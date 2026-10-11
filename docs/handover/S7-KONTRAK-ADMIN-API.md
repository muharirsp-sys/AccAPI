# Kontrak API admin user & grup — S7-1 (BL-61, BL-62, BL-63, Riwayat)

Status: **kontrak S7-1** (11 Okt 2026). Zona AGENTS §3 Auth — 2 peninjau. UI = S7a (memakai kontrak ini; tidak memanggil
`/api/auth/admin/*` lagi). Perubahan sesudah commit pertama dicatat di bagian **Catatan perubahan** di akhir.

Dasar: matriks D-01 (DISETUJUI 11 Okt, `scratch/fiori-intake/D01-MATRIKS-DRAF-2026-10-11.md` §E), jawaban owner S7
(`OWNER-ANSWERS-S7-2026-10-10.md`: bintang opsional, 1 grup = otomatis utama, bintang grup preset menurunkan `user.role`, atur sandi
= dialog bertopeng tanpa email), eksplorasi `S7-EKSPLORASI-2026-10-11.md` §4.3 (6 celah BL-61).

## 1. Aturan umum

- Semua route di bawah `/api/admin/**`, JSON, sesi Better Auth (cookie). Tanpa sesi → **401** `{ error: "Unauthorized" }`; tanpa kunci
  → **403** `{ error: "Forbidden" }` (helper bersama `requirePermission`, tanpa `code`).
- **Tulis = `users.manage`** (satu-satunya kunci tulis user & grup, D-01 §E). **Baca daftar/riwayat = `users.manage` ATAU `users.view`**.
  Peran lama `user.role === "admin"` TIDAK lagi menjadi gerbang mana pun di sini.
- Galat berkode: `{ ok: false, code: "<KODE>", error: "<pesan Indonesia>" }` (+ field tambahan bila disebut). Sukses: `{ ok: true, ... }`.
- **Atomik:** setiap tulisan DB app satu transaksi (perubahan + penurunan grup utama/role + `permission_audit_log`). Gagal di mana pun
  → tidak ada perubahan dan tidak ada baris audit. Galat tak terduga → **500** `GAGAL_SIMPAN` (tidak ada yang berubah).
- **Rahasia:** sandi tidak pernah masuk audit, log, atau jawaban (juga tidak hash-nya).
- **Penjaga BL-61** dijalankan pada SEMUA titik tulis user/grup/anggota/izin (bagian 3).

## 2. Kode galat

| HTTP | `code` | Arti |
|---|---|---|
| 400 | `INPUT_TIDAK_VALID` | body tidak lengkap / bentuk salah (`error` menyebut field) |
| 400 | `SANDI_TERLALU_PENDEK` / `SANDI_TERLALU_PANJANG` | sandi < 6 / > 128 karakter (batas Better Auth server) |
| 400 | `EMAIL_TIDAK_VALID` | format email |
| 400 | `KUNCI_TIDAK_VALID` | kunci izin tidak ada di registry (`invalid: string[]`) |
| 404 | `USER_TIDAK_ADA` / `GRUP_TIDAK_ADA` | target tidak ada |
| 404 | `BUKAN_ANGGOTA` | user bukan anggota grup itu |
| 409 | `ADMIN_TERAKHIR` | aksi membuat 0 user aktif ber-`users.manage` efektif |
| 409 | `AKSES_SENDIRI` | aksi membuat AKTOR sendiri kehilangan `users.manage` efektif / nonaktif |
| 409 | `PRESET_NAMA_TERKUNCI` | ganti nama grup preset |
| 409 | `ADMIN_PRESET_TERKUNCI` | mencabut `users.manage` dari grup preset `Admin` |
| 409 | `PRESET_TIDAK_BISA_DIHAPUS` | hapus grup preset |
| 409 | `GRUP_TERAKHIR` | aksi membuat user tanpa grup (lalu jatuh ke akses role lama); `users: {id,name}[]` |
| 409 | `EMAIL_TERPAKAI` / `NAMA_GRUP_TERPAKAI` | unik |
| 409 | `BINTANG_BENTROK` | bentrok bintang bersamaan (indeks unik `uq_user_group_primary`); ulangi |
| 500 | `GAGAL_SIMPAN` | galat tak terduga; tidak ada yang berubah |

