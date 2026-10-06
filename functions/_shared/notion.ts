// Helpers compartidos de Notion para Cloudflare Pages Functions.
// Equivalente a los del server Express, pero sin estado en memoria (cada
// invocación es aislada en Cloudflare).

export const NOTION_VERSION = "2026-03-11";
export const NOTION_BASE = "https://api.notion.com/v1";

export interface Env {
  NOTION_SECRET?: string;
  NOTION_ID_PAGE?: string;
  NOTION_PARENT_PAGE_ID?: string;
  SUBMISSIONS_KV?: KVNamespace;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_SENDER?: string;
  MAIL_FROM_NAME?: string;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Lee las credenciales de env (+ override opcional en KV). */
export async function getCredentials(env: Env): Promise<{ notionSecret: string; parentPageId: string }> {
  let notionSecret = env.NOTION_SECRET || "";
  let parentPageId = env.NOTION_ID_PAGE || env.NOTION_PARENT_PAGE_ID || "";
  if (env.SUBMISSIONS_KV) {
    try {
      const override = await env.SUBMISSIONS_KV.get("config");
      if (override) {
        const cfg = JSON.parse(override);
        if (cfg.notionSecret) notionSecret = cfg.notionSecret;
        if (cfg.parentPageId) parentPageId = cfg.parentPageId;
      }
    } catch { /* ignore */ }
  }
  return { notionSecret, parentPageId: cleanNotionId(parentPageId) };
}

export function cleanNotionId(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  const dashed = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (dashed) return dashed[0];
  const plain = trimmed.match(/[a-f0-9]{32}/i);
  if (plain) return plain[0];
  return trimmed;
}

/** Llamada genérica a la API de Notion con reintentos ante 429/5xx. */
export async function notionFetch(method: string, path: string, token: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) (init as any).body = JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(`${NOTION_BASE}${path}`, init);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(600 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 600 * 2 ** attempt);
      continue;
    }
    const data: any = await res.json().catch(() => ({}));
    throw new Error(`Notion API error (${res.status}): ${data?.message || data?.code || "desconocido"}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lista TODOS los bloques hijos (paginado). */
export async function listAllChildBlocks(blockId: string, token: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : `?page_size=100`;
    const resp = await notionFetch("GET", `/blocks/${blockId}/children${qs}`, token);
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

export const isSubmissionTitle = (name: string): boolean => name.trim().startsWith("👤");

/** Lista las categorías (toggles / subpáginas) de la página madre. */
export async function collectProjects(parentPageId: string, token: string): Promise<any[]> {
  const acc: any[] = [];
  for (const block of await listAllChildBlocks(parentPageId, token)) {
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

export const DEST_REGISTRO = "1REGISTRO";
export const DEST_DATA = "2DATA";

/** Toggles hijos (nombre + id), ignorando los de envío (👤). */
export async function childToggles(blockId: string, token: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (const b of await listAllChildBlocks(blockId, token)) {
    if (b.type !== "toggle") continue;
    const name = (b.toggle?.rich_text || []).map((rt: any) => rt.plain_text).join("").trim();
    if (isSubmissionTitle(name)) continue;
    out.push({ id: b.id, name });
  }
  return out;
}

export const isDestName = (name: string) => {
  const n = name.trim().toUpperCase();
  return n === DEST_REGISTRO || n === DEST_DATA;
};
export const looksLikePeriod = (name: string) => /^[A-Za-z0-9]{1,4}$/.test(name.trim()) && !/^\d{4}$/.test(name.trim());
export const looksLikeYear = (name: string) => /^\d{4}$/.test(name.trim());

/** Describe la estructura (años/periodos) de una categoría. */
export async function describeCategory(categoryId: string, token: string) {
  const level1 = await childToggles(categoryId, token);
  const years = level1.filter((t) => looksLikeYear(t.name));
  const hasDirectDest = level1.some((t) => isDestName(t.name));
  const periodsByYear: Record<string, string[]> = {};
  for (const y of years) {
    const level2 = await childToggles(y.id, token);
    periodsByYear[y.name] = level2.filter((t) => looksLikePeriod(t.name) || !isDestName(t.name)).map((p) => p.name);
  }
  return { useHierarchy: years.length > 0, hasDirectDest, years: years.map((y) => y.name), periodsByYear };
}

/**
 * Busca un toggle hijo por nombre; si no existe, lo crea. Como en Cloudflare no
 * hay memoria compartida entre invocaciones (dos envíos simultáneos podrían
 * crear el mismo toggle a la vez), tras crear se RECONCILIA: se vuelve a listar
 * y, si hay duplicados con el mismo nombre, se conserva el primero (orden de
 * Notion = más antiguo) y se borran los demás. El id devuelto es siempre el
 * superviviente, de modo que el envío cae en el toggle correcto.
 */
export async function findOrCreateToggle(parentId: string, name: string, token: string): Promise<string> {
  const upper = name.toUpperCase();
  const existing = await childToggles(parentId, token);
  const hit = existing.find((t) => t.name.toUpperCase() === upper);
  if (hit) return hit.id;

  // Crear.
  const res = await notionFetch("PATCH", `/blocks/${parentId}/children`, token, {
    children: [{ object: "block", type: "toggle", toggle: { rich_text: [{ type: "text", text: { content: name } }] } }],
  });
  const createdId: string = res?.results?.[0]?.id || "";

  // Reconciliar duplicados por carrera: re-listar y quedarse con el primero.
  const after = await childToggles(parentId, token);
  const sameName = after.filter((t) => t.name.toUpperCase() === upper);
  if (sameName.length <= 1) return createdId || sameName[0]?.id || "";

  const survivor = sameName[0].id; // orden de Notion → el más antiguo
  for (const dup of sameName.slice(1)) {
    // No borrar si ya tiene contenido (otra invocación pudo escribir dentro).
    try {
      const kids = await notionFetch("GET", `/blocks/${dup.id}/children?page_size=1`, token);
      if ((kids.results || []).length === 0) {
        await notionFetch("DELETE", `/blocks/${dup.id}`, token);
      }
    } catch { /* best-effort */ }
  }
  return survivor;
}

/** Resuelve (creando lo que falte) el toggle destino: categoría → [año] → [periodo] → dest. */
export async function resolveDestination(categoryId: string, dest: string, token: string, year?: string, period?: string): Promise<string> {
  let parent = categoryId;
  if (year && year.trim()) {
    parent = await findOrCreateToggle(parent, year.trim(), token);
    if (period && period.trim()) parent = await findOrCreateToggle(parent, period.trim(), token);
  }
  return findOrCreateToggle(parent, dest, token);
}

// ─── MIME / nombres de subida ───
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

export function resolveUploadMeta(filename: string, mimeType: string): { uploadName: string; contentType: string; extModified: boolean } {
  const dotIndex = filename.lastIndexOf(".");
  const ext = dotIndex !== -1 ? filename.slice(dotIndex + 1).toLowerCase() : "";
  const standardMime = NOTION_MIME_TYPES[ext];
  if (standardMime) return { uploadName: filename, contentType: standardMime, extModified: false };
  return { uploadName: filename + ".zip", contentType: "application/zip", extModified: true };
}

/** Sube un archivo pequeño (single-part) a Notion y devuelve el upload id. */
export async function uploadFileToNotion(file: File, token: string): Promise<{ id: string; finalName: string; extModified: boolean }> {
  const { uploadName, contentType, extModified } = resolveUploadMeta(file.name, file.type);
  const create = await fetch(`${NOTION_BASE}/file_uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "single_part", filename: uploadName, content_type: contentType }),
  });
  const upload = (await create.json()) as any;
  if (!upload.id) throw new Error(`No se pudo crear el upload: ${JSON.stringify(upload)}`);
  const form = new FormData();
  form.append("file", new Blob([await file.arrayBuffer()], { type: contentType }), uploadName);
  const send = await fetch(upload.upload_url || `${NOTION_BASE}/file_uploads/${upload.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    body: form,
  });
  const sent = (await send.json()) as any;
  if (sent.status !== "uploaded" && sent.status !== "complete") throw new Error(`Error al enviar archivo: ${JSON.stringify(sent)}`);
  return { id: upload.id, finalName: uploadName, extModified };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff"]);

/** Construye los bloques (callout + archivos) para el toggle de un envío. */
export function buildSubmissionBlocks(opts: {
  senderName: string; senderEmail: string; document: string; comment: string; dateStr: string;
  fileRecords: { name: string; size: number; uploadId: string; extModified: boolean; mimeType: string }[];
}): any[] {
  const blocks: any[] = [{
    object: "block", type: "callout",
    callout: {
      rich_text: [{
        type: "text",
        text: { content: `Información de la entrega:\n• Remitente: ${opts.senderName}\n• Correo: ${opts.senderEmail}${opts.document ? `\n• Documento: ${opts.document}` : ""}\n• Fecha de envío: ${opts.dateStr}\n• Archivos totales: ${opts.fileRecords.length}${opts.comment ? `\n• Detalle: ${opts.comment}` : ""}` },
      }],
      icon: { type: "emoji", emoji: "📬" }, color: "blue_background",
    },
  }];
  if (opts.fileRecords.length > 0) {
    blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "Archivos adjuntos" } }] } });
  }
  for (const f of opts.fileRecords) {
    const isImage = IMAGE_TYPES.has(f.mimeType);
    const sizeLabel = (f.size / (1024 * 1024)).toFixed(2) + " MB";
    const caption = f.extModified
      ? [{ type: "text", text: { content: `⚠️ .zip agregado. Nombre original: ${f.name} (${sizeLabel})` } }]
      : [{ type: "text", text: { content: `${isImage ? "🖼️" : "📄"} ${f.name} (${sizeLabel})` } }];
    blocks.push(isImage
      ? { object: "block", type: "image", image: { type: "file_upload", file_upload: { id: f.uploadId }, caption } }
      : { object: "block", type: "file", file: { type: "file_upload", file_upload: { id: f.uploadId }, caption } });
  }
  return blocks;
}
