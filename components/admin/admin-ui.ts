/*
 * Tujuan: Logika murni layar User & Akses Group (Fiori S7a): kalimat galat dari `code` kontrak S7-1 (+ jawaban tidak pasti),
 *   selisih izin, perkiraan role identitas (cermin roleTurunan/roleSisa server), pemeriksa sandi bertopeng, status akun, riwayat.
 * Caller: components/admin/Bersama.tsx, app/(dashboard)/admin/users/Pengguna.tsx, app/(dashboard)/admin/groups/AksesGrup.tsx.
 * Dependensi: lib/rbac (label satu sumber: auditActionLabels, permissionKeyLabel), lib/tampil (KOSONG, sebabHttp), components/fiori/core
 *   (tipe Tone).
 * Main Functions: pesanGalat, selisihIzin, utamaEfektif, perkiraanRole, roleDariGrup, labelRole, alasanSandi, statusAkun, ringkasRiwayat,
 *   waktuWita.
 * Side Effects: Tidak ada. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md.
 */
import { auditActionLabels, permissionKeyLabel } from "@/lib/rbac";
import { KOSONG, sebabHttp } from "@/lib/tampil";
import type { Tone } from "@/components/fiori/core";

export const BELUM_PASTI = "Hasilnya belum pasti: server tidak memberi jawaban yang jelas, jadi perubahan mungkin sudah tersimpan. Data dimuat ulang. Periksa hasilnya sebelum mengulang.";

export type Galat = { pesan: string; muatUlang: boolean; belumPasti: boolean; code?: string };
type Jawaban = Record<string, unknown> | null;

const namaUser = (body: Jawaban) => {
    const users = Array.isArray(body?.users) ? (body.users as Array<{ name?: string }>).map((u) => u.name).filter(Boolean) : [];
    return users.length ? users.join(", ") : "user ini";
};

