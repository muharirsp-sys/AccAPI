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
import { OWNER, splitDiscounts, TOLERANCE, type DiscountAt } from "@/lib/principal-validation";

export type PromoRule = {
    principal: string;
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    /** Kosong = aturan tingkat FAKTUR (berlaku semua barang), mis. program MSG. */
    itemCode: string;
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
    return rules.find((rule) => rule.itemCode === line.itemCode
        && rule.benefitBeban === beban
        && rule.benefitType === "DISC_PCT"
        && inPeriod(rule, line.transDate)
        && Math.abs(cents(Number(rule.benefitValue) - percent)) <= 0.01) ?? null;
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
    const reached = tiers.find((tier) => gross >= tier.triggerQty);
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
};

/**
 * Rekap satu periode. Angka yang dilaporkan adalah angka Accurate; aturan hanya dipakai untuk
 * MENJELASKAN angka itu, tidak pernah untuk menggantinya.
 */
export function recap(lines: InvoiceLine[], rules: PromoRule[]): Recap {
    const out: Recap = {
        invoices: 0, lines: lines.length, gross: 0,
        principal: 0, distributor: 0, unowned: 0, programs: [], rows: [],
    };
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

        for (const owner of ["distributor", "principal"] as const) {
            const amount = owner === "distributor" ? split.distributor : split.principal;
            if (amount <= 0) continue;
            const percent = percentAt(owner);
            const beban = owner === "distributor" ? "DISTRIBUTOR" : "PRINCIPAL";
            const matched = ruleFor(line, rules, beban, percent);
            if (matched) {
                out[owner] = cents(out[owner] + amount);
                if (owner === "principal") add(matched, amount, line.invoiceNo);
                out.rows.push({ ...base, bucket: owner, positions: positionsAt(owner), percent, amount,
                    suratProgram: matched.suratProgram, promoGroup: matched.promoGroup, reason: "" });
                continue;
            }
            out.unowned = cents(out.unowned + amount);
            const adaAturan = rules.some((rule) => rule.itemCode === line.itemCode && rule.benefitBeban === beban);
            out.rows.push({ ...base, bucket: "unowned", positions: positionsAt(owner), percent, amount,
                suratProgram: "", promoGroup: "",
                reason: adaAturan
                    ? `${percent}% tidak sama dengan aturan ${beban.toLowerCase()} yang berlaku untuk barang ini`
                    : `tidak ada aturan ${beban.toLowerCase()} untuk barang ini`,
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
    return out;
}

/** Rp 1 per baris, sama dengan gerbang validasi — hanya menyerap pembulatan. */
export const RECAP_TOLERANCE = TOLERANCE;
