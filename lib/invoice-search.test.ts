/* AM-029 (S6-0d butir 4): pencarian faktur milik kunci antrean. Tanpa DB dan tanpa Accurate —
 * db = urutan jawaban select tiruan, Accurate = fetch tiruan per URL (bukan provider asli). */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BATAS_CARI, cariFaktur, cocokFaktur, jendelaCari, kueriListDo, milikKunci } from "./invoice-search.ts";

const KEY = "KINO:1671-SOP-260014013";
const SESI = { sessionHost: "https://accurate.tiruan", sessionId: "sesi", accessToken: "token" };
const ANTRE = new Date("2026-10-08T02:00:00Z"); // 09:00 WIB

test("milikKunci: charField1 kepala EQUAL; baris hanya cadangan bila kepala kosong", () => {
    assert.equal(milikKunci({ charField1: KEY }, KEY), true);
    assert.equal(milikKunci(JSON.stringify(JSON.stringify({ charField1: KEY })), KEY), true, "raw_data string berlapis");
    assert.equal(milikKunci({ charField1: `${KEY}2` }, KEY), false, "awalan bukan EQUAL");
    assert.equal(milikKunci({ charField1: "KINO:LAIN", detailItem: [{ charField1: KEY }] }, KEY), false, "kepala berisi kunci lain menang");
    assert.equal(milikKunci({ charField1: "", detailItem: [{ charField1: "" }, { charField1: KEY }] }, KEY), true);
    assert.equal(milikKunci({ id: 1, number: "INV/1" }, KEY), false, "raw list.do tanpa charField1");
    assert.equal(milikKunci({ charField1: "" }, ""), false);
});

test("jendela: cache −1 hari, list.do −10 menit pada jam Accurate (UTC+7)", () => {
    const j = jendelaCari(ANTRE);
    assert.equal(j.cacheSejak.toISOString(), "2026-10-07T02:00:00.000Z");
    assert.equal(j.accurateSejakTeks, "08/10/2026 08:50:00");
});

test("kueri list.do: per pelanggan + lastUpdate, TANPA filter.charField1 (diabaikan Accurate, §G)", () => {
    const q = kueriListDo(50123, "08/10/2026 08:50:00", 2);
    assert.equal(q["filter.customerId.val"], "50123");
    assert.equal(q["filter.customerId.op"], "EQUAL");
    assert.equal(q["filter.lastUpdate.op"], "GREATER_EQUAL_THAN");
    assert.equal(q["sp.page"], "2");
    assert.ok(!Object.keys(q).some((k) => k.includes("charField1")));
    assert.ok(!("filter.customerNo" in q), "filter.customerNo ditolak \"Pelanggan tidak tepat\" (§G)");
});

/** db tiruan: tiap `select()` mengembalikan jawaban berikutnya dari daftar. */
function dbTiruan(jawaban: unknown[][]) {
    let i = 0;
    const select = () => {
        const hasil = jawaban[i++] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
        chain.then = (ok: (v: unknown) => unknown, gagal: (e: unknown) => unknown) => Promise.resolve(hasil).then(ok, gagal);
        return chain;
    };
    return { select, dipanggil: () => i } as unknown as Parameters<typeof cariFaktur>[0]["db"] & { dipanggil: () => number };
}

type Halaman = { status?: number; body: unknown };
function accurateTiruan(t: TestContext, list: Halaman[], detail: Record<string, Halaman>) {
    let page = 0;
    return t.mock.method(globalThis, "fetch", async (url: string | URL) => {
        const u = new URL(String(url));
        const jawab = u.pathname.endsWith("/list.do") ? list[page++] : detail[u.searchParams.get("id") ?? ""];
        if (!jawab) throw new Error(`panggilan tak terduga ${u.pathname}${u.search}`);
        return new Response(JSON.stringify(jawab.body), { status: jawab.status ?? 200 });
    });
}
const listOk = (rows: unknown[], rowCount = rows.length, pageCount = 1) => ({ body: { s: true, d: rows, sp: { rowCount, pageCount } } });
const detailOk = (d: unknown) => ({ body: { s: true, d } });
const PELANGGAN = [{ id: 50123 }];

