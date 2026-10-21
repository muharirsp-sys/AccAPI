/*
 * Tujuan: Self-check helper penyajian layar Rekapan Nota (Fiori S2): saringan pool, urutan wave, tanggal WITA,
 *         exception yang menahan konfirmasi. Rusak di sini = "Pilih semua" memilih yang tidak terlihat atau tanggal bergeser.
 * Caller: npm run test:rekapan
 * Dependensi: node:test. Tidak menyentuh DB maupun file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXCEPTION_LABEL, hariIniWita, jamWita, judulBerkas, labelEvent, menahanKonfirmasi, nomorLembar, saringPool, tanggalPanjang, tanggalPendek, urutanBerikutnya } from "@/lib/rekapan-nota/ui";

const POOL = [
    { no_nota: "INV/2610/KN01381", customer: "TK HARAPAN BARU", salesman: "Yusuf", area: "4", pareto: false },
    { no_nota: "INV/2610/KN01408", customer: "IDM DAENG TATA", salesman: "Sinta", area: "5", pareto: true },
    { no_nota: "INV/2610/KN01410", customer: null, salesman: null, area: null, pareto: null },
];

test("saringan pool: cari tanpa huruf besar-kecil, lalu DAN dengan salesman/area/pareto", () => {
    const base = { cari: "", salesman: "", area: "", pareto: false };
    assert.equal(saringPool(POOL, base).length, 3);
    assert.deepEqual(saringPool(POOL, { ...base, cari: "harapan" }).map((r) => r.no_nota), ["INV/2610/KN01381"]);
    assert.deepEqual(saringPool(POOL, { ...base, cari: "kn014" }).map((r) => r.no_nota), ["INV/2610/KN01408", "INV/2610/KN01410"]);
    assert.deepEqual(saringPool(POOL, { ...base, pareto: true }).map((r) => r.no_nota), ["INV/2610/KN01408"]);
    assert.deepEqual(saringPool(POOL, { ...base, salesman: "Sinta", area: "4" }), []);
    // Baris tanpa customer/salesman tidak melempar.
    assert.equal(saringPool(POOL, { ...base, cari: "zzz" }).length, 0);
});

test("urutan wave berikutnya: reguler = maks + 1, kanvas mulai 9; tidak terpengaruh tipe lain", () => {
    const wave = [{ tipe: "reguler", urutan: 1 }, { tipe: "reguler", urutan: 2 }, { tipe: "kanvas", urutan: 9 }];
    assert.equal(urutanBerikutnya(wave, "reguler"), 3);
    assert.equal(urutanBerikutnya(wave, "kanvas"), 10);
    assert.equal(urutanBerikutnya([], "reguler"), 1);
    assert.equal(urutanBerikutnya([], "kanvas"), 9);
});

test("tanggal YYYY-MM-DD tidak bergeser hari dan jam tampil WITA", () => {
    assert.equal(tanggalPendek("2026-10-06"), "06/10/2026");
    assert.match(tanggalPanjang("2026-10-06"), /^Selasa, 6 Okt 2026$/);
    assert.equal(tanggalPendek("bukan tanggal"), "bukan tanggal");
    // 01.40 UTC = 09.40 WITA.
    assert.equal(jamWita("2026-10-06T01:40:00Z"), "6 Okt 09.40");
    assert.equal(jamWita("rusak"), "");
});

test("hanya exception KONVERSI_* berstatus open yang menahan konfirmasi", () => {
    assert.equal(menahanKonfirmasi("KONVERSI_TIDAK_ADA", "open"), true);
    assert.equal(menahanKonfirmasi("KONVERSI_BEDA_DENGAN_EXPORT", "diabaikan"), false);
    assert.equal(menahanKonfirmasi("OUTLET_TANPA_AREA", "open"), false);
});

test("riwayat BL-24/25: penutupan exception dan jumlah nota yang kembali saat batal; selisih file berlabel", () => {
    assert.deepEqual(labelEvent("wave.exception_resolved", { status: "diabaikan", ref_kode: "BRG-A", alasan: "file benar" }),
        { apa: "Mengabaikan exception", ubah: "BRG-A · file benar" });
    assert.equal(labelEvent("wave.exception_resolved", { status: "selesai", ref_kode: "BRG-A" }).apa, "Menandai exception selesai");
    assert.equal(labelEvent("wave.cancelled", { nota_kembali: ["N1", "N2"], alasan: "mobil rusak" }).ubah, "2 nota kembali ke pool · mobil rusak");
    assert.equal(labelEvent("wave.cancelled", {}).ubah, undefined);
    assert.equal(EXCEPTION_LABEL.REKONSILIASI_SELISIH, "Selisih dengan file");
});

test("nomor lembar tetap per wave + lembar; hari cetak dihitung WITA", () => {
    assert.equal(nomorLembar("RKP", "2026-10-19", 2, "ALL"), "RKP/2610/0002/ALL");
    assert.equal(nomorLembar("RKP", "2026-10-19", 2, "AREA-1+VOL-NONPARETO"), "RKP/2610/0002/AREA-1+VOL-NONPARETO");
    assert.equal(nomorLembar("TTF", "2026-10-19", 12345), "TTF/2610/12345");
    assert.equal(hariIniWita(new Date("2026-10-19T23:30:00Z")), "2026-10-20"); // 07.30 WITA = sudah tanggal 20
});

test("judul berkas PDF = nomor lembar tanpa garis miring + tanggal-jam WITA", () => {
    const pukul = new Date("2026-10-20T01:40:33Z"); // 09.40 WITA
    assert.equal(judulBerkas("RKP/2610/0002/JP-FKS", pukul), "RKP-2610-0002-JP-FKS_20261020-0940");
    assert.equal(judulBerkas("TTF/2610/0002", new Date("2026-10-19T16:05:00Z")), "TTF-2610-0002_20261020-0005"); // lewat tengah malam WITA
});
