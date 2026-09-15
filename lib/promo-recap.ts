/*
 * Tujuan: Membongkar diskon NYATA dari faktur Accurate (hasil webhook) dan menyandingkannya
 *         dengan aturan promo terbit, jadi rekap per program untuk akhir bulan.
 * Caller: app/api/promo-recap.
 * Dependensi: lib/principal-validation (pecahan diskon per posisi). Murni — tanpa DB/jaringan.
 * Main Functions: invoiceLines, recap.
 * Side Effects: Tidak ada.
 *
 * Kenapa dari webhook: `sales_invoice.raw_data` adalah jawaban Accurate sendiri (detail.do),
 * bukan hitungan kita. Rekap yang dibangun dari angka kita sendiri hanya membuktikan bahwa
 * kita konsisten dengan diri sendiri — bukan bahwa fakturnya benar.
 *
 * Dua hal yang TIDAK boleh dianggap nol tanpa dihitung:
 * - diskon posisi 6+ (TAK BERTUAN), dan
 * - klaim principal yang tidak punya aturan terbit.
 * Gerbang kita memang menahan keduanya sebelum faktur naik, tetapi faktur juga bisa dibuat
 * langsung di Accurate di luar jalur ini. Angka nol harus DIBUKTIKAN, bukan diasumsikan.
 */
import { matchBonusRule, matchTariff, OWNER, splitDiscounts, TOLERANCE, type DiscountAt } from "@/lib/principal-validation";

export type PromoRule = {
    principal: string;
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    /** Kosong = aturan tingkat FAKTUR (berlaku semua barang), mis. program MSG. */
    itemCode: string;
    /** Kosong = berlaku semua pelanggan. Terisi = tarif Discount Reguler milik satu outlet. */
    customerCode: string;
    periodStart: string | null;
    periodEnd: string | null;
    benefitType: string;
    benefitValue: string;
    benefitUnit: string;
    onFaktur: boolean;
    /** PRINCIPAL (bisa ditagihkan) atau DISTRIBUTOR (tanggungan sendiri). */
    benefitBeban: string;
    tierNo: number;
    /** Ambang pemicu; `triggerUnit` RP = nilai belanja. */
    triggerQty: number;
    triggerUnit: string;
};

export type InvoiceLine = {
    invoiceNo: string;
    invoiceId: string;
    transDate: string;
    customerNo: string;
    /** Cabang faktur = principal pemiliknya; ruang nama yang sama dengan `promo_rule.principal`. */
    branchName: string;
    customerName: string;
    itemCode: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    gross: number;
    discounts: DiscountAt[];
    cashDiscount: number;
};

const cents = (value: number) => Math.round(value * 100) / 100;

function safeParse(raw: string): unknown {
    try {
        const once = JSON.parse(raw);
        // Bisa berlapis dua kalau suatu saat disimpan ulang; urai sekali lagi, lalu berhenti.
        return typeof once === "string" ? JSON.parse(once) : once;
    } catch {
        return null;
    }
}
const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Accurate menulis tanggal faktur dd/MM/yyyy; rekap butuh yyyy-MM-dd untuk dibandingkan. */
export function isoDate(raw: string): string {
    const value = String(raw ?? "").trim();
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : value.slice(0, 10);
}

/**
 * `raw_data` satu faktur -> baris barang beserta diskonnya.
 *
 * Rantai persen Accurate ("4+2.25") dibaca APA ADANYA dan urutannya = POSISI diskon, karena
 * posisi itulah yang menentukan siapa menanggung. Menjumlahkannya lebih dulu menghapus
 * informasi yang justru dicari rekap ini.
 */
