/* Owner 17 Nov 2026: pelanggan bercatatan "Hendra" — sistem tidak boleh mengubah apa pun; yang boleh dikembalikan hanya Limit Piutang
 * dan Limit Hari yang diubah IMPOR MASSAL (edit satuan dibiarkan). Uji murni lib/pelanggan-hendra (tanpa jaringan/DB). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AMBANG_MASSAL, TUNGGU_MS, amatiSimpanan, identitasTulis, isCatatanHendra, payloadPulih, periksaTulisPelangganHendra, pulihkanLimitHendra,
    type DepsPulih, type DetailLimit, type Limit, type PelangganAccurate, type Peristiwa, type SimpananLama,
} from "./pelanggan-hendra.ts";
import { parseAccurateDateTime } from "./accurate-invoice.ts";
import { GET as cronPulih } from "../app/api/cron/pulih-limit-hendra/route.ts";

const t = (s: string) => parseAccurateDateTime(s)!;
const L = (aktif: boolean, nilai: number, hariAktif: boolean, hari: number): Limit => ({ aktif, nilai, hariAktif, hari });

test("catatan Hendra: semua variasi yang dipakai tim; catatan lain tidak", () => {
    for (const n of ["Hendra", "hendra", "Hendra via Wa", "Hendra (Acc Pak Fahdar)", "Hold OD60 dibuka permanen ... Hendra", "LIMIT TURUN - PAK ADNANhendra"]) {
        assert.equal(isCatatanHendra(n), true, n);
    }
    for (const n of ["", null, undefined, "Toko Cash", "Acc Pak Haji"]) assert.equal(isCatatanHendra(n), false, String(n));
});

// ---------------- (1) penjaga tulis ----------------

test("identitasTulis: id/customerNo/no/number di atas dan data[n], semua bentuk; kontak bersarang bukan pelanggan", () => {
    assert.deepEqual(identitasTulis({ id: 7, name: "x" }), { ids: ["7"], kode: [], rusak: false });
    assert.deepEqual(identitasTulis({ ID: 7, id: 8 }).ids.sort(), ["7", "8"]);
    assert.deepEqual(identitasTulis({ id: [7, 8] }).ids, ["7", "8"]);
    assert.deepEqual(identitasTulis({ "data[0]": { id: 9 } }).ids, ["9"]);
    assert.deepEqual(identitasTulis({ "data[0][id]": 9 }).ids, ["9"]);
    assert.deepEqual(identitasTulis({ data: { id: 22001 } }).ids, ["22001"], "data sebagai objek (review 2 #7)");
    assert.deepEqual(identitasTulis({ number: "c-pel017-fr", customerNo: "X-1", no: "Y-2" }).kode.sort(), ["C-PEL017-FR", "X-1", "Y-2"]);
    assert.deepEqual(identitasTulis([{ id: 1 }, { number: "C-2", detailContact: [{ id: 99, name: "kontak" }] }]), { ids: ["1"], kode: ["C-2"], rusak: false });
    assert.deepEqual(identitasTulis({ data: [{ id: 3, detailShipAddress: [{ id: 98 }] }] }).ids, ["3"]);
    assert.equal(identitasTulis('{"id":1}').rusak, true, "payload teks = tak terbaca");
    assert.equal(identitasTulis(null).rusak, false);
});

const DATA: Record<string, PelangganAccurate> = {
    "22001": { customerNo: "C-PEL017-FR", notes: "Hendra" },
    "102": { customerNo: "C-ANE050-FR", notes: "" },
};
const NO: Record<string, PelangganAccurate> = { "C-ISR001-AB": { customerNo: "C-ISR001-AB", notes: "hendra" }, "C-PEL017-FR": DATA["22001"] };
const cariId = async (id: string) => DATA[id] ?? null;
const cariNo = async (no: string) => NO[no] ?? null;

test("penjaga: tulis APA PUN ke pelanggan Hendra ditolak — lewat id, kode, number, bulk, data[n], kode di samping id lain", async () => {
    for (const payload of [
        { id: 22001, name: "PELITA LISTRIK" },
        { id: "22001", customerLimitAmountValue: 445000 },
        { number: "C-PEL017-FR", notes: "", customerLimitAmountValue: 1 },
        { data: [{ number: "C-PEL017-FR", notes: "" }] },
        { customerNo: "c-isr001-ab", billStreet: "JL. X" },
        [{ id: 102, name: "A" }, { id: 22001, notes: "Hendra" }],
        { "data[0].id": 22001, "data[0].name": "X" },
        { id: 102, number: "C-PEL017-FR" },
        { id: [102, 22001] },
    ]) {
        const r = await periksaTulisPelangganHendra(payload, cariId, cariNo);
        assert.equal(r.kode.length, 1, JSON.stringify(payload));
        assert.deepEqual(r.takTerbaca, [], JSON.stringify(payload));
    }
});

test("penjaga: pelanggan biasa & pelanggan baru lolos; id fiktif, gagal baca, payload teks = takTerbaca", async () => {
    assert.deepEqual(await periksaTulisPelangganHendra([{ id: 102, name: "A" }, { customerNo: "C-BARU-01" }], cariId, cariNo), { kode: [], takTerbaca: [] });
    assert.deepEqual(await periksaTulisPelangganHendra({ id: 999 }, cariId, cariNo), { kode: [], takTerbaca: ["id 999"] });
    const gagal = await periksaTulisPelangganHendra({ customerNo: "C-X" }, cariId, async () => { throw new Error("Accurate HTTP 429"); });
    assert.deepEqual(gagal.takTerbaca, ["C-X"]);
    assert.deepEqual((await periksaTulisPelangganHendra('{"id":22001}', cariId, cariNo)).takTerbaca, ["payload bukan objek/array"]);
});

// ---------------- (2) pengamat simpanan ----------------

const baris = (id: number, lastUpdate: string, l: Limit, notes = "Hendra", customerNo = `C-${id}`) => ({
    id, customerNo, notes, lastUpdate, customerLimitAmount: l.aktif, customerLimitAmountValue: l.nilai, customerLimitAge: l.hariAktif, customerLimitAgeValue: l.hari,
});

test("pengamat: simpanan baru dihitung per menit; jawaban ulang tidak; peristiwa hanya untuk limit pelanggan Hendra yang berubah", () => {
    const lama = new Map<number, SimpananLama>([
        [1, { lastUpdate: "10/11/2026 09:00:00", limit: L(true, 445000, true, 28) }],
        [2, { lastUpdate: "10/11/2026 09:00:00", limit: L(true, 1000, false, 28) }],
        [3, { lastUpdate: "10/11/2026 09:00:00", limit: L(true, 5000, false, 28) }],
        [4, { lastUpdate: "13/11/2026 10:22:40", limit: L(true, 200000, true, 28) }],
    ]);
    const { menit, ubah } = amatiSimpanan([
        baris(1, "13/11/2026 10:22:36", L(true, 200000, true, 28)),             // Hendra, limit turun -> peristiwa
        baris(2, "13/11/2026 10:22:50", L(true, 200000, false, 28), ""),        // bukan Hendra -> dihitung saja
        baris(3, "13/11/2026 10:23:01", L(true, 5000, false, 28)),              // Hendra, ganti alamat (limit sama) -> dihitung saja
        baris(4, "13/11/2026 10:22:40", L(true, 200000, true, 28)),             // jawaban ulang -> tidak dihitung
        baris(5, "13/11/2026 10:22:59", L(false, 0, false, 0)),                 // pelanggan baru -> dihitung
        baris(6, "2026-11-13T03:22:00.000Z", L(true, 1, true, 1)),              // lastUpdate ISO (cadangan sync) -> dilewati
    ], lama, new Map());
    assert.deepEqual([...menit], [["13/11/2026 10:22", 3], ["13/11/2026 10:23", 1]]);
    assert.deepEqual(ubah, [{ customerId: 1, customerNo: "C-1", lastUpdate: "13/11/2026 10:22:36", lama: L(true, 445000, true, 28), baru: L(true, 200000, true, 28), status: "baru" }]);
});

test("pengamat: simpanan toko terlindungi (alat luar + pelepas AccAPI, 19 Nov) tidak dihitung ke menit ramai", () => {
    const rows = Array.from({ length: 24 }, (_, i) => baris(100 + i, "19/11/2026 09:18:" + String(10 + i), L(true, 1000, true, 28), "", i < 12 ? `C-IN0087-D${i}` : `C-IN0087-E${i}`));
    const { menit } = amatiSimpanan([...rows, baris(1, "19/11/2026 09:18:40", L(true, 5000, true, 28), "", "C-BIASA-KN")], new Map(), new Map());
    assert.equal(menit.get("19/11/2026 09:18"), 1);
});

test("pengamat: simpanan pemulih sendiri (berbalik persis dari pemulihan MANA PUN) = `sistem`, tidak dihitung ke menit ramai", () => {
    const lama = new Map<number, SimpananLama>([[1, { lastUpdate: "13/11/2026 10:22:36", limit: L(true, 200000, true, 28) }]]);
    const pulih = new Map([[1, [
        { baru: L(true, 300000, true, 28), ke: L(true, 100000, true, 28) },   // pemulihan lama, bukan yang ini
        { baru: L(true, 200000, true, 28), ke: L(true, 445000, true, 28) },
    ]]]);
    const { menit, ubah } = amatiSimpanan([baris(1, "17/11/2026 13:13:07", L(true, 445000, true, 28))], lama, pulih);
    assert.equal(menit.size, 0);
    assert.equal(ubah[0].status, "sistem");
    // Nilai lain (bukan balikan persis) = perubahan biasa.
    const lain = amatiSimpanan([baris(1, "17/11/2026 13:13:07", L(true, 500000, true, 28))], lama, pulih);
    assert.equal(lain.ubah[0].status, "baru");
    assert.equal(lain.menit.get("17/11/2026 13:13"), 1);
});

test("SQL: setiap ANY(...) memakai satu parameter array (sql.param), bukan array mentah yang dirender drizzle sebagai ($1, $2)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./pelanggan-hendra.ts", import.meta.url), "utf8");
    const any = [...src.matchAll(/ANY\(\$\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(any.length >= 3, "ada kueri ANY");
    for (const isi of any) assert.match(isi, /^sql\.param\(/, `ANY(\${${isi}}) harus sql.param(...)`);
});

// ---------------- (3) pemulih ----------------

const SEKARANG = t("17/11/2026 13:00:00");
const LAMA_TERAMATI = t("13/11/2026 12:00:00");
/** Masih < 2 hari sesudah impor: tulis gagal diulang (sesudahnya berhenti, review 5). */
const MASIH_DIULANG = t("14/11/2026 09:00:00");
const P = (id: number, lastUpdate: string, lama: Limit, baru: Limit, customerId = 22001, customerNo = "C-PEL017-FR", dicatatPada = LAMA_TERAMATI): Peristiwa =>
    ({ id, customerId, customerNo, lastUpdate, lama, baru, dicatatPada });
