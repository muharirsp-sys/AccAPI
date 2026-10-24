/*
 * Tujuan: Bandingkan dua jawaban detail.do faktur penjualan -> baris perubahan rincian (tabel sales_invoice_line_change).
 * Caller: lib/sync.ts (upsertSalesInvoiceById). Spec: docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §6-7.
 * Dependensi: tidak ada — murni, tanpa DB/jaringan.
 * Main Functions: diffInvoiceLines, deletedInvoiceLines, parseRaw, parsePrintedView.
 * Side Effects: tidak ada.
 */

export type ChangeSource = "webhook" | "backfill" | "send";
/** Asal simpan. appKey: '' = orang di layar Accurate, terisi = aplikasi, null = tidak diketahui (di luar webhook). */
export type ChangeContext = { source: ChangeSource; appKey: string | null; savedAt: Date | null };
export const BACKFILL: ChangeContext = { source: "backfill", appKey: null, savedAt: null };

export type LineSnapshot = {
    qty: number; unit: string; ratio: number | null; price: number;
    discPercent: string; discRp: number; total: number; warehouse: string;
};
export type ChangeKind = "removed" | "added" | "changed" | "invoice_deleted";
/** Satu baris tabel sales_invoice_line_change; nama kunci = nama kolom Drizzle (db/schema.ts salesInvoiceLineChange). */
export type LineChangeRow = {
    invoiceId: number; invoiceNumber: string; transDate: string; customerNo: string;
    kind: ChangeKind; lineId: number | null; itemNo: string; itemName: string;
    oldLine: LineSnapshot | null; newLine: LineSnapshot | null; baseQtyDelta: number | null;
    totalBefore: number | null; totalAfter: number | null;
    appKey: string | null; source: ChangeSource; savedAt: Date | null;
    printedAt: Date | null; printedBy: string; afterPrint: boolean; detectedAt: Date;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const teks = (v: unknown) => String(v ?? "").trim();
const angka = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const angkaAtauNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** raw_data tersimpan sebagai STRING JSON di kolom jsonb (lib/sync.ts); terima string (sekali/dua kali dienkode), objek, atau null. */
export function parseRaw(raw: unknown): Obj | null {
    let v = raw;
    for (let i = 0; i < 2 && typeof v === "string"; i++) {
        try { v = JSON.parse(v); } catch { return null; }
    }
    return v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
}

const BULAN: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Mei: "05", Jun: "06", Jul: "07",
    Aug: "08", Agu: "08", Sep: "09", Oct: "10", Okt: "10", Nov: "11", Dec: "12", Des: "12" };
/**
 * printedTimeView "17 Oct 2026 15:23:23" -> Date. Keluarga *View = WIB (createDateView sama dengan createDate yang cocok dengan
 * receivedAt webhook); printedTime "17/10/2026, 16:23" = WITA tanpa detik, jadi tidak dipakai. "Belum cetak/email"/kosong -> null.
 */
