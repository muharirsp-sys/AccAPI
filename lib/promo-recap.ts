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
import { splitDiscounts, TOLERANCE, type DiscountAt } from "@/lib/principal-validation";

export type PromoRule = {
    principal: string;
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    itemCode: string;
    periodStart: string | null;
    periodEnd: string | null;
    benefitType: string;
    benefitValue: string;
    benefitUnit: string;
    onFaktur: boolean;
};

export type InvoiceLine = {
    invoiceNo: string;
    invoiceId: string;
    transDate: string;
    customerNo: string;
    itemCode: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    gross: number;
    discounts: DiscountAt[];
    cashDiscount: number;
};

const cents = (value: number) => Math.round(value * 100) / 100;
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
    const invoice = (raw ?? {}) as Record<string, unknown>;
    const details = Array.isArray(invoice.detailItem) ? invoice.detailItem : [];
    const invoiceNo = String(invoice.number ?? "");
    const invoiceId = String(invoice.id ?? "");
    const transDate = isoDate(String(invoice.transDate ?? ""));
    const customerNo = String(
        (invoice.customer as Record<string, unknown> | undefined)?.customerNo ?? invoice.customerNo ?? "",
    );

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
            invoiceNo, invoiceId, transDate, customerNo,
            itemCode: String(detail.itemNo ?? item.no ?? ""),
            itemName: String(item.name ?? detail.detailName ?? ""),
            quantity, unitPrice,
            gross: cents(quantity * unitPrice),
            discounts: percents,
            cashDiscount: num(detail.itemCashDiscount),
        };
    });
}

export type RuleMatch = { rule: PromoRule; expectedPercent: number | null };

/** Aturan yang berlaku untuk satu baris: barangnya cocok DAN tanggal faktur di dalam periode. */
export function ruleFor(line: InvoiceLine, rules: PromoRule[]): RuleMatch | null {
    const found = rules.find((rule) =>
        rule.itemCode === line.itemCode
        && (!rule.periodStart || rule.periodStart <= line.transDate)
        && (!rule.periodEnd || line.transDate <= rule.periodEnd));
    if (!found) return null;
    const percent = found.benefitType === "DISC_PCT" ? Number(found.benefitValue) : null;
    return { rule: found, expectedPercent: Number.isFinite(percent as number) ? (percent as number) : null };
}

export type ProgramRecap = {
    key: string;
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    principalAmount: number;
    lines: number;
    invoices: number;
    mismatched: { invoiceNo: string; itemCode: string; expected: number; actual: number }[];
};

export type Recap = {
    invoices: number;
    lines: number;
    gross: number;
    distributor: number;
    principal: number;
    unowned: number;
    /** Klaim principal yang TIDAK punya aturan terbit — uang yang belum bisa dipertanggungjawabkan. */
    principalWithoutRule: number;
    cashDiscount: number;
    programs: ProgramRecap[];
    unownedLines: { invoiceNo: string; itemCode: string; amount: number; positions: number[] }[];
    unexplained: { invoiceNo: string; itemCode: string; amount: number }[];
};

/**
 * Rekap satu periode. Angka yang dilaporkan adalah angka Accurate; aturan hanya dipakai untuk
 * MENJELASKAN angka itu, tidak pernah untuk menggantinya.
 */
export function recap(lines: InvoiceLine[], rules: PromoRule[]): Recap {
    const out: Recap = {
        invoices: 0, lines: lines.length, gross: 0, distributor: 0, principal: 0, unowned: 0,
        principalWithoutRule: 0, cashDiscount: 0, programs: [], unownedLines: [], unexplained: [],
    };
    const invoiceIds = new Set<string>();
    const byProgram = new Map<string, ProgramRecap>();

    for (const line of lines) {
        invoiceIds.add(line.invoiceId || line.invoiceNo);
        const split = splitDiscounts(line.gross, line.discounts);
        out.gross = cents(out.gross + line.gross);
        out.distributor = cents(out.distributor + split.distributor);
        out.principal = cents(out.principal + split.principal);
        out.unowned = cents(out.unowned + split.unowned);
        out.cashDiscount = cents(out.cashDiscount + line.cashDiscount);

        if (split.unowned > 0) {
            out.unownedLines.push({
                invoiceNo: line.invoiceNo, itemCode: line.itemCode, amount: split.unowned,
                positions: line.discounts.filter((d) => d.position > 5).map((d) => d.position),
            });
        }
        if (split.principal <= 0) continue;

        const matched = ruleFor(line, rules);
        if (!matched) {
            out.principalWithoutRule = cents(out.principalWithoutRule + split.principal);
            out.unexplained.push({ invoiceNo: line.invoiceNo, itemCode: line.itemCode, amount: split.principal });
            continue;
        }
        const key = `${matched.rule.suratProgram}|${matched.rule.promoGroup}`;
        const program = byProgram.get(key) ?? {
            key, suratProgram: matched.rule.suratProgram, promoLabel: matched.rule.promoLabel,
            promoGroup: matched.rule.promoGroup, principalAmount: 0, lines: 0, invoices: 0, mismatched: [],
        };
        program.principalAmount = cents(program.principalAmount + split.principal);
        program.lines += 1;
        byProgram.set(key, program);

        // Sesuai mekanisme? Dibandingkan pada PERSEN posisi principal, bukan pada rupiahnya:
        // rupiah ikut berubah oleh diskon distributor yang memotong lebih dulu.
        if (matched.expectedPercent !== null) {
            const actual = line.discounts
                .filter((entry) => entry.position === 4 || entry.position === 5)
                .reduce((total, entry) => total + entry.percent, 0);
            if (Math.abs(cents(actual - matched.expectedPercent)) > 0.01) {
                program.mismatched.push({
                    invoiceNo: line.invoiceNo, itemCode: line.itemCode,
                    expected: matched.expectedPercent, actual: cents(actual),
                });
            }
        }
    }

    for (const program of byProgram.values()) {
        program.invoices = new Set(
            lines.filter((line) => {
                const matched = ruleFor(line, rules);
                return matched && `${matched.rule.suratProgram}|${matched.rule.promoGroup}` === program.key;
            }).map((line) => line.invoiceNo),
        ).size;
    }

    out.invoices = invoiceIds.size;
    out.programs = [...byProgram.values()].sort((a, b) => b.principalAmount - a.principalAmount);
    return out;
}

/** Rp 1 per baris, sama dengan gerbang validasi — hanya menyerap pembulatan. */
export const RECAP_TOLERANCE = TOLERANCE;
