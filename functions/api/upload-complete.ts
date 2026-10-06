import { json, getCredentials, NOTION_BASE, NOTION_VERSION, type Env } from "../_shared/notion";

/** POST /api/upload-complete — finaliza un multi-part upload en Notion. */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado." }, 400);

  let body: { uploadId?: string };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Cuerpo de solicitud inválido." }, 400);
  }
  const { uploadId } = body || {};
  if (!uploadId) return json({ error: "Se requiere uploadId." }, 400);

  try {
    const completeRes = await fetch(`${NOTION_BASE}/file_uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${notionSecret}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    });
    if (!completeRes.ok) throw new Error(`Notion rechazó el complete: ${completeRes.status} - ${await completeRes.text()}`);
    const result = (await completeRes.json()) as any;
    return json({ success: true, id: uploadId, status: result.status, finalName: result.filename });
  } catch (err: any) {
    return json({ error: `Error al completar upload: ${err.message || "desconocido"}` }, 500);
  }
};
