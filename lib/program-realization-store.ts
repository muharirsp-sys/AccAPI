/** Tujuan: Simpan hasil verifikasi faktur pada antrean program dengan identitas database+record.
 * Caller: webhook sync, cron invoice, API realisasi. Dependensi: Drizzle, Accurate detail.do, pure verifier.
 * Main Functions: recordInvoiceRealization, refreshRealization. Side Effects: HTTP baca, satu UPDATE CAS; tidak kirim faktur.
 */
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { invoiceOutbox } from "../db/schema";
import { unavailable, verifyRealization } from "./program-realization";
import type { InvoiceOrder, InvoicePayload } from "./accurate-invoice-write";
import type { AccurateCredentials } from "./sync";

export async function recordInvoiceRealization(databaseId: string, invoiceId: string, detail: unknown) {
    if (!databaseId || !invoiceId) return;
    const key = and(eq(invoiceOutbox.state, "posted"), eq(invoiceOutbox.accurateDbId, databaseId), eq(invoiceOutbox.accurateId, invoiceId));
    const rows = await db.select({ id: invoiceOutbox.orderId, snapshot: invoiceOutbox.programSnapshot, payload: invoiceOutbox.payload }).from(invoiceOutbox).where(key).limit(2);
    if (rows.length !== 1) return; // ambiguous identity never attributes spending twice
    const row = rows[0];
    const result = !row.snapshot ? unavailable("Order lama belum memiliki snapshot program") :
        detail === null ? unavailable("Faktur tidak ditemukan di Accurate") :
        verifyRealization(row.snapshot as InvoiceOrder, row.payload as InvoicePayload, detail, invoiceId);
    await db.update(invoiceOutbox).set({ realization: result, realizationCheckedAt: new Date() }).where(and(key, eq(invoiceOutbox.orderId, row.id)));
    return result;
}

export async function refreshRealization(orderId: string, creds: AccurateCredentials) {
    const [row] = await db.select({ state: invoiceOutbox.state, databaseId: invoiceOutbox.accurateDbId, invoiceId: invoiceOutbox.accurateId })
        .from(invoiceOutbox).where(eq(invoiceOutbox.orderId, orderId)).limit(1);
    if (!row || row.state !== "posted") throw new Error("Order belum memiliki faktur terkirim");
    if (!creds.databaseId || creds.databaseId !== row.databaseId) throw new Error("Database sesi Accurate tidak cocok dengan faktur");
    const response = await fetch(`${creds.sessionHost}/accurate/api/sales-invoice/detail.do?id=${encodeURIComponent(row.invoiceId)}`, {
        headers: { Authorization: `Bearer ${creds.apiKey}`, "X-Session-ID": creds.sessionId, Accept: "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.s !== true) throw new Error("Faktur Accurate belum dapat diperiksa");
    return recordInvoiceRealization(row.databaseId, row.invoiceId, body.d ?? null);
}
