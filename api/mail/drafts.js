// Deja borradores en la carpeta Borradores de alejandro@nexgent.io (IMAP APPEND con la marca \Draft).
// NUNCA envía correos: Alejandro los revisa y los envía él desde su webmail.
// Los agentes (Vela, Alba) dejan los borradores en la tabla mail_drafts de Supabase y llaman a esta URL.
// Formato del cuerpo (body_md): texto con párrafos separados por línea en blanco y enlaces [frase](url).
import { createClient } from "@supabase/supabase-js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { send, withImap, imapConfigured } from "../../lib/common.js";

const PDF_URL = "https://www.nexgent.io/consultores/Nexgent-IA-consultores.pdf";
const FROM = { name: "Alejandro Gutiérrez", address: process.env.ALEJANDRO_IMAP_USER || "alejandro@nexgent.io" };

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function mdToHtml(t) {
  t = String(t || "").replace(/\r/g, "");
  let o = "", last = 0;
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(t))) {
    o += esc(t.slice(last, m.index)) + `<a href="${esc(m[2])}" style="color:#1a73e8;font-weight:600;text-decoration:underline">${esc(m[1])}</a>`;
    last = re.lastIndex;
  }
  o += esc(t.slice(last));
  const paras = o.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328">${paras}</div>`;
}

export function mdToText(t) {
  return String(t || "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}

let pdfCache = null;
async function pdf() {
  if (pdfCache) return pdfCache;
  const r = await fetch(PDF_URL);
  if (!r.ok) throw new Error("No se pudo descargar la presentación en PDF");
  pdfCache = Buffer.from(await r.arrayBuffer());
  return pdfCache;
}

function build(d, attachment) {
  const mail = new MailComposer({
    from: FROM,
    to: d.to_email,
    cc: d.cc || undefined,
    subject: d.subject,
    text: mdToText(d.body_md),
    html: mdToHtml(d.body_md),
    inReplyTo: d.in_reply_to || undefined,
    references: d.in_reply_to || undefined,
    attachments: attachment ? [{ filename: "Nexgent-IA-consultores.pdf", content: attachment, contentType: "application/pdf" }] : [],
  });
  return new Promise((ok, ko) => mail.compile().build((e, msg) => (e ? ko(e) : ok(msg))));
}

export default async function handler(req, res) {
  const secret = process.env.MAIL_INGEST_SECRET;
  if (!secret) return send(res, 412, { ok: false, error: "Falta MAIL_INGEST_SECRET en Vercel" });
  if (!imapConfigured("alejandro")) return send(res, 412, { ok: false, error: "Falta ALEJANDRO_IMAP_PASSWORD en Vercel" });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  const { data: pending, error } = await sb.rpc("mail_drafts_pending", { p_secret: secret, p_limit: 8 });
  if (error) return send(res, 500, { ok: false, error: "No se pudo leer la cola de borradores" });
  if (!pending || !pending.length) return send(res, 200, { ok: true, created: 0, pending: 0 });

  const done = [], failed = [];
  try {
    await withImap(async client => {
      const boxes = await client.list();
      const drafts = boxes.find(b => b.specialUse === "\\Drafts") || boxes.find(b => /(^|[./])drafts$/i.test(b.path));
      if (!drafts) throw Object.assign(new Error("No encuentro la carpeta Borradores"), { status: 500 });
      for (const d of pending) {
        try {
          const raw = await build(d, d.attach_pdf ? await pdf() : null);
          await client.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
          await sb.rpc("mail_drafts_done", { p_secret: secret, p_id: d.id, p_ok: true, p_error: "" });
          done.push(d.id);
        } catch (e) {
          await sb.rpc("mail_drafts_done", { p_secret: secret, p_id: d.id, p_ok: false, p_error: String(e.message || e).slice(0, 300) });
          failed.push(d.id);
        }
      }
    }, "alejandro");
  } catch (e) {
    return send(res, e.status || 500, { ok: false, error: e.message || "Error con el correo de alejandro@" });
  }
  return send(res, 200, { ok: true, created: done.length, failed: failed.length, ids: done });
}
