/*
 * Tujuan: Adaptasi idempoten workbook Master Barang lama (Form Fix, Fix Mapping, dan tabel generik) ke model Master Barang AccAPI.
 * Caller: app/api/master-barang/route.ts action adapt_legacy dan script migrasi operasional.
 * Dependensi: xlsx, filesystem, domain engine, service persistence, dan Drizzle PostgreSQL.
 * Main Functions: parseLegacyWorkbook, adaptLegacyDirectory.
 * Side Effects: Membaca workbook/folder; adaptLegacyDirectory menulis source runtime dan DB melalui service.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { masterBarang } from "@/db/schema";
import { codebookKey, normalizePrincipleName, type CodebookEntry, type CodebookLevel, type SourceItem } from "@/lib/master-barang/engine";
import { appendSource, createMaster, getMasterDetail, updateCodebook } from "@/lib/master-barang/service";

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const upper = (value: unknown) => clean(value).toUpperCase();
const headerKey = (value: unknown) => upper(value).replace(/[^A-Z0-9]+/g, "");

type ParsedLegacy = {
    principleName: string;
    principleCode: string;
    items: SourceItem[];
    codebook: CodebookEntry[];
    sheetName: string;
    headerRow: number;
    warnings: string[];
};

function findHeader(matrix: unknown[][]) {
    let best: { row: number; score: number } | null = null;
    for (let row = 0; row < Math.min(matrix.length, 80); row++) {
        const keys = matrix[row].map(headerKey);
        const hasName = keys.some((key) => ["NAMABARANGPRINCIPLE", "NAMABARANG", "NAMAPRODUK", "PRODUK", "NAMAPADAPRINCIPLE", "PENULISANNAMABARANG", "NAMAWIN"].includes(key));
        if (!hasName) continue;
        const score = ["KODEPCPL", "ISICTN", "NAMAPCPL", "KODEBARANGWIN2", "NAMAKLP", "GRAMASI", "VARIANT"]
            .filter((needle) => keys.some((key) => key === needle || key.includes(needle))).length;
        if (!best || score > best.score) best = { row, score };
    }
    return best;
}

function targetTokens(value: string): Set<string> {
    const ignored = new Set(["FIX", "FORM", "MASTER", "BARANG", "NEW", "CONTOH", "ANGGA", "EDIT", "TO", "WIN", "SHEET"]);
    return new Set(upper(value).split(/[^A-Z0-9]+/).filter((token) => token.length > 1 && !/^\d+$/.test(token) && !ignored.has(token)));
}

function bestIndex(keys: string[], dataRows: unknown[][], aliases: string[]): number {
    const wanted = new Set(aliases.map(headerKey));
    const candidates = keys.map((key, index) => wanted.has(key) ? index : -1).filter((index) => index >= 0);
    if (!candidates.length) return -1;
    return candidates.sort((a, b) => {
        const countA = dataRows.slice(0, 1000).filter((row) => clean(row[a])).length;
        const countB = dataRows.slice(0, 1000).filter((row) => clean(row[b])).length;
        return countB - countA;
    })[0];
}

function indexOf(keys: string[], ...aliases: string[]): number {
    const normalized = aliases.map(headerKey);
    return keys.findIndex((key) => normalized.includes(key));
}

function nextTo(keys: string[], nameAliases: string[]): number {
    const nameIndex = indexOf(keys, ...nameAliases);
    return nameIndex >= 0 ? nameIndex + 1 : -1;
}

function valueAt(row: unknown[], index: number): string {
    return index >= 0 ? clean(row[index]) : "";
}

function addCodebook(target: Map<string, CodebookEntry>, level: CodebookLevel, scope: string, sourceName: string, name: string, code: string) {
    const normalizedName = upper(sourceName || name);
    if (!normalizedName && !code) return;
    const key = codebookKey(level, scope, normalizedName);
    if (!target.has(key)) target.set(key, { key, level, scope: upper(scope), sourceName: normalizedName, name: upper(name || sourceName), code: clean(code), generated: false });
}

function principleFromFile(fileName: string): string {
    return [...targetTokens(path.basename(fileName, path.extname(fileName)))].join(" ") || "PRINCIPLE LEGACY";
}

function parseFormB(matrix: unknown[][], headerRow: number, fileName: string, sheetName: string): ParsedLegacy {
    const headers = matrix[headerRow].map(headerKey);
    const find = (...aliases: string[]) => indexOf(headers, ...aliases);
    const nameIx = find("Nama Pada Principle"), principleIx = find("Principle", "Principle (2 Digit)"), klpIx = find("Nama Produk / Kategori/ KLP (2 digit)", "Nama Produk / Kategori (2 digit)"),
        subIx = find("Sub Kategori (1 Digit)"), aromaIx = find("Aroma / Rasa (2 Digit)"), gramasiIx = find("Gramasi (4 digit)"),
        kemasanIx = find("Kemasan (2 Digit)"), promoIx = find("Jenis Promo (1 Digit)"), isiUnitIx = find("Isi Per Krt (satuan kecil)");
    if (nameIx < 0 || principleIx < 0 || klpIx < 0) throw new Error("Struktur Form-B tidak lengkap.");
    let kodePcplIx = -1;
    for (let rowNo = headerRow + 1; rowNo < Math.min(matrix.length, headerRow + 5); rowNo++) {
        const label = matrix[rowNo].map(headerKey).findIndex((key) => key === "KODE");
        if (label >= 0) { kodePcplIx = label; break; }
    }
    const fallbackPrinciple = principleFromFile(fileName);
    const nameOf = (row: unknown[]) => {
        const direct = valueAt(row, nameIx);
        if (direct && !/^#(REF|VALUE|N\/A)!?$/i.test(direct)) return direct;
        return [10, 7, 33].map((index) => valueAt(row, index)).find((value) => value.length >= 5 && !/^#(REF|VALUE|N\/A)!?$/i.test(value)) || "";
    };
    const records = matrix.slice(headerRow + 1).map((row, offset) => ({ row, sourceRow: headerRow + offset + 2, principle: upper(valueAt(row, principleIx)) || fallbackPrinciple, name: nameOf(row) }))
        .filter((record) => record.name && record.principle && !/^(KODE|KELOMPOK BARANG|SATUAN)$/i.test(record.name));
    const grouped = new Map<string, typeof records>();
    for (const record of records) grouped.set(record.principle, [...(grouped.get(record.principle) ?? []), record]);
    const expected = new Set([...targetTokens(fileName), ...targetTokens(sheetName)]);
    const selectedGroup = [...grouped.entries()].sort((a, b) => {
        const score = (entry: [string, typeof records]) => [...targetTokens(entry[0])].filter((token) => expected.has(token)).length * 100000 + entry[1].length;
        return score(b) - score(a);
    })[0];
    if (!selectedGroup) throw new Error("Tidak ada item Form-B yang terbaca.");
    const [principleName, selected] = selectedGroup;
    const items: SourceItem[] = [];
    const codebook = new Map<string, CodebookEntry>();
    for (const { row, sourceRow } of selected) {
        const klp = upper(valueAt(row, klpIx)), sub = upper(valueAt(row, subIx)), sub2 = "", aroma = upper(valueAt(row, aromaIx));
        const item: SourceItem = {
            sourceRow, kodePcpl: valueAt(row, kodePcplIx), namaBarang: nameOf(row), isiCtn: valueAt(row, isiUnitIx + 1),
            satuan: valueAt(row, isiUnitIx), klp, subKlp: sub, subKlp2: sub2, aroma, gramasi: valueAt(row, gramasiIx),
            kemasan: valueAt(row, kemasanIx), promo: valueAt(row, promoIx), confidence: 1,
        };
        items.push(item);
        addCodebook(codebook, "klp", principleName, klp, klp, valueAt(row, klpIx + 1));
        addCodebook(codebook, "sub_klp", klp, sub, sub, valueAt(row, subIx + 1));
        addCodebook(codebook, "sub_klp2", `${klp}|${sub}`, sub2, sub2, "0");
        addCodebook(codebook, "aroma", `${klp}|${sub}|${sub2}`, aroma, aroma, valueAt(row, aromaIx + 1));
        addCodebook(codebook, "gramasi", `${klp}|${sub}|${sub2}|${aroma}`, upper(item.gramasi), upper(item.gramasi), valueAt(row, gramasiIx + 1));
        // Kemasan sengaja tidak mengambil kode legacy 00/01: engine baru menomori ulang dari 1 per KLP.
        addCodebook(codebook, "promo", klp, upper(item.promo), upper(item.promo), valueAt(row, promoIx + 1));
    }
    return { principleName, principleCode: "", items, codebook: [...codebook.values()], sheetName, headerRow: headerRow + 1, warnings: ["Format Form-B diadaptasi; kode kemasan dinomori ulang dari 1 per KLP.", ...(selected.some((record) => !valueAt(record.row, nameIx)) ? ["Sebagian Nama Pada Principle kosong; adaptor memakai nama legacy dan menandainya untuk review."] : [])] };
}

export function parseLegacyWorkbook(bytes: Buffer, fileName: string): ParsedLegacy {
    const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, cellFormula: true });
    let selected: { sheetName: string; matrix: unknown[][]; header: { row: number; score: number }; rank: number } | null = null;
    const expected = targetTokens(fileName);
    const priority = ["Form Fix", "Fix Mapping", ...workbook.SheetNames];
    for (const sheetName of [...new Set(priority)]) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false, blankrows: false });
        const header = findHeader(matrix);
        const sheetMatch = [...targetTokens(sheetName)].filter((token) => [...expected].some((wanted) => token === wanted || (Math.min(token.length, wanted.length) >= 3 && (token.includes(wanted) || wanted.includes(token))))).length;
        let dataPrincipleMatch = 0;
        if (header) {
            const headerKeys = matrix[header.row].map(headerKey);
            const principleIndex = indexOf(headerKeys, "Principle", "Principle (2 Digit)");
            if (principleIndex >= 0) {
                dataPrincipleMatch = matrix.slice(header.row + 1).filter((row) => [...targetTokens(valueAt(row, principleIndex))].some((token) => [...expected].some((wanted) => token === wanted || token.includes(wanted) || wanted.includes(token)))).length;
            }
        }
        const rank = (sheetName === "Form Fix" ? 1_000_000 : 0) + dataPrincipleMatch * 100_000 + sheetMatch * 10_000 + (header?.score ?? 0);
        if (header && (!selected || rank > selected.rank)) selected = { sheetName, matrix, header, rank };
        if (selected?.sheetName === "Form Fix" && selected.header.score >= 4) break;
    }
    if (!selected) throw new Error("Header item tidak ditemukan pada workbook.");
    const headers = selected.matrix[selected.header.row].map(headerKey);
    if (headers.includes("NAMAPADAPRINCIPLE")) return parseFormB(selected.matrix, selected.header.row, fileName, selected.sheetName);
    const dataRows = selected.matrix.slice(selected.header.row + 1);
    const ix = {
        no: indexOf(headers, "NO"), kodePcpl: indexOf(headers, "Kode Pcpl", "Kode Principle", "Item Code", "Kode Barang"),
        kelompokPcpl: indexOf(headers, "Klp Brg Pcpl", "Kelompok Pcpl", "Kategori"),
        nama: bestIndex(headers, dataRows, ["Nama Barang Principle", "Nama Barang", "Nama Produk", "Produk", "Nama Win"]),
        isi: indexOf(headers, "ISI/CTN", "Isi Ctn", "Isi/Karton", "Isi Karton"), ket: indexOf(headers, "Ket. Tambahan / Pembantu", "Keterangan"),
        satuan: indexOf(headers, "SATUAN Fix Win", "Satuan"), namaPcpl: indexOf(headers, "Nama Pcpl", "Nama Principle", "Principle"),
        kodePcplWin: nextTo(headers, ["Nama Pcpl", "Nama Principle"]), klp: indexOf(headers, "Nama KLP", "KLP", "Kelompok"),
        kodeKlp: nextTo(headers, ["Nama KLP"]), sub: indexOf(headers, "Nama Sub KLP", "Sub KLP", "Sub Kategori"),
        kodeSub: nextTo(headers, ["Nama Sub KLP"]), sub2: indexOf(headers, "Nama Sub KLP2", "Sub KLP2"),
        kodeSub2: nextTo(headers, ["Nama Sub KLP2"]), aroma: indexOf(headers, "Nama Aroma/Rasa", "Aroma/Rasa", "Variant", "Varian"),
        kodeAroma: nextTo(headers, ["Nama Aroma/Rasa"]), gramasi: indexOf(headers, "Nama Gramasi atau Jumlah Pack per CTN", "Gramasi"),
        kodeGramasi: nextTo(headers, ["Nama Gramasi atau Jumlah Pack per CTN"]), kemasan: indexOf(headers, "Nama Jenis Kemasan", "Kemasan"),
        kodeKemasan: nextTo(headers, ["Nama Jenis Kemasan"]), promo: indexOf(headers, "Nama Promo", "Promo"), kodePromo: nextTo(headers, ["Nama Promo"]),
        sachet: indexOf(headers, "Gunakan ini apabila item tersebut sachet", "Sachet"), kodeSachet: nextTo(headers, ["Gunakan ini apabila item tersebut sachet"]),
        golongan: indexOf(headers, "KET. GOLONGAN", "Golongan"), kodeGolongan: nextTo(headers, ["KET. GOLONGAN"]),
    };
    const rows = selected.matrix.slice(selected.header.row + 1);
    const items: SourceItem[] = [];
    const codebook = new Map<string, CodebookEntry>();
    let principleName = "", principleCode = "";
    for (let offset = 0; offset < rows.length; offset++) {
        const row = rows[offset];
        const nama = valueAt(row, ix.nama);
        if (!nama || nama.startsWith("=")) continue;
        const item: SourceItem = {
            sourceRow: selected.header.row + offset + 2, kodePcpl: valueAt(row, ix.kodePcpl), kelompokPcpl: valueAt(row, ix.kelompokPcpl),
            namaBarang: nama, isiCtn: valueAt(row, ix.isi), ketTambahan: valueAt(row, ix.ket), satuan: valueAt(row, ix.satuan),
            klp: valueAt(row, ix.klp), subKlp: valueAt(row, ix.sub), subKlp2: valueAt(row, ix.sub2), aroma: valueAt(row, ix.aroma),
            gramasi: valueAt(row, ix.gramasi), kemasan: valueAt(row, ix.kemasan), promo: valueAt(row, ix.promo), sachet: valueAt(row, ix.sachet),
            golongan: valueAt(row, ix.golongan), confidence: 1,
        };
        items.push(item);
        principleName ||= upper(valueAt(row, ix.namaPcpl));
        const candidateCode = upper(valueAt(row, ix.kodePcplWin));
        if (/^[A-Z0-9]{2}$/.test(candidateCode)) principleCode ||= candidateCode;
        const pcplScope = principleName || principleFromFile(fileName);
        const klp = upper(item.klp || item.kelompokPcpl), sub = upper(item.subKlp), sub2 = upper(item.subKlp2), aroma = upper(item.aroma);
        addCodebook(codebook, "klp", pcplScope, klp, klp, valueAt(row, ix.kodeKlp));
        addCodebook(codebook, "sub_klp", klp, sub, sub, valueAt(row, ix.kodeSub));
        addCodebook(codebook, "sub_klp2", `${klp}|${sub}`, sub2, sub2, valueAt(row, ix.kodeSub2));
        addCodebook(codebook, "aroma", `${klp}|${sub}|${sub2}`, aroma, aroma, valueAt(row, ix.kodeAroma));
        addCodebook(codebook, "gramasi", `${klp}|${sub}|${sub2}|${aroma}`, upper(item.gramasi), upper(item.gramasi), valueAt(row, ix.kodeGramasi));
        // Kode kemasan legacy tidak dipertahankan: engine baru wajib reset dari 1 per KLP.
        addCodebook(codebook, "promo", klp, upper(item.promo), upper(item.promo), valueAt(row, ix.kodePromo));
        addCodebook(codebook, "sachet", klp, upper(item.sachet), upper(item.sachet), valueAt(row, ix.kodeSachet));
        addCodebook(codebook, "golongan", pcplScope, upper(item.golongan), upper(item.golongan), valueAt(row, ix.kodeGolongan));
    }
    if (!items.length) throw new Error(`Tidak ada item terbaca dari sheet ${selected.sheetName}.`);
    principleName ||= principleFromFile(fileName);
    return { principleName, principleCode, items, codebook: [...codebook.values()].filter((entry) => entry.name || entry.code), sheetName: selected.sheetName, headerRow: selected.header.row + 1, warnings: principleCode ? [] : ["Kode principal Win tidak ditemukan; AccAPI akan membuat kode otomatis."] };
}

export async function adaptLegacyDirectory(directory: string, actorId: string) {
    const root = path.resolve(/*turbopackIgnore: true*/ directory);
    const entries = (await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && /\.(xlsx|xls)$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    const report: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
        const filePath = path.resolve(/*turbopackIgnore: true*/ root, entry.name);
        if (!filePath.startsWith(`${root}${path.sep}`)) continue;
        try {
            const bytes = await readFile(/*turbopackIgnore: true*/ filePath);
            const parsed = parseLegacyWorkbook(bytes, entry.name);
            const norm = normalizePrincipleName(parsed.principleName);
            const [existing] = await db.select({ id: masterBarang.id }).from(masterBarang).where(eq(masterBarang.principleNameNorm, norm)).limit(1);
            const master = existing ? await getMasterDetail(existing.id) : await createMaster({ principleName: parsed.principleName, principleCode: parsed.principleCode || undefined, legacyFileName: entry.name }, actorId, true);
            if (!master) throw new Error("Gagal membuat/memuat master hasil adaptasi.");
            let detail;
            try {
                detail = await appendSource({ masterId: master.id, fileName: entry.name, mimeType: "application/vnd.ms-excel", bytes, sourceKind: "legacy_xlsx", extractedItems: parsed.items, extraction: { adapter: "legacy", sheetName: parsed.sheetName, headerRow: parsed.headerRow, warnings: parsed.warnings } }, actorId);
            } catch (error) {
                if (/sudah pernah diupload/i.test(String(error))) {
                    report.push({ file: entry.name, status: "unchanged", masterId: master.id, items: parsed.items.length });
                    continue;
                }
                throw error;
            }
            const merged = new Map((detail?.codebook ?? []).map((item) => [item.key, item]));
            for (const seed of parsed.codebook) {
                const current = merged.get(seed.key);
                if (!current || current.generated) merged.set(seed.key, seed);
            }
            await updateCodebook(master.id, [...merged.values()], actorId);
            report.push({ file: entry.name, status: "adapted", masterId: master.id, principle: parsed.principleName, items: parsed.items.length, sheet: parsed.sheetName, warnings: parsed.warnings });
        } catch (error) {
            report.push({ file: entry.name, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { directory: root, total: report.length, adapted: report.filter((item) => item.status === "adapted").length, unchanged: report.filter((item) => item.status === "unchanged").length, failed: report.filter((item) => item.status === "failed").length, files: report };
}
