/*
 * Tujuan: Membuktikan bahwa faktur yang SUDAH ada di Accurate sama dengan yang kita kirim —
 *         per baris, oleh sistem. Butir 4.30 checklist; permintaan pengguna 2026-09-12
 *         ("kenapa harus saya yang mastikan?").
 * Caller: app/api/invoice-verify.
 * Dependensi: lib/principal-validation (rantai diskon), tipe lib/accurate-invoice-write. Murni.
 * Main Functions: readAccurateInvoice, verifyInvoice, normalizePercentChain.
 * Side Effects: Tidak ada — tanpa DB dan tanpa jaringan.
 *
 * Tiga aturan yang menentukan bentuk berkas ini:
 *
 * 1. Yang dibandingkan adalah `payload` BEKU di antrean lawan jawaban Accurate sendiri
 *    (`sales_invoice.raw_data` = isi `detail.do`). Payload itulah satu-satunya rekaman
 *    permanen dari apa yang sistem ini niatkan untuk SO tersebut: baris batch principal BISA
 *    HILANG — unggah ulang berkas yang sama menghapus batch lama beserta barisnya (ON DELETE
 *    CASCADE), jadi membangun harapan dari batch berarti verifikasi bisa buta justru pada
 *    faktur paling lama. Rantai batch -> payload sendiri hanya punya satu jalur kode
 *    (groupCandidates + buildInvoicePayload) yang sudah bertest dan punya pratinjau.
 * 2. Tidak ada yang boleh "lolos karena tidak diperiksa". Faktur tanpa rincian baris
 *    (`detailItem`) TIDAK dinyatakan cocok; statusnya `tak-terperiksa`, dan itu bukan hijau.
 * 3. `charField1` adalah kuncinya, dan kunci itu ikut DIPERIKSA. Kalau faktur yang ketemu
 *    membawa charField1 lain, yang salah bukan angkanya — yang salah pasangannya.
 */
import { TOLERANCE, splitDiscounts, type DiscountAt } from "@/lib/principal-validation";
import type { InvoicePayload } from "@/lib/accurate-invoice-write";

export type Finding = { line: number | null; field: string; expected: string; actual: string };

export type AccurateLine = {
    itemNo: string;
    unitId: number;
    unitName: string;
    quantity: number;
    unitPrice: number;
    discPercent: string;
    cashDiscount: number;
    totalPrice: number;
    /** Nomor baris yang KITA tulis di detailNotes saat mengirim; 0 kalau tidak terbaca. */
    ourLine: number;
};

export type AccurateInvoice = {
    id: string;
    number: string;
    charField1: string;
    customerNo: string;
    transDate: string;
    branchId: number;
    branchName: string;
    taxable: boolean;
    inclusiveTax: boolean;
    tax1Amount: number;
    totalAmount: number;
    salesmanId: string;
    salesmanName: string;
    lines: AccurateLine[];
    /** detail.do membawa rincian baris; list.do TIDAK. Tanpa ini tidak ada yang bisa dibandingkan. */
    hasDetail: boolean;
};

const obj = (value: unknown): Record<string, unknown> =>
    (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const cents = (value: number) => Math.round(value * 100) / 100;

/** `detailNotes` yang kita kirim berbentuk "order <SO> baris N"; N itu kunci pasangan barisnya. */
function ourLineNumber(notes: string): number {
    const match = /baris\s+(\d+)\s*$/i.exec(notes.trim());
    return match ? Number(match[1]) : 0;
}

/**
 * `raw_data` satu faktur -> bentuk yang bisa dibandingkan.
 *
 * Kolomnya bertipe jsonb tetapi ISINYA string JSON (lib/sync menyimpan lewat JSON.stringify);
 * kedua bentuk diterima di sini supaya berkas ini tidak ikut rusak bila penyimpanannya
 * suatu saat diperbaiki jadi objek sungguhan.
 */
export function readAccurateInvoice(raw: unknown): AccurateInvoice {
    let parsed: unknown = raw;
    for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
        try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
    }
    const row = obj(parsed);
    const details = Array.isArray(row.detailItem) ? row.detailItem : [];
    return {
        id: str(row.id),
        number: str(row.number),
        charField1: str(row.charField1),
        customerNo: str(obj(row.customer).customerNo ?? row.customerNo),
        transDate: str(row.transDate),
        branchId: num(row.branchId),
        branchName: str(row.branchName),
        taxable: row.taxable === true,
        inclusiveTax: row.inclusiveTax === true,
        tax1Amount: num(row.tax1Amount),
        totalAmount: num(row.totalAmount),
        salesmanId: str(row.masterSalesmanId ?? ""),
        salesmanName: str(row.masterSalesmanName ?? obj(row.salesman).name),
        hasDetail: Array.isArray(row.detailItem),
        lines: details.map((entry) => {
            const detail = obj(entry);
            const unit = obj(detail.itemUnit);
            return {
                itemNo: str(detail.itemNo ?? obj(detail.item).no),
                unitId: num(detail.itemUnitId ?? unit.id),
                unitName: str(unit.name),
                quantity: num(detail.quantity),
                unitPrice: num(detail.unitPrice),
                discPercent: str(detail.itemDiscPercent),
                cashDiscount: num(detail.itemCashDiscount),
                totalPrice: num(detail.totalPrice),
                ourLine: ourLineNumber(str(detail.detailNotes)),
            };
        }),
    };
}

