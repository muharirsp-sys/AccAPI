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
    /**
     * Rupiah baris ini SUDAH dilipat ke `percents` sebagai persen setara (jalur laporan principal).
     * Hanya agar galat netto menyebut sebab yang benar: batas 4 desimal, bukan dasar yang salah.
     */
    rupiahDilipat?: boolean;
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
    /** Sales per baris (nomor pegawai Accurate). Lihat `salesmanNumber` di buildInvoicePayload. */
    salesmanListNumber?: string[];
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
    /** Sales pemilik faktur (id pegawai Accurate). Absen bila kodenya belum ketemu di master. */
    masterSalesmanId?: number;
};

/** Accurate menerima tanggal tulis sebagai dd/MM/yyyy (terbukti di jalur purchase-payment). */
export function toAccurateDate(ymd: string): string {
    // Pola diperiksa penuh: "08-09-2026" yang dipecah begitu saja menghasilkan "2026/09/08"
    // — tanggal yang salah tanpa satu pun galat. Ditemukan oleh testnya sendiri.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) throw new Error(`Tanggal order tidak baku: ${ymd}`);
    const [year, month, day] = String(ymd).split("-");
    return `${day}/${month}/${year}`;
}

/**
 * Tanggal faktur PILIHAN petugas saat menekan Kirim (keputusan pengguna 2026-09-29): order yang
 * kemarin belum terproses boleh difakturkan hari ini dengan tanggal hari ini. Payload beku saat
 * antre membawa tanggal SO; yang diganti HANYA `transDate`, dan payload hasilnya yang disimpan
 * serta dikirim — verifikasi balik membandingkan dengan tanggal yang benar-benar dikirim.
 * Lebih awal dari tanggal SO ditolak: penjualan tidak boleh tercatat sebelum pesanannya ada.
 * `invoiceDate` kosong = tanggal SO apa adanya.
 */
