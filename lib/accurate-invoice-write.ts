/*
 * Tujuan: Memetakan order internal yang sudah dibekukan menjadi payload sales-invoice Accurate,
 *         termasuk bonus dengan SKU pasti, dan menentukan status antrean setelah kirim.
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
export type FrozenResultLine = {
    code: string; unit: string; quantity: string; gross: string; net: string;
    /** Rantai persen yang berlaku pada baris ini, mis. ["10","5"]. Dibekukan oleh kalkulator. */
    percents?: string[];
    /** Bagian diskon yang berupa RUPIAH, di luar rantai persen di atas. */
    cash?: string;
    /** Harga satuan bila baris hasil membawanya sendiri (jalur laporan principal). */
    price?: string;
};
export type FrozenBonus = { program_id: string; code: string; unit: string; quantity: string; eligible_codes?: string[] };

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
    rules?: { id: string; name: string; [key: string]: unknown }[];
    result: { pending_price?: boolean; gross?: string; discount?: string; net?: string; lines?: FrozenResultLine[];
        applications?: { program_id: string; discount: string; minimum: string }[]; bonuses?: FrozenBonus[] };
};

export type InvoiceLinePayload = {
    itemNo: string;
    quantity: number;
    unitPrice: number;
    itemUnitId: number;
    itemDiscPercent: string;
    itemCashDiscount: number;
    detailNotes: string;
    charField1: string;
};

