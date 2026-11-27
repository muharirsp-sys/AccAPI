/* Owner 19 Nov 2026: nota hit list belum lunas tidak boleh menahan order outlet hit list. Order biasa/campuran lolos bila (piutang di
 * luar hit list + pesanan terbuka + order) <= limit dan tidak ada nota BUKAN hit list belum lunas yang sudah mencapai batas hari.
 * Owner 25 Nov 2026: order NPL (semua baris SKU hit list) -> batas dilepas tanpa memeriksa piutang; hanya toko hold OD yang ditahan.
 * Tanpa DB dan tanpa Accurate: pembaca/penulis dipalsukan, `db` dan `fetch` diganti tiruan. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "./db.ts";
import {
    GT_HITLIST_OUTLET, GT_HITLIST_SKU, MAKS_PERIKSA_PER_KIRIM, isiHitlist, lolosBatasPiutang, notaGtHitlist, pelangganHitlist, putuskan,
    tolakBatas, type Beban, type DepsLolos, type NotaBelumLunas, type PelangganBatas, type TolakBatas,
} from "./gt-hitlist-npl.ts";
import { jawabanCron, sendQueuedInvoices, type SenderDeps } from "./invoice-sender.ts";

const HL = "K1046012025020", BUKAN = "K1330004020010";
const UMUR = "Pelanggan \"FITRIA {C-FIT025}\" melewati batas piutang. Ada faktur yang belum dilunasi lebih dari 28 hari";
const NOMINAL = "Pelanggan \"FITRIA {C-FIT025}\" melewati batas piutang. Total piutang dan pesanan menjadi lebih dari Rp 1,000,000";
const nota = (customerNo: string, ...itemNo: string[]) => ({ customerNo, detailItem: itemNo.map((i) => ({ itemNo: i })) });

test("data: 29 SKU berkategori dan 1.467 kode outlet Surya Perkasa", () => {
    assert.equal(GT_HITLIST_SKU.size, 29);
    assert.equal(GT_HITLIST_OUTLET.size, 1467);
    assert.ok(GT_HITLIST_OUTLET.has("C-FIT025") && GT_HITLIST_OUTLET.has("C-R S001"));
    assert.ok(!GT_HITLIST_SKU.has("K1048009004520"), "pasta gigi B&B tanpa kategori bukan hit list");
});

test("pelanggan/nota hit list: -KN outlet hit list; nota = SEMUA baris SKU hit list (payload itemNo atau detail.do item.no)", () => {
    assert.equal(pelangganHitlist(" c-fit025-kn "), true);
    for (const no of ["C-FIT025", "C-FIT025-RB", "C-TIDAKADA-KN"]) assert.equal(pelangganHitlist(no), false, no);
    assert.equal(notaGtHitlist(nota("C-FIT025-KN", HL, "K1531001003011")), true);
    assert.equal(notaGtHitlist(nota("C-FIT025-KN", HL, BUKAN)), false, "campuran");
    assert.equal(notaGtHitlist(nota("C-FIT025-KN")), false, "tanpa baris");
    assert.equal(isiHitlist([{ item: { no: HL } }, { item: { no: "k1090001010010" } }]), true);
    assert.equal(isiHitlist([{ item: { no: HL } }, { item: null }]), false);
});

test("tolakBatas: hanya pesan batas piutang (hari dan/atau nominal); pesan lain / terpotong / dua klausul satu teks = null", () => {
    assert.deepEqual(tolakBatas(JSON.stringify([UMUR])), { umur: true, nominal: false });
    assert.deepEqual(tolakBatas(JSON.stringify([NOMINAL])), { umur: false, nominal: true });
    assert.deepEqual(tolakBatas(JSON.stringify([UMUR, NOMINAL])), { umur: true, nominal: true });
    assert.equal(tolakBatas(JSON.stringify([UMUR, "Harga jual tidak boleh nol"])), null);
    assert.equal(tolakBatas(JSON.stringify([`${UMUR}. Total piutang dan pesanan menjadi lebih dari Rp 1`])), null);
    assert.equal(tolakBatas(JSON.stringify([UMUR]).slice(0, 60)), null);
    assert.equal(tolakBatas("[]"), null);
});

const pelanggan = (o: Partial<PelangganBatas> = {}): PelangganBatas => ({
    id: 77, customerNo: "C-FIT025-KN", notes: "", umurAktif: true, umur: 28, nominalAktif: true, nominal: 1_000_000, ...o,
});
const HARI_INI = "2026-11-19";
const n = (nomor: string, tanggal: string, sisa: number, hitlist: boolean): NotaBelumLunas => ({ nomor, tanggal, sisa, hitlist });
const NOTA_HL_LAMA = n("INV/HL1", "2026-10-01", 5_000_000, true);
const NOTA_BUKAN_BARU = n("INV/B1", "2026-11-10", 300_000, false);
const NOTA_BUKAN_LAMA = n("INV/B2", "2026-10-22", 100_000, false); // 28 hari tepat = sudah mencapai batas (lebih ketat dari Accurate)
const order = (hitlist: boolean, total = 200_000) => ({ customerNo: "C-FIT025-KN", hitlist, total });
const DUA: TolakBatas = { umur: true, nominal: true };
const beban = (nota: NotaBelumLunas[], pesanan = 0): Beban => ({ nota, pesanan });

test("putuskan: order BUKAN hit list lolos bila yang menahan hanya nota hit list", () => {
    const k = putuskan(pelanggan(), beban([NOTA_HL_LAMA, NOTA_BUKAN_BARU]), order(false), DUA, HARI_INI);
    assert.equal(k.boleh, true, k.alasan);
    assert.deepEqual(k.lepas, DUA);
});

test("putuskan: nota BUKAN hit list belum lunas sudah mencapai batas hari -> order biasa ditahan", () => {
    const biasa = putuskan(pelanggan(), beban([NOTA_HL_LAMA, NOTA_BUKAN_LAMA]), order(false), DUA, HARI_INI);
    assert.equal(biasa.boleh, false);
    assert.match(biasa.alasan, /INV\/B2/);
    assert.equal(putuskan(pelanggan(), beban([n("INV/B5", "2026-10-23", 1, false)]), order(false), DUA, HARI_INI).boleh, true, "27 hari = belum");
});

test("putuskan: order NPL (owner 25 Nov) -> batas yang disebut Accurate dilepas tanpa memeriksa nota lewat hari maupun limit", () => {
    // ASMA C-ASM016-KN 25 Nov: limit 200rb, nota biasa 161.800 + order NPL 70.400 -> dulu ditahan limit.
    const asma = putuskan(pelanggan({ nominal: 200_000 }), beban([n("INV/2611/KN00178", "2026-11-05", 161_800, false)]), order(true, 70_400),
        { umur: false, nominal: true }, HARI_INI);
    assert.equal(asma.boleh, true, asma.alasan);
    assert.deepEqual(asma.lepas, { umur: false, nominal: true });
    assert.match(asma.alasan, /order NPL/);
    const lewatSemua = putuskan(pelanggan(), beban([NOTA_BUKAN_LAMA, n("INV/B6", "2026-10-01", 9e9, false)], 9e9), order(true), DUA, HARI_INI);
    assert.equal(lewatSemua.boleh, true, lewatSemua.alasan);
    assert.deepEqual(lewatSemua.lepas, DUA);
});

test("putuskan: toko hold OD (1/1, catatan Hold, angka tak terbaca) -> order NPL pun ditahan", () => {
    for (const [nama, p] of [
        ["hold 1/1", pelanggan({ nominal: 1, umur: 1 })],
        ["catatan Hold", pelanggan({ notes: "Hold - Toko Ini Sementara Di Tutup Untuk Transaksi, Karena Tedeteksi Ada Riwayat ..." })],
        ["limit tak terbaca", pelanggan({ nominal: null })],
        ["hari tak terbaca", pelanggan({ umur: null })],
    ] as const) {
        const k = putuskan(p, beban([]), order(true), DUA, HARI_INI);
        assert.equal(k.boleh, false, nama);
        assert.match(k.alasan, /hold/i, nama);
    }
    const dibuka = pelanggan({ nominal: 200_000, notes: "Hold OD60 dibuka permanen 09/11/2026 (owner): limit dikembalikan ke Piutang Rp 200.000\n"
        + "Hold - Toko Ini Sementara Di Tutup Untuk Transaksi, Karena Tedeteksi Ada Riwayat Pembayaran Lebih dari 60 Hari" });
    assert.equal(putuskan(dibuka, beban([]), order(true), DUA, HARI_INI).boleh, true, "hold yang sudah dibuka permanen bukan hold");
});

test("putuskan: limit order biasa = piutang bukan hit list + pesanan terbuka + order; angka tak terbaca = ditahan", () => {
    assert.equal(putuskan(pelanggan(), beban([NOTA_BUKAN_BARU], 500_000), order(false), DUA, HARI_INI).boleh, true, "300rb + 500rb + 200rb = 1jt");
    assert.match(putuskan(pelanggan(), beban([NOTA_BUKAN_BARU], 500_001), order(false), DUA, HARI_INI).alasan, /pesanan terbuka/);
    assert.equal(putuskan(pelanggan(), beban([]), order(false, Number.NaN), DUA, HARI_INI).boleh, false);
    assert.equal(putuskan(pelanggan({ nominal: null }), beban([]), order(false), DUA, HARI_INI).boleh, false);
});

test("putuskan: piutang di luar hit list + order > limit, toko hold Rp 1, batas yang disebut Accurate tidak tercentang -> ditahan", () => {
    assert.match(putuskan(pelanggan(), beban([NOTA_BUKAN_BARU]), order(false, 800_000), DUA, HARI_INI).alasan, /melewati limit/);
    assert.equal(putuskan(pelanggan({ nominal: 1, umur: 1 }), beban([NOTA_HL_LAMA]), order(false), DUA, HARI_INI).boleh, false, "hold 1/1");
    assert.equal(putuskan(pelanggan({ nominalAktif: false }), beban([]), order(true), DUA, HARI_INI).boleh, false);
    assert.equal(putuskan(pelanggan({ umurAktif: false }), beban([]), order(true), { umur: true, nominal: false }, HARI_INI).boleh, false);
});

test("putuskan: limit tidak tercentang = tidak dihitung; hanya batas yang disebut Accurate yang dilepas", () => {
    const k = putuskan(pelanggan({ nominalAktif: false }), beban([NOTA_HL_LAMA, n("INV/B4", "2026-11-18", 9e9, false)]), order(false),
        { umur: true, nominal: false }, HARI_INI);
    assert.equal(k.boleh, true, k.alasan);
    assert.deepEqual(k.lepas, { umur: true, nominal: false });
});

/** Pelanggan palsu BERSTATUS: lepas = tidak tercentang; pulih = tercentang (kecuali `pulihTakMenempel`). */
function palsu(awal: PelangganBatas | null, notaBL: NotaBelumLunas[] | null, opsi: { gagalTulis?: number[]; pulihTakMenempel?: boolean } = {}) {
    const jejak: string[] = [];
    const tulisan: Record<string, unknown>[] = [];
    const st = awal ? { ...awal } : null;
    let k = 0;
    const deps: DepsLolos<string> = {
        baca: async () => { jejak.push("baca"); return st ? { ...st } : null; },
        beban: async () => { jejak.push("nota"); return notaBL ? beban(notaBL) : null; },
        tulis: async (p) => {
            const i = k++;
            const pulih = p.customerLimitAge === true || p.customerLimitAmount === true;
            jejak.push(pulih ? "pulih" : "lepas");
            tulisan.push(p);
            if (opsi.gagalTulis?.includes(i)) throw new Error(`tulis ${i} gagal`);
            if (!st) return;
            if ("customerLimitAge" in p) st.umurAktif = p.customerLimitAge === true && !opsi.pulihTakMenempel;
            if ("customerLimitAmount" in p) st.nominalAktif = p.customerLimitAmount === true && !opsi.pulihTakMenempel;
        },
        kirimUlang: async () => { jejak.push("kirim"); return "terkirim"; },
        jeda: async () => undefined,
        hariIni: HARI_INI,
    };
    return { jejak, tulisan, deps };
}