export function invoiceLines(raw: unknown): InvoiceLine[] {
    // `sales_invoice.raw_data` bertipe jsonb tetapi ISINYA STRING: lib/sync menyimpannya
    // lewat JSON.stringify, jadi yang tersimpan adalah teks JSON, bukan objek (dibuktikan di
    // produksi 2026-09-12: `jsonb_typeof(raw_data)` = "string"). Tanpa penguraian ini rekap
    // membaca NOL baris dan melaporkan "tidak ada diskon" untuk faktur yang penuh diskon —
    // jawaban salah yang terlihat menenangkan.
    const parsed = typeof raw === "string" ? safeParse(raw) : raw;
    const invoice = (parsed ?? {}) as Record<string, unknown>;
    const details = Array.isArray(invoice.detailItem) ? invoice.detailItem : [];
    const invoiceNo = String(invoice.number ?? "");
    const invoiceId = String(invoice.id ?? "");
    const transDate = isoDate(String(invoice.transDate ?? ""));
    const customer = (invoice.customer ?? {}) as Record<string, unknown>;
    const customerNo = String(customer.customerNo ?? invoice.customerNo ?? "");
    const customerName = String(customer.name ?? "");
    const branchName = String(invoice.branchName ?? "");

    return details.map((entry) => {
        const detail = (entry ?? {}) as Record<string, unknown>;
        const item = (detail.item ?? {}) as Record<string, unknown>;
        const quantity = num(detail.quantity);
        const unitPrice = num(detail.unitPrice);
        // POSISI diambil dari urutan ASLI pada rantai, baru nol dibuang. Menyaring lebih dulu
        // menggeser posisi: "4+0+0+3" akan membuat 3% (klaim principal, posisi 4) terbaca
        // sebagai posisi 2 alias tanggungan distributor — salah beban, salah uang.
        const percents = String(detail.itemDiscPercent ?? "")
            .split("+")
            .map((part, index) => ({ position: index + 1, percent: Number(String(part).trim().replace(",", ".")) }))
            .filter((entry) => Number.isFinite(entry.percent) && entry.percent !== 0);
        return {
            invoiceNo, invoiceId, transDate, customerNo, customerName, branchName,
            itemCode: String(detail.itemNo ?? item.no ?? ""),
            itemName: String(item.name ?? detail.detailName ?? ""),
            quantity, unitPrice,
            gross: cents(quantity * unitPrice),
            discounts: percents,
            cashDiscount: num(detail.itemCashDiscount),
        };
    });
}

export type Bucket = "principal" | "distributor" | "unowned";

/**
 * Satu potongan yang sudah digolongkan — bahan kartu, rincian layar, DAN unduhan CSV sekaligus.
 * Satu bentuk untuk ketiganya supaya angka di kartu tidak mungkin berbeda dari rinciannya.
 */
export type DetailRow = {
    bucket: Bucket;
    invoiceNo: string;
    transDate: string;
    branchName: string;
    customerNo: string;
    customerName: string;
    itemCode: string;
    itemName: string;
    /** Posisi kolom diskon yang menyumbang, mis. "4" atau "1+2"; "faktur" untuk potongan MSG. */
    positions: string;
    percent: number;
    amount: number;
    suratProgram: string;
    promoGroup: string;
    /** Kosong bila tidak ada yang perlu dijelaskan; terisi kalau tak bertuan. */
    reason: string;
};

/** PPN yang dipakai mengembalikan potongan tingkat faktur ke nilai surat programnya. */
export const PPN = 0.11;

const inPeriod = (rule: PromoRule, date: string) =>
    (!rule.periodStart || rule.periodStart <= date) && (!rule.periodEnd || date <= rule.periodEnd);

/**
 * Aturan per BARANG yang membenarkan potongan sebesar `percent` atas beban `beban`.
 *
 * Beban IKUT dicocokkan: aturan principal tidak boleh membenarkan potongan yang duduk di posisi
 * distributor, dan sebaliknya. Posisi menyatakan siapa yang DIMAKSUD menanggung; aturan
 * menyatakan apakah maksud itu sah.
 */
export function ruleFor(line: InvoiceLine, rules: PromoRule[], beban: string, percent: number): PromoRule | null {
    if (percent <= 0) return null;
    return rules.find((rule) => rule.itemCode === line.itemCode && !rule.customerCode
        && rule.benefitBeban === beban
        && rule.benefitType === "DISC_PCT"
        && inPeriod(rule, line.transDate)
        && Math.abs(cents(Number(rule.benefitValue) - percent)) <= 0.01) ?? null;
}

/**
 * Tarif Discount Reguler outlet ini (butir 4.10) yang menjelaskan SELURUH potongan distributor
 * pada baris faktur. Tarifnya melekat pada OUTLET dan berlaku semua barang, jadi tidak pernah
 * ketemu lewat `ruleFor` yang mencocokkan per barang.
 *
 * Kode outlet pada faktur Accurate membawa akhiran cabang (`C-MA0056-KN`) sedangkan tarifnya
 * tercetak dengan kode internal (`C-MA0056`), jadi dicocokkan dengan awalan — bukan sama persis.
 */
