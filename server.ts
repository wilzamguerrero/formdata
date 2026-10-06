import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { Client } from "@notionhq/client";
import { hasGmailCredentials, sendGmailMessage, buildPreinscripcionEmail, buildMaterialEmail } from "./email";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_API_VER = "2026-03-11";
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB
const MULTI_PART_THRESHOLD = 20 * 1024 * 1024; // 20 MiB
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB (límite de Notion)

// ───────────────────────────────────────────────────────────────────────────
// Acceso a Notion con cola. Notion limita a ~3 req/s por workspace: un semáforo
// (NOTION_CONCURRENCY en vuelo) + reintentos ante 429/errores temporales evita
// saturar y perder entregas. Portado del sistema de referencia (UpZ).
// ───────────────────────────────────────────────────────────────────────────
const NOTION_CONCURRENCY = 2;
const NOTION_MAX_QUEUE = 15;
const NOTION_MAX_RETRIES = 3;

class NotionBusyError extends Error {
  readonly code = "BUSY";
  constructor() {
    super("Notion queue is full");
    this.name = "NotionBusyError";
  }
}

let notionClient: Client | null = null;
let notionClientSecret = "";
let notionActive = 0;
const notionWaiting: Array<() => void> = [];

async function acquireNotionSlot(): Promise<void> {
  if (notionActive < NOTION_CONCURRENCY) {
    notionActive++;
    return;
  }
  if (notionWaiting.length >= NOTION_MAX_QUEUE) throw new NotionBusyError();
  await new Promise<void>((resolve) => notionWaiting.push(resolve));
}

function releaseNotionSlot(): void {
  const next = notionWaiting.shift();
  if (next) { next(); return; }
  notionActive--;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetriableNotionError(err: any): boolean {
  const status = err?.status ?? err?.statusCode;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  const code = String(err?.code || "");
  return code === "notionhq_client_request_timeout" || code === "service_unavailable" || code === "rate_limited";
}

function retryAfterMs(err: any, attempt: number): number {
  const header = err?.headers?.["retry-after"] ?? err?.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10000);
  return 1000 * 2 ** attempt;
}

async function runQueued<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await acquireNotionSlot();
    let released = false;
    try {
      return await fn();
    } catch (err: any) {
      if (attempt >= NOTION_MAX_RETRIES || !isRetriableNotionError(err)) throw err;
      releaseNotionSlot();
      released = true;
      await sleep(retryAfterMs(err, attempt));
    } finally {
      if (!released) releaseNotionSlot();
    }
  }
}

function queueNotionCalls<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function") {
        return (...args: any[]) => runQueued(() => (value as any).apply(obj, args));
      }
      if (value && typeof value === "object") return queueNotionCalls(value);
      return value;
    },
  });
}

function getNotion(secret: string): Client {
  if (!notionClient || notionClientSecret !== secret) {
    notionClient = queueNotionCalls(new Client({ auth: secret }));
    notionClientSecret = secret;
  }
  return notionClient;
}

// Serializa operaciones por clave para evitar que dos envíos simultáneos creen
// el mismo toggle (año/periodo/registro) dos veces.
const keyLocks = new Map<string, Promise<unknown>>();
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  keyLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (keyLocks.get(key) === current) keyLocks.delete(key);
  }
}

// ─── Config ───
function cleanNotionId(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  const dashed = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (dashed) return dashed[0];
  const plain = trimmed.match(/[a-f0-9]{32}/i);
  if (plain) return plain[0];
  return trimmed;
}

function loadConfig() {
  const notionSecret = process.env.NOTION_SECRET || "";
  const parentPageId = cleanNotionId(process.env.NOTION_ID_PAGE || process.env.NOTION_PARENT_PAGE_ID || "");
  return { notionSecret, parentPageId };
}

