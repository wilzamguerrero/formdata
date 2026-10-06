import { json, getCredentials, uploadFileToNotion, type Env } from "../_shared/notion";

// 95 MiB — bajo el límite de 100 MB de body por request de Cloudflare.
const MAX_FILE_SIZE = 95 * 1024 * 1024;

/** POST /api/upload-file — sube un archivo (≤95 MB) a Notion (single-part). */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado." }, 400);

  let formData: FormData;
  try {
    formData = await context.request.formData();
  } catch {
    return json({ error: "No se pudo leer el formulario." }, 400);
  }
  const file = formData.get("file") as unknown as File | null;
  if (!file) return json({ error: "No se proporcionó ningún archivo." }, 400);
  if (file.size > MAX_FILE_SIZE) {
    return json({ error: `"${file.name}" excede el límite de 95 MB por archivo en esta vía. Usa la subida por partes.` }, 413);
  }
  try {
    const result = await uploadFileToNotion(file, notionSecret);
    return json({ success: true, id: result.id, finalName: result.finalName, extModified: result.extModified, mimeType: file.type, size: file.size });
  } catch (err: any) {
    return json({ error: `Error al subir "${file.name}" a Notion: ${err.message || "desconocido"}` }, 500);
  }
};
