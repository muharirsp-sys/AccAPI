/* K1a (BL-59) lib murni Kasir ↔ Incaso: alokasi uang pelunasan ke salesman, salesman -> kode -> ORANG (gabungan per bulan),
 * rekonsiliasi per orang per hari (klop persis / pembulatan ke atas Rp 100), kunci hari 20.00 WITA + buka kembali.
 * Semua nominal dalam SEN (bilangan bulat). Tanpa I/O. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    alokasiPelunasan, batasKunci, bolehDiubah, bulatkanKeAtas100, hariKerja, keSen, klop, orangDariKode, orangDariSalesmanId,
    penghalangTutup, rekonsiliasiHari, rencanaSetoranOrang, senKeTeks, snapshotHari, statusHari, TANPA_SALESMAN,
    type EventHari, type Pelunasan, type PetaOrang, type SetoranRevisi,
} from "./rekonsiliasi.ts";

const Rp = (rupiah: number) => rupiah * 100; // contoh uji dalam Rupiah bulat -> sen
const D = "2026-10-05"; // Senin
// Waktu WITA (UTC+8): 20.00 WITA = 12.00 UTC.
const wita = (isoLokal: string) => new Date(`${isoLokal}+08:00`);

// Pegawai Accurate (accurate_employee.id -> number) + gabungan kode (sales_code_merge 'merge') per bulan.
const PETA: PetaOrang = {
    kodeSalesman: new Map([[11, "S-A"], [12, "S-B"], [13, "S-A2"], [14, "S-C"], [15, "  "]]),
    gabunganPerBulan: new Map([["2026-10", new Map([["S-A2", "S-A"]])]]),
};

let urut = 0;
const pel = (metode: string, cheque: number, faktur: [salesmanId: number | null, rupiah: number][], tanggal = D): Pelunasan => {
    urut++;
    return {
        id: 1000 + urut, nomor: `SR/2610/${urut}`, tanggal, metode, chequeAmount: Rp(cheque),
        faktur: faktur.map(([masterSalesmanId, rp], i) => ({ fakturId: 5000 + urut * 10 + i, nomorFaktur: `INV/${urut}/${i}`, masterSalesmanId, invoicePayment: Rp(rp) })),
    };
};
const setor = (salesmanKode: string, tunai: number, transfer = 0, giro = 0, revisi = 1): SetoranRevisi =>
    ({ salesmanKode, revisi, tunai: Rp(tunai), transfer: Rp(transfer), giro: Rp(giro) });
const baris = (h: ReturnType<typeof rekonsiliasiHari>, orang: string) => {
    const b = h.baris.find((x) => x.orang === orang);
    assert.ok(b, `baris orang ${JSON.stringify(orang)}`);
    return b;
};

test("keSen: angka JSON Accurate / teks numeric Postgres -> sen tepat; > 2 desimal / bukan angka DITOLAK (tidak dibulatkan)", () => {
    assert.equal(keSen(108741.15), 10874115);
    assert.equal(keSen("108741.15"), 10874115);
    assert.equal(keSen("41592193.00"), 4159219300);
    assert.equal(keSen(0.1), 10);
    assert.equal(keSen("0.5"), 50);
    assert.equal(keSen(-1250.5), -125050);
    assert.equal(keSen("-0.00"), 0);
    assert.ok(Object.is(keSen("-0.00"), 0), "tanpa -0");
    for (const salah of [108741.152, "0.125", "1.234.567", "1,5", "1e5", 1e21, "", " ", "abc", Number.NaN, Number.POSITIVE_INFINITY, "99999999999999999.00"]) {
        assert.throws(() => keSen(salah as number | string), RangeError, `ditolak: ${String(salah)}`);
    }
    assert.equal(senKeTeks(10874115), "108741.15");
    assert.equal(senKeTeks(-125050), "-1250.50");
    assert.equal(senKeTeks(5), "0.05");
    assert.equal(senKeTeks(0), "0.00");
    assert.equal(keSen(senKeTeks(4159219300)), 4159219300, "pulang-pergi");
});

test("alokasi: satu pelunasan membayar faktur DUA orang -> dibagi per baris faktur (invoicePayment)", () => {
    const p = pel("CASH_OTHER", 1_500_000, [[11, 1_000_000], [12, 500_000]]);
    const a = alokasiPelunasan([p], PETA);
    assert.deepEqual(a.bagian.map((b) => [b.orang, b.sen]), [["S-A", Rp(1_000_000)], ["S-B", Rp(500_000)]]);
    assert.deepEqual(a.takTeralokasi, []);
    assert.deepEqual(a.nonKas, []);
});

test("alokasi (owner: nominal = chequeAmount): SATU orang -> chequeAmount PENUH (lebih bayar / kredit tanpa ember); multi-orang Σ ≠ cheque -> ember dengan orang & arah", () => {
    const lebih1 = pel("CASH_OTHER", 1_000_000, [[11, 900_000]]); // satu orang, uang lebih / lebih bayar
    const kredit1 = pel("CASH_OTHER", 400_000, [[11, 450_000]]); // satu orang, kredit / non-kas
    const duaKode = pel("BANK_TRANSFER", 700_000, [[11, 300_000], [13, 300_000]]); // S-A + S-A2 = SATU orang (gabungan Okt)
    const multiLebih = pel("BANK_TRANSFER", 1_000_000, [[11, 600_000], [12, 300_000]]);
    const multiKredit = pel("CASH_OTHER", 1_000_000, [[11, 700_000], [12, 400_000]]);
    const kosong = pel("BANK_CHEQUE", 250_000, []);
    const a = alokasiPelunasan([lebih1, kredit1, duaKode, multiLebih, multiKredit, kosong], PETA);
    assert.deepEqual(a.bagian.map((b) => [b.pelunasanId, b.orang, b.sen]), [
        [lebih1.id, "S-A", Rp(1_000_000)], [kredit1.id, "S-A", Rp(400_000)], [duaKode.id, "S-A", Rp(700_000)],
        [multiLebih.id, "S-A", Rp(600_000)], [multiLebih.id, "S-B", Rp(300_000)],
        [multiKredit.id, "S-A", Rp(700_000)], [multiKredit.id, "S-B", Rp(400_000)],
    ], "satu orang = chequeAmount; multi-orang = invoicePayment utuh (tidak diskalakan)");
    const dua = a.bagian.find((b) => b.pelunasanId === duaKode.id)!;
    assert.deepEqual([dua.kode, dua.jumlahFaktur], [["S-A", "S-A2"], 2]);
    // sisa = chequeAmount − Σ invoicePayment: > 0 = uang lebih / lebih bayar, < 0 = kredit / non-kas.
    assert.deepEqual(a.takTeralokasi.map((t) => [t.pelunasanId, t.sisa, t.alasan, t.arah, t.orang]), [
        [multiLebih.id, Rp(100_000), "jumlah_invoice_payment_beda", "lebih_bayar", ["S-A", "S-B"]],
        [multiKredit.id, Rp(-100_000), "jumlah_invoice_payment_beda", "kredit", ["S-A", "S-B"]],
        [kosong.id, Rp(250_000), "tanpa_baris_faktur", "lebih_bayar", []],
    ]);
    const t0 = a.takTeralokasi[0];
    assert.equal(t0.chequeAmount, Rp(1_000_000));
    assert.equal(t0.jumlahInvoicePayment, Rp(900_000));
    // Invarian: Σ bagian + Σ sisa = Σ chequeAmount (uang tidak hilang dan tidak bertambah).
    const total = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    assert.equal(total(a.bagian.map((b) => b.sen)) + total(a.takTeralokasi.map((t) => t.sisa)), Rp(1_000_000 + 400_000 + 700_000 + 1_000_000 + 1_000_000 + 250_000));
});

test("rekonsiliasi memakai chequeAmount: lebih bayar 1 orang (setor 1.000.000 klop, 900.000 selisih −100.000), kredit 1 orang (setor 400.000 klop); ember multi-orang berkalimat orang & arah", () => {
    const lebih = pel("CASH_OTHER", 1_000_000, [[11, 900_000]]);
    const kredit = pel("CASH_OTHER", 400_000, [[12, 450_000]]);
    const hari = (sa: number, sb: number) => rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [lebih, kredit], setoran: [setor("S-A", sa), setor("S-B", sb)] });
    const ok = hari(1_000_000, 400_000);
    assert.deepEqual(ok.baris.map((b) => [b.orang, b.pelunasan, b.status]), [["S-A", Rp(1_000_000), "klop"], ["S-B", Rp(400_000), "klop"]]);
    assert.deepEqual(ok.takTeralokasi, [], "satu orang: tanpa ember");
    const kurang = hari(900_000, 400_000);
    assert.deepEqual([baris(kurang, "S-A").status, baris(kurang, "S-A").selisih], ["selisih", Rp(-100_000)]);

    const multiKredit = pel("CASH_OTHER", 1_000_000, [[11, 700_000], [null, 400_000]]);
    const m = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [multiKredit], setoran: [setor("S-A", 700_000)] });
    assert.deepEqual(penghalangTutup(m).alasan, [
        "Tanpa salesman belum setor dan belum dijelaskan: pelunasan Rp 400.000.",
        `Uang tak teralokasi ${multiKredit.nomor} belum dijelaskan: Rp -100.000 kredit / non-kas (pelunasan Rp 1.000.000, faktur Rp 1.100.000; orang S-A, Tanpa salesman).`,
    ]);
});

test("alokasi: metode OTHERS (retur/ayat silang) DIKELUARKAN — tidak masuk salesman maupun ember", () => {
    const retur = pel("OTHERS", 300_000, [[11, 300_000]]);
    const silang = pel("OTHERS", -300_000, [[11, -300_000]]);
    const tunai = pel("CASH_OTHER", 200_000, [[11, 200_000]]);
    const a = alokasiPelunasan([retur, silang, tunai], PETA);
    assert.deepEqual(a.nonKas.map((p) => p.id), [retur.id, silang.id]);
    assert.deepEqual(a.bagian.map((b) => b.pelunasanId), [tunai.id]);
    assert.deepEqual(a.takTeralokasi, []);
});

test("alokasi: input rusak ditolak keras — nominal bukan sen bulat, id pelunasan ganda", () => {
    const p = pel("CASH_OTHER", 1, [[11, 1]]);
    assert.throws(() => alokasiPelunasan([{ ...p, chequeAmount: 10.5 }], PETA), RangeError);
    assert.throws(() => alokasiPelunasan([{ ...p, faktur: [{ ...p.faktur[0], invoicePayment: Number.NaN }] }], PETA), RangeError);
    assert.throws(() => alokasiPelunasan([p, p], PETA), /ganda/);
});

test("orang: kode -> orang lewat gabungan PER BULAN (rantai diikuti); kode tanpa gabungan = orang sendiri; id tanpa kode = Tanpa salesman", () => {
    assert.equal(orangDariKode("S-A2", "2026-10-31", PETA), "S-A", "Okt: S-A2 digabung ke S-A");
    assert.equal(orangDariKode("S-A2", "2026-09-30", PETA), "S-A2", "Sep: tanpa keputusan gabung = orang sendiri");
    assert.equal(orangDariKode("S-A2", "2026-11-01", PETA), "S-A2", "Nov: keputusan Okt tidak terbawa");
    assert.equal(orangDariKode(" S-B ", D, PETA), "S-B");
    const rantai = { gabunganPerBulan: new Map([["2026-10", new Map([["X1", "X2"], ["X2", "X3"]])]]) };
    assert.equal(orangDariKode("X1", D, rantai), "X3");
    assert.deepEqual(orangDariSalesmanId(13, D, PETA), { orang: "S-A", kode: "S-A2" });
    assert.deepEqual(orangDariSalesmanId(12, D, PETA), { orang: "S-B", kode: "S-B" });
    assert.deepEqual(orangDariSalesmanId(null, D, PETA), { orang: TANPA_SALESMAN, kode: null });
    assert.deepEqual(orangDariSalesmanId(99, D, PETA), { orang: TANPA_SALESMAN, kode: null }, "id tak ada di accurate_employee");
    assert.deepEqual(orangDariSalesmanId(15, D, PETA), { orang: TANPA_SALESMAN, kode: null }, "number kosong");
    assert.equal(orangDariKode("", D, PETA), TANPA_SALESMAN);
});

test("klop: sama persis ATAU setoran = total dibulatkan KE ATAS ke kelipatan Rp 100; selain itu selisih", () => {
    assert.equal(bulatkanKeAtas100(Rp(41_592_193)), Rp(41_592_200));
    assert.equal(bulatkanKeAtas100(Rp(41_592_200)), Rp(41_592_200));
    assert.equal(bulatkanKeAtas100(keSen("108741.15")), Rp(108_800));
    assert.equal(bulatkanKeAtas100(Rp(-150)), Rp(-100));
    assert.ok(klop(Rp(41_592_193), Rp(41_592_193)), "sama persis");
    assert.ok(klop(Rp(41_592_193), Rp(41_592_200)), "pembulatan ke atas");
    assert.ok(!klop(Rp(41_592_193), Rp(41_592_300)), "lebih dari pembulatan = selisih");
    assert.ok(!klop(Rp(41_592_193), Rp(41_592_100)), "pembulatan ke BAWAH = selisih");
    assert.ok(!klop(Rp(41_592_193), Rp(41_592_199)), "di antara = selisih");
    assert.ok(klop(keSen("108741.15"), keSen("108741.15")));
    assert.ok(klop(keSen("108741.15"), Rp(108_800)));
    assert.ok(!klop(keSen("108741.15"), Rp(108_741)), "sen dibuang = kurang setor");
    // Angka besar: tetap tepat (aritmetika bulat, bukan Math.ceil pada pecahan).
    assert.equal(bulatkanKeAtas100(1_234_567_890_123_401), 1_234_567_890_130_000);
});

test("rekonsiliasi per ORANG per hari: alokasi multi-salesman + gabungan kode + revisi terakhir + status", () => {
    const h = rekonsiliasiHari({
        tanggal: D,
        peta: PETA,
        pelunasan: [
            pel("CASH_OTHER", 1_500_000, [[11, 1_000_000], [12, 500_000]]),
            pel("BANK_TRANSFER", 2_000_000, [[13, 2_000_000]]), // S-A2 -> orang S-A
            pel("BANK_CHEQUE", 41_592_193, [[14, 41_592_193]]),
            pel("OTHERS", 999_000, [[12, 999_000]]),
        ],
        setoran: [
            setor("S-A", 1_000_000, 0, 0, 1),
            setor("S-A", 1_000_000, 2_000_000, 0, 2), // koreksi: revisi 2 menggantikan revisi 1
            setor("S-C", 0, 0, 41_592_200),
            setor("S-D", 75_000),
        ],
    });
    assert.deepEqual(h.baris.map((b) => [b.orang, b.status]), [
        ["S-A", "klop"], ["S-B", "belum_setor"], ["S-C", "klop"], ["S-D", "setoran_tanpa_pelunasan"],
    ]);
    const a = baris(h, "S-A");
    assert.deepEqual(a.kode, ["S-A", "S-A2"]);
    assert.equal(a.pelunasan, Rp(3_000_000));
    assert.deepEqual(a.pelunasanPerMetode, { CASH_OTHER: Rp(1_000_000), BANK_TRANSFER: Rp(2_000_000) });
    assert.deepEqual(a.setoran, { tunai: Rp(1_000_000), transfer: Rp(2_000_000), giro: 0, total: Rp(3_000_000) });
    assert.equal(a.selisih, 0);
    assert.equal(a.jumlahFaktur, 2);
    const b = baris(h, "S-B");
    assert.equal(b.pelunasan, Rp(500_000), "OTHERS S-B tidak dihitung");
    assert.equal(b.setoran, null);
    assert.equal(b.selisih, null);
    assert.equal(baris(h, "S-C").selisih, Rp(7), "klop karena pembulatan, selisih tetap terlihat");
    assert.equal(baris(h, "S-D").pelunasan, 0);
    assert.deepEqual(h.total, { pelunasan: Rp(45_092_193), setoran: Rp(44_667_200), takTeralokasi: 0, nonKas: Rp(999_000) });
    assert.deepEqual(h.nonKas.map((p) => p.metode), ["OTHERS"]);
});

test("rekonsiliasi: selisih (kurang/lebih), setoran 0 tercatat = selisih (bukan belum setor), revisi turun ke 0", () => {
    const h = rekonsiliasiHari({
        tanggal: D, peta: PETA,
        pelunasan: [pel("CASH_OTHER", 41_592_193, [[11, 41_592_193]]), pel("CASH_OTHER", 9_150_000, [[12, 9_150_000]]), pel("CASH_OTHER", 100, [[14, 100]])],
        setoran: [setor("S-A", 41_592_300), setor("S-B", 8_750_000), setor("S-C", 100, 0, 0, 1), setor("S-C", 0, 0, 0, 2)],
    });
    assert.deepEqual(h.baris.map((x) => [x.orang, x.status, x.selisih]), [
        ["S-A", "selisih", Rp(107)], ["S-B", "selisih", Rp(-400_000)], ["S-C", "selisih", Rp(-100)],
    ]);
});

test("rekonsiliasi: Tanpa salesman TERLIHAT (id null / id tanpa kode), ember tak teralokasi ikut total; tanggal lain ditolak", () => {
    const h = rekonsiliasiHari({
        tanggal: D, peta: PETA,
        pelunasan: [pel("CASH_OTHER", 300_000, [[null, 100_000], [99, 200_000]]), pel("CASH_OTHER", 500_000, [[11, 300_000], [12, 150_000]])],
        setoran: [],
    });
    const t = baris(h, TANPA_SALESMAN);
    assert.equal(t.pelunasan, Rp(300_000));
    assert.equal(t.status, "belum_setor");
    assert.deepEqual(t.salesmanIdTakDikenal, [99]);
    assert.equal(h.baris[h.baris.length - 1].orang, TANPA_SALESMAN, "Tanpa salesman di akhir daftar");
    assert.deepEqual(h.takTeralokasi.map((x) => x.sisa), [Rp(50_000)]);
    assert.deepEqual(h.total, { pelunasan: Rp(750_000), setoran: 0, takTeralokasi: Rp(50_000), nonKas: 0 });
    assert.throws(() => rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [pel("CASH_OTHER", 1, [[11, 1]], "2026-10-06")], setoran: [] }), /tanggal/);
    assert.throws(() => rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [], setoran: [setor("S-A", 1), setor("S-A", 2)] }), /revisi/);
});

test("koreksi setoran ORANG multi-kode: rencana menulis revisi di SETIAP rantai kode orang itu (utama = nominal baru, lain = 0) — tanpa dobel hitung", () => {
    // S-B dan S-A dicatat terpisah (belum digabung), lalu Insentif memutuskan gabung S-B -> S-A untuk Okt.
    const petaGabung: PetaOrang = { ...PETA, gabunganPerBulan: new Map([["2026-10", new Map([["S-A2", "S-A"], ["S-B", "S-A"]])]]) };
    const pelunasan = [pel("CASH_OTHER", 3_000_000, [[11, 3_000_000]])];
    const awal = [setor("S-B", 1_000_000), setor("S-A", 2_000_000)];
    const hari = (setoran: SetoranRevisi[]) => baris(rekonsiliasiHari({ tanggal: D, peta: petaGabung, pelunasan, setoran }), "S-A");
    const a = hari(awal);
    assert.deepEqual(a.setoranPerKode, [
        { kode: "S-A", revisi: 1, tunai: Rp(2_000_000), transfer: 0, giro: 0, total: Rp(2_000_000) },
        { kode: "S-B", revisi: 1, tunai: Rp(1_000_000), transfer: 0, giro: 0, total: Rp(1_000_000) },
    ]);
    assert.equal(a.setoran?.total, Rp(3_000_000));

    // Koreksi total orang ke 3 jt. Naif (hanya rantai S-A) = dobel hitung 4 jt.
    const naif = hari([...awal, setor("S-A", 3_000_000, 0, 0, 2)]);
    assert.equal(naif.setoran?.total, Rp(4_000_000), "naif: rantai S-B tertinggal");
    const rencana = rencanaSetoranOrang(a, { tunai: Rp(3_000_000), transfer: 0, giro: 0 });
    assert.deepEqual(rencana, [
        { salesmanKode: "S-A", revisi: 2, revisiSebelumnya: 1, tunai: Rp(3_000_000), transfer: 0, giro: 0 },
        { salesmanKode: "S-B", revisi: 2, revisiSebelumnya: 1, tunai: 0, transfer: 0, giro: 0 },
    ]);
    const sesudah = hari([...awal, ...rencana]);
    assert.equal(sesudah.setoran?.total, Rp(3_000_000), "rencana: total orang = nominal baru");
    assert.equal(sesudah.status, "klop");

    // Rantai lain yang sudah 0 tidak ditulis ulang; koreksi berikutnya hanya rantai utama.
    assert.deepEqual(rencanaSetoranOrang(sesudah, { tunai: Rp(2_900_000), transfer: Rp(100_000), giro: 0 }),
        [{ salesmanKode: "S-A", revisi: 3, revisiSebelumnya: 2, tunai: Rp(2_900_000), transfer: Rp(100_000), giro: 0 }]);
    // Setoran hanya di kode lama (S-B) yang kini digabung: kode utama mulai revisi 1, S-B dinolkan.
    const hanyaB = hari([setor("S-B", 1_000_000)]);
    assert.deepEqual(rencanaSetoranOrang(hanyaB, { tunai: Rp(3_000_000), transfer: 0, giro: 0 }), [
        { salesmanKode: "S-A", revisi: 1, revisiSebelumnya: null, tunai: Rp(3_000_000), transfer: 0, giro: 0 },
        { salesmanKode: "S-B", revisi: 2, revisiSebelumnya: 1, tunai: 0, transfer: 0, giro: 0 },
    ]);
    // Orang tanpa setoran = catat pertama; Tanpa salesman / nominal negatif / bukan sen ditolak.
    assert.deepEqual(rencanaSetoranOrang({ orang: "S-C", setoranPerKode: [] }, { tunai: Rp(5), transfer: 0, giro: 0 }),
        [{ salesmanKode: "S-C", revisi: 1, revisiSebelumnya: null, tunai: Rp(5), transfer: 0, giro: 0 }]);
    assert.throws(() => rencanaSetoranOrang({ orang: TANPA_SALESMAN, setoranPerKode: [] }, { tunai: 1, transfer: 0, giro: 0 }), /Tanpa salesman/);
    assert.throws(() => rencanaSetoranOrang({ orang: "S-C", setoranPerKode: [] }, { tunai: -1, transfer: 0, giro: 0 }), RangeError);
    assert.throws(() => rencanaSetoranOrang({ orang: "S-C", setoranPerKode: [] }, { tunai: 0.5, transfer: 0, giro: 0 }), RangeError);
});

test("penjelasan selisih berlaku hanya untuk angka yang dijelaskan; penghalang tutup = belum klop & belum dijelaskan", () => {
    const masukan = (setoranB: number) => ({
        tanggal: D, peta: PETA,
        pelunasan: [pel("CASH_OTHER", 9_150_000, [[12, 9_150_000]]), pel("CASH_OTHER", 1_000, [[11, 1_000]])],
        setoran: [setor("S-B", setoranB), setor("S-A", 1_000)],
        catatan: [{ salesmanKode: "S-B", pelunasan: Rp(9_150_000), setoran: Rp(8_750_000) }],
    });
    const h = rekonsiliasiHari(masukan(8_750_000));
    assert.equal(baris(h, "S-B").dijelaskan, true);
    assert.deepEqual(penghalangTutup(h), { bisaDitutup: true, alasan: [], baris: [], takTeralokasi: [] });
    const berubah = rekonsiliasiHari(masukan(8_800_000));
    assert.equal(baris(berubah, "S-B").dijelaskan, false, "angka berubah = penjelasan lama tidak berlaku");
    const p = penghalangTutup(berubah);
    assert.equal(p.bisaDitutup, false);
    assert.deepEqual(p.baris.map((x) => x.orang), ["S-B"]);
    assert.deepEqual(p.alasan, ["Selisih S-B belum dijelaskan: setoran Rp 8.800.000 lawan pelunasan Rp 9.150.000 (Rp -350.000)."]);
    const s = snapshotHari(berubah);
    assert.equal(s.tanggal, D);
    assert.deepEqual(s.total, berubah.total);
    assert.deepEqual(s.baris.find((x) => x.orang === "S-B"), { orang: "S-B", pelunasan: Rp(9_150_000), setoran: Rp(8_800_000), status: "selisih", dijelaskan: false });
    assert.deepEqual(s.terhalang, p.alasan);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "snapshot = JSON murni (kolom jsonb)");
});

test("T2 (owner 11 Okt): uang TAK TERALOKASI wajib dijelaskan sebelum Tutup — per pelunasan, angka sisa sama; kunci tetap mencatat yang belum", () => {
    const lebih = pel("BANK_TRANSFER", 1_000_000, [[11, 600_000], [12, 300_000]]); // dua orang, sisa Rp 100.000
    const kosong = pel("CASH_OTHER", 250_000, []); // tanpa baris faktur
    const masukan = (catatanTakTeralokasi: { pelunasanId: number; sisa: number }[]) => ({
        tanggal: D, peta: PETA, pelunasan: [lebih, kosong], setoran: [setor("S-A", 600_000), setor("S-B", 300_000)], catatanTakTeralokasi,
    });
    const belum = rekonsiliasiHari(masukan([]));
    assert.deepEqual(belum.baris.map((b) => b.status), ["klop", "klop"], "semua orang klop ...");
    assert.deepEqual(belum.takTeralokasi.map((t) => t.dijelaskan), [false, false]);
    const p = penghalangTutup(belum);
    assert.equal(p.bisaDitutup, false, "... tetapi ember tak teralokasi menghalangi Tutup");
    assert.deepEqual(p.baris, []);
    assert.deepEqual(p.takTeralokasi.map((t) => t.pelunasanId), [lebih.id, kosong.id]);
    assert.deepEqual(p.alasan, [
        `Uang tak teralokasi ${lebih.nomor} belum dijelaskan: Rp 100.000 uang lebih / lebih bayar (pelunasan Rp 1.000.000, faktur Rp 900.000; orang S-A, S-B).`,
        `Uang tak teralokasi ${kosong.nomor} belum dijelaskan: Rp 250.000 (pelunasan tanpa baris faktur).`,
    ]);

    // Penjelasan berlaku hanya untuk pelunasan & angka sisa yang sama.
    const sebagian = rekonsiliasiHari(masukan([{ pelunasanId: lebih.id, sisa: Rp(100_000) }, { pelunasanId: kosong.id, sisa: Rp(1) }]));
    assert.deepEqual(sebagian.takTeralokasi.map((t) => t.dijelaskan), [true, false]);
    assert.deepEqual(penghalangTutup(sebagian).takTeralokasi.map((t) => t.pelunasanId), [kosong.id]);
    const tuntas = rekonsiliasiHari(masukan([{ pelunasanId: lebih.id, sisa: Rp(100_000) }, { pelunasanId: kosong.id, sisa: Rp(250_000) }]));
    assert.deepEqual(penghalangTutup(tuntas), { bisaDitutup: true, alasan: [], baris: [], takTeralokasi: [] });
    assert.deepEqual(snapshotHari(tuntas).terhalang, [], "snapshot Tutup: tidak terhalang");

    // Kunci otomatis 20.00 TETAP mengunci walau terhalang (kunci ≠ tutup); snapshot kunci MENCATAT ember yang belum dijelaskan.
    assert.equal(statusHari(D, [], wita("2026-10-05T20:00:00")).terkunci, true);
    const sk = snapshotHari(belum);
    assert.deepEqual(sk.takTeralokasi, [
        { pelunasanId: lebih.id, nomor: lebih.nomor, sisa: Rp(100_000), alasan: "jumlah_invoice_payment_beda", arah: "lebih_bayar", orang: ["S-A", "S-B"], dijelaskan: false },
        { pelunasanId: kosong.id, nomor: kosong.nomor, sisa: Rp(250_000), alasan: "tanpa_baris_faktur", arah: "lebih_bayar", orang: [], dijelaskan: false },
    ]);
    assert.deepEqual(sk.terhalang, p.alasan);
});

test("kunci hari: 19.59 WITA terbuka, 20.00 WITA terkunci otomatis; lintas tengah malam UTC & WITA", () => {
    assert.equal(batasKunci(D).toISOString(), "2026-10-05T12:00:00.000Z");
    assert.equal(statusHari(D, [], wita("2026-10-05T19:59:59")).terkunci, false);
    assert.deepEqual(statusHari(D, [], wita("2026-10-05T20:00:00")), { terkunci: true, sebab: "otomatis_20", kunciBerikutnya: null });
    // 07.30 WITA = 23.30 UTC hari SEBELUMNYA: tetap hari D di WITA, terbuka.
    assert.equal(statusHari(D, [], wita("2026-10-05T07:30:00")).terkunci, false);
    assert.equal(statusHari(D, [], wita("2026-10-06T00:30:00")).terkunci, true, "lewat tengah malam WITA");
    assert.equal(statusHari(D, [], wita("2026-10-05T19:59:59")).kunciBerikutnya?.toISOString(), "2026-10-05T12:00:00.000Z");
    // Hari yang belum tiba: belum terkunci, tetapi tidak boleh diubah (tanggal > hari ini WITA).
    assert.equal(statusHari("2026-10-06", [], wita("2026-10-05T21:00:00")).terkunci, false);
    assert.equal(bolehDiubah("2026-10-06", [], wita("2026-10-05T21:00:00")), false, "masa depan");
    assert.equal(bolehDiubah(D, [], wita("2026-10-05T19:59:59")), true);
    assert.equal(bolehDiubah(D, [], wita("2026-10-05T20:00:00")), false);
    assert.throws(() => statusHari("5/10/2026", [], new Date()), /tanggal/);
    assert.throws(() => statusHari("2026-02-30", [], new Date()), /tanggal/);
});

test("kunci hari T1 (owner 11 Okt): tutup lebih awal mengunci; buka kembali HANYA dengan alasan ≥ 15 huruf, terkunci ulang otomatis 20.00 WITA berikutnya", () => {
    const tutup: EventHari = { id: 1, jenis: "tutup", pada: wita("2026-10-05T17:42:00") };
    assert.deepEqual(statusHari(D, [tutup], wita("2026-10-05T17:43:00")), { terkunci: true, sebab: "tutup", kunciBerikutnya: null });
    const bukaPendek: EventHari = { id: 2, jenis: "buka", pada: wita("2026-10-05T18:00:00"), alasan: "salah ketik" };
    assert.equal(statusHari(D, [tutup, bukaPendek], wita("2026-10-05T18:01:00")).terkunci, true, "buka tanpa alasan sah diabaikan");
    const buka: EventHari = { id: 3, jenis: "buka", pada: wita("2026-10-06T09:00:00"), alasan: "Setoran MKS-03 susulan salah dicatat" };
    const s = statusHari(D, [buka, tutup], wita("2026-10-06T09:05:00")); // urutan masukan bebas; urut menurut id
    assert.deepEqual(s, { terkunci: false, sebab: null, kunciBerikutnya: new Date("2026-10-06T12:00:00.000Z") });
    assert.equal(bolehDiubah(D, [tutup, buka], wita("2026-10-06T19:59:00")), true);
    assert.deepEqual(statusHari(D, [tutup, buka], wita("2026-10-06T20:00:00")), { terkunci: true, sebab: "otomatis_20", kunciBerikutnya: null },
        "terkunci lagi otomatis 20.00 WITA sesudah dibuka");
    // Buka sesudah 20.00 -> berlaku sampai 20.00 hari berikutnya.
    const bukaMalam: EventHari = { id: 4, jenis: "buka", pada: wita("2026-10-06T21:00:00"), alasan: "Koreksi Incaso masuk malam hari" };
    assert.equal(statusHari(D, [tutup, buka, bukaMalam], wita("2026-10-07T19:00:00")).terkunci, false);
    // Tutup / kunci sesudah dibuka mengunci lagi.
    const kunci: EventHari = { id: 5, jenis: "kunci", pada: wita("2026-10-07T20:00:05") };
    assert.deepEqual(statusHari(D, [tutup, buka, bukaMalam, kunci], wita("2026-10-07T20:00:06")), { terkunci: true, sebab: "kunci", kunciBerikutnya: null });
});

test("RENDAH 3: metode di luar daftar putih (CASH_OTHER/BANK_TRANSFER/BANK_CHEQUE) -> ember 'metode tak dikenal' terlihat, tidak dihitung ke orang", () => {
    const kartu = pel("CREDIT_CARD", 500_000, [[11, 500_000]]);
    const kecil = pel("cash_other", 200_000, [[11, 200_000]]);
    const spasi = pel("CASH_OTHER ", 100_000, [[12, 100_000]]);
    const sah = pel("CASH_OTHER", 50_000, [[11, 50_000]]);
    const h = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [kartu, kecil, spasi, sah], setoran: [setor("S-A", 50_000)] });
    assert.deepEqual(h.baris.map((b) => [b.orang, b.pelunasan, b.status]), [["S-A", Rp(50_000), "klop"]], "tidak dihitung tunai diam-diam");
    assert.deepEqual(h.takTeralokasi.map((t) => [t.pelunasanId, t.sisa, t.alasan]), [
        [kartu.id, Rp(500_000), "metode_tak_dikenal"], [kecil.id, Rp(200_000), "metode_tak_dikenal"], [spasi.id, Rp(100_000), "metode_tak_dikenal"],
    ]);
    assert.equal(h.total.takTeralokasi, Rp(800_000), "uangnya tetap terlihat di total");
    assert.equal(penghalangTutup(h).alasan[0],
        `Uang tak teralokasi ${kartu.nomor} belum dijelaskan: Rp 500.000 (metode "CREDIT_CARD" tak dikenal; tidak dihitung ke orang).`);
});

test("K1b RENDAH 5a: metode tak dikenal ber-cheque 0 DILEWATI — tanpa ember sisa 0 (CHECK sisa <> 0 membuat Tutup terhalang permanen)", () => {
    const nol = pel("CREDIT_CARD", 0, [[11, 100_000]]);
    const nolTanpaBaris = pel("GIRO_MUNDUR", 0, []);
    const kartu = pel("CREDIT_CARD", 25_000, [[11, 25_000]]);
    const h = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [nol, nolTanpaBaris, kartu], setoran: [] });
    assert.deepEqual(h.takTeralokasi.map((t) => [t.pelunasanId, t.sisa]), [[kartu.id, Rp(25_000)]], "hanya ember bernominal");
    assert.ok(h.takTeralokasi.every((t) => t.sisa !== 0), "tidak ada ember sisa 0");
    assert.deepEqual(h.baris, [], "tidak dihitung ke orang");
    assert.deepEqual(penghalangTutup(rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [nol], setoran: [] })).bisaDitutup, true);
});

// K-1 (owner 12 Okt, pilihan a): cheque metode UANG < 0 -> SELURUH nominal ke ember tak teralokasi `nominal_negatif` (wajib dijelaskan sebelum
// Tutup, meniru metode_tak_dikenal); TIDAK mengurangi total orang; orang lain tetap direkonsiliasi (tanpa galat sehari).
test("K1b RENDAH 5b (K-1 = a): cheque uang NEGATIF -> ember nominal_negatif penuh, tidak mengurangi orang, hari tidak gagal", () => {
    const negatif = pel("CASH_OTHER", -300_000, [[12, -300_000]]);
    const negatifCampur = pel("BANK_TRANSFER", -80_000, [[14, -80_000], [11, 0]]);
    const positifC = pel("CASH_OTHER", 30_000, [[14, 30_000]]);
    const sah = pel("CASH_OTHER", 50_000, [[11, 50_000]]);
    const giro = pel("BANK_CHEQUE", -0.5, []);
    const masukan = { tanggal: D, peta: PETA, pelunasan: [negatif, negatifCampur, positifC, sah, giro],
        setoran: [setor("S-A", 50_000), setor("S-B", 0), setor("S-C", 30_000)] };
    const h = rekonsiliasiHari(masukan);
    assert.deepEqual(h.baris.map((b) => [b.orang, b.pelunasan, b.status]), [["S-A", Rp(50_000), "klop"], ["S-B", 0, "klop"], ["S-C", Rp(30_000), "klop"]],
        "orang lain tetap direkonsiliasi; cheque negatif tidak mengurangi total orang");
    assert.deepEqual(h.takTeralokasi.map((t) => [t.pelunasanId, t.sisa, t.arah, t.alasan, t.jumlahInvoicePayment, t.orang]), [
        [negatif.id, Rp(-300_000), "kredit", "nominal_negatif", 0, ["S-B"]],
        [negatifCampur.id, Rp(-80_000), "kredit", "nominal_negatif", 0, ["S-C", "S-A"]],
        [giro.id, -50, "kredit", "nominal_negatif", 0, []],
    ]);
    assert.equal(h.total.pelunasan + h.total.takTeralokasi, Rp(-300_000 - 80_000 + 30_000 + 50_000) - 50, "invarian Σ orang + Σ ember = Σ cheque");
    const p = penghalangTutup(h);
    assert.equal(p.bisaDitutup, false, "wajib dijelaskan sebelum Tutup");
    assert.equal(p.alasan[0], `Uang tak teralokasi ${negatif.nomor} belum dijelaskan: Rp -300.000 (pelunasan Tunai/Transfer/Giro bernominal negatif; `
        + "tidak dihitung ke orang S-B).");
    assert.deepEqual(snapshotHari(h).takTeralokasi.map((t) => t.alasan), ["nominal_negatif", "nominal_negatif", "nominal_negatif"]);
    const jelas = rekonsiliasiHari({ ...masukan, catatanTakTeralokasi: h.takTeralokasi.map((t) => ({ pelunasanId: t.pelunasanId, sisa: t.sisa })) });
    assert.equal(penghalangTutup(jelas).bisaDitutup, true, "dijelaskan (angka sisa sama) -> Tutup boleh");
    // Metode tak dikenal bernominal negatif tetap metode_tak_dikenal; OTHERS negatif tetap non-kas.
    const kartu = pel("CREDIT_CARD", -10_000, [[11, -10_000]]);
    const retur = pel("OTHERS", -20_000, [[11, -20_000]]);
    const h2 = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [kartu, retur], setoran: [] });
    assert.deepEqual(h2.takTeralokasi.map((t) => t.alasan), ["metode_tak_dikenal"]);
    assert.deepEqual(h2.nonKas.map((x) => x.id), [retur.id]);
});

test("K1b RENDAH 4 (K-1 a per orang): invoicePayment NEGATIF pada pelunasan multi-orang -> bagian negatif ke ember nominal_negatif, orang tidak dikurangi", () => {
    const p = pel("CASH_OTHER", 100_000, [[11, 150_000], [12, -50_000], [12, -10_000], [14, 10_000]]);
    const h = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [p], setoran: [setor("S-A", 150_000), setor("S-B", 0), setor("S-C", 10_000)] });
    assert.deepEqual(h.baris.map((b) => [b.orang, b.pelunasan, b.status]), [["S-A", Rp(150_000), "klop"], ["S-B", 0, "klop"], ["S-C", Rp(10_000), "klop"]]);
    assert.deepEqual(h.takTeralokasi.map((t) => [t.alasan, t.sisa, t.arah, t.orang]), [
        ["nominal_negatif", Rp(-60_000), "kredit", ["S-B"]],
        ["jumlah_invoice_payment_beda", Rp(100_000 - 100_000), "lebih_bayar", ["S-A", "S-B", "S-C"]],
    ].filter((x) => x[1] !== 0));
    assert.equal(h.total.pelunasan + h.total.takTeralokasi, Rp(100_000), "invarian Σ orang + Σ ember = Σ cheque");
    assert.match(penghalangTutup(h).alasan.join(" | "), /baris faktur bernominal negatif/);
});

/** PRNG berbenih (mulberry32) — fuzz deterministik. */
function acak(benih: number) {
    let a = benih >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("K1b RENDAH 4 fuzz: data Accurate apa pun (cheque/invoicePayment ±, metode campur, salesman null/tak dikenal) -> rekonsiliasi TIDAK PERNAH melempar", () => {
    const r = acak(20261012);
    const pilih = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const nominal = () => (r() < 0.15 ? 0 : Math.round((r() * 2 - 1) * 50_000_000));
    for (let iter = 0; iter < 400; iter++) {
        const pelunasan: Pelunasan[] = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => ({
            id: iter * 100 + i, nomor: `SR/F/${iter}/${i}`, tanggal: D, chequeAmount: nominal(),
            metode: pilih(["CASH_OTHER", "BANK_TRANSFER", "BANK_CHEQUE", "OTHERS", "CREDIT_CARD"]),
            faktur: Array.from({ length: Math.floor(r() * 4) }, (__, j) => ({ fakturId: j + 1, nomorFaktur: null,
                masterSalesmanId: pilih([11, 12, 13, 14, 15, 999, null]), invoicePayment: nominal() })),
        }));
        const setoran = (["S-A", "S-B", "S-C"] as const).filter(() => r() < 0.6).map((k) => setor(k, Math.round(r() * 500_000)));
        const h = rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan, setoran });
        penghalangTutup(h);
        snapshotHari(h);
        const uang = pelunasan.filter((x) => x.metode !== "OTHERS").reduce((a, x) => a + x.chequeAmount, 0);
        assert.equal(h.total.pelunasan + h.total.takTeralokasi, uang, `invarian iterasi ${iter}`);
        assert.ok(h.baris.every((b) => b.pelunasan >= 0), `total orang >= 0 iterasi ${iter}`);
        assert.ok(h.takTeralokasi.every((t) => t.sisa !== 0), `tanpa ember sisa 0 iterasi ${iter}`);
    }
});

