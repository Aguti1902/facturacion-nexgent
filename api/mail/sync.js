// Copia los últimos correos de info@nexgent.io (cabeceras y un extracto) a la tabla mail_inbox de Supabase,
// para que NexGent OS y sus agentes lleven el control de las solicitudes. No devuelve contenido de correos.
// Lo llaman el cron diario de Vercel y el agente de Solicitudes; como mucho una sincronización cada 2 minutos.
import { createClient } from "@supabase/supabase-js";
import { simpleParser } from "mailparser";
import { send, withImap, folders, imapConfigured } from "../../lib/common.js";

const DAYS = 21;
const MAX_MSGS = 60;
const MAX_SOURCE = 400 * 1024;

function clean(t) {
  return String(t || "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

export default async function handler(req, res) {
  const secret = process.env.MAIL_INGEST_SECRET;
  if (!secret) return send(res, 412, { ok: false, error: "Falta MAIL_INGEST_SECRET en Vercel" });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  const force = String(req.query?.force || "") === "1" && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!force) {
    const { data: due, error } = await sb.rpc("mail_sync_due", { p_secret: secret, p_min_seconds: 120 });
    if (error) return send(res, 500, { ok: false, error: "No se pudo comprobar el estado de la sincronización" });
    if (!due) return send(res, 200, { ok: true, skipped: "Sincronizado hace menos de 2 minutos" });
  }
  if (!imapConfigured()) {
    await sb.rpc("ingest_mail", { p_secret: secret, p_rows: [], p_error: "IMAP sin configurar" });
    return send(res, 412, { ok: false, error: "Falta la contraseña IMAP de info@nexgent.io en Vercel" });
  }

  const rows = [];
  try {
    await withImap(async client => {
      for (const folder of folders()) {
        const lock = await client.getMailboxLock(folder);
        try {
          const since = new Date(Date.now() - DAYS * 864e5);
          const uids = (await client.search({ since }, { uid: true })) || [];
          const last = uids.slice(-MAX_MSGS);
          if (!last.length) continue;
          for await (const m of client.fetch(last, { uid: true, envelope: true, flags: true, size: true, internalDate: true }, { uid: true })) {
            const env = m.envelope || {};
            const from = (env.from && env.from[0]) || {};
            let snippet = "", attach = false;
            if ((m.size || 0) <= MAX_SOURCE) {
              try {
                const full = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
                const parsed = await simpleParser(full.source);
                snippet = clean(parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : ""));
                attach = (parsed.attachments || []).some(a => a.contentDisposition === "attachment" || /pdf|image/.test(a.contentType || ""));
              } catch {}
            }
            rows.push({
              id: env.messageId || `${folder}:${m.uid}`,
              received_at: (m.internalDate || env.date || new Date()).toISOString(),
              from_name: from.name || "",
              from_email: from.address || "",
              to_email: (env.to || []).map(t => t.address).filter(Boolean).join(", "),
              subject: env.subject || "",
              snippet,
              has_attachments: attach,
              folder,
              seen: m.flags ? m.flags.has("\\Seen") : null,
            });
          }
        } finally { lock.release(); }
      }
    });
  } catch (e) {
    await sb.rpc("ingest_mail", { p_secret: secret, p_rows: [], p_error: e.message || "Error IMAP" });
    return send(res, e.status || 500, { ok: false, error: e.message || "Error leyendo el correo" });
  }

  const { data, error } = await sb.rpc("ingest_mail", { p_secret: secret, p_rows: rows, p_error: null });
  if (error) return send(res, 500, { ok: false, error: "No se pudo guardar en Supabase" });
  return send(res, 200, { ok: true, rows: data?.rows ?? rows.length });
}