// ─── MIME + nombres de subida ───
const NOTION_MIME_TYPES: Record<string, string> = {
  zip: "application/zip", gz: "application/gzip", gzip: "application/gzip", tar: "application/x-tar",
  "7z": "application/x-7z-compressed", bz2: "application/x-bzip2", rar: "application/vnd.rar",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff", ico: "image/vnd.microsoft.icon",
  heic: "image/heic", avif: "image/avif", apng: "image/apng",
  aac: "audio/aac", adts: "audio/aac", mid: "audio/midi", midi: "audio/midi", mp3: "audio/mpeg",
  mpga: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg",
  opus: "audio/ogg", wav: "audio/wav", wma: "audio/x-ms-wma", weba: "audio/webm", flac: "audio/x-flac",
  amv: "video/x-amv", asf: "video/x-ms-asf", wmv: "video/x-ms-asf", avi: "video/x-msvideo", f4v: "video/x-f4v",
  flv: "video/x-flv", gifv: "video/mp4", m4v: "video/mp4", mp4: "video/mp4", mkv: "video/webm",
  webm: "video/webm", mov: "video/quicktime", qt: "video/quicktime", mpeg: "video/mpeg", ogv: "video/ogg",
  "3gp": "video/3gpp", "3g2": "video/3gpp2",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json",
  doc: "application/msword", dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  xls: "application/vnd.ms-excel", xlt: "application/vnd.ms-excel", xla: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ppt: "application/vnd.ms-powerpoint", pot: "application/vnd.ms-powerpoint", pps: "application/vnd.ms-powerpoint",
  ppa: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  rtf: "application/rtf", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html",
  epub: "application/epub+zip", xml: "text/xml", css: "text/css",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation", ics: "text/calendar", yaml: "text/yaml",
  yml: "text/yaml", tsv: "text/tab-separated-values",
};

function resolveUploadMeta(filename: string, mimeType: string): { uploadName: string; contentType: string; extModified: boolean } {
  const dotIndex = filename.lastIndexOf(".");
  const ext = dotIndex !== -1 ? filename.slice(dotIndex + 1).toLowerCase() : "";
  const standardMime = NOTION_MIME_TYPES[ext];
  if (standardMime) return { uploadName: filename, contentType: standardMime, extModified: false };
  return { uploadName: filename + ".zip", contentType: "application/zip", extModified: true };
}

// ─── Subida de archivos a Notion ───
async function uploadFileObjectToNotion(secret: string, pathname: string, originalname: string, mimeType: string) {
  const { uploadName, contentType, extModified } = resolveUploadMeta(originalname, mimeType);
  const initResp = await fetch(`${NOTION_API_BASE_URL}/file_uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Notion-Version": NOTION_API_VER, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "single_part", filename: uploadName, content_type: contentType }),
  });
  if (!initResp.ok) throw new Error(`Init upload failed: ${await initResp.text()}`);
  const { id: uploadId, upload_url } = (await initResp.json()) as any;

  const fileBuffer = fs.readFileSync(pathname);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(fileBuffer)], { type: contentType }), uploadName);
  const uploadResp = await fetch(upload_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Notion-Version": NOTION_API_VER },
    body: form,
  });
  if (!uploadResp.ok) throw new Error(`Content upload failed: ${await uploadResp.text()}`);
  return { id: uploadId, finalName: uploadName, extModified };
}

async function uploadLargeFileObjectToNotion(secret: string, pathname: string, originalname: string, mimeType: string) {
  const { uploadName, contentType, extModified } = resolveUploadMeta(originalname, mimeType);
  const fileBuffer = fs.readFileSync(pathname);
  const totalSize = fileBuffer.length;
  const numberOfParts = Math.ceil(totalSize / CHUNK_SIZE);

  const initResp = await fetch(`${NOTION_API_BASE_URL}/file_uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Notion-Version": NOTION_API_VER, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "multi_part", number_of_parts: numberOfParts, filename: uploadName, content_type: contentType }),
  });
  if (!initResp.ok) throw new Error(`Init multi-part upload failed: ${await initResp.text()}`);
  const initData = (await initResp.json()) as any;
  const uploadUrl = initData.upload_url || `${NOTION_API_BASE_URL}/file_uploads/${initData.id}/send`;
  const completeUrl = initData.complete_url || `${NOTION_API_BASE_URL}/file_uploads/${initData.id}/complete`;

  for (let partNumber = 1; partNumber <= numberOfParts; partNumber++) {
    const start = (partNumber - 1) * CHUNK_SIZE;
    const chunk = fileBuffer.subarray(start, Math.min(start + CHUNK_SIZE, totalSize));
    const partForm = new FormData();
    partForm.append("part_number", String(partNumber));
    partForm.append("file", new Blob([new Uint8Array(chunk)], { type: contentType }), uploadName);
    const partResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Notion-Version": NOTION_API_VER },
      body: partForm,
    });
    if (!partResp.ok) throw new Error(`Error uploading part ${partNumber}/${numberOfParts}: ${await partResp.text()}`);
  }

  const completeResp = await fetch(completeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Notion-Version": NOTION_API_VER, "Content-Type": "application/json" },
  });
  if (!completeResp.ok) throw new Error(`Error completing multi-part upload: ${await completeResp.text()}`);
  return { id: initData.id, finalName: uploadName, extModified };
}

