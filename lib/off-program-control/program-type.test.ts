import assert from "node:assert/strict";
import { test } from "node:test";
import { INFO_TIPE, OFF_PROGRAM_TYPES, labelTipe, resolveProgramType, resolveProgramTypeForSave, sarankanTipe } from "./program-type.ts";

test("saran tipe dari nama program nyata (form SPV opc$ dan register klaim clm$)", () => {
  const kasus: Array<[string, string | null]> = [
    ["CASHBACK WHS LOYALTY Q2 2026", "Loyalty & Cashback Toko"],
    ["COG CUSSONS", "Loyalty & Cashback Toko"], // owner 3 Nov: COG = loyalty & cashback toko
    ["TT-Condi Rebate MTI (Monthly & Quarterly)", "Loyalty & Cashback Toko"],
    ["MTI - LISTING & SUPPORT FEE NPL & MHS JANUARI - DESEMBER 2026", "Listing & Biaya Ritel Modern"],
    ["CLAIM DC FEE ALFAMART", "Listing & Biaya Ritel Modern"],
    ["SEWA END GONDOLA", "Display"],
    ["SEWA COC", "Display"],
    ["RAFRAKSI NASIONAL MT", "Diskon & Rafaksi"],
    ["PROGRAM POTONGAN HARGA DI MTI", "Diskon & Rafaksi"],
    ["INCENTIVE SALESMAN & DSS PERIODE JULI 2026", "Insentif & Gaji Tenaga Penjual"],
    ["GAJI MOTORIS", "Insentif & Gaji Tenaga Penjual"],
    ["PROGRAM VOUCHER POTONGAN HARGA KEPADA KONSUMEN DI MT", "Promo On Store"],
    ["KLAIM PROGRAM BELI 4+1 MIE ABC LKA MAKASSAR", "Promo On Store"],
    ["CAR FREE DAY BOULEVARD", "Event"],
    ["GREBEK PASAR DAN TITIK KERAMAIAN", "Event"],
    ["SEWA VISIBILITY REGULER Q4", "Visibility"],
    ["AJUAN SPANDUK DESSERT 1 UMKM DAN OUTLET", "Visibility"],
    ["FREE DRINK THE TJAP SOLO", "Sample"],
    ["HAMPERS UNTUK TOKO", "Hadiah & Relasi Toko"],
    ["FLUSH OUT SISA PRODUCT SEASONAL 2026", "Retur & Near ED"],
    ["INSENTIF DISTRIBUTOR Q2", "Insentif Distributor"],
    ["HPC_TP NAS_BOOSTER DESEMBER PROGRAM 2025", "Loyalty & Cashback Toko"],
    ["BIAYA UNTUK PROGRAM VINDA", null],
    ["", null],
  ];
  for (const [nama, harap] of kasus) assert.equal(sarankanTipe(nama), harap, nama);
});

test("setiap tipe SPV punya penjelasan; label lama tetap memetakan nilai tersimpan", () => {
  for (const t of OFF_PROGRAM_TYPES) assert.ok(INFO_TIPE[t].jelas && INFO_TIPE[t].jawaban, t);
  assert.equal(labelTipe("Promo On Store"), "Promo Konsumen & Bonus Barang");
  assert.equal(labelTipe("Sample"), "Sampel & Free Drink");
  assert.equal(labelTipe("Tipe Asing"), "Tipe Asing");
  assert.equal(resolveProgramType("Promo Konsumen & Bonus Barang").normalizedType, "Promo On Store");
});

test("tipe tak dikenal jatuh ke Lainnya, bukan Sample; tipe CLM disimpan apa adanya", () => {
  const asing = resolveProgramType("Kategori Asing XYZ");
  assert.equal(asing.normalizedType, "Lainnya");
  assert.equal(asing.forcedToFallback, true);
  // Dulu "Insentif" (CLM) dipaksa jadi Sample karena hanya dibandingkan dengan dropdown SPV.
  const clm = resolveProgramTypeForSave("Insentif", "");
  assert.equal(clm.normalizedType, "Insentif");
  assert.equal(clm.typeIsLegacy, false);
  assert.equal(resolveProgramType("Display").typeIsLegacy, false);
  assert.equal(resolveProgramType("Visibilty").normalizedType, "Visibility");
});