test("lolosBatasPiutang: lepas batas yang disebut -> kirim ulang sekali -> pulihkan nilai asal kedua batas", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const { jejak, tulisan, deps } = palsu(pelanggan(), [NOTA_HL_LAMA, NOTA_BUKAN_BARU]);
    const h = await lolosBatasPiutang(order(false), DUA, deps);
    assert.deepEqual(jejak, ["baca", "nota", "lepas", "kirim", "baca", "pulih", "baca"]);
    assert.deepEqual(tulisan, [
        { id: 77, customerLimitAge: false, customerLimitAmount: false },
        { id: 77, customerLimitAge: true, customerLimitAgeValue: 28, customerLimitAmount: true, customerLimitAmountValue: 1_000_000 },
    ]);
    assert.equal(h.dicoba, true);
    assert.equal(h.hasil, "terkirim");
    assert.equal(h.dipulihkan, true);
});

test("lolosBatasPiutang: ditahan / Hendra / tidak ditemukan / nota tak terbaca / toko terlindungi = tidak menulis apa pun", async () => {
    for (const [p, notaBL, no, pola] of [
        [pelanggan(), [NOTA_HL_LAMA, NOTA_BUKAN_LAMA], "C-FIT025-KN", /INV\/B2/],
        [pelanggan({ notes: "Hendra via Wa" }), [NOTA_HL_LAMA], "C-FIT025-KN", /Hendra/],
        [null, [], "C-FIT025-KN", /tidak ditemukan/],
        [pelanggan(), null, "C-FIT025-KN", /lebih dari 30 atau pesanan/],
        [pelanggan(), [NOTA_HL_LAMA], "C-IND051-KN", /terlindungi/],
    ] as const) {
        const { tulisan, deps } = palsu(p, notaBL ? [...notaBL] : null);
        const h = await lolosBatasPiutang({ ...order(false), customerNo: no }, DUA, deps);
        assert.equal(h.dicoba, false);
        assert.match(h.alasan, pola);
        assert.equal(tulisan.length, 0);
    }
});

