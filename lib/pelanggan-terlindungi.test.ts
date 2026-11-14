/* Owner 13 Nov 2026: 8 toko NKA/DC tidak boleh dinonaktifkan atau diberi batas piutang / batas umur piutang (semua divisi).
 * Uji murni lib/pelanggan-terlindungi (tanpa jaringan; pencarian id dipalsukan). Rute: lib/proxy-guard-route.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PELANGGAN_TERLINDUNGI, isPelangganTerlindungi, periksaPenutupanPelanggan } from "./pelanggan-terlindungi.ts";
import { isCustomerWrite } from "./accurate-forward.ts";

const kodeId: Record<string, string> = { "101": "C-IND051", "102": "C-ALF052-KN", "200": "C-ANE050", "201": "C-IND0801" };
const cari = async (id: string) => kodeId[id] ?? null;
const cek = (payload: unknown) => periksaPenutupanPelanggan(payload, cari);
const kosong = { kode: [], alasan: [], idTakTerbaca: [] };

test("daftar tepat 8 kode owner; varian divisi ikut, nomor lain tidak", () => {
    assert.deepEqual([...PELANGGAN_TERLINDUNGI].sort(), ["C-AL0063", "C-AL0064", "C-ALF052", "C-IN0050", "C-IN0088", "C-IND051", "C-IND080", "C-IND086"]);
    for (const k of ["C-IND051", " c-ind051 ", "C-IND051-KN", "C-IND051 RB", "C-IND051KN", "C-IN0088_CS"]) assert.equal(isPelangganTerlindungi(k), true, k);
    for (const k of ["C-IND0510", "C-IND0801", "C-IND05", "C-ANE050", "", null, undefined]) assert.equal(isPelangganTerlindungi(k), false, String(k));
});

test("isCustomerWrite: customer & pos/customer save/bulk-save (fail-closed seperti tulis lain); baca/endpoint lain bukan", () => {
    for (const p of ["/api/customer/save.do", "/api/customer/bulk-save.do", "/api/pos/customer/save.do", "/api/customer/save.do;x", "/api/%63ustomer/save.do"]) {
        assert.equal(isCustomerWrite(p), true, p);
    }
    for (const p of ["/api/customer/list.do", "/api/customer/detail.do", "/api/customer-category/save.do", "/api/sales-order/save.do"]) {
        assert.equal(isCustomerWrite(p), false, p);
    }
});

test("nonaktif, batas piutang, batas umur piutang (hari) untuk toko terlindungi: ditolak beserta alasannya", async () => {
    const tolak: Array<[unknown, string[]]> = [
        [{ customerNo: "C-AL0063", suspended: true }, ["dinonaktifkan"]],
        [{ customerNo: "C-AL0063", customerLimitAmount: true, customerLimitAmountValue: 251953000 }, ["batas piutang"]],
        [{ customerNo: "C-AL0063", customerLimitAmountValue: 300000000 }, ["batas piutang"]],
        [{ customerNo: "C-AL0063", customerLimitAmountValue: 0 }, ["batas piutang"]],
        [{ customerNo: "C-AL0063", customerLimitAmount: "on" }, ["batas piutang"]],
        [{ customerNo: "C-IND051", customerLimitAge: true, customerLimitAgeValue: 30 }, ["batas umur piutang (hari)"]],
        [{ customerNo: "C-IND051", CustomerLimitAgeValue: "45" }, ["batas umur piutang (hari)"]],
        [{ customerNo: "C-IND051-KN", customerLimitAge: 1 }, ["batas umur piutang (hari)"]],
        [{ customerNo: "C-IN0050", customerLimitAmount: false, customerLimitAge: true }, ["batas umur piutang (hari)"]],
        [{ customerNo: "C-IN0050", customerLimitAmount: false, CustomerLimitAmount: true }, ["batas piutang"]],
        [{ suspended: false, Suspended: true, customerNo: "C-IND086" }, ["dinonaktifkan"]],
        [{ customerNo: "C-ANE050", no: "C-IND080", customerLimitAmountValue: 1 }, ["batas piutang"]],
        [{ customerNo: "C-IND086", suspended: "ya", customerLimitAmount: true, customerLimitAge: true }, ["dinonaktifkan", "batas piutang", "batas umur piutang (hari)"]],
    ];
    for (const [payload, alasan] of tolak) {
        const r = await cek(payload);
        assert.equal(r.kode.length, 1, JSON.stringify(payload));
        assert.deepEqual(r.alasan, alasan, JSON.stringify(payload));
    }
});

test("kolom aktif kosong/null (sel Excel kosong) + nilai = memasang batas, bukan mematikan", async () => {
    for (const v of [null, "", "  ", undefined]) {
        assert.deepEqual((await cek({ customerNo: "C-AL0063", customerLimitAmount: v, customerLimitAmountValue: 5000 })).kode, ["C-AL0063"], String(v));
        assert.deepEqual((await cek({ customerNo: "C-AL0063", customerLimitAge: v, customerLimitAgeValue: 30 })).kode, ["C-AL0063"], String(v));
    }
});

test("bentuk payload: bulk array, data[n].x datar, {data:[...]}/{data:{...}}, bersarang, teks JSON", async () => {
    for (const payload of [
        [{ customerNo: "C-ANE050", customerLimitAmount: true }, { customerNo: "C-AL0063", customerLimitAmount: true }],
        { "data[0].customerNo": "C-AL0063", "data[0].customerLimitAgeValue": 7 },
        { data: [{ no: "C-AL0063", suspended: true }] },
        { data: { customerNo: "C-AL0063", customerLimitAgeValue: 7 } },
        { customer: { customerNo: "C-AL0063", customerLimitAmount: true } },
        { data: JSON.stringify([{ customerNo: "C-AL0063", suspended: true }]) },
        JSON.stringify({ customerNo: "C-AL0063", customerLimitAmountValue: 1 }),
    ]) {
        assert.deepEqual((await cek(payload)).kode, ["C-AL0063"], JSON.stringify(payload));
    }
});

test("lewat id: kode dicari (juga bila payload membawa kode baru); tak ditemukan/gagal baca = idTakTerbaca", async () => {
    assert.deepEqual((await cek({ id: 101, customerLimitAgeValue: 14 })).kode, ["C-IND051"]);
    assert.deepEqual((await cek({ id: "102", suspended: 1 })).kode, ["C-ALF052-KN"]);
    assert.deepEqual((await cek({ id: 101, customerNo: "X-BARU", customerLimitAmount: true })).kode, ["C-IND051"]);
    assert.deepEqual(await cek({ id: 999, suspended: true }), { kode: [], alasan: [], idTakTerbaca: ["999"] });
    const gagal = await periksaPenutupanPelanggan({ id: 7, customerLimitAmount: true }, async () => { throw new Error("Accurate HTTP 500"); });
    assert.deepEqual(gagal.idTakTerbaca, ["7"]);
});

test("id sama dicari sekali; paling banyak 4 bersamaan", async () => {
    let panggil = 0, jalan = 0, puncak = 0;
    const lambat = async (id: string) => {
        panggil++; jalan++; puncak = Math.max(puncak, jalan);
        await new Promise((ok) => setTimeout(ok, 5));
        jalan--;
        return kodeId[id] ?? `C-LAIN${id}`;
    };
    const baris: unknown[] = Array.from({ length: 30 }, (_, i) => ({ id: 300 + (i % 10), customerLimitAmount: true, customerLimitAmountValue: 1000 }));
    baris.push({ id: 101, customerLimitAmountValue: 1 });
    const r = await periksaPenutupanPelanggan(baris, lambat);
    assert.deepEqual(r.kode, ["C-IND051"]);
    assert.equal(panggil, 11);
    assert.ok(puncak <= 4, `puncak ${puncak}`);
});

test("yang tetap lolos: mematikan batas, edit biasa, toko lain, baris tanpa tanda menutup tidak dicari", async () => {
    let dicari = 0;
    const hitung = async (id: string) => { dicari++; return cari(id); };
    for (const payload of [
        { customerNo: "C-IND051", suspended: false, name: "INDOGROSIR" },
        { id: 101, name: "INDOGROSIR MAKASSAR" },
        { customerNo: "C-AL0063", customerLimitAmount: false },
        { customerNo: "C-AL0063", customerLimitAmount: false, customerLimitAmountValue: 251953000 },
        { customerNo: "C-AL0063", customerLimitAge: "false", customerLimitAgeValue: 30 },
        { customerNo: "C-AL0063", customerLimitAmount: "TIDAK", customerLimitAge: 0, suspended: null },
        { customerNo: "C-AL0063", customerLimitAmountValue: null, customerLimitAgeValue: "" },
        { customerNo: "C-AL0063", name: "ALFAMART", detailContact: [{ id: 5, name: "Budi" }], notes: "{bukan json" },
        { customerNo: "C-ANE050", customerLimitAmount: true, customerLimitAmountValue: 21000000 },
        { id: 200, customerLimitAge: true, customerLimitAgeValue: 30 },
        { id: 201, suspended: true },
        [{ customerNo: "C-ANE050", customerLimitAmountValue: 1 }, { customerNo: "C-IND051", name: "X" }],
    ]) {
        assert.deepEqual(await periksaPenutupanPelanggan(payload, hitung), kosong, JSON.stringify(payload));
    }
    assert.equal(dicari, 2, "hanya baris ber-id yang menutup (id 200, 201) yang dicari");
});