export function tariffFor(line: InvoiceLine, rules: PromoRule[]): PromoRule[] | null {
    const no = line.customerNo.toUpperCase();
    if (!no) return null;
    const milikOutlet = rules.filter((rule) => rule.customerCode
        && inPeriod(rule, line.transDate)
        && (no === rule.customerCode.toUpperCase() || no.startsWith(`${rule.customerCode.toUpperCase()}-`)));
    return milikOutlet.length ? matchTariff(line.discounts, milikOutlet) : null;
}

/**
 * Aturan tingkat FAKTUR (program MSG): tier tertinggi yang ambang belanjanya terlampaui.
 * Nominal surat TERMASUK PPN sedangkan faktur membawa DPP, jadi klaimnya dikembalikan dulu.
 */
export function fakturRuleFor(
    rules: PromoRule[], beban: string, transDate: string, gross: number, claim: number, lineCount: number,
): PromoRule | null {
    const tiers = rules
        .filter((rule) => !rule.itemCode && rule.benefitBeban === beban && rule.benefitType === "DISC_RP"
            && rule.triggerUnit.toUpperCase() === "RP" && inPeriod(rule, transDate))
        .sort((a, b) => b.triggerQty - a.triggerQty);
    // Ambang DAN manfaat sama-sama TERMASUK PPN; faktur membawa DPP, jadi keduanya
    // dikembalikan. Lihat checkSoPromo — bukti yang sama, 15 faktur September di produksi.
    const reached = tiers.find((tier) => cents(gross * (1 + PPN)) >= tier.triggerQty);
    if (!reached) return null;
    const expected = Number(reached.benefitValue);
    if (!Number.isFinite(expected)) return null;
    // Toleransi Rp 1 per baris: nominalnya dibagi rata lalu dibulatkan di tiap baris.
    return Math.abs(cents(claim * (1 + PPN)) - expected) <= TOLERANCE * Math.max(lineCount, 1) ? reached : null;
}

export type ProgramRecap = {
    key: string;
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    amount: number;
    lines: number;
    invoices: number;
};

export type Recap = {
    invoices: number;
    lines: number;
    gross: number;
    /** Potongan yang COCOK aturan principal — inilah yang benar-benar bisa ditagihkan. */
    principal: number;
    /** Potongan yang COCOK aturan distributor — beban sendiri, dan memang seharusnya begitu. */
    distributor: number;
    /**
     * Potongan yang TIDAK cocok aturan mana pun, di posisi mana pun. Bukan "posisi 6 ke atas":
     * keputusan pengguna 2026-09-12 — yang membuat sebuah potongan tak bertuan adalah TIDAK
     * SESUAINYA dengan promo yang berlaku, bukan letak kolomnya. Untuk Kino hari ini itu berarti
     * SELURUH potongan posisi 1-3 masuk ke sini, karena belum ada satu pun aturan berbeban
     * DISTRIBUTOR yang termuat. Uang ini wajib divalidasi dulu sebelum diakui beban siapa pun.
     */
    unowned: number;
    programs: ProgramRecap[];
    rows: DetailRow[];
    /** Pemeriksaan tarif: yang terdaftar tapi tidak pernah menjelaskan satu potongan pun. */
    tarifMenganggur: TarifMenganggur[];
    /** Pemeriksaan tarif: outlet yang potongannya belum punya aturan, diringkas per outlet. */
    outletTanpaAturan: OutletTanpaAturan[];
};

/**
 * Tarif yang terdaftar tetapi tidak pernah dipakai sepanjang periode.
 *
 * Bukan otomatis salah — outlet bisa saja memang tidak berbelanja. Tetapi tarif yang menganggur
 * berbulan-bulan biasanya berarti salah satu dari tiga hal: kode outletnya salah ketik, outletnya
 * sudah tutup, atau potongannya sebenarnya muncul di KOLOM LAIN sehingga tarifnya tidak pernah
 * cocok. Ketiganya hanya terlihat kalau dihitung.
 */