// ─── Árbol de proyectos (categorías) ───
async function listAllChildBlocks(notion: Client, blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const resp: any = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

const isSubmissionTitle = (name: string): boolean => name.trim().startsWith("👤");

async function collectProjects(notion: Client, parentPageId: string): Promise<any[]> {
  const acc: any[] = [];
  const children = await listAllChildBlocks(notion, parentPageId);
  for (const block of children) {
    if (block.type === "toggle") {
      const name = (block.toggle?.rich_text || []).map((rt: any) => rt.plain_text).join("").trim();
      if (isSubmissionTitle(name)) continue;
      acc.push({ id: block.id, name: name || "Categoría sin título", type: "toggle", isActive: true });
    } else if (block.type === "child_page") {
      acc.push({ id: block.id, name: block.child_page?.title || "Categoría sin título", type: "page", isActive: true });
    }
  }
  return acc;
}

// ───────────────────────────────────────────────────────────────────────────
// Estructura jerárquica dentro de una categoría:
//   categoría → [año] → [periodo] → (1REGISTRO | 2DATA)
// Soporta dos convenciones existentes:
//   - Simple  (MUD/MAD/HOMUS): la categoría contiene 1REGISTRO / 2DATA directo.
//   - Anidada (DEX):           categoría → 2026 → A/B → 1REGISTRO / 2DATA.
// El nivel año/periodo solo se usa si la categoría ya tiene toggles de año.
// ───────────────────────────────────────────────────────────────────────────

const DEST_REGISTRO = "1REGISTRO";
const DEST_DATA = "2DATA";

/** Devuelve los toggles hijos (nombre + id), ignorando los de envío (👤 …). */
async function childToggles(notion: Client, blockId: string): Promise<{ id: string; name: string }[]> {
  const blocks = await listAllChildBlocks(notion, blockId);
  const out: { id: string; name: string }[] = [];
  for (const b of blocks) {
    if (b.type !== "toggle") continue;
    const name = (b.toggle?.rich_text || []).map((rt: any) => rt.plain_text).join("").trim();
    if (isSubmissionTitle(name)) continue;
    out.push({ id: b.id, name });
  }
  return out;
}

/** ¿Es un toggle "contenedor de destino" (1REGISTRO / 2DATA)? */
const isDestName = (name: string) => {
  const n = name.trim().toUpperCase();
  return n === DEST_REGISTRO || n === DEST_DATA;
};

/** ¿Es un toggle de periodo? (nombre corto tipo A, B, I, II, 1, 2…) */
const looksLikePeriod = (name: string) => /^[A-Za-z0-9]{1,4}$/.test(name.trim()) && !/^\d{4}$/.test(name.trim());

/** ¿Es un toggle de año? (4 dígitos, p. ej. 2026) */
const looksLikeYear = (name: string) => /^\d{4}$/.test(name.trim());

/**
 * Describe la estructura de una categoría para que el frontend sepa qué pedir.
 * Devuelve: { years: [...], periodsByYear: { year: [...] }, hasDirectDest }.
 */
async function describeCategory(notion: Client, categoryId: string) {
  const level1 = await childToggles(notion, categoryId);
  const years = level1.filter((t) => looksLikeYear(t.name));
  const hasDirectDest = level1.some((t) => isDestName(t.name));

  const periodsByYear: Record<string, { id: string; name: string }[]> = {};
  for (const y of years) {
    const level2 = await childToggles(notion, y.id);
    periodsByYear[y.name] = level2.filter((t) => looksLikePeriod(t.name) || !isDestName(t.name));
  }
  return {
    useHierarchy: years.length > 0,
    hasDirectDest,
    years: years.map((y) => y.name),
    periodsByYear: Object.fromEntries(Object.entries(periodsByYear).map(([k, v]) => [k, v.map((p) => p.name)])),
  };
}

/** Busca un toggle hijo por nombre (case-insensitive); si no existe, lo crea. */
async function findOrCreateToggle(notion: Client, parentId: string, name: string): Promise<string> {
  return withKeyLock(`toggle:${parentId}:${name.toUpperCase()}`, async () => {
    const existing = await childToggles(notion, parentId);
    const hit = existing.find((t) => t.name.toUpperCase() === name.toUpperCase());
    if (hit) return hit.id;
    const res: any = await notion.blocks.children.append({
      block_id: parentId,
      children: [{ object: "block", type: "toggle", toggle: { rich_text: [{ type: "text", text: { content: name } }] } }],
    });
    return res?.results?.[0]?.id || "";
  });
}

/**
 * Resuelve (creando lo que falte) el toggle destino donde guardar el envío.
 * dest = "1REGISTRO" | "2DATA". year/period opcionales (solo si la categoría
 * usa jerarquía). Devuelve el blockId destino.
 */
async function resolveDestination(
  notion: Client,
  categoryId: string,
  dest: string,
  year?: string,
  period?: string
): Promise<string> {
  let parent = categoryId;
  if (year && year.trim()) {
    parent = await findOrCreateToggle(notion, parent, year.trim());
    if (period && period.trim()) {
      parent = await findOrCreateToggle(notion, parent, period.trim());
    }
  }
  return findOrCreateToggle(notion, parent, dest);
}

// ─── Multer (disco, borra tras subir a Notion) ───
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ═══════════════════════════ API ═══════════════════════════

app.get("/api/config", (_req, res) => {
  const cfg = loadConfig();
  res.json({ success: true, isConfigured: !!(cfg.notionSecret && cfg.parentPageId) });
});

app.get("/api/projects", async (_req, res) => {
  const config = loadConfig();
  if (!config.notionSecret || !config.parentPageId) {
    return res.status(400).json({ error: "Notion no está configurado. Define NOTION_SECRET y NOTION_ID_PAGE en .env" });
  }
  try {
    const notion = getNotion(config.notionSecret);
    const projects = await collectProjects(notion, config.parentPageId);
    res.json({ success: true, projects });
  } catch (err: any) {
    res.status(500).json({ error: `Error al conectar con Notion: ${err.message || "desconocido"}` });
  }
});

// Describe la estructura (años/periodos) de una categoría para el frontend.
app.get("/api/category-structure", async (req, res) => {
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado." });
  const categoryId = String(req.query.categoryId || "");
  if (!categoryId) return res.status(400).json({ error: "Se requiere categoryId." });
  try {
    const notion = getNotion(config.notionSecret);
    const structure = await describeCategory(notion, categoryId);
    res.json({ success: true, structure });
  } catch (err: any) {
    res.status(500).json({ error: `Error al leer la estructura: ${err.message || "desconocido"}` });
  }
});

app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se proporcionó ningún archivo." });
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado." });
  try {
    const result = req.file.size > MULTI_PART_THRESHOLD
      ? await uploadLargeFileObjectToNotion(config.notionSecret, req.file.path, req.file.originalname, req.file.mimetype)
      : await uploadFileObjectToNotion(config.notionSecret, req.file.path, req.file.originalname, req.file.mimetype);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: true, id: result.id, finalName: result.finalName, extModified: result.extModified, mimeType: req.file.mimetype, size: req.file.size });
  } catch (err: any) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: `Error al subir "${req.file.originalname}": ${err.message || "desconocido"}` });
  }
});

