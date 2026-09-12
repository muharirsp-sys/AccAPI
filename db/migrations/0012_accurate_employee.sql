-- =====================================================================
-- Master pegawai/salesman Accurate (employee/list.do).
--
-- Kenapa tabel, bukan kolom id pada `principal_mapping`: `employee.number`
-- TERBUKTI identik dengan kode internal salesman kita (M-IDW, M-WEC, ...),
-- jadi jembatan ke `masterSalesmanId` bisa DITURUNKAN, bukan diketik ulang.
-- Kolom yang diisi tangan akan basi diam-diam setiap kali sales berganti —
-- dan pada 2026-09-12 dua dari sembilan baris mapping memang sudah menunjuk
-- orang yang `suspended` di Accurate.
--
-- Endpoint dibuktikan live 2026-09-12: `salesman/list.do` -> 404 "URL API
-- tidak tepat"; `employee/list.do` -> 200, 236 pegawai, 220 bertanda
-- `salesman: true`, lengkap dengan `number`, `name`, `branchId`, `suspended`.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0012_accurate_employee.sql
-- Idempoten dan aditif; tidak menyentuh tabel lain.
-- =====================================================================

CREATE TABLE IF NOT EXISTS accurate_employee (
    id         bigint      PRIMARY KEY,
    -- Kode pegawai Accurate; sama dengan kode salesman internal kita.
    number     text        NOT NULL DEFAULT '',
    name       text        NOT NULL DEFAULT '',
    branch_id  bigint,
    -- Hanya yang bertanda salesman boleh dipasang pada faktur.
    salesman   boolean     NOT NULL DEFAULT false,
    suspended  boolean     NOT NULL DEFAULT false,
    raw_data   jsonb,
    synced_at  timestamptz NOT NULL DEFAULT now()
);

-- Pencarian dari kode internal salesman -> id Accurate.
CREATE INDEX IF NOT EXISTS idx_accurate_employee_number ON accurate_employee (number);