export type TarifMenganggur = {
    customerCode: string;
    tierNo: number;
    benefitValue: string;
    benefitBeban: string;
    suratProgram: string;
    promoLabel: string;
    /** Outlet ini muncul di faktur periode ini, tetapi tarifnya tetap tidak pernah cocok. */
    outletBertransaksi: boolean;
};

/** Outlet dengan potongan yang belum punya aturan, diringkas supaya lubangnya terlihat. */
export type OutletTanpaAturan = {
    customerNo: string;
    customerName: string;
    amount: number;
    lines: number;
    /** Kolom diskon yang terlibat, mis. "1" atau "4". */
    positions: string[];
    /** Persen yang muncul, supaya bisa langsung diadu dengan tabel tarifnya. */
    percents: number[];
};

/**
 * Rekap satu periode. Angka yang dilaporkan adalah angka Accurate; aturan hanya dipakai untuk
 * MENJELASKAN angka itu, tidak pernah untuk menggantinya.
 */
export function recap(lines: InvoiceLine[], rules: PromoRule[]): Recap {
    const out: Recap = {
        invoices: 0, lines: lines.length, gross: 0,
        principal: 0, distributor: 0, unowned: 0, programs: [], rows: [],
        tarifMenganggur: [], outletTanpaAturan: [],
    };
    // Aturan yang BENAR-BENAR menjelaskan sesuatu, dicatat saat dipakai — bukan ditebak ulang
    // di akhir dengan logika kedua yang bisa menjawab berbeda dari yang dipakai menggolongkan.
    const terpakai = new Set<string>();
    const kunci = (rule: PromoRule) => `${rule.customerCode}|${rule.suratProgram}|${rule.promoGroup}|${rule.itemCode}|${rule.tierNo}`;
    const outletBertransaksi = new Set(lines.map((line) => line.customerNo.toUpperCase()));
    const byProgram = new Map<string, ProgramRecap>();
    const programInvoices = new Map<string, Set<string>>();

    const add = (rule: PromoRule, amount: number, invoiceNo: string) => {
        const key = `${rule.suratProgram}|${rule.promoGroup}`;
        const entry = byProgram.get(key) ?? {
            key, suratProgram: rule.suratProgram, promoLabel: rule.promoLabel,
            promoGroup: rule.promoGroup, amount: 0, lines: 0, invoices: 0,
        };
        entry.amount = cents(entry.amount + amount);
        entry.lines += 1;
        byProgram.set(key, entry);
        if (!programInvoices.has(key)) programInvoices.set(key, new Set());
        programInvoices.get(key)!.add(invoiceNo);
    };

    // Potongan tingkat faktur tidak bisa dinilai per baris — nominalnya milik seluruh faktur.
    const perInvoice = new Map<string, { gross: number; leftover: number; lines: InvoiceLine[] }>();

    for (const line of lines) {
        const invoiceKey = line.invoiceId || line.invoiceNo;
        const bucketOf = perInvoice.get(invoiceKey) ?? { gross: 0, leftover: 0, lines: [] };
        bucketOf.gross = cents(bucketOf.gross + line.gross);
        bucketOf.lines.push(line);
        out.gross = cents(out.gross + line.gross);

        const split = splitDiscounts(line.gross, line.discounts);
        const percentAt = (owner: string) => cents(line.discounts
            .filter((entry) => (OWNER[entry.position] ?? "unowned") === owner)
            .reduce((total, entry) => total + entry.percent, 0));
        const positionsAt = (owner: string) => line.discounts
            .filter((entry) => (OWNER[entry.position] ?? "unowned") === owner)
            .map((entry) => String(entry.position)).join("+");

        const base = {
            invoiceNo: line.invoiceNo, transDate: line.transDate, branchName: line.branchName,
            customerNo: line.customerNo, customerName: line.customerName,
            itemCode: line.itemCode, itemName: line.itemName,
        };

        // Baris BONUS ("beli 30 gratis 1") diputuskan lebih dulu dan sekaligus: faktur
        // mencatatnya sebagai potongan 100% di posisi 1, jadi pencocokan persen per beban
        // tidak akan pernah menemukannya dan seluruh nilainya jatuh ke tak bertuan. Diakui
        // sebagai KLAIM PRINCIPAL sesuai bunyi suratnya (keputusan pengguna 2026-09-15).
        const bonusRule = matchBonusRule(line.discounts, rules.filter((rule) => inPeriod(rule, line.transDate)), line.itemCode);
        // Yang di posisi 1-5 saja; bonus di posisi di luar itu tetap jatuh ke blok tak
        // bertuan di bawah, seperti di gerbang — dan tidak boleh ikut dihitung dua kali.
        const bonusAmount = bonusRule ? cents(split.distributor + split.principal) : 0;
        if (bonusRule && bonusAmount > 0) {
            terpakai.add(kunci(bonusRule));
            out.principal = cents(out.principal + bonusAmount);
            add(bonusRule, bonusAmount, line.invoiceNo);
            out.rows.push({ ...base, bucket: "principal", positions: positionsAt("distributor") || positionsAt("principal"),
                percent: 100, amount: bonusAmount, suratProgram: bonusRule.suratProgram,
                promoGroup: bonusRule.promoGroup, reason: "" });
        }

        for (const owner of (bonusRule && bonusAmount > 0) ? [] : (["distributor", "principal"] as const)) {
            const amount = owner === "distributor" ? split.distributor : split.principal;
            if (amount <= 0) continue;
            const percent = percentAt(owner);
            const beban = owner === "distributor" ? "DISTRIBUTOR" : "PRINCIPAL";
            // Tarif outlet dicoba setelah aturan per barang: yang per barang lebih sempit,
            // jadi kalau keduanya bisa menjelaskan, yang menyebut barangnya yang dipakai.
            const cocokTarif = owner === "distributor" ? tariffFor(line, rules) : null;
            const matched = ruleFor(line, rules, beban, percent) ?? cocokTarif?.[0] ?? null;
            if (matched) {
                for (const dipakai of cocokTarif ?? [matched]) terpakai.add(kunci(dipakai));
                out[owner] = cents(out[owner] + amount);
                if (owner === "principal") add(matched, amount, line.invoiceNo);
                out.rows.push({ ...base, bucket: owner, positions: positionsAt(owner), percent, amount,
                    suratProgram: matched.suratProgram, promoGroup: matched.promoGroup, reason: "" });
                continue;
            }
            out.unowned = cents(out.unowned + amount);
            const adaAturan = rules.some((rule) => rule.itemCode === line.itemCode && !rule.customerCode && rule.benefitBeban === beban);
            const adaTarif = owner === "distributor" && rules.some((rule) => rule.customerCode
                && line.customerNo.toUpperCase().startsWith(rule.customerCode.toUpperCase()));
            out.rows.push({ ...base, bucket: "unowned", positions: positionsAt(owner), percent, amount,
                suratProgram: "", promoGroup: "",
                reason: adaAturan || adaTarif
                    ? `${percent}% (posisi ${positionsAt(owner)}) tidak sama dengan aturan ${beban.toLowerCase()} yang berlaku`
                    : `tidak ada aturan ${beban.toLowerCase()} untuk ${owner === "distributor" ? "outlet ini" : "barang ini"}`,
            });
        }

        // Posisi di luar 1-5: tidak ada yang mengaku menanggung, jadi selalu tak bertuan.
        if (split.unowned > 0) {
            out.unowned = cents(out.unowned + split.unowned);
            out.rows.push({ ...base, bucket: "unowned", positions: positionsAt("unowned"),
                percent: percentAt("unowned"), amount: split.unowned, suratProgram: "", promoGroup: "",
                reason: "posisi di luar 1-5; tidak ada yang menyatakan menanggungnya" });
        }

        // Potongan rupiah yang TIDAK berasal dari rantai persen: calon potongan tingkat faktur.
        const leftover = cents(line.cashDiscount - split.total);
        if (leftover > TOLERANCE) bucketOf.leftover = cents(bucketOf.leftover + leftover);
        perInvoice.set(invoiceKey, bucketOf);
    }

    for (const invoice of perInvoice.values()) {
        if (invoice.leftover <= 0) continue;
        const first = invoice.lines[0];
        const matched = fakturRuleFor(rules, "PRINCIPAL", first.transDate, invoice.gross, invoice.leftover, invoice.lines.length);
        const base = {
            invoiceNo: first.invoiceNo, transDate: first.transDate, branchName: first.branchName,
            customerNo: first.customerNo, customerName: first.customerName,
            itemCode: "", itemName: "(potongan tingkat faktur)", positions: "faktur", percent: 0,
            amount: invoice.leftover,
        };
        if (matched) {
            out.principal = cents(out.principal + invoice.leftover);
            add(matched, invoice.leftover, first.invoiceNo);
            out.rows.push({ ...base, bucket: "principal", suratProgram: matched.suratProgram,
                promoGroup: matched.promoGroup, reason: "" });
            continue;
        }
        out.unowned = cents(out.unowned + invoice.leftover);
        out.rows.push({ ...base, bucket: "unowned", suratProgram: "", promoGroup: "",
            reason: "potongan rupiah tanpa aturan tingkat faktur yang cocok" });
    }

    for (const [key, program] of byProgram) program.invoices = programInvoices.get(key)?.size ?? 0;

    out.invoices = new Set(lines.map((line) => line.invoiceId || line.invoiceNo)).size;
    out.programs = [...byProgram.values()].sort((a, b) => b.amount - a.amount);
    out.rows.sort((a, b) => b.amount - a.amount);

    // Laporan 1 — tarif yang tidak pernah menjelaskan apa pun.
    out.tarifMenganggur = rules
        .filter((rule) => rule.customerCode && !rule.itemCode && !terpakai.has(kunci(rule)))
        .map((rule) => ({
            customerCode: rule.customerCode, tierNo: rule.tierNo, benefitValue: rule.benefitValue,
            benefitBeban: rule.benefitBeban, suratProgram: rule.suratProgram, promoLabel: rule.promoLabel,
            // Outlet yang TIDAK berbelanja wajar kalau tarifnya menganggur. Yang berbelanja
            // tetapi tarifnya tidak pernah cocok — itu yang patut dicurigai.
            outletBertransaksi: [...outletBertransaksi].some((no) =>
                no === rule.customerCode.toUpperCase() || no.startsWith(`${rule.customerCode.toUpperCase()}-`)),
        }))
        .sort((a, b) => Number(b.outletBertransaksi) - Number(a.outletBertransaksi)
            || a.customerCode.localeCompare(b.customerCode) || a.tierNo - b.tierNo);

    // Laporan 2 — potongan tanpa aturan, diringkas per outlet supaya lubangnya terlihat.
    const perOutlet = new Map<string, OutletTanpaAturan>();
    for (const row of out.rows) {
        if (row.bucket !== "unowned") continue;
        const entry = perOutlet.get(row.customerNo) ?? {
            customerNo: row.customerNo, customerName: row.customerName,
            amount: 0, lines: 0, positions: [], percents: [],
        };
        entry.amount = cents(entry.amount + row.amount);
        entry.lines += 1;
        for (const pos of row.positions.split("+").filter(Boolean)) {
            if (!entry.positions.includes(pos)) entry.positions.push(pos);
        }
        if (row.percent > 0 && !entry.percents.includes(row.percent)) entry.percents.push(row.percent);
        perOutlet.set(row.customerNo, entry);
    }
    out.outletTanpaAturan = [...perOutlet.values()]
        .map((entry) => ({ ...entry, positions: entry.positions.sort(), percents: entry.percents.sort((a, b) => a - b) }))
        .sort((a, b) => b.amount - a.amount);

    return out;
}