app.post("/api/upload-init", async (req, res) => {
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado." });
  const { filename, mimeType = "", fileSize = 0 } = req.body || {};
  if (!filename) return res.status(400).json({ error: "Se requiere el nombre del archivo." });
  if (fileSize > MAX_FILE_SIZE) return res.status(413).json({ error: "El archivo excede el límite de 5 GB de Notion." });

  const { uploadName, contentType } = resolveUploadMeta(filename, mimeType);
  const isMultiPart = fileSize > MULTI_PART_THRESHOLD;
  const numberOfParts = isMultiPart ? Math.ceil(fileSize / CHUNK_SIZE) : 1;
  try {
    const createBody: any = { filename: uploadName, content_type: contentType };
    if (isMultiPart) { createBody.mode = "multi_part"; createBody.number_of_parts = numberOfParts; }
    const createRes = await fetch(`${NOTION_API_BASE_URL}/file_uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.notionSecret}`, "Notion-Version": NOTION_API_VER, "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const uploadObj = (await createRes.json()) as any;
    if (!uploadObj.id) throw new Error(`No se pudo crear el upload: ${JSON.stringify(uploadObj)}`);
    res.json({
      success: true, id: uploadObj.id,
      uploadUrl: uploadObj.upload_url || `${NOTION_API_BASE_URL}/file_uploads/${uploadObj.id}/send`,
      mode: isMultiPart ? "multi_part" : "single_part", numberOfParts, uploadName, contentType,
    });
  } catch (err: any) {
    res.status(500).json({ error: `Error al inicializar upload: ${err.message || "desconocido"}` });
  }
});

app.post("/api/upload-part", upload.single("file"), async (req, res) => {
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado." });
  if (!req.file) return res.status(400).json({ error: "No se proporcionó el chunk de archivo." });
  const upload_id = (req.query.upload_id as string) || (req.body && req.body.upload_id);
  const { part_number } = req.body || {};
  if (!upload_id) return res.status(400).json({ error: "Se requiere upload_id." });
  try {
    const fileBytes = new Uint8Array(fs.readFileSync(req.file.path));
    // Reintento ante fallos de red transitorios ("fetch failed") o throttling de
    // Notion (429/5xx), que ocurren cuando varias partes llegan muy seguidas.
    let sendRes: Response | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const form = new FormData();
        if (part_number) form.append("part_number", String(part_number));
        form.append("file", new Blob([fileBytes], { type: req.file.mimetype || "application/octet-stream" }), req.file.originalname || "file");
        sendRes = await fetch(`${NOTION_API_BASE_URL}/file_uploads/${upload_id}/send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.notionSecret}`, "Notion-Version": NOTION_API_VER },
          body: form,
        });
        if (sendRes.ok) break;
        if (sendRes.status !== 429 && sendRes.status < 500) {
          throw new Error(`Notion rechazó el chunk: ${sendRes.status} - ${await sendRes.text()}`);
        }
        lastErr = new Error(`Notion ${sendRes.status}`);
      } catch (e) {
        lastErr = e; // p. ej. "fetch failed"
      }
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt + Math.random() * 300));
    }
    if (!sendRes || !sendRes.ok) {
      throw lastErr || new Error("No se pudo enviar el chunk tras varios intentos.");
    }
    const result = (await sendRes.json()) as any;
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: true, id: result.id, status: result.status, partNumber: part_number ? parseInt(part_number, 10) : 1 });
  } catch (err: any) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: `Error al enviar chunk: ${err.message || "desconocido"}` });
  }
});