const IMPOR = P(1, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28));
const DET = (l: Limit, notes = "Hendra"): DetailLimit => ({ customerNo: "C-PEL017-FR", notes, lastUpdate: "13/11/2026 10:22:36", ...l });

type Detail = DetailLimit | null | ((ke: number) => DetailLimit | null);
function palsu(o: { daftar: Peristiwa[]; menit?: Record<string, number>; detail?: Detail; klaim?: boolean; tulisGagal?: boolean }) {
    const jejak: string[] = [];
    let baca = 0;
    const deps: DepsPulih = {
        daftar: async () => o.daftar,
        hitungMenit: async (m) => new Map(m.map((x) => [x, o.menit?.[x] ?? 0])),
        klaim: async (_c, ids) => { jejak.push(`klaim ${ids.join(",")}`); return o.klaim ?? true; },
        tandaiTarget: async (id, ke) => { jejak.push(`tandai ${id} ${ke.nilai}/${ke.hari}`); },
        selesai: async (id, status) => { jejak.push(`selesai ${id} ${status}`); },
        bacaDetail: async () => {
            baca++;
            if (o.detail === undefined) return DET(L(true, 200000, true, 28));
            return typeof o.detail === "function" ? o.detail(baca) : o.detail;
        },
        tulisLimit: async (id, l) => { if (o.tulisGagal) throw new Error("save.do HTTP 504"); jejak.push(`tulis ${id} ${l.nilai}/${l.hari}`); },
    };
    return { deps, jejak };
}