/** Rp 1 per baris, sama dengan gerbang validasi — hanya menyerap pembulatan. */
export const RECAP_TOLERANCE = TOLERANCE;

const text = (value: unknown) => String(value ?? "").trim();

/** Sheet tarif per outlet; namanya sama dengan judul tabel principalnya, bukan singkatan. */
export const TARIFF_SHEET = "Discount Reguler";
const TARIFF_PROGRAM = "DISCOUNT REGULER";
const TARIFF_GROUP = "TANGGUNGAN DISTRIBUTOR";

/**
 * Sebuah baris tarif hanya dimuat kalau peninjau MENYATAKAN posisinya sudah pasti (kolom
 * `PAKAI`). Keputusan pengguna 2026-09-13: yang posisinya belum terbukti jangan dimuat dulu.
 *
 * Kenapa dijaga di sini dan bukan di tangan penyusun sheetnya: tabel tarif ini diekstrak dari
 * FOTO, dan hanya baris ALFAMART yang posisinya pernah dibuktikan lawan data nyata. Aturan
 * tebakan yang lolos ke gerbang persis sama buruknya dengan tidak punya gerbang — bedanya
 * yang ini terlihat benar.
 */
const DIPAKAI = new Set(["YA", "Y", "YES", "TRUE", "1", "V", "X", "OK", "PASTI", "TERBUKTI", "✓", "√"]);

