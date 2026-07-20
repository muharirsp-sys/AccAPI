/*
 * Tujuan: Domain engine deterministik untuk normalisasi item, Kamus Kode kontekstual, Form Fix, QC, dan kemiripan principal.
 * Caller: lib/master-barang/service.ts, route API Master Barang, dan self-check CLI.
 * Dependensi: node:crypto (hash revisi/challenge); tanpa DB dan tanpa HTTP.
 * Main Functions: generateMasterBarang, findSimilarPrinciples, normalizePrincipleName, runMasterBarangSelfCheck.
 * Side Effects: Tidak ada pada flow normal; self-check hanya menulis hasil ke stdout.
 */
import { createHash } from "node:crypto";
import { breakdownByCode, isWinCode } from "./breakdown";

export type SourceItem = {
    sourceRow?: number;
    sourcePage?: number;
    kodePcpl?: string;
    // Kode Barang Win dari ekspor master lama; dipisah dari kodePcpl karena satu baris bisa punya
    // keduanya (KDBRG + KDPRC). Ini yang dibedah jadi struktur KLP/Sub/Aroma.
    kodeWin?: string;
    kelompokPcpl?: string;
    namaBarang: string;
    isiCtn?: string | number;
    ketTambahan?: string;
    satuan?: string;
    klp?: string;
    subKlp?: string;
    subKlp2?: string;
    aroma?: string;
    gramasi?: string;
    kemasan?: string;
    promo?: string;
    sachet?: string;
    golongan?: string;
    confidence?: number;
    reviewNotes?: string[];
};

export type CodebookLevel = "klp" | "sub_klp" | "sub_klp2" | "aroma" | "gramasi" | "kemasan" | "promo" | "sachet" | "golongan";

export type CodebookEntry = {
    key: string;
    level: CodebookLevel;
    scope: string;
    sourceName: string;
    name: string;
    code: string;
    generated: boolean;
};

export type FormFixRow = {
    no: number;
    kodePcpl: string;
    kelompokPcpl: string;
    namaBarangPrinciple: string;
    isiCtn: string;
    ketTambahan: string;
    satuanFixWin: string;
    namaKelompokWin: string;
    kodeKelompokWin: string;
    kodeBarangWin2: string;
    len15: number;
    namaWin: string;
    len50: number;
    namaPcpl: string;
    kodePcplWin: string;
    namaKlp: string;
    kodeKlp: string;
    namaSubKlp: string;
    kodeSubKlp: string;
    namaSubKlp2: string;
    kodeSubKlp2: string;
    namaAroma: string;
    kodeAroma: string;
    namaGramasi: string;
    kodeGramasi: string;
    namaKemasan: string;
    kodeKemasan: string;
    namaPromo: string;
    kodePromo: string;
    namaSachet: string;
    kodeSachet: string;
    ketTambahan2: string;
    ketGolongan: string;
    kodeGolongan: string;
    sourceRow?: number;
    sourcePage?: number;
    confidence: number;
};

export type QcIssue = {
    severity: "error" | "warning" | "info";
    code: string;
    row?: number;
    message: string;
};

export type MasterQc = {
    errors: number;
    warnings: number;
    over50: number;
    invalidCodeLength: number;
    lowConfidence: number;
    duplicateCodes: number;
    gramasiNearDup: number;
    issues: QcIssue[];
};

export type GeneratedMaster = {
    sourceItems: SourceItem[];
    codebook: CodebookEntry[];
    formRows: FormFixRow[];
    qc: MasterQc;
    revisionHash: string;
};

