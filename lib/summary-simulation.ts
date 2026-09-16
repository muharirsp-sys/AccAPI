/*
 * Tujuan: Mensimulasikan sebuah publikasi Summary SEBELUM ia jadi aturan yang menahan faktur.
 * Caller: app/api/promo-rule/from-summary (mode simulasi) dan layar Aturan Promo.
 * Dependensi: lib/summary-bridge, lib/principal-validation. Murni — tanpa DB dan tanpa jaringan.
 * Main Functions: simulateLetter.
 *
 * KENAPA ADA SIMULASI SAMA SEKALI.
 * Yang menyusun Summary bukan yang menulis kodenya, dan ia diminta menyatakan "program ini sudah
 * benar dan bisa berjalan" — pernyataan yang menahan faktur sungguhan dan mengesahkan potongan
 * sungguhan. Tanpa diperlihatkan APA yang akan dibaca sistem dari suratnya, pernyataan itu cuma
 * tanda tangan di atas sesuatu yang tidak bisa ia lihat. Centang seperti itu tidak menambah
 * keamanan apa pun; ia hanya memindahkan tanggung jawab ke orang yang tidak punya cara memeriksa.
 *
 * TIGA PERTANYAAN yang dijawab simulasi ini, dan ketiganya pertanyaan orang, bukan pertanyaan
 * program:
 *
 *   1. "Suratku jadi aturan apa saja?"      -> `rules`, dikelompokkan supaya bisa dibaca mata
 *   2. "Ada yang tidak terbaca?"            -> `refused` dan `notes`, apa adanya beserta sebabnya
 *   3. "Kalau dipakai, apa yang terjadi?"   -> `trial`, diadu dengan baris faktur SUNGGUHAN
 *
 * Pertanyaan ketiga yang paling menentukan. Aturan bisa terbaca sempurna oleh sistem dan tetap
 * salah — salah posisi diskon, salah beban, ambang yang tidak pernah tercapai. Yang membuktikan
 * bukan bentuknya, melainkan hasilnya atas faktur yang benar-benar pernah terjadi.
 *
 * SIMULASI TIDAK PERNAH MENULIS APA PUN. Ia membaca aturan yang BELUM ada dan menghitungnya
 * terhadap baris yang SUDAH ada. Kalau ia menulis, orang akan berhenti menjalankannya karena
 * takut merusak — dan simulasi yang ditakuti sama saja tidak punya simulasi.
 */
import { bridgeRows, type BridgeRow, type PublishedLetter } from "./summary-bridge";
import {
    matchItemRule, needsTriggerCheck, purchaseByGroup, splitDiscounts, triggerGroupKey, triggerReached,
    type DiscountAt, type PublishedRule,
} from "./principal-validation";

/** Satu baris faktur/laporan nyata yang dipakai menguji aturannya. */
export type TrialLine = {
    soNo: string;
    itemCode: string;
    /** Jumlah dalam satuan TERKECIL. */
    quantity: number;
    gross: number;
    discounts: DiscountAt[];
    bonus?: boolean;
};

export type SimulationRuleGroup = {
    suratProgram: string;
    promoGroup: string;
    benefitType: string;
    benefitValue: string;
    benefitBeban: string;
    tierNo: number;
    triggerQty: string;
    triggerUnit: string;
    periodStart: string;
    periodEnd: string;
    channel: string;
    outletList: string;
    outletListMode: string;
    /** Kode barang yang ikut aturan ini. Dipotong saat ditampilkan, tidak di sini. */
    itemCodes: string[];
};

export type SimulationTrial = {
    /** Baris nyata yang barangnya memang disebut surat ini. */
    lines: number;
    /** Baris yang punya potongan dan potongannya DIJELASKAN aturan surat ini. */
    explained: number;
    /** Baris yang punya potongan tetapi TIDAK dijelaskan; masing-masing dengan sebabnya. */
    unexplained: { soNo: string; itemCode: string; percent: number; reason: string }[];
    /** Baris yang barangnya disebut surat tetapi memang tanpa potongan sama sekali. */
    noDiscount: number;
};

export type Simulation = {
    ok: boolean;
    suratProgram: string;
    ruleCount: number;
    groups: SimulationRuleGroup[];
    refused: string[];
    notes: string[];
    trial: SimulationTrial;
    /** Kalimat yang dibaca manusia; urutannya urutan yang harus ia periksa. */
    warnings: string[];
};

