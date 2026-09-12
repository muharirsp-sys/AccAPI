/*
 * Tujuan: Laporan integrasi principal (Order Detail Kino) -> baris order ternormalisasi.
 * Caller: app/api/principal-order/upload, gerbang validasi berikutnya.
 * Dependensi: xlsx. Main Functions: readOrderDetail, parseOrderDetail, fixLine.
 * Side Effects: Tidak ada — murni, tanpa DB dan tanpa jaringan.
 *
 * Aturannya BUKAN karangan: diambil dari Power Query yang dipakai admin selama ini
 * (`KINO (1).xlsx`, query `Kino_OD_Base`), dibaca 2026-09-11. Menyimpang dari situ berarti
 * faktur hasil sistem tidak akan sama dengan faktur yang selama ini terbit.
 */
import * as XLSX from "xlsx";

export type PackInfo = { unit: string; packSize: number };

export type DiscountAt = {
    position: number;
    percent: number;
    /**
     * Rupiah asli bila kolom DISC_n memuat NOMINAL, bukan persen (potongan tingkat faktur yang
     * dibagi rata ke baris — program MSG). `percent` tetap diisi dengan nilai SETARA supaya
     * seluruh hitungan di hilir tidak berubah; `amount` yang dipakai saat menyusun faktur,
     * karena membulatkan ulang dari persen bisa meleset beberapa rupiah dari yang dilaporkan.
     */
    amount?: number;
};

export type OrderDetailLine = {
    rowNumber: number;
    soNo: string;
    soDate: string;
    soStatus: string;
    customerCode: string;
    customerName: string;
    customerType: string;
    salesmanCode: string;
    productCode: string;
    productName: string;
    /** Apa adanya dari laporan, sebelum dinaikkan ke karton. */
    reportQty: number;
    reportPrice: number;
    reportGross: number;
    reportTotalDiscount: number;
    reportTotalPromo: number;
    reportNet: number;
    /** Hasil aturan Fix Qty / Fix Satuan / Fix Harga. */
    qty: number;
    unit: string;
    price: number;
    discounts: DiscountAt[];
    bonus: boolean;
};

export type OrderDetailResult = {
    branch: string;
    period: string;
    lines: OrderDetailLine[];
    issues: string[];
    /** Kode produk laporan yang tidak ada di mapping; baris-barisnya TIDAK ikut. */
    unmappedProducts: string[];
};

const FOOTER = /^(total for\b|grand total\b)/i;
const DISCOUNT_POSITIONS = 8;

const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const clean = text(value).replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const parsed = Number(clean);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Tanggal laporan bisa datang sebagai teks "2026-09-11" atau serial Excel. */
export function isoDate(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const raw = text(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial > 20000 && serial < 90000) {
        return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
    }
    return "";
}

/**
 * Aturan satuan yang berjalan hari ini, verbatim dari Power Query:
 *   naik ke KRT HANYA bila QTY habis dibagi ISI, dan harganya dikali ISI.
 * Kalau tidak habis dibagi, baris tetap dalam satuan terkecil dengan harga apa adanya.
 * Nilai barisnya identik di kedua cabang — yang berubah hanya cara menuliskannya.
 */
export function fixLine(qty: number, price: number, pack: PackInfo): { qty: number; unit: string; price: number } {
    const whole = pack.packSize > 0 && qty % pack.packSize === 0;
    return whole
        ? { qty: qty / pack.packSize, unit: "KRT", price: price * pack.packSize }
        : { qty, unit: pack.unit, price };
}

/**
 * DISC_1..8 -> posisi yang benar-benar terisi. Baris bonus = potongan 100% di posisi 1.
 *
 * Kolom DISC_n TIDAK selalu berisi persen. Dibuktikan pada berkas 12 September 2026: outlet
 * RISKA TK menaruh RUPIAH di DISC_5 (446,8468 atas bruto 29.729,73 = 1,503%) karena potongannya
 * program MSG tingkat FAKTUR yang dibagi rata ke tiap baris, sementara SS DIAPERS menaruh
 * persen (2,0) di DISC_1. Satu kolom, dua satuan, dalam satu berkas.
 *
 * Membacanya selalu sebagai persen membuat 446,8468 jadi 446,85% — gerbang validasi memang
 * menahannya, tetapi dengan alasan yang salah, dan potongan faktur yang SAH ikut tertahan.
 *
 * Pembedanya tidak perlu menebak: TOTAL_DISC yang dilaporkan principal adalah jawabannya.
 * Hitung kedua tafsir, pakai yang mereproduksi TOTAL_DISC. Yang berupa rupiah dikembalikan
 * dengan persen SETARA (supaya seluruh hitungan di hilir tidak berubah) plus `amount`, karena
 * rupiah aslinya itulah yang harus muncul di faktur, bukan persen hasil pembagian.
 *
 * ponytail: hanya dibedakan saat TEPAT SATU posisi terisi. Berkas bercampur persen dan rupiah
 * pada satu baris belum pernah ada; kalau suatu saat muncul, tafsirnya jatuh ke persen dan
 * selisih totalnya tetap menahan barisnya — gagal tertutup, bukan salah diam-diam.
 */
