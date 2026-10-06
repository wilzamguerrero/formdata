import { json, getCredentials, resolveUploadMeta, NOTION_BASE, NOTION_VERSION, type Env } from "../_shared/notion";

/** POST /api/upload-init — crea un file upload en Notion (single o multi-part). */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado." }, 400);

  let body: { filename?: string; mimeType?: string; fileSize?: number };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Cuerpo de solicitud inválido." }, 400);
  }
  const { filename, mimeType = "", fileSize = 0 } = body || {};
  if (!filename) return json({ error: "Se requiere el nombre del archivo." }, 400);

  const CHUNK_SIZE = 10 * 1024 * 1024;
  const MULTI_PART_THRESHOLD = 20 * 1024 * 1024;
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
  if (fileSize > MAX_FILE_SIZE) return json({ error: "El archivo excede el límite de 5 GB de Notion." }, 413);

  const { uploadName, contentType } = resolveUploadMeta(filename, mimeType);
  const isMultiPart = fileSize > MULTI_PART_THRESHOLD;
  const numberOfParts = isMultiPart ? Math.ceil(fileSize / CHUNK_SIZE) : 1;

  try {
    const createBody: any = { filename: uploadName, content_type: contentType };
    if (isMultiPart) { createBody.mode = "multi_part"; createBody.number_of_parts = numberOfParts; }
    const createRes = await fetch(`${NOTION_BASE}/file_uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${notionSecret}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const upload = (await createRes.json()) as any;
    if (!upload.id) throw new Error(`No se pudo crear el upload: ${JSON.stringify(upload)}`);
    return json({
      success: true, id: upload.id,
      uploadUrl: upload.upload_url || `${NOTION_BASE}/file_uploads/${upload.id}/send`,
      mode: isMultiPart ? "multi_part" : "single_part", numberOfParts, uploadName, contentType,
    });
  } catch (err: any) {
    return json({ error: `Error al inicializar upload: ${err.message || "desconocido"}` }, 500);
  }
};