test("cache: ketemu lewat kepala atau baris, DIKONFIRMASI satu detail.do (tanpa list.do)", async (t) => {
    for (const raw of [{ charField1: KEY }, JSON.stringify({ charField1: "", detailItem: [{ charField1: KEY }] })]) {
        await t.test(typeof raw === "string" ? "baris" : "kepala", async (st) => {
            const fetchMock = accurateTiruan(st, [], { 7: detailOk({ id: 7, number: "INV/7", charField1: KEY }) });
            const db = dbTiruan([[{ id: 9 }, { id: 7 }], [{ id: 9, number: "INV/9", raw: { charField1: "LAIN" } }, { id: 7, number: "INV/7", raw }]]);
            const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
            assert.deepEqual(hasil, { hasil: "ketemu", id: "7", number: "INV/7", sumber: "cache", cocok: "charField1", semua: [{ id: "7", number: "INV/7" }] });
            assert.equal(fetchMock.mock.callCount(), 1);
            assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/sales-invoice\/detail\.do\?id=7$/);
        });
    }
});

test("A-RENDAH: hit cache yang tidak terkonfirmasi di Accurate = gagal_cek (cache bisa menyimpan faktur yang sudah dihapus)", async (t) => {
    const cache = () => dbTiruan([[{ id: 7 }], [{ id: 7, number: "INV/7", raw: { charField1: KEY } }]]);
    const cek = async (session: typeof SESI | null, pola: RegExp) => {
        const hasil = await cariFaktur({ db: cache(), key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session });
        assert.equal(hasil.hasil, "gagal_cek");
        assert.match(hasil.hasil === "gagal_cek" ? hasil.alasan : "", pola);
    };
    await t.test("tanpa sesi", async () => cek(null, /INV\/7.*tidak bisa dikonfirmasi tanpa sesi/));
    // Putaran 3: d kosong = faktur TERBUKTI dihapus (lib/sync.ts) -> cache basi, lanjut list.do (bukan jalan buntu).
    await t.test("dihapus (s:true, d kosong) -> cari langsung di Accurate", async (st) => {
        const f = accurateTiruan(st, [listOk([])], { 7: { body: { s: true, d: null } } });
        const db = dbTiruan([[{ id: 7 }], [{ id: 7, number: "INV/7", raw: { charField1: KEY } }], PELANGGAN]);
        const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
        assert.equal(hasil.hasil, "tidak_ketemu_dicek", "SO yang fakturnya dihapus harus bisa difakturkan ulang");
        assert.deepEqual(f.mock.calls.map((c) => new URL(String(c.arguments[0])).pathname.split("/").pop()), ["detail.do", "list.do"]);
    });
    await t.test("dihapus, faktur pengganti ada di list.do -> ketemu yang hidup", async (st) => {
        accurateTiruan(st, [listOk([{ id: 8, number: "INV/8", customer: { id: 50123 }, charField1: KEY }])], { 7: { body: { s: true, d: null } } });
        const db = dbTiruan([[{ id: 7 }], [{ id: 7, number: "INV/7", raw: { charField1: KEY } }], PELANGGAN]);
        const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
        assert.equal(hasil.hasil === "ketemu" && `${hasil.sumber}:${hasil.id}`, "accurate:8");
    });
    await t.test("kunci berubah", async (st) => {
        accurateTiruan(st, [], { 7: detailOk({ id: 7, number: "INV/7", charField1: "KINO:LAIN" }) });
        await cek(SESI, /INV\/7 di Accurate tidak lagi membawa kunci/);
    });
    await t.test("detail.do galat", async (st) => {
        accurateTiruan(st, [], { 7: { status: 503, body: { message: "x" } } });
        await cek(SESI, /konfirmasi faktur cache INV\/7.*HTTP 503/);
    });
});