test("lolosBatasPiutang: tenggat pelepasan lewat (pembacaan lambat) -> tidak melepas, tidak kirim ulang", async () => {
    const { tulisan, jejak, deps } = palsu(pelanggan(), [NOTA_HL_LAMA]);
    const h = await lolosBatasPiutang(order(true), DUA, { ...deps, tenggatLepas: Date.now() - 1 });
    assert.equal(h.dicoba, false);
    assert.match(h.alasan, /hampir habis/);
    assert.equal(tulisan.length, 0);
    assert.ok(!jejak.includes("kirim"));
});

test("lolosBatasPiutang: pelepasan gagal -> TIDAK kirim ulang; pemulihan MENULIS dulu (pelepasan mungkin diterapkan belakangan)", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const { jejak, deps } = palsu(pelanggan(), [NOTA_HL_LAMA], { gagalTulis: [0] });
    const h = await lolosBatasPiutang(order(true), { umur: true, nominal: false }, deps);
    assert.equal(h.dicoba, false);
    assert.deepEqual(jejak, ["baca", "lepas", "pulih", "baca"], "order NPL: nota tidak dibaca");
    assert.equal(h.dipulihkan, true);
});

test("lolosBatasPiutang: pemulihan tak menempel -> dua tulisan, dilaporkan GAGAL", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    t.mock.method(console, "error", () => undefined);
    const { jejak, deps } = palsu(pelanggan(), [NOTA_HL_LAMA], { pulihTakMenempel: true });
    const h = await lolosBatasPiutang(order(true), DUA, deps);
    assert.equal(h.dicoba, true);
    assert.equal(h.dipulihkan, false);
    assert.equal(jejak.filter((j) => j === "pulih").length, 2);
});

