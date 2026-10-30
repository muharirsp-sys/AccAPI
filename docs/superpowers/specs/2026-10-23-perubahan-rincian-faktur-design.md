# Pencatat perubahan rincian faktur — desain

Tanggal: 23 Okt 2026. Status: disetujui owner 23 Okt; DIIMPLEMENTASI 24 Okt di cabang `feat/perubahan-rincian-faktur` (belum di-push). Bila spec dan kode berbeda, kode yang benar.
Zona §3 AGENTS.md: skema baru + jalur sinkron faktur → review manusia, merge atas perintah owner.

## 1. Tujuan dan lingkup

Setiap kali isi faktur penjualan (INV) berubah di Accurate, AccAPI mencatat **baris mana yang hilang, bertambah, atau berubah**,
**oleh manusia atau aplikasi**, **kapan**, dan **apakah faktur sudah dicetak** saat diubah. Tujuannya menjawab pertanyaan audit stok
seperti "apakah faktur yang memuat barang X dikoreksi sesudah barangnya keluar?" tanpa bergantung pada cadangan database.

**Masuk lingkup:**
- Perubahan baris faktur INV yang terlihat lewat `detail.do`: webhook Accurate, penambal (`/api/cron/webhook-backfill`), dan kirim faktur.
- Faktur INV yang dihapus di Accurate: semua baris terakhirnya dicatat sebagai `invoice_deleted`.

**Di luar lingkup:**
- Halaman laporan atau ekspor. Sementara dibaca lewat SQL (§9).
- Mengisi riwayat lama dari cadangan `/root/cadangan`.
- Perubahan kepala faktur (tanggal, pelanggan, salesman, keterangan).
- Draf `DFT.*` dan dokumen lain (retur, pengiriman, penyesuaian, pindah gudang, faktur pembelian).
- Nama pengguna yang mengubah. API Accurate tidak memberikannya; hanya Log Aktifitas di layar Accurate.

## 2. Fakta yang membentuk desain (penyelidikan 23 Okt, baca-saja)

- **API publik Accurate tidak punya Log Aktifitas maupun versi lama faktur.** Spesifikasi `acc.json.do` (Mar 2026, 321 operasi) hanya
  punya `webhook-history.do` dan `item/stock-mutation-history.do`. `detail.do` selalu memberi keadaan terakhir.
- **Cache kita menimpa isi lama.** `sales_invoice.raw_data` ditimpa tiap webhook ([lib/sync.ts](../../../lib/sync.ts) `upsertSalesInvoiceById`),
  dan History Penjualan mengganti barisnya bila `lastUpdate` berubah. Versi lama hanya selamat di cadangan pra-rilis.
- **Kasus nyata:** INV/2610/CS00399 dicetak 17/10 16.23, lalu 22/10 Cotton Buds diubah 72 → 6 PCS (−Rp 330.973,80). Baris lain sama,
  id baris (`detailItem[].id`) tetap. Isi lamanya hanya bisa dipulihkan dari cadangan 19 Okt.
- **Audit stok 9 barang (Jul–23 Okt):** hanya 2 koreksi baris yang terbukti. 69 faktur lain totalnya berubah, tetapi isi sebelum
  perubahannya tidak tersimpan di mana pun.
- **Bentuk amplop webhook** (log produksi): `{databaseId, type:"SALES_INVOICE", timestamp:"dd/MM/yyyy HH:mm:ss", uuid, appKey?,
  data:[{salesInvoiceId, salesInvoiceNo, salesInvoiceTotalAmount, action:"WRITE"|"DELETE"}]}`. `appKey` hanya ada bila disimpan
  aplikasi: `70a5d9f9…` = AccAPI, `872cb6…` = aplikasi lain. Tanpa `appKey` = disimpan orang di layar Accurate.
- **Zona waktu (dibuktikan):**
  - `timestamp` webhook, `createDate`, dan `*View` (mis. `printedTimeView` "17 Oct 2026 15:23:23") = **WIB (UTC+7)**.
    Bukti: `receivedAt` 05:58:34Z ↔ `timestamp` 12:58:34 ↔ `createDate` 12:58:32.
  - `printedTime` ("17/10/2026, 16:23", tanpa detik) dan `lastUpdate` dari `list.do` = **WITA (UTC+8)**.
    Bukti: 1.850 dari 1.914 `lastUpdate` cocok ±3 menit dengan webhook bila dibaca WITA.
  - Mencetak faktur tidak mengubah `lastUpdate` dan tidak memicu webhook.