export const FORM_FIX_COLUMNS: Array<{ key: keyof FormFixRow; label: string }> = [
    { key: "no", label: "NO" },
    { key: "kodePcpl", label: "Kode Pcpl" },
    { key: "kelompokPcpl", label: "Klp Brg Pcpl" },
    { key: "namaBarangPrinciple", label: "Nama Barang Principle" },
    { key: "isiCtn", label: "ISI/CTN" },
    { key: "ketTambahan", label: "Ket. Tambahan / Pembantu" },
    { key: "satuanFixWin", label: "SATUAN Fix Win" },
    { key: "namaKelompokWin", label: "Nama Kelompok Win" },
    { key: "kodeKelompokWin", label: "Kode Kelompok Win" },
    // Label ekspor = "Kode Barang"/"Nama Barang" (sama seperti master legacy) supaya file
    // hasil ekspor langsung terbaca parser /summary. "Kode BARANG Win2"/"Nama Win" = nama lama.
    { key: "kodeBarangWin2", label: "Kode Barang" },
    { key: "len15", label: "LEN 15" },
    { key: "namaWin", label: "Nama Barang" },
    { key: "len50", label: "LEN 55" },
    { key: "namaPcpl", label: "Nama Pcpl" },
    { key: "kodePcplWin", label: "kode  2 Digit (hrf+No)" },
    { key: "namaKlp", label: "Nama KLP" },
    { key: "kodeKlp", label: "kode  2 Digit (Nomor)" },
    { key: "namaSubKlp", label: "Nama Sub KLP" },
    { key: "kodeSubKlp", label: "kode  1 Digit (Nomor)" },
    { key: "namaSubKlp2", label: "Nama Sub KLP2" },
    { key: "kodeSubKlp2", label: "kode  1 Digit (Nomor)5" },
    { key: "namaAroma", label: "Nama Aroma/Rasa" },
    { key: "kodeAroma", label: "kode  2 Digit (Nomor)2" },
    { key: "namaGramasi", label: "Nama Gramasi atau Jumlah Pack per CTN" },
    { key: "kodeGramasi", label: "kode  4 Digit (Nomor)" },
    { key: "namaKemasan", label: "Nama Jenis Kemasan" },
    { key: "kodeKemasan", label: "kode  1 Digit (Nomor)3" },
    { key: "namaPromo", label: "Nama Promo" },
    { key: "kodePromo", label: "kode  1 Digit (Nomor)4" },
    { key: "namaSachet", label: "Gunakan ini apabila item tersebut sachet" },
    { key: "kodeSachet", label: "kode  1 Digit (Nomor)32" },
    { key: "ketTambahan2", label: "KET TAMBAHAN2" },
    { key: "ketGolongan", label: "KET. GOLONGAN" },
    { key: "kodeGolongan", label: "kode  1 Digit (Nomor)" },
];

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const upper = (value: unknown) => clean(value).toUpperCase();

// Batas panjang Nama Win. Dulu 50 (batas Win); Accurate menampung 255, jadi dinaikkan ke 55
// demi keterbacaan nama. Ini ambang REVIEW, bukan pemotongan otomatis (lihat QC LEN50_REVIEW).
export const NAMA_WIN_MAX = 55;

export function normalizePrincipleName(value: string): string {
    return upper(value).replace(/\b(PT|CV|TBK|INDONESIA|INDO)\b/g, " ").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
    return upper(value).replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
    return normalizeKey(value).split(" ").filter(Boolean);
}

function damerau(a: string, b: string): number {
    const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) rows[i][0] = i;
    for (let j = 0; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
            }
        }
    }
    return rows[a.length][b.length];
}

export function principalSimilarity(a: string, b: string): number {
    const na = normalizePrincipleName(a), nb = normalizePrincipleName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const edit = 1 - damerau(na, nb) / Math.max(na.length, nb.length);
    const ta = new Set(tokens(na)), tb = new Set(tokens(nb));
    const intersection = [...ta].filter((token) => tb.has(token)).length;
    const tokenScore = intersection / Math.max(ta.size, tb.size, 1);
    const contains = na.includes(nb) || nb.includes(na) ? 0.92 : 0;
    return Math.max(edit, tokenScore, contains);
}

export function findSimilarPrinciples(input: string, existing: Array<{ id: string; principleName: string }>, threshold = 0.72) {
    return existing
        .map((item) => ({ ...item, score: principalSimilarity(input, item.principleName) }))
        .filter((item) => item.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
}

function inferGramasi(item: SourceItem): string {
    const explicit = upper(item.gramasi);
    if (explicit) return explicit;
    const name = upper(item.namaBarang);
    const matches = [...name.matchAll(/(?:\b|X)(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L)\b/g)];
    if (!matches.length) return item.isiCtn ? `${clean(item.isiCtn)} PCS` : "1 PCS";
    const match = matches[matches.length - 1];
    const unit = match[2] === "G" ? "GR" : match[2] === "LTR" || match[2] === "LT" ? "L" : match[2];
    return `${match[1].replace(",", ".")} ${unit}`;
}

function gramasiCode(value: string): string {
    const normalized = upper(value);
    const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L|PCS)/);
    if (!match) return "0001";
    const number = Number(match[1].replace(",", "."));
    const unit = match[2];
    if (unit === "KG" || unit === "L" || unit === "LTR" || unit === "LT") {
        return `1${String(Math.round(number)).padStart(3, "0")}`.slice(-4);
    }
    return String(Math.max(0, Math.round(number))).padStart(4, "0").slice(-4);
}