export type InvoicePayload = {
    customerNo: string;
    transDate: string;
    typeAutoNumber: number;
    taxable: boolean;
    inclusiveTax: boolean;
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
    // `label` = penanda pendek pada catatan tiap baris faktur. Default potongan id order;
    // jalur laporan principal mengirim nomor SO-nya, yang jauh lebih berarti bagi pembukuan.
    options: { unitIds: Map<string, number>; branchId: number; typeAutoNumber: number; label?: string },
): InvoicePayload {
    if (!order.customer_no?.trim()) throw new Error("Order tanpa kode pelanggan Accurate tidak bisa difakturkan");
    if (order.result?.pending_price) throw new Error("Order berstatus needs_price; isi harga dulu sebelum difakturkan");
    const resultLines = order.result?.lines ?? [];
    if (resultLines.length === 0) throw new Error("Order tidak punya baris hasil yang dibekukan");

    const frozen = new Map(order.lines.map((line) => [`${line.code}|${line.unit}`, line]));
    const detailItem = resultLines.map((line, index) => {
        const key = `${line.code}|${line.unit}`;
        const input = frozen.get(key);
        // Jalur laporan principal membawa harga pada baris hasilnya sendiri: satu SO bisa
        // memuat item+satuan yang SAMA dua kali (baris biasa dan baris bonus berdiskon 100%),
        // jadi peta `code|unit` tidak cukup untuk menemukan harganya.
        const unitPrice = line.price ?? input?.price;
        if (unitPrice === undefined) throw new Error(`Baris hasil ${key} tidak ada pada baris order; angka beku tidak konsisten`);
        const unitId = options.unitIds.get(line.unit.trim().toUpperCase());
        // Satuan TIDAK boleh ditebak: satu item bisa berselisih 72x antar satuan.
        if (!unitId) throw new Error(`Satuan ${line.unit} tidak ada di master satuan Accurate`);
        const gross = money(line.gross, `gross baris ${key}`);
        const net = money(line.net, `net baris ${key}`);
        const discount = Number((gross - net).toFixed(2));
        if (discount < 0) throw new Error(`Baris ${key} punya netto lebih besar dari bruto`);
        // Faktur harus MENAMPILKAN persen dan rupiah, seperti nota Kino. Karena itu rantai
        // persen dikirim apa adanya lewat `itemDiscPercent` ("10+5") dan HANYA sisa yang
        // berupa rupiah lewat `itemCashDiscount`. Mengirim seluruh diskon di kedua field
        // akan membuat Accurate memotong dua kali.
        const percents = (line.percents ?? []).map((p) => String(p).trim()).filter(Boolean);
        const cash = line.cash === undefined ? discount : money(line.cash, `diskon rupiah baris ${key}`);
        if (cash < 0 || cash > discount + 0.01) {
            throw new Error(`Baris ${key} punya diskon rupiah ${cash} di luar total diskon ${discount}`);
        }
        // Accurate menghitung ulang bagian persennya sendiri, jadi totalnya bisa berbeda
        // beberapa sen dari angka beku kita. Itu diterima; yang tidak boleh adalah selisih
        // karena kita mengirim dasar yang salah.
        return {
            itemNo: line.code,
            quantity: money(line.quantity, `jumlah baris ${key}`),
            unitPrice: money(unitPrice, `harga baris ${key}`),
            itemUnitId: unitId,
            itemDiscPercent: percents.join("+"),
            itemCashDiscount: cash,
            detailNotes: `order ${options.label ?? order.id.slice(0, 8)} baris ${index + 1}`,
            charField1: order.id,
        };
    });

    for (const bonus of order.result.bonuses ?? []) {
        if (!bonus.code?.trim()) throw new Error(`Pilih SKU bonus program ${bonus.program_id} sebelum membuat faktur`);
        const unitId = options.unitIds.get(bonus.unit.trim().toUpperCase());
        const quantity = money(bonus.quantity, "Jumlah bonus");
        if (!unitId || quantity <= 0 || !Number.isInteger(quantity)) throw new Error("Satuan/jumlah bonus tidak valid");
        // Baris bonus berharga 0, jadi tidak punya rantai persen sama sekali — dikirim kosong,
        // bukan dihilangkan: field yang absen membuat Accurate memakai nilai bawaannya sendiri.
        detailItem.push({ itemNo: bonus.code, quantity, unitPrice: 0, itemUnitId: unitId,
            itemDiscPercent: "", itemCashDiscount: 0,
            detailNotes: `Bonus ${bonus.program_id}`.slice(0, 250), charField1: order.id });
    }

    const sources = order.sources.map((source) => `${source.draft_id.slice(0, 8)}r${source.revision}`).join(",");
    return {
        customerNo: order.customer_no.trim(),
        transDate: toAccurateDate(order.order_date),
        // Nomor faktur milik Accurate. JANGAN mengirim `number`.
        // Serinya WAJIB dari cabang pelanggan (lib/order-branch): penomoran Faktur Penjualan
        // di database ini berjalan per cabang, dan nilai tetap `1` dulu berarti SEMUA faktur
        // masuk satu seri — nomor nyasar ke pembukuan cabang lain tanpa satu pun galat.
        typeAutoNumber: options.typeAutoNumber,
        // PPN WAJIB aktif untuk semua faktur penjualan; tidak ada saklar dan tidak ada
        // jalur yang bisa mengirim faktur non-PPN diam-diam.
        taxable: true,
        // Harga jual Accurate maupun PRICE pada laporan principal adalah DPP: pada data Kino
        // 3 Sep 2026, GROSS 324.324,32 + TAX 35.675,68 (11%) = NET 360.000, jadi pajaknya
        // DITAMBAHKAN di atas harga, bukan sudah termasuk. Kalau faktur uji nanti keluar 11%
        // terlalu tinggi, di sinilah tempat memperbaikinya.
        inclusiveTax: false,
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

/**
 * Boleh dikirim pengirim terjadwal? HANYA `queued`.
 *
 * `rejected` sengaja TIDAK ikut. Accurate menolak karena ada yang salah — outlet non-aktif,
 * piutang lewat tempo, harga keliru — dan mengirim ulang tiap jalannya cron tidak memperbaiki
 * satu pun dari itu; yang terjadi hanya tumpukan percobaan gagal yang menutupi masalah asli.
 * Baris yang ditolak menunggu manusia menyatakan sudah diperbaiki (lihat `resendable`).
 */
export function sendable(state: OutboxState): boolean {
    return state === "queued";
}

/**
 * Boleh dilepas ulang oleh manusia? HANYA `rejected` — Accurate MENJAWAB dan menolak, jadi
 * dipastikan tidak ada fakturnya di sana. `unknown` TIDAK PERNAH: tidak ada jawaban berarti
 * fakturnya mungkin sudah terbentuk, dan faktur ganda di Accurate tidak bisa dibatalkan.
 */
export function resendable(state: OutboxState): boolean {
    return state === "rejected";
}