test("pemulih: C-PEL017-FR diturunkan impor 13 Nov (339 simpanan/menit) -> dikembalikan ke 445.000; target dicatat SEBELUM ditulis", async () => {
    const { deps, jejak } = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 } });
    const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.deepEqual(h.dipulihkan, ["C-PEL017-FR (13/11/2026 10:22:36)"]);
    assert.deepEqual(jejak, ["klaim 1", "tandai 1 445000/28", "tulis 22001 445000/28", "selesai 1 dipulihkan"]);
});

test("pemulih: menit sebelah ramai (juga lewat pergantian jam) = impor; menit sepi -> dibiarkan tanpa tulis", async () => {
    for (const [menit, harap] of [
        [{ "13/11/2026 10:21": AMBANG_MASSAL }, "dipulihkan"],
        [{ "13/11/2026 10:23": 58 }, "dipulihkan"],
        [{ "13/11/2026 10:24": 300 }, "dibiarkan"],
        [{ "13/11/2026 10:22": AMBANG_MASSAL - 1 }, "dibiarkan"],
    ] as const) {
        const { deps, jejak } = palsu({ daftar: [IMPOR], menit });
        await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
        assert.ok(jejak.includes(`selesai 1 ${harap}`), JSON.stringify(menit));
        assert.equal(jejak.some((j) => j.startsWith("tulis")), harap === "dipulihkan");
    }
    const jam = palsu({ daftar: [P(2, "13/11/2026 10:59:30", L(true, 1, true, 1), L(true, 2, true, 1))], menit: { "13/11/2026 11:00": 40 },
        detail: DET(L(true, 2, true, 1)) });
    await pulihkanLimitHendra(jam.deps, { sekarang: SEKARANG });
    assert.ok(jam.jejak.includes("selesai 2 dipulihkan"), "10:59 bersebelahan dengan 11:00");
});

