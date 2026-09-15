# Handover — tarif Discount Reguler dan pengetatan gerbang promo (13–15 September 2026)

Penerus: baca **`docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`** lebih dulu (butir 4.10, 4.12, 4.39–4.42),
lalu TAHAP 13 pada `docs/SURYA_IMPLEMENTATION.md`. Berkas ini merangkum apa yang berubah, kenapa,
dan apa yang masih menggantung.

---

## Satu kalimat

Penahan alur nomor satu (butir 4.10) dibuka: tarif **Discount Reguler** kini punya tempat di
`promo_rule`, sudah dimuat di produksi (89 tarif untuk 70 outlet), dan gerbang promo diperketat
di tiga titik yang sebelumnya bisa meloloskan uang tanpa dasar.

## Yang berubah dan alasannya

| Perubahan | Kenapa |
|---|---|
| Kolom `customer_code` pada `promo_rule` (migrasi **0013**) | Tarif melekat pada OUTLET, bukan barang. Tanpa kolom ini satu tarif harus disalin per barang — 4.182 baris yang basi tiap master bertambah |
| `matchTariff()` mencocokkan **per kolom** | Posisi menentukan penanggung; 4% di kolom 1 dan 4% di kolom 2 dua hal berbeda |
| `matchItemRule()` juga **per kolom** | Satu aturan 5% tidak boleh meloloskan 3%+2% dari dua program berbeda |
| Aturan dipilih per **tanggal SO**, bukan periode batch | Satu berkas bisa memuat lebih dari satu hari |
| Potongan tanpa aturan → **tak bertuan** | Mencatatnya sebagai beban distributor = mengaku menanggung; sebagai klaim principal = mengaku berhak menagih |
| Impor sheet `Discount Reguler` + kolom `PAKAI` wajib | Tabelnya diekstrak dari FOTO; aturan tebakan yang lolos sama buruknya dengan tidak punya gerbang |
| Muat ulang hanya mengganti irisannya sendiri | Sheet `Detail` untuk aturan surat, `Discount Reguler` untuk tarif — dulu yang satu mencabut yang lain |
| Menu **Aturan Promo** (`/aturan-promo`) | Impor mengganti seluruh irisan; satu perbaikan kecil tidak boleh mempertaruhkan seluruh muatan |
| Dua **laporan pemeriksaan tarif** di Rekap Promo | Mesin tidak bisa menilai tarif lawan kontrak, tapi bisa lawan faktur nyata |

## Tiga temuan yang tidak akan terbaca dari kode

1. **Dua nilai yang tercetak bersebelahan di tabel tarif itu kolom 1 dan 4**, bukan dua kolom
   berdampingan. Dibuktikan dengan menyapu sepuluh berkas `ORDER_DETAIL` lama, bukan dengan
   membaca fotonya. **Kalau ragu soal posisi, sapu ORDER_DETAIL lagi — jangan menafsir foto.**
2. **29 baris cetak di tabel = 70 OUTLET.** Sebagian barisnya jaringan: SATU SAMA JAYA 17 outlet,
   MISI PASARAYA 12, Indomaret/Alfamart/Sangir Talaud 5. Anggota satu jaringan **tidak punya
   awalan kode bersama** (`C-SA0001`, `C-SA0269`, `C-SAT015`…), jadi jangan pernah mencocokkan
   tarif dengan menebak dari nama atau awalan.
3. **Berkas migrasi tidak ada di VPS** — deploy lewat image GHCR, bukan checkout repo. Jalankan
   SQL-nya dengan heredoc ke `docker exec -i accapi-postgres psql`; `< db/migrations/...` selalu
   gagal di sana.

## Keputusan pengguna yang mengikat

- **Posisi Alfamart, Alfamidi, Indomaret, Indogrosir = kolom 2**, beban distributor. Ditegaskan
  dua kali setelah saya tunjukkan bahwa `ORDER_DETAIL` melaporkannya di DISC_4.
  **Konsekuensi yang diterima: baris keempat jaringan itu akan TERTAHAN** selama Kino masih
  menaruhnya di kolom 4. Itu disengaja — menahan lebih baik daripada menagih uang yang bukan hak.
- **Indomaret 3%**, bukan 3,1%. Berlaku sampai ada kabar dari Kino.
- **Satu Sama Jaya 17 outlet** (bukan 18; yang kembar sudah dihapus pengguna).
- Potongan tanpa aturan = tak bertuan **di kolom mana pun**.
- Yang belum dipastikan posisinya **jangan dimuat** — dijaga kolom `PAKAI`, bukan kedisiplinan.

## Keadaan produksi saat ditutup

- Migrasi **0013 sudah dijalankan dan diverifikasi** di produksi.
- `promo_rule`: **145 aturan surat + 89 tarif outlet = 234**. Tarif dimuat pengguna 14 Sep dari
  `DISCOUNT REGULER - KINO NON FOOD - POSISI2.xlsx` (70 baris → 89 aturan, 70 outlet).
- Gerbang kirim otomatis **tetap tertutup**; faktur hanya naik lewat tombol.
- Dev server dan Postgres lokal masih hidup di mesin pengembang; data uji sudah dibersihkan
  (kembali 145 aturan, 0 tarif di lokal).

## Yang MASIH menggantung — kerjakan dari sini

1. **Validasi ulang batch 12 September belum pernah dijalankan.** Ini pembuktian utama dan
   satu-satunya yang belum ada. Target: 37 lolos → 48. Simulasi offline sudah menunjukkan
   kesebelas baris distributor lolos, tetapi belum pernah diuji atas produksi.
2. **Pemetaan `CUST_ID2` → kode internal untuk SS DIAPERS** (`C-SAT016`, `C-SAT015`) masih
   diturunkan dari nama pelanggan pada laporan, **belum diadu dengan `principal_mapping`**.
   Kalau setelah muat tarif kedua outlet itu tetap tertahan, di situ sebabnya.
3. **Konfirmasi Kino** untuk dua hal: Indomaret 3,1%, dan keempat jaringan yang melaporkan
   potongan beban distributor di kolom klaim principal.
4. Butir **4.25** masih kosong: belum pernah ada satu pun teks penolakan asli dari Accurate.
5. Pemilihan tanggal proses faktur di web, dan keputusan apakah `sync-item-prices` masuk cron.

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_TARIF_2026-09-15.md` lalu butir 4.10/4.12/4.39–4.42 pada
> `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`. Tarif Discount Reguler SUDAH dimuat di produksi
> (234 aturan: 145 surat + 89 tarif outlet) dan migrasi 0013 sudah jalan di sana. **Langkah
> pertama: jalankan Validasi ulang batch 12 September di produksi** — itu satu-satunya
> pembuktian yang belum pernah ada; target 37 lolos menjadi 48. Kalau ada baris yang tetap
> tertahan, periksa dulu pemetaan `CUST_ID2` SS DIAPERS lawan `principal_mapping`, lalu
> keempat jaringan yang sengaja ditahan karena Kino melaporkan potongan beban distributor di
> kolom 4. Gerbang kirim otomatis TETAP TERTUTUP. Jangan stage massal — working tree masih
> memuat pekerjaan rekonsiliasi dan eksperimen OCR lama.
