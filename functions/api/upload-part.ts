import { json, getCredentials, NOTION_BASE, NOTION_VERSION, type Env } from "../_shared/notion";

/**
 * POST /api/upload-part?upload_id=<id>
 * Reenvía un chunk multipart/form-data directo a Notion SIN parsearlo.
 *
 * IMPORTANTE (límite de CPU de Cloudflare, ~10-50ms por request):
 * NO se usa formData(). Parsear/reserializar un chunk de 10 MiB consume mucho
 * más CPU que el límite y mata la invocación (Error 1102 → 503). En su lugar, el
 * navegador manda un body que Notion ya entiende (form con `file` y
 * `part_number`) y aquí solo se le añade la cabecera de auth y se hace pipe del
 * stream crudo. Hacer pipe usa casi nada de CPU, sin importar el tamaño.
 *
 * El upload_id va por query param para no tener que leer el body.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado." }, 400);

  const uploadId = new URL(context.request.url).searchParams.get("upload_id");
  if (!uploadId) return json({ error: "Se requiere upload_id." }, 400);

  const contentType = context.request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({ error: "Content-Type debe ser multipart/form-data." }, 400);
  }

  try {
    const sendRes = await fetch(`${NOTION_BASE}/file_uploads/${uploadId}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionSecret}`,
        "Notion-Version": NOTION_VERSION,
        // Preservar el boundary original para que Notion parsee las partes.
        "Content-Type": contentType,
      },
      body: context.request.body,
    });
    if (!sendRes.ok) {
      const errText = await sendRes.text();
      // Errores transitorios → 503 para que el navegador reintente esa parte.
      const transient = [429, 500, 502, 503, 504, 529].includes(sendRes.status);
      return json({ error: `Notion rechazó el chunk: ${sendRes.status} - ${errText}` }, transient ? 503 : 502);
    }
    const result = (await sendRes.json()) as any;
    return json({ success: true, status: result.status });
  } catch (err: any) {
    return json({ error: `Error al enviar chunk: ${err.message || "desconocido"}` }, 503);
  }
};
