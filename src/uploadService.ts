// Motor de subida (cliente) para UpZ. Sube archivos pesados (hasta 5 GB) a
// Notion a través de las Cloudflare Pages Functions (/api/upload-*).
//
// Estrategia (portada desde el motor de pagepage):
//  - Un único semáforo adaptativo (AIMD) limita las subidas simultáneas a Notion.
//  - Los archivos se suben EN PARALELO mediante un pool de workers.
//  - Manejo de throttling (429/503) con cooldown + reintentos con backoff.
//  - Los tipos no soportados por Notion se comprimen a un ZIP real antes de subir.
//
// IMPORTANTE: CHUNK_SIZE debe coincidir con functions/api/upload-init.ts (10 MiB).

export interface UploadRecord {
  name: string;
  finalName: string;
  size: number;
  uploadId: string;
  extModified: boolean;
  mimeType: string;
}

export interface UploadCallbacks {
  /** Texto descriptivo del paso actual (se muestra en el botón de envío). */
  onStep?: (step: string) => void;
  /** Progreso global agregado de todos los archivos (0-100). */
  onProgress?: (percent: number) => void;
}

// IMPORTANTE: CHUNK_SIZE debe coincidir con functions/api/upload-init.ts
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB
const SMALL_FILE_THRESHOLD = 20 * 1024 * 1024; // 20 MiB
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB (límite de Notion)

const START_CONCURRENCY = 6;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 12;
const THROTTLE_COOLDOWN_MS = 1500;

const SMALL_FILE_POOL = MAX_CONCURRENCY;
const LARGE_FILE_POOL = 3;

const MAX_PART_RETRIES = 6;
const MAX_SMALL_RETRIES = 4;

type Outcome = "ok" | "throttle" | "error";

const isThrottleStatus = (status: number): boolean => status === 429 || status === 503;

/** Semáforo con concurrencia adaptativa (AIMD). */
class AdaptiveSemaphore {
  private active = 0;
  private limit: number;
  private queue: Array<() => void> = [];
  private successCredits = 0;
  private cooldownUntil = 0;

  constructor(start: number, private readonly min: number, private readonly max: number) {
    this.limit = start;
  }

  async acquire(): Promise<(outcome?: Outcome) => void> {
    if (this.active < this.limit) {
      this.active++;
      return this.makeRelease();
    }
    return new Promise<(outcome?: Outcome) => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): (outcome?: Outcome) => void {
    let released = false;
    return (outcome: Outcome = "ok") => {
      if (released) return;
      released = true;
      this.adjust(outcome);
      this.active--;
      this.pump();
    };
  }

  private adjust(outcome: Outcome): void {
    const now = Date.now();
    if (outcome === "throttle") {
      // Multiplicative decrease: recorta la concurrencia a la mitad.
      this.limit = Math.max(this.min, Math.floor(this.limit / 2));
      this.successCredits = 0;
      this.cooldownUntil = now + THROTTLE_COOLDOWN_MS;
    } else if (outcome === "ok") {
      if (now < this.cooldownUntil) return;
      // Additive increase: sube de a 1 tras suficientes éxitos.
      this.successCredits++;
      if (this.successCredits >= this.limit) {
        this.successCredits = 0;
        this.limit = Math.min(this.max, this.limit + 1);
      }
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const backoff = Math.min(5000, 400 * Math.pow(2, attempt - 1));
        await sleep(backoff + Math.random() * 300);
      }
    }
  }
  throw lastError || new Error("Operación fallida.");
}

// Extensiones aceptadas por la File Upload API de Notion.
const NOTION_SUPPORTED_EXTENSIONS = new Set([
  // Comprimidos
  "zip", "gz", "gzip", "tar", "7z", "bz2", "rar",
  // Imágenes
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "heic", "avif", "apng",
  // Audio
  "aac", "adts", "mid", "midi", "mp3", "mpga", "m4a", "m4b", "oga", "ogg", "opus", "wav", "wma", "weba", "flac",
  // Vídeo
  "amv", "asf", "wmv", "avi", "f4v", "flv", "gifv", "m4v", "mp4", "mkv", "webm", "mov", "qt", "mpeg", "ogv", "3gp", "3g2",
  // Documentos
  "pdf", "txt", "csv", "json", "doc", "dot", "docx", "dotx", "xls", "xlt", "xla", "xlsx", "xltx",
  "ppt", "pot", "pps", "ppa", "pptx", "potx", "rtf", "md", "markdown", "html", "htm", "epub", "xml", "css",
  "odt", "ods", "odp", "ics", "yaml", "yml", "tsv",
]);

/** ¿El archivo necesita comprimirse a ZIP para ser compatible con Notion? */
const needsZipCompression = (filename: string): boolean => {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return true; // sin extensión
  const ext = filename.slice(dotIndex + 1).toLowerCase();
  return !NOTION_SUPPORTED_EXTENSIONS.has(ext);
};

/** Comprime un archivo en un ZIP real usando JSZip. */
const compressFileToZip = async (file: File): Promise<File> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(file.name, file);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return new File([blob], file.name + ".zip", { type: "application/zip" });
};

/** Reporta el progreso de un archivo concreto. */
type FileReport = (percent: number, step: string) => void;

