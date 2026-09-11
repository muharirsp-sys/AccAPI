/*
 * Tujuan: Validasi tahap 1 baris laporan principal — item, harga, dan pecahan diskon.
 * Caller: app/api/principal-order/validate.
 * Dependensi: tidak ada. Main Functions: splitDiscounts, checkLine, TOLERANCE.
 * Side Effects: Tidak ada — murni, tanpa DB dan tanpa jaringan.
 *
 * Kembaran Python-nya `python_backend/kino_discount.py` menangani jalur promo/Summary.
 * Yang di sini hanya pecahan per POSISI, yang memang juga dibutuhkan tampilan; aturan promo
 * (aturan terbit dari surat) tetap tinggal di mesin Python dan dipanggil terpisah.
 */

/** Posisi kolom DISC_n menentukan siapa menanggung. Dibuktikan dari data ALFAMART 2026-09-03. */
export const OWNER: Record<number, "distributor" | "principal"> = { 1: "distributor", 2: "distributor", 3: "distributor", 4: "principal", 5: "principal" };

/** Rp 1 per baris; hanya menyerap pembulatan, bukan selisih aturan. Ditetapkan pengguna. */
export const TOLERANCE = 1;

export type DiscountAt = { position: number; percent: number };

export type Split = { distributor: number; principal: number; unowned: number; total: number };

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Diskon bertingkat: tiap posisi memotong SISA, bukan bruto.
 * Dibuktikan dengan ALFAMART: 4% lalu 2,25% atas Rp 345.945,95 = Rp 21.310,27, sama persis
 * dengan TOTAL_DISC yang dilaporkan Kino. Menjumlahkan 6,25% memberi Rp 21.621,62.
 */
export function splitDiscounts(gross: number, discounts: DiscountAt[]): Split {
    let remaining = gross;
    const bucket: Split = { distributor: 0, principal: 0, unowned: 0, total: 0 };
    for (const { position, percent } of [...discounts].sort((a, b) => a.position - b.position)) {
        const amount = cents(remaining * percent / 100);
        remaining -= amount;
        bucket[OWNER[position] ?? "unowned"] += amount;
        bucket.total += amount;
    }
    for (const key of Object.keys(bucket) as (keyof Split)[]) bucket[key] = cents(bucket[key]);
    return bucket;
}

export type LineInput = {
    productCode: string;
    itemCode: string | null;
    itemExists: boolean;
    customerCode: string;
    customerNo: string | null;
    customerExists: boolean;
    salesmanCode: string;
    salesmanInternal: string | null;
    unit: string;
    knownUnits: string[];
    price: number;
    expectedPrice: number | null;
    gross: number;
    reportDiscount: number;
    discounts: DiscountAt[];
    bonus: boolean;
    hasPublishedRules: boolean;
};

export type LineCheck = { status: "ok" | "review"; findings: string[]; split: Split };

/**
 * Satu baris -> status + temuan. Setiap temuan menahan barisnya; tidak ada yang "cuma warning",
 * karena semua yang diperiksa di sini berakhir sebagai angka pada faktur.
 */
export function checkLine(line: LineInput): LineCheck {
    const findings: string[] = [];
    const split = splitDiscounts(line.gross, line.discounts);

    if (!line.itemCode) findings.push(`Kode produk ${line.productCode} belum ada di mapping principal.`);
    else if (!line.itemExists) findings.push(`Kode barang ${line.itemCode} tidak ada di master Accurate.`);

    if (!line.customerNo) findings.push(`Kode outlet ${line.customerCode} belum ada di mapping principal.`);
    else if (!line.customerExists) findings.push(`Pelanggan ${line.customerNo} tidak ada di master Accurate.`);

    if (!line.salesmanInternal) findings.push(`Kode salesman ${line.salesmanCode} belum ada di mapping principal.`);

    // Satuan yang tidak dikenal daftar harga berarti nilai barisnya tidak bisa dipercaya:
    // satu item bisa berselisih 72x antar satuan.
    if (line.knownUnits.length > 0 && !line.knownUnits.includes(line.unit.toUpperCase())) {
        findings.push(`Satuan ${line.unit} tidak ada pada daftar harga Accurate (yang ada: ${line.knownUnits.join(", ")}).`);
    }

    // Baris bonus memang berharga penuh lalu dipotong 100%; harganya tetap wajib benar.
    if (line.expectedPrice === null) {
        findings.push(`Harga Accurate untuk ${line.itemCode ?? line.productCode} ${line.unit} tidak ditemukan.`);
    } else {
        const gap = cents(line.price - line.expectedPrice);
        if (Math.abs(gap) > TOLERANCE) {
            findings.push(`Harga laporan ${line.price.toLocaleString("id-ID")} berbeda ${gap > 0 ? "lebih tinggi" : "lebih rendah"} `
                + `${Math.abs(gap).toLocaleString("id-ID")} dari harga Accurate ${line.expectedPrice.toLocaleString("id-ID")}.`);
        }
    }

    if (split.unowned > 0) {
        const posisi = line.discounts.filter((entry) => !OWNER[entry.position]).map((entry) => `DISC_${entry.position}`);
        findings.push(`Diskon tak bertuan Rp ${split.unowned.toLocaleString("id-ID")} pada ${posisi.join(", ")}; `
            + "posisi itu bukan tanggungan distributor maupun klaim principal.");
    }
    // Klaim principal tanpa aturan terbit adalah uang yang tidak bisa dipertanggungjawabkan.
    // Selama belum ada satu pun aturan promo terbit, SETIAP klaim harus ditinjau manusia.
    if (split.principal > 0 && !line.hasPublishedRules) {
        findings.push(`Klaim principal Rp ${split.principal.toLocaleString("id-ID")} belum punya aturan promo terbit yang menjelaskannya.`);
    }

    // Angka kita harus sama dengan yang dilaporkan principal; beda berarti salah satu salah baca.
    if (Math.abs(cents(split.total - line.reportDiscount)) > TOLERANCE) {
        findings.push(`Total diskon hitungan kami Rp ${split.total.toLocaleString("id-ID")} berbeda dari laporan principal `
            + `Rp ${line.reportDiscount.toLocaleString("id-ID")}.`);
    }

    return { status: findings.length ? "review" : "ok", findings, split };
}