## 3. Pendekatan

**Dipilih: catat selisih saat cache faktur diperbarui.** Di `upsertSalesInvoiceById`, isi lama dibaca sebelum ditimpa, dibandingkan
dengan jawaban `detail.do`, dan hanya baris yang berbeda yang disimpan. Satu titik ini dilewati webhook, penambal, dan kirim faktur.

**Ditolak:**
- **Simpan versi utuh per simpan, bandingkan saat dibaca.** ±1.800 simpan per hari × ±100 KB `raw_data` ≈ 180 MB per hari, dan
  tetap butuh pembanding. Tidak sepadan untuk kebutuhan yang hanya baris.
- **Trigger Postgres di `sales_invoice`.** Tidak tahu `appKey` maupun jam simpan Accurate. `raw_data` tersimpan sebagai teks JSON,
  dan cron `list.do` memperbarui ±66 ribu baris per hari, jadi trigger ikut jalan di semuanya.

## 4. Skema

Berkas `db/migrations/0037_sales_invoice_line_change.sql`, didaftarkan di `scripts/migrate-pg.mjs` (entri baru, `sudahAda` lewat
`pg_indexes`: kedua indeks ada di `current_schema()`). Produksi punya `DATABASE_MIGRATION_URL`, jadi entri ini yang menerapkan saat container start. EXPAND saja: tabel baru,
tidak menyentuh tabel lain, idempoten. Drizzle: `salesInvoiceLineChange` di `db/schema.ts`.

```sql
CREATE TABLE IF NOT EXISTS sales_invoice_line_change (
    id              bigserial     PRIMARY KEY,
    invoice_id      bigint        NOT NULL,     -- id Accurate. Tanpa FK: faktur yang dihapus tetap tercatat.
    invoice_number  text          NOT NULL,
    trans_date      text          NOT NULL,     -- dd/MM/yyyy, sama dengan sales_invoice.trans_date
    customer_no     text          NOT NULL DEFAULT '',
    kind            text          NOT NULL CHECK (kind IN ('removed', 'added', 'changed', 'invoice_deleted')),
    line_id         bigint,                     -- detailItem[].id Accurate
    item_no         text          NOT NULL,
    item_name       text          NOT NULL DEFAULT '',
    old_line        jsonb,                      -- NULL bila 'added'
    new_line        jsonb,                      -- NULL bila 'removed' / 'invoice_deleted'
    base_qty_delta  numeric,                    -- qty×rasio baru − qty×rasio lama. Negatif = stok Accurate naik. NULL bila rasio tak ada.
    total_before    numeric(18,2),
    total_after     numeric(18,2),
    app_key         text,                       -- '' = manusia di layar Accurate; terisi = aplikasi; NULL = tidak diketahui
    source          text          NOT NULL CHECK (source IN ('webhook', 'backfill', 'send')),
    saved_at        timestamptz,                -- jam simpan menurut timestamp event webhook; NULL di luar webhook
    printed_at      timestamptz,                -- printedTimeView (WIB); NULL = belum pernah dicetak
    printed_by      text          NOT NULL DEFAULT '',
    after_print     boolean       NOT NULL,     -- printed_at <= coalesce(saved_at, detected_at)
    detected_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_silc_item_no    ON sales_invoice_line_change (item_no, detected_at);
CREATE INDEX IF NOT EXISTS idx_silc_invoice_id ON sales_invoice_line_change (invoice_id);
-- Bila role aplikasi ada: GRANT SELECT, INSERT ON sales_invoice_line_change TO accapi_app;
--                         GRANT USAGE ON SEQUENCE sales_invoice_line_change_id_seq TO accapi_app;
```

Isi `old_line` / `new_line`: `{qty, unit, ratio, price, discPercent, discRp, total, warehouse}` dari `quantity`, `itemUnit.name`,
`unitRatio`, `unitPrice`, `itemDiscPercent`, `itemCashDiscount`, `totalPrice`, `warehouse.name`.

Volume: satu baris per baris faktur yang berubah, perkiraan ratusan per hari. Disimpan selamanya, tanpa pembersihan.

## 5. Komponen dan alur

