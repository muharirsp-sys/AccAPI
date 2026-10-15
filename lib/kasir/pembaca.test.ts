/* K1b (BL-59) lib murni pembaca pelunasan Accurate: list.do fail-closed berlapis, urai detail.do -> Pelunasan, rencana baca per id,
 * kelas galat + jadwal ulang, status akhir, tanggal cron. Tanpa I/O (fungsi ambil disuntik). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bacaDaftar, bacaRetryAfter, dariTanggalAccurate, GalatBaca, kelasGalat, keTanggalAccurate, kueriDaftar, MAKS_HALAMAN, PESAN_SESI_SINKRON,
    hapusMassal, rencanaBaca, saringPesan, segarUntukTutup, statusAkhir, tanggalCron, tundaUlang, uraiDetail, type BarisDaftar,
} from "./pembaca.ts";

const D = "2026-10-05";
const DA = "05/10/2026";
const baris = (id: number, lastUpdate = `05/10/2026 09:${String(id % 60).padStart(2, "0")}:00`) =>
    ({ id, number: `SR/${id}`, transDate: DA, paymentMethod: "CASH_OTHER", chequeAmount: 1000, lastUpdate });
const hal = (rows: unknown[], rowCount: number, pageCount: number | string | undefined) =>
    ({ s: true, d: rows, sp: { rowCount, ...(pageCount === undefined ? {} : { pageCount }) } });

/** Simulator halaman: `jawab(halaman, panggilanKe)` -> badan; mencatat urutan halaman yang diminta. */
function sim(jawab: (h: number, ke: number) => unknown) {
    const diminta: number[] = [];
    return { diminta, ambil: async (h: number) => { diminta.push(h); return jawab(h, diminta.length); } };
}
const galat = (kelas: string, pola?: RegExp) => (e: unknown) => e instanceof GalatBaca && e.kelas === kelas && (!pola || pola.test(e.message));

test("kueriDaftar: filter transDate SAJA dd/MM/yyyy, 100/halaman, urut id naik, fields sempit", () => {
    assert.deepEqual(kueriDaftar(D, 3), {
        fields: "id,number,transDate,paymentMethod,chequeAmount,lastUpdate", "filter.transDate.op": "EQUAL", "filter.transDate.val": DA,
        "sp.pageSize": "100", "sp.sort": "id|asc", "sp.page": "3",
    });
    assert.equal(keTanggalAccurate("2026-01-31"), "31/01/2026");
    for (const salah of ["2026-02-30", "05/10/2026", "2026-1-5", ""]) assert.throws(() => keTanggalAccurate(salah), /tanggal/);
    assert.equal(dariTanggalAccurate(" 05/10/2026 "), D);
    assert.equal(dariTanggalAccurate("31/02/2026"), null);
    assert.equal(dariTanggalAccurate("2026-10-05"), null);
});