## 3. Penjaga BL-61 (`lib/rbac/otorisasi.ts`, satu fungsi bersama)

- **Admin** = user **aktif** (tidak banned, atau ban-nya kedaluwarsa) yang memegang `users.manage` **efektif** (sama dengan
  `getUserPermissions`: punya ≥1 grup → gabungan kunci grup; tanpa grup → preset role lama / `user.permissions`).
- Dihitung **di dalam transaksi** sesudah perubahan diterapkan, di bawah kunci `pg_advisory_xact_lock` bersama (semua tulisan
  otorisasi berurutan) → dua admin yang saling mencabut bersamaan: satu berhasil, satu **409 `ADMIN_TERAKHIR`**.
- Tolak bila sesudah aksi admin = 0 (`ADMIN_TERAKHIR`), atau aktor (yang sebelumnya admin) bukan admin lagi (`AKSES_SENDIRI`):
  keluar dari grup yang memberi `users.manage`, menonaktifkan diri, mencabut `users.manage` dari grupnya, menghapus grup custom
  yang memberinya, masuk ke grup yang membuang fallback role lama.
- Grup preset tidak bisa diganti nama (deskripsi boleh); grup preset `Admin` tidak bisa kehilangan `users.manage`; preset tidak bisa dihapus.
- User tidak boleh dibuat tanpa grup dan tidak boleh dibuat **tanpa grup** oleh keluarkan anggota / hapus grup (`GRUP_TERAKHIR`):
  user tanpa grup jatuh ke preset role lama (bisa lebih tinggi). Untuk mencabut akses: nonaktifkan.

## 4. Grup utama (BL-63) & `user.role`

- `getPrimaryGroup(userId)` (`lib/rbac/resolve.ts`) = grup berbintang; bila tidak ada bintang dan user tepat 1 grup → grup itu;
  selain itu `null`. Diturunkan saat DIBACA (tidak bergantung backfill).
- Setiap tulisan yang mengubah keanggotaan user juga menjaga data: user dengan tepat 1 grup tanpa bintang → grup itu diberi bintang
  (sebelum dan sesudah perubahan, satu transaksi) — sama dengan backfill `DDL_S7_0.sql`.
- Ganti bintang = dua langkah dalam satu transaksi (lepas semua, lalu pasang); sisa bentrok 23505 → 409 `BINTANG_BENTROK`.
- **`user.role` diturunkan hanya bila grup utama efektif BERUBAH:** utama baru = grup preset yang dikenal (`Admin→admin, Manager→manager,
  Finance→finance, Staff→staff, Viewer→viewer, SPV→spv, SM→sm, Claim→claim, OM→om, Salesman→salesman, Admin Sales→admin_sales`, dan
  `is_preset = true`) → role = petanya. Utama baru = grup custom / preset tanpa peta / tidak ada → role **tidak berubah**, KECUALI role
  saat ini adalah turunan grup utama lama (role === peta(utama lama)) → role kembali ke bawaan `viewer` (agar `admin` tidak tertinggal
  sesudah keluar dari grup Admin). Jalur: tambah/keluarkan anggota, tandai/lepas bintang, hapus grup (semua anggotanya), buat user,
  route lama `users/[id]/group`. Perubahan role dicatat di `detail` audit aksi pemicunya (`roleBefore`, `roleAfter`).
- `pickSyncUserId` (`lib/accurate-session.ts`) TIDAK diubah; ia memakai `role === "admin"` bila `ACCURATE_SYNC_USER_ID` kosong.

## 5. Endpoint

### 5.1 Daftar user — `GET /api/admin/users/permissions` (`users.manage` | `users.view`)
```
{ users: [{ id, name, email, role, permissions, emailVerified, banned, banReason,
            groups: [{ id, name, isPreset, isPrimary }],          // semua grup, urut nama; isPrimary = bintang di DB
            primaryGroupId, primaryGroupName,                     // grup utama EFEKTIF (getPrimaryGroup) atau null
            groupId, groupName }] }                               // LAMA (Beranda/GroupManagement): utama efektif, selain itu grup pertama
```