const key = (row: BridgeRow) => [row.suratProgram, row.promoGroup, row.benefitType, row.benefitValue,
    row.benefitBeban, row.tierNo, row.triggerQty, row.triggerUnit, row.periodStart, row.periodEnd,
    row.channel, row.outletList, row.outletListMode].join("|");

/** Baris jembatan -> bentuk yang dibaca gerbang. Sama dengan yang ditulis route from-summary. */
const asRule = (row: BridgeRow): PublishedRule => ({
    suratProgram: row.suratProgram, promoGroup: row.promoGroup, itemCode: row.itemCode,
    customerCode: row.customerCode, tierNo: row.tierNo,
    periodStart: row.periodStart, periodEnd: row.periodEnd,
    triggerQty: Number(row.triggerQty), triggerUnit: row.triggerUnit,
    benefitType: row.benefitType, benefitValue: row.benefitValue, benefitBeban: row.benefitBeban,
    channel: row.channel, outletList: row.outletList, outletListMode: row.outletListMode,
});

/**
 * Menguji aturan calon terhadap baris faktur SUNGGUHAN.
 *
 * Yang SENGAJA tidak ikut diperiksa di sini: periode, daftar outlet peserta, dan channel. Baris
 * ujinya diambil dari bulan yang sudah lewat dan dari outlet apa saja, jadi menyaringnya akan
 * membuat simulasi selalu kosong dan tidak membuktikan apa pun. Yang diuji adalah yang memang
 * bisa diuji tanpa konteks: apakah PERSEN, POSISI, BEBAN, dan AMBANG-nya cocok dengan potongan
 * yang benar-benar pernah turun pada barang itu.
 */
function runTrial(rows: BridgeRow[], lines: TrialLine[]): SimulationTrial {
    const rules = rows.map(asRule);
    const items = new Set(rules.map((rule) => rule.itemCode).filter(Boolean));
    const relevan = lines.filter((line) => items.has(line.itemCode));
    const trial: SimulationTrial = { lines: relevan.length, explained: 0, unexplained: [], noDiscount: 0 };
    if (!relevan.length) return trial;

    // Ambang dihitung per SO, sama seperti gerbangnya — kalau berbeda, simulasi akan berjanji
    // sesuatu yang gerbangnya tidak tepati.
    const perSo = new Map<string, TrialLine[]>();
    for (const line of relevan) perSo.set(line.soNo, [...(perSo.get(line.soNo) ?? []), line]);

    for (const [soNo, isi] of perSo) {
        const belanja = purchaseByGroup(isi, rules.filter(needsTriggerCheck));
        for (const line of isi) {
            if (!line.discounts?.length) { trial.noDiscount += 1; continue; }
            const milikBarang = rules.filter((rule) => rule.itemCode === line.itemCode);
            const lolosAmbang = milikBarang.filter((rule) =>
                !needsTriggerCheck(rule) || triggerReached(rule, belanja.get(triggerGroupKey(rule))).ok);
            const split = splitDiscounts(line.gross, line.discounts);
            const cocok = (split.principal > 0 && matchItemRule(line.discounts, lolosAmbang, line.itemCode, "principal"))
                || (split.distributor > 0 && matchItemRule(line.discounts, lolosAmbang, line.itemCode, "distributor"));
            if (cocok) { trial.explained += 1; continue; }

            const persen = line.discounts.reduce((total, entry) => total + entry.percent, 0);
            const tertahanAmbang = milikBarang.find((rule) => needsTriggerCheck(rule)
                && !triggerReached(rule, belanja.get(triggerGroupKey(rule))).ok);
            const sebab = tertahanAmbang
                ? (triggerReached(tertahanAmbang, belanja.get(triggerGroupKey(tertahanAmbang))) as { reason: string }).reason
                : milikBarang.length === 0
                    ? "barang ini tidak punya aturan pada surat ini"
                    : `potongan ${persen}% tidak sama dengan aturan surat ini (${milikBarang.map((rule) => `${rule.benefitValue}% beban ${rule.benefitBeban}`).join(", ")})`;
            trial.unexplained.push({ soNo, itemCode: line.itemCode, percent: persen, reason: sebab });
        }
    }
    trial.unexplained.sort((a, b) => a.soNo.localeCompare(b.soNo) || a.itemCode.localeCompare(b.itemCode));
    return trial;
}