test("RENDAH 4–6: gabungan siklik = galat; klop/setoran negatif & urutan revisi ditolak lib; `pada` wajib Date atau ISO berofset", () => {
    const siklik = { gabunganPerBulan: new Map([["2026-10", new Map([["A", "B"], ["B", "C"], ["C", "A"]])]]) };
    assert.throws(() => orangDariKode("A", D, siklik), /siklik/);
    assert.throws(() => orangDariKode("B", D, siklik), /siklik/);
    assert.equal(orangDariKode("X", D, { gabunganPerBulan: new Map([["2026-10", new Map([["X", "X"]])]]) }), "X", "peta ke diri sendiri = tanpa gabungan");

    assert.throws(() => klop(Rp(-1), 0), RangeError);
    assert.throws(() => klop(Rp(1), Rp(-1)), RangeError);
    const hari = (setoran: SetoranRevisi[]) => rekonsiliasiHari({ tanggal: D, peta: PETA, pelunasan: [], setoran });
    assert.throws(() => hari([setor("S-A", -1)]), RangeError, "setoran negatif");
    assert.throws(() => hari([setor("S-A", 0, -5)]), RangeError, "transfer negatif");
    assert.throws(() => hari([setor("S-A", 1, 0, 0, 1), setor("S-A", 1, 0, 0, 3)]), /revisi/, "revisi 2 hilang");
    assert.throws(() => hari([setor("S-A", 1, 0, 0, 2)]), /revisi/, "tanpa revisi 1");
    assert.throws(() => hari([setor("S-A", 1, 0, 0, 0)]), /revisi/, "revisi 0");
    assert.throws(() => hari([setor("S-A", 1, 0, 0, 1.5)]), /revisi/, "revisi bukan bulat");

    const tutup: EventHari = { id: 1, jenis: "tutup", pada: "2026-10-05T17:42:00+08:00" };
    const bukaIso = (pada: string): EventHari => ({ id: 2, jenis: "buka", pada, alasan: "Setoran MKS-03 susulan salah dicatat" });
    assert.equal(statusHari(D, [tutup, bukaIso("2026-10-06T01:00:00Z")], wita("2026-10-06T19:00:00")).terkunci, false, "ISO Z diterima");
    assert.equal(statusHari(D, [tutup, bukaIso("2026-10-06T09:00:00.123+08:00")], wita("2026-10-06T19:00:00")).terkunci, false, "ISO +08:00 diterima");
    for (const salah of ["2026-10-06T09:00:00", "2026-10-06 09:00:00+08", "06/10/2026 09:00", ""]) {
        assert.throws(() => statusHari(D, [tutup, bukaIso(salah)], wita("2026-10-06T19:00:00")), /ofset|waktu/, `pada ${JSON.stringify(salah)}`);
    }
    assert.throws(() => statusHari(D, [{ ...tutup, pada: new Date(Number.NaN) }], wita("2026-10-06T19:00:00")), /waktu/i, "Date tidak sah");
});

test("hari kerja Senin–Sabtu", () => {
    assert.deepEqual(["2026-10-04", "2026-10-05", "2026-10-10", "2026-10-11"].map(hariKerja), [false, true, true, false]);
});
