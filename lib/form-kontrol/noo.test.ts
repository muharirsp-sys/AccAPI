/* NOO (toko baru dari kunjungan salesman, owner 13 Okt 2026) TANPA DB: aturan isian (NIK 16 angka, HP seluler Indonesia kanonik, GPS wajib),
 * NIK tersamar, kode NOO, matriks hak (owner P2: SPV tim + grup Admin lihat KTP & setujui; SM menyetujui tanpa KTP; Admin Sales tanpa KTP),
 * dan pengolah foto (PNG beralfa → latar putih). Perilaku route ASLI pada Postgres = lib/form-kontrol/noo-pg.test.ts. Data contoh generik. */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { isKodeNoo, normalHp, periksaIsianNoo, periksaNik, samarkanNik } from "./noo-aturan.ts";
import { buatKodeNoo, hakNoo, type AksesNoo } from "./noo.ts";
import { olahFoto } from "./uploads.ts";

test("normalHp: seluler Indonesia → 08… kanonik; telepon rumah/pendek/panjang/08-0 ditolak", () => {
    assert.equal(normalHp("0812-3456-7890"), "081234567890");
    assert.equal(normalHp("+62 812 3456 789"), "08123456789");
    assert.equal(normalHp("62812345678"), "0812345678");
    assert.equal(normalHp("(0857) 1234.5678"), "085712345678");
    for (const salah of ["0212345678", "08123", "0801234567", "08123456789012", "8123456789", "", null, "0812abc4567"]) {
        assert.equal(normalHp(salah), null, String(salah));
    }
});

test("periksaNik: tepat 16 angka (spasi antarkelompok dibuang); samarkanNik 4 + 8 titik + 4", () => {
    assert.equal(periksaNik("7371 0101 0101 0012"), "7371010101010012");
    for (const salah of ["737101010101001", "73710101010100123", "7371O10101010012", "", undefined]) assert.equal(periksaNik(salah), null, String(salah));
    assert.equal(samarkanNik("7371010101010012"), "7371••••••••0012");
    assert.equal(samarkanNik("123"), "—");
    assert.equal(samarkanNik(null), "—");
});

const ISIAN: Record<string, string> = { namaToko: " TOKO  BARU A ", namaPemilik: "PEMILIK A", alamat: "JL. CONTOH 1", noHp: "+6281234567890",
    nik: "7371010101010012", namaKtp: "PEMILIK A", lat: "-5.1477", lng: "119.4327", akurasi: "12" };
const periksa = (lain: Record<string, string> = {}) => periksaIsianNoo((k) => ({ ...ISIAN, ...lain })[k]);

test("periksaIsianNoo: bersih + kanonik; galat berkode TANPA nilai NIK/HP yang diketik; GPS wajib", () => {
    const ok = periksa();
    assert.ok("isian" in ok);
    assert.deepEqual(ok.isian, { namaToko: "TOKO BARU A", namaPemilik: "PEMILIK A", alamat: "JL. CONTOH 1", namaKtp: "PEMILIK A",
        noHp: "081234567890", nik: "7371010101010012", lat: -5.1477, lng: 119.4327, akurasi: 12 });
    const kode = (lain: Record<string, string>) => { const r = periksa(lain); return "galat" in r ? r.galat.kode : "ok"; };
    assert.equal(kode({ namaToko: "  " }), "ISIAN_WAJIB");
    assert.equal(kode({ alamat: "x".repeat(301) }), "ISIAN_TERLALU_PANJANG");
    assert.equal(kode({ noHp: "0211234567" }), "HP_TIDAK_SAH");
    assert.equal(kode({ nik: "123456789012345" }), "NIK_TIDAK_SAH");
    assert.equal(kode({ lat: "" }), "GPS_WAJIB");
    assert.equal(kode({ akurasi: "abc" }), "GPS_WAJIB");
    assert.equal(kode({ lat: "91" }), "GPS_TIDAK_SAH");
    assert.equal(kode({ akurasi: "-1" }), "GPS_TIDAK_SAH");
    for (const lain of [{ nik: "73710101010100" }, { noHp: "0219876543" }]) {
        const r = periksa(lain);
        assert.ok("galat" in r);
        assert.ok(!r.galat.error.includes(Object.values(lain)[0]), "nilai pribadi tidak masuk pesan galat");
    }
});

test("kode NOO: format NOO-XXXXXXXX (Crockford), acak; isKodeNoo hanya bentuk persis", () => {
    const kode = new Set(Array.from({ length: 2000 }, buatKodeNoo));
    assert.equal(kode.size, 2000);
    for (const k of kode) assert.ok(isKodeNoo(k) && !/[ILOU]/.test(k.slice(4)), k);
    for (const salah of ["noo-ABCDEFGH", "NOO-ABCDEFG", "NOO-ABCDEFGHI", "C-100001-CBA", "NOO-ABCD-FGH", 42, null]) assert.equal(isKodeNoo(salah), false, String(salah));
});