/**
 * Rantai persen dibaca APA ADANYA, hanya dibakukan bentuknya: "4,00 + 2.25" dan "4+2.25" sama,
 * "" dan "0+0" sama-sama tanpa diskon. Nol di TENGAH tidak dibuang — posisi menentukan siapa
 * menanggung, jadi "4+0+0+3" tidak boleh menyusut jadi "4+3".
 */
export function normalizePercentChain(raw: string): string {
    const text = String(raw ?? "").trim();
    if (!text) return "";
    const parts = text.split("+").map((part) => Number(part.trim().replace(",", ".")));
    if (parts.some((value) => !Number.isFinite(value))) return text;
    while (parts.length > 0 && parts[parts.length - 1] === 0) parts.pop();
    return parts.map((value) => String(cents(value))).join("+");
}

function chainOf(raw: string): DiscountAt[] {
    return String(raw ?? "").split("+")
        .map((part, index) => ({ position: index + 1, percent: Number(part.trim().replace(",", ".")) }))
        .filter((entry) => Number.isFinite(entry.percent) && entry.percent !== 0);
}

export type VerifyStatus = "cocok" | "selisih" | "tak-terperiksa";
export type VerifyResult = {
    status: VerifyStatus;
    /** Alasan pemeriksaan tidak bisa berjalan; kosong bila benar-benar berjalan. */
    reason: string;
    findings: Finding[];
    invoiceNumber: string;
    invoiceId: string;
    linesChecked: number;
    /** Salesman pada faktur Accurate (butir 4.31); kosong = faktur keluar tanpa sales. */
    salesman: string;
};

const unchecked = (reason: string, invoice?: AccurateInvoice): VerifyResult => ({
    status: "tak-terperiksa", reason, findings: [],
    invoiceNumber: invoice?.number ?? "", invoiceId: invoice?.id ?? "", linesChecked: 0,
    salesman: invoice?.salesmanName ?? "",
});

/**
 * Payload beku lawan faktur Accurate. Menandai selisih; TIDAK memperbaiki apa pun — faktur yang
 * sudah terbentuk di Accurate tidak bisa ditarik, jadi keluaran satu-satunya di sini adalah bukti.
 */