export function pakaiTanggalFaktur(payload: InvoicePayload, orderDate: string, invoiceDate?: string):
    { payload: InvoicePayload; error?: string } {
    if (!invoiceDate) return { payload };
    if (invoiceDate < orderDate) {
        return { payload, error: `tanggal faktur ${toAccurateDate(invoiceDate)} lebih awal dari tanggal SO ${toAccurateDate(orderDate)}` };
    }
    return { payload: { ...payload, transDate: toAccurateDate(invoiceDate) } };
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Persen yang memotong `amount` rupiah dari `remaining`, sependek mungkin ("1.5", bukan
 * "1.5000"), tanpa notasi eksponen yang tidak dibaca Accurate.
 * ponytail: paling banyak 4 desimal — yang TERBUKTI disimpan dan dihitung persis oleh Accurate
 * (INV/2606/SZ01003 "0.5380+0+2.5"; tidak ada satu pun faktur ≥ 5 desimal, dicek 5 Okt 2026).
 * Meleset ≤ sisa × 0,0000005: baris bersisa > ± Rp 2 juta bisa lewat Rp 1 dan ditahan pemeriksa
 * netto di buildInvoicePayload. Naikkan batasnya setelah satu faktur 6 desimal terbukti.
 */
export function persenSetara(amount: number, remaining: number): string {
    let text = "";
    for (let digits = 2; digits <= 4; digits += 1) {
        text = (amount / remaining * 100).toFixed(digits);
        if (Math.abs(remaining * Number(text) / 100 - amount) < 0.005) break;
    }
    return text.replace(/\.?0+$/, "");
}

/**
 * Baris berbentuk persen + rupiah sekaligus (catatan barisnya). Payload DIBEKUKAN saat antre,
 * jadi antrean dari sebelum perbaikan masih membawa bentuk yang rupiahnya dibuang Accurate.
 */
export function barisPersenRupiah(payload: InvoicePayload): string[] {
    return payload.detailItem
        .filter((item) => String(item.itemDiscPercent ?? "").trim() !== "" && Number(item.itemCashDiscount) > 0)
        .map((item) => item.detailNotes);
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
    options: { unitIds: Map<string, number>; branchId: number; typeAutoNumber: number; label?: string;
        masterSalesmanId?: number; salesmanNumber?: string },
): InvoicePayload {
    if (!order.customer_no?.trim()) throw new Error("Order tanpa kode pelanggan Accurate tidak bisa difakturkan");
    if (order.result?.pending_price) throw new Error("Order berstatus needs_price; isi harga dulu sebelum difakturkan");
    const resultLines = order.result?.lines ?? [];
    if (resultLines.length === 0) throw new Error("Order tidak punya baris hasil yang dibekukan");

    const frozen = new Map(order.lines.map((line) => [`${line.code}|${line.unit}`, line]));
    // Sales PER BARIS, bukan hanya di kepala faktur. Layar Accurate menyimpan sales per baris
    // (`salesmanList`); faktur API yang hanya membawa `masterSalesmanId` kehilangan salesnya
    // begitu disimpan ulang dari layar Accurate — terjadi 2026-09-29 09:25 WITA pada
    // KN01225-KN01227 semenit sesudah terkirim. Dikirim hanya bila salesnya sah (sama dengan
    // syarat `masterSalesmanId`); verifikasi balik membuktikan apakah Accurate menyimpannya.
    const perBaris = options.salesmanNumber ? { salesmanListNumber: [options.salesmanNumber] } : {};
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
        const percents = (line.percents ?? []).map((p) => String(p).trim()).filter(Boolean);
        let cash = line.cash === undefined ? discount : money(line.cash, `diskon rupiah baris ${key}`);
        if (cash < 0 || cash > discount + 0.01) {
            throw new Error(`Baris ${key} punya diskon rupiah ${cash} di luar total diskon ${discount}`);
        }
        // Accurate TIDAK menjumlahkan `itemDiscPercent` dan `itemCashDiscount`: begitu persen
        // terisi, potongan baris dihitung dari persen saja dan rupiahnya dibuang. Terbukti pada
        // INV/2609/KN01376 (30 Sep 2026): "2+0+0+0+0" + rupiah di 7 baris, DPP Accurate = bruto
        // × 98% persis, Rp 18.019,82 hilang. Rupiahnya dilipat jadi persen setara di ujung rantai.
        const sisa = percents.reduce((left, p) => left - cents(left * Number(p) / 100), gross);
        // Netto persen + rupiah APA ADANYA, sebelum dilipat: pembeda sebab bila rantainya meleset.
        const asli = { rantai: `${percents.join("+") || "-"}${cash > 0 ? ` + Rp ${cash}` : ""}`, netto: sisa - cash };
        // Rupiah yang dilipat di sini, atau sudah dilipat pemanggil (jalur laporan principal).
        let dilipat = line.rupiahDilipat === true;
        if (percents.length > 0 && cash > 0) {
            dilipat = Math.abs(asli.netto - net) <= 1;
            percents.push(persenSetara(cash, sisa));
            cash = 0;
        }
        // Accurate menghitung ulang persennya sendiri, jadi beberapa sen selisih diterima; rantai
        // yang memberi netto lain = dasar yang salah, dan faktur tidak bisa ditarik setelah terbit.
        // Galatnya menahan SO UTUH (pemanggil menolak seluruh faktur, tidak ada faktur separuh isi).
        const hasil = percents.reduce((left, p) => left - cents(left * Number(p) / 100), gross) - cash;
        if (!(Math.abs(hasil - net) <= 1)) {
            const [rantai, netto] = dilipat ? [`persen ${percents.join("+")}`, hasil] : [`diskon ${asli.rantai}`, asli.netto];
            const angka = `netto SO Rp ${net.toFixed(2)}, netto hasil ${rantai} Rp ${netto.toFixed(2)}, `
                + `selisih Rp ${Math.abs(netto - net).toFixed(2)}`;
            throw new Error(`Barang ${line.code} (${line.unit}): ${angka}. SO ditahan utuh: ${dilipat
                ? "potongan rupiah baris terlalu besar untuk dipersenkan 4 desimal"
                : "rantai diskon beku tidak menghasilkan netto SO"} — buat faktur ini manual di Accurate atau minta perbaikan.`);
        }
        return {
            itemNo: line.code,
            quantity: money(line.quantity, `jumlah baris ${key}`),
            unitPrice: money(unitPrice, `harga baris ${key}`),
            itemUnitId: unitId,
            itemDiscPercent: percents.join("+"),
            itemCashDiscount: cash,
            detailNotes: `order ${options.label ?? order.id.slice(0, 8)} baris ${index + 1}`,
            charField1: order.id,
            ...perBaris,
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
            detailNotes: `Bonus ${bonus.program_id}`.slice(0, 250), charField1: order.id, ...perBaris });
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
        // Sales TIDAK menahan faktur bila kodenya belum ketemu: field ini tidak pernah dikirim
        // sama sekali sampai 2026-09-12, jadi menjadikannya syarat akan menghentikan seluruh
        // antrean atas data yang memang belum pernah ada. Yang kosong ditandai verifikasi balik.
        ...(options.masterSalesmanId ? { masterSalesmanId: options.masterSalesmanId } : {}),
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

/**
 * Klasifikasi jawaban save.do (AM-015/016). Hanya dua jawaban yang PASTI:
 * - amplop sukses `{s:true, r:{id}}` -> posted;
 * - amplop penolakan `{s:false, d}` pada status non-5xx -> rejected (aman diperbaiki & dikirim ulang).
 * Selain itu (non-JSON, null, array, JSON gateway tanpa amplop, 5xx, sukses tanpa id) Accurate
 * MUNGKIN sudah menyimpan fakturnya -> no_answer (unknown), tidak pernah "rejected".
 */
export function classifySaveResponse(status: number, text: string): SendOutcome {
    // 401/403/429 (token/izin ditolak, rate limit): angka status saja BUKAN bukti tidak tersimpan —
    // gateway di depan Accurate bisa menjawab begitu sesudah request diteruskan. Tidak pasti (D-07,
    // S6-0d E7), bahkan berbadan amplop {s:false}; pencegahnya pra-cek sesi sebelum klaim pertama.
    // (1835b724 menjadikannya "rejected belum diproses" = kirim ulang tanpa cek; dibalik di sini.)
    if (status === 401 || status === 403 || status === 429) {
        return { kind: "no_answer", message: `HTTP ${status} (belum terbukti tidak diproses): ${text.slice(0, 200)}` };
    }
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return { kind: "no_answer", message: `respons non-JSON (${status})` };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as { s?: unknown }).s !== "boolean") {
        return { kind: "no_answer", message: `respons tanpa amplop Accurate (${status}): ${text.slice(0, 200)}` };
    }
    const identity = readInvoiceIdentity(body);
    if (identity.ok) {
        return identity.id
            ? { kind: "posted", id: identity.id, number: identity.number }
            : { kind: "no_answer", message: `sukses tanpa id record (${status}) — cek di Accurate` };
    }
    return status >= 500
        ? { kind: "no_answer", message: `HTTP ${status}: ${identity.message}` }
        : { kind: "rejected", message: identity.message };
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

/**
 * Boleh DIBUANG dari antrean? `rejected` dan `queued` — keduanya dipastikan TIDAK punya faktur
 * di Accurate: yang pertama karena Accurate menjawab dan menolak, yang kedua karena belum satu
 * request pun terkirim (baris yang sedang dikirim berstatus `sending`, bukan `queued`).
 *
 * `queued` perlu ikut karena payload DIBEKUKAN saat diantrekan. Kalau aturan pembentuk payload
 * berubah setelah itu — salesman mulai ikut dikirim, harga diperbaiki — baris lama akan terbit
 * dengan angka lama, dan tanpa jalan membuangnya satu-satunya pilihan adalah menyentuh DB.
 *
 * `sending`, `posted`, dan `unknown` TIDAK PERNAH: fakturnya pasti atau mungkin sudah ada di
 * sana, dan menghapus jejak lokalnya hanya menghilangkan satu-satunya petunjuk untuk mencarinya.
 */
export function discardable(state: OutboxState): boolean {
    return state === "rejected" || state === "queued";
}
