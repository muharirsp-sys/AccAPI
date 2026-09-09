/*
 * Tujuan: Self-check mesin usulan area terhadap master nyata (3.379 outlet) dan terhadap
 *         hasil analisis offline (Usulan_Mapping_Area_Outlet.xlsx). Uji jujur: leave-one-out,
 *         bukan menghitung ulang jawaban yang sudah ikut membentuk indeksnya.
 * Caller: npm run test:rekapan
 * Dependensi: workbook + file usulan di Downloads. Tidak ada -> SKIP dengan pesan jelas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as XLSX from "xlsx";
import {
    parseKelKec, bangunIndeks, usulkanArea, usulkanSemua,
    type OutletTerpetakan, type Outlet,
} from "@/lib/rekapan-nota/area-suggest";

const WORKBOOK = process.env.REKAPAN_WORKBOOK_XLSX
    || "C:\\Users\\Muhar\\Downloads\\A_New Rekapan Nota 24 AGUST 2026 update.xlsx";
const USULAN = process.env.REKAPAN_USULAN_XLSX
    || "C:\\Users\\Muhar\\Downloads\\Usulan_Mapping_Area_Outlet.xlsx";
const DIKECUALIKAN = new Set(["NON", "LUAR KOTA", "0", ""]);

test("parseKelKec menangani dua gaya penulisan yang ada di data", () => {
    assert.deepEqual(parseKelKec("JALAN NIPA NIPA_ Kel.ANTANG Kec. MANGGALA"),
        { kelurahan: "ANTANG", kecamatan: "MANGGALA" });
    assert.deepEqual(parseKelKec("JL. MONUMEN EMMY SAELAN III. NO. A4_ KEL.KARUNRUNG KEC. RAPPOCINI"),
        { kelurahan: "KARUNRUNG", kecamatan: "RAPPOCINI" });
    // Koma sesudah kecamatan pernah muncul (PABAENG-BAENG) — tidak boleh ikut tertelan.
    assert.deepEqual(parseKelKec("PASAR PABAENG-BAENG_ Kel.PABAENG-BAENG Kec. TAMALATE,JL"),
        { kelurahan: "PABAENG-BAENG", kecamatan: "TAMALATE" });
    assert.deepEqual(parseKelKec("IR SUTAMI KOMP PERG PARANGLOE INDAH HAL 4/2 - TAMALANREA"),
        { kelurahan: null, kecamatan: null });
    assert.deepEqual(parseKelKec(null), { kelurahan: null, kecamatan: null });
});

function bacaMasterArea(): OutletTerpetakan[] {
    const wb = XLSX.readFile(WORKBOOK, { cellStyles: false, cellHTML: false });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Master Area Heinz"], {
        header: 1, raw: true, blankrows: false,
    });
    const out: OutletTerpetakan[] = [];
    for (const r of rows.slice(1)) {
        const kode = String(r[0] ?? "").trim();
        const area = String(r[3] ?? "").trim().toUpperCase();
        if (!kode || DIKECUALIKAN.has(area)) continue;
        out.push({ kode, nama: String(r[1] ?? "").trim(), alamat: String(r[2] ?? "").trim(), area });
    }
    return out;
}

test("leave-one-out atas master nyata: akurasi kelurahan >= 85%", (t) => {
    if (!existsSync(WORKBOOK)) { t.skip(`Workbook tidak ada: ${WORKBOOK}`); return; }
    const master = bacaMasterArea();
    assert.ok(master.length > 3000, `master terlalu sedikit: ${master.length}`);

    const indeks = bangunIndeks(master);
    let diuji = 0, benar = 0;
    for (const o of master) {
        const { kelurahan } = parseKelKec(o.alamat);
        const per = kelurahan ? indeks.kelurahan.get(kelurahan) : undefined;
        if (!per) continue;
        // LOO sungguhan: buang kontribusi outlet ini dari indeks sebelum ditanya, lalu kembalikan.
        const sebelum = per.get(o.area) ?? 0;
        if (sebelum <= 1) per.delete(o.area); else per.set(o.area, sebelum - 1);
        const kosong = per.size === 0;
        if (kosong) indeks.kelurahan.delete(kelurahan!);

        const usul = usulkanArea(o, indeks);
        if (usul) { diuji += 1; if (usul.area === o.area) benar += 1; }

        if (kosong) indeks.kelurahan.set(kelurahan!, per);
        per.set(o.area, sebelum);
    }
    const akurasi = benar / diuji;
    console.log(`  LOO: ${benar}/${diuji} benar = ${(akurasi * 100).toFixed(1)}%`);
    assert.ok(diuji > 1000, `terlalu sedikit yang bisa diuji: ${diuji}`);
    assert.ok(akurasi >= 0.85, `akurasi LOO ${(akurasi * 100).toFixed(1)}% di bawah baseline 85%`);
});

test("168 outlet belum terpetakan: cakupan usulan >= 55%, yang TINGGI sepakat dengan analisis offline", (t) => {
    if (!existsSync(WORKBOOK) || !existsSync(USULAN)) {
        t.skip(`File tidak ada. workbook=${WORKBOOK} usulan=${USULAN}`);
        return;
    }
    const master = bacaMasterArea();
    const wb = XLSX.readFile(USULAN, { cellStyles: false, cellHTML: false });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Usulan"], {
        header: 1, raw: true, blankrows: false,
    });
    // KODE | NAMA OUTLET | ALAMAT | KOTA | KELURAHAN | KECAMATAN | AREA USULAN | KEYAKINAN | ...
    const target: Outlet[] = [];
    const offline = new Map<string, { area: string; keyakinan: string }>();
    for (const r of rows.slice(1)) {
        const kode = String(r[0] ?? "").trim();
        if (!kode) continue;
        target.push({ kode, nama: String(r[1] ?? "").trim(), alamat: String(r[2] ?? "").trim() });
        offline.set(kode, {
            area: String(r[6] ?? "").trim().toUpperCase(),
            keyakinan: String(r[7] ?? "").trim().toUpperCase(),
        });
    }
    assert.equal(target.length, 168, "jumlah outlet belum terpetakan di file usulan");

    const usulan = usulkanSemua(target, master);
    const cakupan = usulan.length / target.length;
    const tinggi = usulan.filter((u) => u.keyakinan === "TINGGI");
    console.log(`  usulan: ${usulan.length}/168 = ${(cakupan * 100).toFixed(1)}% ` +
        `(TINGGI ${tinggi.length})`);
    assert.ok(cakupan >= 0.55, `cakupan ${(cakupan * 100).toFixed(1)}% di bawah baseline 55%`);

    // Yang boleh diterima massal wajib sepakat dengan analisis offline — di situlah risikonya.
    const beda = usulan
        .filter((u) => u.keyakinan === "TINGGI" && offline.get(u.kode)?.keyakinan === "TINGGI")
        .filter((u) => u.area !== offline.get(u.kode)!.area)
        .map((u) => `${u.kode}: mesin ${u.area} vs offline ${offline.get(u.kode)!.area}`);
    assert.deepEqual(beda, [], "usulan berkeyakinan TINGGI berbeda dengan analisis offline");
});