/**
 * Tabel **Discount Reguler** — butir 4.10 (dan 4.12).
 *
 * Bentuk sheetnya: satu BARIS per outlet, satu KOLOM per posisi (`POSISI 1` .. `POSISI 5`),
 * isinya persen. Itu bentuk tabel aslinya (dan tabel yang dicetak principal), jadi dibaca apa
 * adanya lalu dipecah menjadi satu aturan per (outlet x posisi) — posisi menentukan siapa
 * menanggung, jadi ia tidak boleh larut jadi satu angka gabungan.
 *
 * Isinya BUKAN tarif distributor saja: posisi 1-3 tanggungan distributor, posisi 4-5 klaim
 * principal — persis pembagian yang tercetak pada header tabelnya. Baris Alfamart 2,25% di
 * posisi 4 itulah diskon yang selama ini tidak punya surat (butir 4.12).
 *
 * Tanpa periode: berlaku sampai dicabut, dan baris tanpa tanggal memang dibaca gerbang sebagai
 * selalu berlaku. Yang dicabut hilang dengan memuat ulang berkasnya.
 *
 * Sel kosong BUKAN nol: outlet yang posisinya tidak diisi tidak mendapat tarif di posisi itu,
 * dan potongannya akan tertahan — itu yang diminta ("tidak ada potongan tembus tanpa aturan").
 */
