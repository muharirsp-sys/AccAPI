/* O3 (owner 12 Okt 2026 sesi 13): riwayat beli toko — rata-rata pengambilan per bulan per barang + satuan.
 * Bagian 1 (murni, tanpa DB): jendela 90 hari, bulan teramati (faktur paling awal toko lebih baru dari awal jendela), agregasi baris faktur
 *   (satuan berbeda, faktur tanpa rincian, bonus harga 0, qty rusak), jumlah tombol Tambah, satuan saat Tambah, sisip baris order.
 * Bagian 2 (route TANPA DB): gerbang 401/403/400 sebelum DB, cakupan cabang salesman (403), galat DB = 500 berkode (bukan daftar kosong),
 *   bentuk jawaban (+ `dilewati` = faktur rusak) + tanda "tak bisa diorder" dari master barang. SQL-nya diuji di lib/riwayat-beli-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { customer, item, userGroup } from "../db/schema.ts";
import { bacaRiwayat, bulanTeramati, jendelaRiwayat, jumlahTambah, ringkasRiwayat, satuanTambah, sisipkanBaris, type BarisFaktur } from "./riwayat-beli.ts";
import * as riwayat from "../app/api/customers/riwayat-beli/route.ts";

// ---------------------------------------------------------------- murni

test("jendela = bulan × 30 hari TERMASUK hari ini (3 bulan = 90 hari); lintas tahun", () => {
    assert.deepEqual(jendelaRiwayat("2026-10-12", 3), { dari: "2026-07-15", sampai: "2026-10-12" });
    assert.deepEqual(jendelaRiwayat("2026-10-12", 1), { dari: "2026-09-13", sampai: "2026-10-12" });
    assert.deepEqual(jendelaRiwayat("2027-01-10", 1), { dari: "2026-12-12", sampai: "2027-01-10" });
});

test("bulan teramati: faktur paling awal ≤ awal jendela = bulan jendela; lebih baru = hari sejak faktur itu ÷ 30, minimal 1", () => {
    const j = { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3 };
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-01-02" }), 3);
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-07-15" }), 3); // tepat awal jendela = jendela penuh (kontinu dengan sehari sesudahnya)
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-07-16" }), 89 / 30);
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-08-28" }), 46 / 30); // 46 hari (28 Agu .. 12 Okt)
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-09-28" }), 1); // 15 hari -> minimal 1 bulan
    assert.equal(bulanTeramati({ ...j, palingAwal: "2026-10-20" }), 1); // tanggal masa depan di cache -> minimal 1, bukan negatif
    assert.equal(bulanTeramati({ ...j, palingAwal: null }), 3);
});

const f = (faktur: string, tanggal: string, code: string | null, satuan: string | null, qty: string | null, harga: string | null = "1000", nama: string | null = null): BarisFaktur =>
    ({ faktur, tanggal, adaRincian: code !== null, code, nama, satuan, qty, harga });

test("agregasi per barang + SATUAN: KRT dan PCS barang yang sama = dua baris; total, jumlah faktur (unik), terakhir beli", () => {
    const rows = [
        f("1", "2026-08-01", "A-1", "KRT", "2", "576000", "BARANG A"), f("1", "2026-08-01", "A-1", "KRT", "1"), // dua baris satu faktur = 1 faktur
        f("2", "2026-09-10", "A-1", "krt ", "3"), f("2", "2026-09-10", "A-1", "PCS", "12"),
        f("3", "2026-10-05", " A-1 ", "PCS", "6"),
    ];
    const h = ringkasRiwayat(rows, { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-07-01", dilewati: 2 });
    assert.deepEqual(h.items, [
        { code: "A-1", name: "", unit: "PCS", totalQty: 18, rataPerBulan: 6, jumlahFaktur: 2, terakhirBeli: "2026-10-05" },
        { code: "A-1", name: "BARANG A", unit: "KRT", totalQty: 6, rataPerBulan: 2, jumlahFaktur: 2, terakhirBeli: "2026-09-10" },
    ]);
    // `dilewati` (faktur rusak, dihitung di SQL) diteruskan apa adanya; tidak ikut jumlahFaktur.
    assert.deepEqual(h.ringkasan, { jumlahFaktur: 3, tanpaRincian: 0, dilewati: 2, dataSejak: "2026-07-01" });
    assert.deepEqual(h.jendela, { bulan: 3, dari: "2026-07-15", sampai: "2026-10-12", bulanTeramati: 3 });
});

test("faktur TANPA rincian (list.do) tetap dihitung di ringkasan, tidak masuk barang; bonus harga 0 dan qty rusak/≤ 0 tidak dihitung", () => {
    const rows = [
        f("1", "2026-09-01", "A-1", "KRT", "4"),
        f("2", "2026-09-02", null, null, null), // faktur tanpa rincian barang
        f("3", "2026-09-03", null, null, null),
        f("4", "2026-09-04", "A-1", "KRT", "2", "0"), // bonus promo (harga 0) — pemberian, bukan pengambilan
        f("4", "2026-09-04", "A-1", "PCS", "abc"), f("4", "2026-09-04", "A-1", "PCS", "-3"), f("4", "2026-09-04", "", "PCS", "5"), f("4", "2026-09-04", "A-2", null, "5"),
        f("5", "2026-09-05", "A-3", "LSN", "1.5", null), // harga tak terkirim != bonus: dihitung
    ];
    const h = ringkasRiwayat(rows, { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-07-15", dilewati: 0 });
    assert.deepEqual(h.ringkasan, { jumlahFaktur: 5, tanpaRincian: 2, dilewati: 0, dataSejak: "2026-07-15" });
    assert.deepEqual(h.items.map((x) => [x.code, x.unit, x.totalQty, x.jumlahFaktur]), [["A-1", "KRT", 4, 1], ["A-3", "LSN", 1.5, 1]]);
    // Tanpa faktur di jendela: SQL tetap mengirim satu baris (faktur null) pembawa tanggal data paling awal.
    const kosong = ringkasRiwayat([{ faktur: null, tanggal: null, adaRincian: false, code: null, nama: null, satuan: null, qty: null, harga: null }],
        { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-02-01", dilewati: 1 });
    assert.deepEqual(kosong.ringkasan, { jumlahFaktur: 0, tanpaRincian: 0, dilewati: 1, dataSejak: "2026-02-01" });
    assert.deepEqual(kosong.items, []);
});

test("rata-rata dengan faktur awal BARU: dibagi bulan sejak faktur pertama (bukan 3), minimal 1; urut rata-rata terbesar", () => {
    const rows = [f("1", "2026-08-28", "A-1", "KRT", "3"), f("2", "2026-10-01", "A-1", "KRT", "3"), f("2", "2026-10-01", "A-4", "LSN", "10")];
    const baru = ringkasRiwayat(rows, { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-08-28", dilewati: 0 });
    assert.equal(baru.jendela.bulanTeramati, 1.53); // 46/30
    assert.deepEqual(baru.items.map((x) => [x.code, x.rataPerBulan]), [["A-4", 6.52], ["A-1", 3.91]]); // 10/1.533, 6/1.533
    const lama = ringkasRiwayat(rows, { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-05-01", dilewati: 0 });
    assert.deepEqual(lama.items.map((x) => [x.code, x.rataPerBulan]), [["A-4", 3.33], ["A-1", 2]]);
    const sebentar = ringkasRiwayat(rows.slice(1), { dari: "2026-07-15", sampai: "2026-10-12", bulan: 3, palingAwal: "2026-10-01", dilewati: 0 });
    assert.deepEqual(sebentar.items.map((x) => [x.code, x.rataPerBulan]), [["A-4", 10], ["A-1", 3]]); // 12 hari -> 1 bulan, bukan 0,4
});

test("tombol Tambah: jumlah = pembulatan ke atas rata-rata, minimal 1", () => {
    assert.equal(jumlahTambah(2.5), 3);
    assert.equal(jumlahTambah(1.2), 2); // ke atas, bukan dibulatkan biasa (1,2 -> 2)
    assert.equal(jumlahTambah(2), 2);
    assert.equal(jumlahTambah(0.2), 1);
    assert.equal(jumlahTambah(0), 1);
});

test("satuan saat Tambah: satuan master (ejaan master); sales tak bisa satuan tanpa harga sah; petugas boleh (harga petugas)", () => {
    const b = { units: [{ unit: "KRT", price: 576000 }, { unit: "Pcs", price: null }], hargaUntuk: "1|2026-10-12" };
    assert.deepEqual(satuanTambah(b, "KRT", "sales", "1|2026-10-12"), { unit: "KRT" });
    assert.deepEqual(satuanTambah(b, "PCS", "petugas", "1|2026-10-12"), { unit: "Pcs" });
    assert.match((satuanTambah(b, "PCS", "sales", "1|2026-10-12") as { alasan: string }).alasan, /Harga PCS belum ada/);
    assert.deepEqual(satuanTambah(b, "PCS", "sales", "1|2026-10-13"), { unit: "Pcs" }); // daftar harga usang: pratinjau yang memutuskan
    assert.match((satuanTambah(b, "LSN", "petugas", "1|2026-10-12") as { alasan: string }).alasan, /Satuan LSN tidak ada lagi/);
});

test("sisip baris: isi baris kosong PERTAMA (belum memilih barang), selain itu tambah di akhir", () => {
    const baru = { code: "A-1", unit: "KRT" };
    assert.deepEqual(sisipkanBaris([{ code: "" , unit: "" }], baru), [baru]);
    assert.deepEqual(sisipkanBaris([{ code: "B-1", unit: "PCS" }, { code: " ", unit: "" }, { code: "", unit: "" }], baru), [{ code: "B-1", unit: "PCS" }, baru, { code: "", unit: "" }]);
    assert.deepEqual(sisipkanBaris([{ code: "B-1", unit: "PCS" }], baru), [{ code: "B-1", unit: "PCS" }, baru]);
});

test("bacaRiwayat (klien): jawaban tak berbentuk = null (galat), bukan riwayat kosong", () => {
    assert.equal(bacaRiwayat({ ok: true }), null);
    assert.equal(bacaRiwayat({ ok: true, items: [], ringkasan: {} }), null);
    const jendela = { bulan: 3, dari: "2026-07-15", sampai: "2026-10-12", bulanTeramati: 3 };
    // Tanpa `dilewati` = bentuk tak terbaca (faktur yang dilewati tidak boleh hilang diam-diam).
    assert.equal(bacaRiwayat({ ok: true, jendela, ringkasan: { jumlahFaktur: 0, tanpaRincian: 0, dataSejak: null }, items: [] }), null);
    const r = bacaRiwayat({ ok: true, jendela, ringkasan: { jumlahFaktur: 0, tanpaRincian: 0, dilewati: 2, dataSejak: null },
        items: [{ code: "A-1", name: "BARANG A", unit: "KRT", totalQty: 3, rataPerBulan: 1, jumlahFaktur: 1, terakhirBeli: "2026-10-01", bisaDiorder: true, alasan: null }, { code: 5 }] });
    assert.equal(r?.items.length, 1);
    assert.equal(r?.ringkasan.dataSejak, null);
    assert.equal(r?.ringkasan.dilewati, 2);
});

// ---------------------------------------------------------------- route TANPA DB

const dialek = new PgDialect();
type Isi = { izin: string[] | null; cakupan?: Record<string, unknown>[]; pelanggan?: Record<string, unknown>[]; faktur?: Record<string, unknown>[] | Error; barang?: Record<string, unknown>[] };
type Log = { execute: string[]; select: object[] };

/** Sesi palsu + db tiruan per tabel; `faktur` Error = kueri faktur gagal. Tulis/transaksi DILARANG (route baca-saja). */
async function sebagai<T>(isi: Isi, fn: (log: Log) => Promise<T>): Promise<T> {
    const log: Log = { execute: [], select: [] };
    const saved = (["select", "execute", "insert", "update", "delete", "transaction"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(db, k)] as const);
    const savedSes = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const bypass = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const dilarang = () => { throw new Error("route riwayat beli tidak boleh menulis"); };
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (isi.izin ? { user: { id: "u-uji", name: "Uji", role: "staff" }, session: { id: "s" } } : null) });
    const isiTabel = (t: object): unknown[] => t === userGroup ? (isi.izin ?? []).map((key) => ({ groupId: "g", key }))
        : t === customer ? isi.pelanggan ?? [] : t === item ? isi.barang ?? [] : [];
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: (t: object) => {
        log.select.push(t);
        const c: Record<string, unknown> = {};
        for (const m of ["leftJoin", "innerJoin", "where", "limit", "orderBy"]) c[m] = () => c;
        c.then = (ok: (v: unknown) => unknown, gagal?: (e: unknown) => unknown) => Promise.resolve(isiTabel(t)).then(ok, gagal);
        return c;
    } }) });
    Object.defineProperty(db, "execute", { configurable: true, value: async (q: SQL) => {
        const teks = dialek.sqlToQuery(q).sql;
        log.execute.push(teks);
        if (teks.includes("sales_profile")) return { rows: isi.cakupan ?? [] };
        if (teks.includes("sales_invoice")) { if (isi.faktur instanceof Error) throw isi.faktur; return { rows: isi.faktur ?? [] }; }
        throw new Error(`kueri tak dikenal: ${teks.slice(0, 60)}`);
    } });
    for (const k of ["insert", "update", "delete", "transaction"]) Object.defineProperty(db, k, { configurable: true, value: dilarang });
    try {
        return await fn(log);
    } finally {
        for (const [k, d] of saved) { if (d) Object.defineProperty(db, k, d); else delete (db as unknown as Record<string, unknown>)[k]; }
        if (savedSes) Object.defineProperty(auth.api, "getSession", savedSes);
        if (bypass !== undefined) process.env.LOCAL_AUTH_BYPASS = bypass;
    }
}
const get = (q: string) => riwayat.GET(new NextRequest(`http://localhost/api/customers/riwayat-beli${q}`));
const SALES_A = [{ sales_code: "M-SLA", employee_id: 1, branch_id: 50, salesman: true, suspended: false, branch_name: "CABANG A" }];
const PEL_A = [{ customerNo: "C-01", name: "PELANGGAN A", branchId: 50, branchName: "CABANG A", suspended: false }];
const PEL_B = [{ customerNo: "C-03", name: "PELANGGAN C", branchId: 90, branchName: "CABANG B", suspended: false }];