### 5.2 Buat user — `POST /api/admin/users` (`users.manage`)
Body `{ name, email, password, groupIds: string[≥1], primaryGroupId?: string (∈ groupIds; wajib bila tidak ingin tanpa bintang
pada > 1 grup — opsional) }` → **201** `{ ok: true, user: { id, name, email, role, groupIds, primaryGroupId } }`.
Tanpa pendaftaran publik (`disableSignUp` tetap). `emailVerified: true`. 400/404 `GRUP_TIDAK_ADA`/409 `EMAIL_TERPAKAI`.
Urutan aman (Better Auth di luar transaksi app): validasi semua → `auth.api.createUser` server-side membuat user **dalam keadaan
banned "sedang disiapkan"** (role `viewer`) → transaksi app: grup + bintang + role + buka ban + audit `user.create` → bila transaksi
gagal: user + akun dihapus (kompensasi); bila kompensasi pun gagal, user tetap banned (tidak bisa masuk) → gagal-tertutup.

### 5.3 Atur sandi — `POST /api/admin/users/[id]/password` (`users.manage`)
Body `{ password }` (UI mengetik dua kali di kolom bertopeng; server tidak menerima/membandingkan salinan) → `{ ok: true, sessionsRevoked: n }`.
Hash = hasher Better Auth (`auth.$context.password.hash`), akun `credential` diperbarui/dibuat, **semua sesi user itu dicabut**, audit
`user.password_set` `{ sessionsRevoked }` — satu transaksi. Tanpa email. Atur sandi diri sendiri boleh (sesi sendiri ikut dicabut).

### 5.4 Aktif / nonaktif — `POST /api/admin/users/[id]/status` (`users.manage`)
Body `{ active: boolean, reason?: string (≤ 200) }` → `{ ok: true, changed, active, sessionsRevoked }`. Nonaktif = `banned = true`
(+ `banReason`, tanpa kedaluwarsa) + cabut semua sesi; TIDAK menghapus user. Aktif = buka ban. Sudah dalam keadaan itu → `changed: false`,
tanpa audit. Penjaga: `ADMIN_TERAKHIR`, `AKSES_SENDIRI`. Audit `user.deactivate` / `user.activate`.

### 5.5 Anggota grup — `POST` / `DELETE /api/admin/groups/[id]/members` (`users.manage`)
Body `{ userId }`. POST → `{ ok: true, added, primaryGroupId, role }` (sudah anggota → `added: false`, tanpa audit). DELETE →
`{ ok: true, primaryGroupId, role }`; bukan anggota → 404 `BUKAN_ANGGOTA`. Keluarkan dari grup berbintang → bintang hilang (lalu aturan
1 grup). Penjaga: `ADMIN_TERAKHIR`, `AKSES_SENDIRI`, `GRUP_TERAKHIR`. Audit `user_group.assign` / `user_group.remove`.

### 5.6 Bintang — `PUT` / `DELETE /api/admin/users/[id]/primary-group` (`users.manage`)
PUT body `{ groupId }` (harus grup user itu, selain itu 404 `BUKAN_ANGGOTA`) → `{ ok: true, primaryGroupId, role, roleChanged }`.
DELETE (tanpa body) melepas bintang → jawaban sama (user 1 grup: grup itu tetap utama). Audit `user_group.star` / `user_group.unstar`.

### 5.7 Route lama — `POST /api/admin/users/[id]/group` (`users.manage`) — DIPENSIUNKAN (tetap hidup untuk layar lama)
Semantik "ganti semua" dihapus: kini = **tambah (bila belum) + bintang** grup itu; grup lain TIDAK dihapus. Jawaban
`{ ok: true, role, primaryGroupId }`. S7a memakai 5.5 + 5.6.