export function parseTariff(
    raw: Record<string, unknown>[],
    ctx: { principal: string; importedBy: string; issues: string[] },
) {
    const out: {
        principal: string; suratProgram: string; promoLabel: string; promoGroupId: string; promoGroup: string;
        itemCode: string; itemName: string; prdId: string; customerCode: string;
        periodStart: string | null; periodEnd: string | null; active: boolean; tierNo: number;
        triggerQty: string; triggerUnit: string; benefitType: string; benefitValue: string;
        benefitUnit: string; benefitBeban: string; onFaktur: boolean; note: string; importedBy: string;
    }[] = [];
    raw.forEach((row, index) => {
        const keys = Object.keys(row);
        const pick = (...names: string[]) => {
            const hit = keys.find((key) => names.includes(key.trim().toUpperCase().replace(/\s+/g, " ")));
            return hit ? text(row[hit]) : "";
        };
        const customerCode = pick("KODE_OUTLET", "KODE OUTLET", "KODE INTERNAL", "CODE INTERNAL", "KODE PELANGGAN", "KODE").toUpperCase();
        const customerName = pick("PELANGGAN", "OUTLET", "NAMA OUTLET", "NAMA PELANGGAN", "CUSTOMER", "NAMA");
        const konfirmasi = pick("PAKAI", "TERBUKTI", "POSISI PASTI");
        // Tarif reguler punya masa berlaku sendiri (tulisan tangan pada tabelnya: 15/8-26 s/d
        // 31/12-26), lepas dari periode surat program. Kosong = berlaku sampai dicabut.
        const periodStart = pick("PERIOD_START", "PERIODE MULAI", "MULAI").slice(0, 10);
        const periodEnd = pick("PERIOD_END", "PERIODE SAMPAI", "SAMPAI").slice(0, 10);
        if (!DIPAKAI.has(konfirmasi.toUpperCase())) {
            const sebutan = customerCode || customerName || `baris ${index + 2}`;
            ctx.issues.push(`${TARIFF_SHEET} ${sebutan}: kolom PAKAI belum diisi — posisinya belum dinyatakan pasti, tarifnya tidak dimuat`);
            return;
        }
        if (!customerCode) {
            // Baris tanpa kode DILAPORKAN, tidak dilewati diam-diam: tiga baris pada tabel
            // aslinya memang tidak terbaca dari foto, dan itu harus terlihat sebagai lubang.
            if (customerName) ctx.issues.push(`${TARIFF_SHEET} baris ${index + 2}: "${customerName}" tanpa kode outlet — tarifnya tidak dimuat`);
            return;
        }
        let terisi = 0;
        for (let position = 1; position <= 5; position += 1) {
            const value = pick(`POSISI ${position}`, `POSISI_${position}`, `DISC_${position}`, `DISC ${position}`);
            if (value === "") continue;
            const percent = Number(value.replace(",", ".").replace("%", ""));
            if (!Number.isFinite(percent) || percent <= 0) {
                if (percent !== 0) ctx.issues.push(`${TARIFF_SHEET} baris ${index + 2} (${customerCode}) posisi ${position}: "${value}" bukan persen`);
                continue;
            }
            terisi += 1;
            // Beban DITURUNKAN dari posisinya, bukan diketik ulang. Header tabel principalnya
            // sendiri memisahkan "Distributor" (1-3) dari "Principle" (4-5), dan itu peta yang
            // sama dengan OWNER. Mengisinya tangan berarti satu tabel bisa menyatakan dua hal
            // berbeda tentang baris yang sama.
            const beban = OWNER[position] === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
            out.push({
                principal: ctx.principal, suratProgram: TARIFF_PROGRAM, promoLabel: customerName,
                promoGroupId: "", promoGroup: TARIFF_GROUP,
                itemCode: "", itemName: "", prdId: "", customerCode,
                periodStart: periodStart || null, periodEnd: periodEnd || null, active: true, tierNo: position,
                triggerQty: "0", triggerUnit: "PCS",
                benefitType: "DISC_PCT", benefitValue: String(percent), benefitUnit: "%",
                benefitBeban: beban, onFaktur: true,
                note: pick("CATATAN", "PERIKSA", "KETERANGAN"), importedBy: ctx.importedBy,
            });
        }
        if (terisi === 0) ctx.issues.push(`${TARIFF_SHEET} baris ${index + 2} (${customerCode}): tidak ada satu posisi pun yang terisi`);
    });
    return dedupe(out, ctx.issues);
}