/** Kalimat per `code` (kontrak §2 + catatan perubahan) + apakah data penentu harus dimuat ulang. */
const KODE: Record<string, (body: Jawaban, k: { aktivasi?: boolean }) => [string, boolean]> = {
    ADMIN_TERAKHIR: () => ["Minimal satu admin aktif harus tersisa. Beri izin Kelola user (users.manage) ke user aktif lain dulu, lalu ulangi.", false],
    AKSES_SENDIRI: () => ["Ditolak: aksi ini mencabut akses Kelola user dari akun Anda sendiri. Minta admin lain yang melakukannya.", false],
    IZIN_BERUBAH: () => ["Izin Anda berubah sejak halaman dimuat (dicabut admin lain). Tidak ada yang berubah; halaman dimuat ulang.", true],
    GRUP_TERAKHIR: (b, k) => [k.aktivasi
        ? `Tambahkan ${namaUser(b)} ke grup dulu, lalu aktifkan. User aktif tanpa grup jatuh ke akses role lama.`
        : `Ditolak: ${namaUser(b)} hanya punya grup ini, dan user tidak boleh tanpa grup. Tambahkan ke grup lain dulu, atau Nonaktifkan untuk mencabut akses.`, false],
    PRESET_NAMA_TERKUNCI: () => ["Nama grup preset tidak bisa diubah; deskripsi dan izinnya boleh.", false],
    ADMIN_PRESET_TERKUNCI: () => ["Kunci Kelola user (users.manage) pada grup preset Admin tidak bisa dicabut.", false],
    PRESET_TIDAK_BISA_DIHAPUS: () => ["Grup preset tidak bisa dihapus.", false],
    BINTANG_BENTROK: () => ["Grup utama sedang diubah admin lain bersamaan. Data dimuat ulang; ulangi bila masih perlu.", true],
    EMAIL_TERPAKAI: () => ["Email sudah terdaftar. Pakai email lain, atau cari user itu di daftar.", false],
    NAMA_GRUP_TERPAKAI: () => ["Nama grup sudah dipakai. Pilih nama lain.", false],
    SANDI_TERLALU_PENDEK: () => ["Sandi terlalu pendek: minimal 6 karakter.", false],
    SANDI_TERLALU_PANJANG: () => ["Sandi terlalu panjang: maksimal 128 karakter.", false],
    EMAIL_TIDAK_VALID: () => ["Format email tidak valid.", false],
    // Kunci tak dikenal tetap disebut: layar ini khusus Admin dan kuncinya yang perlu dicari (admin-ui.test.ts menguncinya).
    KUNCI_TIDAK_VALID: (b) => [`Server menolak simpan: kunci izin tidak dikenal (${Array.isArray(b?.invalid) ? (b.invalid as string[]).join(", ") : "?"}). Tidak ada yang berubah; muat ulang halaman, karena daftar izin mungkin berubah sesudah pembaruan aplikasi.`, false],
    USER_TIDAK_ADA: () => ["User tidak ditemukan. Mungkin sudah dihapus. Data dimuat ulang.", true],
    GRUP_TIDAK_ADA: () => ["Grup tidak ditemukan. Mungkin sudah dihapus. Data dimuat ulang.", true],
    BUKAN_ANGGOTA: () => ["User sudah bukan anggota grup itu. Data dimuat ulang.", true],
    USER_SETENGAH_JADI: (b) => [`User terbuat sebagian dan dibiarkan NONAKTIF ("sedang disiapkan", tidak bisa masuk). Minta IT Support menghapusnya${typeof b?.userId === "string" ? ` (id ${b.userId})` : ""}, lalu ulangi.`, true],
    GAGAL_SIMPAN: () => ["Gagal menyimpan; tidak ada yang berubah. Coba lagi.", false],
    // O2 (kontrak O1 tautan salesman): PUT/DELETE /api/admin/users/[id]/salesman.
    KARYAWAN_TIDAK_ADA: () => ["Karyawan itu tidak ada di master pegawai hasil sinkron Accurate. Daftar dimuat ulang; sinkronkan master pegawai bila karyawannya baru ditambahkan.", true],
    KARYAWAN_GANDA: () => ["Ada lebih dari satu karyawan Accurate dengan nomor itu. Betulkan nomornya di Accurate, sinkronkan master pegawai, lalu ulangi.", false],
    KARYAWAN_BUKAN_SALESMAN_AKTIF: () => ["Karyawan itu bukan salesman aktif di Accurate (nonaktif, atau tidak bertanda salesman). Pilih karyawan lain; daftar dimuat ulang.", true],
    KARYAWAN_TANPA_CABANG: () => ["Karyawan itu belum punya cabang di Accurate, padahal cabang salesman diambil dari sana. Isi cabangnya di Accurate, sinkronkan master pegawai, lalu ulangi.", false],
    KARYAWAN_SUDAH_TERHUBUNG: (b) => {
        const k = (b?.terhubungKe ?? {}) as { name?: unknown };
        return [`Karyawan itu sudah ditautkan ke akun ${typeof k.name === "string" && k.name ? k.name : "lain"}. Lepas dulu dari akun itu, atau pilih karyawan lain. Daftar dimuat ulang.`, true];
    },
    KODE_DIPAKAI_PROFIL_LAIN: () => ["Kode karyawan itu masih dipegang profil Form Kontrol akun lain yang tautannya sudah dilepas (kode tidak boleh ganda). Pilih karyawan lain, atau minta Admin membereskan profil lama itu lebih dulu.", false],
    PROFIL_TUJUAN_ADA: () => ["Akun ini sudah punya profil sales sendiri, jadi profil akun lain tidak bisa dipindahkan ke sini. Rapikan profil akun ini dulu (lepas/hapus lewat IT Support), atau pilih karyawan lain.", false],
    KODE_DIPAKAI_FORM_KONTROL: (b) => {
        const l = (b?.laporan ?? {}) as { total?: unknown };
        return [`Akun ini punya ${typeof l.total === "number" ? `${l.total} ` : ""}laporan Form Kontrol berkode salesman lama. Mengganti kode butuh konfirmasi.`, false];
    },
    PROFIL_GANDA: () => ["Akun ini punya lebih dari satu profil sales, jadi tautannya tidak bisa diganti begitu saja. Lepas dulu tautannya, lalu tautkan ulang.", true],
};

/**
 * Jawaban server -> kalimat. Tidak pasti (putus = status 0, >= 502, atau bukan JSON) = "belum pasti" + muat ulang.
 * 401/403 tanpa `code` = gerbang `requirePermission` (sesi/izin berubah) -> muat ulang.
 */
export function pesanGalat(status: number, body: Jawaban, konteks: { aktivasi?: boolean } = {}): Galat {
    if (status === 0 || status >= 502 || body === null) return { pesan: BELUM_PASTI, muatUlang: true, belumPasti: true };
    const code = typeof body.code === "string" ? body.code : undefined;
    if (code && KODE[code]) {
        const [pesan, muatUlang] = KODE[code](body, konteks);
        return { pesan, muatUlang, belumPasti: false, code };
    }
    if (status === 401) return { pesan: "Sesi Anda berakhir. Masuk lagi, lalu ulangi.", muatUlang: false, belumPasti: false };
    if (status === 403) return { pesan: "Akun Anda tidak berizin untuk aksi ini (butuh Kelola user, users.manage). Izin dimuat ulang; minta admin bila perlu.", muatUlang: true, belumPasti: false, code: "forbidden" };
    const teks = typeof body.error === "string" && body.error ? body.error : `Gagal. ${sebabHttp(status)}`;
    return { pesan: teks, muatUlang: false, belumPasti: false, code };
}

