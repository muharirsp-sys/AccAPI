/* S7a: uji logika murni layar User & Akses Group — kalimat galat dari `code` kontrak S7-1, jawaban tidak pasti, selisih izin,
 * perkiraan role identitas (HARUS sama dengan roleTurunan/roleSisa server; peta preset dicek sama persis), pemeriksa sandi, riwayat. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUP_NAME_TO_ROLE, pilihUtama, roleSisa, roleTurunan, type GrupUser } from "../../lib/rbac/otorisasi.ts";
import { alasanSandi, perkiraanRole, pesanGalat, ringkasRiwayat, ROLE_PRESET, selisihIzin, statusAkun, type GrupU, type Perubahan } from "./admin-ui.ts";

test("jawaban tidak pasti (putus, >= 502, bukan JSON) = belum pasti + muat ulang; 500 berkode = pasti", () => {
    for (const [status, body] of [[0, null], [502, { ok: false }], [504, null], [200, null], [409, null]] as const) {
        const g = pesanGalat(status, body);
        assert.equal(g.belumPasti, true, `status ${status}`);
        assert.equal(g.muatUlang, true);
        assert.match(g.pesan, /belum pasti/);
    }
    const gagal = pesanGalat(500, { ok: false, code: "GAGAL_SIMPAN", error: "x" });
    assert.equal(gagal.belumPasti, false);
    assert.match(gagal.pesan, /tidak ada yang berubah/);
});

test("kode 409/403 dipetakan ke kalimat jelas + tindakan berikut (bukan teks server mentah)", () => {
    const teks = (code: string, extra: Record<string, unknown> = {}, status = 409) => pesanGalat(status, { ok: false, code, error: "TEKS SERVER", ...extra }).pesan;
    assert.match(teks("ADMIN_TERAKHIR"), /^Minimal satu admin aktif harus tersisa/);
    assert.match(teks("AKSES_SENDIRI"), /akun Anda sendiri/);
    assert.match(teks("GRUP_TERAKHIR", { users: [{ id: "u1", name: "USER A" }] }), /USER A.*Nonaktifkan/);
    assert.match(pesanGalat(409, { ok: false, code: "GRUP_TERAKHIR", users: [{ id: "u1", name: "USER A" }] }, { aktivasi: true }).pesan, /Tambahkan USER A ke grup dulu/);
    assert.match(teks("PRESET_NAMA_TERKUNCI"), /preset/);
    assert.match(teks("ADMIN_PRESET_TERKUNCI"), /Admin/);
    assert.match(teks("EMAIL_TERPAKAI"), /Email sudah terdaftar/);
    assert.match(teks("SANDI_TERLALU_PENDEK", {}, 400), /minimal 6/);
    assert.match(teks("KUNCI_TIDAK_VALID", { invalid: ["finance.reopen"] }, 400), /finance\.reopen/);
    for (const code of ["IZIN_BERUBAH", "BINTANG_BENTROK", "USER_TIDAK_ADA", "GRUP_TIDAK_ADA", "BUKAN_ANGGOTA", "USER_SETENGAH_JADI"]) {
        assert.equal(pesanGalat(409, { ok: false, code }).muatUlang, true, code);
    }
    assert.equal(pesanGalat(409, { ok: false, code: "ADMIN_TERAKHIR" }).muatUlang, false);
    assert.match(pesanGalat(403, { error: "Forbidden" }).pesan, /tidak berizin/);
    assert.equal(pesanGalat(403, { error: "Forbidden" }).muatUlang, true);
    assert.match(pesanGalat(401, { error: "Unauthorized" }).pesan, /Sesi/);
    assert.doesNotMatch(teks("ADMIN_TERAKHIR"), /TEKS SERVER/);
    assert.match(pesanGalat(400, { ok: false, code: "KODE_BARU", error: "Teks server" }).pesan, /Teks server/);
});

test("selisih izin: ditambah dan dicabut terurut", () => {
    assert.deepEqual(selisihIzin(["a.view", "b.edit", "c.view"], ["c.view", "a.view", "d.export", "a.create"]), { ditambah: ["a.create", "d.export"], dicabut: ["b.edit"] });
    assert.deepEqual(selisihIzin(["a.view"], new Set(["a.view"])), { ditambah: [], dicabut: [] });
});

test("peta role preset UI sama persis dengan server (GROUP_NAME_TO_ROLE)", () => {
    assert.deepEqual(ROLE_PRESET, GROUP_NAME_TO_ROLE);
});

/** Server: mulaiUtama/selesaiUtama (normalisasi 1 grup -> berbintang) + roleTurunan ?? roleSisa. */
function server(grup: GrupU[], role: string | null, ubah: Perubahan) {
    const ke = (g: GrupU): GrupUser => ({ groupId: g.id, name: g.name, isPreset: g.isPreset, isPrimary: g.isPrimary });
    const normal = (rows: GrupUser[]) => (rows.length === 1 && !rows[0].isPrimary ? [{ ...rows[0], isPrimary: true }] : rows);
    const lama = normal(grup.map(ke));
    let baru: GrupUser[];
    if ("tambah" in ubah) baru = lama.some((g) => g.groupId === ubah.tambah.id) ? lama : [...lama, { ...ke(ubah.tambah), isPrimary: false }];
    else if ("keluar" in ubah) baru = lama.filter((g) => g.groupId !== ubah.keluar);
    else baru = lama.map((g) => ({ ...g, isPrimary: g.groupId === ubah.bintang }));
    baru = normal(baru);
    const r = roleTurunan(pilihUtama(lama), pilihUtama(baru), role) ?? roleSisa(lama, baru, role);
    return { utama: pilihUtama(baru)?.groupId ?? null, role: r ?? role, berubah: Boolean(r) };
}

