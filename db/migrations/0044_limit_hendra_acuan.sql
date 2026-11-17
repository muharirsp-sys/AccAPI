-- =====================================================================
-- Limit pelanggan "Hendra" (owner 17 Nov 2026): pelanggan yang catatan Accurate-nya memuat "Hendra" adalah keputusan manual.
--
--   limit_hendra_acuan  (baru) acuan Limit Piutang + Limit Hari per pelanggan Hendra. Pemulih (lib/pelanggan-hendra,
--                        cron pulih-limit-hendra + akhir sync-accurate) mengembalikan Accurate ke acuan HANYA bila limit berubah
--                        karena impor massal; edit satuan di Accurate menjadi acuan baru. accapi_app SELECT/INSERT/UPDATE, TANPA
--                        DELETE (jejak pemulihan).
--
-- EXPAND saja. Menjalankan ulang = tanpa perubahan. Entri migrate-pg: "limit hendra acuan". DDL manual: docs/handover/DDL_LIMIT_HENDRA.sql.
-- =====================================================================
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS limit_hendra_acuan (
    customer_id               bigint PRIMARY KEY,
    customer_no               text NOT NULL,
    limit_aktif               boolean NOT NULL,
    limit_nilai               double precision,
    hari_aktif                boolean NOT NULL,
    hari_nilai                integer,
    acuan_last_update         text,
    sumber                    text NOT NULL,
    diperbarui_pada           timestamptz NOT NULL DEFAULT now(),
    terakhir_dipulihkan_pada  timestamptz,
    terakhir_dipulihkan_dari  jsonb,
    jumlah_dipulihkan         integer NOT NULL DEFAULT 0,
    CONSTRAINT limit_hendra_acuan_sumber CHECK (sumber IN ('awal', 'edit_manual'))
);
DO $lha$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON limit_hendra_acuan FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON limit_hendra_acuan TO accapi_app;
  END IF;
END $lha$;
RESET lock_timeout;
