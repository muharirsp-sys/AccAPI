// Tujuan: Migrasi Postgres yang ADITIF dan idempoten, dijalankan otomatis saat container start.
// Caller: Dockerfile.frontend CMD, sebelum `node server.js`. Bisa juga `node scripts/migrate-pg.mjs`.
// Dependensi: pg (sudah dependency runtime lewat lib/db).
// Main Functions: jalankan daftar DDL berurutan, laporkan yang berubah.
// Side Effects: DDL pada database di DATABASE_URL.
//
// Kenapa ada: skema Postgres dibuat lewat `drizzle-kit push` saat cutover D4, dan sejak itu
// setiap kolom baru jadi langkah manual `docker exec ... psql` di VPS yang gampang terlewat —
// kode sudah ter-deploy sementara kolomnya belum ada, dan errornya baru muncul saat dipakai.
// File ini menutup celah itu untuk perubahan yang aman diulang.
//
// ATURAN ISI DAFTAR — hanya perubahan yang aman dijalankan berkali-kali dan tidak bisa
// menghilangkan data:
//   BOLEH : ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE TABLE IF NOT EXISTS
//   JANGAN: DROP apa pun, ALTER TYPE, NOT NULL pada tabel berisi, UPDATE/DELETE data.
// Yang tidak boleh di sini tetap lewat DDL manual di docs/handover/ supaya ada yang menekan
// tombolnya secara sadar dan bisa memeriksa hasilnya baris per baris.

import { pathToFileURL } from "node:url";
import { Pool } from "pg";