app.post("/api/upload-complete", async (req, res) => {
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado." });
  const { uploadId } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: "Se requiere uploadId." });
  try {
    const completeRes = await fetch(`${NOTION_API_BASE_URL}/file_uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.notionSecret}`, "Notion-Version": NOTION_API_VER, "Content-Type": "application/json" },
    });
    if (!completeRes.ok) throw new Error(`Notion rechazó el complete: ${completeRes.status} - ${await completeRes.text()}`);
    const result = (await completeRes.json()) as any;
    res.json({ success: true, id: uploadId, status: result.status, finalName: result.filename });
  } catch (err: any) {
    res.status(500).json({ error: `Error al completar upload: ${err.message || "desconocido"}` });
  }
});

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff"]);

app.post("/api/submit", async (req, res) => {
  const { senderName, senderEmail, projectId, projectName, fileRecords = [], comment = "", document = "", dest = "", year = "", period = "", program = "", accentColor = "" } = req.body;
  const trimmedComment = String(comment || "").trim();
  const trimmedDocument = String(document || "").trim();
  const destType = String(dest || "").trim() === DEST_DATA ? DEST_DATA : DEST_REGISTRO;

  if (!senderName || !senderEmail || !projectId) {
    return res.status(400).json({ error: "Faltan campos obligatorios (nombre, correo o categoría)." });
  }
  if (fileRecords.length === 0 && !trimmedComment) {
    return res.status(400).json({ error: "Adjunta al menos un archivo o escribe un comentario." });
  }
  const config = loadConfig();
  if (!config.notionSecret) return res.status(400).json({ error: "Notion no está configurado en el servidor." });

  try {
    const notion = getNotion(config.notionSecret);

    // Resuelve (creando lo que falte) el toggle destino: categoría → [año] →
    // [periodo] → (1REGISTRO | 2DATA). Aquí es donde se anida el envío.
    const destinationId = await resolveDestination(notion, projectId, destType, year, period);

    const dateStr = new Date().toLocaleString("es-ES", {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }) + " UTC";
    const toggleHeader = `👤 ${String(senderName).trim()} (${String(senderEmail).trim()}) — ${dateStr}`;

    const blocks: any[] = [{
      object: "block", type: "callout",
      callout: {
        rich_text: [{
          type: "text",
          text: { content: `Información de la entrega:\n• Remitente: ${String(senderName).trim()}\n• Correo: ${String(senderEmail).trim()}${trimmedDocument ? `\n• Documento: ${trimmedDocument}` : ""}\n• Fecha de envío: ${dateStr}\n• Archivos totales: ${fileRecords.length}${trimmedComment ? `\n• Detalle: ${trimmedComment}` : ""}` },
        }],
        icon: { type: "emoji", emoji: "📬" }, color: "blue_background",
      },
    }];

    if (fileRecords.length > 0) {
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "Archivos adjuntos" } }] } });
    }

    fileRecords.forEach((f: any) => {
      const isImage = IMAGE_TYPES.has(f.mimeType);
      const sizeLabel = (f.size / (1024 * 1024)).toFixed(2) + " MB";
      const caption = f.extModified
        ? [{ type: "text", text: { content: `⚠️ .zip agregado. Nombre original: ${f.name} (${sizeLabel})` } }]
        : [{ type: "text", text: { content: `${isImage ? "🖼️" : "📄"} ${f.name} (${sizeLabel})` } }];
      blocks.push(isImage
        ? { object: "block", type: "image", image: { type: "file_upload", file_upload: { id: f.uploadId }, caption } }
        : { object: "block", type: "file", file: { type: "file_upload", file_upload: { id: f.uploadId }, caption } });
    });

    const appendRes: any = await notion.blocks.children.append({
      block_id: destinationId,
      children: [{ object: "block", type: "toggle", toggle: { rich_text: [{ type: "text", text: { content: toggleHeader } }], children: blocks } }],
    });
    const notionBlockId = appendRes?.results?.[0]?.id || "";

    const timestamp = new Date().toISOString();

    // Correo de confirmación (best-effort: no bloquea ni hace fallar la respuesta).
    const gmailCreds = {
      clientId: process.env.GMAIL_CLIENT_ID || "",
      clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
      refreshToken: process.env.GMAIL_REFRESH_TOKEN || "",
      sender: process.env.GMAIL_SENDER || "",
      senderName: process.env.MAIL_FROM_NAME || "Universidad de Nariño",
    };
    if (hasGmailCredentials(gmailCreds)) {
      const common = {
        name: String(senderName).trim(),
        email: String(senderEmail).trim(),
        document: trimmedDocument,
        category: projectName || "Evento",
        year: String(year || "").trim() || undefined,
        period: String(period || "").trim() || undefined,
        timestamp,
        accentColor: String(accentColor || "").trim() || undefined,
      };
      const mail = destType === DEST_DATA
        ? buildMaterialEmail({ ...common, files: fileRecords.map((f: any) => ({ name: f.name, size: f.size })) })
        : buildPreinscripcionEmail({ ...common, program: String(program || "").trim() || undefined });
      // No await: el envío ocurre en segundo plano. Si falla, solo se registra.
      sendGmailMessage(gmailCreds, { to: common.email, toName: common.name, subject: mail.subject, html: mail.html, text: mail.text })
        .catch((e) => console.error("No se pudo enviar el correo de confirmación:", e?.message || e));
    }

    res.json({
      success: true,
      message: "Registrado en Notion con éxito.",
      submission: {
        id: "sub_" + Date.now(),
        projectId, projectName: projectName || "Categoría de Notion",
        senderName: String(senderName).trim(), senderEmail: String(senderEmail).trim(),
        timestamp, notionBlockId,
        comment: trimmedComment, document: trimmedDocument,
        files: fileRecords.map((f: any) => ({ name: f.name, size: f.size })),
      },
    });
  } catch (err: any) {
    console.error("Error writing submission to Notion:", err);
    res.status(500).json({ error: `Error al guardar en Notion: ${err.message || "desconocido"}` });
  }
});