export function selisihIzin(sebelum: Iterable<string>, sesudah: Iterable<string>): { ditambah: string[]; dicabut: string[] } {
    const a = new Set(sebelum), b = new Set(sesudah);
    return { ditambah: [...b].filter((k) => !a.has(k)).sort(), dicabut: [...a].filter((k) => !b.has(k)).sort() };
}

/** Cermin GROUP_NAME_TO_ROLE (lib/rbac/otorisasi.ts — modul server ber-DB, tidak bisa dibundel klien). admin-ui.test.ts menjaga sama persis. */
export const ROLE_PRESET: Readonly<Record<string, string>> = {
    Admin: "admin", Manager: "manager", Finance: "finance", Staff: "staff", Viewer: "viewer",
    SPV: "spv", SM: "sm", Claim: "claim", OM: "om", Salesman: "salesman", "Admin Sales": "admin_sales",
};
const ROLE_BAWAAN = "viewer";

export type GrupU = { id: string; name: string; isPreset: boolean; isPrimary: boolean };
export type Perubahan = { tambah: GrupU } | { keluar: string } | { bintang: string | null };

export const roleDariGrup = (g: Pick<GrupU, "name" | "isPreset"> | null) => (g?.isPreset ? ROLE_PRESET[g.name] ?? null : null);
/** Role identitas untuk tampilan: nama grup presetnya ("admin_sales" → "Admin Sales"), bukan nilai enum mentah (audit No 30). */
const NAMA_ROLE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(ROLE_PRESET).map(([nama, role]) => [role, nama]));
export const labelRole = (role: string | null | undefined) => (role ? NAMA_ROLE[role] ?? role : KOSONG);
/** Grup utama efektif (kontrak §4): berbintang; tanpa bintang & tepat 1 grup -> grup itu; selain itu null. */
export const utamaEfektif = <T extends { isPrimary: boolean }>(gs: readonly T[]): T | null => gs.find((g) => g.isPrimary) ?? (gs.length === 1 ? gs[0] : null);
const normal = (gs: GrupU[]) => (gs.length === 1 && !gs[0].isPrimary ? [{ ...gs[0], isPrimary: true }] : gs);

/**
 * Perkiraan hasil server untuk dialog (peringatan role WAJIB kontrak §4). Murni cermin selesaiUtama: normalisasi 1 grup,
 * roleTurunan (utama berubah) ?? roleSisa (role dari preset yang ditinggalkan). Jawaban server tetap yang ditampilkan sesudahnya.
 */
export function perkiraanRole(grup: readonly GrupU[], role: string | null, ubah: Perubahan): { utama: GrupU | null; role: string | null; berubah: boolean } {
    const lamaG = normal([...grup]);
    let baruG: GrupU[];
    if ("tambah" in ubah) baruG = lamaG.some((g) => g.id === ubah.tambah.id) ? lamaG : [...lamaG, { ...ubah.tambah, isPrimary: false }];
    else if ("keluar" in ubah) baruG = lamaG.filter((g) => g.id !== ubah.keluar);
    else baruG = lamaG.map((g) => ({ ...g, isPrimary: g.id === ubah.bintang }));
    baruG = normal(baruG);
    const lama = utamaEfektif(lamaG), baru = utamaEfektif(baruG);
    let r: string | null = null;
    if ((lama?.id ?? null) !== (baru?.id ?? null)) {
        const rb = roleDariGrup(baru);
        const rl = roleDariGrup(lama);
        if (rb) r = rb === role ? null : rb;
        else if (rl && rl === role && role !== ROLE_BAWAAN) r = ROLE_BAWAAN;
    }
    if (r === null && role && role !== ROLE_BAWAAN) {
        const punya = (gs: GrupU[]) => gs.some((g) => roleDariGrup(g) === role);
        if (punya(lamaG) && !punya(baruG)) r = ROLE_BAWAAN;
    }
    return { utama: baru, role: r ?? role, berubah: r !== null };
}

/** Pemeriksa dua kolom sandi bertopeng (panjang saja; nilainya tidak pernah masuk state React). Batas = server Better Auth. */
export function alasanSandi(panjang: number, panjangUlang: number, sama: boolean, min = 6, max = 128): string | undefined {
    if (panjang === 0) return "Isi sandi sementara";
    if (panjang < min) return `Sandi minimal ${min} karakter`;
    if (panjang > max) return `Sandi maksimal ${max} karakter`;
    if (panjangUlang === 0) return "Ketik ulang sandi";
    if (!sama) return "Ketik ulang belum sama dengan sandi";
    return undefined;
}

/** Penanda buat user S7-1 (`app/api/admin/users/route.ts` DISIAPKAN): user setengah jadi, banned, tidak bisa masuk. */
const DISIAPKAN = "sedang disiapkan";