export function verifyInvoice(payload: InvoicePayload, raw: unknown): VerifyResult {
    const invoice = readAccurateInvoice(raw);
    if (!invoice.id && !invoice.number) return unchecked("Faktur belum ada di cache sales_invoice");
    if (!invoice.hasDetail) {
        // list.do tidak membawa detailItem. Ini BUKAN "cocok" — ini belum diperiksa.
        return unchecked("raw_data faktur ini tanpa rincian baris (bukan dari detail.do)", invoice);
    }

    const findings: Finding[] = [];
    const head = (field: string, expected: unknown, actual: unknown) => {
        if (String(expected) !== String(actual)) {
            findings.push({ line: null, field, expected: String(expected), actual: String(actual) });
        }
    };

    // Kuncinya lebih dulu: kalau charField1 bukan milik order ini, sisa pemeriksaan
    // membandingkan dua dokumen yang tidak berhubungan dan hasilnya menyesatkan.
    head("charField1", payload.charField1, invoice.charField1);
    head("pelanggan", payload.customerNo, invoice.customerNo);
    head("tanggal", payload.transDate, invoice.transDate);
    head("PPN aktif (taxable)", payload.taxable, invoice.taxable);
    head("PPN di atas harga (inclusiveTax)", payload.inclusiveTax, invoice.inclusiveTax);
    // Nomor faktur dibuat Accurate dari seri milik cabang. Yang bisa dibuktikan dari jawabannya
    // adalah cabangnya benar DAN nomornya terbit; seri yang salah tampak sebagai cabang lain.
    if (payload.branchId) head("cabang (branchId)", payload.branchId, invoice.branchId);
    if (!invoice.number) {
        findings.push({ line: null, field: "nomor faktur", expected: "terbit dari seri cabang", actual: "kosong" });
    }
    if (invoice.taxable && invoice.tax1Amount <= 0) {
        findings.push({ line: null, field: "nilai PPN (tax1Amount)", expected: "> 0", actual: String(invoice.tax1Amount) });
    }

    // Pasangan baris: pakai nomor baris yang KITA tulis sendiri di detailNotes. Satu SO bisa
    // memuat item+satuan yang sama dua kali (baris biasa dan baris bonus berdiskon 100%), jadi
    // memasangkan lewat kode barang akan menukar keduanya tanpa satu pun galat.
    const byOurLine = new Map<number, AccurateLine>();
    for (const line of invoice.lines) {
        if (line.ourLine > 0 && !byOurLine.has(line.ourLine)) byOurLine.set(line.ourLine, line);
    }
    const byNotes = byOurLine.size === invoice.lines.length && byOurLine.size === payload.detailItem.length;

    if (invoice.lines.length !== payload.detailItem.length) {
        findings.push({
            line: null, field: "jumlah baris",
            expected: String(payload.detailItem.length), actual: String(invoice.lines.length),
        });
    }

    let checked = 0;
    payload.detailItem.forEach((sent, index) => {
        const got = byNotes ? byOurLine.get(index + 1) : invoice.lines[index];
        if (!got) {
            findings.push({ line: index + 1, field: "baris", expected: sent.itemNo, actual: "tidak ada pada faktur Accurate" });
            return;
        }
        checked += 1;
        const same = (field: string, expected: string, actual: string) => {
            if (expected !== actual) findings.push({ line: index + 1, field, expected, actual });
        };
        const near = (field: string, expected: number, actual: number, tolerance: number) => {
            if (Math.abs(expected - actual) > tolerance) {
                findings.push({ line: index + 1, field, expected: String(cents(expected)), actual: String(cents(actual)) });
            }
        };
        same("kode barang", sent.itemNo, got.itemNo);
        // Satuan dibandingkan pada ID, bukan nama: satu item bisa berselisih 72x antar satuan.
        // Namanya hanya ikut ditampilkan supaya temuannya terbaca manusia.
        if (sent.itemUnitId !== got.unitId) {
            findings.push({
                line: index + 1, field: "satuan",
                expected: String(sent.itemUnitId), actual: got.unitName ? `${got.unitId} (${got.unitName})` : String(got.unitId),
            });
        }
        near("qty", sent.quantity, got.quantity, 0.0001);
        near("harga satuan", sent.unitPrice, got.unitPrice, 0.01);
        same("diskon persen", normalizePercentChain(sent.itemDiscPercent), normalizePercentChain(got.discPercent));
        near("diskon rupiah", sent.itemCashDiscount, got.cashDiscount, 0.01);
        // Nilai barisnya sendiri: di sinilah salah tafsir rantai persen muncul sebagai UANG.
        // Accurate menghitung ulang persennya, jadi toleransinya Rp 1 seperti gerbang validasi.
        const gross = cents(sent.quantity * sent.unitPrice);
        const expectedNet = cents(gross - splitDiscounts(gross, chainOf(sent.itemDiscPercent)).total - sent.itemCashDiscount);
        near("nilai baris", expectedNet, got.totalPrice, TOLERANCE);
    });

    return {
        status: findings.length === 0 ? "cocok" : "selisih",
        reason: "",
        findings,
        invoiceNumber: invoice.number,
        invoiceId: invoice.id,
        linesChecked: checked,
        salesman: invoice.salesmanName,
    };
}
