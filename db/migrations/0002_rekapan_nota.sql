-- =====================================================================
-- Modul Rekapan Nota (wave-based picking) — PRD_Rekapan_Nota.md v1.2 §4.3
-- Fase 1 (kolom master) + Fase 2 (skema wave) digabung: satu file, satu
-- transaksi, satu langkah apply. Idempoten — aman dijalankan ulang.
-- Apply: node scripts/apply-rekapan-migration.mjs   (produksi: psql role ber-DDL)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Kolom tambahan pada master existing (aditif; PG 11+ tidak rewrite)
-- ---------------------------------------------------------------------
ALTER TABLE item     ADD COLUMN IF NOT EXISTS isi_per_karton integer;
ALTER TABLE item     ADD COLUMN IF NOT EXISTS satuan_besar   text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS area           text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS grup_all       text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS grup_gdi       text;
-- Alamat outlet: cache Accurate tidak membawanya, padahal di situlah Kel./Kec. berada
-- dan itulah satu-satunya sinyal mesin usulan area. Diisi dari `Master Area Heinz`
-- saat impor master, lalu dijaga tetap segar dari alamat yang ikut tiap baris nota.
ALTER TABLE customer ADD COLUMN IF NOT EXISTS alamat         text;

DO $$ BEGIN
    ALTER TABLE item ADD CONSTRAINT ck_item_isi_positif
        CHECK (isi_per_karton IS NULL OR isi_per_karton > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_customer_area
    ON customer (area) WHERE area IS NOT NULL;
-- Antrean kerja mapping area: menyusut kalau dikerjakan.
CREATE INDEX IF NOT EXISTS ix_customer_tanpa_area
    ON customer ("customerNo") WHERE area IS NULL;
-- Dipakai di SETIAP jalur rekapan (join pool -> customer, upsert master import).
CREATE INDEX IF NOT EXISTS ix_customer_no ON customer ("customerNo");

-- ---------------------------------------------------------------------
-- 2. Enum
-- ---------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE wave_status    AS ENUM ('draft','released','confirmed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wave_tipe      AS ENUM ('reguler','kanvas');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wave_prioritas AS ENUM ('normal','urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pick_dimensi   AS ENUM ('outlet_all','outlet_gdi','area','volume','jenis_produk','sirup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wave_exception_jenis AS ENUM (
    'KONVERSI_TIDAK_ADA','KONVERSI_NOL','SATUAN_TIDAK_KONSISTEN',
    'KONVERSI_BEDA_DENGAN_EXPORT','PRINCIPAL_BELUM_MASUK',
    'OUTLET_TANPA_AREA','REKONSILIASI_SELISIH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wave_exception_status AS ENUM ('open','diabaikan','selesai');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 3. Sumber baris nota: upload export Accurate -> pool
--    (tidak ada tabel baris item di Postgres; sales_invoice cuma header)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rekap_upload (
    id           bigserial    PRIMARY KEY,
    nama_file    text         NOT NULL,
    sha256       text         NOT NULL,
    tanggal_data date         NOT NULL,
    baris_total  integer      NOT NULL,
    baris_masuk  integer      NOT NULL,
    principal    text[]       NOT NULL,
    uploaded_at  timestamptz  NOT NULL DEFAULT now(),
    uploaded_by  text         NOT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rekap_upload_sha ON rekap_upload (sha256);

CREATE TABLE IF NOT EXISTS wave_line_pool (
    id             bigserial   PRIMARY KEY,
    upload_id      bigint      NOT NULL REFERENCES rekap_upload(id) ON DELETE CASCADE,
    tanggal        date        NOT NULL,
    no_nota        text        NOT NULL,
    kode_cust      text        NOT NULL,
    customer       text,
    kode_salesman  text,
    salesman       text,
    kode_barang    text        NOT NULL,
    nama_barang    text,
    qty            numeric(14,4),
    satuan         text,
    qty_pcs        numeric(14,4),
    satuan_kecil   text,
    -- QTY_SATUANKECIL / QTY bila SATUAN <> SATUAN_KECIL. NULL kalau baris dijual
    -- dalam satuan kecil (rasio tak dapat diturunkan). Validator gratis master konversi.
    konv_tersirat  integer,
    jenisproduk    text,
    principal      text,
    region         text,
    alamat         text,
    kota           text
);
-- Idempotensi impor: upload ulang file yang sama tidak menggandakan baris.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wave_line_pool
    ON wave_line_pool (upload_id, no_nota, kode_barang);
CREATE INDEX IF NOT EXISTS ix_wave_line_pool_nota    ON wave_line_pool (no_nota);
CREATE INDEX IF NOT EXISTS ix_wave_line_pool_tanggal ON wave_line_pool (tanggal, no_nota);

-- ---------------------------------------------------------------------
-- 4. Wave
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wave (
    id            bigserial     PRIMARY KEY,
    tanggal       date          NOT NULL,
    urutan        smallint      NOT NULL,      -- 1 Pagi, 2 Siang (urgent), 3 Sore, ...
    nama          text          NOT NULL,
    tipe          wave_tipe     NOT NULL DEFAULT 'reguler',
    status        wave_status   NOT NULL DEFAULT 'draft',
    catatan       text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    text          NOT NULL REFERENCES "user"(id),
    released_at   timestamptz,
    released_by   text          REFERENCES "user"(id),
    confirmed_at  timestamptz,
    confirmed_by  text          REFERENCES "user"(id),
    CONSTRAINT ck_wave_urutan    CHECK (urutan BETWEEN 1 AND 20),
    -- Wave yang sudah lewat draft WAJIB punya waktu rilis. `cancelled` dikecualikan:
    -- draft boleh dibatalkan tanpa pernah dirilis (PRD menulis IFF, dan itu memblokir
    -- pembatalan draft -- ketahuan saat jalur cancel dibangun).
    CONSTRAINT ck_wave_released  CHECK (released_at IS NOT NULL OR status IN ('draft','cancelled')),
    CONSTRAINT ck_wave_confirmed CHECK ((status <> 'confirmed') OR (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wave_tanggal_urutan ON wave (tanggal, urutan);
DO $$ BEGIN
    ALTER TABLE wave ADD CONSTRAINT uq_wave_id_tipe UNIQUE (id, tipe);  -- murah: id sudah PK
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 5. Penugasan nota -> wave. Inti eksklusivitas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wave_assignment (
    id             bigserial       PRIMARY KEY,
    wave_id        bigint          NOT NULL REFERENCES wave(id) ON DELETE RESTRICT,
    wave_tipe      wave_tipe       NOT NULL DEFAULT 'reguler',
    no_nota        text            NOT NULL,
    tanggal_wave   date            NOT NULL,
    prioritas      wave_prioritas  NOT NULL DEFAULT 'normal',

    -- Take-out berapproval gudang. Bukan DELETE: jejaknya harus tinggal.
    dilepas        boolean         NOT NULL DEFAULT false,
    dilepas_alasan text,
    dilepas_at     timestamptz,
    dilepas_by     text            REFERENCES "user"(id),

    -- Snapshot klasifikasi saat nota masuk wave: master boleh berubah besok,
    -- rekapan kemarin tidak boleh ikut berubah.
    snap_grup_all  text            NOT NULL DEFAULT 'Gabung',
    snap_grup_gdi  text            NOT NULL DEFAULT 'Gabung',
    snap_area      text,
    snap_pareto    boolean,
    snap_total_krt numeric(14,4),
    snap_kanvas    boolean         NOT NULL DEFAULT false,

    created_at     timestamptz     NOT NULL DEFAULT now(),
    created_by     text            NOT NULL REFERENCES "user"(id),

    CONSTRAINT ck_takeout CHECK (
        dilepas = false
        OR (dilepas_alasan IS NOT NULL AND dilepas_at IS NOT NULL AND dilepas_by IS NOT NULL)),
    CONSTRAINT ck_kanvas_sesuai_wave CHECK (snap_kanvas = (wave_tipe = 'kanvas')),
    CONSTRAINT fk_wave_assignment_tipe FOREIGN KEY (wave_id, wave_tipe) REFERENCES wave (id, tipe)
);
-- Satu nota = satu penugasan AKTIF, kapan pun. Baris yang sudah di-take-out
-- (dengan approval) tidak lagi menahan. Dievaluasi di dalam transaksi yang sama
-- dengan penulisan -> tidak ada jendela balapan SELECT-lalu-INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_nota_aktif
    ON wave_assignment (no_nota) WHERE dilepas = false;
-- INCLUDE -> listing & filter grup jadi index-only scan (tidak menyentuh heap).
CREATE INDEX IF NOT EXISTS ix_wave_assignment_wave
    ON wave_assignment (wave_id)
    INCLUDE (no_nota, prioritas, snap_grup_all, snap_grup_gdi, snap_area, snap_pareto);

-- Penanda kanvas: berdiri sendiri, TIDAK di pool — pool ditulis ulang tiap
-- upload, tanda tidak boleh ikut terhapus.
CREATE TABLE IF NOT EXISTS nota_kanvas (
    no_nota      text        PRIMARY KEY,
    catatan      text,
    ditandai_at  timestamptz NOT NULL DEFAULT now(),
    ditandai_by  text        NOT NULL REFERENCES "user"(id)
);

-- ---------------------------------------------------------------------
-- 6. Pick group (pengganti 29+ sheet cetak)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pick_group (
    id           bigserial     PRIMARY KEY,
    kode         text          NOT NULL,
    nama         text          NOT NULL,
    dimensi      pick_dimensi  NOT NULL,
    urutan_cetak smallint      NOT NULL DEFAULT 100,
    aktif        boolean       NOT NULL DEFAULT true,
    created_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_group_kode ON pick_group (kode);

CREATE TABLE IF NOT EXISTS pick_group_member (
    pick_group_id bigint NOT NULL REFERENCES pick_group(id) ON DELETE CASCADE,
    nilai         text   NOT NULL,
    PRIMARY KEY (pick_group_id, nilai)
);

CREATE TABLE IF NOT EXISTS wave_pick_group (
    wave_id       bigint NOT NULL REFERENCES wave(id) ON DELETE CASCADE,
    pick_group_id bigint NOT NULL REFERENCES pick_group(id) ON DELETE RESTRICT,
    dicetak_at    timestamptz,
    dicetak_by    text   REFERENCES "user"(id),
    PRIMARY KEY (wave_id, pick_group_id)
);

-- ---------------------------------------------------------------------
-- 7. Exception queue (pengganti sel "salah conversi" yang selalu 0)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wave_exception (
    id          bigserial              PRIMARY KEY,
    wave_id     bigint                 NOT NULL REFERENCES wave(id) ON DELETE CASCADE,
    jenis       wave_exception_jenis   NOT NULL,
    ref_tipe    text                   NOT NULL,
    ref_kode    text                   NOT NULL,
    keterangan  text,
    status      wave_exception_status  NOT NULL DEFAULT 'open',
    created_at  timestamptz            NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by text                   REFERENCES "user"(id)
);
-- Membuat pendeteksian idempoten: boleh dijalankan ulang tanpa menumpuk duplikat.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wave_exception
    ON wave_exception (wave_id, jenis, ref_tipe, ref_kode);
CREATE INDEX IF NOT EXISTS ix_wave_exception_open
    ON wave_exception (wave_id) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 8. Audit trail (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wave_event (
    id         bigserial   PRIMARY KEY,
    wave_id    bigint      NOT NULL REFERENCES wave(id) ON DELETE CASCADE,
    event      text        NOT NULL,
    aktor_id   text        NOT NULL REFERENCES "user"(id),
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wave_event_wave ON wave_event (wave_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 9. Seed pick_group. Aturan versi SORE dijadikan kanonik (R2.4) — versi
--    pagi terbukti tertinggal (PGS hilang, HNZ6 tanpa filter area).
--    Grup `jenis_produk` TIDAK di-seed di sini: nilainya datang dari data,
--    di-upsert otomatis saat upload (§5.2 menolak UI master pick_group).
-- ---------------------------------------------------------------------
INSERT INTO pick_group (kode, nama, dimensi, urutan_cetak) VALUES
    ('AREA-1','Area 1 / 10 / Pinggiran Utara','area',10),
    ('AREA-2','Area 2 / 6 / 11','area',20),
    ('AREA-3','Area 3 / 9','area',30),
    ('AREA-4','Area 4 / 5 / Pinggiran Selatan','area',40),
    ('AREA-5','Area 7 / 8','area',50),
    ('VOL-PARETO','Pareto (>= ambang karton per nota)','volume',60),
    ('VOL-NONPARETO','Non Pareto','volume',61),
    ('OA-SIP','Alfa & Indo PLP','outlet_all',70),
    ('OA-SM','Sat & Midi','outlet_all',71),
    ('OA-II','IDM & IDG','outlet_all',72),
    ('OA-SS','Satu Sama','outlet_all',73),
    ('OA-EKT','Ektong','outlet_all',74),
    ('OA-GABUNG','Gabungan (di luar key account)','outlet_all',75),
    ('OG-MTGDI','MT GDI','outlet_gdi',80),
    ('OG-GABUNG','GDI Gabungan (di luar MT GDI)','outlet_gdi',81),
    ('SRP-SIRUP','Sirup Heinz (gudang terpisah)','sirup',90),
    ('SRP-NONSIRUP','Non Sirup','sirup',91)
ON CONFLICT (kode) DO NOTHING;

INSERT INTO pick_group_member (pick_group_id, nilai)
SELECT g.id, v.nilai FROM pick_group g
JOIN (VALUES
    ('AREA-1','1'),('AREA-1','10'),('AREA-1','PGU'),
    ('AREA-2','2'),('AREA-2','6'),('AREA-2','11'),
    ('AREA-3','3'),('AREA-3','9'),
    ('AREA-4','4'),('AREA-4','5'),('AREA-4','PGS'),
    ('AREA-5','7'),('AREA-5','8'),
    ('VOL-PARETO','PARETO'),('VOL-NONPARETO','NON PARETO'),
    ('OA-SIP','ALFA & INDO PLP'),('OA-SM','SAT & MIDI'),('OA-II','IDM & IDG'),
    ('OA-SS','SATU SAMA'),('OA-EKT','EKTONG'),('OA-GABUNG','Gabung'),
    ('OG-MTGDI','MT GDI'),('OG-GABUNG','Gabung'),
    ('SRP-SIRUP','SIRUP'),('SRP-NONSIRUP','NON SIRUP')
) AS v(kode, nilai) ON v.kode = g.kode
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 10. Parameter bisnis di app_setting (tabel existing, bukan tabel baru)
-- ---------------------------------------------------------------------
INSERT INTO app_setting (key, value, updated_at) VALUES
    ('rekapan.ambang_pareto_karton','50', now()),
    ('rekapan.baris_per_lembar_faktur','13', now()),
    ('rekapan.area_dikecualikan','NON,LUAR KOTA', now())
ON CONFLICT (key) DO NOTHING;
