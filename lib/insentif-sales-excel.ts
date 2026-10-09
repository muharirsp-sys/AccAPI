/** Client-safe Excel helpers for target input — no server-only imports. */
import * as XLSX from "xlsx";

/** Buat template Excel untuk input target. */
export function generateTargetTemplate() {
    const wb = XLSX.utils.book_new();
    const templateData = [
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Channel", "SPV", "SM", "Target Value (Rp)", "Target EC", "Target AO", "Target IA", "SPLM Value", "Tipe Sales", "Status Insentif"],
        // Contoh generik (bukan principal/cabang/orang sungguhan): ganti atau hapus sebelum diunggah.
        ["SLS-001", "SALES A", "PRINCIPLE A", "CABANG A", "GT", "SPV A", "SM A", 250000000, 320, 180, 540, 142300000, "Exclusive", "Distributor+Principle"],
        ["SLS-002", "SALES B", "PRINCIPLE A", "CABANG A", "GT", "SPV A", "SM A", 210000000, 280, 160, 480, 188400000, "Mix", "Distributor"],
        ["SLS-003", "SALES C", "PRINCIPLE B", "CABANG B", "GT", "SPV B", "SM A", 300000000, 360, 200, 600, 151900000, "Mix", "Principle"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(templateData);
    ws["!cols"] = [
        { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 8 },
        { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 },
        { wch: 12 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Target");
    return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

/*
 * SATU aturan angka sel untuk target, support, dan progres (S6-0c, owner 9 Okt) — cermin parse_number_strict Python
 * (python_backend/shared.py, AM-044/D.22). Angka uang yang salah baca = nominal insentif salah, jadi teks yang tidak
 * persis berbentuk angka rupiah DITOLAK (NaN), bukan ditebak:
 *   - kosong / spasi / "-" (tanda nol akuntansi) = 0; sel numerik Excel dipakai apa adanya (nol berformat akuntansi = 0);
 *   - amplop: minus ASCII, prefix Rp/Rp./IDR, digit ASCII, pemisah . , spasi, sufiks ",-" — "(500)", "−5" (minus Unicode),
 *     "5 juta", "12abc", "1e5" ditolak (dulu masing-masing jadi 500, 5, 5, 12, 15);
 *   - pemisah ribuan hanya bila kepala kelompoknya 1-3 digit tanpa nol depan ("1.250.000", "1,250"); pemisah tunggal lain =
 *     desimal ("204,8", "0,125", "533000000,50", "250000000.000"); dua jenis pemisah = yang terakhir desimal;
 *   - sel galat Excel (#DIV/0!, #N/A) di kolom angka = NaN (lihat tandaiGalat), bukan 0.
 */
/** Batas panjang teks angka, sama dengan _STRICT_MAX_LEN Python: pagar backtracking regex dan teks catatan. */
const ANGKA_MAKS = 40;
const AMPLOP = /^-?\s*(?:rp\.?|idr)?\s*-?\s*[0-9][0-9.,\s]*(?:,-)?$/i;
const RIBUAN: Record<"." | ",", RegExp> = { ".": /^[1-9]\d{0,2}(?:\.\d{3})+$/, ",": /^[1-9]\d{0,2}(?:,\d{3})+$/ };
/** Penanda sel galat Excel. SheetJS menjadikan sel galat `undefined` (= kosong = 0); tandaiGalat menggantinya dengan teks ini. */
export const GALAT_EXCEL = "#GALAT_EXCEL";

/** Badan angka tanpa tanda/prefix (hanya digit . ,) → nilai, atau NaN bila pengelompokannya tidak sah. */
function intiAngka(b: string): number {
    if (/^\d+$/.test(b)) return Number(b);
    const titik = b.includes("."), koma = b.includes(",");
    if (titik && koma) {
        const des = b.lastIndexOf(",") > b.lastIndexOf(".") ? "," : ".";
        const grup = des === "," ? "." : ",";
        const i = b.lastIndexOf(des);
        const bulat = b.slice(0, i), pecahan = b.slice(i + 1);
        if (!/^\d+$/.test(pecahan) || !(/^\d+$/.test(bulat) || RIBUAN[grup].test(bulat))) return NaN;
        return Number(`${bulat.split(grup).join("")}.${pecahan}`);
    }
    const sep = titik ? "." : ",";
    if (RIBUAN[sep].test(b)) return Number(b.split(sep).join(""));
    const bagian = b.split(sep);
    return bagian.length === 2 && /^\d+$/.test(bagian[0]) && /^\d+$/.test(bagian[1]) ? Number(`${bagian[0]}.${bagian[1]}`) : NaN;
}

/** Angka dari teks sel menurut aturan di atas; NaN = bukan angka (pemanggil wajib menolak, bukan menjadikannya 0). */
export function parseLocaleNumber(text: string): number {
    const t = text.trim();
    if (t === "" || t === "-") return 0;
    if (t.length > ANGKA_MAKS || !AMPLOP.test(t) || (t.replace(/,-$/, "").match(/-/g) ?? []).length > 1) return NaN;
    let b = t.replace(/(rp|idr)\.?/gi, "").replace(/[^0-9.,-]/g, "").replace(/[,.]-+$/, "");
    const negatif = b.startsWith("-");
    if (negatif) b = b.slice(1);
    if (b.includes("-")) return NaN;
    const v = intiAngka(b);
    return negatif ? -v : v;
}

/** Nilai mentah sel (sheet_to_json raw) → angka: number apa adanya, teks lewat parseLocaleNumber, selain itu (bool, Date, galat) NaN. */
export function angkaSel(v: unknown): number {
    if (v === undefined || v === null) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    return typeof v === "string" ? parseLocaleNumber(v) : NaN;
}

/** Judul kolom dicocokkan seperti pembaca baris: spasi tepi dan huruf besar/kecil diabaikan. */
const normKolom = (k: string) => k.trim().toUpperCase();

/**
 * Ganti sel galat Excel (t === "e": #DIV/0!, #N/A, #REF!) di KOLOM ANGKA yang dibaca dengan GALAT_EXCEL sebelum sheet_to_json —
 * tanpa ini galat rumus di kolom angka terbaca kosong = 0. Hanya kolom berjudul `kolomAngka` (baris pertama lembar) yang
 * dipindai: berkas closing nyata ±4,9 juta sel, memindai seluruh lembar ±15 detik (peninjau A, S6-0c). Kolom teks tidak
 * disentuh, jadi galat di sana tetap terbaca kosong (perilaku lama).
 */
export function tandaiGalat(sheet: XLSX.WorkSheet, kolomAngka: readonly string[]): XLSX.WorkSheet {
    if (!sheet["!ref"]) return sheet;
    const r = XLSX.utils.decode_range(sheet["!ref"]);
    const dicari = new Set(kolomAngka.map(normKolom));
    for (let c = r.s.c; c <= r.e.c; c++) {
        const judul = sheet[XLSX.utils.encode_cell({ r: r.s.r, c })] as XLSX.CellObject | undefined;
        if (!judul || !dicari.has(normKolom(String(judul.v ?? "")))) continue;
        const kolom = XLSX.utils.encode_col(c);
        for (let b = r.s.r + 1; b <= r.e.r; b++) {
            const alamat = kolom + XLSX.utils.encode_row(b);
            if ((sheet[alamat] as XLSX.CellObject | undefined)?.t === "e") sheet[alamat] = { t: "s", v: GALAT_EXCEL };
        }
    }
    return sheet;
}

/**
 * Pembaca satu baris sheet. Header dicocokkan case/whitespace-insensitive, BUKAN string
 * persis — Excel bisa menyimpan versi terformat header (" Target EC ") yang berbeda dari
 * yang terlihat, dan pencocokan persis membuat SELURUH file diam-diam terbaca 0 (H5).
 */
function rowReader(row: Record<string, unknown>) {
    const byKey = new Map(Object.entries(row).map(([k, v]) => [normKolom(k), v]));
    const raw = (name: string) => byKey.get(normKolom(name));
    return {
        str: (name: string, fallback = "") => {
            const v = raw(name);
            return v === undefined || v === null || v === "" ? fallback : String(v).trim();
        },
        // Kosong dan "-" = 0; terisi tapi bukan angka (termasuk sel galat) = NaN, BUKAN 0 (AM-017): pemanggil wajib menolaknya —
        // 0 palsu pada support/target = bayar lebih. Aturannya = angkaSel (sama dengan progres dan Python).
        num: (name: string) => angkaSel(raw(name)),
    };
}

/** Support principle: per salesman (kunci kode sales) atau per SPV (kunci nama SPV). */
export type SupportKind = "sales" | "spv";

const SUPPORT_KEY_HEADER: Record<SupportKind, string> = {
    sales: "Kode Salesman",
    spv: "Nama SPV",
};

export interface SupportTemplateRow {
    /** Kode salesman (kind "sales") atau nama SPV (kind "spv"). */
    key: string;
    /** Hanya untuk pembaca manusia; tidak dibaca balik saat parse. */
    label?: string;
    principle: string;
    supportAmount: number;
}

/**
 * Template support SUDAH TERISI pasangan yang ada di periode itu — Finance tinggal mengetik
 * nominalnya. Template kosong akan memaksa mereka mengetik ulang ratusan kode sales, dan
 * satu typo berarti support jatuh ke baris yang tidak ada.
 */
export function generateSupportTemplate(kind: SupportKind, rows: SupportTemplateRow[]) {
    const keyHeader = SUPPORT_KEY_HEADER[kind];
    const header = [keyHeader, "Nama", "Principal", "Support (Rp)"];
    const body = rows.map((r) => [r.key, r.label ?? "", r.principle, r.supportAmount]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    ws["!cols"] = [{ wch: 18 }, { wch: 28 }, { wch: 32 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === "sales" ? "Support Sales" : "Support SPV");
    return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

export interface ParsedSupportRow {
    key: string;
    principle: string;
    supportAmount: number;
}

/**
 * Parse file support. Baris tanpa kunci/principal dibuang di sini; nominal negatif atau
 * bukan angka DILEWATKAN apa adanya ke pemanggil supaya bisa dilaporkan — bukan diam-diam
 * dijadikan 0, karena support memotong pool insentif dan 0 palsu = orang dibayar lebih.
 */
export function parseSupportExcel(arrayBuffer: ArrayBuffer, kind: SupportKind): ParsedSupportRow[] {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const sheet = tandaiGalat(workbook.Sheets[workbook.SheetNames[0]], ["Support (Rp)"]);
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    const keyHeader = SUPPORT_KEY_HEADER[kind];
    const out: ParsedSupportRow[] = [];
    for (const row of data) {
        const { str, num } = rowReader(row);
        const key = str(keyHeader);
        const principle = str("Principal");
        if (!key || !principle) continue;
        out.push({ key, principle, supportAmount: num("Support (Rp)") });
    }
    return out;
}

/** Parse Excel file untuk target input. */
export function parseTargetExcel(arrayBuffer: ArrayBuffer): Array<Record<string, unknown>> {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const sheet = tandaiGalat(workbook.Sheets[workbook.SheetNames[0]], ["Target Value (Rp)", "Target EC", "Target AO", "Target IA", "SPLM Value"]);
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    // Header dicocokkan case/whitespace-insensitive, BUKAN string persis. Excel bisa menyimpan
    // representasi "terformat" (w) yang berbeda dari nilai mentah (v) pada cell header —
    // misalnya berspasi di awal/akhir kalau kolom itu pernah diberi format angka — sehingga
    // SheetJS membaca kunci objek berbeda dari teks yang terlihat di Excel. String persis
    // (row["Target EC"]) gagal cocok pada kunci " Target EC " dan diam-diam jatuh ke default 0
    // untuk SELURUH file (nyata terjadi 2026-08-24, lihat AUDIT_INSENTIF_SALES_2026-08-24.md H5).
    return data.map((row) => {
        const { str, num } = rowReader(row);
        return {
            salesCode: str("Kode Salesman"),
            salesName: str("Nama Salesman"),
            // TANPA default. Default principal/cabang demo (dulu "NESTLE"/"BANDUNG") membuat baris
            // pemisah/subtotal di Excel berubah jadi target
            // principal hantu — menambah `n` pada grup mix salesman itu (konstanta 1,2jt → 1,4jt)
            // dan memunculkan baris penerima yang bisa ditandai Lunas. Kosong ditolak validator.
            principle: str("Principal"),
            branch: str("Cabang"),
            // Channel tetap punya default: "TT" sama dengan default kolom di db/schema.ts,
            // jadi ini bukan nilai karangan melainkan perilaku yang memang sudah didefinisikan.
            channel: str("Channel", "TT"),
            spvName: str("SPV"),
            smName: str("SM"),
            targetValue: num("Target Value (Rp)"),
            targetEc: num("Target EC"),
            targetAo: num("Target AO"),
            targetIa: num("Target IA"),
            splmValue: num("SPLM Value"),
            tipeSales: str("Tipe Sales", "Exclusive"),
            statusInsentif: str("Status Insentif", "Distributor+Principle"),
        };
    });
}