### 5.8 Grup — `GET/POST /api/admin/groups`, `GET/PATCH/DELETE /api/admin/groups/[id]` (`users.manage`)
Bentuk jawaban lama tetap; `GET [id]` → `members[]` menambah `isPrimary`. POST/PATCH nama bentrok → 409 `NAMA_GRUP_TERPAKAI`.
PATCH nama/deskripsi + izin = SATU transaksi (validasi kunci dulu → 400 `KUNCI_TIDAK_VALID` tanpa tulis). 409 `PRESET_NAMA_TERKUNCI`,
`ADMIN_PRESET_TERKUNCI`, penjaga. DELETE (custom saja; 409 `PRESET_TIDAK_BISA_DIHAPUS`) = satu transaksi: grup, izin, keanggotaan,
grup utama + role tiap anggota, audit `group.delete` + `user_group.remove` per anggota (`detail.via = "group.delete"`); `GRUP_TERAKHIR`
bila ada anggota yang hanya punya grup ini.

### 5.9 Riwayat — `GET /api/admin/users/[id]/history`, `GET /api/admin/groups/[id]/history` (`users.manage` | `users.view`)
Query `limit` (1–200, bawaan 50), `cursor` (dari jawaban sebelumnya). Urut terbaru dulu (keyset `created_at, id`).
```
{ ok: true, items: [{ id, action, actorUserId, actorName, targetUserId, targetUserName, targetGroupId, targetGroupName,
                      detail, createdAt }], nextCursor: string | null }
```
Riwayat user = baris dengan `target_user_id` = id; riwayat grup = `target_group_id` = id (tetap terbaca sesudah grup dihapus).
Cursor rusak → 400 `INPUT_TIDAK_VALID`. Label aksi: `auditActionLabels` di `lib/rbac.ts`.

### 5.10 Aksi audit (`permission_audit_log.action`)
`user.create`, `user.password_set`, `user.deactivate`, `user.activate`, `user_group.assign`, `user_group.remove`, `user_group.star`,
`user_group.unstar`, `group.create`, `group.update`, `group.delete`, `group_permission.sync`, dan lama `user_group.set_primary`
(baris sebelum S7-1). `detail` tidak pernah memuat sandi/hash.

## 6. Better Auth

- Plugin admin **ditutup dari browser**: `disabledPaths` (`lib/auth.ts`) memuat ke-15 path `/admin/*` plugin (`create-user`,
  `set-user-password`, `set-role`, `ban-user`, `unban-user`, `remove-user`, `list-users`, `get-user`, `update-user`, `has-permission`,
  `impersonate-user`, `stop-impersonating`, `list-user-sessions`, `revoke-user-session`, `revoke-user-sessions`) → HTTP **404**.
  `disabledPaths` hanya berlaku di router HTTP; `auth.api.*` server-side (dipakai `POST /api/admin/users` dan `bootstrap/route.ts`)
  tetap jalan — dibuktikan uji.
- `emailAndPassword.revokeSessionsOnPasswordReset: true`: reset lewat tautan lupa sandi mencabut semua sesi lama user itu.
- Halaman `/admin/users` digerbang `users.manage` efektif (bukan `role === "admin"`).

## 7. Label (satu sumber untuk S7a)
`lib/rbac.ts`: `actionLabels` (termasuk 18 aksi OPC granular), `permissionModuleLabels` (20 modul registry, termasuk `form_kontrol`),
`permissionKeyLabel(key)`, `auditActionLabels`.

## Catatan perubahan
- **Butir 1 (penjaga):** kode baru **403 `IZIN_BERUBAH`** — aktor lolos gerbang `users.manage` saat permintaan masuk, tetapi saat kunci
  global didapat ia sudah bukan admin (dicabut admin lain sesaat sebelumnya; mis. balapan saling mencabut) → ditolak, tidak ada perubahan.
  `POST /api/admin/groups/[id]/members` kini menjawab `{ ok, added }`; 404 berkode `USER_TIDAK_ADA` / `GRUP_TIDAK_ADA`.
- **Butir 2 (BL-62):** `POST /api/admin/users/[id]/status` `{ active: true }` untuk user TANPA grup → 409 `GRUP_TERAKHIR` (aktif tanpa grup =
  akses role lama); tetapkan grup dulu. Galat buat user: `GRUP_TIDAK_ADA` menyertakan `missing: string[]`. Layar lama
  `UserManagement.tsx` dialihkan ke `POST /api/admin/users` dan `POST /api/admin/users/[id]/password` (plugin ditutup); S7a menggantinya.