/**
 * Simulasi satu publikasi. `trialLines` boleh kosong — hasilnya tetap berguna untuk pertanyaan
 * 1 dan 2, dan kalimat peringatannya akan menyebut bahwa pertanyaan 3 belum terjawab.
 */
export function simulateLetter(letter: PublishedLetter, trialLines: TrialLine[] = []): Simulation {
    const { rows, refused, notes } = bridgeRows(letter);

    const groups = new Map<string, SimulationRuleGroup>();
    for (const row of rows) {
        const k = key(row);
        const entry = groups.get(k) ?? {
            suratProgram: row.suratProgram, promoGroup: row.promoGroup,
            benefitType: row.benefitType, benefitValue: row.benefitValue, benefitBeban: row.benefitBeban,
            tierNo: row.tierNo, triggerQty: row.triggerQty, triggerUnit: row.triggerUnit,
            periodStart: row.periodStart, periodEnd: row.periodEnd,
            channel: row.channel, outletList: row.outletList, outletListMode: row.outletListMode,
            itemCodes: [],
        };
        if (row.itemCode) entry.itemCodes.push(row.itemCode);
        groups.set(k, entry);
    }

    const trial = runTrial(rows, trialLines);
    const warnings: string[] = [];

    // Urutannya urutan yang harus diperiksa orang, bukan urutan kemunculannya di kode.
    if (!rows.length) {
        warnings.push("Publikasi ini TIDAK menghasilkan satu aturan pun. Selama begitu, menerbitkannya "
            + "tidak menahan dan tidak mengesahkan apa pun — periksa daftar penolakan di bawah.");
    }
    if (refused.length) {
        warnings.push(`${refused.length} program tidak bisa dimuat. Yang tidak dimuat TIDAK akan menahan `
            + "faktur, jadi potongannya akan jatuh sebagai tak bertuan sampai aturannya ada.");
    }
    const tanpaAmbang = rows.filter((row) => row.benefitType === "BONUS_QTY" && Number(row.triggerQty) <= 0);
    if (tanpaAmbang.length) {
        warnings.push("Ada aturan BONUS tanpa ambang beli. Bonus tanpa syarat pembelian berarti setiap "
            + "pembelian berapa pun berhak bonus — pastikan itu memang bunyi suratnya.");
    }
    const krt = rows.filter((row) => String(row.triggerUnit).toUpperCase() === "KRT" && Number(row.triggerQty) > 0);
    if (krt.length) {
        warnings.push("Ada ambang bersatuan KRT. Isi karton berbeda tiap barang, jadi gerbang TIDAK bisa "
            + "menilainya dan barisnya akan tertahan. Tulis ambangnya dalam satuan terkecil (PCS).");
    }
    if (!trialLines.length) {
        warnings.push("Belum ada baris faktur nyata untuk diuji, jadi yang terbukti baru bentuk aturannya — "
            + "bukan hasilnya. Unggah laporan principal yang memuat barang surat ini untuk pembuktian penuh.");
    } else if (trial.lines === 0) {
        warnings.push("Tidak satu pun baris faktur yang pernah memuat barang surat ini, jadi aturannya belum "
            + "pernah teruji atas data sungguhan.");
    } else if (trial.unexplained.length) {
        warnings.push(`${trial.unexplained.length} baris nyata berpotongan TIDAK dijelaskan aturan ini. `
            + "Itu belum tentu salah — potongannya bisa milik surat lain — tetapi periksa satu per satu "
            + "sebelum menyatakan programnya benar.");
    }

    return {
        ok: rows.length > 0,
        // Semua surat yang benar-benar dimuat, bukan yang tertulis di kepala publikasi: satu
        // Summary bisa memuat beberapa surat, dan yang dilihat pemeriksa harus yang akan ditulis.
        suratProgram: [...new Set(rows.map((row) => row.suratProgram))].join(", ") || letter.suratProgram,
        ruleCount: rows.length,
        groups: [...groups.values()],
        refused, notes, trial, warnings,
    };
}
