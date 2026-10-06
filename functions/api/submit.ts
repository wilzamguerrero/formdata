import {
  json, getCredentials, resolveDestination, buildSubmissionBlocks,
  notionFetch, DEST_DATA, type Env,
} from "../_shared/notion";
import {
  hasGmailCredentials, sendGmailMessage, buildPreinscripcionEmail, buildMaterialEmail,
} from "../_shared/email";

interface FileRecord { name: string; finalName: string; size: number; uploadId: string; extModified: boolean; mimeType: string; }

/** POST /api/submit — registra una preinscripción (1REGISTRO) o material (2DATA). */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { notionSecret } = await getCredentials(context.env);
  if (!notionSecret) return json({ error: "Notion no está configurado en el servidor." }, 400);

  let body: any;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Cuerpo de solicitud inválido." }, 400);
  }

  const {
    senderName = "", senderEmail = "", projectId = "", projectName = "Evento",
    fileRecords = [], comment = "", document = "", dest = "", year = "", period = "",
    program = "", accentColor = "",
  } = body as {
    senderName: string; senderEmail: string; projectId: string; projectName: string;
    fileRecords: FileRecord[]; comment: string; document: string; dest: string;
    year: string; period: string; program: string; accentColor: string;
  };

  const trimmedComment = String(comment || "").trim();
  const trimmedDocument = String(document || "").trim();
  const destType = String(dest || "").trim() === DEST_DATA ? DEST_DATA : "1REGISTRO";

  if (!senderName || !senderEmail || !projectId) {
    return json({ error: "Faltan campos obligatorios (nombre, correo o categoría)." }, 400);
  }
  if (fileRecords.length === 0 && !trimmedComment) {
    return json({ error: "Adjunta al menos un archivo o escribe un comentario." }, 400);
  }

  const dateStr = new Date().toLocaleString("es-ES", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }) + " UTC";
  const toggleHeader = `👤 ${String(senderName).trim()} (${String(senderEmail).trim()}) — ${dateStr}`;

  try {
    const destinationId = await resolveDestination(projectId, destType, notionSecret, year, period);
    const blocks = buildSubmissionBlocks({
      senderName: String(senderName).trim(), senderEmail: String(senderEmail).trim(),
      document: trimmedDocument, comment: trimmedComment, dateStr, fileRecords,
    });
    const appendRes = await notionFetch("PATCH", `/blocks/${destinationId}/children`, notionSecret, {
      children: [{ object: "block", type: "toggle", toggle: { rich_text: [{ type: "text", text: { content: toggleHeader } }], children: blocks } }],
    });
    const notionBlockId = appendRes?.results?.[0]?.id || "";
    const timestamp = new Date().toISOString();

    // Correo de confirmación (best-effort, en segundo plano con waitUntil).
    const gmailCreds = {
      clientId: context.env.GMAIL_CLIENT_ID || "",
      clientSecret: context.env.GMAIL_CLIENT_SECRET || "",
      refreshToken: context.env.GMAIL_REFRESH_TOKEN || "",
      sender: context.env.GMAIL_SENDER || "",
      senderName: context.env.MAIL_FROM_NAME || "Universidad de Nariño",
    };
    if (hasGmailCredentials(gmailCreds)) {
      const common = {
        name: String(senderName).trim(), email: String(senderEmail).trim(), document: trimmedDocument,
        category: projectName || "Evento",
        year: String(year || "").trim() || undefined, period: String(period || "").trim() || undefined,
        timestamp, accentColor: String(accentColor || "").trim() || undefined,
      };
      const mail = destType === DEST_DATA
        ? buildMaterialEmail({ ...common, files: fileRecords.map((f) => ({ name: f.name, size: f.size })) })
        : buildPreinscripcionEmail({ ...common, program: String(program || "").trim() || undefined });
      context.waitUntil(
        sendGmailMessage(gmailCreds, { to: common.email, toName: common.name, subject: mail.subject, html: mail.html, text: mail.text })
          .catch((e) => console.error("No se pudo enviar el correo:", e?.message || e))
      );
    }

    return json({
      success: true,
      message: "Registrado en Notion con éxito.",
      submission: {
        id: "sub_" + Date.now(), projectId, projectName: projectName || "Categoría de Notion",
        senderName: String(senderName).trim(), senderEmail: String(senderEmail).trim(),
        timestamp, notionBlockId, comment: trimmedComment, document: trimmedDocument,
        files: fileRecords.map((f) => ({ name: f.name, size: f.size })),
      },
    });
  } catch (err: any) {
    return json({ error: `Error al guardar en Notion: ${err.message || "desconocido"}` }, 500);
  }
};