export function discountsOf(row: Record<string, unknown>, bonus: boolean): DiscountAt[] {
    const found: DiscountAt[] = [];
    for (let position = 1; position <= DISCOUNT_POSITIONS; position += 1) {
        const percent = position === 1 && bonus ? 100 : num(row[`DISC_${position}`]);
        if (percent > 0) found.push({ position, percent });
    }
    if (bonus || found.length !== 1) return found;

    const gross = num(row.GROSS);
    const reported = num(row.TOTAL_DISC);
    if (gross <= 0 || reported <= 0) return found;
    const only = found[0];
    const asPercent = Math.round(gross * only.percent) / 100;
    if (Math.abs(asPercent - reported) <= 1) return found;
    if (Math.abs(only.percent - reported) <= 1) {
        return [{ position: only.position, percent: (only.percent / gross) * 100, amount: only.percent }];
    }
    return found;
}

function headerIndex(rows: unknown[][]): number {
    return rows.findIndex((row) => Array.isArray(row) && row.some((cell) => text(cell).toUpperCase() === "SO_NO"));
}

/**
 * Baris mentah -> baris ternormalisasi. `packs` memetakan kode produk laporan ke satuan+ISI
 * (dari `principal_mapping`). Produk tanpa mapping TIDAK ditebak satuannya — barisnya
 * dikeluarkan dan dilaporkan, karena satuan yang salah membuat nilai baris salah puluhan kali.
 */
export function parseOrderDetail(rows: unknown[][], packs: Map<string, PackInfo>): OrderDetailResult {
    const issues: string[] = [];
    const meta = { branch: "", period: "" };
    for (const row of rows.slice(0, 6)) {
        const label = text(row?.[0]).toLowerCase();
        if (label === "cabang") meta.branch = text(row?.[1]).replace(/^:\s*/, "");
        if (label === "periode") meta.period = text(row?.[1]).replace(/^:\s*/, "");
    }

    const at = headerIndex(rows);
    if (at < 0) return { ...meta, lines: [], issues: ["Kolom SO_NO tidak ditemukan; ini bukan berkas Order Detail."], unmappedProducts: [] };
    const header = rows[at].map((cell) => text(cell).toUpperCase());
    const lines: OrderDetailLine[] = [];
    const unmapped = new Set<string>();

    for (let index = at + 1; index < rows.length; index += 1) {
        const raw = rows[index] ?? [];
        const first = text(raw[0]);
        // Dua baris ekor laporan adalah rekap, bukan transaksi. Ikut terhitung = nilai dobel.
        if (FOOTER.test(first)) continue;
        const row: Record<string, unknown> = {};
        header.forEach((name, column) => { if (name) row[name] = raw[column]; });
        const soNo = text(row.SO_NO);
        if (!soNo) continue;

        const rowNumber = index + 1;
        const productCode = text(row.PRD_ID);
        const reportQty = num(row.QTY);
        if (reportQty <= 0) {
            issues.push(`Baris ${rowNumber} (${productCode}): QTY ${reportQty}; baris dilewati.`);
            continue;
        }
        const pack = packs.get(productCode);
        if (!pack) {
            unmapped.add(productCode);
            issues.push(`Baris ${rowNumber}: kode produk ${productCode} belum ada di mapping principal; baris dilewati.`);
            continue;
        }
        const bonus = text(row.FLAG_BONUS).toUpperCase() !== "N";
        const reportPrice = num(row.PRICE);
        const fixed = fixLine(reportQty, reportPrice, pack);
        lines.push({
            rowNumber, soNo,
            soDate: isoDate(row.SO_DATE),
            soStatus: text(row.SO_STS),
            // CUST_ID1 adalah satu-satunya kode pelanggan yang bisa dipercaya: pada berkas
            // 11 Sep 2026 `CUST_ID2` pun berisi kode Kino, bukan kode internal.
            customerCode: text(row.CUST_ID1),
            customerName: text(row.CUSTOMER),
            customerType: text(row.CUST_TYPE1),
            salesmanCode: text(row.SLSMAN_ID),
            productCode,
            productName: text(row.PRD_DESC),
            reportQty, reportPrice,
            reportGross: num(row.GROSS),
            reportTotalDiscount: num(row.TOTAL_DISC),
            reportTotalPromo: num(row.TOTAL_PROMO),
            reportNet: num(row.NET),
            qty: fixed.qty, unit: fixed.unit, price: fixed.price,
            discounts: discountsOf(row, bonus),
            bonus,
        });
    }
    if (lines.length === 0) issues.push("Tidak ada satu pun baris yang bisa dipakai dari berkas ini.");
    return { ...meta, lines, issues, unmappedProducts: [...unmapped].sort() };
}

/** Berkas -> baris. SheetJS membaca stylesheet rusak bawaan laporan ini tanpa perbaikan apa pun. */
export function readOrderDetail(buffer: ArrayBuffer | Uint8Array, packs: Map<string, PackInfo>): OrderDetailResult {
    const book = XLSX.read(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), { type: "array" });
    const sheet = book.Sheets[book.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "", raw: true });
    return parseOrderDetail(rows, packs);
}
