/*
 * Tujuan: Petakan respons sales-invoice/detail.do Accurate jadi bentuk siap-tampil (header + baris item).
 * Caller: app/api/faktur/[id]/route.ts, tests/faktur-detail-map.spec.ts.
 * Catatan: bentuk detailItem DIVERIFIKASI LIVE 2026-08-19 (faktur 304428, ?raw=1). Nama field
 *          yang benar: detailName, quantity, itemUnit.name, unitPrice, itemCashDiscount,
 *          totalPrice; kode barang ada di item.no (BUKAN itemNo di level baris). Alias tebakan
 *          yang tidak terbukti sudah dibuang. Endpoint detail tetap punya ?raw=1 kalau nanti ada
 *          faktur yang tampil aneh.
 */

const pickNum = (...vals: unknown[]): number => {
    for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n) && v !== null && v !== "") return n;
    }
    return 0;
};
const pickStr = (...vals: unknown[]): string => {
    for (const v of vals) {
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
    }
    return "";
};
const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

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
    items: FakturItem[];
};

export function mapFakturDetail(row: unknown): FakturDetail {
    const r = obj(row);
    const rawItems = Array.isArray(r.detailItem) ? r.detailItem : [];

    const items: FakturItem[] = rawItems.map((entry) => {
        const d = obj(entry);
        const item = obj(d.item);
        const unit = obj(d.itemUnit);
        return {
            itemNo: pickStr(item.no),
            itemName: pickStr(d.detailName, item.name),
            quantity: pickNum(d.quantity),
            unit: pickStr(unit.name, d.availableItemUnitName),
            unitPrice: pickNum(d.unitPrice),
            discount: pickNum(d.itemCashDiscount),
            total: pickNum(d.totalPrice),
        };
    });

    const customer = obj(r.customer);
    return {
        id: pickNum(r.id),
        number: pickStr(r.number),
        transDate: pickStr(r.transDate),
        dueDate: pickStr(r.dueDate),
        customerNo: pickStr(customer.customerNo),
        customerName: pickStr(customer.name),
        branchName: pickStr(r.branchName),
        // Nama sales ada di masterSalesmanName (level faktur) — bukan objek salesman bersarang.
        salesName: pickStr(r.masterSalesmanName),
        description: pickStr(r.description),
        status: pickStr(r.statusName),
        subTotal: pickNum(r.subTotal),
        totalDiscount: pickNum(r.cashDiscount),
        tax: pickNum(r.tax1Amount),
        totalAmount: pickNum(r.totalAmount),
        items,
    };
}
