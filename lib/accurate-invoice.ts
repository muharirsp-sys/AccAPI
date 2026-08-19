/*
 * Tujuan: Petakan respons sales-invoice/detail.do Accurate jadi bentuk siap-tampil (header + baris item).
 * Caller: app/api/faktur/[id]/route.ts, tests/faktur-detail-map.spec.ts.
 * Catatan: nama field DIVERIFIKASI LIVE 2026-08-19 (faktur 304428 + INV/2608/HZ01521 di production,
 *          lihat ?raw=1 di route detail). Alias tebakan sudah dibuang — kalau suatu saat ada kolom
 *          kosong, cek ulang dengan ?raw=1 dulu sebelum menambah alias baru.
 */

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Accurate mengirim lastUpdate sebagai "dd/MM/yyyy HH:mm:ss" (bukan ISO). Parse manual: new Date()
// membaca string itu sebagai MM/dd atau NaN tergantung mesin, jadi tidak bisa diandalkan.
export const parseAccurateDateTime = (value: unknown): Date | null => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return null;
    const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
        const [, d, mo, y, h = "0", mi = "0", sec = "0"] = m;
        return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    }
    // Fallback ISO (nilai lama yang ditulis lib/sync.ts sendiri saat Accurate tidak kirim lastUpdate).
    const iso = new Date(raw);
    return Number.isNaN(iso.getTime()) ? null : iso;
};

export type FakturItem = {
    itemNo: string;
    itemName: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    discount: number;
    total: number;
};

export type FakturDetail = {
    id: number;
    number: string;
    transDate: string;
    dueDate: string;
    customerNo: string;
    customerName: string;
    branchName: string;
    salesName: string;
    description: string;
    status: string;
    subTotal: number;
    totalDiscount: number;
    tax: number;
    totalAmount: number;
    paid: number;
    owing: number;
    paymentTerm: string;
    lastPaymentDate: string;
    items: FakturItem[];
};

export function mapFakturDetail(row: unknown): FakturDetail {
    const r = obj(row);
    const rawItems = Array.isArray(r.detailItem) ? r.detailItem : [];

    const items: FakturItem[] = rawItems.map((entry) => {
        const d = obj(entry);
        return {
            itemNo: str(d.itemNo),
            itemName: str(d.detailName),
            quantity: num(d.quantity),
            unit: str(obj(d.itemUnit).name),
            unitPrice: num(d.unitPrice),
            discount: num(d.itemCashDiscount),
            total: num(d.totalPrice),
        };
    });

    return {
        id: num(r.id),
        number: str(r.number),
        transDate: str(r.transDate),
        dueDate: str(r.dueDate),
        customerNo: str(obj(r.customer).customerNo),
        customerName: str(obj(r.customer).name),
        branchName: str(r.branchName),
        // Satu-satunya kolom yang alias-nya SENGAJA dipertahankan: raw 304428 memuat nama sales di
        // header sebagai masterSalesmanName, tapi kolom Sales juga terisi di faktur HZ01521 yang
        // mapper lamanya hanya membaca salesman.name — jadi kedua bentuk terbukti muncul di live.
        salesName: str(r.masterSalesmanName) || str(obj(r.salesman).name),
        description: str(r.description),
        status: str(r.statusName),
        subTotal: num(r.subTotal),
        totalDiscount: num(r.cashDiscount),
        tax: num(r.tax1Amount),
        totalAmount: num(r.totalAmount),
        // primeReceipt/primeOwing = sudah dibayar / sisa tagihan, dalam mata uang dasar. Ini
        // SATU-SATUNYA sumber sisa piutang per faktur: list.do tidak punya outstanding sama
        // sekali (terverifikasi 2026-07-28, lihat db/schema.ts), jadi kolom outstanding di DB
        // selalu kosong dan angka di sini tidak bisa diambil dari cache.
        paid: num(r.primeReceipt),
        owing: num(r.primeOwing),
        paymentTerm: str(obj(r.paymentTerm).name),
        lastPaymentDate: str(r.lastPaymentDate),
        items,
    };
}