| Unit | Tugas | Bergantung pada |
|---|---|---|
| `lib/accurate-webhook.ts` → `salesInvoiceEvents(payload)` | Amplop webhook → `[{id, action, appKey, savedAt}]`. `appKey` = `''` bila tidak ada, `savedAt` = `timestamp` dibaca WIB. | — (murni) |
| `lib/sales-invoice-change.ts` → `diffInvoiceLines(oldRaw, newRaw, ctx)` dan `deletedInvoiceLines(oldRaw, ctx)` | Bandingkan dua `detail.do` → baris siap-INSERT. | — (murni) |
| `lib/sync.ts` → `upsertSalesInvoiceById(id, creds, ctx?)` | Ambil `detail.do`, lalu dalam satu transaksi: kunci, baca lama, upsert, catat. | Postgres |
| `upsertSalesInvoiceRows(rows, q = db)` (dipakai `SYNC_MODULES.sales_invoice.upsertPage` dan jalur webhook) | Badan upsert lama, kini bisa memakai transaksi pemanggil. | Postgres |

`ctx = { source: 'webhook' | 'backfill' | 'send', appKey: string | null, savedAt: Date | null }`.
Bawaan `{ source: 'backfill', appKey: null, savedAt: null }`, jadi pemanggil lama (penambal, uji PG Supervisor Review) tidak berubah.

```
webhook route ─ salesInvoiceEvents(payload) ─► per event: upsertSalesInvoiceById(id, creds, {source:'webhook', appKey, savedAt})
penambal      ─────────────────────────────► upsertSalesInvoiceById(id, creds)                    (ctx bawaan 'backfill')
kirim faktur  ─────────────────────────────► upsertSalesInvoiceById(id, creds, {source:'send', appKey:null, savedAt:null})

upsertSalesInvoiceById:
  detail.do
  faktur sudah tiada? → (pagar ACCURATE_INVOICE_DB_ID tetap seperti sekarang)
                       BEGIN; kunci; DELETE … RETURNING raw_data; SAVEPOINT; INSERT deletedInvoiceLines(raw lama); COMMIT
  selain itu         → BEGIN
                         pg_advisory_xact_lock(hashtextextended('sales_invoice:' || id, 0))
                         SELECT raw_data FROM sales_invoice WHERE id = $1           (lewat primary key)
                         upsertSalesInvoiceRows([row], tx)                           (perilaku sama dengan sekarang)
                         SAVEPOINT → INSERT diffInvoiceLines(raw lama, row, ctx)    (gagal → ROLLBACK TO SAVEPOINT + log)
                       COMMIT
  recordInvoiceRealization tetap di luar transaksi, seperti sekarang.
```

## 6. Aturan perbandingan

- **Hanya faktur INV.** Dicatat bila nomor LAMA dan BARU (atau nomor lama untuk penghapusan) sama-sama diawali `INV/`. Draf `DFT.*` dan draf yang baru terbit (lama `DFT.*`, baru `INV/`) dilewati: penerbitan draf bukan suntingan rincian.
- **Butuh isi lama berincian.** Bila baris cache belum ada atau `raw_data` lamanya tanpa `detailItem` (faktur pertama kali
  terbaca), tidak ada yang dicatat.
- **Kunci baris = `detailItem[].id` + kode barang.**
  - Ada di lama, tidak ada di baru → `removed`.
  - Ada di baru, tidak ada di lama → `added`.
  - Ada di keduanya dan salah satu kolom pembanding berbeda → `changed`.
  - Baris yang barangnya diganti (id sama, kode lain) → `removed` barang lama + `added` barang baru, supaya kueri per barang
    melihat keduanya.
  - Baris tanpa `id` dianggap tak berpasangan (jadi `removed` + `added`).
- **Kolom pembanding:** `quantity`, `itemUnit.name`, `unitRatio`, `unitPrice`, `itemDiscPercent`, `itemCashDiscount`,
  `warehouse.name`. Angka dibandingkan dengan toleransi 1e-6; diskon persen kosong, "0", dan "0.0" dianggap sama. Id baris kembar dalam satu faktur diberi kunci unik supaya tidak ada baris yang tertimpa.
- **Diabaikan:** `deliveredQuantity`, `returnQuantity`, `availableQuantity`, `shipQuantity` (berubah karena retur/pengiriman, bukan
  suntingan), salesman per baris, catatan baris, dan semua kolom kepala.
