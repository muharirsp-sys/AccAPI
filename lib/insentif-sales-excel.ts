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
    const norm = (k: string) => k.trim().toUpperCase();
    return data.map((row) => {
        const byKey = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
        const raw = (name: string) => byKey.get(norm(name));
        const str = (name: string, fallback = "") => {
            const v = raw(name);
            return v === undefined || v === null || v === "" ? fallback : String(v).trim();
        };
        const num = (name: string) => {
            const v = raw(name);
            if (v === undefined || v === null || v === "") return 0;
            const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
            return Number.isFinite(n) ? n : 0;
        };
        return {
            salesCode: str("Kode Salesman"),
            salesName: str("Nama Salesman"),
            principle: str("Principal", "NESTLE"),
            branch: str("Cabang", "BANDUNG"),
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
