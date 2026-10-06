// Envío de correos con la Gmail API por HTTP (OAuth2 refresh token).
// Funciona en Node y en Cloudflare Workers/Pages (usa fetch, NO SMTP).
// Portado del sistema de referencia y adaptado a "Universidad de Nariño".

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Correo Gmail remitente (cuenta dueña del refresh token). */
  sender: string;
  /** Nombre visible del remitente. */
  senderName?: string;
}

export interface MailInput {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
}

/** ¿Están completas las credenciales de Gmail? */
export function hasGmailCredentials(creds: Partial<GmailCredentials> | null | undefined): boolean {
  return !!(creds && creds.clientId && creds.clientSecret && creds.refreshToken && creds.sender);
}

function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const g = globalThis as any;
  if (typeof g.Buffer !== "undefined") return g.Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return g.btoa(binary);
}

function toBase64Url(input: string): string {
  return toBase64(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function wrap76(base64: string): string {
  return (base64.match(/.{1,76}/g) || []).join("\r\n");
}

function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${toBase64(subject)}?=`;
}

async function getAccessToken(creds: GmailCredentials): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`No se pudo obtener el access token de Google (${res.status}): ${data.error_description || data.error || "desconocido"}`);
  }
  return data.access_token as string;
}

function buildRawMessage(creds: GmailCredentials, mail: MailInput): string {
  const fromName = creds.senderName || "Universidad de Nariño";
  const toHeader = mail.toName ? `${mail.toName} <${mail.to}>` : mail.to;
  const htmlB64 = wrap76(toBase64(mail.html));
  const headers = [
    `From: ${fromName} <${creds.sender}>`,
    `To: ${toHeader}`,
    `Subject: ${encodeSubject(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${htmlB64}`;
}

/** Envía un correo con la Gmail API. Lanza error si falla. */
export async function sendGmailMessage(creds: GmailCredentials, mail: MailInput): Promise<void> {
  if (!hasGmailCredentials(creds)) {
    throw new Error("Faltan credenciales de Gmail API.");
  }
  const accessToken = await getAccessToken(creds);
  const raw = toBase64Url(buildRawMessage(creds, mail));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    throw new Error(`Gmail API error (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const normalizeHex = (raw?: string): string => {
  if (!raw) return "";
  const h = raw.replace("#", "").trim();
  if (h.length === 3 && /^[0-9a-fA-F]{3}$/.test(h)) return "#" + h.split("").map((c) => c + c).join("");
  if (h.length === 6 && /^[0-9a-fA-F]{6}$/.test(h)) return "#" + h;
  return "";
};

const isLightColor = (hex: string): boolean => {
  const h = normalizeHex(hex).replace("#", "");
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
};

const fontStack = "'Segoe UI', Helvetica, Arial, sans-serif";
const monoStack = "'Courier New', Consolas, monospace";

/** Envoltorio HTML común (cabecera con color del evento + cuerpo + pie). */
function shell(opts: {
  accentColor?: string;
  badge: string;
  heading: string;
  bodyHtml: string;
}): string {
  const headerBg = normalizeHex(opts.accentColor) || "#4f46e5";
  const light = isLightColor(headerBg);
  const headerText = light ? "#111111" : "#ffffff";
  const headerSub = light ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.82)";
  const stripes = `repeating-linear-gradient(119deg, ${headerBg} 0px, ${headerBg} 1px, transparent 1px, transparent 10px)`;
  const bgOuter = `background-color:transparent;background-image:${stripes};`;
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;${bgOuter}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${bgOuter}">
    <tr><td align="center" style="padding:32px 24px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#0d0d0d;border:1px solid rgba(255,255,255,0.10);">
        <tr><td style="background-color:${headerBg};padding:28px 24px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:${headerText};letter-spacing:1px;font-family:${fontStack};">Universidad de Nariño</div>
          <div style="font-size:11px;color:${headerSub};margin-top:8px;letter-spacing:2px;text-transform:uppercase;font-family:${monoStack};">${escapeHtml(opts.badge)}</div>
        </td></tr>
        <tr><td style="padding:28px 24px;">
          <h2 style="color:#ffffff;font-size:18px;margin:0 0 18px;font-family:${fontStack};">${escapeHtml(opts.heading)}</h2>
          ${opts.bodyHtml}
          <p style="color:#5a5a5a;font-size:11px;margin:24px 0 0;text-align:center;font-family:${fontStack};">Este es un correo automático, por favor no respondas a este mensaje.</p>
        </td></tr>
        <tr><td style="height:4px;background-color:${headerBg};font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function dataRows(pairs: [string, string][]): string {
  const labelStyle = `padding:7px 0;color:#7a7a7a;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-family:${monoStack};`;
  const valueStyle = `padding:7px 0;color:#ffffff;font-size:13px;font-weight:600;text-align:right;font-family:${fontStack};`;
  const rows = pairs.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="${labelStyle}">${escapeHtml(k)}</td><td style="${valueStyle}">${escapeHtml(v)}</td></tr>`)
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;">${rows}</table>`;
}

const fmtDate = (ts: string): string => {
  const d = ts ? new Date(ts) : new Date();
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("es-ES", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Correo de confirmación de PREINSCRIPCIÓN. */
export function buildPreinscripcionEmail(data: {
  name: string; email: string; document: string; category: string;
  year?: string; period?: string; program?: string; timestamp: string; accentColor?: string;
}): { subject: string; html: string; text: string } {
  const subject = `Preinscripción recibida · ${data.category}`;
  const scope = [data.year, data.period].filter(Boolean).join(" · ");
  const bodyHtml = `
    <p style="color:#e5e5e5;font-size:15px;line-height:1.6;margin:0 0 22px;font-family:${fontStack};">Hola <strong style="color:#fff;">${escapeHtml(data.name)}</strong>, tu <strong style="color:#fff;">preinscripción</strong> fue registrada correctamente. Conserva este correo como respaldo.</p>
    ${dataRows([
      ["Evento", data.category],
      ...(scope ? [["Año / Periodo", scope] as [string, string]] : []),
      ["Nombre", data.name],
      ["Documento", data.document],
      ["Correo", data.email],
      ...(data.program ? [["Programa / Carrera", data.program] as [string, string]] : []),
      ["Fecha y hora", fmtDate(data.timestamp)],
    ])}`;
  const html = shell({ accentColor: data.accentColor, badge: "Comprobante de preinscripción", heading: "¡Preinscripción recibida!", bodyHtml });
  const text = [
    `Preinscripción recibida - ${data.category}`, ``,
    `Hola ${data.name}, tu preinscripción fue registrada correctamente.`, ``,
    `Evento: ${data.category}`, scope ? `Año/Periodo: ${scope}` : "",
    `Nombre: ${data.name}`, `Documento: ${data.document}`, `Correo: ${data.email}`,
    data.program ? `Programa: ${data.program}` : "", `Fecha: ${fmtDate(data.timestamp)}`, ``,
    `Este es un correo automático, por favor no respondas.`,
  ].filter(Boolean).join("\n");
  return { subject, html, text };
}

/** Correo de confirmación de MATERIAL enviado. */
export function buildMaterialEmail(data: {
  name: string; email: string; document: string; category: string;
  year?: string; period?: string; files: { name: string; size: number }[]; timestamp: string; accentColor?: string;
}): { subject: string; html: string; text: string } {
  const subject = `Material recibido · ${data.category}`;
  const scope = [data.year, data.period].filter(Boolean).join(" · ");
  const fileRows = data.files.map((f) =>
    `<tr><td style="padding:10px 14px;border-bottom:1px solid #1e1e1e;color:#e5e5e5;font-size:13px;word-break:break-all;font-family:${fontStack};">${escapeHtml(f.name)}</td>
     <td style="padding:10px 14px;border-bottom:1px solid #1e1e1e;color:#8a8a8a;font-size:12px;font-family:${monoStack};text-align:right;white-space:nowrap;">${formatBytes(f.size)}</td></tr>`
  ).join("");
  const filesTable = data.files.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#080808;border:1px solid rgba(255,255,255,0.10);border-collapse:separate;">
         <tr><td colspan="2" style="padding:10px 14px;color:#7a7a7a;font-size:10px;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #1e1e1e;font-family:${monoStack};">Archivos enviados (${data.files.length})</td></tr>
         ${fileRows}
       </table>`
    : "";
  const bodyHtml = `
    <p style="color:#e5e5e5;font-size:15px;line-height:1.6;margin:0 0 22px;font-family:${fontStack};">Hola <strong style="color:#fff;">${escapeHtml(data.name)}</strong>, tu <strong style="color:#fff;">material</strong> fue recibido correctamente. Conserva este correo como respaldo.</p>
    ${dataRows([
      ["Evento", data.category],
      ...(scope ? [["Año / Periodo", scope] as [string, string]] : []),
      ["Nombre", data.name],
      ["Documento", data.document],
      ["Correo", data.email],
      ["Fecha y hora", fmtDate(data.timestamp)],
    ])}
    ${filesTable}`;
  const html = shell({ accentColor: data.accentColor, badge: "Comprobante de material", heading: "¡Material recibido!", bodyHtml });
  const text = [
    `Material recibido - ${data.category}`, ``,
    `Hola ${data.name}, tu material fue recibido correctamente.`, ``,
    `Evento: ${data.category}`, scope ? `Año/Periodo: ${scope}` : "",
    `Nombre: ${data.name}`, `Documento: ${data.document}`, `Correo: ${data.email}`,
    `Fecha: ${fmtDate(data.timestamp)}`, ``,
    `Archivos:`, ...data.files.map((f) => `- ${f.name} (${formatBytes(f.size)})`), ``,
    `Este es un correo automático, por favor no respondas.`,
  ].filter(Boolean).join("\n");
  return { subject, html, text };
}