test("pemulih: dua impor beruntun (A->B, B->C) diklaim & diputuskan BERSAMA -> kembali ke A; edit satuan memutus rantai", async () => {
    const e1 = P(1, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28));
    const e2 = P(2, "13/11/2026 11:05:10", L(true, 200000, true, 28), L(true, 300000, true, 28));
    const { deps, jejak } = palsu({ daftar: [e1, e2], menit: { "13/11/2026 10:22": 339, "13/11/2026 11:05": 120 }, detail: DET(L(true, 300000, true, 28)) });
    await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.deepEqual(jejak, ["klaim 1,2", "tandai 2 445000/28", "tulis 22001 445000/28", "selesai 1 dilewati", "selesai 2 dipulihkan"]);
    // Tulis rantai gagal (Accurate masih C): SELURUH kelompok kembali `baru` — peristiwa pertama tidak difinalkan sendirian,
    // jadi jalan berikutnya membangun rantai utuh lagi dan tetap menulis A (review 4 F1).
    const gagal = palsu({ daftar: [e1, e2], menit: { "13/11/2026 10:22": 339, "13/11/2026 11:05": 120 }, detail: DET(L(true, 300000, true, 28)), tulisGagal: true });
    await pulihkanLimitHendra(gagal.deps, { sekarang: MASIH_DIULANG });
    assert.deepEqual(gagal.jejak, ["klaim 1,2", "tandai 2 445000/28", "selesai 1 baru", "selesai 2 baru"]);
    const edit = P(2, "13/11/2026 11:00:10", L(true, 200000, true, 28), L(true, 600000, true, 28));
    const e3 = P(3, "13/11/2026 11:05:10", L(true, 600000, true, 28), L(true, 300000, true, 28));
    const b = palsu({ daftar: [e1, edit, e3], menit: { "13/11/2026 10:22": 339, "13/11/2026 11:05": 120 }, detail: DET(L(true, 300000, true, 28)) });
    await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG });
    assert.ok(b.jejak.includes("tulis 22001 600000/28"));
});

