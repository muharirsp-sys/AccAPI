/*
 * Tujuan: Memetakan order internal yang sudah dibekukan menjadi payload sales-invoice Accurate,
 *         dan menentukan status antrean setelah percobaan kirim.
 * Caller: app/api/orders/[id]/invoice (dry-run + enqueue), app/api/cron/post-invoices (pengirim).
 * Beda dari lib/accurate-invoice.ts: itu MEMBACA faktur (detail.do -> tampilan), ini MENULIS.
 * Dependensi: TIDAK ADA (pure) — supaya bisa diuji tanpa DB dan tanpa jaringan.
 * Main Functions: toAccurateDate, buildInvoicePayload, readInvoiceIdentity, nextOutboxState.
 * Side Effects: Tidak ada.
 *
 * Aturan yang TIDAK boleh dilanggar (docs/SURYA_IMPLEMENTATION.md "Aturan correctness"):
 * - Nomor faktur milik Accurate. Payload memakai `typeAutoNumber`; `number` tidak pernah dikarang.
 * - Identitas dokumen = database Accurate + record ID, bukan nomor faktur (nomor bisa dipakai
 *   ulang setelah penghapusan).
 * - Timeout setelah kirim = TIDAK PASTI, bukan gagal. Jangan pernah membuat ulang otomatis.
 * - Angka yang dikirim adalah angka BEKU pada order, bukan hasil hitung ulang.
 *
 * Bukti live 2026-09-08 (read-only, DB CV Surya Perkasa):
 * - `sales-invoice/list.do` -> `transDate: "08/09/2026"`, jadi tanggal tulis = dd/MM/yyyy
 *   (sama dengan jalur purchase-payment yang sudah jalan di produksi).
 * - `sales-invoice/detail.do` -> `detailItem[].itemUnit = { id, name }`, `unitPrice`,
 *   `availableUnitRatio`, `branchId`.
 * - `unit/list.do` -> 37 satuan dengan id+nama (mis. BAG=350); inilah sumber `itemUnitId`.
 *
 * BELUM TERBUKTI: nama field REQUEST `sales-invoice/save.do`. Spec resmi Accurate tidak ada di
 * repo dan field yang tidak dikenal DIABAIKAN DIAM-DIAM oleh Accurate — jadi satu faktur uji
 * pada database yang ditunjuk pengguna WAJIB diperiksa (terutama satuan) sebelum produksi.
 */

export type FrozenInputLine = { code: string; unit: string; quantity: string; price: string };
export type FrozenResultLine = { code: string; unit: string; quantity: string; gross: string; net: string };

export type InvoiceOrder = {
    id: string;
    customer_no: string;
    outlet: string;
    channel: string;
    order_date: string;
    status: string;
    note?: string;
    lines: FrozenInputLine[];
    sources: { draft_id: string; revision: number }[];
    result: { pending_price?: boolean; gross?: string; discount?: string; net?: string; lines?: FrozenResultLine[] };
};

export type InvoiceLinePayload = {
    itemNo: string;
    quantity: number;
    unitPrice: number;
    itemUnitId: number;
    itemCashDiscount: number;
    detailNotes: string;
    charField1: string;
};

export type InvoicePayload = {
    customerNo: string;
    transDate: string;
    typeAutoNumber: number;
    description: string;
    detailItem: InvoiceLinePayload[];
    charField1: string;
    charField2: string;
    branchId?: number;
};

/** Accurate menerima tanggal tulis sebagai dd/MM/yyyy (terbukti di jalur purchase-payment). */
export function toAccurateDate(ymd: string): string {
    // Pola diperiksa penuh: "08-09-2026" yang dipecah begitu saja menghasilkan "2026/09/08"
    // — tanggal yang salah tanpa satu pun galat. Ditemukan oleh testnya sendiri.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) throw new Error(`Tanggal order tidak baku: ${ymd}`);
    const [year, month, day] = String(ymd).split("-");
    return `${day}/${month}/${year}`;
}