test("cache tidak ketemu -> list.do per pelanggan -> detail.do per calon -> ketemu (sumber accurate)", async (t) => {
    const db = dbTiruan([[{ id: 1 }], [{ id: 1, number: "INV/1", raw: { id: 1 } }], PELANGGAN]);
    const fetchMock = accurateTiruan(t, [listOk([
        { id: 11, number: "INV/11", customer: { id: 50123 }, lastUpdate: "08/10/2026 09:05:00" },
        { id: 12, number: "INV/12", customer: { id: 50123 }, lastUpdate: "08/10/2026 09:06:00" },
        { id: 13, number: "INV/13", customer: { id: 777 }, lastUpdate: "08/10/2026 09:07:00" }, // filter pelanggan diabaikan
        { id: 14, number: "INV/14", customer: { id: 50123 }, lastUpdate: "07/10/2026 23:00:00" }, // sebelum antre
    ], 4)], {
        11: detailOk({ id: 11, number: "INV/11", charField1: "KINO:LAIN" }),
        12: detailOk({ id: 12, number: "INV/12", charField1: KEY }),
    });
    const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
    assert.deepEqual(hasil, { hasil: "ketemu", id: "12", number: "INV/12", sumber: "accurate", cocok: "charField1", semua: [{ id: "12", number: "INV/12" }] });
    const urls = fetchMock.mock.calls.map((c) => new URL(String(c.arguments[0])));
    assert.equal(urls.length, 3, "1 list.do + 2 detail.do (13 dan 14 disaring)");
    assert.equal(urls[0].searchParams.get("filter.customerId.val"), "50123");
    assert.equal(urls[0].searchParams.get("filter.lastUpdate.val"), "08/10/2026 08:50:00");
    for (const c of fetchMock.mock.calls) assert.equal((c.arguments[1] as RequestInit).method, "GET", "pencarian BACA-SAJA");
});

test("tidak ketemu setelah semua calon diperiksa -> tidak_ketemu_dicek (bukan bukti tidak ada)", async (t) => {
    const db = dbTiruan([[], PELANGGAN]);
    accurateTiruan(t, [listOk([{ id: 21, customer: { id: 50123 }, lastUpdate: "08/10/2026 10:00:00" }], 1)], {
        21: detailOk({ id: 21, number: "INV/21", charField1: `${KEY}9` }),
    });
    assert.deepEqual(await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI }),
        { hasil: "tidak_ketemu_dicek", sumber: "accurate", diperiksa: 1, barisListDo: 1, calonTanpaKunci: [] });
});

test("gagal_cek: tanpa sesi, pelanggan tak ada, list.do s:false, rowCount raksasa, calon terlalu banyak, detail.do galat", async (t) => {
    const cek = async (db: ReturnType<typeof dbTiruan>, session: typeof SESI | null, pola: RegExp) => {
        const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session });
        assert.equal(hasil.hasil, "gagal_cek");
        assert.match(hasil.hasil === "gagal_cek" ? hasil.alasan : "", pola);
    };
    const tanpaJaringan = t.mock.method(globalThis, "fetch", async () => { throw new Error("tidak boleh ke Accurate"); });
    await cek(dbTiruan([[]]), null, /tidak ada sesi Accurate/);
    await cek(dbTiruan([[], []]), SESI, /tidak ada di master customer/);
    await cek(dbTiruan([[], [{ id: 1 }, { id: 2 }]]), SESI, /tidak unik/);
    assert.equal(tanpaJaringan.mock.callCount(), 0);
    tanpaJaringan.mock.restore();

    await t.test("list.do s:false (Pelanggan tidak tepat)", async (st) => {
        accurateTiruan(st, [{ body: { s: false, d: ["Pelanggan tidak tepat"] } }], {});
        await cek(dbTiruan([[], PELANGGAN]), SESI, /Pelanggan tidak tepat/);
    });
    await t.test("rowCount raksasa = filter diabaikan", async (st) => {
        const f = accurateTiruan(st, [listOk([{ id: 1 }], 247_847, 2479)], {});
        await cek(dbTiruan([[], PELANGGAN]), SESI, /247847 faktur/);
        assert.equal(f.mock.callCount(), 1, "tidak ada detail.do");
    });
    await t.test("calon melebihi batas", async (st) => {
        const rows = Array.from({ length: BATAS_CARI.calonDetail + 1 }, (_, i) => ({ id: 100 + i, customer: { id: 50123 } }));
        accurateTiruan(st, [listOk(rows)], {});
        await cek(dbTiruan([[], PELANGGAN]), SESI, /faktur calon tanpa charField1 di list\.do \(batas 25\)/);
    });
    await t.test("detail.do 500", async (st) => {
        accurateTiruan(st, [listOk([{ id: 31, customer: { id: 50123 } }])], { 31: { status: 500, body: { message: "err" } } });
        await cek(dbTiruan([[], PELANGGAN]), SESI, /detail\.do HTTP 500/);
    });
    await t.test("list.do bukan amplop", async (st) => {
        accurateTiruan(st, [{ status: 502, body: { message: "Bad Gateway" } }], {});
        await cek(dbTiruan([[], PELANGGAN]), SESI, /HTTP 502/);
    });
});