- **`base_qty_delta`** = `quantity × unitRatio` baru − lama. `removed` / `invoice_deleted` = −lama; `added` = +baru.
  NULL bila salah satu `unitRatio` tidak ada.

## 7. Manusia atau aplikasi, waktu, dan cetak

- **`app_key`:** dari amplop webhook. `''` = orang di layar Accurate. Nilai lain = aplikasi (`70a5d9f9…` = AccAPI).
  NULL untuk penambal dan kirim faktur, karena asal simpannya tidak diketahui di jalur itu.
- **`saved_at`:** `timestamp` amplop dibaca sebagai `+07:00`. NULL di luar webhook.
- **`printed_at` / `printed_by`:** dari `printedTimeView` (dibaca `+07:00`, berdetik) dan `printUserName` pada `detail.do` baru.
  Untuk penghapusan, dari isi lama. Nilai "Belum cetak/email" atau kosong → NULL / `''`.
- **`after_print`** = `printed_at IS NOT NULL AND printed_at <= coalesce(saved_at, detected_at)`.
  Batas yang diketahui:
  - Bila faktur dicetak ulang SESUDAH diubah tetapi sebelum `detail.do` kita terbaca (hitungan detik), cetakan ulang itu yang terbaca.
  - Di jalur penambal (`saved_at` NULL) pembandingnya jam deteksi, yang bisa berjam-jam sesudah simpan sebenarnya; cetakan di antara
    keduanya membuat `after_print` benar padahal simpannya sebelum cetak. `detail.do` tidak membawa `lastUpdate`, jadi tidak ada
    jam simpan yang lebih baik di jalur itu.
- **`printed_by`** tetap diisi dari `printUserName` (kecuali "Belum cetak/email") walau `printedTimeView` gagal dibaca, supaya
  kegagalan baca jam cetak terlihat di data (`printed_at` NULL tetapi `printed_by` terisi).

## 8. Galat dan konkurensi

- **Pencatatan tidak boleh menghalangi cache.** INSERT berada di SAVEPOINT. Kalau gagal (mis. tabel belum ada karena migrasi belum
  jalan, atau data aneh), savepoint dibatalkan, galat dicatat ke log `[perubahan-faktur]`, dan upsert cache tetap di-commit.
  Webhook tetap 200 dan Accurate tidak mengirim ulang.
- **Pembanding melempar galat** (bentuk `raw_data` tak terduga) → ditangkap, dicatat di log, tidak ada yang di-INSERT, upsert jalan.
- **Dua webhook untuk faktur yang sama bersamaan:** `pg_advisory_xact_lock(hashtextextended('sales_invoice:' || id, 0))` membuat yang kedua
  menunggu. Saat dapat giliran, ia membaca isi yang sudah ditulis yang pertama, jadi perubahan tidak tercatat ganda.
  Pola kunci sama dengan `lib/kasir/hari.ts`.
- **Pengiriman ulang webhook** (502 → Accurate kirim ulang): isi lama sudah sama dengan yang baru, jadi tidak ada baris baru.
- **Beban tambahan:** satu `SELECT raw_data` lewat primary key per webhook (±1.800 per hari). Tidak ada pindaian tabel.
- **Pengerasan (tinjauan 24 Okt):** transaksi dipaku `READ COMMITTED` (SELECT sesudah kunci melihat commit pemegang sebelumnya);
  INSERT perubahan memakai `SET LOCAL lock_timeout = '2s'` di savepoint, supaya kunci/DDL kelak pada tabel perubahan tidak membuat
  webhook menunggu sampai `statement_timeout` sambil memegang baris `sales_invoice`. Log galat hanya memuat pesan Postgres, tanpa
  parameter INSERT (data pelanggan).
- **Batas yang diketahui:**
  - `detail.do` diambil SEBELUM kunci. Bila panggilan A mengambil versi V1, lalu B mengambil V2 dan commit lebih dulu, A mencatat
    perubahan semu V2 → V1 dan menulis V1 ke cache (cache basi ini sudah terjadi sebelum fitur ini; baris semunya baru). Butuh
    suntingan nyata dalam ±1 detik dari pengambilan serentak, jadi jarang; `detail.do` tidak membawa `lastUpdate`, jadi tidak ada
    penjaga versi yang murah.
  - Selisih selalu = isi cache vs `detail.do` terkini, dicatat atas nama event yang lebih dulu diproses. Dua simpan beruntun, atau event yang terlambat/dikirim ulang, bisa membawa `app_key`/`saved_at` event lain (termasuk dua event satu faktur dalam satu amplop).