export function parsePrintedView(v: unknown): Date | null {
    const m = teks(v).match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
    const bulan = m ? BULAN[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()] : undefined;
    if (!m || !bulan) return null;
    const d = new Date(`${m[3]}-${bulan}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}+07:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function snapshot(d: Obj): LineSnapshot {
    const ratio = angkaAtauNull(d.unitRatio);
    return {
        qty: angka(d.quantity), unit: teks(obj(d.itemUnit).name), ratio: ratio !== null && ratio > 0 ? ratio : null,
        price: angka(d.unitPrice), discPercent: teks(d.itemDiscPercent), discRp: angka(d.itemCashDiscount),
        total: angka(d.totalPrice), warehouse: teks(obj(d.warehouse).name),
    };
}
const dekat = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-6);
/** Kolom pembanding spec §6. totalPrice (turunan) dan qty kirim/retur/salesman sengaja tidak ikut. */
const samaBaris = (a: LineSnapshot, b: LineSnapshot) => dekat(a.qty, b.qty) && a.unit === b.unit && dekat(a.ratio, b.ratio)
    && dekat(a.price, b.price) && a.discPercent === b.discPercent && dekat(a.discRp, b.discRp) && a.warehouse === b.warehouse;
const dasar = (l: LineSnapshot | null): number | null => (l === null ? 0 : l.ratio === null ? null : l.qty * l.ratio);
function selisihDasar(lama: LineSnapshot | null, baru: LineSnapshot | null): number | null {
    const a = dasar(lama), b = dasar(baru);
    return a === null || b === null ? null : Math.round((b - a) * 1e6) / 1e6;
}

type Baris = { lineId: number | null; itemNo: string; itemName: string; snap: LineSnapshot };
/** Kunci pasangan = id baris + kode barang. Baris tanpa id diberi kunci unik per sisi supaya tidak pernah berpasangan. */
function petaBaris(rinci: unknown[], sisi: "lama" | "baru"): Map<string, Baris> {
    const peta = new Map<string, Baris>();
    rinci.forEach((v, i) => {
        const d = obj(v), barang = obj(d.item);
        const lineId = angkaAtauNull(d.id);
        const itemNo = teks(barang.no ?? d.itemNo);
        peta.set(lineId === null ? `${sisi}:tanpa-id:${i}` : `${lineId}|${itemNo}`,
            { lineId, itemNo, itemName: teks(barang.name ?? d.detailName), snap: snapshot(d) });
    });
    return peta;
}

type Kepala = Pick<LineChangeRow, "invoiceId" | "invoiceNumber" | "transDate" | "customerNo" | "printedAt" | "printedBy"> & { total: number | null };
function kepala(f: Obj): Kepala {
    const printedAt = parsePrintedView(f.printedTimeView);
    return {
        invoiceId: angka(f.id), invoiceNumber: teks(f.number), transDate: teks(f.transDate),
        customerNo: teks(obj(f.customer).customerNo ?? f.customerNo), total: angkaAtauNull(f.totalAmount),
        printedAt, printedBy: printedAt ? teks(f.printUserName) : "",
    };
}

function baris(k: Kepala, ctx: ChangeContext, now: Date, kind: ChangeKind, b: Baris, oldLine: LineSnapshot | null,
               newLine: LineSnapshot | null, totalBefore: number | null, totalAfter: number | null): LineChangeRow {
    return {
        invoiceId: k.invoiceId, invoiceNumber: k.invoiceNumber, transDate: k.transDate, customerNo: k.customerNo,
        kind, lineId: b.lineId, itemNo: b.itemNo, itemName: b.itemName, oldLine, newLine, baseQtyDelta: selisihDasar(oldLine, newLine),
        totalBefore, totalAfter, appKey: ctx.appKey, source: ctx.source, savedAt: ctx.savedAt,
        printedAt: k.printedAt, printedBy: k.printedBy, afterPrint: k.printedAt !== null && k.printedAt <= (ctx.savedAt ?? now),
        detectedAt: now,
    };
}

/** Isi lama (raw_data cache) vs jawaban detail.do baru -> baris perubahan. Kosong bila bukan INV atau salah satu tanpa detailItem. */
export function diffInvoiceLines(oldRaw: unknown, newRow: Obj, ctx: ChangeContext, now = new Date()): LineChangeRow[] {
    const lama = parseRaw(oldRaw);
    if (!lama || !Array.isArray(lama.detailItem) || !Array.isArray(newRow.detailItem)) return [];
    const k = kepala(newRow);
    if (!k.invoiceNumber.startsWith("INV/")) return [];
    const totalLama = angkaAtauNull(lama.totalAmount);
    const o = petaBaris(lama.detailItem, "lama"), n = petaBaris(newRow.detailItem, "baru");
    const hasil: LineChangeRow[] = [];
    for (const [kunci, a] of o) {
        const b = n.get(kunci);
        if (!b) hasil.push(baris(k, ctx, now, "removed", a, a.snap, null, totalLama, k.total));
        else if (!samaBaris(a.snap, b.snap)) hasil.push(baris(k, ctx, now, "changed", b, a.snap, b.snap, totalLama, k.total));
    }
    for (const [kunci, b] of n) if (!o.has(kunci)) hasil.push(baris(k, ctx, now, "added", b, null, b.snap, totalLama, k.total));
    return hasil;
}

/** Faktur dihapus di Accurate: semua baris terakhir yang diketahui -> invoice_deleted. Kosong bila bukan INV atau tanpa detailItem. */
export function deletedInvoiceLines(oldRaw: unknown, ctx: ChangeContext, now = new Date()): LineChangeRow[] {
    const lama = parseRaw(oldRaw);
    if (!lama || !Array.isArray(lama.detailItem)) return [];
    const k = kepala(lama);
    if (!k.invoiceNumber.startsWith("INV/")) return [];
    return [...petaBaris(lama.detailItem, "lama").values()]
        .map((a) => baris(k, ctx, now, "invoice_deleted", a, a.snap, null, k.total, null));
}
