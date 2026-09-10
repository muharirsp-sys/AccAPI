/** Tujuan: Cocokkan isi faktur aktual dengan order beku sebelum mengakui benefit program.
 * Caller: program-realization-store, runnable self-check. Dependensi: tipe order/payload Accurate.
 * Main Functions: programSnapshot, verifyRealization. Side Effects: tidak ada I/O.
 */
import type { InvoiceOrder, InvoicePayload } from "./accurate-invoice-write";

export type Realization = { status: "verified" | "mismatch" | "unavailable"; reason: string;
    discount: number | null; programs: { id: string; name: string; discount: number }[];
    bonuses: { programId: string; code: string; unit: string; quantity: number; cost: null }[] };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const numeric = (v: unknown): number => {
    if ((typeof v !== "number" && typeof v !== "string") || v === "" || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1e12)
        throw new Error("Angka faktur tidak lengkap atau di luar batas");
    return Number(v);
};
const cents = (v: unknown) => Math.round(numeric(v) * 100);
export const unavailable = (reason: string): Realization => ({ status: "unavailable", reason, discount: null, programs: [], bonuses: [] });

export function programSnapshot(order: InvoiceOrder): InvoiceOrder {
    const ids = new Set((order.result.applications ?? []).map(a => a.program_id));
    return { ...order, rules: (order.rules ?? []).filter(p => ids.has(p.id)) };
}

export function verifyRealization(order: InvoiceOrder, payload: InvoicePayload, raw: unknown, invoiceId: string): Realization {
    try {
        const invoice = obj(raw);
        if (String(invoice.id ?? "") !== invoiceId || String(obj(invoice.customer).customerNo ?? "") !== order.customer_no)
            throw new Error("Identitas faktur/pelanggan tidak cocok dengan order");
        if (String(invoice.transDate ?? "") !== payload.transDate) throw new Error("Tanggal faktur berubah dari order");
        if (payload.branchId && numeric(invoice.branchId) !== payload.branchId) throw new Error("Cabang faktur tidak cocok");
        if (!Array.isArray(invoice.detailItem) || !invoice.detailItem.length) throw new Error("Detail item faktur belum tersedia");
        const expected = new Map<string, { quantity: number; discount: number }>();
        const actual = new Map<string, { quantity: number; discount: number }>();
        const add = (map: typeof expected, code: string, unit: unknown, price: unknown, quantity: unknown, discount: unknown) => {
            const q = numeric(quantity), d = cents(discount), p = cents(price);
            if (!code || q <= 0 || d < 0 || p < 0) throw new Error("Baris faktur tidak valid");
            const key = JSON.stringify([code, numeric(unit), p]), old = map.get(key) ?? { quantity: 0, discount: 0 };
            map.set(key, { quantity: old.quantity + q, discount: old.discount + d });
        };
        for (const line of payload.detailItem) add(expected, line.itemNo, line.itemUnitId, line.unitPrice, line.quantity, line.itemCashDiscount);
        for (const rawLine of invoice.detailItem) {
            const line = obj(rawLine);
            add(actual, String(line.itemNo ?? ""), obj(line.itemUnit).id, line.unitPrice, line.quantity, line.itemCashDiscount);
        }
        if (actual.size !== expected.size) throw new Error("Jumlah jenis barang/satuan/harga faktur berubah");
        let deviation = 0;
        for (const [key, value] of expected) {
            const found = actual.get(key);
            if (!found || Math.abs(found.quantity - value.quantity) > 1e-8) throw new Error("SKU, satuan, harga atau jumlah faktur berubah");
            deviation += Math.abs(found.discount - value.discount);
        }
        if (deviation > 100 || cents(invoice.cashDiscount) !== 0) throw new Error("Diskon faktur berbeda dari order (toleransi total Rp1)");
        const programs = new Map<string, { id: string; name: string; discount: number }>();
        let planned = 0;
        for (const a of order.result.applications ?? []) {
            const rule = order.rules?.find(p => p.id === a.program_id);
            if (!rule) throw new Error("Versi program pada order tidak lengkap");
            const amount = cents(a.discount);
            if (amount < 0) throw new Error("Potongan program negatif");
            planned += amount;
            const old = programs.get(a.program_id);
            programs.set(a.program_id, { id: a.program_id, name: rule.name, discount: (old?.discount ?? 0) + amount / 100 });
        }
        if (Math.abs(planned - cents(order.result.discount)) > 0) throw new Error("Alokasi program tidak sama dengan potongan order");
        const totalActual = [...actual.values()].reduce((n, r) => n + r.discount, 0);
        if (Math.abs(totalActual - planned) > 100) throw new Error("Total potongan aktual tidak cocok");
        // Attribusi tidak mengarang pembagian selisih pembulatan antarprogram.
        if (totalActual !== planned) throw new Error("Selisih pembulatan perlu dialokasikan sebelum diakui per program");
        const bonuses = (order.result.bonuses ?? []).map(b => {
            if (!b.code || !programs.has(b.program_id)) throw new Error("Jejak SKU/program bonus belum lengkap");
            return { programId: b.program_id, code: b.code, unit: b.unit, quantity: numeric(b.quantity), cost: null };
        });
        return { status: "verified", reason: "Cocok dengan faktur Accurate. Nilai sebelum penyesuaian retur; biaya bonus belum tersedia.",
            discount: totalActual / 100, programs: [...programs.values()], bonuses };
    } catch (error) {
        return { ...unavailable(error instanceof Error ? error.message : "Faktur belum cocok"), status: "mismatch" };
    }
}