## 9. Cara membaca

```sql
-- Semua koreksi barang tertentu, terbaru dulu
SELECT invoice_number, trans_date, kind, old_line->>'qty' AS qty_lama, new_line->>'qty' AS qty_baru,
       base_qty_delta, CASE WHEN app_key = '' THEN 'manusia' WHEN app_key IS NULL THEN '?' ELSE 'aplikasi' END AS oleh,
       saved_at AT TIME ZONE 'Asia/Makassar' AS disimpan_wita, after_print
FROM sales_invoice_line_change WHERE item_no = 'K1102007000110' ORDER BY detected_at DESC;

-- Dampak koreksi sesudah cetak ke stok Accurate, per barang
SELECT item_no, sum(base_qty_delta) FROM sales_invoice_line_change WHERE after_print GROUP BY item_no;
```

Catatan membaca `invoice_deleted`: faktur yang dihapus lalu dibuat ulang dengan nomor sama mendapat id baru, dan isi faktur baru
itu TIDAK tercatat sebagai `added` (faktur baru pertama kali terbaca tanpa isi lama). Penjumlahan dampak stok yang memasukkan
`invoice_deleted` akan berlebih ke arah negatif untuk kasus itu — cocokkan nomor faktur yang masih hidup, atau pisahkan per `kind`.

## 10. Uji

- **`lib/sales-invoice-change.test.ts`** (`tsx --test`, ikut `npm test`). Fungsi murni dengan data contoh generik
  (BARANG A/B, PELANGGAN A):
  - Satu baris dihapus, satu ditambah.
  - qty berubah (bentuk CS00399: 72 → 6, rasio 1).
  - Satuan berubah KRT → PCS dengan qty dasar sama: tercatat `changed`, `base_qty_delta` = 0.
  - Hanya `deliveredQuantity` / salesman yang berubah → tidak ada baris.
  - `raw_data` lama tanpa `detailItem` → tidak ada baris.
  - Nomor `DFT.*` → tidak ada baris.
  - Faktur dihapus → semua baris `invoice_deleted` dengan delta negatif.
  - `after_print` benar/salah berdasarkan `printedTimeView` vs `saved_at`.
  - `salesInvoiceEvents`: `appKey` ada/tidak, `timestamp` WIB → instan UTC yang benar.
- **`lib/sales-invoice-change-pg.test.ts`** (Postgres evaluasi `AM040_DATABASE_URL`, skema sekali-pakai, dilewati tanpa env; pola
  `lib/supervisor-review/supervisor-review-pg.test.ts`). `detail.do` dipalsukan lewat `globalThis.fetch`:
  - Dua kali `upsertSalesInvoiceById` (72 lalu 6) → satu baris `changed`. Panggilan ketiga dengan isi sama → tetap satu.
  - Tabel perubahan TIDAK ada → cache tetap diperbarui, tidak melempar.
  - Faktur tiada → baris `invoice_deleted` + cache terhapus.
  - Dua panggilan bersamaan → tidak ganda.
  - Migrasi 0037 = entri migrate-pg = Drizzle; dijalankan 2× idempoten.
- **Gerbang (24 Okt):** `npm run lint` 0 error, `npx tsc --noEmit` 0, `npm run build` 0. `npm test` dengan Postgres evaluasi: 1.273 uji, 34 gagal — empat berkas yang sama gagal 34 juga di `origin/main` tanpa perubahan (lingkungan DB evaluasi), jadi bukan dari cabang ini. Uji fitur ini: 26 murni + 5 PG + Supervisor Review 7, semuanya lulus, 0 dilewati.

## 11. Temuan sampingan (bukan bagian spec ini)

`parseAccurateDateTime` ([lib/accurate-invoice.ts](../../../lib/accurate-invoice.ts)) membaca semua tanggal Accurate sebagai `+07:00`.
Itu benar untuk `timestamp` webhook dan `createDate`, tetapi `lastUpdate` dari `list.do` ternyata WITA. Akibatnya
`sales_invoice.last_update_at` maju 1 jam dari kenyataan (CS00399: tersimpan 07:49Z, sebenarnya 06:49Z). Perbaikannya tugas terpisah.