test("route gerbang: tanpa sesi 401; izin bukan websales.create/order.create 403; query tidak valid 400 — semuanya SEBELUM kueri faktur", async () => {
    assert.equal((await sebagai({ izin: null }, () => get("?customerNo=C-01"))).status, 401);
    for (const izin of [["order.view", "websales.view"], ["order.edit"]]) {
        const r = await sebagai({ izin }, async (log) => ({ res: await get("?customerNo=C-01"), log }));
        assert.equal(r.res.status, 403, izin.join(","));
        assert.equal((await r.res.json()).kode, "TIDAK_DIIZINKAN");
        assert.deepEqual(r.log.execute, []);
    }
    for (const q of ["", "?customerNo=%20", "?customerNo=C-01&bulan=0", "?customerNo=C-01&bulan=13", "?customerNo=C-01&bulan=x", `?customerNo=${"C".repeat(81)}`]) {
        const r = await sebagai({ izin: ["websales.create"] }, async (log) => ({ res: await get(q), log }));
        assert.equal(r.res.status, 400, q);
        assert.equal((await r.res.json()).kode, "INPUT_TIDAK_VALID", q);
        assert.deepEqual(r.log.execute, [], q);
    }
});

test("route cakupan: salesman meminta pelanggan cabang lain = 403 CABANG_DI_LUAR_CAKUPAN tanpa membaca faktur; akun belum tertaut = 403 berkode", async () => {
    const r = await sebagai({ izin: ["websales.create"], cakupan: SALES_A, pelanggan: PEL_B, faktur: [] }, async (log) => ({ res: await get("?customerNo=C-03"), log }));
    assert.equal(r.res.status, 403);
    assert.equal((await r.res.json()).kode, "CABANG_DI_LUAR_CAKUPAN");
    assert.equal(r.log.execute.filter((s) => s.includes("sales_invoice")).length, 0);
    const belum = await sebagai({ izin: ["websales.create"], cakupan: [] }, () => get("?customerNo=C-01"));
    assert.equal(belum.status, 403);
    assert.equal((await belum.json()).kode, "SALESMAN_BELUM_TERHUBUNG");
    const tak = await sebagai({ izin: ["order.create", "order.view"], pelanggan: [] }, () => get("?customerNo=C-99"));
    assert.equal(tak.status, 409);
    assert.equal((await tak.json()).kode, "PELANGGAN_TIDAK_ADA");
    const tanpa = await sebagai({ izin: ["order.create", "order.view"], pelanggan: [{ ...PEL_A[0], branchId: null }] }, () => get("?customerNo=C-01"));
    assert.equal((await tanpa.json()).kode, "PELANGGAN_TANPA_CABANG");
});

