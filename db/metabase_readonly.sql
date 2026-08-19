-- Role read-only Postgres untuk Metabase (Direktur/Manager).
-- Terpisah total dari role DATABASE_URL yang dipakai Next.js/FastAPI — script ini
-- TIDAK meng-ALTER/REVOKE role atau koneksi existing apapun.
--
-- Jalankan sebagai owner DB:  psql "$DATABASE_URL" -f db/metabase_readonly.sql
-- Ganti password dulu. Jangan commit password asli.
--
-- ponytail: whitelist eksplisit per kolom, bukan GRANT ... ON ALL TABLES.
-- Tabel baru TIDAK otomatis kebaca Metabase (ALTER DEFAULT PRIVILEGES sengaja tidak dipakai) —
-- tambah tabel baru = tambah baris GRANT di sini. Sengaja bikin capek: itu gate-nya.

BEGIN;

-- 1. Role -----------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    CREATE ROLE metabase_readonly LOGIN PASSWORD 'GANTI_PASSWORD_INI';
  END IF;
END
$$;

-- Guard tulis (bukan pagar: role bisa SET off sendiri). Pagar sebenarnya = tidak ada
-- GRANT INSERT/UPDATE/DELETE di bawah + REVOKE CREATE di step 2.
ALTER ROLE metabase_readonly SET default_transaction_read_only = on;
-- Metabase buka banyak koneksi paralel; batasi supaya tidak menghabiskan pool app.
ALTER ROLE metabase_readonly CONNECTION LIMIT 5;

-- 2. Schema ---------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO metabase_readonly;

-- Postgres <= 14: PUBLIC punya CREATE di schema public, jadi metabase_readonly bisa
-- CREATE TABLE meski tidak di-grant apapun. Cek dulu owner schema; kalau owner-nya
-- role app (bukan PUBLIC-dependent), aman di-revoke.
--   SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Whitelist tabel ------------------------------------------------------

-- 3a. OFF Program Control (spend program per principal)
GRANT SELECT ON off_period_closure TO metabase_readonly;

GRANT SELECT (
  id, no_pengajuan, gelombang, principle_code, principle_name, bulan, tahun,
  supervisor_name, total_nominal, status, sm_status, claim_status, om_status,
  finance_status, final_status, locked, submitted_at, sm_approved_at, returned_at,
  claim_reviewed_at, claim_submitted_date, claim_deadline, no_claim,
  completeness_status, om_approved_at, cancelled_at, paid_at, payment_date,
  paid_amount, payment_method, verified_amount, refund_status, refund_amount,
  total_refunded, created_by_role, created_at, updated_at
) ON off_batch TO metabase_readonly;

GRANT SELECT (
  id, batch_id, item_no, row_no, no_surat, no_claim, nama_program, periode, toko,
  barang, nominal, cara_bayar, finance_payment_status, finance_paid_at,
  finance_paid_amount, type, original_type, normalized_type, type_is_legacy,
  pph_exempt, pph_amount, adjustment_pph, deadline,
  kwt, skp, fp, pc, foto, rekap, others,
  final_kwt, final_skp, final_fp, final_pc, final_foto, final_rekap, final_others,
  created_at, updated_at
) ON off_batch_item TO metabase_readonly;

-- 3b. Claim Workflow (outstanding klaim ke principal)
GRANT SELECT (
  id, off_batch_id, claim_workflow_no, principle_code, principle_name, source_type,
  aggregate_status, status, total_dpp, total_ppn, total_pph, total_claim, total_paid,
  remaining_amount, submitted_to_principal_at, no_claim, no_claim_assigned_at,
  closed_at, created_at, updated_at
) ON claim_workflow TO metabase_readonly;

GRANT SELECT (
  id, claim_workflow_id, no_claim, no_claim_assigned_at, scope, scope_label, status,
  total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
  submitted_to_principal_at, closed_at, created_at, updated_at
) ON claim_submission TO metabase_readonly;

GRANT SELECT (
  id, claim_workflow_id, claim_submission_id, off_batch_item_id, no_surat,
  jenis_promosi, periode, outlet, dpp, ppn_rate, ppn_amount, pph_rate, pph_amount,
  nilai_klaim, status, created_at, updated_at
) ON claim_workflow_item TO metabase_readonly;

