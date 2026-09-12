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
    /**
     * Berapa satuan terkecil dalam satu baris faktur (ISI), bila barisnya dinaikkan ke KRT.
     * 1 = baris masih dalam satuan terkecil. Dipakai HANYA untuk toleransi harga.
     */
    unitRatio?: number;
    gross: number;
    reportDiscount: number;
    discounts: DiscountAt[];
    bonus: boolean;
    /** Aturan terbit yang berlaku untuk BARANG ini pada tanggal SO-nya. */
    rules: PublishedRule[];
    /**
     * Diisi bila klaim principal pada SO ini sudah dijelaskan aturan tingkat FAKTUR
     * (lihat checkSoPromo). Baris tidak perlu punya aturannya sendiri.
     */
    fakturPromo?: string;
};

export type LineCheck = { status: "ok" | "review"; findings: string[]; split: Split };

/**
 * Satu aturan promo terbit (`promo_rule`), sudah disaring per tanggal oleh pemanggil.
 * `itemCode` kosong = aturan tingkat FAKTUR (berlaku semua barang), mis. program MSG.
 */
export type PublishedRule = {
    suratProgram: string;
    promoGroup: string;
    itemCode: string;
    tierNo: number;
    /** Ambang pemicu; `triggerUnit` RP = nilai belanja, selain itu jumlah barang. */
    triggerQty: number;
    triggerUnit: string;
    benefitType: string;
    benefitValue: string;
    benefitBeban: string;
};

/**
 * PPN yang dipakai membandingkan potongan tingkat faktur. Surat program menulis manfaatnya
 * dalam rupiah TERMASUK PPN (Rp 20.000), sedangkan laporan principal membawa DPP (18.016,22).
 * Dibuktikan pengguna 2026-09-12: 18.016,22 x 1,11 = 19.998 — beda Rp 2 dari Rp 20.000.
 */
export const PPN = 0.11;

/**
 * Aturan per BARANG yang menjelaskan klaim principal pada satu baris, atau null.
 * Dipakai dua kali dan harus memberi jawaban yang sama di keduanya: oleh checkLine untuk
 * memutuskan barisnya, dan oleh pemanggil untuk menghitung SISA klaim yang belum dijelaskan
 * sebelum aturan tingkat faktur ditanya.
 */
export function matchItemRule(
    discounts: DiscountAt[],
    rules: PublishedRule[],
    itemCode?: string | null,
    owner: "principal" | "distributor" = "principal",
): PublishedRule | null {
    // Dibandingkan pada PERSEN posisi yang bersangkutan, bukan rupiahnya: rupiah ikut berubah
    // oleh diskon yang memotong lebih dulu di rantai yang sama.
    const actual = cents(discounts
        .filter((entry) => OWNER[entry.position] === owner)
        .reduce((total, entry) => total + entry.percent, 0));
    if (actual <= 0) return null;
    const beban = owner === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
    return rules.find((rule) => rule.itemCode && rule.benefitType === "DISC_PCT"
        // BEBAN ikut dicocokkan: aturan principal tidak boleh membenarkan potongan yang duduk
        // di posisi distributor, dan sebaliknya. Posisi menyatakan siapa yang DIMAKSUD
        // menanggung; aturan menyatakan apakah maksud itu sah.
        && rule.benefitBeban === beban
        // Pemanggil memang sudah menyaring per barang, tetapi disaring lagi di sini: aturan
        // milik barang LAIN yang kebetulan ikut terbawa tidak boleh meloloskan baris ini.
        && (!itemCode || rule.itemCode === itemCode)
        && Math.abs(cents(Number(rule.benefitValue) - actual)) <= 0.01) ?? null;
}

export type SoPromo = {
    /** Kosong bila klaim principal pada SO ini TIDAK dijelaskan aturan tingkat faktur. */
    explained: string;
    /** Temuan tingkat SO; menahan seluruh barisnya, sama seperti temuan per baris. */
    findings: string[];
};

/**
 * Potongan tingkat FAKTUR (program MSG): satu nominal untuk SELURUH SO, dibagi rata ke tiap
 * barisnya. Tidak bisa diperiksa per baris — barang yang sama sekali tidak masuk program pun
 * ikut kebagian potongannya, jadi pencocokan per barang akan menuduh baris yang benar.
 *
 * Yang dicocokkan: SISA klaim principal se-SO — bagian yang BELUM dijelaskan aturan per barang
 * — dikembalikan ke nilai TERMASUK PPN, lawan manfaat tier tertinggi yang ambangnya terlampaui
 * oleh bruto SO. Memakai total klaim mentah akan menuduh SO yang klaimnya sudah beres per
 * barang: SO 1671-SOP-260013044 (12 Sep 2026) brutonya 3 juta sehingga menyentuh tier 3, padahal
 * seluruh klaimnya adalah promo 3% per barang yang sudah cocok dan tidak ada urusan dengan MSG.
 */
