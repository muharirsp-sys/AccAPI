# HANDOVER — handover14.md (Form Kontrol: JKS Web-LL, Item Super, peta + GPS, radius titik toko, realisasi Accurate)

**Status per 14 Nov 2026 pagi: semua PR di bawah SUDAH di-merge ke `main` dan ter-deploy ke produksi (https://web-super.online).**
Tidak ada branch kerja yang menggantung. Lanjutan = item di §6.

---

## 0. BACA INI DULU — tempat kerja dan jebakan

- **Repo produksi** = GitHub `muharirsp-sys/AccAPI`, clone `D:\Coding\AccAPI\_github_clean`, worktree kerja **`D:\Coding\AccAPI\wt-laporan-harian`**.
  `D:\Coding\AccAPI` (root, branch `master`, tanpa remote) **BUKAN** aplikasi produksi — jangan kerja di sana.
- **Merge ke `main` = deploy produksi otomatis** (`.github/workflows/deploy.yml`: build image GHCR → redeploy Coolify; `scripts/migrate-pg.mjs` jalan saat
  container start). Merge di luar jam kunjungan salesman (pagi sebelum ±07.30 WITA atau malam).
- **Repo TIDAK mengizinkan GitHub auto-merge.** "Merge saat CI hijau" = tunggu check-run commit lalu merge lewat API.
  Mesin ini tanpa `gh` CLI → pakai skrip di `scratch/` (gitignored, memakai kredensial git tersimpan, token tidak dicetak):
  - `node scratch/gh-api.mjs <METHOD> <path> [badan.json]` — mis. `POST /repos/muharirsp-sys/AccAPI/pulls`, `PUT /repos/muharirsp-sys/AccAPI/pulls/<n>/merge`.
    Di Git Bash awali `MSYS_NO_PATHCONV=1` (kalau tidak, path `/repos/...` dirusak).
  - `node scratch/tunggu-ci.mjs <sha-40-huruf>` — tunggu semua check-run commit selesai (maks. 30 menit). **Pakai SHA yang benar dari
    `git rev-parse HEAD`** — SHA tebakan membuat skrip menunggu 30 menit sia-sia.
- **Berkas CRLF**: banyak berkas repo ber-CRLF. Skrip penyunting harus menormalkan `\r\n` dan memakai **fungsi pengganti** di `String.replace`
  (`s.replace(a, () => b)`) — teks pengganti biasa menafsirkan `$&` dan pernah merusak `db.ts`.
- **Peramban (panel)**: jangan tekan Escape di dialog (menutup dialog + hilang pilihan berkas); koordinat klik = `getBoundingClientRect × 800/innerWidth`;
  jangan pernah mengetik sandi — pemilik mengetik sendiri; unggah berkas = pemilik memilih berkasnya.
- Aturan repo: `AGENTS.md` + `CLAUDE.md` di worktree (gaya "ponytail", komentar kepala berkas, peta `SYSTEM_MAP.md` wajib diperbarui).

## 1. PR yang sudah mendarat

| PR | Isi | Skema |
|---|---|---|
| #258 (13 Nov) | JKS Web-LL siklus 4 minggu (M1–M4, F8 dua hari), dua tipe sales (`sumber_order` accapi/principal), Item Super + penawaran di Merchandising, panel *Kontrol bulan ini* Supervisor Review | 0041 |
| #260 | Rute hari ini: tombol Google Maps, alamat, target, omzet, Kelas A, minggu siklus, Bagikan/Cetak rute. GPS WAJIB check-in + check-out. Radius titik toko: **fix 20 m / validasi 100 m + toleransi akurasi GPS maks. 15 m**; di luar radius = alasan + **pengajuan ke IT**, kunjungan tetap lanjut. Tab **Validasi Lokasi** (unggah berkas selisih titik, putusan IT oleh role admin saja, antrean perbaikan lokasi). Supervisor Review: jarak check-out, status pengajuan IT, analisa kunjungan GPS bulanan | **0042** (`ao_control_daily.checkout_*`, `toko_koordinat.status`, tabel `pengajuan_lokasi`) |
| #261 | Realisasi faktur Accurate bulan berjalan per toko (Σ INV termasuk PPN + jumlah faktur + % target) di rute, kunjungan, bagikan/cetak; ringkasan rute vs target | — |
| #262 | Label "Pindahan dari …" / "Baru ditugaskan" (kolom STATUS + SALES SEKARANG Web-LL) disembunyikan per toko; ringkasan "Toko pindahan sudah order" untuk SPV tetap | — |

Berkas kunci: `lib/form-kontrol/{db,constants,jks-webll,item-super,item-super-db,peta,gps,radius,lokasi,lokasi-db}.ts`,
`lib/supervisor-review/{ringkasan,kontrol,kontrol-db,db,kontrak}.ts`, `app/(dashboard)/form-kontrol/tabs/{TabAo,TabJks,TabItemSuper,TabLokasi,TabHierarki}.tsx`,
`app/(dashboard)/form-kontrol/visit/[custCode]/{Kunjungan,FotoBukti}.tsx`, `app/api/form-kontrol/{checkin,checkout,lokasi,jks,item-super}/**`.

## 2. Keputusan owner (jangan diubah tanpa bertanya)

- Minggu = nomor minggu per tahun; 13 Nov 2026 = minggu 46 = **M2**, 16 Nov = M3, 30 Nov = M1 (`ACUAN_MINGGU_GENAP` di `constants.ts`).
- Sales input di sistem principal: KINO, RECKITT, GODREJ, HEINZ, MOTASA, CUSSONS. TARGET TOKO Web-LL **termasuk PPN**.
- JKS baru mengganti JKS lama per principal; varian item super (13 digit sama) = satu saran.
- Radius: titik fix 20 m, perlu validasi 100 m, toleransi akurasi GPS maks. 15 m; di luar radius → ajukan ke IT, kunjungan lanjut.
  Toko tanpa titik: tanpa radius, titik check-in pertama dikumpulkan lalu dinilai di Antrean perbaikan lokasi.
- Status titik dari berkas `D:\Coding\Web-LL\data\selisih_titik_alamat_2026-11-11_baru.xlsx` (sheet 1_SANGAT_BERBEDA 188, 2_BERBEDA 147,
  3_ALAMAT_KELIRU 102 → validasi; kolom LATITUDE/LONGITUDE BENAR terisi → titik baru fix). 58 toko Kino/Primarasa termasuk.
- Hierarki: Kino = SPV_DARMAN / SM IRMAN; Primarasa = SPV_RAMLY / SM ADNAN; MSM = SPV_SYAMSUL / ADNAN.
- Label pindahan/baru ditugaskan tidak ditampilkan per toko; ringkasan SPV tetap.

## 3. Data produksi yang sudah diisi (lewat layar, oleh owner / sesi ini)

- 12 akun salesman Kino (8, sumber order = principal) + Primarasa (4) tertaut karyawan Accurate (KN7_DINA WAHYUNI = M-DW); akun SPV_DARMAN,
  IRMAN, SPV_RAMLY dibuat (sandi bawaan bersama — **minta diganti**).
- JKS Primarasa (827 baris) + Kino (1475 baris, principal "KINO NON FOOD") diimpor; rute Senin 16 Nov cocok dengan berkas.
- Item Super Kino + Primarasa (400 saran, Mei s/d Okt 2026) diunggah.
- Unggah berkas status titik + muat ulang Form Kontrol: owner menjawab "Sudah" (14 Nov) — **belum diverifikasi dari sesi**; cek di tab Validasi Lokasi
  (ringkasan "Perlu validasi (100 m)" seharusnya > 0).

## 4. Cara uji lokal

- Tanpa Postgres lokal (uji `*-pg.test.ts` selalu dilewati; WSL/Docker tidak ada). `npm test` = uji murni.
- Dev server worktree: `D:\Coding\AccAPI\wt-laporan-harian\.env.local` (gitignored) berisi `LOCAL_AUTH_BYPASS=true` + secret acak + DATABASE_URL palsu;
  jalankan lewat konfigurasi **`wt-laporan-dev`** (port 3001) di `D:\Coding\AccAPI\.claude\launch.json`.
- Playwright (API di-mock): `PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test tests/fiori-lapangan-salesman.spec.ts tests/fiori-supervisor-review.spec.ts tests/fiori-form-kontrol-luar-rute.spec.ts tests/fiori-form-kontrol-noo.spec.ts tests/fiori-supervisor-peta.spec.ts tests/fiori-form-kontrol-lokasi.spec.ts tests/fiori-lapangan-tim.spec.ts tests/fiori-form-kontrol-msm.spec.ts`
  (106 lulus per 14 Nov).
- CI PR: typecheck + "Deterministic risk gate" (+ build-and-push dilewati di PR). Skema = CRITICAL bagi PR Guardian.

## 5. Belum terverifikasi / risiko yang diketahui

1. **Uji Postgres** (0041/0042, `tulisAjuan`, `putuskanPengajuan`, `terapkanStatusTitik`) belum pernah jalan.
2. **GPS nyata di ponsel salesman** belum dicoba (semua uji memakai lokasi tiruan). Pantau antrean pengajuan IT hari pertama — bila membanjir, tinjau
   toleransi/titik.
3. **Angka realisasi** (#261) belum dicocokkan dengan data produksi. Realisasi = principal rute harus sama dengan `customer.branch_name` Accurate;
   principal di cabang gabungan (mis. MIX FOOD) → angka disembunyikan. Cek: `SELECT DISTINCT principle FROM jks_master EXCEPT SELECT name FROM branch`.
   Angka rute (per toko, semua salesman, per cabang) ≠ *Kontrol bulan ini* (per salesman) — memang beda definisi.
4. Mengunggah ulang berkas status titik LAMA bisa mengembalikan titik yang sudah difix IT menjadi "validasi" (unggahan tidak tahu urutan waktu).
5. `antreanLokasi` membaca 90 hari `ao_control_daily` tiap muat tab (tanpa indeks `date`) — perhatikan bila lambat.
6. Halaman lama yang masih terbuka di ponsel saat deploy ditolak check-out (tanpa GPS) sampai dimuat ulang.
7. Pelacakan lokasi terus-menerus tidak dibuat (peramban tidak melacak di latar belakang) — hanya titik check-in/check-out.

## 6. Usulan lanjutan (belum dikerjakan)

- Dari daftar 6 fitur yang disetujui owner 13 Nov: **#2 Realisasi JKS vs nota Accurate per tanggal** (toko terjadwal ber-nota / tanpa nota / nota di luar
  jadwal atau rayon) dan **#5 Pelacak outlet potensi → nota pertama** belum punya layar sendiri (sebagian angka ada di *Kontrol bulan ini*).
- JKS principal lain (Reckitt, Godrej, Heinz, Motasa, Cussons, dst.) belum diimpor ke produksi; akun salesman mereka juga belum ada.
- Uji Postgres lokal (pasang Postgres/Docker) untuk menutup §5.1.

## 7. Memori sesi

`C:\Users\OMEN\.claude\projects\D--Coding-AccAPI\memory\`: `jks-item-super-form-kontrol.md` (status + keputusan), `jks-source-web-ll.md` (sumber JKS Web-LL),
`toko-dc-jangan-ditutup.md`, `kerjakan-sendiri-lewat-accurate.md`.
