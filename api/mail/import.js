import { send, authUser, withImap, readJson } from "../../lib/common.js";
import { simpleParser } from "mailparser";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import Anthropic from "@anthropic-ai/sdk";
import { heuristicExtract } from "../../lib/heuristic.js";

const CATS = ["Software y suscripciones","Servidores y hosting","Publicidad","Material y equipos","Servicios profesionales","Viajes y dietas","Formación","Oficina y suministros","Comisiones bancarias","Otros"];
const r2 = n => Math.round((+n || 0) * 100) / 100;
const isPdf = a => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename || "") || (a.content && a.content.slice(0, 4).toString() === "%PDF");

async function extract(company, mail, pdfText) {
  const fromName = mail.from?.value?.[0]?.name || mail.from?.value?.[0]?.address || "";
  const dateIso = (mail.date || new Date()).toISOString().slice(0, 10);
  const fallback = { supplier: fromName, cif: "", number: "", date: dateIso, concept: (mail.subject || "").slice(0, 80), category: "Otros", currency: "EUR", base: 0, vat_rate: 21, vat_amount: null, total: 0, reverse_charge: false, is_invoice: true, confidence: "baja" };
  const basic = () => ({ ...fallback, ...heuristicExtract({ text: pdfText || mail.text || "", subject: mail.subject || "", fromName, dateIso, companyCif: company.cif || "" }), needsReview: true, noAi: true });
  if (!process.env.ANTHROPIC_API_KEY) return basic();
  const prompt = `Eres un asistente contable español. Extrae los datos de una factura RECIBIDA por la empresa ${company.name || ""} (CIF ${company.cif || "-"}), a partir del correo y del texto de su PDF adjunto.
Devuelve SOLO un objeto JSON, sin texto alrededor, con estas claves:
supplier (razón social del emisor), cif (NIF/VAT del emisor o ""), number (nº de factura o ""), date (fecha de la factura, AAAA-MM-DD), concept (descripción breve, máx. 70 caracteres),
category (una de: ${CATS.join(" | ")}), currency (código ISO, p. ej. EUR, USD), base (base imponible, número), vat_rate (tipo de IVA en %, número; 0 si no hay IVA), vat_amount (cuota de IVA, número), total (total, número),
reverse_charge (true si el emisor está fuera de España y no cobra IVA español: inversión del sujeto pasivo), is_invoice (false si el correo NO contiene una factura o recibo de un gasto: publicidad, avisos, o facturas emitidas por ${company.name || "la empresa"}), confidence ("alta" | "media" | "baja").
Usa punto decimal. Si solo hay un total sin desglose, pon base = total y vat_amount = 0 salvo que el IVA aparezca indicado.

CORREO
De: ${mail.from?.text || ""}
Asunto: ${mail.subject || ""}
Fecha: ${mail.date || ""}
${(mail.text || "").slice(0, 5000)}

TEXTO DEL PDF
${pdfText || "(no hay PDF adjunto o no se pudo leer)"}`;
  try {
    const client = new Anthropic();
    const r = await client.messages.create({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const txt = r.content.map(b => b.text || "").join("");
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    return { ...fallback, ...j, needsReview: j.confidence !== "alta" };
  } catch (e) {
    return { ...basic(), aiError: String(e.message || e).slice(0, 200) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Usa POST" });
  try {
    const { sb } = await authUser(req);
    const { id, folder, uid } = await readJson(req);
    if (!/^imap-[0-9a-f]{20}$/.test(id || "") || !folder || !uid) return send(res, 400, { error: "Petición no válida" });

    const { data: existing } = await sb.from("docs").select("id").eq("collection", "expenses").eq("id", id).maybeSingle();
    if (existing) return send(res, 200, { status: "duplicate" });

    const raw = await withImap(async client => {
      const lock = await client.getMailboxLock(folder);
      try {
        const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
        return m && m.source;
      } finally { lock.release(); }
    });
    if (!raw) return send(res, 404, { error: "No se encontró el correo" });

    const mail = await simpleParser(raw);
    const pdf = (mail.attachments || []).find(isPdf);
    let pdfText = "";
    if (pdf) { try { pdfText = (await pdfParse(pdf.content, { max: 3 })).text.slice(0, 14000); } catch {} }

    const { data: comp } = await sb.from("docs").select("data").eq("collection", "settings").eq("id", "company").maybeSingle();
    const f = await extract(comp?.data || {}, mail, pdfText);
    if (f.is_invoice === false) return send(res, 200, { status: "skipped" });

    let assetId = "", assetName = "";
    if (pdf) {
      const path = `gastos/${id}.pdf`;
      const up = await sb.storage.from("facturas").upload(path, pdf.content, { contentType: "application/pdf", upsert: true });
      if (up.error) throw Object.assign(new Error("No se pudo guardar el PDF: " + up.error.message), { status: 500 });
      assetId = path; assetName = pdf.filename || "factura.pdf";
    }
    const cur = String(f.currency || "EUR").toUpperCase();
    const doc = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || "") ? f.date : (mail.date || new Date()).toISOString().slice(0, 10),
      supplier: String(f.supplier || "").slice(0, 120), cif: f.cif || "", number: f.number || "", concept: String(f.concept || "").slice(0, 120),
      category: CATS.includes(f.category) ? f.category : "Otros",
      base: r2(f.base), vat: f.reverse_charge ? 0 : (+f.vat_rate || 0), vatAmount: f.reverse_charge ? 0 : (f.vat_amount != null ? r2(f.vat_amount) : null),
      total: cur === "EUR" && f.total ? r2(f.total) : null, deductible: true, reverseCharge: !!f.reverse_charge,
      assetId, assetName, source: "correo", mailSubject: mail.subject || "", mailFrom: mail.from?.text || "",
      currency: cur, originalAmount: cur !== "EUR" ? String(f.total ?? "") : "", needsReview: !!f.needsReview || cur !== "EUR",
      importedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const ins = await sb.from("docs").insert({ collection: "expenses", id, data: doc });
    if (ins.error) throw Object.assign(new Error("No se pudo guardar el gasto: " + ins.error.message), { status: 500 });
    send(res, 200, { status: "imported", hasPdf: !!pdf, needsReview: doc.needsReview, noAi: !!f.noAi, aiError: f.aiError || null });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "Error", code: e.code });
  }
}