// Diekspor agar uji Postgres (lib/invoice-outbox-event.test.ts) menjalankan SQL entri yang SAMA
// persis; eksekusi hanya bila berkas ini dijalankan langsung (`node scripts/migrate-pg.mjs`).
/** @type {{ nama: string, sudahAda: string, sql: string }[]} */
export const migrations = [
  {
    // 2026-08-29. Deteksi kandidat "Gabung Kode Sales" hanya bisa membaca nama dari
    // sales_targets, jadi kode yang punya penjualan tapi belum punya target sampai ke sana
    // sebagai kode telanjang dan pasangan satu-orang-dua-rute tidak pernah terbentuk.
    // Kasus nyata: target BASRI YUSUF di M-BSR, penjualannya di M-BSR2.
    nama: "sales_daily_progress.sales_name",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'sales_daily_progress' AND column_name = 'sales_name'`,
    sql: "ALTER TABLE sales_daily_progress ADD COLUMN IF NOT EXISTS sales_name TEXT",
  },
  {
    // 2026-08-31. Tabel penyimpanan rekonsiliasi (db/migrations/0001_reconciliation_storage.sql)
    // dibuat setelah cutover D4 lewat `drizzle-kit push` yang tidak pernah kena prod, jadi
    // GET /api/reconciliation/{mappings,history} error `relation ... does not exist`.
    // Versi IF NOT EXISTS ini menutup celahnya secara idempoten saat container start.
    nama: "reconciliation storage",
    sudahAda: `SELECT 1 FROM information_schema.tables
               WHERE table_name IN ('reconciliation_mapping_version', 'reconciliation_run')
               GROUP BY 1 HAVING count(*) = 2`,
    sql: `
      CREATE TABLE IF NOT EXISTS reconciliation_mapping_version (
          id text PRIMARY KEY,
          division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
          principal_code text NOT NULL,
          version integer NOT NULL CHECK (version > 0),
          original_name text NOT NULL,
          mime_type text NOT NULL,
          byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
          sha256 text NOT NULL CHECK (length(sha256) = 64),
          workbook bytea NOT NULL,
          uploaded_by text NOT NULL,
          uploaded_by_name text NOT NULL,
          uploaded_by_email text NOT NULL,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamp NOT NULL,
          UNIQUE (division, principal_code, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_mapping_version_active_idx
          ON reconciliation_mapping_version (division, principal_code)
          WHERE is_active = true;
      CREATE INDEX IF NOT EXISTS reconciliation_mapping_version_lookup_idx
          ON reconciliation_mapping_version (division, principal_code, created_at);
      CREATE TABLE IF NOT EXISTS reconciliation_run (
          id text PRIMARY KEY,
          division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
          principal_code text NOT NULL,
          mapping_version_id text NOT NULL REFERENCES reconciliation_mapping_version(id) ON DELETE RESTRICT,
          status text NOT NULL CHECK (status IN ('processing', 'success', 'failed')),
          uploaded_by text NOT NULL,
          uploaded_by_name text NOT NULL,
          uploaded_by_email text NOT NULL,
          input_files jsonb NOT NULL,
          summary jsonb,
          issues jsonb,
          error text,
          duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
          started_at timestamp NOT NULL,
          finished_at timestamp
      );
      CREATE INDEX IF NOT EXISTS reconciliation_run_lookup_idx
          ON reconciliation_run (division, principal_code, started_at);
      CREATE INDEX IF NOT EXISTS reconciliation_run_uploader_idx
          ON reconciliation_run (uploaded_by, started_at);
      CREATE INDEX IF NOT EXISTS reconciliation_run_mapping_version_idx
          ON reconciliation_run (mapping_version_id);
    `,
  },
  {
    // 2026-09-17. Modul Master Barang akhirnya tersambung (PR #79). Tanpa entri ini tabelnya
    // TIDAK PERNAH dibuat di produksi: `db/migrations/*.sql` bukan yang dibaca runner ini,
    // dan skema Postgres dibuat lewat `drizzle-kit push` yang tidak ikut deploy. Halaman
    // /master-barang akan gagal saat dibuka, dan modul ini prasyarat untuk membuat master
    // principal baru -- lihat db/migrations/0019_master_barang.sql untuk penjelasan bentuknya.
    nama: "master_barang (+source, +audit)",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'master_barang'`,
    sql: `
      CREATE TABLE IF NOT EXISTS master_barang (
          id                  text PRIMARY KEY,
          principle_code      text NOT NULL,
          principle_name      text NOT NULL,
          principle_name_norm text NOT NULL,
          status              text NOT NULL DEFAULT 'draft',
          revision            integer NOT NULL DEFAULT 1,
          revision_hash       text NOT NULL DEFAULT '',
          source_items        jsonb NOT NULL DEFAULT '[]'::jsonb,
          codebook            jsonb NOT NULL DEFAULT '[]'::jsonb,
          form_rows           jsonb NOT NULL DEFAULT '[]'::jsonb,
          qc                  jsonb NOT NULL DEFAULT '{}'::jsonb,
          confirmation_state  jsonb NOT NULL DEFAULT '{}'::jsonb,
          legacy_file_name    text,
          created_by          text NOT NULL,
          created_at          timestamp NOT NULL,
          updated_at          timestamp NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_master_barang_principle_norm ON master_barang (principle_name_norm);
      CREATE INDEX IF NOT EXISTS idx_master_barang_updated_at ON master_barang (updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_master_barang_legacy_file ON master_barang (legacy_file_name);

      CREATE TABLE IF NOT EXISTS master_barang_source (
          id           text PRIMARY KEY,
          master_id    text NOT NULL REFERENCES master_barang(id) ON DELETE CASCADE,
          file_name    text NOT NULL,
          mime_type    text NOT NULL,
          file_size    integer NOT NULL,
          sha256       text NOT NULL,
          storage_path text NOT NULL,
          source_kind  text NOT NULL,
          extraction   jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by   text NOT NULL,
          created_at   timestamp NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_master_barang_source_master_created ON master_barang_source (master_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_master_barang_source_sha ON master_barang_source (master_id, sha256);

      CREATE TABLE IF NOT EXISTS master_barang_audit (
          id         text PRIMARY KEY,
          master_id  text NOT NULL REFERENCES master_barang(id) ON DELETE CASCADE,
          actor_id   text NOT NULL,
          action     text NOT NULL,
          detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamp NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_master_barang_audit_master_created ON master_barang_audit (master_id, created_at);
    `,
  },
  {
    // 2026-09-24. Menu Normalisasi Diskon: keputusan pengguna atas potongan tak bertuan pada
    // faktur Accurate yang dibuat di luar web. Lihat db/migrations/0022_discount_normalization.sql.
    nama: "discount_normalization",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'discount_normalization'`,
    sql: `
      CREATE TABLE IF NOT EXISTS discount_normalization (
          line_key    text NOT NULL,
          positions   text NOT NULL,
          bucket      text NOT NULL CHECK (bucket IN ('principal', 'distributor')),
          amount      numeric(18,2) NOT NULL,
          percent     numeric(9,4) NOT NULL DEFAULT 0,
          invoice_no  text NOT NULL DEFAULT '',
          invoice_id  text NOT NULL DEFAULT '',
          trans_date  date,
          customer_no text NOT NULL DEFAULT '',
          item_code   text NOT NULL DEFAULT '',
          note        text NOT NULL DEFAULT '',
          decided_by  text NOT NULL DEFAULT '',
          decided_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (line_key, positions)
      );
      CREATE INDEX IF NOT EXISTS idx_discount_normalization_date ON discount_normalization (trans_date);
    `,
  },
  {
    // 2026-09-25. Aturan "hanya PO pertama" (surat listing BP2609008707). Lihat
    // db/migrations/0023_promo_rule_first_po.sql. ADD COLUMN dengan DEFAULT: baris lama terisi
    // false seketika, jadi NOT NULL-nya aman pada tabel berisi (bukan SET NOT NULL belakangan).
    nama: "promo_rule.first_po",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'promo_rule' AND column_name = 'first_po'`,
    sql: "ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS first_po boolean NOT NULL DEFAULT false",
  },
  {
    // 2026-09-28. Penjelasan selisih verifikasi balik (sales diganti / isi dikoreksi saat
    // pengiriman). Lihat db/migrations/0024_invoice_verify_note.sql.
    nama: "invoice_verify_note",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'invoice_verify_note'`,
    sql: `
      CREATE TABLE IF NOT EXISTS invoice_verify_note (
          order_id   text NOT NULL,
          jenis      text NOT NULL CHECK (jenis IN ('sales', 'isi')),
          sidik      text NOT NULL,
          note       text NOT NULL DEFAULT '',
          decided_by text NOT NULL DEFAULT '',
          decided_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (order_id, jenis)
      );
    `,
  },
  {
    // 2026-10-01. Normalisasi Diskon wajib menyebut aturan promo dasarnya. Kolom NULL-able:
    // baris lama tetap ada, tetapi rekap tidak memakainya. Lihat db/migrations/0025_discount_normalization_rule.sql.
    nama: "discount_normalization.promo_rule_id",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'discount_normalization' AND column_name = 'promo_rule_id'`,
    sql: "ALTER TABLE discount_normalization ADD COLUMN IF NOT EXISTS promo_rule_id bigint",
  },
  {
    // 2026-10-02. Rujukan utama keputusan normalisasi = kunci alami aturan, bukan id: impor
    // Summary/Excel mengganti id aturan. Lihat db/migrations/0025_discount_normalization_rule.sql.
    nama: "discount_normalization.promo_rule_key",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'discount_normalization' AND column_name = 'promo_rule_key'`,
    sql: "ALTER TABLE discount_normalization ADD COLUMN IF NOT EXISTS promo_rule_key text",
  },
  {
    // 2026-10-08. Templat No Claim per principal yang diubah dari bawaan kode (S4b).
    // Lihat db/migrations/0026_no_claim_template.sql.
    nama: "no_claim_template",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'no_claim_template'`,
    sql: `
      CREATE TABLE IF NOT EXISTS no_claim_template (
          principle_code text NOT NULL,
          variant_key    text NOT NULL DEFAULT '',
          label          text NOT NULL,
          pattern        text NOT NULL,
          pad_width      integer,
          sequence_type  text NOT NULL DEFAULT 'number' CHECK (sequence_type IN ('number', 'text', 'roman')),
          updated_by     text,
          updated_at     timestamp NOT NULL,
          PRIMARY KEY (principle_code, variant_key)
      );
    `,
  },
  {
    // 2026-10-08. Jejak ubah/kembalikan templat No Claim (nilai lama -> baru + pelaku).
    nama: "no_claim_template_log",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'no_claim_template_log'`,
    sql: `
      CREATE TABLE IF NOT EXISTS no_claim_template_log (
          id             bigserial PRIMARY KEY,
          principle_code text NOT NULL,
          variant_key    text NOT NULL DEFAULT '',
          action         text NOT NULL CHECK (action IN ('set', 'reset')),
          before         jsonb,
          after          jsonb,
          actor          text,
          created_at     timestamp NOT NULL
      );
    `,
  },
  {
    // 2026-09-29 (AM-014 / C.12, DRAFT — zona Accurate write, butuh review manusia). Klaim
    // attempt tulis Accurate SEBELUM kirim: satu attempt hidup per operation × subject lewat
    // unique partial index, sehingga reload / dua tab / dua user tidak bisa mengirim dua kali.
    // Role aplikasi butuh SELECT/INSERT/UPDATE (default privileges runbook L1g — cek sebelum deploy).
    // 2026-10-08 (C14, owner): langsung BENTUK FINAL ADR-004 rev 3.1 rilis A — produksi belum punya tabel ini,
    // jadi ini pembuatan pertama (generasi + reopen_id + CHECK, UNIQUE identitas, index hidup per generasi).
    // DB evaluasi berdefinisi lama (index 2 kolom) TIDAK diubah di sini: docs/handover/DDL_ADR004.sql dulu (tukar index).
    nama: "accurate_write_attempt",
    // Cek INDEX, bukan tabel: tabel tanpa unique partial index = klaim ganda diam-diam.
    sudahAda: `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_accurate_write_attempt_live'`,
    sql: `
      CREATE TABLE IF NOT EXISTS accurate_write_attempt (
          id              text PRIMARY KEY,
          operation       text NOT NULL,
          subject_key     text NOT NULL,
          client_ref      text NOT NULL DEFAULT '',
          target_db_id    text NOT NULL,
          payload_hash    text NOT NULL,
          actor           text NOT NULL,
          state           text NOT NULL,
          outcome         jsonb NOT NULL DEFAULT '{}'::jsonb,
          accurate_id     text NOT NULL DEFAULT '',
          accurate_number text NOT NULL DEFAULT '',
          resolution      jsonb,
          generation      integer NOT NULL DEFAULT 0,
          reopen_id       text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_accurate_write_attempt_identity UNIQUE (id, operation, subject_key, generation, target_db_id),
          CONSTRAINT accurate_write_attempt_state
              CHECK (state IN ('sending', 'posted', 'rejected', 'unknown', 'not_sent', 'resolved_absent')),
          CONSTRAINT accurate_write_attempt_generation CHECK (generation >= 0),
          CONSTRAINT accurate_write_attempt_reopen_gen CHECK ((generation = 0) = (reopen_id IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_accurate_write_attempt_live
          ON accurate_write_attempt (operation, subject_key, generation)
          WHERE state IN ('sending', 'posted', 'unknown');
    `,
  },
  {
    // 2026-10-08 (C14, ADR-004 rev 3.1 rilis A): catatan reopen immutable untuk repost D-15. Tabel saja — tidak ada
    // route yang menulisnya sampai rilis B. FK ke kunci identitas attempt INLINE (operasi yang diizinkan berkas ini).
    // FK balik attempt->reopen (melingkar), trigger immutability & REVOKE = docs/handover/DDL_ADR004.sql (IT Support saat deploy, O5), BUKAN di sini.
    nama: "accurate_write_attempt_reopen",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'accurate_write_attempt_reopen'`,
    sql: `
      CREATE TABLE IF NOT EXISTS accurate_write_attempt_reopen (
          id                  text PRIMARY KEY,
          operation           text NOT NULL,
          subject_key         text NOT NULL,
          from_attempt_id     text NOT NULL,
          target_db_id        text NOT NULL,
          actor               text NOT NULL,
          from_generation     integer NOT NULL,
          to_generation       integer NOT NULL,
          old_accurate_id     text NOT NULL DEFAULT '',
          old_accurate_number text NOT NULL DEFAULT '',
          reason              text NOT NULL,
          checked_source      text NOT NULL,
          verification        jsonb NOT NULL,
          created_at          timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_accurate_write_attempt_reopen_generation UNIQUE (operation, subject_key, to_generation),
          CONSTRAINT uq_accurate_write_attempt_reopen_from UNIQUE (from_attempt_id),
          CONSTRAINT uq_accurate_write_attempt_reopen_identity UNIQUE (id, operation, subject_key, to_generation, target_db_id),
          CONSTRAINT fk_accurate_write_attempt_reopen_from
              FOREIGN KEY (from_attempt_id, operation, subject_key, from_generation, target_db_id)
              REFERENCES accurate_write_attempt (id, operation, subject_key, generation, target_db_id),
          CONSTRAINT accurate_write_attempt_reopen_from_generation CHECK (from_generation >= 0),
          CONSTRAINT accurate_write_attempt_reopen_to_generation CHECK (to_generation = from_generation + 1),
          CONSTRAINT accurate_write_attempt_reopen_old_ref CHECK (old_accurate_id <> '' OR old_accurate_number <> ''),
          CONSTRAINT accurate_write_attempt_reopen_reason CHECK (length(btrim(reason)) >= 15),
          CONSTRAINT accurate_write_attempt_reopen_checked_source CHECK (btrim(checked_source) <> ''),
          -- coalesce: tanpa itu '{}' lolos (CHECK bernilai NULL).
          CONSTRAINT accurate_write_attempt_reopen_verification
              CHECK (coalesce(verification->>'method', '') IN ('manual_attestation', 'provider_readback'))
      );
    `,
  },
  {
    // 2026-09-30 (AM-050 + AM-052, keputusan owner D-18; DRAFT — zona idempotency, butuh review manusia).
    // EXPAND saja: kolom nullable pemilik lock + tabel jejak override. Tanpa backfill, tanpa drop.
    // idempotency_log dibuat drizzle-kit push (tidak ada migrasi repo) — ALTER memakai IF NOT EXISTS.
    // Role aplikasi butuh SELECT/INSERT/UPDATE pada idempotency_override (runbook L1g).
    nama: "idempotency_lock_owner_override",
    sudahAda: `SELECT 1 FROM information_schema.columns c
               JOIN information_schema.tables t ON t.table_name = 'idempotency_override' AND t.table_schema = 'public'
               WHERE c.table_name = 'idempotency_log' AND c.column_name = 'lockedBy'`,
    sql: `
      ALTER TABLE idempotency_log ADD COLUMN IF NOT EXISTS "lockId" text;
      ALTER TABLE idempotency_log ADD COLUMN IF NOT EXISTS "lockedBy" text;
      CREATE TABLE IF NOT EXISTS idempotency_override (
          id              text PRIMARY KEY,
          lock_id         text NOT NULL,
          key             text NOT NULL,
          actor           text NOT NULL,
          reason          text NOT NULL,
          block_reason    text NOT NULL,
          previous_status text,
          action          text NOT NULL CONSTRAINT idempotency_override_action
                          CHECK (action IN ('takeover', 'resend_success', 'allow_duplicate')),
          consumed_at     timestamptz,
          created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_override_lock_key ON idempotency_override (lock_id, key);
    `,
  },
  {
    // 2026-09-30 (review e641e571 LOW): guard /api/proxy mencari idempotency_log per lockId.
    nama: "idempotency_log_lock_index",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_idempotency_log_lock'`,
    sql: `CREATE INDEX IF NOT EXISTS idx_idempotency_log_lock ON idempotency_log ("lockId");`,
  },
  {
    // 2026-10-10 (S6e-2 butir 2 & 5, keputusan orkestrator; DRAFT — zona idempotensi, butuh review manusia).
    // EXPAND saja: kolom nullable database Accurate di lock (baris lama NULL = "tidak tercatat") + tabel jejak Selesaikan.
    // Trigger anti-ubah + REVOKE UPDATE/DELETE/TRUNCATE = docs/handover/DDL_S6E2.sql (IT Support saat deploy), BUKAN di sini.
    // Role aplikasi butuh SELECT/INSERT pada idempotency_resolution (runbook L1g).
    nama: "idempotency_s6e2",
    sudahAda: `SELECT 1 FROM information_schema.columns c
               JOIN information_schema.tables t ON t.table_name = 'idempotency_resolution' AND t.table_schema = 'public'
               WHERE c.table_name = 'idempotency_log' AND c.column_name = 'databaseId'`,
    sql: `
      ALTER TABLE idempotency_log ADD COLUMN IF NOT EXISTS "databaseId" text;
      CREATE TABLE IF NOT EXISTS idempotency_resolution (
          id              text PRIMARY KEY,
          key             text NOT NULL,
          lock_id         text,
          previous_status text NOT NULL,
          decision        text NOT NULL,
          accurate_number text,
          database_id     text NOT NULL,
          checked_source  text NOT NULL,
          reason          text NOT NULL,
          actor           text NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT idempotency_resolution_decision CHECK (decision IN ('terposting', 'tidak_ada')),
          CONSTRAINT idempotency_resolution_reason CHECK (char_length(btrim(reason)) >= 15),
          CONSTRAINT idempotency_resolution_number CHECK (decision <> 'terposting' OR coalesce(btrim(accurate_number), '') <> ''),
          CONSTRAINT idempotency_resolution_source CHECK (btrim(checked_source) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_resolution_key ON idempotency_resolution (key);
    `,
  },
  {
    // 2026-10-11 (S6e-2a tinjauan B2; DRAFT — zona idempotensi, butuh review manusia). EXPAND: database Accurate lock juga
    // di override (lock yang hanya berisi override resend_success tidak punya baris idempotency_log). NULL = override lama
    // = "tidak tercatat" (proxy menolak). Entri TERPISAH dari `idempotency_s6e2` agar `sudahAda` entri itu tetap benar
    // untuk DB yang sudah menjalankannya; tabel idempotency_override dibuat entri `idempotency_lock_owner_override`.
    nama: "idempotency_override_database",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'idempotency_override' AND column_name = 'database_id'`,
    sql: `ALTER TABLE idempotency_override ADD COLUMN IF NOT EXISTS database_id text;`,
  },
  {
    // 2026-10-09 (S6-0d BL-17 + R6; DRAFT — zona Accurate write/idempotensi, butuh review manusia).
    // Riwayat antrean faktur APPEND-ONLY: satu baris per aksi/percobaan (antre, kirim + status HTTP
    // + potongan jawaban, buang, antre ulang, selesaikan, sapu). TANPA FK ke invoice_outbox —
    // Buang = DELETE baris antrean dan riwayatnya harus bertahan. invoice_outbox sendiri dipasang
    // manual (db/migrations/0004) dan tidak dibutuhkan untuk membuat tabel ini.
    // Role aplikasi butuh SELECT/INSERT + USAGE sequence (runbook L1g). Trigger anti-ubah + REVOKE
    // UPDATE/DELETE/TRUNCATE + E5 (data lama dikunci tidak pasti = UPDATE data, dilarang di berkas
    // ini) = docs/handover/DDL_OUTBOX_EVENT.sql (manual, IT Support saat deploy), BUKAN di sini.
    nama: "invoice_outbox_event",
    sudahAda: `SELECT 1 FROM information_schema.tables WHERE table_name = 'invoice_outbox_event'`,
    sql: `
      CREATE TABLE IF NOT EXISTS invoice_outbox_event (
          id               bigserial PRIMARY KEY,
          order_id         text NOT NULL,
          jenis            text NOT NULL,
          state_from       text,
          state_to         text,
          actor            text NOT NULL DEFAULT '',
          http_status      integer,
          response_excerpt text NOT NULL DEFAULT '',
          error_code       text NOT NULL DEFAULT '',
          reason           text NOT NULL DEFAULT '',
          detail           jsonb,
          created_at       timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT invoice_outbox_event_jenis CHECK (jenis IN
              ('antre', 'kirim', 'posted', 'rejected', 'unknown', 'buang', 'antre_ulang', 'selesaikan', 'sapu')),
          CONSTRAINT invoice_outbox_event_excerpt CHECK (length(response_excerpt) <= 500)
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_outbox_event_order ON invoice_outbox_event (order_id, created_at);
    `,
  },
  {
    // 2026-10-11 (S7-0 BL-64, owner 11 Okt: tabel resmi + alias; KINO NON FOOD / Forisa MT-GT / Heinz HZ-BS = VARIAN satu
    // principal; DRAFT — zona skema, butuh review manusia). Tabel saja: TANPA benih (S7-2 membuat laporan matched/ambiguous
    // dulu), tanpa pembaca. Lihat db/migrations/0027_principal.sql. Unik kode & alias = indeks terpisah agar entri ini bisa
    // melengkapi tabel yang ada tanpa indeksnya; sudahAda memeriksa SEMUA indeks (PK tersirat = tabel ada) + kolom bentuk baru.
    // Putaran tinjauan (B-SEDANG-1): alias ber-PK id + unik parsial per kelompok jenis; bentuk 893f8cbf -> DO $guard$ menolak.
    // (B-SEDANG-2): principal_variant.name + is_active lewat ADD COLUMN IF NOT EXISTS (aditif, DB lama ikut lengkap).
    // (B-SEDANG-3): trigger "principal.code tetap" TIDAK di sini (pola repo: trigger/REVOKE = DDL manual) — ada di
    // docs/handover/DDL_S7_0.sql; jalur DATABASE_MIGRATION_URL saja = tanpa trigger & GRANT, jadi DDL tetap wajib dijalankan.
    nama: "principal (+variant, +alias)",
    sudahAda: `SELECT 1 WHERE (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN
                   ('uq_principal_code', 'principal_variant_pkey', 'principal_alias_pkey', 'idx_principal_alias_principal',
                    'uq_principal_alias_kode_mb', 'uq_principal_alias_nama')) = 6
               AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
                   AND (table_name, column_name) IN (('principal_alias', 'id'), ('principal_variant', 'name'),
                                                     ('principal_variant', 'is_active'))) = 3`,
    sql: `
      -- Bentuk 893f8cbf (PK alias_norm, tanpa kolom id; hanya pernah ada di DB evaluasi) tidak bisa diubah secara aditif:
      -- berhenti jelas alih-alih diam-diam mempertahankan PK global. docs/handover/DDL_S7_0.sql mengubahnya (tabel kosong).
      DO $guard$
      BEGIN
          IF to_regclass('principal_alias') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'principal_alias' AND column_name = 'id') THEN
              RAISE EXCEPTION 'S7-0: principal_alias berbentuk lama 893f8cbf (PK alias_norm) — jalankan docs/handover/DDL_S7_0.sql';
          END IF;
      END $guard$;
      CREATE TABLE IF NOT EXISTS principal (
          id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          code       text NOT NULL,
          name       text NOT NULL,
          is_active  boolean NOT NULL DEFAULT true,
          created_by text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT principal_code_format CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
          CONSTRAINT principal_name_isi CHECK (btrim(name) <> '')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_code ON principal (code);
      CREATE TABLE IF NOT EXISTS principal_variant (
          principal_id text NOT NULL,
          variant_key  text NOT NULL DEFAULT '',
          created_by   text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT principal_variant_pkey PRIMARY KEY (principal_id, variant_key),
          CONSTRAINT principal_variant_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
          CONSTRAINT principal_variant_key_format CHECK (variant_key ~ '^[A-Z0-9_-]{0,20}$')
      );
      -- B-SEDANG-2: nama tampilan varian (opsional, mis. "KINO NON FOOD") + aktif. ALTER (bukan kolom CREATE TABLE) agar DB
      -- yang sudah punya tabel varian bentuk 893f8cbf ikut lengkap dan urutan kolom sama di semua jalur.
      ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS name text;
      ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
      -- Aturan kanonik varian (B-RENDAH; lintas baris -> tidak bisa CHECK, DITEGAKKAN S7-2 saat benih/tulis): alias untuk principal
      -- UTUH = variant_key NULL (bukan ''); varian '' hanya "varian dasar" pada principal yang JUGA punya varian lain (KINO '' vs
      -- NON_FOOD); principal tanpa varian lain tidak punya baris varian ''. no_claim_template.variant_key '' = principal utuh.
      -- alias_norm = bentuk normal normalizer S7-2 (CHECK): HURUF BESAR, tanpa spasi tepi, spasi tunggal (tanda baca bebas).
      CREATE TABLE IF NOT EXISTS principal_alias (
          id           text NOT NULL DEFAULT gen_random_uuid()::text,
          alias_norm   text NOT NULL,
          principal_id text NOT NULL,
          variant_key  text,
          alias_asli   text NOT NULL,
          jenis        text NOT NULL,
          sumber       text NOT NULL,
          created_by   text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT principal_alias_pkey PRIMARY KEY (id),
          CONSTRAINT principal_alias_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
          CONSTRAINT principal_alias_variant_fk FOREIGN KEY (principal_id, variant_key)
              REFERENCES principal_variant (principal_id, variant_key) ON DELETE RESTRICT,
          CONSTRAINT principal_alias_norm_bentuk CHECK (alias_norm = upper(alias_norm) AND alias_norm ~ '^[^[:space:]]+( [^[:space:]]+)*$'),
          CONSTRAINT principal_alias_asli_isi CHECK (btrim(alias_asli) <> ''),
          CONSTRAINT principal_alias_sumber_isi CHECK (btrim(sumber) <> ''),
          CONSTRAINT principal_alias_jenis CHECK (jenis IN
              ('nama', 'kode_master_barang', 'label_mapping', 'nama_bank', 'nama_summary', 'nama_surat'))
      );
      -- Unik per kelompok (B-SEDANG-1): kode Master Barang 2 karakter terpisah dari nama/label/kode OPC. Tabrakan nama yang
      -- sah tetap DITOLAK (masuk laporan ambiguous S7-2) — JANGAN PERNAH ON CONFLICT DO UPDATE (alias diam-diam pindah principal).
      CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_kode_mb ON principal_alias (alias_norm) WHERE jenis = 'kode_master_barang';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_nama ON principal_alias (alias_norm) WHERE jenis <> 'kode_master_barang';
      CREATE INDEX IF NOT EXISTS idx_principal_alias_principal ON principal_alias (principal_id, variant_key);
    `,
  },
  {
    // 2026-10-11 (S7-0 BL-63, owner 11 Okt: BINTANG grup utama, opsional; DRAFT — zona skema, butuh review manusia).
    // ADD COLUMN dengan DEFAULT: baris lama false seketika (tanpa rewrite). Satu bintang per user = indeks unik parsial.
    // TANPA backfill di sini: "user tepat 1 grup -> berbintang" = bagian BACKFILL docs/handover/DDL_S7_0.sql (manual).
    // Lihat db/migrations/0028_user_group_primary.sql. Indeks tersirat kolom ada -> sudahAda cukup memeriksa indeks.
    nama: "user_group.is_primary",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_user_group_primary'`,
    sql: `
      ALTER TABLE user_group ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_group_primary ON user_group (user_id) WHERE is_primary;
    `,
  },
  {
    // 2026-10-11 (K1a BL-59 Kasir ↔ Incaso, owner 11 Okt: per ORANG per hari, Tunai+Transfer+Giro lawan chequeAmount, kunci 20.00
    // WITA; DRAFT — zona uang + skema, butuh review manusia). Tabel baru saja (tanpa data). Lihat db/migrations/0029_kasir.sql.
    // Trigger append-only + REVOKE/GRANT (setoran, catatan, event) TIDAK di sini (pola repo) — docs/handover/DDL_K1A.sql WAJIB
    // dijalankan (juga bila DATABASE_MIGRATION_URL terpasang). sudahAda = SEMUA 11 indeks (PK + unik revisi + indeks baca) ada.
    // T2 (owner 11 Okt): uang tak teralokasi wajib dijelaskan sebelum Tutup -> kasir_tak_teralokasi_catatan + CHECK tutup_tuntas.
    nama: "kasir (setoran, catatan, hari, cache pelunasan)",
    sudahAda: `SELECT 1 WHERE (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN
                   ('kasir_setoran_pkey', 'uq_kasir_setoran_revisi', 'kasir_selisih_catatan_pkey', 'idx_kasir_selisih_catatan_hari',
                    'kasir_hari_event_pkey', 'idx_kasir_hari_event_tanggal', 'kasir_pelunasan_pkey', 'idx_kasir_pelunasan_tanggal',
                    'kasir_pelunasan_faktur_pkey', 'kasir_tak_teralokasi_catatan_pkey', 'idx_kasir_tak_teralokasi_catatan_hari')) = 11`,
    sql: `
      CREATE TABLE IF NOT EXISTS kasir_setoran (
          id                bigserial PRIMARY KEY,
          tanggal           date NOT NULL,
          salesman_kode     text NOT NULL,
          revisi            integer NOT NULL,
          revisi_sebelumnya integer,
          tunai             numeric(18,2) NOT NULL,
          transfer          numeric(18,2) NOT NULL,
          giro              numeric(18,2) NOT NULL,
          no_form_kasir     text,
          bukti_transfer    text,
          catatan           text,
          dicatat_oleh      text NOT NULL,
          dicatat_pada      timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_kasir_setoran_revisi UNIQUE (tanggal, salesman_kode, revisi),
          CONSTRAINT kasir_setoran_revisi_sebelumnya_fk FOREIGN KEY (tanggal, salesman_kode, revisi_sebelumnya)
              REFERENCES kasir_setoran (tanggal, salesman_kode, revisi),
          CONSTRAINT kasir_setoran_rantai CHECK (revisi >= 1 AND revisi_sebelumnya IS NOT DISTINCT FROM nullif(revisi - 1, 0)),
          CONSTRAINT kasir_setoran_nominal CHECK (tunai >= 0 AND transfer >= 0 AND giro >= 0),
          CONSTRAINT kasir_setoran_kode CHECK (salesman_kode <> '' AND salesman_kode = btrim(salesman_kode)),
          CONSTRAINT kasir_setoran_teks CHECK (btrim(coalesce(no_form_kasir, '-')) <> '' AND btrim(coalesce(bukti_transfer, '-')) <> ''
              AND btrim(coalesce(catatan, '-')) <> ''),
          CONSTRAINT kasir_setoran_oleh CHECK (btrim(dicatat_oleh) <> '')
      );
      CREATE TABLE IF NOT EXISTS kasir_selisih_catatan (
          id            bigserial PRIMARY KEY,
          tanggal       date NOT NULL,
          salesman_kode text NOT NULL,
          pelunasan     numeric(18,2) NOT NULL,
          setoran       numeric(18,2) NOT NULL,
          penjelasan    text NOT NULL,
          tindak_lanjut text NOT NULL,
          dicatat_oleh  text NOT NULL,
          dicatat_pada  timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT kasir_selisih_catatan_kode CHECK (salesman_kode = btrim(salesman_kode)),
          CONSTRAINT kasir_selisih_catatan_setoran CHECK (setoran >= 0),
          CONSTRAINT kasir_selisih_catatan_penjelasan CHECK (char_length(btrim(penjelasan)) >= 15),
          CONSTRAINT kasir_selisih_catatan_tindak_lanjut CHECK (tindak_lanjut IN ('setor_susulan', 'koreksi_incaso', 'lapor_om')),
          CONSTRAINT kasir_selisih_catatan_oleh CHECK (btrim(dicatat_oleh) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_kasir_selisih_catatan_hari ON kasir_selisih_catatan (tanggal, salesman_kode);
      CREATE TABLE IF NOT EXISTS kasir_hari_event (
          id       bigserial PRIMARY KEY,
          tanggal  date NOT NULL,
          jenis    text NOT NULL,
          alasan   text,
          snapshot jsonb,
          oleh     text NOT NULL,
          pada     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT kasir_hari_event_jenis CHECK (jenis IN ('tutup', 'kunci', 'buka')),
          CONSTRAINT kasir_hari_event_alasan_buka CHECK (jenis <> 'buka' OR char_length(btrim(coalesce(alasan, ''))) >= 15),
          CONSTRAINT kasir_hari_event_snapshot CHECK ((jenis = 'buka') = (snapshot IS NULL)
              AND (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object')),
          CONSTRAINT kasir_hari_event_tutup_tuntas CHECK (jenis <> 'tutup' OR coalesce(snapshot -> 'terhalang', 'null'::jsonb) = '[]'::jsonb),
          CONSTRAINT kasir_hari_event_oleh CHECK (btrim(oleh) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_kasir_hari_event_tanggal ON kasir_hari_event (tanggal, id);
      CREATE TABLE IF NOT EXISTS kasir_tak_teralokasi_catatan (
          id           bigserial PRIMARY KEY,
          tanggal      date NOT NULL,
          database_id  text NOT NULL,
          pelunasan_id bigint NOT NULL,
          sisa         numeric(18,2) NOT NULL,
          penjelasan   text NOT NULL,
          dicatat_oleh text NOT NULL,
          dicatat_pada timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT kasir_tak_teralokasi_catatan_database CHECK (btrim(database_id) <> ''),
          CONSTRAINT kasir_tak_teralokasi_catatan_sisa CHECK (sisa <> 0),
          CONSTRAINT kasir_tak_teralokasi_catatan_penjelasan CHECK (char_length(btrim(penjelasan)) >= 15),
          CONSTRAINT kasir_tak_teralokasi_catatan_oleh CHECK (btrim(dicatat_oleh) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_kasir_tak_teralokasi_catatan_hari ON kasir_tak_teralokasi_catatan (database_id, tanggal);
      CREATE TABLE IF NOT EXISTS kasir_pelunasan (
          database_id   text NOT NULL,
          pelunasan_id  bigint NOT NULL,
          nomor         text NOT NULL,
          tanggal       date NOT NULL,
          metode        text NOT NULL,
          cheque_amount numeric(18,2) NOT NULL,
          last_update   text,
          dibaca_pada   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT kasir_pelunasan_pkey PRIMARY KEY (database_id, pelunasan_id),
          CONSTRAINT kasir_pelunasan_isi CHECK (btrim(database_id) <> '' AND btrim(nomor) <> '' AND btrim(metode) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_kasir_pelunasan_tanggal ON kasir_pelunasan (database_id, tanggal);
      CREATE TABLE IF NOT EXISTS kasir_pelunasan_faktur (
          database_id        text NOT NULL,
          pelunasan_id       bigint NOT NULL,
          faktur_id          bigint NOT NULL,
          nomor_faktur       text,
          master_salesman_id bigint,
          invoice_payment    numeric(18,2) NOT NULL,
          CONSTRAINT kasir_pelunasan_faktur_pkey PRIMARY KEY (database_id, pelunasan_id, faktur_id),
          CONSTRAINT kasir_pelunasan_faktur_pelunasan_fk FOREIGN KEY (database_id, pelunasan_id)
              REFERENCES kasir_pelunasan (database_id, pelunasan_id) ON DELETE CASCADE
      );
    `,
  },
  {
    // 2026-10-11 (S7-2 BL-64; DRAFT — zona skema, butuh review manusia). Riwayat principal/varian/alias APPEND-ONLY, ditulis
    // dalam transaksi yang sama dengan perubahannya. EXPAND saja: tabel baru tanpa pembaca lama. Trigger tolak UPDATE/DELETE/
    // TRUNCATE + REVOKE + USAGE sequence = docs/handover/DDL_S7_2.sql (IT Support saat deploy), BUKAN di sini — jalur tulis
    // /api/principals menolak 503 bila trigger itu belum ada. sudahAda lewat pg_indexes (tidak bergantung hak, RENDAH S7-0).
    // Lihat db/migrations/0030_principal_log.sql.
    nama: "principal_log",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
               AND indexname IN ('principal_log_pkey', 'idx_principal_log_principal') HAVING count(*) = 2`,
    sql: `
      CREATE TABLE IF NOT EXISTS principal_log (
          id           bigserial PRIMARY KEY,
          entitas      text NOT NULL,
          kunci        text NOT NULL,
          principal_id text NOT NULL,
          aksi         text NOT NULL,
          before       jsonb,
          after        jsonb,
          aktor        text NOT NULL,
          waktu        timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT principal_log_entitas CHECK (entitas IN ('principal', 'varian', 'alias')),
          CONSTRAINT principal_log_aksi CHECK (aksi IN ('buat', 'aktif', 'nonaktif', 'hapus')),
          CONSTRAINT principal_log_aktor_isi CHECK (btrim(aktor) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_principal_log_principal ON principal_log (principal_id, id);
    `,
  },
  {
    // 2026-10-12 (K1b BL-59 pembaca pelunasan Accurate Kasir; DRAFT — zona uang + skema, butuh review manusia). Tabel baru saja
    // (tanpa data, tanpa trigger: cache). Hak accapi_app (SELECT/INSERT/UPDATE) = docs/handover/DDL_K1B.sql. Lihat
    // db/migrations/0031_kasir_baca.sql; SESUDAH entri principal_log (0030, S7-2 #160). ADD COLUMN = EXPAND KOLOM saja; CHECK sebab tabel versi
    // awal TIDAK diperluas (versi awal hanya di DB uji: DROP TABLE kasir_pelunasan_baca lalu jalankan ulang — tabel status, bukan data uang).
    nama: "kasir_pelunasan_baca (status baca K1b)",
    // sudahAda lewat katalog (pg_indexes + pg_attribute), BUKAN information_schema: tanpa hak tabel information_schema kosong ->
    // ALTER 42501 -> crash loop (tinjauan B putaran 2, pola S7-0).
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'kasir_pelunasan_baca_pkey'
               AND (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('kasir_pelunasan_baca') AND NOT attisdropped
                    AND attname IN ('akun_sinkron', 'penuh_tertunda_pada')) = 2`,
    sql: `
      CREATE TABLE IF NOT EXISTS kasir_pelunasan_baca (
          database_id   text NOT NULL,
          tanggal       date NOT NULL,
          status        text NOT NULL,
          sebab         text,
          pesan         text,
          jumlah_daftar integer,
          sisa_detail   integer,
          ditolak       jsonb NOT NULL DEFAULT '[]'::jsonb,
          token         text,
          mulai_pada    timestamptz NOT NULL DEFAULT now(),
          selesai_pada  timestamptz,
          lengkap_pada  timestamptz,
          pemicu        text NOT NULL,
          akun_sinkron  text,
          penuh_tertunda_pada timestamptz,
          CONSTRAINT kasir_pelunasan_baca_pkey PRIMARY KEY (database_id, tanggal),
          CONSTRAINT kasir_pelunasan_baca_status CHECK (status IN ('berjalan', 'lengkap', 'sebagian', 'gagal')),
          CONSTRAINT kasir_pelunasan_baca_sebab CHECK (sebab IS NULL OR sebab IN ('sesi_sinkron', 'hak_akses', 'batas_laju', 'accurate_5xx',
              'jaringan', 'tidak_pasti', 'ditolak', 'bentuk', 'nominal', 'terpotong', 'hapus_massal')),
          CONSTRAINT kasir_pelunasan_baca_isi CHECK (btrim(database_id) <> '' AND btrim(pemicu) <> '' AND jsonb_typeof(ditolak) = 'array'
              AND jumlah_daftar >= 0 AND sisa_detail >= 0 AND sisa_detail <= jumlah_daftar),
          CONSTRAINT kasir_pelunasan_baca_konsisten CHECK ((status = 'gagal') = (sebab IS NOT NULL)
              AND (status = 'berjalan') = (token IS NOT NULL) AND (status = 'berjalan') = (selesai_pada IS NULL)
              AND (status <> 'lengkap' OR (coalesce(sisa_detail, -1) = 0 AND jumlah_daftar IS NOT NULL
                  AND ditolak = '[]'::jsonb AND lengkap_pada IS NOT NULL)))
      );
      ALTER TABLE kasir_pelunasan_baca ADD COLUMN IF NOT EXISTS akun_sinkron text;
      ALTER TABLE kasir_pelunasan_baca ADD COLUMN IF NOT EXISTS penuh_tertunda_pada timestamptz;
    `,
  },
  {
    // 2026-10-12 (O1 order per cabang Accurate; DRAFT — zona skema + jalur order, butuh review manusia). EXPAND KOLOM saja pada tabel
    // lama (item, customer, sales_profile) — ALTER butuh role PEMILIK: tanpa DATABASE_MIGRATION_URL jalankan docs/handover/DDL_O1.sql
    // SEBELUM image (sesudahnya entri ini SKIP). sudahAda lewat pg_attribute (tanpa hak tabel information_schema kosong -> ALTER 42501 ->
    // crash loop). Putaran 1: + sales_profile.accurate_linked (tautan salesman dilepas tanpa menghapus profil Form Kontrol).
    // Lihat db/migrations/0033_order_cabang.sql.
    nama: "order cabang (item/customer/sales_profile O1)",
    sudahAda: `SELECT 1 WHERE (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('item') AND NOT attisdropped
                   AND attname IN ('branch_id', 'suspended', 'char_field2')) = 3
               AND (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('customer') AND NOT attisdropped
                   AND attname = 'suspended') = 1
               AND (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('sales_profile') AND NOT attisdropped
                   AND attname = 'accurate_linked') = 1`,
    sql: `
      ALTER TABLE item ADD COLUMN IF NOT EXISTS branch_id bigint;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS char_field2 text;
      ALTER TABLE customer ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
      ALTER TABLE sales_profile ADD COLUMN IF NOT EXISTS accurate_linked boolean NOT NULL DEFAULT false;
    `,
  },
  {
    // 2026-10-12 (FK-MSM2 kunjungan luar rute + konfirmasi masuk JKS; DRAFT — zona skema, butuh review manusia). Tabel BARU saja (EXPAND,
    // tanpa data/trigger/pembaca lama). CREATE butuh hak CREATE di skema: tanpa DATABASE_MIGRATION_URL jalankan docs/handover/DDL_FK_MSM2.sql
    // SEBELUM image (sesudahnya entri ini SKIP). Hak accapi_app (SELECT/INSERT/UPDATE, tanpa DELETE) HANYA di DDL itu. sudahAda lewat
    // katalog (pg_indexes + pg_attribute), bukan information_schema (tanpa hak tabel kosong -> CREATE 42501 -> crash loop).
    // Lihat db/migrations/0034_kunjungan_luar_rute.sql. 13 Okt: + batal lunak (dibatalkan_pada/oleh, UNIQUE parsial belum batal) — draf 12 Okt
    // tidak pernah dijalankan di produksi, jadi bentuk tabel diganti langsung (bukan migrasi baru).
    nama: "kunjungan_luar_rute (FK-MSM2)",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_klr_unik'
               AND (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('kunjungan_luar_rute') AND NOT attisdropped
                    AND attname IN ('konfirmasi', 'jks_id', 'dikonfirmasi_pada', 'dibatalkan_pada')) = 4`,
    sql: `
      CREATE TABLE IF NOT EXISTS kunjungan_luar_rute (
          id                     text PRIMARY KEY,
          sales_code             text NOT NULL,
          principle              text NOT NULL,
          tanggal                text NOT NULL,
          cust_code              text NOT NULL,
          cust_name              text NOT NULL,
          alamat                 text,
          customer_id            bigint,
          dibuat_oleh            text NOT NULL,
          dibuat_oleh_nama       text,
          dibuat_pada            timestamptz NOT NULL DEFAULT now(),
          konfirmasi             text NOT NULL DEFAULT 'menunggu',
          hari                   text,
          minggu_pattern         text,
          jks_id                 text,
          dikonfirmasi_oleh      text,
          dikonfirmasi_oleh_nama text,
          dikonfirmasi_pada      timestamptz,
          dibatalkan_pada        timestamptz,
          dibatalkan_oleh        text,
          CONSTRAINT kunjungan_luar_rute_konfirmasi CHECK (konfirmasi IN ('menunggu', 'jks', 'tidak', 'sudah_jks')),
          CONSTRAINT kunjungan_luar_rute_isi CHECK (btrim(sales_code) <> '' AND btrim(principle) <> '' AND btrim(cust_code) <> ''
              AND tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
          CONSTRAINT kunjungan_luar_rute_jadwal CHECK ((hari IS NULL OR hari IN ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'))
              AND (minggu_pattern IS NULL OR minggu_pattern IN ('ganjil', 'genap', 'all'))),
          CONSTRAINT kunjungan_luar_rute_jks CHECK (konfirmasi <> 'jks' OR (jks_id IS NOT NULL AND hari IS NOT NULL
              AND minggu_pattern IS NOT NULL AND dikonfirmasi_pada IS NOT NULL)),
          CONSTRAINT kunjungan_luar_rute_batal CHECK ((dibatalkan_pada IS NULL) = (dibatalkan_oleh IS NULL)
              AND (dibatalkan_pada IS NULL OR konfirmasi <> 'jks'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_klr_unik ON kunjungan_luar_rute (sales_code, cust_code, principle, tanggal) WHERE dibatalkan_pada IS NULL;
      CREATE INDEX IF NOT EXISTS idx_klr_jks ON kunjungan_luar_rute (jks_id);
    `,
  },
  {
    // 2026-10-13 (NOO toko baru dari kunjungan salesman; zona §3 skema + DATA PRIBADI — butuh review manusia). Tabel BARU saja (EXPAND).
    // CREATE butuh hak CREATE di skema: tanpa DATABASE_MIGRATION_URL jalankan docs/handover/DDL_NOO.sql SEBELUM image (sesudahnya entri ini
    // SKIP). Hak accapi_app (SELECT/INSERT/UPDATE, tanpa DELETE) HANYA di DDL itu. sudahAda lewat katalog (pg_indexes + pg_attribute).
    // SQL = db/migrations/0035_noo_toko.sql (uji lib/form-kontrol/noo-pg.test.ts membandingkan katalognya).
    nama: "noo_toko (NOO)",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_noo_customer'
               AND (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('noo_toko') AND NOT attisdropped
                    AND attname IN ('nik', 'foto_ktp', 'duplikat_dikonfirmasi', 'ditautkan_pada')) = 4`,
    sql: `
      CREATE TABLE IF NOT EXISTS noo_toko (
          id                    text PRIMARY KEY,
          kode                  text NOT NULL,
          sales_code            text NOT NULL,
          principle             text NOT NULL,
          branch_id             bigint NOT NULL,
          branch_name           text,
          tanggal               text NOT NULL,
          nama_toko             text NOT NULL,
          nama_pemilik          text NOT NULL,
          alamat                text NOT NULL,
          no_hp                 text NOT NULL,
          nik                   text NOT NULL,
          nama_ktp              text NOT NULL,
          foto_ktp              text NOT NULL,
          foto_toko             text NOT NULL,
          lat                   double precision NOT NULL,
          lng                   double precision NOT NULL,
          akurasi               double precision NOT NULL,
          gps_flag              text,
          status                text NOT NULL DEFAULT 'menunggu_spv',
          duplikat_dengan       text,
          alasan_duplikat       text,
          duplikat_dikonfirmasi boolean NOT NULL DEFAULT false,
          dibuat_oleh           text NOT NULL,
          dibuat_oleh_nama      text,
          dibuat_pada           timestamptz NOT NULL DEFAULT now(),
          diputuskan_oleh       text,
          diputuskan_oleh_nama  text,
          diputuskan_pada       timestamptz,
          alasan_tolak          text,
          customer_id           bigint,
          customer_no           text,
          ditautkan_oleh        text,
          ditautkan_oleh_nama   text,
          ditautkan_pada        timestamptz,
          CONSTRAINT noo_toko_status CHECK (status IN ('menunggu_spv', 'disetujui', 'ditolak', 'terdaftar')),
          CONSTRAINT noo_toko_isi CHECK (kode ~ '^NOO-[0-9A-Z]{8}$' AND btrim(sales_code) <> '' AND btrim(principle) <> ''
              AND tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND btrim(nama_toko) <> '' AND btrim(nama_pemilik) <> '' AND btrim(alamat) <> ''
              AND btrim(nama_ktp) <> ''),
          CONSTRAINT noo_toko_pribadi CHECK (nik ~ '^[0-9]{16}$' AND no_hp ~ '^08[1-9][0-9]{7,10}$'
              AND foto_ktp ~ '^[0-9a-f-]{36}[.]jpg$' AND foto_toko ~ '^[0-9a-f-]{36}[.]jpg$' AND foto_ktp <> foto_toko),
          CONSTRAINT noo_toko_gps CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND akurasi >= 0),
          CONSTRAINT noo_toko_duplikat CHECK ((duplikat_dengan IS NULL) = (alasan_duplikat IS NULL)
              AND (alasan_duplikat IS NULL OR btrim(alasan_duplikat) <> '')
              AND (NOT duplikat_dikonfirmasi OR duplikat_dengan IS NOT NULL)
              AND (duplikat_dengan IS NULL OR status IN ('menunggu_spv', 'ditolak') OR duplikat_dikonfirmasi)),
          CONSTRAINT noo_toko_keputusan CHECK ((status = 'menunggu_spv') = (diputuskan_pada IS NULL)
              AND (diputuskan_pada IS NULL) = (diputuskan_oleh IS NULL)
              AND (status = 'ditolak') = (alasan_tolak IS NOT NULL)
              AND (alasan_tolak IS NULL OR btrim(alasan_tolak) <> '')),
          CONSTRAINT noo_toko_tautan CHECK ((status = 'terdaftar') = (customer_id IS NOT NULL)
              AND (customer_id IS NULL) = (customer_no IS NULL)
              AND (customer_id IS NULL) = (ditautkan_pada IS NULL)
              AND (ditautkan_pada IS NULL) = (ditautkan_oleh IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_noo_kode ON noo_toko (kode);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_noo_customer ON noo_toko (customer_id) WHERE customer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_noo_sales ON noo_toko (sales_code, status);
      CREATE INDEX IF NOT EXISTS idx_noo_antrean ON noo_toko (status, branch_id);
      CREATE INDEX IF NOT EXISTS idx_noo_nik ON noo_toko (nik) WHERE status <> 'ditolak';
      CREATE INDEX IF NOT EXISTS idx_noo_hp ON noo_toko (no_hp) WHERE status <> 'ditolak';
    `,
  },
];

async function main() {
  // DATABASE_MIGRATION_URL: role ber-hak DDL, terpisah dari role aplikasi. Role aplikasi
  // (accapi_app) sengaja bukan owner tabel — runbook L1g — dan Postgres menolak ALTER TABLE
  // dari non-owner. Kalau tidak di-set, jatuh ke DATABASE_URL seperti semula.
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "";
  if (!url.startsWith("postgres")) {
    console.log("[migrate-pg] DATABASE_URL bukan Postgres — dilewati.");
    process.exit(0);
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });

  try {
    for (const m of migrations) {
      // Cek dulu lewat information_schema (read-only, tidak butuh hak DDL). Postgres memeriksa
      // kepemilikan tabel SEBELUM IF NOT EXISTS sempat berlaku, jadi tanpa cek ini ALTER tetap
      // ditolak walau kolomnya sudah ada — dan karena kegagalan mematikan container, hasilnya
      // crash loop permanen: "no available server" di proxy.
      const { rowCount } = await pool.query(m.sudahAda);
      if (rowCount) {
        console.log(`[migrate-pg] SKIP ${m.nama} (sudah ada)`);
        continue;
      }
      await pool.query(m.sql);
      console.log(`[migrate-pg] OK ${m.nama}`);
    }
    console.log(`[migrate-pg] ${migrations.length} migrasi selesai.`);
  } catch (error) {
    // Sengaja MEMATIKAN container: kode yang butuh kolom ini sudah ikut di image yang sama.
    // Start dengan skema setengah jadi berarti error muncul nanti, di tangan user, pada
    // request acak — jauh lebih mahal daripada gagal start yang langsung terlihat di log.
    console.error("[migrate-pg] GAGAL:", String(error?.message || error));
    console.error("[migrate-pg] Kalau pesannya soal owner/permission: role aplikasi memang bukan owner tabel.");
    console.error("[migrate-pg] Jalankan DDL-nya sekali sebagai role owner (lihat docs/handover/), atau set");
    console.error("[migrate-pg] DATABASE_MIGRATION_URL ke role yang berhak DDL. Setelah kolomnya ada, migrasi ini di-skip.");
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