test("bacaDaftar: hari ramai 824 pelunasan / 9 halaman dibaca berurutan, semua id unik", async () => {
    const semua = Array.from({ length: 824 }, (_, i) => baris(5000 + i));
    const s = sim((h) => hal(semua.slice((h - 1) * 100, h * 100), 824, 9));
    const d = await bacaDaftar(D, s.ambil);
    assert.equal(d.length, 824);
    assert.deepEqual(s.diminta, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(d[0], { id: 5000, nomor: "SR/5000", lastUpdate: semua[0].lastUpdate });
});

test("bacaDaftar fail-closed: pageCount hilang / 0 dengan baris / menyusut, halaman kosong di tengah, > batas halaman", async () => {
    await assert.rejects(bacaDaftar(D, sim(() => hal([baris(1)], 1, undefined)).ambil), galat("terpotong", /pageCount/), "pageCount hilang");
    await assert.rejects(bacaDaftar(D, sim(() => hal([baris(1)], 1, "")).ambil), galat("terpotong"), "pageCount teks kosong");
    await assert.rejects(bacaDaftar(D, sim(() => hal([baris(1)], 1, 0)).ambil), galat("terpotong"), "pageCount 0 padahal ada baris");
    assert.deepEqual(await bacaDaftar(D, sim(() => hal([], 0, 0)).ambil), [], "hari kosong: 0 halaman + 0 baris sah");
    assert.equal((await bacaDaftar(D, sim((h) => hal([baris(h)], 2, "2")).ambil)).length, 2, "pageCount teks angka diterima");
    // Halaman 1 mengumumkan 3, halaman 2 kosong ber-pageCount 0: jumlah halaman tidak boleh turun -> halaman 3 tak pernah dilewati.
    const menyusut = sim((h) => (h === 1 ? hal(Array.from({ length: 100 }, (_, i) => baris(i + 1)), 250, 3) : hal([], 250, 0)));
    await assert.rejects(bacaDaftar(D, menyusut.ambil), galat("terpotong", /kosong sebelum halaman terakhir/));
    const tengah = sim((h) => hal(h === 2 ? [] : [baris(h)], 3, 3));
    await assert.rejects(bacaDaftar(D, tengah.ambil), galat("terpotong", /kosong/), "halaman kosong di tengah");
    const tanpaRow = sim(() => ({ s: true, d: [baris(1)], sp: { pageCount: 1 } }));
    await assert.rejects(bacaDaftar(D, tanpaRow.ambil), galat("terpotong", /rowCount/), "tanpa rowCount kelengkapan tak terbukti");
    const banyak = sim((h) => hal([baris(h)], 100_000, 1000));
    await assert.rejects(bacaDaftar(D, banyak.ambil), galat("terpotong", new RegExp(`> ${MAKS_HALAMAN} halaman`)));
    assert.equal(banyak.diminta.length, MAKS_HALAMAN, "berhenti di pagar, tidak menyapu riwayat");
});

test("bacaDaftar: rowCount bergeser -> daftar diulang SEKALI (lalu sah); bergeser lagi -> terpotong; id ganda dibuang", async () => {
    // Putaran 1: halaman 2 melihat rowCount 199 (satu pelunasan dihapus di tengah) -> ulang dari halaman 1.
    const semua = Array.from({ length: 200 }, (_, i) => baris(i + 1));
    const sekali = sim((h, ke) => (ke <= 2 ? hal(semua.slice((h - 1) * 100, h * 100), ke === 1 ? 200 : 199, 2)
        : hal(semua.slice(1).slice((h - 1) * 100, h * 100), 199, 2)));
    const d = await bacaDaftar(D, sekali.ambil);
    assert.deepEqual(sekali.diminta, [1, 2, 1, 2]);
    assert.equal(d.length, 199);
    const terus = sim((h, ke) => hal([baris(h)], 2 + ke, 2));
    await assert.rejects(bacaDaftar(D, terus.ambil), galat("terpotong", /dua kali/));
    assert.deepEqual(terus.diminta, [1, 2, 1, 2], "tepat satu ulang");
    // Id ganda dalam jawaban dibuang; jumlah id unik = rowCount -> sah.
    const ganda = await bacaDaftar(D, sim(() => hal([baris(1), baris(2), baris(2), baris(3)], 3, 1)).ambil);
    assert.deepEqual(ganda.map((b) => b.id), [1, 2, 3]);
    // Id ganda yang menyembunyikan baris lain (unik < rowCount) -> ulang -> tetap -> terpotong.
    await assert.rejects(bacaDaftar(D, sim(() => hal([baris(1), baris(1)], 2, 1)).ambil), galat("terpotong", /id unik/));
});

test("bacaDaftar: s:false = ditolak (pesan tanpa token), bentuk salah, filter tanggal diabaikan, lastUpdate kosong", async () => {
    const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    await assert.rejects(bacaDaftar(D, sim(() => ({ s: false, d: [`Sesi ${token} tidak sah`] })).ambil, [token]),
        (e) => galat("ditolak")(e) && !(e as Error).message.includes(token) && /\*\*\*/.test((e as Error).message));
    await assert.rejects(bacaDaftar(D, sim(() => ({ s: true, d: {} })).ambil), galat("bentuk"));
    await assert.rejects(bacaDaftar(D, sim(() => "<html>").ambil), galat("bentuk"));
    await assert.rejects(bacaDaftar(D, sim(() => hal([{ ...baris(1), transDate: "04/10/2026" }], 1, 1)).ambil), galat("bentuk", /filter tanggal/));
    await assert.rejects(bacaDaftar(D, sim(() => hal([{ ...baris(1), lastUpdate: "" }], 1, 1)).ambil), galat("bentuk", /lastUpdate/));
    await assert.rejects(bacaDaftar(D, sim(() => hal([{ ...baris(1), id: "x" }], 1, 1)).ambil), galat("bentuk"));
});

const detail = (lain: Record<string, unknown> = {}) => ({
    id: 77, number: "SR/2610/77", transDate: DA, paymentMethod: "CASH_OTHER", chequeAmount: 108741.15,
    detailInvoice: [
        { invoiceId: 9001, invoice: { id: 9001, number: "INV/1", masterSalesmanId: 4652 }, invoicePayment: 54370.5, paymentAmount: 60000 },
        { invoiceId: 9002, invoice: { id: 9002, number: "INV/2", masterSalesmanId: null }, invoicePayment: "54370.65" },
    ],
    ...lain,
});
const urai = (d: unknown) => uraiDetail(d, D, { id: 77, nomor: "SR/2610/77" });

test("uraiDetail: nominal lewat keSen (sen tepat), fakturId invoice.id ?? invoiceId, nomor faktur, salesman null boleh", () => {
    assert.deepEqual(urai(detail()), { ok: true, pelunasan: { id: 77, nomor: "SR/2610/77", tanggal: D, metode: "CASH_OTHER", chequeAmount: 10874115,
        faktur: [{ fakturId: 9001, nomorFaktur: "INV/1", masterSalesmanId: 4652, invoicePayment: 5437050 },
            { fakturId: 9002, nomorFaktur: "INV/2", masterSalesmanId: null, invoicePayment: 5437065 }] } });
    const tanpaObjek = urai(detail({ detailInvoice: [{ invoiceId: 9003, invoicePayment: 1 }] }));
    assert.ok(tanpaObjek.ok);
    assert.deepEqual(tanpaObjek.pelunasan.faktur, [{ fakturId: 9003, nomorFaktur: null, masterSalesmanId: null, invoicePayment: 100 }]);
    const kosong = urai(detail({ detailInvoice: [] }));
    assert.ok(kosong.ok && kosong.pelunasan.faktur.length === 0, "tanpa baris faktur = sah (ember tanpa_baris_faktur di lib)");
});

test("uraiDetail: > 2 desimal Accurate (produksi 10–15 Okt: ±40 % pelunasan) -> sen dibulatkan setengah menjauhi nol, bukan ditolak", () => {
    const satu = (cheque: unknown, ip: unknown) => urai(detail({ chequeAmount: cheque, detailInvoice: [{ invoice: { id: 1 }, invoicePayment: ip }] }));
    const h = satu(82250.0988, 82250.0988);
    assert.ok(h.ok);
    assert.equal(h.pelunasan.chequeAmount, 8225010);
    assert.equal(h.pelunasan.faktur[0].invoicePayment, 8225010);
    const sen = (v: unknown) => { const r = satu(v, v); return r.ok ? r.pelunasan.chequeAmount : r.sebab; };
    assert.equal(sen(1695228.659414), 169522866);
    assert.equal(sen(1.0001), 100);
    assert.equal(sen(0.125), 13, "tepat setengah -> menjauhi nol");
    assert.equal(sen(0.124999), 12);
    assert.equal(sen(-0.125), -13);
    assert.equal(sen("27447491.598839"), 2744749160);
    assert.equal(sen(0.1 + 0.2), 30, "galat floating JSON (0.30000000000000004)");
});

test("uraiDetail: baris faktur dibulatkan KUMULATIF — Σ baris = cheque bila Accurate klop, selisih nyata tetap terlihat", () => {
    const tiga = (cheque: unknown, ip: unknown[]) => urai(detail({ chequeAmount: cheque,
        detailInvoice: ip.map((v, i) => ({ invoice: { id: i + 1, masterSalesmanId: i + 1 }, invoicePayment: v })) }));
    // Dibulatkan sendiri-sendiri: 3333 × 3 = 9999 ≠ 10000 -> ember tak teralokasi semu 1 sen (multi-salesman ±2 % pelunasan).
    const klop = tiga(99.999999, [33.333333, 33.333333, 33.333333]);
    assert.ok(klop.ok);
    assert.equal(klop.pelunasan.chequeAmount, 10000);
    assert.deepEqual(klop.pelunasan.faktur.map((f) => f.invoicePayment), [3333, 3334, 3333]);
    const beda = tiga(120.5, [50.123, 50.124]);
    assert.ok(beda.ok);
    assert.deepEqual([beda.pelunasan.chequeAmount, ...beda.pelunasan.faktur.map((f) => f.invoicePayment)], [12050, 5012, 5013]);
    const ganda = urai(detail({ chequeAmount: 30.00003, detailInvoice: [10.00001, 10.00001, 10.00001].map((v) => ({ invoice: { id: 5 }, invoicePayment: v })) }));
    assert.ok(ganda.ok);
    assert.deepEqual(ganda.pelunasan.faktur.map((f) => f.invoicePayment), [3000], "faktur sama dua kali tetap dijumlah");
});

test("uraiDetail: rusak DITOLAK terlihat — bukan angka desimal polos, invoicePayment absen (tanpa cadangan paymentAmount), faktur ganda, bentuk", () => {
    const sebab = (d: unknown) => { const h = urai(d); return h.ok ? "ok" : h.sebab; };
    assert.equal(sebab(detail({ chequeAmount: "1.234.567" })), "nominal");
    assert.equal(sebab(detail({ chequeAmount: "12,5" })), "nominal");
    assert.equal(sebab(detail({ chequeAmount: 1e-7 })), "nominal", "notasi e");
    assert.equal(sebab(detail({ chequeAmount: Number.NaN })), "nominal");
    assert.equal(sebab(detail({ chequeAmount: 1e17 })), "nominal", "di luar bilangan bulat aman (sen)");
    assert.equal(sebab(detail({ detailInvoice: [{ invoice: { id: 1 }, invoicePayment: "0.1.2" }] })), "nominal");
    assert.equal(sebab(detail({ detailInvoice: ["90000000000000", "-180000000000000", "90000000000000"]
        .map((v, i) => ({ invoice: { id: i + 1 }, invoicePayment: v })) })), "nominal", "baris di luar batas walau kumulatif aman");
    assert.equal(sebab(detail({ detailInvoice: [{ invoice: { id: 1 }, paymentAmount: 500 }] })), "bentuk", "invoicePayment absen, paymentAmount TIDAK dipakai");
    assert.equal(sebab(detail({ chequeAmount: undefined })), "bentuk");
    assert.equal(sebab(detail({ paymentMethod: { name: "Tunai" } })), "bentuk");
    assert.equal(sebab(detail({ paymentMethod: "  " })), "bentuk");
    assert.equal(sebab(detail({ id: 78 })), "bentuk", "id detail ≠ id daftar");
    assert.equal(sebab(detail({ transDate: "2026-10-05" })), "bentuk");
    assert.equal(sebab(detail({ detailInvoice: "x" })), "bentuk");
    assert.equal(sebab(detail({ detailInvoice: [{ invoice: { id: 1, masterSalesmanId: "abc" }, invoicePayment: 1 }] })), "bentuk");
    assert.equal(sebab(detail({ detailInvoice: [{ invoicePayment: 1 }] })), "bentuk", "tanpa id faktur");
    assert.equal(sebab([]), "bentuk");
    assert.equal(sebab(detail({ transDate: "06/10/2026" })), "berubah", "transDate pindah sesudah daftar = tidak lengkap");
    // Faktur sama dua kali: salesman sama -> dijumlah (PK cache per faktur); salesman beda -> galat.
    const dua = urai(detail({ detailInvoice: [{ invoice: { id: 5, number: "INV/5", masterSalesmanId: 11 }, invoicePayment: 100.5 },
        { invoiceId: 5, invoice: { id: 5, masterSalesmanId: 11 }, invoicePayment: 200.25 }] }));
    assert.ok(dua.ok);
    assert.deepEqual(dua.pelunasan.faktur, [{ fakturId: 5, nomorFaktur: "INV/5", masterSalesmanId: 11, invoicePayment: 30075 }]);
    assert.equal(sebab(detail({ detailInvoice: [{ invoice: { id: 5, masterSalesmanId: 11 }, invoicePayment: 1 },
        { invoice: { id: 5, masterSalesmanId: 12 }, invoicePayment: 1 }] })), "bentuk");
});

test("rencanaBaca: baru/ubah dibaca, sama tetap, hilang dihapus HANYA dari daftar lengkap; penuh = semua dibaca", () => {
    const cache = new Map<number, string | null>([[1, "05/10/2026 09:00:00"], [2, "05/10/2026 09:01:00"], [3, null], [4, "x"]]);
    const daftar: BarisDaftar[] = [{ id: 1, nomor: "SR/1", lastUpdate: "05/10/2026 09:00:00" }, { id: 2, nomor: "SR/2", lastUpdate: "05/10/2026 10:00:00" },
        { id: 3, nomor: "SR/3", lastUpdate: "05/10/2026 09:02:00" }, { id: 5, nomor: "SR/5", lastUpdate: "05/10/2026 09:03:00" }];
    const r = rencanaBaca(cache, { baris: daftar, lengkap: true }, false);
    assert.deepEqual(r.baca.map((b) => b.id), [2, 3, 5]);
    assert.deepEqual(r.tetap, [1]);
    assert.deepEqual(r.hapus, [4]);
    assert.deepEqual(rencanaBaca(cache, { baris: daftar, lengkap: false }, false).hapus, [], "daftar terpotong tidak pernah menghapus");
    const penuh = rencanaBaca(cache, { baris: daftar, lengkap: true }, true);
    assert.deepEqual([penuh.baca.length, penuh.tetap.length, penuh.hapus], [4, 0, [4]]);
    assert.deepEqual(rencanaBaca(new Map(), { baris: [], lengkap: true }, false), { baca: [], hapus: [], tetap: [] });
});

test("kelasGalat: 401/kredensial = sesi_sinkron, 403, 429, 5xx, jaringan, timeout/abort/bukan JSON = tidak_pasti, s:false = ditolak", () => {
    const k = (j: Parameters<typeof kelasGalat>[0]) => kelasGalat(j, ["RAHASIA-SESI-123"]).kelas;
    assert.equal(k({ kredensialAbsen: true }), "sesi_sinkron");
    assert.equal(k({ status: 401, teks: "{}" }), "sesi_sinkron");
    assert.equal(k({ status: 403, teks: "" }), "hak_akses");
    assert.equal(k({ status: 429, teks: "" }), "batas_laju");
    assert.equal(k({ status: 500, teks: "{}" }), "accurate_5xx");
    assert.equal(k({ status: 503, teks: "<html>" }), "accurate_5xx");
    assert.equal(k({ galat: new TypeError("fetch failed") }), "jaringan");
    assert.equal(k({ galat: new DOMException("timeout", "TimeoutError") }), "tidak_pasti");
    assert.equal(k({ galat: new DOMException("aborted", "AbortError") }), "tidak_pasti");
    assert.equal(k({ status: 200, teks: "<html>login</html>" }), "tidak_pasti");
    assert.equal(k({ status: 404, teks: JSON.stringify({ s: false, d: ["tidak ada"] }) }), "ditolak");
    const tolak = kelasGalat({ status: 200, teks: JSON.stringify({ s: false, m: "Token RAHASIA-SESI-123 / Bearer abc.def ditolak" }) }, ["RAHASIA-SESI-123"]);
    assert.equal(tolak.kelas, "ditolak");
    assert.ok(tolak.kelas && !/RAHASIA|abc\.def/.test(tolak.pesan), `pesan disaring: ${tolak.kelas && tolak.pesan}`);
    const sah = kelasGalat({ status: 200, teks: JSON.stringify({ s: true, d: [] }) });
    assert.equal(sah.kelas, null);
    assert.equal(kelasGalat({ status: 401, teks: "" }).kelas && (kelasGalat({ status: 401, teks: "" }) as { pesan: string }).pesan, PESAN_SESI_SINKRON);
    assert.equal(saringPesan(["satu", { a: 1 }]), `satu; {"a":1}`);
    assert.equal(saringPesan("x".repeat(400)).length, 3, "untaian panjang mirip token disamarkan");
    assert.equal(saringPesan(undefined), "tanpa pesan");
});

test("tundaUlang: 429 0,5/1/2 dtk (Retry-After lebih lama dihormati) lalu berhenti; 5xx/jaringan ≤ 3×; tidak_pasti 1×; 401/403/ditolak tanpa ulang", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => tundaUlang("batas_laju", n)), [500, 1000, 2000, null]);
    assert.equal(tundaUlang("batas_laju", 1, 3000), 3000);
    assert.equal(tundaUlang("batas_laju", 2, 100), 1000);
    assert.deepEqual([1, 2, 3, 4].map((n) => tundaUlang("accurate_5xx", n)), [500, 1000, 2000, null]);
    assert.deepEqual([1, 2, 3, 4].map((n) => tundaUlang("jaringan", n)), [500, 1000, 2000, null]);
    assert.deepEqual([1, 2].map((n) => tundaUlang("tidak_pasti", n)), [500, null]);
    for (const kelas of ["sesi_sinkron", "hak_akses", "ditolak", "bentuk", "nominal", "terpotong"] as const) assert.equal(tundaUlang(kelas, 1), null, kelas);
    assert.equal(bacaRetryAfter("2", 0), 2000);
    assert.equal(bacaRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
    assert.equal(bacaRetryAfter("besok", 0), null);
    assert.equal(bacaRetryAfter(null, 0), null);
});