test("perkiraan role identitas = hasil server di semua jalur (bintang, lepas, tambah, keluarkan)", () => {
    const admin: GrupU = { id: "g-admin", name: "Admin", isPreset: true, isPrimary: false };
    const fin: GrupU = { id: "g-fin", name: "Finance", isPreset: true, isPrimary: false };
    const custom: GrupU = { id: "g-promo", name: "Promo A", isPreset: false, isPrimary: false };
    const palsuAdmin: GrupU = { id: "g-x", name: "Admin", isPreset: false, isPrimary: false };
    const tanpaPeta: GrupU = { id: "g-kasir", name: "Kasir", isPreset: true, isPrimary: false };
    const semua = [admin, fin, custom, palsuAdmin, tanpaPeta];
    const bintang = (gs: GrupU[], id: string | null) => gs.map((g) => ({ ...g, isPrimary: g.id === id }));
    let n = 0;
    for (const role of ["admin", "finance", "viewer", "manager", null]) {
        for (let mask = 0; mask < 1 << semua.length; mask++) {
            const gs = semua.filter((_, i) => mask & (1 << i));
            for (const star of [null, ...gs.map((g) => g.id)]) {
                const grup = bintang(gs, star);
                const ubahan: Perubahan[] = [
                    { bintang: null }, ...semua.map((g) => ({ bintang: g.id })),
                    ...semua.map((g) => ({ tambah: g })), ...gs.map((g) => ({ keluar: g.id })),
                ];
                for (const ubah of ubahan) {
                    if ("bintang" in ubah && ubah.bintang && !gs.some((g) => g.id === ubah.bintang)) continue; // server: 404 BUKAN_ANGGOTA
                    const ui = perkiraanRole(grup, role, ubah);
                    assert.deepEqual({ utama: ui.utama?.id ?? null, role: ui.role, berubah: ui.berubah }, server(grup, role, ubah), JSON.stringify({ grup, role, ubah }));
                    n++;
                }
            }
        }
    }
    assert.ok(n > 1000);
    // Kasus wajib kontrak §4: lepas bintang Admin pada user 2 grup -> viewer walau masih anggota Admin.
    const r = perkiraanRole(bintang([admin, fin], "g-admin"), "admin", { bintang: null });
    assert.deepEqual([r.role, r.berubah, r.utama], ["viewer", true, null]);
});

test("sandi bertopeng: minimal 6, maksimal 128, ketik ulang wajib sama", () => {
    assert.equal(alasanSandi(0, 0, true), "Isi sandi sementara");
    assert.equal(alasanSandi(5, 5, true), "Sandi minimal 6 karakter");
    assert.equal(alasanSandi(129, 129, true), "Sandi maksimal 128 karakter");
    assert.equal(alasanSandi(6, 0, false), "Ketik ulang sandi");
    assert.equal(alasanSandi(6, 6, false), "Ketik ulang belum sama dengan sandi");
    assert.equal(alasanSandi(6, 6, true), undefined);
});

test("status akun: aktif / nonaktif / sedang disiapkan", () => {
    assert.equal(statusAkun({ banned: false }).label, "Aktif");
    assert.equal(statusAkun({ banned: null }).aktif, true);
    assert.equal(statusAkun({ banned: true, banReason: "Pindah cabang" }).label, "Nonaktif");
    assert.equal(statusAkun({ banned: true, banReason: "sedang disiapkan (S7-1)" }).label, "Sedang disiapkan");
    assert.equal(statusAkun({ banned: true, banReason: "sedang disiapkan (S7-1)" }).setengah, true, "setengah jadi: tidak boleh diaktifkan (IT Support menghapusnya)");
    assert.equal(statusAkun({ banned: true, banReason: "Pindah cabang" }).setengah, false);
    assert.equal(statusAkun({ banned: false }).setengah, false);
});

test("ringkasan riwayat: label aksi satu sumber + rincian tanpa kunci mentah", () => {
    const sync = ringkasRiwayat({ action: "group_permission.sync", detail: { added: ["payments.delete"], removed: ["users.manage"] } }, "grup");
    assert.equal(sync.apa, "Izin grup diubah");
    assert.equal(sync.rinci, "+ Payments · Hapus · − Users & RBAC · Manage");
    const star = ringkasRiwayat({ action: "user_group.unstar", targetGroupName: "Admin", detail: { roleBefore: "admin", roleAfter: "viewer" } }, "user");
    assert.equal(star.rinci, "Admin · role identitas admin → viewer");
    const hapus = ringkasRiwayat({ action: "user_group.remove", targetUserName: null, detail: { userName: "USER A", groupName: "Promo A", via: "group.delete" } }, "grup");
    assert.equal(hapus.rinci, "USER A · karena grup dihapus");
    assert.equal(ringkasRiwayat({ action: "user.password_set", detail: { sessionsRevoked: 2 } }, "user").rinci, "2 sesi diakhiri");
    assert.equal(ringkasRiwayat({ action: "aksi.baru", detail: null }, "user").apa, "aksi.baru");
});