test("pemulih: satu peristiwa pelanggan belum matang (simpan < 15 menit ATAU baru teramati) -> SEMUA peristiwa pelanggan itu ditunda", async () => {
    const segar = P(2, "17/11/2026 12:50:00", L(true, 200000, true, 28), L(true, 300000, true, 28));
    assert.ok(t(segar.lastUpdate).getTime() > SEKARANG.getTime() - TUNGGU_MS);
    const a = palsu({ daftar: [IMPOR, segar], menit: { "13/11/2026 10:22": 339, "17/11/2026 12:50": 400 } });
    assert.equal((await pulihkanLimitHendra(a.deps, { sekarang: SEKARANG })).ditunda, 2);
    assert.deepEqual(a.jejak, [], "peristiwa lama tidak difinalkan sendirian (rantai antar-jalan, review 3 A)");
    // Impor lama yang baru teramati sync: lastUpdate sudah lewat 15 menit, tapi pengamatannya baru -> hitungan mungkin belum lengkap.
    const baruTeramati = P(1, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28), 22001, "C-PEL017-FR", t("17/11/2026 12:55:00"));
    const b = palsu({ daftar: [baruTeramati], menit: { "13/11/2026 10:22": 3 } });
    assert.equal((await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG })).ditunda, 1);
    assert.deepEqual(b.jejak, [], "tidak menyimpulkan 'edit satuan' dari hitungan yang belum lengkap (review 3 B)");
});

test("pemulih: catatan dihapus -> dilewati; sudah bernilai sebelum impor -> dipulihkan TANPA tulis; tanpa tulis apa pun", async () => {
    for (const [detail, harap] of [
        [DET(L(true, 200000, true, 28), ""), "selesai 1 dilewati"],
        [DET(L(true, 445000, true, 28)), "selesai 1 dipulihkan"],
    ] as const) {
        const { deps, jejak } = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, detail });
        await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
        assert.deepEqual(jejak, ["klaim 1", harap], JSON.stringify(detail));
    }
});

test("pemulih: impor kedua mengembalikan nilai (A->B, B->A) -> sudah sesuai, TANPA save.do; tulis ditolak terus > 2 hari -> berhenti", async () => {
    const e1 = P(1, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28));
    const balik = P(2, "13/11/2026 11:05:10", L(true, 200000, true, 28), L(true, 445000, true, 28));
    const a = palsu({ daftar: [e1, balik], menit: { "13/11/2026 10:22": 339, "13/11/2026 11:05": 120 }, detail: DET(L(true, 445000, true, 28)) });
    await pulihkanLimitHendra(a.deps, { sekarang: SEKARANG });
    assert.deepEqual(a.jejak, ["klaim 1,2", "selesai 1 dilewati", "selesai 2 dipulihkan"]);
    const ditolak = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, tulisGagal: true });
    await pulihkanLimitHendra(ditolak.deps, { sekarang: SEKARANG }); // SEKARANG = 4 hari sesudah impor
    assert.deepEqual(ditolak.jejak, ["klaim 1", "tandai 1 445000/28", "selesai 1 dilewati"]);
});

test("pemulih: tak terbaca / berubah lagi tanpa peristiwa teramati -> diulang utuh (`baru`) selama < 2 hari, sesudahnya dilewati", async () => {
    const SEGAR = t("13/11/2026 12:00:00");
    const impor = P(1, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28), 22001, "C-PEL017-FR", t("13/11/2026 10:30:00"));
    for (const [detail, sekarang, harap] of [
        [null, SEGAR, "selesai 1 baru"],
        [DET(L(true, 900000, true, 28)), SEGAR, "selesai 1 baru"],
        [null, SEKARANG, "selesai 1 dilewati"],
        [DET(L(true, 900000, true, 28)), SEKARANG, "selesai 1 dilewati"],
    ] as const) {
        const { deps, jejak } = palsu({ daftar: [impor], menit: { "13/11/2026 10:22": 339 }, detail });
        await pulihkanLimitHendra(deps, { sekarang });
        assert.deepEqual(jejak, ["klaim 1", harap], `${JSON.stringify(detail)} ${sekarang.toISOString()}`);
    }
});

test("pemulih: impor lalu edit tangan pada pelanggan sama -> impor dilewati, edit dibiarkan (keputusan terakhir menang)", async () => {
    const edit = P(2, "15/11/2026 08:00:10", L(true, 200000, true, 28), L(true, 900000, true, 28));
    const { deps, jejak } = palsu({ daftar: [IMPOR, edit], menit: { "13/11/2026 10:22": 339, "15/11/2026 08:00": 1 }, detail: DET(L(true, 900000, true, 28)) });
    await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.deepEqual(jejak, ["klaim 1,2", "selesai 1 dilewati", "selesai 2 dibiarkan"]);
});

