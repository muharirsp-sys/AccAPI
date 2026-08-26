/** Client-safe Excel helpers for target input — no server-only imports. */
import * as XLSX from "xlsx";

/** Buat template Excel untuk input target. */
export function generateTargetTemplate() {
    const wb = XLSX.utils.book_new();
    const templateData = [
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Channel", "SPV", "SM", "Target Value (Rp)", "Target EC", "Target AO", "Target IA", "SPLM Value", "Tipe Sales", "Status Insentif"],
        ["SLS-001", "Andi Pratama", "NESTLE", "BANDUNG", "GT", "Budi Santoso", "Hendra Wijaya", 250000000, 320, 180, 540, 142300000, "Exclusive", "Distributor+Principle"],
        ["SLS-002", "Siti Rahmawati", "NESTLE", "BANDUNG", "GT", "Budi Santoso", "Hendra Wijaya", 210000000, 280, 160, 480, 188400000, "Mix", "Distributor"],
        ["SLS-003", "Rudi Hartono", "UNILEVER", "CIMAHI", "GT", "Dewi Lestari", "Hendra Wijaya", 300000000, 360, 200, 600, 151900000, "Mix", "Principle"],
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

/**
 * Angka dari sel TEKS. Cell numerik tidak lewat sini; yang lewat adalah kolom yang di Excel
 * disimpan sebagai teks — dan di file Indonesia itu berarti "1.250.000". Versi lama membuang
 * semua kecuali [\d.-] lalu Number("1.250.000") = NaN = 0. Untuk support principle, 0 palsu
 * berarti pool insentif tidak terpotong dan orang dibayar lebih.
 *
 * Pemisah paling KANAN yang menentukan: diikuti tepat 3 digit dan (ada pemisah lain atau
 * pemisahnya titik) -> itu pemisah ribuan; selain itu -> desimal. "204,8" -> 204,8;
 * "1.250.000" -> 1250000; "1.250" -> 1250 (konvensi Indonesia).
 */
export function parseLocaleNumber(text: string): number {
    const cleaned = text.replace(/[^\d.,-]/g, "");
    if (!cleaned) return NaN;
    const last = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
    if (last === -1) return Number(cleaned);
    const sepCount = (cleaned.match(/[.,]/g) ?? []).length;
    const digitsAfter = cleaned.length - last - 1;
    const isThousands = digitsAfter === 3 && (sepCount > 1 || cleaned[last] === ".");
    if (isThousands) return Number(cleaned.replace(/[.,]/g, ""));
    return Number(cleaned.slice(0, last).replace(/[.,]/g, "") + "." + cleaned.slice(last + 1));
}

/**
 * Pembaca satu baris sheet. Header dicocokkan case/whitespace-insensitive, BUKAN string
 * persis — Excel bisa menyimpan versi terformat header (" Target EC ") yang berbeda dari
 * yang terlihat, dan pencocokan persis membuat SELURUH file diam-diam terbaca 0 (H5).
 */
function rowReader(row: Record<string, unknown>) {
    const norm = (k: string) => k.trim().toUpperCase();
    const byKey = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
    const raw = (name: string) => byKey.get(norm(name));
    return {
        str: (name: string, fallback = "") => {
            const v = raw(name);
            return v === undefined || v === null || v === "" ? fallback : String(v).trim();
        },
        num: (name: string) => {
            const v = raw(name);
            if (v === undefined || v === null || v === "") return 0;
            if (typeof v === "number") return Number.isFinite(v) ? v : 0;
            const n = parseLocaleNumber(String(v));
            return Number.isFinite(n) ? n : 0;
        },
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
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
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
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
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
            // TANPA default. "NESTLE"/"BANDUNG" adalah data DEMO (lihat PRINCIPLES/BRANCHES di
            // app/(dashboard)/insentif-sales/data.ts, ditandai "Master data dummy"). Sebagai
            // default, keduanya membuat baris pemisah/subtotal di Excel berubah jadi target
            // NESTLE hantu — menambah `n` pada grup mix salesman itu (konstanta 1,2jt → 1,4jt)
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