// ═══════════════════════════ SPA + arranque ═══════════════════════════
async function start() {
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  if (process.env.NODE_ENV !== "production") {
    vite = await createViteServer({ server: { middlewareMode: true }, appType: "custom" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist"), { index: false }));
  }

  app.all("/api/*", (req, res) => {
    res.status(404).json({ success: false, code: "NOT_FOUND", error: `La ruta ${req.method} ${req.path} no existe.` });
  });

  app.get("*", async (req, res) => {
    try {
      const templatePath = process.env.NODE_ENV !== "production"
        ? path.join(process.cwd(), "index.html")
        : path.join(process.cwd(), "dist", "index.html");
      let template = fs.readFileSync(templatePath, "utf-8");
      if (vite) template = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).setHeader("Content-Type", "text/html; charset=UTF-8").send(template);
    } catch (error: any) {
      if (vite) vite.ssrFixStacktrace(error);
      console.error("Error rendering HTML:", error);
      res.status(500).send("No se pudo renderizar la página.");
    }
  });

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const isApi = req.path.startsWith("/api/");
    const status = err?.status ?? err?.statusCode;
    if (err instanceof NotionBusyError || status === 429) {
      const msg = "Hay muchas personas usando la plataforma. Espera unos segundos e inténtalo de nuevo.";
      return isApi ? res.status(503).json({ success: false, code: "BUSY", error: msg }) : res.status(503).send(msg);
    }
    console.error(`Error no controlado en ${req.method} ${req.path}:`, err);
    const isBadReq = err?.code === "LIMIT_FILE_SIZE" || err?.type === "entity.parse.failed";
    const httpStatus = isBadReq ? 400 : (typeof status === "number" && status >= 400 && status < 600 ? status : 500);
    const message = err?.code === "LIMIT_FILE_SIZE" ? "El archivo supera el tamaño máximo permitido."
      : err?.type === "entity.parse.failed" ? "La solicitud contenía datos mal formados."
      : "Ocurrió un error inesperado en el servidor.";
    return isApi ? res.status(httpStatus).json({ success: false, error: message }) : res.status(httpStatus).send(message);
  });

  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start();