test("statusAkhir: lengkap ⇔ daftar lengkap ∧ semua id cocok ∧ tanpa ditolak; galat & ditolak = gagal; sisa = sebagian", () => {
    const daftar: BarisDaftar[] = [{ id: 1, nomor: "SR/1", lastUpdate: "a" }, { id: 2, nomor: "SR/2", lastUpdate: "b" }];
    const cocok = new Map<number, string | null>([[1, "a"], [2, "b"]]);
    assert.deepEqual(statusAkhir({ galat: null, daftar, cacheAkhir: cocok, ditolak: [] }),
        { status: "lengkap", sebab: null, pesan: null, jumlahDaftar: 2, sisaDetail: 0 });
    assert.deepEqual(statusAkhir({ galat: null, daftar, cacheAkhir: new Map([[1, "a"], [2, "lama"]]), ditolak: [] }),
        { status: "sebagian", sebab: null, pesan: "Membaca 1/2", jumlahDaftar: 2, sisaDetail: 1 });
    const tolak = statusAkhir({ galat: null, daftar, cacheAkhir: new Map([[1, "a"]]), ditolak: [{ id: 2, nomor: "SR/2", sebab: "nominal", pesan: "3 desimal" }] });
    assert.deepEqual([tolak.status, tolak.sebab, tolak.sisaDetail], ["gagal", "nominal", 1]);
    assert.match(tolak.pesan!, /1 pelunasan ditolak.*SR\/2 \(nominal/);
    const sesi = statusAkhir({ galat: { kelas: "sesi_sinkron", pesan: PESAN_SESI_SINKRON }, daftar, cacheAkhir: cocok, ditolak: [] });
    assert.deepEqual([sesi.status, sesi.sebab], ["gagal", "sesi_sinkron"], "galat menang walau cache kebetulan cocok");
    assert.deepEqual(statusAkhir({ galat: null, daftar: null, cacheAkhir: cocok, ditolak: [] }).status, "sebagian");
    assert.deepEqual(statusAkhir({ galat: { kelas: "terpotong", pesan: "x" }, daftar: null, cacheAkhir: cocok, ditolak: [] }),
        { status: "gagal", sebab: "terpotong", pesan: "x", jumlahDaftar: null, sisaDetail: null });
    assert.equal(statusAkhir({ galat: null, daftar: [], cacheAkhir: new Map(), ditolak: [] }).status, "lengkap", "hari tanpa pelunasan");
});

test("tanggalCron: hari ini + mundur sampai hari kerja sebelumnya (Senin: Sabtu & Minggu)", () => {
    assert.deepEqual(tanggalCron("2026-10-05"), ["2026-10-05", "2026-10-04", "2026-10-03"], "Senin");
    assert.deepEqual(tanggalCron("2026-10-06"), ["2026-10-06", "2026-10-05"], "Selasa");
    assert.deepEqual(tanggalCron("2026-10-11"), ["2026-10-11", "2026-10-10"], "Minggu");
    assert.deepEqual(tanggalCron("2026-01-01"), ["2026-01-01", "2025-12-31"], "lintas tahun");
});

test("hapusMassal: > 5 baris DAN > 10 % cache = tahan; segarUntukTutup: lengkap DAN lengkap_pada <= 15 menit (kontrak K2)", () => {
    assert.deepEqual([[6, 40], [5, 10], [6, 60], [6, 59], [1, 1], [0, 0]].map(([h, c]) => hapusMassal(h, c)), [true, false, false, true, false, false]);
    const kini = new Date("2026-10-05T10:00:00.000Z");
    assert.equal(segarUntukTutup({ status: "lengkap", lengkapPada: "2026-10-05T09:45:00.000Z" }, kini), true);
    assert.equal(segarUntukTutup({ status: "lengkap", lengkapPada: "2026-10-05T09:44:59.999Z" }, kini), false, "lebih tua -> segarkan dulu");
    assert.equal(segarUntukTutup({ status: "gagal", lengkapPada: "2026-10-05T09:59:00.000Z" }, kini), false);
    assert.equal(segarUntukTutup({ status: "lengkap", lengkapPada: null }, kini), false);
});
