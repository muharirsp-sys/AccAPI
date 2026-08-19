/*
 * Tujuan: Petakan respons sales-invoice/detail.do Accurate jadi bentuk siap-tampil (header + baris item).
 * Caller: app/api/faktur/[id]/route.ts, tests/faktur-detail-map.spec.ts.
 * Catatan: nama field detailItem BELUM diverifikasi live (repo ini sudah 2x kena tebakan field
 *          yang salah: fields list.do & parser webhook). Karena itu tiap kolom punya beberapa
 *          alias, dan endpoint detail menyediakan ?raw=1 untuk melihat bentuk asli sekali jalan.
 *          Begitu bentuknya terbukti, alias yang tidak terpakai boleh dibuang.
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
    const rawItems = Array.isArray(r.detailItem) ? r.detailItem
        : Array.isArray(r.detailItems) ? r.detailItems
        : Array.isArray(r.detail) ? r.detail
        : [];

    const items: FakturItem[] = rawItems.map((entry) => {
        const d = obj(entry);
        const item = obj(d.item);
        const unit = obj(d.itemUnit);
        return {
            itemNo: pickStr(d.itemNo, item.no, item.number, d.no),
            itemName: pickStr(d.detailName, d.itemName, item.name, d.name),
            quantity: pickNum(d.quantity, d.qty, d.quantityUnit),
            unit: pickStr(unit.name, d.unitName, d.itemUnitName, d.unit),
            unitPrice: pickNum(d.unitPrice, d.price, d.itemPrice),
            discount: pickNum(d.itemCashDiscount, d.cashDiscount, d.discAmount, d.itemDiscAmount),
            total: pickNum(d.totalPrice, d.total, d.totalAmount, d.subTotal),
        };
    });

    const customer = obj(r.customer);
    return {
        id: pickNum(r.id),
        number: pickStr(r.number, r.no),
        transDate: pickStr(r.transDate),
        dueDate: pickStr(r.dueDate),
        customerNo: pickStr(customer.customerNo, r.customerNo),
        customerName: pickStr(customer.name, r.customerName),
        branchName: pickStr(obj(r.branch).name, r.branchName),
        salesName: pickStr(obj(r.salesman).name, obj(r.sales).name, r.salesmanName),
        description: pickStr(r.description, r.detailNotes),
        status: pickStr(r.statusName, r.status),
        subTotal: pickNum(r.subTotal, r.subTotalAmount),
        totalDiscount: pickNum(r.cashDiscount, r.totalDiscount, r.discAmount),
        tax: pickNum(r.tax1Amount, r.taxAmount, r.totalTax),
        totalAmount: pickNum(r.totalAmount),
        items,
    };
}