function money(raw: string | undefined, label: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${label} bukan angka: ${raw}`);
    return value;
}

/**
 * Order beku -> payload sales-invoice. Melempar (bukan menebak) begitu ada yang tidak pasti:
 * order belum berharga, pelanggan kosong, satuan tidak ada di master satuan Accurate, atau
 * baris hasil tidak cocok dengan baris masukan.
 */
export function buildInvoicePayload(
    order: InvoiceOrder,
    options: { unitIds: Map<string, number>; branchId?: number },
): InvoicePayload {
    if (!order.customer_no?.trim()) throw new Error("Order tanpa kode pelanggan Accurate tidak bisa difakturkan");
    if (order.result?.pending_price) throw new Error("Order berstatus needs_price; isi harga dulu sebelum difakturkan");
    const resultLines = order.result?.lines ?? [];
    if (resultLines.length === 0) throw new Error("Order tidak punya baris hasil yang dibekukan");

    const frozen = new Map(order.lines.map((line) => [`${line.code}|${line.unit}`, line]));
    const detailItem = resultLines.map((line, index) => {
        const key = `${line.code}|${line.unit}`;
        const input = frozen.get(key);
        if (!input) throw new Error(`Baris hasil ${key} tidak ada pada baris order; angka beku tidak konsisten`);
        const unitId = options.unitIds.get(line.unit.trim().toUpperCase());
        // Satuan TIDAK boleh ditebak: satu item bisa berselisih 72x antar satuan.
        if (!unitId) throw new Error(`Satuan ${line.unit} tidak ada di master satuan Accurate`);
        const gross = money(line.gross, `gross baris ${key}`);
        const net = money(line.net, `net baris ${key}`);
        const discount = Number((gross - net).toFixed(2));
        if (discount < 0) throw new Error(`Baris ${key} punya netto lebih besar dari bruto`);
        return {
            itemNo: line.code,
            quantity: money(line.quantity, `jumlah baris ${key}`),
            unitPrice: money(input.price, `harga baris ${key}`),
            itemUnitId: unitId,
            itemCashDiscount: discount,
            detailNotes: `order ${order.id.slice(0, 8)} baris ${index + 1}`,
            charField1: order.id,
        };
    });

    const sources = order.sources.map((source) => `${source.draft_id.slice(0, 8)}r${source.revision}`).join(",");
    return {
        customerNo: order.customer_no.trim(),
        transDate: toAccurateDate(order.order_date),
        // Nomor faktur milik Accurate. JANGAN mengirim `number`.
        typeAutoNumber: 1,
        description: [`Order ${order.id}`, order.outlet, order.channel, order.note?.trim()].filter(Boolean).join(" | ").slice(0, 500),
        detailItem,
        // Jejak balik ke order internal; dipakai rekonsiliasi status TIDAK PASTI lewat
        // filter.charField1 pada sales-invoice/list.do.
        charField1: order.id,
        charField2: sources.slice(0, 100),
        ...(options.branchId ? { branchId: options.branchId } : {}),
    };
}

/** Amplop Accurate: { s: boolean, d: ..., r: ... }. Identitas = database + record id. */
export function readInvoiceIdentity(response: unknown): { ok: boolean; id: string; number: string; message: string } {
    const envelope = (response ?? {}) as Record<string, unknown>;
    const body = (envelope.r ?? envelope.d ?? envelope) as Record<string, unknown>;
    const nested = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const ok = envelope.s === true;
    const message = ok ? "" : JSON.stringify(envelope.d ?? envelope).slice(0, 500);
    return {
        ok,
        id: String(nested.id ?? ""),
        number: String(nested.number ?? ""),
        message,
    };
}

export type OutboxState = "queued" | "sending" | "posted" | "unknown" | "rejected";
export type SendOutcome =
    | { kind: "posted"; id: string; number: string }
    // Accurate MENJAWAB dan menolak: aman diperbaiki lalu dicoba lagi.
    | { kind: "rejected"; message: string }
    // Tidak ada jawaban (timeout / koneksi putus): fakturnya MUNGKIN sudah terbentuk.
    | { kind: "no_answer"; message: string };

/**
 * Status berikutnya. Satu aturan yang menentukan segalanya: tanpa jawaban dari Accurate,
 * status menjadi `unknown` dan TIDAK PERNAH dibuat ulang otomatis — kunci unik lokal tidak
 * menjamin tidak ada faktur ganda di Accurate. Penyelesaiannya rekonsiliasi manual/terpisah
 * lewat pencarian `charField1` = order id.
 */
export function nextOutboxState(current: OutboxState, outcome: SendOutcome): OutboxState {
    if (current === "posted" || current === "unknown") return current;
    if (outcome.kind === "posted") return "posted";
    if (outcome.kind === "no_answer") return "unknown";
    return "rejected";
}

/** Boleh dikirim? Hanya `queued` dan `rejected` (yang sudah diperbaiki). */
export function sendable(state: OutboxState): boolean {
    return state === "queued" || state === "rejected";
}
