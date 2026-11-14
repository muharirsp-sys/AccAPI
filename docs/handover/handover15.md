# HANDOVER — handover15.md (Form Kontrol: dua alur order salesman, limit kredit, Rute hari ini dirapikan)

**Status per 14 Nov 2026 siang:** dikerjakan di worktree `D:\Coding\AccAPI\wt-laporan-harian`, branch **`feat/fk-dua-flow-order`** (dari `origin/main`
3f41d4c5). **Belum di-commit, belum ada PR, belum di produksi.** Baca `handover14.md` dulu untuk aturan kerja (merge ke `main` = deploy produksi,
tanpa `gh`, skrip `scratch/gh-api.mjs` + `scratch/tunggu-ci.mjs`, berkas CRLF).

## 1. Permintaan owner (14 Nov 2026)

- Dua tipe salesman (`sales_profile.sumber_order`):
  - **Input di sistem internal (accapi):** Form Kontrol → pilih toko → ORDER → halaman order terbuka otomatis → isi stok toko saat ini dari
    riwayat pengambilan → item super WAJIB ditawarkan dulu (muncul di halaman order) → input order (permintaan toko + saran salesman) → Kirim order → merchandising.
  - **Input di sistem principal:** alur sama, halaman order TANPA isian order; item super tetap wajib; tombol **Sudah input order** (tidak mengirim
    apa pun ke Accurate) → merchandising.
- No urut JKS tidak tampil di Form Kontrol; tambahkan limit; tampilan halaman salesman dirapikan (informasi tetap) memakai skill antislop.

## 2. Yang dibangun

| Bagian | Isi |
|---|---|
| Skema **0043** (zona §3) | `ao_control_daily.order_ref` + `order_dicatat_pada` (langkah Order selesai; `websales:<id>[,…]` atau `principal`), tabel `stok_toko_kunjungan` (tanpa DELETE). `db/migrations/0043_order_kunjungan.sql`, entri migrate-pg "order kunjungan", `docs/handover/DDL_ORDER_KUNJUNGAN.sql` |
| Server | `POST /api/form-kontrol/order-kunjungan` (item super dihitung ulang server + stok + `selesai.ref` sesuai tipe salesman); `lib/form-kontrol/order-kunjungan.ts` (murni, teruji); `db.ts` `simpanOrderKunjungan`, `bacaStokKunjungan`, `limitToko` (limit di rute + GET visit) |
| Wizard | 5 langkah Check-in → Status → **Order** → Merchandising → Check-out. Simpan ORDER → `router.push` ke `/form-kontrol/visit/[custCode]/order`. TIDAK ORDER melewati Order (item super tetap di Merchandising). Nomor order principal pindah ke halaman order |
| Halaman order | `visit/[custCode]/order/{page,OrderKunjungan,StokToko}.tsx`. Stok: 10 barang teratas riwayat wajib (0 boleh); riwayat tak terbaca / toko bukan pelanggan cabang = tidak wajib. Accapi: `OrderSales` mode `kunjungan` (isian terkunci sampai stok + item super; Tambah dari stok dengan saran = ceil(rata − stok); Kirim = simpan FK → Web Sales → catat ref). Principal: dialog "Sudah input order" |
| Rute hari ini | Tanpa "Urutan N"; kartu = kode + status, nama, status kunjungan, alamat, tiga angka (Target, Realisasi bulan, **Limit kredit + sisa**, merah bila lewat), keterangan, lencana; saringan `.fi-segs` satu baris; Muat ulang = ikon di samping judul |
| Skill | antislop v3.2.30 (MIT, github.com/miqdadbadjuber/anti-slop) dipasang di `~/.claude/skills/{antislop,antislop-ui,antislop-layoutmobile}` setelah dibaca isinya |

## 3. Uji

- `npm test` hijau (pg dilewati, tanpa Postgres lokal). `npx tsc --noEmit` + eslint berkas berubah bersih.
- Playwright baru `tests/fiori-form-kontrol-order-kunjungan.spec.ts` (4 uji: rute 390 px, alur principal, alur accapi, TIDAK ORDER).
  Tiga uji lama disesuaikan (teks kepala rute, angka realisasi di kartu, K4 luar rute memakai order tercatat).

## 4. Keputusan default yang PERLU dikonfirmasi owner

1. "Limit" = **limit kredit pelanggan Accurate** (cabang = principal rute); sisa = limit − `customer.balance` (saldo sinkron terakhir, bukan real time).
2. Stok wajib = **10 barang teratas** riwayat 3 bulan; sisanya opsional.
3. Item super "dipesan" untuk salesman accapi punya tombol "Tambah ke order" (jumlah 1, satuan dipilih salesman bila lebih dari satu).
4. Kunjungan ORDER yang sedang berjalan saat deploy harus melewati halaman order dulu sebelum Merchandising.

## 4b. Tinjauan independen (gate-verifier) dan tindak lanjutnya

- Ref `websales:<id>` kini diperiksa server: permintaan harus ada di antrean Order Sales akun itu (FastAPI `GET /websales/orders`, cookie
  diteruskan), untuk toko kunjungan (`cocokKodeRute`), bertanggal kunjungan, tidak ditolak. Antrean tak terbaca = 503 (layar: catat ulang, tanpa kirim ulang).
- Status ORDER → TIDAK ORDER mengosongkan `order_dicatat_pada` (ref tetap sebagai jejak); layar Status memperingatkan order yang sudah terkirim tidak
  ikut batal. Kembali ke ORDER = halaman order lagi; order lama bisa "Catat ke kunjungan ini" tanpa kirim ulang.
- `limitToko`: urutan tetap (kode persis menang, lalu kode berakhiran pertama).
- Diterima sebagai celah: kelengkapan stok (10 barang wajib) hanya dijaga layar; server memeriksa format saja.

## 5. Belum / risiko

- Uji Postgres 0043 + `simpanOrderKunjungan` belum pernah jalan (sama dengan §5.1 handover14).
- Supervisor Review belum menampilkan stok toko / ref order kunjungan (data sudah tersimpan).
- Halaman order memakai `/api/customers/rute` + `/riwayat-beli` (izin `websales.create`); salesman principal tanpa izin itu = stok tidak wajib (strip peringatan), alur tetap jalan.
