/* Owner 17 Nov 2026: pelanggan bercatatan "Hendra" — sistem tidak boleh mengubah apa pun; pemulih hanya mengembalikan Limit Piutang
 * dan Limit Hari yang diubah impor massal (edit satuan = acuan baru). Uji murni lib/pelanggan-hendra (tanpa jaringan/DB). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AMBANG_MASSAL, TUNGGU_MS, isCatatanHendra, payloadPulih, periksaTulisPelangganHendra, pulihkanLimitHendra, putuskanLimit,
    type DepsPulih, type DetailLimit, type Kandidat, type Limit, type PelangganAccurate,
} from "./pelanggan-hendra.ts";
import { parseAccurateDateTime } from "./accurate-invoice.ts";
import { GET as cronPulih } from "../app/api/cron/pulih-limit-hendra/route.ts";

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

const t = (s: string) => parseAccurateDateTime(s)!;
const menit = (s: string) => Math.floor(t(s).getTime() / 60_000);

test("catatan Hendra: semua variasi yang dipakai tim; catatan lain tidak", () => {
    for (const n of ["Hendra", "hendra", "Hendra via Wa", "Hendra (Acc Pak Fahdar)", "Hold OD60 dibuka permanen ... Hendra", "LIMIT TURUN - PAK ADNANhendra"]) {
        assert.equal(isCatatanHendra(n), true, n);
    }
    for (const n of ["", null, undefined, "Toko Cash", "Acc Pak Haji"]) assert.equal(isCatatanHendra(n), false, String(n));
});

// ---------------- penjaga tulis ----------------

const DATA: Record<string, PelangganAccurate> = {
    "101": { customerNo: "C-PEL017-FR", notes: "Hendra" },
    "102": { customerNo: "C-ANE050-FR", notes: "" },
    "103": { customerNo: "C-HEN016-M2", notes: "LIMIT TURUN" }, // nama mengandung HENDRA di toko lain, catatan bukan
};
const NO: Record<string, PelangganAccurate> = { "C-ISR001-AB": { customerNo: "C-ISR001-AB", notes: "hendra" }, "C-BIASA-AB": { customerNo: "C-BIASA-AB", notes: "x" } };
function pencari() {
    const panggil: string[] = [];
    return {
        panggil,
        cariId: async (id: string) => { panggil.push(`id:${id}`); return DATA[id] ?? null; },
        cariNo: async (no: string) => { panggil.push(`no:${no}`); return NO[no] ?? null; },
    };
}

test("penjaga: tulis APA PUN ke pelanggan Hendra ditolak (id, kode, bulk, data[n] datar)", async () => {
    for (const payload of [
        { id: 101, name: "PELITA LISTRIK" },
        { id: "101", customerLimitAmountValue: 445000 },
        { customerNo: "c-isr001-ab", billStreet: "JL. X" },
        [{ id: 102, name: "A" }, { id: 101, notes: "Hendra" }],
        { "data[0].id": 101, "data[0].name": "X" },
        { data: [{ customerNo: "C-ISR001-AB" }] },
    ]) {
        const p = pencari();
        const r = await periksaTulisPelangganHendra(payload, p.cariId, p.cariNo);
        assert.equal(r.kode.length, 1, JSON.stringify(payload));
        assert.deepEqual(r.takTerbaca, []);
    }
});

test("penjaga: pelanggan biasa, pelanggan baru, dan id kontak bersarang lolos; id kontak tidak dicari", async () => {
    const p = pencari();
    const r = await periksaTulisPelangganHendra([
        { id: 102, name: "A", detailContact: [{ id: 101, name: "kontak" }], "detailContact[0].id": 101 },
        { id: 103, customerLimitAmount: true },
        { customerNo: "C-BIASA-AB" },
        { customerNo: "C-BARU-01", name: "Toko baru" },
    ], p.cariId, p.cariNo);
    assert.deepEqual(r, { kode: [], takTerbaca: [] });
    assert.deepEqual(p.panggil.sort(), ["id:102", "id:103", "no:C-BARU-01", "no:C-BIASA-AB"]);
});

test("penjaga: id yang tidak ada / gagal dibaca = takTerbaca (fail-closed)", async () => {
    const p = pencari();
    assert.deepEqual(await periksaTulisPelangganHendra({ id: 999, name: "x" }, p.cariId, p.cariNo), { kode: [], takTerbaca: ["id 999"] });
    const gagal = await periksaTulisPelangganHendra({ customerNo: "C-X" }, p.cariId, async () => { throw new Error("Accurate HTTP 500"); });
    assert.deepEqual(gagal.takTerbaca, ["C-X"]);
});

// ---------------- keputusan pemulih ----------------

const L = (aktif: boolean, nilai: number, hariAktif: boolean, hari: number): Limit => ({ aktif, nilai, hariAktif, hari });
const K = (lastUpdate: string, l: Limit, id = 22001, customerNo = "C-PEL017-FR"): Kandidat => ({ id, customerNo, lastUpdate, ...l });
const SEKARANG = t("17/11/2026 13:00:00");
const SYNC_LAMA = t("13/11/2026 09:00:00");
const SYNC_BARU = t("13/11/2026 18:00:00");
const ramaiDi = (...m: string[]) => (x: Date) => m.map(menit).includes(Math.floor(x.getTime() / 60_000));

test("putuskanLimit: acuan awal, sama, tunggu, pulihkan (impor), acuan baru (edit satuan)", () => {
    const acuan = L(true, 445000, true, 28);
    const impor = K("13/11/2026 10:22:36", L(true, 200000, true, 28));
    assert.equal(putuskanLimit(undefined, impor, ramaiDi(), SEKARANG, SYNC_BARU), "acuan_awal");
    assert.equal(putuskanLimit(acuan, K("13/11/2026 10:22:36", acuan), ramaiDi(), SEKARANG, SYNC_BARU), "sama");
    assert.equal(putuskanLimit(acuan, impor, ramaiDi("13/11/2026 10:22"), SEKARANG, SYNC_BARU), "pulihkan");
    assert.equal(putuskanLimit(acuan, impor, ramaiDi(), SEKARANG, SYNC_BARU), "acuan_baru");
    assert.equal(putuskanLimit(acuan, impor, ramaiDi(), SEKARANG, SYNC_LAMA), "tunggu", "edit satuan baru disimpulkan sesudah sync penuh");
    assert.equal(putuskanLimit(acuan, impor, ramaiDi(), SEKARANG, null), "tunggu");
    const baru = new Date(t("13/11/2026 10:22:36").getTime() + TUNGGU_MS - 1000);
    assert.equal(putuskanLimit(acuan, impor, ramaiDi("13/11/2026 10:22"), baru, SYNC_BARU), "tunggu", "impor mungkin masih berjalan");
    assert.equal(putuskanLimit(acuan, K("2026-11-13T02:22:36.000Z", L(true, 1, true, 28)), ramaiDi(), SEKARANG, SYNC_BARU), "tunggu", "lastUpdate bukan format Accurate");
    assert.equal(putuskanLimit(acuan, K("13/11/2026 10:22:36", L(true, 445000.2, true, 28)), ramaiDi(), SEKARANG, SYNC_BARU), "sama", "selisih pembulatan");
    assert.equal(putuskanLimit(acuan, K("13/11/2026 10:22:36", L(true, 445000, true, 14)), ramaiDi("13/11/2026 10:22"), SEKARANG, SYNC_BARU), "pulihkan", "limit hari ikut");
});

test("payloadPulih: id + 4 kolom limit, tidak ada kolom lain", () => {
    assert.deepEqual(payloadPulih(22001, L(true, 445000, true, 28)),
        { id: 22001, customerLimitAmount: true, customerLimitAmountValue: 445000, customerLimitAge: true, customerLimitAgeValue: 28 });
});

// ---------------- pemulih (jalan penuh, dependensi palsu) ----------------

function palsu(o: { kandidat: Kandidat[]; acuan: [number, Limit][]; detail?: Record<number, DetailLimit | null>; ramai?: string[]; sync?: Date | null; tulisGagal?: number[] }) {
    const catat = { tulis: [] as [number, Limit][], acuan: [] as [string, string][], pulih: [] as number[] };
    const deps: DepsPulih = {
        kandidat: async () => o.kandidat,
        perMenit: async () => new Map((o.ramai ?? []).map((m) => [menit(m), AMBANG_MASSAL + 100])),
        acuan: async () => new Map(o.acuan),
        syncPenuh: async () => (o.sync === undefined ? SYNC_BARU : o.sync),
        simpanAcuan: async (k, sumber) => { catat.acuan.push([k.customerNo, sumber]); },
        catatPulih: async (id) => { catat.pulih.push(id); },
        bacaDetail: async (id) => (o.detail ?? {})[id] ?? null,
        tulisLimit: async (id, l) => { if (o.tulisGagal?.includes(id)) throw new Error("save.do HTTP 500"); catat.tulis.push([id, l]); },
    };
    return { deps, catat };
}

test("pemulih: C-PEL017-FR diturunkan impor 13 Nov -> dikembalikan ke acuan 445.000; hanya limit yang ditulis", async () => {
    const kini = K("13/11/2026 10:22:36", L(true, 200000, true, 28));
    const { deps, catat } = palsu({
        kandidat: [kini], acuan: [[22001, L(true, 445000, true, 28)]], ramai: ["13/11/2026 10:22"],
        detail: { 22001: { customerNo: "C-PEL017-FR", notes: "Hendra", lastUpdate: "13/11/2026 10:22:36", ...L(true, 200000, true, 28) } },
    });
    const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.deepEqual(h.dipulihkan, ["C-PEL017-FR"]);
    assert.deepEqual(catat.tulis, [[22001, L(true, 445000, true, 28)]]);
    assert.deepEqual(catat.pulih, [22001]);
    assert.deepEqual(catat.acuan, [], "acuan tidak diganti nilai impor");
});

test("pemulih: menit sebelah yang ramai (awal/ekor impor) = impor; menit sepi jauh = bukan impor", async () => {
    const det = { customerNo: "C-PEL017-FR", notes: "Hendra", lastUpdate: "13/11/2026 10:22:36", ...L(true, 200000, true, 28) };
    for (const [ramai, harap] of [[["13/11/2026 10:21"], 1], [["13/11/2026 10:23"], 1], [["13/11/2026 10:24"], 0]] as const) {
        const { deps, catat } = palsu({ kandidat: [K("13/11/2026 10:22:36", L(true, 200000, true, 28))], acuan: [[22001, L(true, 445000, true, 28)]],
            ramai: [...ramai], detail: { 22001: det }, sync: SYNC_LAMA });
        await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
        assert.equal(catat.tulis.length, harap, ramai.join());
    }
});

test("pemulih: coba=1 hanya melaporkan; tidak menulis Accurate maupun acuan", async () => {
    const { deps, catat } = palsu({
        kandidat: [K("13/11/2026 10:22:36", L(true, 200000, true, 28)), K("16/11/2026 09:00:00", L(false, 0, false, 0), 5, "C-BARU-HZ")],
        acuan: [[22001, L(true, 445000, true, 28)]], ramai: ["13/11/2026 10:22"],
        detail: { 22001: { customerNo: "C-PEL017-FR", notes: "Hendra", lastUpdate: "13/11/2026 10:22:36", ...L(true, 200000, true, 28) } },
    });
    const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG, coba: true });
    assert.deepEqual([h.coba, h.dipulihkan, h.acuanAwal], [true, ["C-PEL017-FR"], 1]);
    assert.deepEqual([catat.tulis, catat.acuan, catat.pulih], [[], [], []]);
});

test("pemulih: edit satuan -> acuan baru; pelanggan baru Hendra -> acuan awal; tanpa tulis Accurate", async () => {
    const { deps, catat } = palsu({
        kandidat: [K("15/11/2026 08:00:10", L(true, 900000, true, 28)), K("16/11/2026 09:00:00", L(false, 0, false, 0), 5, "C-BARU-HZ")],
        acuan: [[22001, L(true, 445000, true, 28)]], ramai: ["13/11/2026 10:22"], sync: t("16/11/2026 18:00:00"),
    });
    const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
    assert.deepEqual(h.acuanBaru, ["C-PEL017-FR"]);
    assert.equal(h.acuanAwal, 1);
    assert.deepEqual(catat.acuan, [["C-PEL017-FR", "edit_manual"], ["C-BARU-HZ", "awal"]]);
    assert.deepEqual(catat.tulis, []);
});

test("pemulih: Accurate sudah berubah lagi / catatan dihapus / sudah sama -> tidak menulis", async () => {
    const kini = K("13/11/2026 10:22:36", L(true, 200000, true, 28));
    const acuan: [number, Limit][] = [[22001, L(true, 445000, true, 28)]];
    for (const [det, harap] of [
        [{ customerNo: "C-PEL017-FR", notes: "Hendra", lastUpdate: "17/11/2026 12:00:00", ...L(true, 300000, true, 28) }, "ditunda"],
        [{ customerNo: "C-PEL017-FR", notes: "", lastUpdate: "13/11/2026 10:22:36", ...L(true, 200000, true, 28) }, "dilewati"],
        [null, "dilewati"],
        [{ customerNo: "C-PEL017-FR", notes: "Hendra", lastUpdate: "13/11/2026 10:22:36", ...L(true, 445000, true, 28) }, "sama"],
    ] as const) {
        const { deps, catat } = palsu({ kandidat: [kini], acuan, ramai: ["13/11/2026 10:22"], detail: { 22001: det as DetailLimit | null } });
        const h = await pulihkanLimitHendra(deps, { sekarang: SEKARANG });
        assert.deepEqual(catat.tulis, [], harap);
        if (harap === "ditunda") assert.equal(h.ditunda, 1);
        if (harap === "dilewati") assert.equal(h.dilewati.length, 1);
        if (harap === "sama") assert.deepEqual([h.dipulihkan, h.ditunda, h.dilewati], [[], 0, []]);
    }
});

test("pemulih: satu gagal tulis tidak menghentikan yang lain; batas maks per jalan", async () => {
    const kandidat = [1, 2, 3].map((i) => K("13/11/2026 10:22:36", L(true, 200000, false, 28), i, `C-${i}`));
    const acuan: [number, Limit][] = [1, 2, 3].map((i) => [i, L(true, 900000, false, 28)]);
    const detail = Object.fromEntries([1, 2, 3].map((i) => [i, { customerNo: `C-${i}`, notes: "hendra", lastUpdate: "13/11/2026 10:22:36", ...L(true, 200000, false, 28) }]));
    const a = palsu({ kandidat, acuan, detail, ramai: ["13/11/2026 10:22"], tulisGagal: [2] });
    const h = await pulihkanLimitHendra(a.deps, { sekarang: SEKARANG });
    assert.deepEqual([h.dipulihkan, h.gagal.length], [["C-1", "C-3"], 1]);
    const b = palsu({ kandidat, acuan, detail, ramai: ["13/11/2026 10:22"] });
    const hb = await pulihkanLimitHendra(b.deps, { sekarang: SEKARANG, maks: 2 });
    assert.deepEqual([hb.dipulihkan.length, hb.dilewati.length], [2, 1]);
});
