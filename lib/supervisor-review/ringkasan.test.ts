/* Supervisor Review — perhitungan MURNI (spec §2, §4 WhatsApp/peta, §3.3 koordinat). Data contoh generik (SALES A, CABANG A). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineM, hitungRingkasan, periksaKoordinat, waUrl, type MasukanRingkasan } from "./ringkasan.ts";

const utc = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00Z`); // checkin_at tersimpan UTC (probe produksi 14 Okt)
const TOKO_C1 = { lat: -5.1477, lng: 119.4327 };

// 12 Okt 2026 = Senin minggu GENAP (acuan paritas). Rencana SALES A: C-1 (all) + C-2 (genap); C-3 Selasa, C-4 ganjil = bukan hari ini.
const MASUK: MasukanRingkasan = {
    tanggal: "2026-10-12",
    salesman: [
        { salesCode: "M-SLC", nama: "SALES C", cabang: "CABANG B", noHp: null },
        { salesCode: "M-SLB", nama: "SALES B", cabang: "CABANG A", noHp: "0812-0000-0002" },
        { salesCode: "M-SLA", nama: "SALES A", cabang: "CABANG A", noHp: "+62 812-3456-7890" },
    ],
    jks: [
        { salesCode: "M-SLA", custCode: "C-1", custName: "TOKO A", hariKunjungan: "SENIN", mingguPattern: "all" },
        { salesCode: "M-SLA", custCode: "C-2", custName: "TOKO B", hariKunjungan: " Senin ", mingguPattern: "GENAP" },
        { salesCode: "M-SLA", custCode: "C-3", custName: "TOKO C", hariKunjungan: "Selasa", mingguPattern: "all" },
        { salesCode: "M-SLA", custCode: "C-4", custName: "TOKO D", hariKunjungan: "Senin", mingguPattern: "ganjil" },
        { salesCode: "M-SLB", custCode: "C-20", custName: "TOKO E", hariKunjungan: "Senin", mingguPattern: "all" },
    ],
    ao: [
        // C-1 dua baris (dua principal) = SATU kunjungan; ORDER + faktur -> EC sekali.
        { salesCode: "M-SLA", custCode: "C-1", status: "ordered", checkinAt: utc("01:00"), checkoutAt: utc("01:30"), lat: -5.1477, lng: 119.4328 },
        { salesCode: "M-SLA", custCode: "C-1", status: "not_order", checkinAt: utc("01:05"), checkoutAt: utc("01:20"), lat: null, lng: null },
        { salesCode: "M-SLA", custCode: "C-9", status: "not_order", checkinAt: utc("02:00"), checkoutAt: utc("02:20"), lat: -5.2, lng: 119.5 },
        // SALES B: masih di toko, ORDER belum difakturkan.
        { salesCode: "M-SLB", custCode: "C-20", status: "ordered", checkinAt: utc("03:00"), checkoutAt: null, lat: null, lng: null },
        // Baris tanpa check-in (belum dikunjungi) tidak dihitung kunjungan.
        { salesCode: "M-SLB", custCode: "C-21", status: "not_visited", checkinAt: null, checkoutAt: null, lat: null, lng: null },
    ],
    luarRute: [{ salesCode: "M-SLA", custCode: "C-9", custName: "TOKO LUAR A" }],
    noo: [{ salesCode: "M-SLA" }],
    faktur: [
        { salesCode: "M-SLA", cabang: "CABANG A", customerNo: "C-1-CBA", customerName: "TOKO A {C-1}", qty: 10, item: 2, dpp: 100000 },
        { salesCode: "M-SLA", cabang: "CABANG A", customerNo: "C-5-CBA", customerName: "TOKO F", qty: 5, item: 1, dpp: 50000 },
        { salesCode: "", cabang: "CABANG A", customerNo: "C-7-CBA", customerName: "TOKO G", qty: 2, item: 1, dpp: 20000 },
        { salesCode: null, cabang: "CABANG B", customerNo: "C-8-CBB", customerName: "TOKO H", qty: 0, item: 0, dpp: 0 },
    ],
    koordinat: new Map([["C-1", TOKO_C1], ["C-2", { lat: -5.15, lng: 119.44 }], ["C-5", { lat: -5.16, lng: 119.45 }]]),
};

test("ringkasan: setiap kolom §2 per salesman (EC gabungan sekali, faktur tanpa check-in = Non Rute + EC, Time Travel, status)", () => {
    const r = hitungRingkasan(MASUK);
    const a = r.salesman.find((s) => s.salesCode === "M-SLA")!;
    assert.deepEqual({ ...a, waUrl: undefined }, {
        cabang: "CABANG A", salesCode: "M-SLA", nama: "SALES A", status: "sudah", waUrl: undefined,
        registeredOutlet: 4, callPlan: 2, callRute: 1, callNonRute: 2, ec: 2, noo: 1, quantity: 15, itemPerEc: 1.5,
        nilaiOrder: 150000, omzetPerEc: 75000, jamDiToko: 0.83, jamPerjalanan: 0.5,
    });
    const b = r.salesman.find((s) => s.salesCode === "M-SLB")!;
    assert.equal(b.status, "di_toko");
    assert.deepEqual([b.callPlan, b.callRute, b.callNonRute, b.ec, b.quantity, b.nilaiOrder, b.jamDiToko, b.jamPerjalanan], [1, 1, 0, 1, 0, 0, 0, 0]);
    const c = r.salesman.find((s) => s.salesCode === "M-SLC")!;
    assert.equal(c.status, "belum");
    assert.equal(c.waUrl, null, "tanpa No HP = tombol nonaktif");
    assert.deepEqual([c.registeredOutlet, c.ec, c.itemPerEc, c.omzetPerEc], [0, 0, 0, 0], "EC 0 -> rasio 0, bukan NaN");
});

test("ringkasan: urutan per cabang, baris 'Tanpa salesman terpetakan', TOTAL cabang dihitung dari jumlah (bukan rata-rata rasio)", () => {
    const r = hitungRingkasan(MASUK);
    assert.deepEqual(r.salesman.map((s) => [s.cabang, s.salesCode, s.nama]), [
        ["CABANG A", "M-SLA", "SALES A"], ["CABANG A", "M-SLB", "SALES B"], ["CABANG A", "", "Tanpa salesman terpetakan"], ["CABANG B", "M-SLC", "SALES C"],
    ]);
    const tanpa = r.salesman.find((s) => s.salesCode === "")!;
    assert.deepEqual([tanpa.ec, tanpa.callNonRute, tanpa.nilaiOrder, tanpa.waUrl], [1, 1, 20000, null]);
    const tA = r.totalCabang.find((t) => t.cabang === "CABANG A")!;
    assert.deepEqual([tA.callPlan, tA.ec, tA.quantity, tA.nilaiOrder, tA.itemPerEc, tA.omzetPerEc], [3, 4, 17, 170000, 1, 42500]);
    assert.deepEqual(r.totalCabang.map((t) => t.cabang), ["CABANG A", "CABANG B"]);
    assert.deepEqual(r.fakturBelumTerbaca, [{ cabang: "CABANG B", jumlah: 1 }], "faktur rincian belum terbaca terlihat per cabang");
});

test("ringkasan: rincian kunjungan (jam WITA, menit, tempuh, belum difakturkan, tanpa check-in di akhir, jarak)", () => {
    const k = hitungRingkasan(MASUK).kunjungan.filter((x) => x.salesCode === "M-SLA");
    assert.deepEqual(k.map((x) => [x.custCode, x.jenis, x.mulai, x.selesai, x.menitDiToko, x.menitTempuh, x.qty, x.item, x.nilai, x.ec, x.belumDifakturkan]), [
        ["C-1", "rute", "2026-10-12T09:00:00+08:00", "2026-10-12T09:30:00+08:00", 30, null, 10, 2, 100000, true, false],
        ["C-9", "luar_rute", "2026-10-12T10:00:00+08:00", "2026-10-12T10:20:00+08:00", 20, 30, null, null, null, false, false],
        ["C-5-CBA", "tanpa_checkin", null, null, null, null, 5, 1, 50000, true, false],
    ]);
    assert.equal(k[0].namaToko, "TOKO A");
    assert.equal(k[1].namaToko, "TOKO LUAR A");
    assert.equal(k[0].jarakKeTokoM, 11, "check-in ±11 m dari koordinat toko");
    assert.equal(k[1].jarakKeTokoM, null, "toko tanpa koordinat");
    const b = hitungRingkasan(MASUK).kunjungan.filter((x) => x.salesCode === "M-SLB");
    assert.deepEqual(b.map((x) => [x.custCode, x.selesai, x.ec, x.belumDifakturkan, x.qty]), [["C-20", null, true, true, null]]);
    const urut = hitungRingkasan(MASUK).kunjungan.map((x) => x.salesCode);
    assert.deepEqual(urut, [...urut].sort(), "urut salesCode");
});

test("ringkasan: penanda peta hanya toko berkoordinat (ec / belum / faktur tanpa check-in) + jumlah toko JKS tanpa koordinat", () => {
    const r = hitungRingkasan(MASUK);
    assert.deepEqual(r.penanda.map((p) => [p.salesCode, p.custCode, p.status, p.lat, p.lng]).sort(), [
        ["M-SLA", "C-1", "ec", -5.1477, 119.4327],
        ["M-SLA", "C-2", "belum", -5.15, 119.44],
        ["M-SLA", "C-5-CBA", "faktur_tanpa_checkin", -5.16, 119.45],
    ]);
    assert.equal(r.tokoTanpaKoordinat, 3, "C-3, C-4, C-20");
});

test("WhatsApp: nomor 08…/+62… dinormalkan ke 628…; teks memuat angka + toko terjadwal belum dikunjungi (maks 15, lalu 'dan N lainnya')", () => {
    const a = hitungRingkasan(MASUK).salesman.find((s) => s.salesCode === "M-SLA")!;
    const u = new URL(a.waUrl!);
    assert.equal(`${u.origin}${u.pathname}`, "https://wa.me/6281234567890");
    const teks = u.searchParams.get("text")!;
    for (const s of ["12/10/2026", "SALES A", "Call Plan: 2", "Call Rute: 1", "Call Non Rute: 2", "EC: 2", "Nilai Order: Rp 150.000", "C-2 TOKO B"]) {
        assert.ok(teks.includes(s), `teks WA tanpa "${s}":\n${teks}`);
    }
    assert.ok(!teks.includes("C-1 TOKO A"), "toko yang sudah dikunjungi tidak didaftar");
    const banyak = hitungRingkasan({ ...MASUK, ao: [], faktur: [], jks: Array.from({ length: 17 }, (_, i) => ({ salesCode: "M-SLA", custCode: `C-${100 + i}`,
        custName: `TOKO ${i}`, hariKunjungan: "Senin", mingguPattern: "all" })) }).salesman.find((s) => s.salesCode === "M-SLA")!;
    const t2 = new URL(banyak.waUrl!).searchParams.get("text")!;
    assert.equal(t2.split("\n").filter((l) => l.startsWith("- ")).length, 15);
    assert.ok(t2.includes("dan 2 lainnya"), t2);
    assert.equal(waUrl("0812-3456", "x"), null, "nomor tidak sah = null");
    assert.equal(waUrl("081234567890", "a b"), "https://wa.me/6281234567890?text=a%20b");
});

test("haversine: 1° bujur di khatulistiwa ±111,2 km; titik sama = 0", () => {
    assert.equal(Math.round(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })), 111195);
    assert.equal(haversineM(TOKO_C1, TOKO_C1), 0);
});

test("periksaKoordinat: tolak per baris (kode bukan JKS, bukan angka, di luar Indonesia, ganda); baris sah tetap; koma desimal diterima", () => {
    const jks = new Map([["C-1", "C-1"], ["C-2", "C-2"], ["C-3", "C-3"]]);
    const hasil = periksaKoordinat([
        { baris: 2, kode: " c-1 ", lat: -5.1477, lng: 119.4327 },
        { baris: 3, kode: "C-404", lat: -5, lng: 119 },
        { baris: 4, kode: "C-2", lat: "abc", lng: 119 },
        { baris: 5, kode: "C-3", lat: 40.7, lng: -74 },
        { baris: 6, kode: "C-1", lat: -5, lng: 119 },
        { baris: 7, kode: "C-3", lat: "-5,25", lng: "119,5" },
        { baris: 8, kode: "", lat: "", lng: "" },
    ], jks);
    assert.deepEqual(hasil.sah, [{ custCode: "C-1", lat: -5.1477, lng: 119.4327 }, { custCode: "C-3", lat: -5.25, lng: 119.5 }]);
    assert.deepEqual(hasil.ditolak.map((d) => [d.baris, d.kode]), [[3, "C-404"], [4, "C-2"], [5, "C-3"], [6, "C-1"]]);
    for (const d of hasil.ditolak) assert.ok(d.pesan.length > 5);
});
