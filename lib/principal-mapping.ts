/*
 * Tujuan: Baca sheet terjemahan principal (KINO.xlsx) menjadi baris `principal_mapping`.
 * Caller: app/api/principal-mapping/import, halaman Mapping Principal.
 * Dependensi: xlsx (sudah terpasang). Main Functions: readMappingSheet, parseMappingRows, KINDS.
 * Side Effects: Tidak ada — murni, tanpa DB dan tanpa jaringan.
 *
 * Judul kolom berkas Kino TIDAK stabil (laporan ad hoc, spasi menempel, huruf besar-kecil
 * berubah), jadi kolomnya dicari lewat sinonim yang dinormalkan, bukan lewat indeks tetap.
 * Baris yang tidak lengkap DILAPORKAN, tidak ditebak dan tidak didiamkan.
 */
import * as XLSX from "xlsx";

export type MappingKind = "item" | "customer" | "salesman" | "brand";

export type MappingRow = {
    kind: MappingKind;
    sourceCode: string;
    targetCode: string;
    unit: string | null;
    packSize: number | null;
};

export type ParseResult = { rows: MappingRow[]; issues: string[] };

/** Sinonim judul kolom per jenis. Urutan = prioritas pencarian. */
export const KINDS: Record<MappingKind, {
    label: string; sheet: string; source: string[]; target: string[]; unit?: string[]; pack?: string[];
}> = {
    item: {
        label: "Barang", sheet: "Mapping_Prd",
        source: ["kode alias", "kodealias", "prd id", "prdid", "kode principal", "kode pcpl"],
        target: ["kode item", "kodeitem", "kode barang", "kode internal"],
        unit: ["satuan", "satuan fix win"],
        pack: ["isi", "isi/ctn", "isictn"],
    },
    customer: {
        label: "Pelanggan", sheet: "Mapping_Customer",
        source: ["code kino", "kode kino", "cust id", "custid", "code principal"],
        target: ["code internal", "kode internal", "customer no", "customerno"],
    },
    salesman: {
        label: "Salesman", sheet: "Mapping_Sls",
        source: ["slsman id", "slsmanid", "sls id", "kode sales principal"],
        target: ["code internal", "kode internal", "kode sales"],
    },
    // Nama merek pada SURAT promo -> pola nama pada master barang. Surat memakai bahasa
    // pemasaran ("OVALE 2IN1 CLEANSER"), master memakai bahasa gudang ("OVALE FACIAL LOTION"),
    // dan tanpa catatan ini tiap surat berikutnya menanyakan hal yang sama.
    brand: {
        label: "Merek pada surat", sheet: "Mapping_Brand",
        source: ["merek surat", "nama merek", "brand surat", "brand"],
        target: ["nama master", "pola nama", "nama barang", "brand master"],
    },
};

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const text = (value: unknown) => String(value ?? "").trim();

/** Cari indeks kolom dari baris judul. -1 bila tidak satu pun sinonim cocok. */
export function columnOf(header: unknown[], names: string[]): number {
    const cleaned = header.map(norm);
    for (const name of names) {
        const wanted = norm(name);
        const exact = cleaned.indexOf(wanted);
        if (exact >= 0) return exact;
    }
    // Cocok sebagian hanya sebagai jalan terakhir, dan hanya bila tepat satu kolom yang cocok.
    for (const name of names) {
        const wanted = norm(name);
        const hits = cleaned.flatMap((value, index) => (value && value.includes(wanted) ? [index] : []));
        if (hits.length === 1) return hits[0];
    }
    return -1;
}

/** "1.234,5" dan "1234.5" sama-sama jadi 1234.5. Kosong/bukan angka -> null. */
export function packOf(raw: unknown): number | null {
    if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
    const clean = text(raw).replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const value = Number(clean);
    return clean !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Baris mentah (termasuk baris judul) -> baris mapping. Judul dicari, bukan diasumsikan.
 * Duplikat kode sumber dilaporkan: yang terakhir menang, tetapi diamnya berbahaya karena
 * satu kode barang bisa menunjuk dua item yang berbeda.
 */
export function parseMappingRows(kind: MappingKind, raw: unknown[][]): ParseResult {
    const spec = KINDS[kind];
    const issues: string[] = [];
    const headerAt = raw.findIndex((row) => Array.isArray(row) && columnOf(row, spec.source) >= 0 && columnOf(row, spec.target) >= 0);
    if (headerAt < 0) {
        return { rows: [], issues: [`Sheet ${spec.label}: tidak menemukan kolom "${spec.source[0]}" dan "${spec.target[0]}".`] };
    }
    const header = raw[headerAt];
    const at = {
        source: columnOf(header, spec.source),
        target: columnOf(header, spec.target),
        unit: spec.unit ? columnOf(header, spec.unit) : -1,
        pack: spec.pack ? columnOf(header, spec.pack) : -1,
    };
    if (kind === "item" && (at.unit < 0 || at.pack < 0)) {
        issues.push("Sheet Barang: kolom Satuan atau ISI tidak ada. Tanpa ISI, satuan baris tidak bisa dinaikkan ke KRT.");
    }

    const seen = new Map<string, number>();
    const rows: MappingRow[] = [];
    for (let index = headerAt + 1; index < raw.length; index += 1) {
        const row = raw[index] ?? [];
        const sourceCode = text(row[at.source]);
        const targetCode = text(row[at.target]);
        if (!sourceCode && !targetCode) continue;
        const label = `Baris ${index + 1}`;
        if (!sourceCode || !targetCode) {
            issues.push(`${label}: kode ${!sourceCode ? "principal" : "internal"} kosong; baris dilewati.`);
            continue;
        }
        const pack = at.pack >= 0 ? packOf(row[at.pack]) : null;
        if (kind === "item" && pack === null) {
            issues.push(`${label} (${sourceCode}): ISI per karton kosong atau bukan angka; baris dilewati.`);
            continue;
        }
        const previous = seen.get(sourceCode);
        if (previous !== undefined) {
            issues.push(`${label}: kode principal ${sourceCode} muncul lagi (sebelumnya baris ${previous}); yang terakhir dipakai.`);
            rows.splice(rows.findIndex((item) => item.sourceCode === sourceCode), 1);
        }
        seen.set(sourceCode, index + 1);
        rows.push({
            kind,
            sourceCode,
            targetCode,
            unit: at.unit >= 0 ? text(row[at.unit]).toUpperCase() || null : null,
            packSize: pack,
        });
    }
    if (rows.length === 0) issues.push(`Sheet ${spec.label}: tidak ada satu pun baris yang bisa dipakai.`);
    return { rows, issues };
}

/** Ambil satu jenis dari workbook. Nama sheet dicocokkan longgar supaya "Mapping_Prd (2)" tetap ketemu. */
export function readMappingSheet(book: XLSX.WorkBook, kind: MappingKind): ParseResult {
    const spec = KINDS[kind];
    const wanted = norm(spec.sheet);
    const name = book.SheetNames.find((sheet) => norm(sheet) === wanted)
        ?? book.SheetNames.find((sheet) => norm(sheet).startsWith(wanted));
    if (!name) return { rows: [], issues: [`Sheet ${spec.sheet} tidak ada di berkas ini.`] };
    const raw = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, blankrows: false, defval: "" });
    return parseMappingRows(kind, raw);
}