export function checkSoPromo(
    input: { gross: number; principalClaim: number; lineCount: number },
    rules: PublishedRule[],
): SoPromo {
    if (input.principalClaim <= 0) return { explained: "", findings: [] };
    const tiers = rules
        .filter((rule) => !rule.itemCode && rule.benefitType === "DISC_RP" && rule.triggerUnit.toUpperCase() === "RP")
        .sort((a, b) => b.triggerQty - a.triggerQty);
    const reached = tiers.find((tier) => input.gross >= tier.triggerQty);
    if (!reached) return { explained: "", findings: [] };

    const expected = Number(reached.benefitValue);
    if (!Number.isFinite(expected)) return { explained: "", findings: [] };
    const claimWithTax = cents(input.principalClaim * (1 + PPN));
    // Toleransi Rp 1 PER BARIS: nominalnya dibagi rata lalu dibulatkan di tiap baris, jadi
    // sisa pembulatannya menumpuk sebanyak barisnya. Satu baris tetap Rp 1, seperti gerbang lain.
    const tolerance = TOLERANCE * Math.max(input.lineCount, 1);
    if (Math.abs(claimWithTax - expected) > tolerance) {
        return {
            explained: "",
            findings: [`Potongan faktur ${reached.suratProgram} tier ${reached.tierNo}: klaim principal `
                + `Rp ${input.principalClaim.toLocaleString("id-ID")} (Rp ${claimWithTax.toLocaleString("id-ID")} dengan PPN) `
                + `berbeda dari manfaat terbit Rp ${expected.toLocaleString("id-ID")}.`],
        };
    }
    return {
        explained: `${reached.suratProgram} tier ${reached.tierNo} (belanja >= Rp ${reached.triggerQty.toLocaleString("id-ID")} -> Rp ${expected.toLocaleString("id-ID")})`,
        findings: [],
    };
}

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
        // Toleransi Rp 1 berlaku pada SATUAN TERKECIL, tempat pembulatannya benar-benar terjadi:
        // Accurate menyimpan harga per satuan terkecil dalam rupiah bulat (BTL 29.189) sementara
        // laporan principal membawa desimal DPP (29.189,1892 = 32.400 / 1,11). Beda Rp 0,19 per
        // botol itu menjadi Rp 4,54 begitu baris dinaikkan ke KRT isi 24 — pembulatan yang sama,
        // hanya dikali ISI. Salah harga yang sungguhan besarnya ratusan rupiah per satuan
        // terkecil, jadi tetap tertahan.
        const ratio = line.unitRatio && line.unitRatio > 0 ? line.unitRatio : 1;
        const gapPerSmallest = cents(gap / ratio);
        if (Math.abs(gapPerSmallest) > TOLERANCE) {
            findings.push(`Harga laporan ${line.price.toLocaleString("id-ID")} berbeda ${gap > 0 ? "lebih tinggi" : "lebih rendah"} `
                + `${Math.abs(gap).toLocaleString("id-ID")} dari harga Accurate ${line.expectedPrice.toLocaleString("id-ID")}`
                + (ratio > 1 ? ` (setara ${Math.abs(gapPerSmallest).toLocaleString("id-ID")} per satuan terkecil dari ${ratio}).` : "."));
        }
    }

    if (split.unowned > 0) {
        const posisi = line.discounts.filter((entry) => !OWNER[entry.position]).map((entry) => `DISC_${entry.position}`);
        findings.push(`Diskon tak bertuan Rp ${split.unowned.toLocaleString("id-ID")} pada ${posisi.join(", ")}; `
            + "posisi itu bukan tanggungan distributor maupun klaim principal.");
    }
    // Klaim principal wajib PUNYA PENJELASAN. Sebelumnya setiap klaim ditahan tanpa kecuali
    // karena gerbang ini tidak pernah membaca aturan terbit — termasuk klaim yang sudah punya
    // aturannya. Sekarang aturannya dibaca, dan yang ditahan hanya yang benar-benar tidak
    // cocok. Uang yang tidak bisa dipertanggungjawabkan tetap tidak boleh lewat.
    // TIDAK ADA potongan yang boleh tembus ke faktur tanpa aturannya (keputusan pengguna
    // 2026-09-12). Berlaku untuk KEDUA beban: klaim principal maupun tanggungan distributor.
    // Sebelumnya posisi 1-3 lolos begitu saja karena "toh beban sendiri" — tetapi potongan yang
    // tidak punya aturan bukan beban sendiri, ia potongan yang belum jelas milik siapa, dan
    // memberikannya lebih dulu lalu bertanya kemudian adalah cara kehilangan uang tanpa jejak.
    for (const owner of ["distributor", "principal"] as const) {
        const amount = owner === "principal" ? split.principal : split.distributor;
        if (amount <= 0) continue;
        const beban = owner === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
        const sebutan = owner === "principal" ? "Klaim principal" : "Potongan tanggungan distributor";

        if (matchItemRule(line.discounts, line.rules, line.itemCode, owner)) continue;
        // Potongan tingkat faktur: nominalnya milik SELURUH SO dan sudah diperiksa di sana.
        if (owner === "principal" && line.fakturPromo) continue;

        const percentRules = line.rules.filter((rule) => rule.itemCode && rule.benefitType === "DISC_PCT"
            && rule.benefitBeban === beban && (!line.itemCode || rule.itemCode === line.itemCode));
        const actual = cents(line.discounts
            .filter((entry) => OWNER[entry.position] === owner)
            .reduce((total, entry) => total + entry.percent, 0));
        if (percentRules.length > 0) {
            const daftar = percentRules.map((rule) => `${rule.benefitValue}% (${rule.suratProgram} ${rule.promoGroup})`).join(", ");
            findings.push(`${sebutan} ${actual}% tidak sama dengan aturan terbit untuk barang ini: ${daftar}.`);
        } else {
            findings.push(`${sebutan} Rp ${amount.toLocaleString("id-ID")} belum punya aturan promo terbit yang menjelaskannya.`);
        }
    }

    // Angka kita harus sama dengan yang dilaporkan principal; beda berarti salah satu salah baca.
    if (Math.abs(cents(split.total - line.reportDiscount)) > TOLERANCE) {
        findings.push(`Total diskon hitungan kami Rp ${split.total.toLocaleString("id-ID")} berbeda dari laporan principal `
            + `Rp ${line.reportDiscount.toLocaleString("id-ID")}.`);
    }

    return { status: findings.length ? "review" : "ok", findings, split };
}