GRANT SELECT (
  id, claim_workflow_id, claim_submission_id, payment_date, payment_amount,
  payment_type, voided_at, created_at, updated_at
) ON claim_payment TO metabase_readonly;

-- 3c. Sales performance (target vs achievement)
GRANT SELECT (
  id, sales_code, sales_name, principle, branch, channel, spv_name, sm_name,
  created_at, updated_at
) ON sales_profile TO metabase_readonly;

GRANT SELECT ON sales_targets TO metabase_readonly;

GRANT SELECT (
  id, sales_code, principle, branch, date, period_month, period_year, invoice_number,
  achieved_value_dpp, achieved_ec, achieved_ao, achieved_ia, created_at
) ON sales_daily_progress TO metabase_readonly;

GRANT SELECT ON sales_outlet_txn TO metabase_readonly;

-- 3d. Kontrol harian (coverage/AO)
GRANT SELECT (
  id, sales_code, sales_name, cust_code, cust_name, market, kota, hari_kunjungan,
  minggu_pattern, area, rayon, principle, channel, visit_frequency, is_active,
  created_at, updated_at
) ON jks_master TO metabase_readonly;

GRANT SELECT (
  id, sales_code, cust_code, principle, date, period_month, period_year, status,
  order_value_dpp, invoice_number, is_visited, no_order_reason_code, checkin_at,
  checkout_at, gps_flag, auto_matched, source, created_at, updated_at
) ON ao_control_daily TO metabase_readonly;

GRANT SELECT (
  id, sales_code, date, period_month, period_year, total_toko_jks, total_order,
  total_active, total_not_order, total_not_visited, reason_summary, submitted_at,
  spv_ack, spv_ack_at
) ON salesman_daily_report TO metabase_readonly;

GRANT SELECT ON no_order_reason TO metabase_readonly;

-- 3e. Cache Accurate (omzet/piutang) — raw_data JSONB sengaja tidak di-grant
-- NOTE: kolom `synced_at` ada di db/schema.ts tapi BELUM ada di DB produksi
-- (drift, per 2026-07-27). Tambahkan ke grant di bawah setelah migrasi jalan.
GRANT SELECT (id, no, name, "itemType", "unitPrice", last_update)
  ON item TO metabase_readonly;

GRANT SELECT (id, "customerNo", name, balance, last_update)
  ON customer TO metabase_readonly;

GRANT SELECT (
  id, number, trans_date, customer_no, customer_name, total_amount, outstanding,
  status, last_update
) ON sales_invoice TO metabase_readonly;

GRANT SELECT (
  id, number, trans_date, customer_no, customer_name, total_amount, status,
  last_update
) ON sales_return TO metabase_readonly;

COMMIT;

-- 4. Self-check -----------------------------------------------------------
-- Gagal (raise exception) kalau whitelist bocor ke tabel auth atau kolom rekening.
-- Tabel blacklist dicek lewat to_regclass supaya tidak meledak kalau modulnya
-- belum ter-migrate di environment ini (mis. master_barang belum ada di prod).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user','account','session','verification',
                           'accurate_oauth_session','master_barang','incentive_payments',
                           'off_payment','off_refund','permission_audit_log'] LOOP
    IF to_regclass(quote_ident(t)) IS NOT NULL THEN
      ASSERT NOT has_table_privilege('metabase_readonly', quote_ident(t), 'SELECT'),
             format('BOCOR: %s ke-grant', t);
    END IF;
  END LOOP;
  ASSERT NOT has_column_privilege('metabase_readonly', 'off_batch', 'no_rekening', 'SELECT'), 'BOCOR: no_rekening';
  ASSERT NOT has_column_privilege('metabase_readonly', 'item', 'raw_data', 'SELECT'), 'BOCOR: item.raw_data';
  ASSERT     has_table_privilege('metabase_readonly', 'sales_targets', 'SELECT'), 'sales_targets tidak ke-grant';
  ASSERT NOT has_table_privilege('metabase_readonly', 'sales_targets', 'UPDATE'), 'BOCOR: write access';
  RAISE NOTICE 'metabase_readonly OK';
END
$$;
