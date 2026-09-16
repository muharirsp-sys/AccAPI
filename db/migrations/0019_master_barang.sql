-- =====================================================================
-- MASTER BARANG per principal — modul yang selesai Juli 2026 dan tak pernah sampai.
--
-- Modul ini yang MEMBUAT master principal baru: unggah daftar barang principal
-- (Excel/PDF), susun Kamus Kode, isi Form Fix, periksa QC, lalu konfirmasi.
-- Tanpa ia, satu-satunya cara menambah principal baru adalah menyusun berkas
-- master dengan tangan di luar sistem — dan matcher deterministik jalur Summary
-- menuntut master berpola `BRAND - JENIS` yang tidak dijamin siapa pun.
--
-- Karena itu ia prasyarat untuk surat di luar Priskila: matchernya sudah ada,
-- masternya yang belum bisa dibuat.
--
-- BENTUK PENYIMPANAN. Satu baris `master_barang` memegang SATU revisi utuh:
-- snapshot source-item, Kamus Kode, Form Fix, hasil QC, dan state konfirmasi.
-- JSONB dipilih karena layar selalu membaca dan mengganti satu revisi sekaligus,
-- tidak pernah satu sel; memecahnya menjadi tabel baris hanya menambah join yang
-- tidak pernah ditanyakan. Metadata yang DICARI (nama principal ternormalisasi,
-- waktu ubah) tetap kolom typed dan ber-indeks supaya daftar master tidak
-- memindai JSON.
--
-- `master_barang_source` menyimpan JEJAK BERKAS ASALNYA, dan `sha256`-nya unik
-- per master: mengunggah ulang berkas yang sama persis bukan sumber baru, ia
-- unggahan ganda. `master_barang_audit` mencatat siapa mengubah apa; keduanya
-- ON DELETE CASCADE karena tanpa masternya mereka tidak berarti apa-apa.
--
-- Skema Postgres produksi dibuat lewat `drizzle-kit push` (lihat scripts/init-db.mjs),
-- jadi berkas ini untuk basis data yang sudah ada dan untuk dibaca orang.
-- =====================================================================

CREATE TABLE IF NOT EXISTS master_barang (
    id                  text PRIMARY KEY,
    principle_code      text NOT NULL,
    principle_name      text NOT NULL,
    principle_name_norm text NOT NULL,
    -- blocked_similarity | draft | review | ready
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
-- Satu berkas master lama hanya boleh diadopsi SEKALI; dua adopsi berarti dua
-- master yang mengaku mewakili berkas yang sama.
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
