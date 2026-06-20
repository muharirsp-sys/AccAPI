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

    return data.map((row) => ({
        salesCode: String(row["Kode Salesman"] || "").trim(),
        salesName: String(row["Nama Salesman"] || "").trim(),
        principle: String(row["Principal"] || "NESTLE").trim(),
        branch: String(row["Cabang"] || "BANDUNG").trim(),
        channel: String(row["Channel"] || "TT").trim(),
        spvName: String(row["SPV"] || "").trim(),
        smName: String(row["SM"] || "").trim(),
        targetValue: Number(row["Target Value (Rp)"] || 0),
        targetEc: Number(row["Target EC"] || 0),
        targetAo: Number(row["Target AO"] || 0),
        targetIa: Number(row["Target IA"] || 0),
        splmValue: Number(row["SPLM Value"] || 0),
        tipeSales: String(row["Tipe Sales"] || "Exclusive").trim(),
        statusInsentif: String(row["Status Insentif"] || "Distributor+Principle").trim(),
    }));
}
