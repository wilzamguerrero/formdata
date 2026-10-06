import { json, getCredentials, describeCategory, type Env } from "../_shared/notion";

/** GET /api/category-structure?categoryId=... — años/periodos de una categoría. */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado." }, 400);
  const categoryId = new URL(context.request.url).searchParams.get("categoryId") || "";
  if (!categoryId) return json({ error: "Se requiere categoryId." }, 400);
  try {
    const structure = await describeCategory(categoryId, notionSecret);
    return json({ success: true, structure });
  } catch (err: any) {
    return json({ error: `Error al leer la estructura: ${err.message || "desconocido"}` }, 500);
  }
};
