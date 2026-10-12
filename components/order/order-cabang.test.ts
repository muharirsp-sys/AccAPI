/* O2: uji logika murni Order per cabang — kode galat O1 -> kalimat + tindakan (bukan kode mentah), jawaban tidak pasti, URL pencarian,
 * bacaan pelanggan/barang dari bentuk kontrak, baris terbuang saat ganti pelanggan beda cabang, promo per baris/order dari pratinjau. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MIN_HURUF, bacaBarang, bacaPelanggan, barisBedaCabang, cukupHuruf, galatDariJawaban, hargaCabangDefault, hargaPetugasSah, kalimatGalat, kunciHarga, labelSatuan, pratinjauBerubah, promoBaris, ringkasPromo,
    urlCariBarang, urlCariPelanggan, urlSalesmanCabang, type Result,
} from "./order-cabang.ts";

const jawab = (status: number, data: Record<string, unknown> | null) => ({ status, data });

test("pencarian: minimal 2 huruf (spasi tidak dihitung); URL tanpa parameter kosong", () => {
    assert.equal(MIN_HURUF, 2);
    assert.equal(cukupHuruf(""), false);
    assert.equal(cukupHuruf(" a "), false);
    assert.equal(cukupHuruf("ab"), true);
    assert.equal(urlCariPelanggan({ q: " toko a ", branchId: 5, limit: 20 }), "/api/customers/search?q=toko+a&branchId=5&limit=20");
    assert.equal(urlCariPelanggan({ limit: 1 }), "/api/customers/search?limit=1");
    assert.equal(urlCariPelanggan({ q: "", branchId: null }), "/api/customers/search");
    assert.equal(urlCariBarang({ q: "A-1", customerId: 7, tanggal: "2026-10-12" }), "/api/items/search?q=A-1&customerId=7&tanggal=2026-10-12");
    assert.equal(urlSalesmanCabang(5), "/api/orders/salesmen?branchId=5");
    assert.equal(urlSalesmanCabang(null), "/api/orders/salesmen");
});

test("tiap kode galat O1 menjadi kalimat + tindakan, bukan kode mentah", () => {
    const KODE = ["SALESMAN_BELUM_TERHUBUNG", "SALESMAN_TIDAK_AKTIF", "CABANG_DI_LUAR_CAKUPAN", "PELANGGAN_WAJIB", "PELANGGAN_TIDAK_ADA", "PELANGGAN_SUSPENDED",
        "PELANGGAN_TANPA_CABANG", "BARANG_TIDAK_ADA", "BARANG_SUSPENDED", "BARANG_BEDA_CABANG", "SATUAN_SALAH", "HARGA_BELUM_ADA", "INPUT_TIDAK_VALID", "TIDAK_DIIZINKAN", "SALESMAN_BEDA_CABANG",
        "IZIN_TIDAK_KONSISTEN", "SIDIK_WAJIB", "PRATINJAU_BERUBAH", "CHANNEL_BEDA_MASTER", "ORDER_GANDA", "ATURAN_BELUM_TERBIT", "DATA_TIDAK_VALID", "HARGA_TIDAK_VALID", "KONFIGURASI_SERVER", "LAYANAN_TIDAK_PASTI"];
    for (const kode of KODE) {
        for (const peran of ["sales", "petugas"] as const) {
            const g = galatDariJawaban(jawab(409, { ok: false, kode, error: "Teks server untuk PELANGGAN A." }), peran);
            assert.equal(g.kode, kode);
            assert.ok(g.judul.length > 8 && g.tindakan.length > 8 && g.pesan.length > 8, kode);
            assert.doesNotMatch(`${g.judul} ${g.tindakan}`, /[A-Z]{4,}_[A-Z_]{3,}/, `${kode}: kode mentah bocor ke kalimat`);
            assert.equal(g.tidakPasti, kode === "LAYANAN_TIDAK_PASTI", kode);
        }
    }
});

test("salesman belum terhubung / tidak aktif = blokir layar, kalimat 'hubungi Admin'; kode lain tidak memblokir layar", () => {
    const a = galatDariJawaban(jawab(403, { ok: false, kode: "SALESMAN_BELUM_TERHUBUNG", error: "x" }), "sales");
    assert.equal(a.blokirSales, true);
    assert.match(a.judul, /belum dihubungkan ke karyawan Accurate/);
    assert.match(a.tindakan, /Hubungi Admin/);
    assert.equal(galatDariJawaban(jawab(403, { ok: false, kode: "SALESMAN_TIDAK_AKTIF" }), "sales").blokirSales, true);
    assert.equal(galatDariJawaban(jawab(403, { ok: false, kode: "CABANG_DI_LUAR_CAKUPAN", error: "di luar cabang" }), "sales").blokirSales, false);
});

test("tindakan HARGA_BELUM_ADA berbeda: sales tidak bisa kirim, petugas boleh isi manual", () => {
    const s = galatDariJawaban(jawab(409, { kode: "HARGA_BELUM_ADA", error: "x", missing: ["A-1"] }), "sales");
    const p = galatDariJawaban(jawab(409, { kode: "HARGA_BELUM_ADA", error: "x", missing: ["A-1"] }), "petugas");
    assert.match(s.tindakan, /belum bisa dikirim/);
    assert.match(p.tindakan, /manual/);
    assert.match(s.perBarang["A-1"], /Harga belum ada/);
});

test("BARANG_BEDA_CABANG: kalimat per barang menyebut cabang asal atau 'tanpa cabang' + tag non-jual", () => {
    const g = galatDariJawaban(jawab(409, { ok: false, kode: "BARANG_BEDA_CABANG", error: "Barang bukan barang cabang CABANG A", barang: [
        { code: "B-1", name: "BARANG B", branchId: 9, branchName: "CABANG B", tag: "X" },
        { code: "N-1", name: "BARANG N", branchId: null, branchName: null, tag: "ASSET" },
    ] }));
    assert.match(g.perBarang["B-1"], /BARANG B milik cabang CABANG B, bukan cabang pelanggan/);
    assert.match(g.perBarang["N-1"], /tanpa cabang \(tag "ASSET" tidak bisa diorder\)/);
    assert.equal(g.menolak, true);
});

test("SATUAN_SALAH: per baris menyebut satuan yang tersedia", () => {
    const g = galatDariJawaban(jawab(409, { kode: "SATUAN_SALAH", error: "x", wrong_unit: [{ code: "A-1", unit: "PCS", known_units: ["KRT", "LSN"] }] }));
    assert.equal(g.perBarang["A-1"], "Satuan PCS tidak ada; pilih KRT atau LSN.");
});

test("jawaban tidak pasti (putus, >= 502, bukan JSON) = belum pasti, tidak pernah galat aturan; kode admin `code` dibaca juga", () => {
    for (const [status, data] of [[0, null], [502, { ok: false }], [504, null], [200, null], [409, null]] as const) {
        const g = galatDariJawaban(jawab(status, data));
        assert.equal(g.tidakPasti, true, `status ${status}`);
        assert.equal(g.menolak, false);
    }
    assert.match(galatDariJawaban(jawab(0, null)).judul, /Tidak tersambung/);
    assert.equal(galatDariJawaban(jawab(409, { code: "PELANGGAN_SUSPENDED", error: "Nonaktif" })).kode, "PELANGGAN_SUSPENDED");
    assert.equal(galatDariJawaban(jawab(401, { error: "x" })).kode, "SESI_BERAKHIR");
    const baru = galatDariJawaban(jawab(409, { kode: "KODE_BARU", error: "Teks server baru." }));
    assert.equal(baru.pesan, "Teks server baru.");
    assert.equal(baru.menolak, false);
    assert.match(kalimatGalat(baru), /Teks server baru\. /);
});

test("bacaPelanggan/bacaBarang: bentuk kontrak; baris rusak dibuang; harga 0/kosong = belum ada", () => {
    const p = bacaPelanggan({ id: 3, customerNo: "C-01", name: "PELANGGAN A", branchId: 5, branchName: "CABANG A", categoryName: "General Trade", channel: "gt", priceCategoryName: "GROSIR", alamat: null });
    assert.deepEqual(p, { id: 3, customerNo: "C-01", name: "PELANGGAN A", branchId: 5, branchName: "CABANG A", channel: "GT", categoryName: "General Trade", priceCategoryName: "GROSIR", alamat: null });
    assert.equal(bacaPelanggan({ id: 3, customerNo: "", branchId: 5 }), null);
    assert.equal(bacaPelanggan({ customerNo: "C-01", branchId: 5 }), null);
    const b = bacaBarang({ id: 1, no: "A-1", name: "BARANG A", branchId: 5, branchName: "CABANG A", tag: "TAG A", units: [
        { unit: "KRT", price: 576000, source: "tier", branchName: "CABANG A", effectiveDate: "2026-10-01" }, { unit: "PCS", price: 0 }, { unit: "" }, { unit: "LSN", price: null },
    ] }, "3|2026-10-12");
    assert.deepEqual(b?.units.map((u) => [u.unit, u.price]), [["KRT", 576000], ["PCS", null], ["LSN", null]]);
    assert.equal(b?.hargaUntuk, "3|2026-10-12");
    assert.deepEqual(bacaBarang({ id: 1, no: "A-1", units: [] }, "k")?.units, []);
    assert.equal(bacaBarang({ no: "A-1" }, "k"), null);
});

test("label satuan: harga tampil hanya selama masih berlaku untuk pelanggan+tanggal; kosong = 'harga belum ada'", () => {
    const f = (n: number) => `Rp ${n}`;
    assert.equal(labelSatuan({ unit: "KRT", price: 576000 }, true, f), "KRT · Rp 576000");
    assert.equal(labelSatuan({ unit: "KRT", price: 576000 }, false, f), "KRT");
    assert.equal(labelSatuan({ unit: "PCS", price: null }, true, f), "PCS · harga belum ada");
    assert.notEqual(kunciHarga(3, "2026-10-12"), kunciHarga(3, "2026-10-13"));
    assert.notEqual(kunciHarga(3, "2026-10-12"), kunciHarga(4, "2026-10-12"));
});

test("ganti pelanggan beda cabang: baris berbarang cabang lain dibuang (tidak diam); baris kosong dibiarkan", () => {
    const baris = (code: string, branchId: number | null) => ({ code, barang: code ? { branchId } : null });
    const lines = [baris("A-1", 5), baris("B-1", 9), baris("", null), baris("X-1", null)];
    const r = barisBedaCabang(lines, 9);
    assert.deepEqual(r.dibuang.map((l) => l.code), ["A-1", "X-1"]);
    assert.deepEqual(r.tersisa.map((l) => l.code), ["B-1", ""]);
    assert.deepEqual(barisBedaCabang(lines, 5).dibuang.map((l) => l.code), ["B-1", "X-1"]);
    assert.equal(barisBedaCabang([baris("", null)], 5).dibuang.length, 0);
});

const HASIL: Result = {
    gross: "1500000.00", discount: "150000.00", net: "1350000.00",
    lines: [
        { code: "A-1", unit: "KRT", quantity: "2", gross: "1152000.00", net: "1036800.00", percents: ["10"], cash: "0.00" },
        { code: "B-1", unit: "LSN", quantity: "6", gross: "348000.00", net: "348000.00", percents: [], cash: "0.00" },
    ],
    applications: [{ program_id: "p1", minimum: "1", discount: "115200.00" }, { program_id: "abcdef123456", minimum: "5", discount: "34800.00" }],
    bonuses: [{ program_id: "p1", code: "", unit: "PCS", quantity: "2", eligible_codes: ["A-1"] }, { program_id: "p2", code: "G-9", unit: "PCS", quantity: "1" }],
    blocked: [{ program_id: "p3", program_name: "PROMO C", reason: "khusus outlet MT" }],
};

test("promo per baris: diskon = bruto - netto, persen berantai, bonus dari barang dibeli menempel di barang yang memenuhi syarat", () => {
    const a = promoBaris(HASIL, "A-1", "KRT")!;
    assert.equal(a.diskon, 115200);
    assert.deepEqual(a.persen, ["10"]);
    assert.deepEqual(a.bonus.map((b) => b.quantity), ["2"]);
    const b = promoBaris(HASIL, "B-1", "LSN")!;
    assert.equal(b.diskon, 0);
    assert.deepEqual(b.bonus, []);
    assert.equal(promoBaris(HASIL, "A-1", "PCS"), null);
    assert.equal(promoBaris(null, "A-1", "KRT"), null);
});

test("ringkasan promo: nama program dari saran/diblokir bila ada, selain itu #id pendek; bonus berkode barang sendiri terpisah", () => {
    const r = ringkasPromo(HASIL, [{ program_id: "p1", program_name: "PROMO A", message: "m", codes: ["A-1"] }])!;
    assert.equal(r.diskon, 150000);
    assert.equal(r.net, 1350000);
    assert.deepEqual(r.program.map((p) => p.nama), ["PROMO A", "Program #abcdef12"]);
    assert.deepEqual(r.bonusLain, [{ nama: "Program #p2", kode: "G-9", unit: "PCS", jumlah: "1" }]);
    assert.deepEqual(r.tidakBerlaku, [{ nama: "PROMO C", alasan: "khusus outlet MT" }]);
    assert.equal(ringkasPromo(null), null);
});

test("503 berkode: KONFIGURASI_SERVER = pasti tidak tersimpan (bukan 'sesi berakhir', bukan 'belum pasti'); LAYANAN_TIDAK_PASTI = belum pasti; 502/503 tanpa kode = belum pasti", () => {
    const k = galatDariJawaban(jawab(503, { ok: false, kode: "KONFIGURASI_SERVER", detail: "CRON_SECRET belum di-set" }));
    assert.equal(k.tidakPasti, false);
    assert.match(k.judul, /Konfigurasi server/);
    assert.match(k.tindakan, /Hubungi Admin/);
    assert.doesNotMatch(`${k.judul} ${k.pesan} ${k.tindakan}`, /sesi login berakhir/i);
    const l = galatDariJawaban(jawab(503, { ok: false, kode: "LAYANAN_TIDAK_PASTI", detail: "Next tidak menjawab" }));
    assert.equal(l.tidakPasti, true);
    assert.match(l.tindakan, /Muat ulang/);
    assert.equal(galatDariJawaban(jawab(503, { detail: "x" })).tidakPasti, true);
    assert.equal(galatDariJawaban(jawab(502, { ok: false, kode: "LAYANAN_TIDAK_PASTI", error: "Layanan promo tidak dapat dihubungi" })).tidakPasti, true);
    assert.equal(galatDariJawaban(jawab(500, { ok: false, error: "x" })).tidakPasti, false);
});

test("kalimat simpan/promo: SIDIK_WAJIB, PRATINJAU_BERUBAH, CHANNEL_BEDA_MASTER (kalimat server dibawa), ORDER_GANDA beda tindakan sales/petugas", () => {
    assert.match(galatDariJawaban(jawab(400, { kode: "SIDIK_WAJIB", detail: "x" })).tindakan, /Tunggu perkiraan/);
    const b = galatDariJawaban(jawab(409, { kode: "PRATINJAU_BERUBAH", detail: "x" }));
    assert.match(b.judul, /Hitungan berubah/);
    assert.match(b.tindakan, /simpan lagi/);
    const c = galatDariJawaban(jawab(422, { kode: "CHANNEL_BEDA_MASTER", detail: "Channel outlet C-01 menurut master MT, bukan GT" }));
    assert.match(c.pesan, /menurut master MT, bukan GT/);
    assert.match(galatDariJawaban(jawab(409, { kode: "ORDER_GANDA", detail: "Mirip dengan order lain" }), "petugas").tindakan, /centang konfirmasi/);
    assert.match(galatDariJawaban(jawab(409, { kode: "ORDER_GANDA", detail: "Mirip dengan order lain" }), "sales").tindakan, /Order saya/);
    assert.match(galatDariJawaban(jawab(400, { kode: "HARGA_TIDAK_VALID", error: "x", barang: ["A-2"] })).tindakan, /kosongkan untuk memakai harga master/);
});

test("harga petugas sah: angka > 0, titik desimal maks 4, tanpa titik ribuan/koma/negatif", () => {
    for (const ok of ["1", "15000", "0.5", "12.3456", " 700 "]) assert.equal(hargaPetugasSah(ok), true, ok);
    for (const salah of ["", "0", "0.0000", "-5", "abc", "1.234,5", "1,5", "12.34567", "1e3", "1.", ".5"]) assert.equal(hargaPetugasSah(salah), false, salah);
});

test("PRATINJAU_BERUBAH membawa pratinjau baru: netto + sidik terbaca; bentuk lain = null", () => {
    const j = jawab(409, { ok: false, kode: "PRATINJAU_BERUBAH", detail: "x", pratinjau: { lines: [], result: { net: "1350000.00" }, sources: [], sidik: "abc123" } });
    assert.deepEqual(pratinjauBerubah(j), { net: 1350000, sidik: "abc123" });
    assert.equal(pratinjauBerubah(jawab(409, { kode: "PRATINJAU_BERUBAH" })), null);
    assert.equal(pratinjauBerubah(jawab(409, { kode: "ORDER_GANDA" })), null);
    assert.equal(pratinjauBerubah(jawab(500, null)), null);
});

test("BONUS_TIDAK_BISA_DIORDER: kalimat menyebut kode barang bonus + alasan; tanpa daftar barang memakai kalimat server", () => {
    const g = galatDariJawaban(jawab(409, { ok: false, kode: "BONUS_TIDAK_BISA_DIORDER", error: "x", barang: ["G-9", { code: "G-8" }], alasan: "suspended" }));
    assert.match(g.pesan, /barang bonus G-9, G-8 tidak bisa dipakai \(suspended\)/);
    assert.match(g.tindakan, /Hubungi Admin.*Summary promo/);
    assert.equal(g.menolak, true);
    assert.equal(galatDariJawaban(jawab(409, { kode: "BONUS_TIDAK_BISA_DIORDER", error: "Teks server bonus" })).pesan, "Teks server bonus");
});

test("harga cabang default: source master_default atau cabang harga != cabang pelanggan; harga petugas tidak pernah", () => {
    assert.equal(hargaCabangDefault({ source: "master_default", branchName: "CABANG DEFAULT" }, "CABANG A"), true);
    assert.equal(hargaCabangDefault({ source: "tier", branchName: "CABANG DEFAULT" }, "CABANG A"), true);
    assert.equal(hargaCabangDefault({ source: "tier", branchName: "CABANG A" }, "CABANG A"), false);
    assert.equal(hargaCabangDefault({ source: "petugas", branchName: "CABANG B" }, "CABANG A"), false);
    assert.equal(hargaCabangDefault({ source: "tier", branchName: null }, "CABANG A"), false);
    assert.equal(hargaCabangDefault(undefined, "CABANG A"), false);
});
