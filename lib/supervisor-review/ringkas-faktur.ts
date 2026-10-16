/*
 * Tujuan: Ringkas satu faktur Accurate (jawaban detail.do / `sales_invoice.raw_data`) menjadi empat kolom Supervisor Review
 *   (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.2): salesman header, qty satuan terkecil, jumlah baris, DPP.
 * Caller: lib/sync.ts (SYNC_MODULES.sales_invoice.upsertPage — webhook, webhook-backfill, invoice-outbox/send, cron list.do) DAN
 *   scripts/backfill-ringkas-faktur.mjs (fungsi yang SAMA, tanpa logika SQL kembar).
 * Dependensi: TIDAK ADA (sengaja tanpa impor: skrip backfill menjalankannya lewat `node --experimental-strip-types` di container).
 * Main Functions: ringkasFaktur. Side Effects: tidak ada.
 * Rumus sama dengan pembaca lain: qty = lib/promo-recap.ts invoiceLines (quantityDefault, cadangan quantity × unitRatio);
 *   DPP = lib/sales-history/accurate.ts (dppAmount).
 */

export interface RingkasanFaktur {
    salesmanId: number | null;
    qtyTotal: number | null;
    jumlahItem: number | null;
    dpp: number | null;
}

const angka = (v: unknown) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) ? n : 0; };
const sen = (v: number) => Math.round(v * 100) / 100;

/** `raw` = objek atau STRING JSON (raw_data tersimpan sebagai string di jsonb). `detailItem` bukan larik = rincian belum terbaca -> semua null. */
export function ringkasFaktur(raw: unknown): RingkasanFaktur {
    let f: unknown = raw;
    if (typeof raw === "string") {
        try { f = JSON.parse(raw); } catch { f = null; }
    }
    const faktur = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    if (!Array.isArray(faktur.detailItem)) return { salesmanId: null, qtyTotal: null, jumlahItem: null, dpp: null };
    const rinci = faktur.detailItem.map((d) => (d && typeof d === "object" ? d : {}) as Record<string, unknown>);
    const id = angka(faktur.masterSalesmanId);
    return {
        salesmanId: Number.isSafeInteger(id) && id > 0 ? id : null,
        qtyTotal: sen(rinci.reduce((s, d) => s + (angka(d.quantityDefault) || sen(angka(d.quantity) * (angka(d.unitRatio) || 1))), 0)),
        jumlahItem: rinci.length,
        dpp: sen(rinci.reduce((s, d) => s + angka(d.dppAmount), 0)),
    };
}