/** Sube un solo archivo a Notion usando el semáforo global. */
const uploadOneFile = async (
  file: File,
  fileIndex: number,
  totalFiles: number,
  sem: AdaptiveSemaphore,
  report: FileReport
): Promise<UploadRecord> => {
  const originalName = file.name;
  const label = `${originalName} (${fileIndex + 1}/${totalFiles})`;

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`"${originalName}" excede el límite de 5 GB.`);
  }

  let uploadFile = file;
  let wasCompressed = false;
  if (needsZipCompression(file.name)) {
    report(0, `Comprimiendo ${label} a ZIP...`);
    uploadFile = await compressFileToZip(file);
    wasCompressed = true;
  }

  // ── Archivo pequeño: una sola petición ──
  if (uploadFile.size <= SMALL_FILE_THRESHOLD) {
    report(0, `Subiendo ${label}...`);
    const data = await withRetry(async () => {
      const release = await sem.acquire();
      let outcome: Outcome = "error";
      try {
        const fd = new FormData();
        fd.append("file", uploadFile, uploadFile.name);
        const res = await fetch("/api/upload-file", { method: "POST", body: fd });
        if (isThrottleStatus(res.status)) {
          outcome = "throttle";
          throw new Error(`Servidor ocupado al subir "${originalName}" (${res.status}).`);
        }
        const text = await res.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`Respuesta inesperada al subir "${originalName}". Puede que el archivo sea demasiado grande.`);
        }
        if (!res.ok || !parsed.success) {
          throw new Error(parsed.error || `Error al subir "${originalName}"`);
        }
        outcome = "ok";
        return parsed;
      } finally {
        release(outcome);
      }
    }, MAX_SMALL_RETRIES);

    report(100, `Subido ${label}`);
    return {
      name: originalName,
      finalName: data.finalName as string,
      size: file.size, // tamaño original para mostrar
      uploadId: data.id as string,
      extModified: wasCompressed || !!data.extModified,
      mimeType: file.type || "application/octet-stream",
    };
  }

  // ── Archivo grande: multi-part ──
  const numberOfParts = Math.ceil(uploadFile.size / CHUNK_SIZE);
  report(0, `Inicializando ${label} (${numberOfParts} partes)...`);

  const initRes = await fetch("/api/upload-init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: uploadFile.name,
      mimeType: uploadFile.type,
      fileSize: uploadFile.size,
    }),
  });
  const initData = await initRes.json();
  if (!initRes.ok || !initData.success) {
    throw new Error(initData.error || `Error al inicializar upload de "${originalName}"`);
  }

  const { id: uploadId, uploadName, contentType, mode } = initData;
  let completedParts = 0;

  const uploadPart = (partNumber: number): Promise<void> =>
    withRetry(async () => {
      const release = await sem.acquire();
      let outcome: Outcome = "error";
      try {
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, uploadFile.size);
        const chunk = uploadFile.slice(start, end);

        const chunkBlob = new Blob([chunk], { type: contentType || "application/octet-stream" });
        const chunkFd = new FormData();
        if (mode === "multi_part") chunkFd.append("part_number", String(partNumber));
        chunkFd.append("file", chunkBlob, uploadName);

        const partRes = await fetch(`/api/upload-part?upload_id=${encodeURIComponent(uploadId)}`, {
          method: "POST",
          body: chunkFd,
        });
        if (isThrottleStatus(partRes.status)) {
          outcome = "throttle";
          throw new Error(`Servidor ocupado en parte ${partNumber} de "${originalName}" (${partRes.status}).`);
        }
        const partText = await partRes.text();
        let partData: any;
        try {
          partData = JSON.parse(partText);
        } catch {
          throw new Error(`Respuesta inesperada al subir parte ${partNumber} de "${originalName}".`);
        }
        if (!partRes.ok || (!partData.success && !partData.id)) {
          throw new Error(partData.error || partData.message || `Error en parte ${partNumber} de "${originalName}"`);
        }

        outcome = "ok";
        completedParts++;
        const pct = Math.min(98, Math.round((completedParts / numberOfParts) * 100));
        report(pct, `Subiendo ${label} — ${completedParts}/${numberOfParts} partes (${pct}%)`);
      } finally {
        release(outcome);
      }
    }, MAX_PART_RETRIES);

  report(0, `Subiendo ${label} — 0/${numberOfParts} partes (0%)`);

  await Promise.all(Array.from({ length: numberOfParts }, (_, i) => uploadPart(i + 1)));

  if (mode === "multi_part") {
    report(99, `Finalizando ${label}...`);
    const completeRes = await fetch("/api/upload-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId }),
    });
    const completeData = await completeRes.json();
    if (!completeRes.ok || !completeData.success) {
      throw new Error(completeData.error || `Error al completar upload de "${originalName}"`);
    }
  }

  report(100, `Subido ${label}`);
  return {
    name: originalName,
    finalName: uploadName,
    size: file.size, // tamaño original para mostrar
    uploadId,
    extModified: wasCompressed || !!initData.extModified,
    mimeType: file.type || "application/octet-stream",
  };
};

/**
 * Sube todos los archivos a Notion en paralelo (pool de workers + semáforo
 * adaptativo) y devuelve los registros en el mismo orden que `files`.
 */
export const uploadFiles = async (
  files: File[],
  callbacks: UploadCallbacks = {}
): Promise<UploadRecord[]> => {
  const records: UploadRecord[] = new Array(files.length);
  if (files.length === 0) return records;

  const sem = new AdaptiveSemaphore(START_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY);
  const hasLarge = files.some((f) => f.size > SMALL_FILE_THRESHOLD);
  const filePool = Math.min(hasLarge ? LARGE_FILE_POOL : SMALL_FILE_POOL, files.length);

  // Progreso agregado: promedio del porcentaje de cada archivo.
  const percents = new Array(files.length).fill(0);
  const emitProgress = () => {
    const total = percents.reduce((a: number, b: number) => a + b, 0);
    callbacks.onProgress?.(Math.round(total / files.length));
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= files.length) return;
      records[i] = await uploadOneFile(files[i], i, files.length, sem, (percent, step) => {
        percents[i] = percent;
        callbacks.onStep?.(step);
        emitProgress();
      });
    }
  };

  await Promise.all(Array.from({ length: filePool }, () => worker()));
  return records;
};
