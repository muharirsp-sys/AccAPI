-- EKSPOR BACA-SAJA sumber laporan principal S7-2 (BL-64) — keluaran SATU baris JSON untuk scripts/principal-laporan.mjs --dari-json.
-- Rujukan: lib/principal/laporan.ts (SUMBER_EKSPOR, uraiEkspor), scripts/principal-laporan.mjs (mode DB menjalankan berkas INI juga),
-- docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md (runbook), lib/principal-pg.test.ts.
--
-- SIAPA & KAPAN: IT Support di VPS, kapan saja (tidak mengubah apa pun). Tanpa terowongan, tanpa Node/tsx di image:
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -qAt -v ON_ERROR_STOP=1 < PRINCIPAL_EKSPOR.sql > principal-ekspor.json
--
--   lalu salin principal-ekspor.json ke checkout repo (sudah `npm ci`) dan jalankan OFFLINE:
--   npx tsx scripts/principal-laporan.mjs --dari-json principal-ekspor.json --keluar scratch/principal-laporan/prod-<tanggal>
--
-- BACA-SAJA: sesi default_transaction_read_only=on + transaksi REPEATABLE READ READ ONLY (satu snapshot), diperiksa sebelum membaca
-- (bukan baca-saja = berhenti), diakhiri ROLLBACK. Tiap sumber dibaca dalam blok EXCEPTION sendiri: tabel hilang/galat dicatat
-- {ok:false, galat} — galat ≠ kosong — dan tidak menggugurkan sumber lain. Isi = nama/kode principal + hitungan, tanpa rahasia.
-- -qAt: tanpa tag perintah/judul kolom; pembaca mengambil baris JSON terakhir (baris lain diabaikan).

SET default_transaction_read_only = on;
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';

DO $ekspor$
DECLARE
    s record;
    baris json;
    data jsonb := '{}'::jsonb;
BEGIN
    IF current_setting('transaction_read_only') <> 'on' THEN
        RAISE EXCEPTION 'principal-ekspor: sesi tidak baca-saja — berhenti tanpa membaca';
    END IF;
    FOR s IN SELECT * FROM (VALUES
        ('masterBarang', $q$SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
                           FROM master_barang GROUP BY 1, 2 ORDER BY 1, 2$q$),
        ('principalMapping', $q$SELECT principal, kind, count(*)::int AS n FROM principal_mapping GROUP BY 1, 2 ORDER BY 1, 2$q$),
        ('noClaimTemplate', $q$SELECT principle_code AS "principleCode", variant_key AS "variantKey" FROM no_claim_template ORDER BY 1, 2$q$),
        ('offBatch', $q$SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
                       FROM off_batch GROUP BY 1, 2 ORDER BY 1, 2$q$),
        ('claimWorkflow', $q$SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
                            FROM claim_workflow GROUP BY 1, 2 ORDER BY 1, 2$q$),
        ('principal', $q$SELECT code, name, is_active AS "isActive" FROM principal ORDER BY code$q$),
        ('principalVariant', $q$SELECT p.code, v.variant_key AS "variantKey", v.name, v.is_active AS "isActive"
                               FROM principal_variant v JOIN principal p ON p.id = v.principal_id ORDER BY 1, 2$q$),
        ('principalAlias', $q$SELECT p.code, a.variant_key AS "variantKey", a.alias_norm AS "aliasNorm", a.alias_asli AS "aliasAsli", a.jenis, a.sumber
                             FROM principal_alias a JOIN principal p ON p.id = a.principal_id ORDER BY 3, 1$q$)
    ) AS v(nama, kueri) LOOP
        BEGIN
            EXECUTE format('SELECT coalesce(json_agg(t), ''[]''::json) FROM (%s) t', s.kueri) INTO baris;
            data := data || jsonb_build_object(s.nama, jsonb_build_object('ok', true, 'rows', baris));
        EXCEPTION WHEN OTHERS THEN
            data := data || jsonb_build_object(s.nama, jsonb_build_object('ok', false, 'galat', SQLSTATE || ' ' || SQLERRM));
        END;
    END LOOP;
    PERFORM set_config('principal_ekspor.hasil', jsonb_build_object('format', 'principal-ekspor-v1',
        'dibaca', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', data)::text, true);
END $ekspor$;

SELECT current_setting('principal_ekspor.hasil') AS ekspor;
ROLLBACK;