// ---------------- Lewat sendQueuedInvoices (jalur kirim nyata, fetch tiruan) ----------------

const dialect = new PgDialect();
const SESI = { sessionHost: "https://contoh.invalid", sessionId: "sesi", accessToken: "token" };
/** Sesi SISTEM (pemilik) untuk baca + lepas/pulih batas — owner 27 Nov 2026; sesi penekan (SESI) hanya mengirim faktur. */
const SESI_SISTEM = { sessionHost: "https://contoh.invalid", sessionId: "sesi-pemilik", accessToken: "token-pemilik" };
/** Pelonggaran asli tanpa jeda 7 dtk dan dengan tanggal tetap. */
const tanpaJeda: SenderDeps = {
    refresh: async () => undefined,
    lolos: (o, tolak, d) => lolosBatasPiutang(o, tolak, { ...d, jeda: async () => undefined, hariIni: HARI_INI }),
    sesiBatas: async () => SESI_SISTEM,
};
/** Token Bearer yang dipakai satu panggilan fetch tiruan. */
const tokenDari = (c: { arguments: unknown[] }) => String(((c.arguments[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization ?? "");

type Jawab = { s: boolean; d?: unknown; r?: unknown } | Error;
type NotaAccurate = { number: string; tanggal: string; sisa: number; items: string[] };

function antrean(t: TestContext, isi: { customerNo?: string; items: string[] }[], faktur: Jawab[],
    opsi: { pulihDitolak?: boolean; belumPulih?: string[]; batasAwal?: boolean; nota?: NotaAccurate[]; pesanan?: number[]; tanpaHalaman?: boolean;
        sisaRusak?: boolean; kenaLaju?: boolean } = {}) {
    t.mock.method(console, "warn", () => undefined);
    t.mock.method(console, "error", () => undefined);
    const rows = isi.map((x, i) => ({
        orderId: `KINO-NON-FOOD:1671-SOP-${i + 1}`, state: "queued", attempts: 0, orderDate: "2026-11-19", createdAt: new Date(),
        payload: {
            customerNo: x.customerNo ?? "C-FIT025-KN", transDate: "19/11/2026", typeAutoNumber: 7, taxable: true, inclusiveTax: false, description: "",
            charField1: `KINO-NON-FOOD:1671-SOP-${i + 1}`, charField2: "",
            detailItem: x.items.map((it) => ({ itemNo: it, quantity: 1, unitPrice: 1000, itemUnitId: 1, itemDiscPercent: "", itemCashDiscount: 0,
                detailNotes: "", charField1: "" })),
        },
    }));
    const pilih = { from: () => pilih, where: () => pilih, orderBy: () => pilih, limit: async () => rows };
    t.mock.method(db, "select", (() => pilih) as unknown as typeof db.select);
    const sqls: { sql: string; params: unknown[] }[] = [];
    t.mock.method(db, "execute", (async (query: SQL) => {
        const r = dialect.sqlToQuery(query);
        sqls.push(r);
        if (r.sql.includes("'gt_hitlist'->>'dipulihkan'")) return { rows: (opsi.belumPulih ?? []).map((no) => ({ no, umur: true, nominal: true })) };
        const row = rows.find((x) => r.params.includes(x.orderId));
        return { rows: r.sql.includes("'kirim'") && row ? [{ order_id: row.orderId, payload: row.payload }] : [] };
    }) as unknown as typeof db.execute);
    const fakturDikirim: string[] = [];
    const simpanPelanggan: Record<string, unknown>[] = [];
    const awal = opsi.batasAwal ?? true;
    let batas = { customerLimitAge: awal, customerLimitAgeValue: 28, customerLimitAmount: awal, customerLimitAmountValue: 10_000_000 };
    const notaAcc = opsi.nota ?? [
        { number: "INV/HL1", tanggal: "01/10/2026", sisa: 9_500_000, items: [HL] },
        { number: "INV/B1", tanggal: "10/11/2026", sisa: 300_000, items: [BUKAN, HL] },
    ];
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const LAJU = { s: false, d: ["Jumlah request API melebihi toleransi yang diperbolehkan. Batas maksimum yang diperbolehkan yaitu 8 proses paralel per Token dan 8 request per detik."] };
    const sudahLaju = new Set<string>();
    const kirim = t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        // Batas laju sekali per jenis permintaan (baca detail pelanggan + simpan pelepasan): harus diulang, bukan menahan order.
        const jenis = u.includes("/customer/detail.do") ? "detail" : u.includes("/customer/save.do") ? "simpan" : "";
        if (opsi.kenaLaju && jenis && !sudahLaju.has(jenis)) { sudahLaju.add(jenis); return ok(LAJU); }
        if (u.includes("/sales-invoice/save.do")) {
            fakturDikirim.push(JSON.parse(String(init?.body)).charField1);
            const j = faktur[Math.min(fakturDikirim.length - 1, faktur.length - 1)];
            if (j instanceof Error) throw j;
            return ok(j);
        }
        if (u.includes("/sales-invoice/list.do")) {
            return ok({ s: true, ...(opsi.tanpaHalaman ? {} : { sp: { pageCount: 1, rowCount: notaAcc.length } }),
                d: notaAcc.map((x, i) => ({ id: 500 + i, number: x.number, transDate: x.tanggal, primeOwing: opsi.sisaRusak && i === 1 ? "300.000,00" : x.sisa,
                    customer: { id: 77 } })) });
        }
        if (u.includes("/sales-order/list.do")) {
            assert.ok(u.includes("filter.status.op=NOT_EQUAL") && u.includes("filter.status.val=CLOSED"), "hanya pesanan yang belum ditutup");
            const so = opsi.pesanan ?? [];
            return ok({ s: true, sp: { pageCount: 1, rowCount: so.length }, d: so.map((v, i) => ({ id: 900 + i, number: `SO-${i}`, status: "WAITING", totalAmount: v, customer: { id: 77 } })) });
        }
        if (u.includes("/sales-invoice/detail.do")) {
            const x = notaAcc[Number(new URL(u).searchParams.get("id")) - 500];
            return ok({ s: true, d: { detailItem: x.items.map((no) => ({ item: { no } })) } });
        }
        if (u.includes("/customer/list.do")) return ok({ s: true, d: [{ id: 77, customerNo: "C-FIT025-KN" }, { id: 78, customerNo: "C-FIT025-KNX" }] });
        if (u.includes("/customer/detail.do")) return ok({ s: true, d: { id: 77, customerNo: "C-FIT025-KN", notes: null, ...batas } });
        if (u.includes("/customer/save.do")) {
            const p = JSON.parse(String(init?.body)) as Record<string, unknown>;
            simpanPelanggan.push(p);
            if ((p.customerLimitAge === true || p.customerLimitAmount === true) && opsi.pulihDitolak) return ok({ s: false, d: ["ditolak tiruan"] });
            const { id: _abaikan, ...ubah } = p;
            void _abaikan;
            batas = { ...batas, ...ubah };
            return ok({ s: true, r: { id: 77 } });
        }
        return ok({ s: true, d: [] }); // pemeriksaan sesi baca-saja
    });
    return { kirim, sqls, simpanPelanggan, fakturDikirim, batas: () => batas };
}

const TOLAK_DUA = { s: false, d: [UMUR, NOMINAL] };
const TOLAK_UMUR = { s: false, d: [UMUR] };
const TERIMA = { s: true, r: { id: 9, number: "INV/2611/KN09" } };
const kirimSemua = (deps: SenderDeps = tanpaJeda) => sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "p" }, deps);
const BATAS_ASAL = { customerLimitAge: true, customerLimitAgeValue: 28, customerLimitAmount: true, customerLimitAmountValue: 10_000_000 };