test("list.do berhalaman: semua halaman dibaca sebelum menyimpulkan", async (t) => {
    const db = dbTiruan([[], PELANGGAN]);
    const f = accurateTiruan(t, [
        listOk([{ id: 41, customer: { id: 50123 } }], 2, 2),
        listOk([{ id: 42, customer: { id: 50123 } }], 2, 2),
    ], { 41: detailOk({ id: 41, charField1: "X" }), 42: detailOk({ id: 42, number: "INV/42", charField1: KEY }) });
    const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI, batas: { calonDetail: 5 } });
    assert.equal(hasil.hasil, "ketemu");
    assert.equal(f.mock.callCount(), 4);
});

test("A-RENDAH: list.do tanpa sp.pageCount dan baris < rowCount -> gagal_cek (bukan tidak ketemu dari halaman pertama saja)", async (t) => {
    const db = dbTiruan([[], PELANGGAN]);
    accurateTiruan(t, [{ body: { s: true, d: [{ id: 51, customer: { id: 50123 } }], sp: { rowCount: 3 } } }], {
        51: detailOk({ id: 51, number: "INV/51", charField1: "LAIN" }),
    });
    const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
    assert.equal(hasil.hasil, "gagal_cek");
    assert.match(hasil.hasil === "gagal_cek" ? hasil.alasan : "", /1 dari 3 faktur/);
});

// §I (bukti produksi 10 Okt): list.do mengembalikan charField1 TERISI -> diputuskan langsung dari baris list.do;
// detail.do hanya cadangan untuk baris yang charField1-nya absen/kosong, dan batas 25 hanya untuk mereka.
test("hibrida: charField1 di baris list.do diputuskan langsung (EQUAL, trim) — tanpa detail.do", async (t) => {
    const db = dbTiruan([[], PELANGGAN]);
    const lain = Array.from({ length: BATAS_CARI.calonDetail + 5 }, (_, i) => ({ id: 200 + i, customer: { id: 50123 }, charField1: `KINO:LAIN-${i}` }));
    const f = accurateTiruan(t, [listOk([...lain, { id: 61, number: "INV/61", customer: { id: 50123 }, charField1: `  ${KEY} ` }])], {});
    const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
    assert.equal(hasil.hasil, "ketemu");
    assert.equal(hasil.hasil === "ketemu" && hasil.id, "61");
    assert.equal(hasil.hasil === "ketemu" && hasil.cocok, "charField1");
    assert.equal(f.mock.callCount(), 1, "hanya list.do; 30 baris berkunci lain tidak membuka detail.do dan tidak kena batas 25");
    assert.match(new URL(String(f.mock.calls[0].arguments[0])).searchParams.get("fields") ?? "", /charField1/);
});