test("route galat ≠ kosong: kueri faktur gagal = 500 { ok:false, kode } — BUKAN 200 dengan daftar kosong", async () => {
    const r = await sebagai({ izin: ["websales.create"], cakupan: SALES_A, pelanggan: PEL_A, faktur: new Error("statement timeout") }, () => get("?customerNo=C-01"));
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.kode, "RIWAYAT_GAGAL");
    assert.equal(j.items, undefined);
});

test("route 200: bentuk jawaban; barang yang KINI tak bisa diorder (cabang lain / suspended / tidak ada) tetap tampil bertanda + alasannya", async () => {
    const k = { paling_awal: "2026-07-24", dilewati: 2 };
    const faktur = [
        { ...k, faktur: "1", tanggal: "2026-08-01", ada_rincian: true, code: "A-1", nama: "BARANG A LAMA", satuan: "KRT", qty: "3", harga: "576000" },
        { ...k, faktur: "1", tanggal: "2026-08-01", ada_rincian: true, code: "B-1", nama: "BARANG B", satuan: "KRT", qty: "6", harga: "700000" },
        { ...k, faktur: "2", tanggal: "2026-09-01", ada_rincian: true, code: "A-9", nama: "BARANG HILANG", satuan: "PCS", qty: "9", harga: "100" },
        { ...k, faktur: "2", tanggal: "2026-09-01", ada_rincian: true, code: "A-5", nama: "BARANG NONAKTIF", satuan: "PCS", qty: "1", harga: "100" },
        { ...k, faktur: "3", tanggal: "2026-09-15", ada_rincian: false, code: null, nama: null, satuan: null, qty: null, harga: null },
    ];
    const barang = [
        { no: "A-1", name: "BARANG A", branchId: 50, suspended: false, tag: "TAG A", branchName: "CABANG A" },
        { no: "B-1", name: "BARANG B", branchId: 90, suspended: false, tag: "TAG B", branchName: "CABANG B" },
        { no: "A-5", name: "BARANG A5", branchId: 50, suspended: true, tag: "TAG A", branchName: "CABANG A" },
    ];
    const r = await sebagai({ izin: ["websales.create"], cakupan: SALES_A, pelanggan: PEL_A, faktur, barang }, async (log) => ({ res: await get("?customerNo=C-01"), log }));
    assert.equal(r.res.status, 200);
    const j = await r.res.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.pelanggan, { customerNo: "C-01", name: "PELANGGAN A", branchId: 50, branchName: "CABANG A" });
    assert.equal(j.jendela.bulan, 3);
    assert.deepEqual(j.ringkasan, { jumlahFaktur: 3, tanpaRincian: 1, dilewati: 2, dataSejak: "2026-07-24" });
    const per = Object.fromEntries(j.items.map((x: { code: string }) => [x.code, x]));
    assert.deepEqual([per["A-1"].name, per["A-1"].bisaDiorder, per["A-1"].alasan], ["BARANG A", true, null]); // nama master menang
    assert.deepEqual([per["B-1"].bisaDiorder, per["B-1"].alasan], [false, "barang cabang CABANG B"]);
    assert.deepEqual([per["A-5"].bisaDiorder, per["A-5"].alasan], [false, "nonaktif (suspended) di Accurate"]);
    assert.deepEqual([per["A-9"].name, per["A-9"].bisaDiorder, per["A-9"].alasan], ["BARANG HILANG", false, "tidak ada di master Accurate"]);
    // SATU kueri faktur per pelanggan, dengan kode pelanggan sebagai parameter (indeks customer_no), bukan disisipkan ke teks SQL.
    const kf = r.log.execute.filter((s) => s.includes("sales_invoice"));
    assert.equal(kf.length, 1);
    assert.match(kf[0], /customer_no = \$1/);
    assert.ok(!kf[0].includes("C-01"));
    // Putaran 1 butir 1: CTE pengurai raw_data WAJIB termaterialisasi (rencananya diuji di lib/riwayat-beli-pg.test.ts).
    assert.match(kf[0], /\bw AS MATERIALIZED\b/);
});