test("kirim: order BUKAN hit list tertahan hari + limit karena nota hit list -> lolos, kedua batas kembali, jejak di event", async (t) => {
    const a = antrean(t, [{ items: [BUKAN] }], [TOLAK_DUA, TERIMA]);
    const hasil = await kirimSemua();
    assert.equal(a.fakturDikirim.length, 2);
    assert.deepEqual(a.simpanPelanggan[0], { id: 77, customerLimitAge: false, customerLimitAmount: false });
    assert.deepEqual(a.batas(), BATAS_ASAL);
    assert.equal(hasil.sent, 1);
    assert.equal(hasil.gagalPulih, 0);
    assert.match(hasil.results[0].catatan ?? "", /nota bukan hit list; 1 nota hit list belum lunas Rp 9\.500\.000 tidak dihitung/);
    const detail = a.sqls.find((q) => q.sql.includes("http_status"))?.params.find((p) => typeof p === "string" && p.includes("gt_hitlist"));
    const g = JSON.parse(String(detail)).gt_hitlist;
    assert.equal(g.pelanggan, "C-FIT025-KN");
    assert.equal(g.dipulihkan, true);
    assert.deepEqual(g.lepas, { umur: true, nominal: true });
});

test("kirim: jawaban batas laju Accurate (8 request/detik) pada baca & simpan pelanggan diulang sekali, order tetap lolos", async (t) => {
    const a = antrean(t, [{ items: [BUKAN] }], [TOLAK_DUA, TERIMA], { kenaLaju: true });
    const hasil = await kirimSemua();
    assert.equal(hasil.sent, 1, hasil.results[0].catatan);
    assert.deepEqual(a.batas(), BATAS_ASAL);
});