export function statusAkun(u: { banned?: boolean | null; banReason?: string | null }): { aktif: boolean; label: string; tone: Tone; setengah: boolean } {
    if (!u.banned) return { aktif: true, label: "Aktif", tone: "pos", setengah: false };
    if (u.banReason?.startsWith(DISIAPKAN)) return { aktif: false, label: "Sedang disiapkan", tone: "warn", setengah: true };
    return { aktif: false, label: "Nonaktif", tone: "neu", setengah: false };
}

export type ItemRiwayat = {
    id?: string; action: string; actorName?: string | null; targetUserName?: string | null; targetGroupName?: string | null;
    detail?: Record<string, unknown> | null; createdAt?: string;
};

const teks = (v: unknown) => (typeof v === "string" && v ? v : null);
const daftarKunci = (v: unknown) => (Array.isArray(v) ? (v as string[]).map(permissionKeyLabel).join(", ") : "");

/** Satu baris riwayat: label aksi (auditActionLabels) + rincian manusiawi. Sudut "user" menyebut grup; sudut "grup" menyebut user. */
export function ringkasRiwayat(item: ItemRiwayat, sudut: "user" | "grup"): { apa: string; rinci: string } {
    const d = item.detail ?? {};
    const bagian: string[] = [];
    const grup = teks(item.targetGroupName) ?? teks(d.groupName) ?? (item.action.startsWith("group") ? teks(d.name) : null);
    const user = teks(item.targetUserName) ?? teks(d.userName);
    if (sudut === "user" && grup && !item.action.startsWith("user.")) bagian.push(grup);
    if (sudut === "grup" && user) bagian.push(user);
    if (item.action === "group_permission.sync") {
        if (daftarKunci(d.added)) bagian.push(`+ ${daftarKunci(d.added)}`);
        if (daftarKunci(d.removed)) bagian.push(`− ${daftarKunci(d.removed)}`);
        if (!daftarKunci(d.added) && !daftarKunci(d.removed)) bagian.push("tanpa perubahan kunci");
    }
    if (item.action === "salesman.link") {
        const nama = (o: Record<string, unknown> | null) => (o && teks(o.salesName) ? `${o.salesName}${teks(o.salesCode) ? ` (${o.salesCode})` : ""}` : null);
        const sesudah = (d.sesudah ?? null) as Record<string, unknown> | null;
        const sebelum = (d.sebelum ?? null) as Record<string, unknown> | null;
        const dari = (d.dipindahDari ?? null) as Record<string, unknown> | null;
        bagian.push(`${sebelum ? `${nama(sebelum) ?? KOSONG} → ` : ""}${nama(sesudah) ?? KOSONG}${sesudah && teks(sesudah.branchName) ? ` · cabang ${sesudah.branchName}` : ""}`);
        if (dari) bagian.push(`profil dipindah dari akun ${teks(dari.name) ?? teks(dari.userId) ?? "lain"}${teks(dari.salesCode) ? ` (kode ${dari.salesCode} tetap)` : ""}`);
    }
    // Kunci mengikuti yang ditulis server (`salesman/route.ts`: detail.dilepas = profil yang tautannya dimatikan).
    if (item.action === "salesman.unlink" && Array.isArray(d.dilepas)) {
        bagian.push(`dilepas: ${(d.dilepas as Array<Record<string, unknown>>).map((x) => `${teks(x.salesName) ?? KOSONG} (${teks(x.salesCode) ?? KOSONG})`).join(", ")}`);
    }
    if (item.action === "user.create" && Array.isArray(d.groupNames)) bagian.push(`grup ${(d.groupNames as string[]).filter(Boolean).join(", ")}`);
    if (item.action === "group.update" && teks(d.name)) bagian.push(`nama ${d.name}${teks(d.description) ? ` · ${d.description}` : ""}`);
    if (item.action === "group.delete" && typeof d.memberCount === "number") bagian.push(`${d.memberCount} anggota`);
    if (item.action === "user.deactivate" && teks(d.reason)) bagian.push(`alasan: ${d.reason}`);
    if (typeof d.sessionsRevoked === "number" && d.sessionsRevoked > 0) bagian.push(`${d.sessionsRevoked} sesi diakhiri`);
    if (d.via === "group.delete") bagian.push("karena grup dihapus");
    if (teks(d.roleAfter) || teks(d.roleBefore)) bagian.push(`role identitas ${labelRole(teks(d.roleBefore))} → ${labelRole(teks(d.roleAfter))}`);

    return { apa: auditActionLabels[item.action] ?? item.action, rinci: bagian.join(" · ") };
}

/** "11 Okt 2026 09.40" WITA. */
export function waktuWita(iso: string | undefined): string {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    const tgl = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Makassar" }).format(d);
    const jam = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(d);
    return `${tgl} ${jam}`;
}
