// Busca facturas recibidas en info@nexgent.io y las deja en la tabla mail_invoices de Supabase
// (remitente, asunto, texto del PDF y enlaces), con el PDF guardado en el almacén «facturas».
// Después el agente contable de NexGent OS las lee y las contabiliza como gastos.
// No devuelve el contenido de los correos. Idempotente: un correo ya capturado o importado no se vuelve a leer.
import { createClient } from "@supabase/supabase-js";
import { simpleParser } from "mailparser";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import crypto from "node:crypto";
import { send, withImap, folders, imapConfigured } from "../../lib/common.js";

const KEYWORDS = /(factura|invoice|recibo|receipt|billing|facturaci[oó]n|payment|pago|justificante|statement|cargo|renovaci[oó]n|renewal|suscripci[oó]n|subscription)/i;
const PER_CALL = 10;
const MAX_SOURCE = 12 * 1024 * 1024;
const isPdf = a => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename || "") || (a.content && a.content.slice(0, 4).toString() === "%PDF");

function hasPdf(node) {
  if (!node) return false;
  const type = `${node.type || ""}`.toLowerCase();
  const name = `${node.dispositionParameters?.filename || node.parameters?.name || ""}`.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return true;
  return (node.childNodes || []).some(hasPdf);
}

function invoiceLinks(html) {
  const out = new Set();
  for (const m of String(html || "").matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, " ");
    if (KEYWORDS.test(text) || /invoice|factura|receipt|billing|pdf/i.test(m[1])) out.add(m[1].slice(0, 500));
    if (out.size >= 5) break;
  }
  return [...out];
}

export default async function handler(req, res) {
  const secret = process.env.MAIL_INGEST_SECRET;
  if (!secret) return send(res, 412, { ok: false, error: "Falta MAIL_INGEST_SECRET en Vercel" });
  if (!imapConfigured()) return send(res, 412, { ok: false, error: "Falta la configuración IMAP en Vercel" });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  const { data: due, error: dueErr } = await sb.rpc("invoice_sync_due", { p_secret: secret, p_min_seconds: 20 });
  if (dueErr) return send(res, 500, { ok: false, error: "No se pudo comprobar el estado" });
  if (!due) return send(res, 200, { ok: true, skipped: "Revisado hace menos de 20 segundos; vuelve a llamar en un momento" });

  const days = Math.min(400, Math.max(1, parseInt(new URL(req.url, "http://x").searchParams.get("days") || "45", 10) || 45));
  const own = (process.env.IMAP_USER || "").toLowerCase();
  let captured = 0, withPdf = 0, pending = 0, scanned = 0;

  try {
    await withImap(async client => {
      for (const folder of folders()) {
        let lock;
        try { lock = await client.getMailboxLock(folder); } catch { continue; }
        try {
          const uids = (await client.search({ since: new Date(Date.now() - days * 864e5) }, { uid: true })) || [];
          if (!uids.length) continue;
          const cands = [];
          for await (const m of client.fetch(uids.slice(-600), { envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
            const env = m.envelope || {};
            const sender = (env.from && env.from[0]) || {};
            if (own && (sender.address || "").toLowerCase() === own) continue;
            const pdf = hasPdf(m.bodyStructure);
            if (!pdf && !KEYWORDS.test(env.subject || "")) continue;
            const key = env.messageId || `${folder}:${client.mailbox.uidValidity}:${m.uid}`;
            cands.push({ id: "imap-" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 20), uid: m.uid, size: m.size || 0, date: m.internalDate || env.date });
          }
          scanned += cands.length;
          if (!cands.length) continue;
          const { data: known, error: kErr } = await sb.rpc("invoice_known", { p_secret: secret, p_ids: cands.map(c => c.id) });
          if (kErr) throw new Error("No se pudo consultar Supabase");
          const todo = cands.filter(c => !(known || []).includes(c.id)).sort((a, b) => new Date(b.date) - new Date(a.date));
          pending += todo.length;
          for (const c of todo) {
            if (captured >= PER_CALL) break;
            if (c.size > MAX_SOURCE) continue;
            const full = await client.fetchOne(String(c.uid), { source: true }, { uid: true });
            if (!full?.source) continue;
            const mail = await simpleParser(full.source);
            const pdf = (mail.attachments || []).find(isPdf);
            let pdfText = "";
            if (pdf) { try { pdfText = (await pdfParse(pdf.content, { max: 4 })).text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").slice(0, 18000); } catch {} }
            const from = mail.from?.value?.[0] || {};
            const row = {
              id: c.id,
              received_at: new Date(mail.date || c.date || Date.now()).toISOString(),
              from_name: from.name || "", from_email: from.address || "",
              subject: mail.subject || "",
              snippet: String(mail.text || "").replace(/\s+/g, " ").trim().slice(0, 2000),
              has_pdf: !!pdf, pdf_name: pdf ? (pdf.filename || "factura.pdf") : "",
              pdf_path: pdf ? `gastos/${c.id}.pdf` : "",
              pdf_text: pdfText,
              links: pdf ? [] : invoiceLinks(mail.html),
            };
            const { data: inserted, error: insErr } = await sb.rpc("ingest_invoice", { p_secret: secret, p_row: row });
            if (insErr) throw new Error("No se pudo guardar en Supabase");
            if (!inserted) continue;
            captured++; pending--;
            if (pdf) {
              const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/invoice-pdf`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret, id: c.id, pdf_b64: pdf.content.toString("base64") }),
              }).catch(() => null);
              if (r && r.ok) withPdf++;
              else await sb.rpc("invoice_pdf_failed", { p_secret: secret, p_id: c.id });
            }
          }
        } finally { lock.release(); }
        if (captured >= PER_CALL) break;
      }
    });
  } catch (e) {
    return send(res, e.status || 500, { ok: false, error: e.message || "Error leyendo el correo" });
  }
  const result = { ok: true, days, scanned, captured, withPdf, pending: Math.max(0, pending) };
  await sb.rpc("invoice_sync_done", { p_secret: secret, p_result: result });
  return send(res, 200, result);
}