test("kirim: ada nota BUKAN hit list belum lunas lewat batas hari -> order bukan hit list tetap ditolak, pelanggan tidak disentuh", async (t) => {
    const a = antrean(t, [{ items: [BUKAN] }], [TOLAK_UMUR], { nota: [
        { number: "INV/HL1", tanggal: "01/10/2026", sisa: 500_000, items: [HL] },
        { number: "INV/B2", tanggal: "01/10/2026", sisa: 100_000, items: [BUKAN] },
    ] });
    const hasil = await kirimSemua();
    assert.equal(a.fakturDikirim.length, 1);
    assert.equal(a.simpanPelanggan.length, 0);
    assert.equal(hasil.rejected, 1);
    assert.match(hasil.results[0].catatan ?? "", /INV\/B2/);
});

test("kirim: order NPL ditolak batas hari dan/atau limit -> lolos tanpa membaca nota, hanya batas yang disebut dilepas lalu dipulihkan", async (t) => {
    for (const [nama, tolak, lepas] of [
        ["hari", TOLAK_UMUR, { id: 77, customerLimitAge: false }],
        ["limit (ASMA 25 Nov)", { s: false, d: [NOMINAL] }, { id: 77, customerLimitAmount: false }],
        ["hari + limit", TOLAK_DUA, { id: 77, customerLimitAge: false, customerLimitAmount: false }],
    ] as const) {
        await t.test(nama, async (st) => {
            const a = antrean(st, [{ items: [HL] }], [tolak, TERIMA], { pesanan: [99_000_000],
                nota: [{ number: "INV/B2", tanggal: "01/10/2026", sisa: 99_000_000, items: [BUKAN] }] });
            const hasil = await kirimSemua();
            assert.equal(hasil.sent, 1, hasil.results[0].catatan);
            assert.deepEqual(a.simpanPelanggan[0], lepas);
            assert.deepEqual(a.batas(), BATAS_ASAL);
            assert.match(hasil.results[0].catatan ?? "", /order NPL/);
            assert.ok(!a.kirim.mock.calls.some((c) => /\/sales-(invoice|order)\/list/.test(String(c.arguments[0]))), "piutang tidak dibaca");
            // Owner 27 Nov: pelanggan dibaca + dilepas/dipulihkan dengan sesi SISTEM; faktur dikirim (2x) dengan sesi penekan.
            const pelangganC = a.kirim.mock.calls.filter((c) => /\/customer\//.test(String(c.arguments[0])));
            assert.ok(pelangganC.length > 0 && pelangganC.every((c) => tokenDari(c) === "Bearer token-pemilik"), "pelanggan = sesi sistem");
            const fakturC = a.kirim.mock.calls.filter((c) => /\/sales-invoice\/save\.do/.test(String(c.arguments[0])));
            assert.ok(fakturC.length === 2 && fakturC.every((c) => tokenDari(c) === "Bearer token"), "faktur = sesi penekan");
        });
    }
});

test("kirim: sesi Accurate sistem tidak bisa dipakai -> order tetap ditolak, pelanggan tidak dibaca/disentuh, sebabnya tercatat", async (t) => {
    for (const [nama, sesiBatas] of [
        ["tidak ada sesi admin", async () => "Tidak ada sesi Accurate milik admin."],
        ["galat", async () => { throw new Error("db putus"); }],
    ] as const) {
        await t.test(nama, async (st) => {
            const a = antrean(st, [{ items: [HL] }], [TOLAK_UMUR, TERIMA]);
            const hasil = await kirimSemua({ ...tanpaJeda, sesiBatas });
            assert.equal(hasil.rejected, 1);
            assert.equal(a.fakturDikirim.length, 1);
            assert.equal(a.simpanPelanggan.length, 0);
            assert.ok(!a.kirim.mock.calls.some((c) => /\/customer\/(list|detail)/.test(String(c.arguments[0]))));
            assert.match(hasil.results[0].catatan ?? "", /sesi Accurate sistem untuk membuka batas tidak bisa dipakai/);
        });
    }
});

test("kirim: pesanan terbuka melewati limit / jumlah halaman tak terbaca / sisa faktur tak terbaca -> ditolak, pelanggan tidak disentuh", async (t) => {
    for (const [nama, opsi, pola] of [
        ["pesanan terbuka", { pesanan: [9_800_000] }, /pesanan terbuka/],
        ["tanpa jumlah halaman", { tanpaHalaman: true }, /tanpa jumlah halaman/],
        ["sisa tak terbaca", { sisaRusak: true }, /sisa faktur INV\/B1 tidak terbaca/],
    ] as const) {
        await t.test(nama, async (st) => {
            const a = antrean(st, [{ items: [BUKAN] }], [TOLAK_DUA], opsi);
            const hasil = await kirimSemua();
            assert.equal(a.fakturDikirim.length, 1);
            assert.equal(a.simpanPelanggan.length, 0);
            assert.equal(hasil.rejected, 1);
            assert.match(hasil.results[0].catatan ?? "", pola);
        });
    }
});

test("kirim: penolakan bukan batas piutang, atau pelanggan bukan outlet hit list -> perilaku lama, Accurate pelanggan tidak dibaca", async (t) => {
    for (const [nama, isi, tolak] of [
        ["pesan lain", { items: [HL] }, { s: false, d: [UMUR, "Gudang tidak cukup"] }],
        ["bukan outlet", { customerNo: "C-TIDAKADA-KN", items: [HL] }, TOLAK_UMUR],
    ] as const) {
        await t.test(nama, async (st) => {
            const a = antrean(st, [isi], [tolak]);
            const hasil = await kirimSemua();
            assert.equal(a.fakturDikirim.length, 1);
            assert.ok(!a.kirim.mock.calls.some((c) => /\/customer\/|\/sales-invoice\/list/.test(String(c.arguments[0]))));
            assert.equal(hasil.rejected, 1);
            assert.equal(hasil.results[0].catatan, undefined);
        });
    }
});

test("kirim: kirim ulang tanpa jawaban -> tidak pasti, batch berhenti, batas TETAP dipulihkan", async (t) => {
    const a = antrean(t, [{ items: [BUKAN] }, { items: [BUKAN] }], [TOLAK_DUA, new TypeError("fetch failed")]);
    const hasil = await kirimSemua();
    assert.deepEqual(a.fakturDikirim, ["KINO-NON-FOOD:1671-SOP-1", "KINO-NON-FOOD:1671-SOP-1"]);
    assert.equal(hasil.unknown, 1);
    assert.equal(hasil.results.length, 1);
    assert.deepEqual(a.batas(), BATAS_ASAL);
});

test("kirim: pemulihan gagal -> kiriman BERHENTI (nota berikutnya tidak lewat), ok:false di cron", async (t) => {
    const a = antrean(t, [{ items: [HL] }, { items: [BUKAN] }], [TOLAK_DUA, TERIMA, TERIMA], { pulihDitolak: true });
    const hasil = await kirimSemua();
    assert.deepEqual(a.fakturDikirim, ["KINO-NON-FOOD:1671-SOP-1", "KINO-NON-FOOD:1671-SOP-1"], "nota ke-2 tidak boleh terkirim");
    assert.equal(hasil.results.length, 1);
    assert.equal(hasil.gagalPulih, 1);
    assert.match(hasil.results[0].catatan ?? "", /BATAS GAGAL DIPULIHKAN/);
    assert.equal(jawabanCron(hasil).body.ok, false);
});

test("kirim berikutnya: pelanggan yang batasnya gagal dipulihkan -> faktur apa pun DILEWATI selama Accurate belum tercentang", async (t) => {
    for (const [nama, batasAwal, terkirim] of [["masih lepas", false, 0], ["sudah dicentang ulang", true, 1]] as const) {
        await t.test(nama, async (st) => {
            const a = antrean(st, [{ items: [BUKAN] }], [TERIMA], { belumPulih: ["C-FIT025-KN"], batasAwal });
            const hasil = await kirimSemua();
            assert.equal(a.fakturDikirim.length, terkirim);
            assert.equal(hasil.results[0].state, terkirim ? "posted" : "dilewati");
            if (!terkirim) assert.match(hasil.results[0].error ?? "", /Centang ulang di Accurate/);
        });
    }
});

test(`kirim: paling banyak ${MAKS_PERIKSA_PER_KIRIM} pemeriksaan per kiriman; sisanya tetap ditolak dengan catatan`, async (t) => {
    const jumlah = MAKS_PERIKSA_PER_KIRIM + 1;
    antrean(t, Array.from({ length: jumlah }, () => ({ items: [HL] })), [TOLAK_UMUR]);
    let dipanggil = 0;
    const hasil = await kirimSemua({ refresh: async () => undefined, sesiBatas: async () => SESI_SISTEM,
        lolos: async () => { dipanggil++; return { dicoba: false, alasan: "uji" }; } });
    assert.equal(dipanggil, MAKS_PERIKSA_PER_KIRIM);
    assert.equal(hasil.rejected, jumlah);
    assert.match(hasil.results[jumlah - 1].catatan ?? "", /batas pemeriksaan kiriman ini tercapai/);
});

test("kirim: saklar GT_HITLIST_LOLOS=mati -> perilaku lama", async (t) => {
    process.env.GT_HITLIST_LOLOS = "mati";
    t.after(() => { delete process.env.GT_HITLIST_LOLOS; });
    const a = antrean(t, [{ items: [HL] }], [TOLAK_UMUR]);
    const hasil = await kirimSemua();
    assert.equal(a.fakturDikirim.length, 1);
    assert.equal(a.simpanPelanggan.length, 0);
    assert.equal(hasil.rejected, 1);
});