function inferKemasan(item: SourceItem): string {
    if (clean(item.kemasan)) return upper(item.kemasan);
    const name = upper(item.namaBarang);
    const choices: Array<[RegExp, string]> = [
        [/\b(SACHET|SCH)\b/, "SCH"], [/\b(POUCH|PCH|REFILL)\b/, "PCH"], [/\b(BOTTLE|BOTOL|BTL)\b/, "BTL"],
        [/\b(CAN|KALENG)\b/, "CAN"], [/\b(JAR)\b/, "JAR"], [/\b(CUP)\b/, "CUP"], [/\b(BAG)\b/, "BAG"],
    ];
    return choices.find(([pattern]) => pattern.test(name))?.[1] ?? "PCS";
}

function inferKlp(item: SourceItem): string {
    if (clean(item.klp)) return upper(item.klp);
    if (clean(item.kelompokPcpl)) return upper(item.kelompokPcpl);
    // Item ber-kode Win sudah dibedah dari kodenya; KLP kosong berarti memang kosong. Tebakan
    // "2 kata pertama" di bawah malah menaruh nama principal jadi KLP ("KNF OVALE").
    if (isWinCode(item.kodeWin || item.kodePcpl || "")) return "";
    const name = upper(item.namaBarang);
    const category = ["SABUN", "LOTION", "SHAMPOO", "DETERGENT", "KECAP", "SAMBAL", "MINUMAN", "MAKANAN", "PARFUM", "TISSUE"]
        .find((word) => name.includes(word));
    return category ?? (tokens(name).slice(0, 2).join(" ") || "LAINNYA");
}

function golonganFor(gramasi: string): string {
    if (/\b(KG|GR|G)\b/.test(upper(gramasi))) return "GRAM";
    if (/\b(ML|L|LTR|LT)\b/.test(upper(gramasi))) return "LITER";
    return "PACK";
}

