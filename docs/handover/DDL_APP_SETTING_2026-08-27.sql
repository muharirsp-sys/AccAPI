-- Tabel setelan aplikasi (kunci-nilai). Role accapi_app sengaja tidak boleh CREATE,
-- jadi DDL dijalankan sebagai owner. Lihat runbook L1g di handover11.md.
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 -f - < DDL_APP_SETTING_2026-08-27.sql

CREATE TABLE IF NOT EXISTS app_setting (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_by  TEXT,
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_setting TO accapi_app;

-- Nilai awal = perilaku yang berjalan sekarang (ambang tetap 240 untuk GT), supaya
-- menjalankan DDL ini tidak mengubah nominal siapa pun.
INSERT INTO app_setting (key, value, updated_at)
VALUES ('insentif_gt_ao_target', 'fixed240', now())
ON CONFLICT (key) DO NOTHING;

SELECT key, value FROM app_setting;