test("pemulih: klaim pelanggan direbut jalan lain = dilompati; tulis tak pasti dicek ke Accurate", async () => {
    const b = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, klaim: false });
    await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG });
    assert.deepEqual(b.jejak, ["klaim 1"]);
    const masuk = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, tulisGagal: true, detail: (n) => DET(L(true, n === 1 ? 200000 : 445000, true, 28)) });
    const h1 = await pulihkanLimitHendra(masuk.deps, { sekarang: SEKARANG });
    assert.deepEqual([h1.dipulihkan.length, h1.gagal.length], [1, 0]);
    assert.deepEqual(masuk.jejak, ["klaim 1", "tandai 1 445000/28", "selesai 1 dipulihkan"]);
    const belum = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, tulisGagal: true });
    assert.equal((await pulihkanLimitHendra(belum.deps, { sekarang: MASIH_DIULANG })).gagal.length, 1);
    assert.deepEqual(belum.jejak, ["klaim 1", "tandai 1 445000/28", "selesai 1 baru"]);
    const gelap = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 }, tulisGagal: true, detail: (n) => (n === 1 ? DET(L(true, 200000, true, 28)) : null) });
    await pulihkanLimitHendra(gelap.deps, { sekarang: SEKARANG });
    assert.deepEqual(gelap.jejak, ["klaim 1", "tandai 1 445000/28"], "tetap diproses, diklaim ulang setelah basi");
});

test("pemulih: coba=1 tidak mengklaim/menandai/menulis; batas maks per jalan menunda pelanggan berikutnya utuh", async () => {
    const a = palsu({ daftar: [IMPOR], menit: { "13/11/2026 10:22": 339 } });
    const h = await pulihkanLimitHendra(a.deps, { sekarang: SEKARANG, coba: true });
    assert.deepEqual([h.coba, h.dipulihkan.length], [true, 1]);
    assert.deepEqual(a.jejak, []);
    const tiga = [1, 2, 3].map((i) => P(i, "13/11/2026 10:22:36", L(true, 445000, true, 28), L(true, 200000, true, 28), 100 + i, `C-${i}`));
    const b = palsu({ daftar: tiga, menit: { "13/11/2026 10:22": 339 } });
    const hb = await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG, maks: 2 });
    assert.deepEqual([hb.dipulihkan.length, hb.ditunda], [2, 1]);
    assert.equal(b.jejak.some((j) => j.endsWith(" 3")), false, "pelanggan ke-3 tidak diklaim");
});

test("pemulih: 8 toko NKA/DC (aturan 13 Nov) tidak pernah diberi batas kembali, walau bercatatan Hendra dan diubah impor", async () => {
    const dc = P(9, "13/11/2026 10:22:36", L(true, 737575000, false, 28), L(false, 737575000, false, 28), 34996, "C-AL0063-KN");
    const { deps, jejak } = palsu({ daftar: [dc], menit: { "13/11/2026 10:22": 339 } });
    const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.equal(h.dilewati.length, 1);
    assert.deepEqual(jejak, ["klaim 9", "selesai 9 dilewati"]);
    // Mematikan batas (lama = mati) tetap boleh dipulihkan untuk toko itu.
    const mati = P(10, "13/11/2026 10:22:36", L(false, 1, false, 28), L(true, 200000, true, 28), 34996, "C-AL0063-KN");
    const b = palsu({ daftar: [mati], menit: { "13/11/2026 10:22": 339 }, detail: { ...DET(L(true, 200000, true, 28)), customerNo: "C-AL0063-KN" } });
    await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG });
    assert.ok(b.jejak.includes("tulis 34996 1/28"));
});

test("payloadPulih: id + 4 kolom limit, tidak ada kolom lain", () => {
    assert.deepEqual(payloadPulih(22001, L(true, 445000, true, 28)),
        { id: 22001, customerLimitAmount: true, customerLimitAmountValue: 445000, customerLimitAge: true, customerLimitAgeValue: 28 });
});

test("cron pulih-limit-hendra: tanpa / salah Bearer CRON_SECRET -> 401 (tidak menyentuh Accurate)", async () => {
    const lama = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "rahasia-uji";
    try {
        for (const auth of [undefined, "Bearer salah", "rahasia-uji"]) {
            const res = await cronPulih(new Request("http://app.test/api/cron/pulih-limit-hendra?coba=1", { headers: auth ? { authorization: auth } : {} }));
            assert.equal(res.status, 401, String(auth));
        }
    } finally {
        if (lama === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = lama;
    }
});
