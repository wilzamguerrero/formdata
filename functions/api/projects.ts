import { json, getCredentials, collectProjects, type Env } from "../_shared/notion";

/** GET /api/projects — categorías (proyectos de la página madre). */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { notionSecret, parentPageId } = await getCredentials(context.env);
  if (!notionSecret || !parentPageId) {
    return json({ error: "Notion no está configurado. Define NOTION_SECRET y NOTION_ID_PAGE." }, 400);
  }
  try {
    const projects = await collectProjects(parentPageId, notionSecret);
    return json({ success: true, projects });
  } catch (err: any) {
    return json({ error: `Error al conectar con Notion: ${err.message || "desconocido"}` }, 500);
  }
};
