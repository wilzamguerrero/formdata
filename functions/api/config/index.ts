import { json, getCredentials, type Env } from "../../_shared/notion";

/** GET /api/config — estado de configuración (sin exponer el secreto). */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { notionSecret, parentPageId } = await getCredentials(context.env);
  return json({ success: true, isConfigured: !!(notionSecret && parentPageId) });
};
