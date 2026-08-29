/*
 * Tujuan: Uji regresi parser export Accurate terhadap kebenaran yang SUDAH diketahui —
 *         131 nota HEINZ ABC tanggal 21 Agu 2026 di sheet `Paste Data Sore` workbook.
 *         Kalau parser rusak, uji ini yang jatuh, bukan gudang yang salah ambil barang.
 * Caller: npm run test:rekapan
 * Dependensi: dua file sumber di Downloads (lihat konstanta di bawah). Kalau tidak ada,
 *             uji ini SKIP dengan pesan jelas — bukan lulus diam-diam.
 * Side Effects: Tidak ada. Baca file, tanpa DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { excelDateToIso } from "@/lib/excel-date";
import { parseAccurateExport, deriveKonvTersirat, normalizeHeader } from "@/lib/rekapan-nota/parse";

const EXPORT_XLSX = process.env.REKAPAN_EXPORT_XLSX
    || "C:\\Users\\Muhar\\Downloads\\rincian_faktur_penjualan_cvsuryaperkasa_260822125905.xlsx";
const WORKBOOK_XLSX = process.env.REKAPAN_WORKBOOK_XLSX
    || "C:\\Users\\Muhar\\Downloads\\A_New Rekapan Nota 24 AGUST 2026 update.xlsx";
const TANGGAL = "2026-08-21";
const PRINCIPAL = "HEINZ ABC";

test("normalizeHeader menyamakan spasi ganda & kapitalisasi", () => {
    assert.equal(normalizeHeader("  KODE  PELANGGAN   INDUK "), "KODE PELANGGAN INDUK");
    assert.equal(normalizeHeader("Jenis Produk"), "JENIS PRODUK");
});

test("deriveKonvTersirat hanya percaya rasio bulat", () => {
    assert.equal(deriveKonvTersirat(3, 144, "CTN", "PCS"), 48);
    assert.equal(deriveKonvTersirat(3, 3, "PCS", "PCS"), null, "satuan sama: rasio tak bermakna");
    assert.equal(deriveKonvTersirat(2, 25, "CTN", "PCS"), null, "rasio pecahan: data kotor, bukan kemasan baru");
    assert.equal(deriveKonvTersirat(0, 10, "CTN", "PCS"), null);
});

/** Baca `Paste Data Sore` jadi peta (no_nota|kode_barang) -> total pcs, untuk principal & tanggal ini. */
function bacaPasteDataSore(): { nota: Set<string>; baris: Map<string, number> } {
    const wb = XLSX.readFile(WORKBOOK_XLSX, { cellDates: true, cellStyles: false, cellHTML: false });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Paste Data Sore"], {
        header: 1, raw: true, blankrows: false,
    });
    const head = rows[0].map(normalizeHeader);
    const at = (n: string) => head.indexOf(n);
    const iNota = at("NO_NOTA"), iTgl = at("TANGGAL"), iBrg = at("KODE_BARANG");
    const iJp = at("JENISPRODUK"), iPcs = at("FIX QTY_SATUAN KECIL");

    const nota = new Set<string>();
    const baris = new Map<string, number>();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const no = String(row[iNota] ?? "").trim();
        if (!no) continue;
        if (String(row[iJp] ?? "").trim().toUpperCase() !== PRINCIPAL) continue;
        if (excelDateToIso(row[iTgl]) !== TANGGAL) continue;
        const key = `${no} ${String(row[iBrg] ?? "").trim()}`;
        nota.add(no);
        baris.set(key, (baris.get(key) ?? 0) + Number(row[iPcs] ?? 0));
    }
    return { nota, baris };
}

test("export Accurate mereproduksi Paste Data Sore: 131 nota, 776 baris, nol selisih", (t) => {
    if (!existsSync(EXPORT_XLSX) || !existsSync(WORKBOOK_XLSX)) {
        t.skip(`File sumber tidak ada. Set REKAPAN_EXPORT_XLSX & REKAPAN_WORKBOOK_XLSX.\n` +
            `  export  : ${EXPORT_XLSX}\n  workbook: ${WORKBOOK_XLSX}`);
        return;
    }

    const excel = bacaPasteDataSore();
    const hasil = parseAccurateExport(readFileSync(EXPORT_XLSX), TANGGAL);
    const heinz = hasil.lines.filter((l) => l.jenisproduk.toUpperCase() === PRINCIPAL);

    const notaParser = new Set(heinz.map((l) => l.noNota));
    const barisParser = new Map(heinz.map((l) => [`${l.noNota} ${l.kodeBarang}`, l.qtyPcs]));

    const notaHilang = [...excel.nota].filter((n) => !notaParser.has(n));
    const notaEkstra = [...notaParser].filter((n) => !excel.nota.has(n));
    assert.deepEqual(notaHilang, [], "nota di workbook yang tidak muncul dari export");
    assert.deepEqual(notaEkstra, [], "nota dari export yang tidak ada di workbook");
    assert.equal(notaParser.size, 131, "jumlah nota HEINZ ABC 21 Agu 2026");

    const selisih: string[] = [];
    for (const [key, pcs] of excel.baris) {
        const dariParser = barisParser.get(key);
        if (dariParser === undefined) selisih.push(`${key}: hilang di parser (excel ${pcs})`);
        else if (Math.abs(dariParser - pcs) > 1e-9) selisih.push(`${key}: parser ${dariParser} vs excel ${pcs}`);
    }
    for (const key of barisParser.keys()) {
        if (!excel.baris.has(key)) selisih.push(`${key}: hanya ada di parser`);
    }
    assert.deepEqual(selisih.slice(0, 20), [], `selisih baris (total ${selisih.length})`);
    assert.equal(barisParser.size, 776, "jumlah baris (no_nota x kode_barang)");
});