test("hibrida: charField1 absen/kosong di list.do -> detail.do cadangan; berkunci lain -> dilewati", async (t) => {
    const db = dbTiruan([[], PELANGGAN]);
    const f = accurateTiruan(t, [listOk([
        { id: 71, customer: { id: 50123 }, charField1: "KINO:LAIN" },
        { id: 72, customer: { id: 50123 }, charField1: "" },
        { id: 73, customer: { id: 50123 } },
    ])], {
        72: detailOk({ id: 72, number: "INV/72", charField1: "", detailItem: [{ charField1: "X" }] }),
        73: detailOk({ id: 73, number: "INV/73", charField1: KEY }),
    });
    const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
    assert.equal(hasil.hasil === "ketemu" && hasil.id, "73");
    const ids = f.mock.calls.slice(1).map((c) => new URL(String(c.arguments[0])).searchParams.get("id"));
    assert.deepEqual(ids, ["72", "73"], "71 diputuskan dari list.do");
});

// A-RENDAH butir 9: faktur yang disimpan ulang dari layar Accurate bisa kehilangan charField1. Pola description yang
// KITA tulis (`Order <kunci> | outlet | channel`, buildInvoicePayload) jadi pengenal cadangan — hanya bila kepala kosong.
test("cocokFaktur: description `Order <kunci> |` hanya cadangan saat charField1 kepala kosong", () => {
    assert.equal(cocokFaktur({ charField1: "", description: `Order ${KEY} | TK SUBHAN | GT` }, KEY), "description");
    assert.equal(cocokFaktur({ description: `Order ${KEY}` }, KEY), "description");
    assert.equal(cocokFaktur({ charField1: "", description: `Order ${KEY}2 | TK SUBHAN` }, KEY), null, "awalan bukan kunci yang sama");
    assert.equal(cocokFaktur({ charField1: "", description: `Disalin dari Order ${KEY}` }, KEY), null, "tanpa pemisah ` |` = bukan pola kita");
    // Putaran 3: pola kita selalu DI AWAL description.
    assert.equal(cocokFaktur({ charField1: "", description: `Standing Order ${KEY} | x` }, KEY), null, "awalan lain");
    assert.equal(cocokFaktur({ charField1: "", description: `Catatan | Order ${KEY} | y` }, KEY), null, "di tengah catatan");
    assert.equal(cocokFaktur({ charField1: "KINO:LAIN", description: `Order ${KEY} | X` }, KEY), null, "kepala berkunci lain menang");
    assert.equal(cocokFaktur({ charField1: KEY, description: "" }, KEY), "charField1");
});

test("detail.do: charField1 hilang tetapi description pola kita -> ketemu {cocok: description}; yang tidak cocok dikembalikan sebagai calon tanpa kunci", async (t) => {
    await t.test("ketemu lewat description", async (st) => {
        const db = dbTiruan([[], PELANGGAN]);
        accurateTiruan(st, [listOk([{ id: 81, customer: { id: 50123 }, charField1: "" }])], {
            81: detailOk({ id: 81, number: "INV/81", charField1: "", description: `Order ${KEY} | TK A | GT` }),
        });
        const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
        assert.equal(hasil.hasil === "ketemu" && hasil.cocok, "description");
        assert.equal(hasil.hasil === "ketemu" && hasil.id, "81");
    });
    await t.test("tidak ketemu: calon berkepala kosong ditampilkan, tidak diputuskan", async (st) => {
        const db = dbTiruan([[], PELANGGAN]);
        accurateTiruan(st, [listOk([{ id: 91, customer: { id: 50123 } }, { id: 92, customer: { id: 50123 }, charField1: "KINO:LAIN" }])], {
            91: detailOk({ id: 91, number: "INV/91", charField1: "", description: "manual", totalAmount: 125000.5, transDate: "08/10/2026" }),
        });
        const hasil = await cariFaktur({ db, key: KEY, customerNo: "C-1-KN", queuedAt: ANTRE, session: SESI });
        assert.deepEqual(hasil, { hasil: "tidak_ketemu_dicek", sumber: "accurate", diperiksa: 2, barisListDo: 2,
            calonTanpaKunci: [{ id: "91", number: "INV/91", totalAmount: 125000.5, transDate: "08/10/2026" }] });
    });
});