function canonicalSource(items: SourceItem[]): SourceItem[] {
    const seen = new Set<string>();
    return items.map((item) => ({ ...item, namaBarang: upper(item.namaBarang) }))
        .filter((item) => {
            if (!item.namaBarang) return false;
            // Keputusan user 2026-07-20: bila Kode Barang principal ada, dedup pakai kode+isi saja.
            // Nama sengaja DIBUANG dari kunci — hasil ekstraksi legacy sering kotor untuk baris yang
            // sama (ABC PI: "ABC BV NU ..." vs "ABC> BV NU ...") sehingga kembar lolos. Isi tetap
            // ikut karena satu kode principal bisa punya kemasan berbeda (FON: isi 12 vs 120).
            // Tanpa kode (banyak master hasil OCR), jatuh ke kunci nama lama.
            // Gramasi dinormalkan di kunci ("70 GR" == "70GR"): penyelaras menulis format donor
            // ke item tersimpan, jadi kiriman ulang item yang sama harus tetap terdeteksi kembar.
            // Kode Win menang atas kode principal: satu KDPRC bisa punya dua KDBRG yang memang
            // beda item (mis. "...010" vs "...010B" untuk baris bonus "B>"), jangan dilebur.
            const kode = upper(item.kodeWin) || upper(item.kodePcpl);
            const gram = inferGramasi(item);
            const key = kode
                ? `${kode}|${clean(item.isiCtn)}`
                : `|${item.namaBarang}|${clean(item.isiCtn)}|${normGram(gram) || gram}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

// Item yang datang cuma sebagai "Kode Barang Win + Nama Win" (mis. master hasil ekspor To Win)
// dibedah dulu jadi kolom struktur. Hanya kolom KOSONG yang diisi — struktur yang sudah ada di
// sumber tetap menang, karena bisa jadi hasil kurasi manual.
function enrichFromWinCode(items: SourceItem[], namePcpl: string): SourceItem[] {
    const winCode = (item: SourceItem) => item.kodeWin || item.kodePcpl || "";
    const targets = items.filter((item) => isWinCode(winCode(item)));
    if (!targets.length) return items;
    // Dibedah sekaligus satu batch: batas kata KLP/aroma hanya bisa disimpulkan lintas baris.
    const parsed = breakdownByCode(targets.map((item) => ({ kode: winCode(item), nama: item.namaBarang })), namePcpl);
    const byItem = new Map(targets.map((item, i) => [item, parsed[i]]));
    return items.map((item) => {
        const hit = byItem.get(item);
        if (!hit) return item;
        // Label struktur (klp/sub/sub2/aroma) = SATU PAKET. Menambal sebagian saja membuat dua
        // pembagian berbeda atas nama yang sama bercampur dan kata jadi dobel
        // ("KECAP MANIS" + aroma "MANIS PCH" -> "KECAP MANIS MANIS PCH").
        const adaLabel = [item.klp, item.subKlp, item.subKlp2, item.aroma].some((value) => clean(value));
        return {
            ...item,
            klp: adaLabel ? item.klp : hit.klp,
            subKlp: adaLabel ? item.subKlp : hit.subKlp,
            subKlp2: adaLabel ? item.subKlp2 : hit.subKlp2,
            aroma: adaLabel ? item.aroma : hit.aroma,
            gramasi: clean(item.gramasi) || hit.gramasi,
            isiCtn: clean(item.isiCtn) || hit.isiCtn,
            kemasan: clean(item.kemasan) || hit.kemasan,
            reviewNotes: hit.notes.length ? [...(item.reviewNotes ?? []), ...hit.notes] : item.reviewNotes,
        };
    });
}

export function codebookKey(level: CodebookLevel, scope: string, sourceName: string): string {
    return `${level}|${normalizeKey(scope)}|${normalizeKey(sourceName)}`;
}

// ---- Penyelaras item baru terhadap master yang sudah ada (deterministik, tanpa AI) ----
// Item input manual biasanya cuma bawa nama ("HARMONY SABUN MANDI BUAH 70 GR (NEW) - PEACH
// SAKURA"). Tanpa penyelaras, inferKlp jatuh ke kata kunci generik ("SABUN") dan struktur
// kode menyimpang dari 144 item MSM yang sudah benar. Penyelaras mencari "donor": item lama
// dengan batang nama sama (nama minus ekor aroma, gramasi, dan "(NEW)"), lalu mewarisi
// KLP/sub/kemasan/isi/format-gramasi donor; ekor " - X" menjadi aroma, disingkat memakai
// pasangan (ekor -> aroma) yang ditambang dari master itu sendiri.
const GRAM_RE = /(?:\b|X)(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L)\b/g;

function normGram(value: string): string {
    const match = upper(value).match(/(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L)\b/);
    if (!match) return "";
    const unit = match[2] === "G" ? "GR" : match[2] === "LTR" || match[2] === "LT" ? "L" : match[2];
    return `${Number(match[1].replace(",", "."))}${unit}`;
}

function stemOf(name: string): string {
    const head = upper(name).split(/\s+-\s+/)[0];
    return normalizeKey(head.replace(/\(NEW\)/g, " ").replace(GRAM_RE, " "));
}

function tailOf(name: string): string {
    const parts = upper(name).split(/\s+-\s+/);
    return parts.length > 1 ? normalizeKey(parts[parts.length - 1].replace(GRAM_RE, " ")) : "";
}

function alignSourceItems(items: SourceItem[]): SourceItem[] {
    const donors = new Map<string, SourceItem>();
    const abbrev = new Map<string, string>();
    for (const item of items) {
        if (!clean(item.klp) && !clean(item.kelompokPcpl)) continue;
        const stem = stemOf(item.namaBarang);
        if (stem && !donors.has(stem)) donors.set(stem, item);
        // Tambang singkatan kata dari pasangan sejajar: "STRAWBERRY ALPINE" vs "STRAW ALP".
        const tailWords = tailOf(item.namaBarang).split(" ").filter(Boolean);
        const aromaWords = normalizeKey(String(item.aroma ?? "")).split(" ").filter(Boolean);
        if (tailWords.length && tailWords.length === aromaWords.length) {
            tailWords.forEach((word, index) => {
                if (word.startsWith(aromaWords[index]) && !abbrev.has(word)) abbrev.set(word, aromaWords[index]);
            });
        }
    }
    if (!donors.size) return items;
    return items.map((item) => {
        if (clean(item.klp) || clean(item.kelompokPcpl)) return item;
        const donor = donors.get(stemOf(item.namaBarang));
        if (!donor) return item;
        const aligned: SourceItem = { ...item };
        aligned.kelompokPcpl = clean(donor.kelompokPcpl);
        aligned.klp = clean(item.klp) || clean(donor.klp);
        aligned.subKlp = clean(item.subKlp) || clean(donor.subKlp);
        aligned.subKlp2 = clean(item.subKlp2) || clean(donor.subKlp2);
        aligned.kemasan = clean(item.kemasan) || clean(donor.kemasan);
        aligned.satuan = clean(item.satuan) || clean(donor.satuan);
        aligned.isiCtn = clean(item.isiCtn) || clean(donor.isiCtn);
        // Format gramasi ikut donor bila nilainya sama ("70 GR" -> "70GR") agar kode dipakai ulang.
        const gram = normGram(inferGramasi(aligned));
        if (gram && gram === normGram(inferGramasi(donor))) aligned.gramasi = clean(donor.gramasi) || inferGramasi(donor);
        if (!clean(aligned.aroma)) {
            const tail = tailOf(item.namaBarang);
            // ponytail: kata ekor tak dikenal dibiarkan utuh (LEN50 review yang menangkap bila
            // kepanjangan); singkatan AI bisa menyusul kalau kamus tambang terbukti kurang.
            if (tail) aligned.aroma = tail.split(" ").map((word) => abbrev.get(word) ?? word).join(" ");
        }
        return aligned;
    });
}

function makeAssigner(seed: CodebookEntry[]) {
    const entries = new Map(seed.map((entry) => [entry.key, { ...entry, generated: false }]));
    return {
        get(level: CodebookLevel, scope: string, sourceName: string, width: number, explicitCode?: string) {
            const raw = upper(sourceName);
            const key = codebookKey(level, scope, raw);
            const current = entries.get(key);
            if (current) return current;
            const used = [...entries.values()].filter((entry) => entry.level === level && normalizeKey(entry.scope) === normalizeKey(scope));
            const max = used.reduce((value, entry) => Math.max(value, Number.parseInt(entry.code, 10) || 0), 0);
            const code = explicitCode || String(max + 1).padStart(width, "0");
            const created = { key, level, scope: upper(scope), sourceName: raw, name: raw, code, generated: true } satisfies CodebookEntry;
            entries.set(key, created);
            return created;
        },
        values: () => [...entries.values()].sort((a, b) => `${a.level}|${a.scope}|${a.code}`.localeCompare(`${b.level}|${b.scope}|${b.code}`)),
    };
}

function buildQc(rows: FormFixRow[], codebook: CodebookEntry[], source: SourceItem[]): MasterQc {
    const issues: QcIssue[] = [];
    const codeWidths: Record<CodebookLevel, number> = { klp: 2, sub_klp: 1, sub_klp2: 1, aroma: 2, gramasi: 4, kemasan: 1, promo: 1, sachet: 1, golongan: 1 };
    const codes = new Map<string, number[]>();
    rows.forEach((row) => {
        if (!row.namaBarangPrinciple) issues.push({ severity: "error", code: "NAME_REQUIRED", row: row.no, message: "Nama Barang Principle kosong." });
        if (row.len50 > NAMA_WIN_MAX) issues.push({ severity: "warning", code: "LEN50_REVIEW", row: row.no, message: `Nama Win ${row.len50} karakter (maks ${NAMA_WIN_MAX}); perlu review/override bulk.` });
        if (row.len15 !== 15) issues.push({ severity: "warning", code: "CODE_LENGTH", row: row.no, message: `Kode barang ${row.len15} digit; target struktur 15.` });
        if (row.confidence < 0.8) issues.push({ severity: "warning", code: "LOW_CONFIDENCE", row: row.no, message: "Hasil ekstraksi dokumen perlu review." });
        const same = codes.get(row.kodeBarangWin2) ?? [];
        same.push(row.no); codes.set(row.kodeBarangWin2, same);
    });
    for (const [code, rowNos] of codes) {
        if (code && rowNos.length > 1) issues.push({ severity: "error", code: "DUPLICATE_CODE", row: rowNos[0], message: `Kode ${code} dipakai baris ${rowNos.join(", ")}.` });
    }
    const cbCodes = new Map<string, string>();
    for (const entry of codebook) {
        const scoped = `${entry.level}|${normalizeKey(entry.scope)}|${entry.code}`;
        const previous = cbCodes.get(scoped);
        if (previous && previous !== entry.key) issues.push({ severity: "error", code: "CODEBOOK_COLLISION", message: `Kamus ${entry.level} scope ${entry.scope}: kode ${entry.code} ganda.` });
        cbCodes.set(scoped, entry.key);
        if (entry.code.length !== codeWidths[entry.level]) issues.push({ severity: "error", code: "CODEBOOK_WIDTH", message: `Kamus ${entry.level} scope ${entry.scope}: kode ${entry.code || "(kosong)"} harus ${codeWidths[entry.level]} digit.` });
    }
    source.forEach((item, index) => (item.reviewNotes ?? []).forEach((message) => issues.push({ severity: "warning", code: "SOURCE_REVIEW", row: index + 1, message })));
    // Deteksi item nama sama dengan gramasi mirip (beda <30%), mis. 850 vs 825 GR / 75 vs 68 GR.
    // Perubahan gramasi produk lama sering terjadi; minta konfirmasi supaya bukan duplikat tak sengaja.
    // Beda jauh (>=30%) dianggap SKU berbeda -> tidak diflag.
    const gramUnit = /(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LTR|LT|L)\b/;
    const gramValue = (value: string) => {
        const m = upper(value).match(gramUnit);
        if (!m) return null;
        const n = Number(m[1].replace(",", "."));
        if (!Number.isFinite(n) || n <= 0) return null;
        const u = m[2];
        if (u === "KG") return { n: n * 1000, fam: "W" };
        if (u === "L" || u === "LTR" || u === "LT") return { n: n * 1000, fam: "V" };
        if (u === "ML") return { n, fam: "V" };
        return { n, fam: "W" }; // GR / G
    };
    const baseName = (value: string) => upper(value).replace(new RegExp(gramUnit, "g"), " ").replace(/\s+/g, " ").trim();
    const gramGroups = new Map<string, Array<{ no: number; n: number; fam: string }>>();
    for (const row of rows) {
        const g = gramValue(String(row.namaGramasi ?? ""));
        const base = baseName(String(row.namaBarangPrinciple ?? ""));
        if (!g || !base) continue;
        const key = `${normalizeKey(String(row.namaKlp ?? ""))}|${normalizeKey(base)}`;
        const arr = gramGroups.get(key) ?? [];
        arr.push({ no: row.no, n: g.n, fam: g.fam });
        gramGroups.set(key, arr);
    }
    for (const arr of gramGroups.values()) {
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            if (a.fam !== b.fam || a.n === b.n) continue;
            const diff = Math.abs(a.n - b.n) / Math.max(a.n, b.n);
            if (diff > 0 && diff < 0.30) issues.push({ severity: "warning", code: "GRAMASI_NEAR_DUP", row: a.no, message: `Baris ${a.no} & ${b.no}: gramasi beda ${Math.round(diff * 100)}% (mirip); konfirmasi apakah ini perubahan gramasi produk yang sama.` });
        }
    }
    return {
        errors: issues.filter((issue) => issue.severity === "error").length,
        warnings: issues.filter((issue) => issue.severity === "warning").length,
        over50: issues.filter((issue) => issue.code === "LEN50_REVIEW").length,
        invalidCodeLength: issues.filter((issue) => issue.code === "CODE_LENGTH").length,
        lowConfidence: issues.filter((issue) => issue.code === "LOW_CONFIDENCE").length,
        duplicateCodes: issues.filter((issue) => issue.code === "DUPLICATE_CODE").length,
        gramasiNearDup: issues.filter((issue) => issue.code === "GRAMASI_NEAR_DUP").length,
        issues,
    };
}

export function generateMasterBarang(principleName: string, principleCode: string, incoming: SourceItem[], seedCodebook: CodebookEntry[] = []): GeneratedMaster {
    const namePcpl = upper(principleName);
    const codePcpl = upper(principleCode);
    if (!namePcpl) throw new Error("Nama Principle wajib diisi.");
    if (!/^[A-Z0-9]{2}$/.test(codePcpl)) throw new Error("Kode Principle Win wajib tepat 2 karakter huruf/angka.");
    const sourceItems = alignSourceItems(enrichFromWinCode(canonicalSource(incoming), namePcpl));
    const assigner = makeAssigner(seedCodebook);
    const formRows: FormFixRow[] = sourceItems.map((item, index) => {
        const klpSource = inferKlp(item);
        const klp = assigner.get("klp", namePcpl, klpSource, 2);
        const sub = assigner.get("sub_klp", klp.sourceName, upper(item.subKlp), 1, clean(item.subKlp) ? undefined : "0");
        const sub2 = assigner.get("sub_klp2", `${klp.sourceName}|${sub.sourceName}`, upper(item.subKlp2), 1, clean(item.subKlp2) ? undefined : "0");
        const aroma = assigner.get("aroma", `${klp.sourceName}|${sub.sourceName}|${sub2.sourceName}`, upper(item.aroma), 2, clean(item.aroma) ? undefined : "00");
        const gramasiSource = inferGramasi(item);
        const gramasi = assigner.get("gramasi", `${klp.sourceName}|${sub.sourceName}|${sub2.sourceName}|${aroma.sourceName}`, gramasiSource, 4, gramasiCode(gramasiSource));
        // Sesuai instruksi: nomor kemasan kontekstual per KLP, selalu mulai 1; bukan kamus global.
        const kemasan = assigner.get("kemasan", klp.sourceName, inferKemasan(item), 1);
        const promo = assigner.get("promo", klp.sourceName, upper(item.promo), 1, clean(item.promo) ? undefined : "0");
        const isSachet = /\b(SACHET|SCH)\b/.test(`${upper(item.sachet)} ${upper(item.namaBarang)}`);
        const sachet = isSachet
            ? assigner.get("sachet", klp.sourceName, "SACHET", 1, "1")
            : { name: "", code: "" };
        const golonganName = upper(item.golongan) || golonganFor(gramasi.name);
        const golongan = assigner.get("golongan", namePcpl, golonganName, 1);
        const revisionCode = "0";
        const kodeBarang = isSachet
            ? `${codePcpl}${klp.code}${sub.code}${sub2.code}${aroma.code}${gramasi.code}${kemasan.code}${sachet.code}`
            : `${codePcpl}${klp.code}${sub.code}${sub2.code}${aroma.code}${gramasi.code}${kemasan.code}${promo.code}${revisionCode}`;
        const isi = clean(item.isiCtn) || "1";
        const namaWin = [namePcpl, klp.name, sub.name, sub2.name, aroma.name, gramasi.name, "X", isi, sachet.name, kemasan.name, promo.name, upper(item.ketTambahan)]
            .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        return {
            no: index + 1,
            kodePcpl: upper(item.kodePcpl), kelompokPcpl: upper(item.kelompokPcpl), namaBarangPrinciple: upper(item.namaBarang),
            isiCtn: isi, ketTambahan: upper(item.ketTambahan), satuanFixWin: upper(item.satuan) || kemasan.name,
            namaKelompokWin: [klp.name, sub.name].filter(Boolean).join(" "), kodeKelompokWin: `${codePcpl}${klp.code}${sub.code}`,
            kodeBarangWin2: kodeBarang, len15: kodeBarang.length, namaWin, len50: namaWin.length,
            namaPcpl: namePcpl, kodePcplWin: codePcpl, namaKlp: klp.name, kodeKlp: klp.code,
            namaSubKlp: sub.name, kodeSubKlp: sub.code, namaSubKlp2: sub2.name, kodeSubKlp2: sub2.code,
            namaAroma: aroma.name, kodeAroma: aroma.code, namaGramasi: gramasi.name, kodeGramasi: gramasi.code,
            namaKemasan: kemasan.name, kodeKemasan: kemasan.code, namaPromo: promo.name, kodePromo: promo.code,
            namaSachet: sachet.name, kodeSachet: sachet.code, ketTambahan2: upper(item.ketTambahan),
            ketGolongan: golongan.name, kodeGolongan: golongan.code,
            sourceRow: item.sourceRow, sourcePage: item.sourcePage, confidence: Number(item.confidence ?? 1),
        };
    });
    const codebook = assigner.values();
    const qc = buildQc(formRows, codebook, sourceItems);
    const revisionHash = createHash("sha256").update(JSON.stringify({ principleName: namePcpl, principleCode: codePcpl, sourceItems, codebook, formRows })).digest("hex");
    return { sourceItems, codebook, formRows, qc, revisionHash };
}

export function runMasterBarangSelfCheck(): void {
    const result = generateMasterBarang("MSM", "M9", [
        { namaBarang: "Harmony Sabun Mandi 75 GR Bottle", isiCtn: 72, klp: "SABUN", kemasan: "BTL" },
        { namaBarang: "Harmony Sabun Mandi 100 GR Pouch", isiCtn: 48, klp: "SABUN", kemasan: "PCH" },
        { namaBarang: "Medicare Handwash 600 ML Bottle", isiCtn: 12, klp: "HANDWASH", kemasan: "BTL" },
    ]);
    const ok = (condition: boolean, message: string) => { if (!condition) throw new Error(`FAIL: ${message}`); };
    ok(result.formRows.length === 3, "semua item terbentuk");
    ok(result.formRows[0].kodeKemasan === "1" && result.formRows[1].kodeKemasan === "2", "kemasan satu KLP berurutan dari 1");
    ok(result.formRows[2].kodeKemasan === "1", "kemasan KLP baru reset ke 1");
    ok(result.formRows.every((row) => row.kodeSachet === ""), "kode sachet kosong untuk item non-sachet");
    const sachet = generateMasterBarang("MSM", "M9", [{ namaBarang: "Minuman Sachet 20 GR", isiCtn: 12, klp: "MINUMAN", kemasan: "SCH" }]);
    ok(sachet.formRows[0].kodeSachet === "1" && sachet.formRows[0].namaSachet === "SACHET", "kode sachet hanya untuk item sachet");
    const overflow = generateMasterBarang("MSM", "M9", Array.from({ length: 10 }, (_, index) => ({ namaBarang: `Item ${index + 1} 10 GR`, klp: "TES", kemasan: `K${index + 1}` })));
    ok(overflow.qc.issues.some((issue) => issue.code === "CODEBOOK_WIDTH"), "kapasitas kode 1 digit diblokir QC");
    ok(result.formRows.every((row) => row.kodePcplWin === "M9"), "kode principal konsisten");
    ok(principalSimilarity("PT MSM Indonesia", "MSM") > 0.9, "kemiripan principal terdeteksi");
    // namaWin = "MSM <klp> 10 GR X 1 PCS" -> panjang tetap 18 + panjang klp; dipakai untuk
    // menguji batas NAMA_WIN_MAX persis di 55/56, bukan sekadar pendek vs panjang.
    const lenRow = (klpChars: number) => generateMasterBarang("MSM", "M9", [{ namaBarang: "Item Tes 10 GR", klp: "A".repeat(klpChars), kemasan: "PCS", isiCtn: 1 }]).formRows[0];
    const atLimit = lenRow(NAMA_WIN_MAX - 18), overLimit = lenRow(NAMA_WIN_MAX - 17);
    ok(atLimit.len50 === NAMA_WIN_MAX, `panjang batas harus ${NAMA_WIN_MAX}, dapat ${atLimit.len50}`);
    ok(overLimit.len50 === NAMA_WIN_MAX + 1, `panjang lewat batas harus ${NAMA_WIN_MAX + 1}, dapat ${overLimit.len50}`);
    ok(!generateMasterBarang("MSM", "M9", [{ namaBarang: "Item Tes 10 GR", klp: "A".repeat(NAMA_WIN_MAX - 18), kemasan: "PCS", isiCtn: 1 }]).qc.issues.some((issue) => issue.code === "LEN50_REVIEW"), `nama tepat ${NAMA_WIN_MAX} karakter tidak diflag`);
    ok(generateMasterBarang("MSM", "M9", [{ namaBarang: "Item Tes 10 GR", klp: "A".repeat(NAMA_WIN_MAX - 17), kemasan: "PCS", isiCtn: 1 }]).qc.issues.some((issue) => issue.code === "LEN50_REVIEW"), `nama ${NAMA_WIN_MAX + 1} karakter diflag LEN50_REVIEW`);
    console.log("master-barang self-check OK");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) runMasterBarangSelfCheck();