/**
 * Satu outlet bisa tertulis dua kali — daftar yang disusun tangan dari jaringan toko memang
 * begitu (SATU SAMA JAYA `C-SAT017` tertulis pada baris 27 dan 42). Kembarnya WAJIB diselesaikan
 * di sini: kunci uniknya sama persis, jadi menyerahkannya ke database berarti SELURUH muatan
 * gagal karena satu baris kembar — 90 aturan hilang gara-gara satu salah ketik.
 *
 * Kembar yang ISINYA SAMA digabung dan dihitung. Kembar yang isinya BERBEDA adalah pernyataan
 * yang saling bertentangan tentang outlet dan posisi yang sama; keduanya DIBUANG dan dilaporkan,
 * karena memilih salah satunya berarti menebak tarif mana yang benar.
 */
function dedupe<T extends { customerCode: string; tierNo: number; benefitValue: string; benefitBeban: string; suratProgram: string; promoGroup: string; itemCode: string }>(
    rows: T[], issues: string[],
): T[] {
    const byKey = new Map<string, T[]>();
    for (const row of rows) {
        const key = `${row.suratProgram}|${row.promoGroup}|${row.itemCode}|${row.customerCode}|${row.tierNo}`;
        byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const out: T[] = [];
    for (const [, kembar] of byKey) {
        const pertama = kembar[0];
        if (kembar.length === 1) { out.push(pertama); continue; }
        const beda = kembar.filter((row) => row.benefitValue !== pertama.benefitValue || row.benefitBeban !== pertama.benefitBeban);
        if (beda.length === 0) {
            issues.push(`${TARIFF_SHEET} ${pertama.customerCode} posisi ${pertama.tierNo}: tertulis ${kembar.length}x dengan isi yang sama — digabung jadi satu`);
            out.push(pertama);
            continue;
        }
        const nilai = [...new Set(kembar.map((row) => `${row.benefitValue}% ${row.benefitBeban}`))].join(" vs ");
        issues.push(`${TARIFF_SHEET} ${pertama.customerCode} posisi ${pertama.tierNo}: tertulis ${kembar.length}x dengan isi BERBEDA (${nilai}) — tidak dimuat, tentukan dulu yang benar`);
    }
    return out;
}