// ---------------------------------------------------------------- matriks hak (owner 13 Okt, P2)

const akses = (role: string, kunci: string[], o: { allowed?: string[] | null; salesCode?: string; userId?: string } = {}): AksesNoo => ({
    scope: { role, salesCode: o.salesCode, allowedSalesCodes: o.allowed === undefined ? null : o.allowed },
    perms: new Set(kunci.map((k) => `form_kontrol.${k}`)), userId: o.userId ?? `u-${role}`,
});
const SALES = akses("salesman", ["view", "submit"], { allowed: ["S-01"], salesCode: "S-01", userId: "u-s01" });
const SPV_TIM = akses("spv", ["view", "submit", "noo_setujui"], { allowed: ["S-01", "S-02"] });
const SPV_LAIN = akses("spv", ["view", "submit", "noo_setujui"], { allowed: ["S-09"] });
const SM = akses("sm", ["view", "submit", "noo_setujui"], { allowed: ["S-01", "S-02", "S-03"] });
const ADMIN = akses("admin", ["view", "submit", "manage", "noo_setujui", "noo_ktp"]);
const ADMIN_SALES = akses("admin_sales", ["view", "submit", "manage"]);
const MANAGER_LIHAT = akses("manager", ["view"]);
const noo = (status: string, dibuatOleh = "u-s01") => ({ salesCode: "S-01", dibuatOleh, status });

test("hakNoo: baca/putuskan/ktp/tautkan/kunjungi per peran (SPV tim + Admin lihat KTP & setujui; SM setujui tanpa KTP; Admin Sales tanpa KTP)", () => {
    const h = (a: AksesNoo, status = "menunggu_spv", oleh?: string) => hakNoo(a, noo(status, oleh));
    assert.deepEqual(h(SALES), { baca: true, putuskan: false, ktp: true, tautkan: false, kunjungi: true }, "pengaju selama menunggu: KTP sendiri");
    assert.deepEqual(h(SALES, "disetujui"), { baca: true, putuskan: false, ktp: false, tautkan: false, kunjungi: true }, "sesudah disetujui: KTP tertutup");
    assert.deepEqual(h(SALES, "terdaftar"), { baca: true, putuskan: false, ktp: false, tautkan: false, kunjungi: false });
    assert.deepEqual(h(SPV_TIM), { baca: true, putuskan: true, ktp: true, tautkan: false, kunjungi: false });
    assert.deepEqual(h(SPV_TIM, "disetujui"), { baca: true, putuskan: false, ktp: true, tautkan: false, kunjungi: false });
    assert.deepEqual(h(SPV_LAIN), { baca: false, putuskan: false, ktp: false, tautkan: false, kunjungi: false }, "SPV tim lain: tidak terlihat");
    assert.deepEqual(h(SM), { baca: true, putuskan: true, ktp: false, tautkan: false, kunjungi: false }, "SM pengganti: setujui tanpa KTP");
    assert.deepEqual(h(ADMIN), { baca: true, putuskan: true, ktp: true, tautkan: false, kunjungi: false });
    assert.deepEqual(h(ADMIN, "disetujui"), { baca: true, putuskan: false, ktp: true, tautkan: true, kunjungi: false });
    assert.deepEqual(h(ADMIN_SALES, "disetujui"), { baca: true, putuskan: false, ktp: false, tautkan: true, kunjungi: false }, "Admin Sales: tanpa KTP");
    assert.deepEqual(h(MANAGER_LIHAT), { baca: false, putuskan: false, ktp: false, tautkan: false, kunjungi: false }, "form_kontrol.view saja tidak membuka NOO");
    assert.equal(h(akses("spv", ["view", "noo_setujui"], { allowed: ["S-01"], userId: "u-s01" })).putuskan, false, "pengaju tidak memutuskan sendiri");
    assert.equal(h(akses("salesman", ["view", "noo_setujui"], { allowed: ["S-01"], salesCode: "S-01", userId: "u-x" })).putuskan, false,
        "akun salesman tidak memutuskan walau salah diberi kunci");
});

test("olahFoto: PNG beralfa → JPEG berlatar PUTIH (bukan hitam), ≤ 1600 px, cap opsional", async () => {
    const bening = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await olahFoto(bening);
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 1600, 800]);
    const { data } = await sharp(out).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, `piksel transparan harus putih, dapat ${[...data]}`);
    const dicap = await olahFoto(bening, ["BARIS 1", "BARIS 2"]);
    const { data: bawah } = await sharp(dicap).extract({ left: 800, top: 795, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.ok(bawah[0] < 200, "pita cap gelap di kiri-bawah");
    await assert.rejects(olahFoto(Buffer.from("bukan gambar")));
});
