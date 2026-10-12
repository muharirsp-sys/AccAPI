/*
 * Tujuan: Definisi SATU-SATUNYA trigger penjaga principal (S7-0 kode tetap, S7-2 riwayat append-only) dan ekspresi SQL pemeriksanya:
 *   nama + tabel + aktif, JENIS EVENT (tgtype), kolom (tgattr), WHEN, fungsi (nama, plpgsql, RETURNS trigger) dan ISI fungsi.
 *   Trigger bernama sama tetapi jenis/fungsi/isi lain (mis. fungsi diganti `RETURN NEW`) = TIDAK sah.
 * Caller: lib/principal/tulis.ts cekDdl (jalur tulis -> 503), lib/principal/laporan.ts (penjaga benih), docs/handover/DDL_S7_2.sql
 *   (prasyarat + VERIFIKASI memuat ekspresi yang SAMA — lib/principal/penjaga.test.ts memastikannya).
 * Dependensi: tidak ada (murni; aman diimpor skrip .mjs lewat tsx).
 * Main Functions: PENJAGA, sqlPenjagaSah, SQL_PENJAGA_HILANG.
 * Side Effects: tidak ada.
 */

export type Penjaga = {
    nama: string; tabel: string; tgtype: number; kolom: string | null; when: string | null; fungsi: string; isi: string; ddl: string;
};

// Isi fungsi = teks di antara $fn$ ... $fn$ pada DDL, spasi dirapatkan (lihat ekspresi `btrim(regexp_replace(prosrc, ...))`).
const ISI_KODE = "BEGIN RAISE EXCEPTION 'S7-0: principal.code tidak boleh diubah (% -> %) — buat principal baru, jangan ganti kode', OLD.code, NEW.code USING ERRCODE = 'restrict_violation'; END";
const ISI_LOG = "BEGIN RAISE EXCEPTION 'S7-2: principal_log append-only — % ditolak (riwayat principal)', TG_OP USING ERRCODE = 'restrict_violation'; END";

// tgtype = bit pg_trigger (catalog/pg_trigger.h): ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
export const PENJAGA: readonly Penjaga[] = [
    // BEFORE UPDATE OF code FOR EACH ROW WHEN (OLD.code IS DISTINCT FROM NEW.code) = 2 + 16 + 1 = 19
    { nama: "trg_principal_code_tetap", tabel: "principal", tgtype: 19, kolom: "code", when: "oldcodeisdistinctfromnewcode",
        fungsi: "principal_code_tetap", isi: ISI_KODE, ddl: "DDL_S7_0.sql" },
    // BEFORE UPDATE OR DELETE FOR EACH ROW = 2 + 8 + 16 + 1 = 27
    { nama: "trg_principal_log_append_only", tabel: "principal_log", tgtype: 27, kolom: null, when: null,
        fungsi: "principal_log_append_only", isi: ISI_LOG, ddl: "DDL_S7_2.sql" },
    // BEFORE TRUNCATE FOR EACH STATEMENT = 2 + 32 = 34
    { nama: "trg_principal_log_no_truncate", tabel: "principal_log", tgtype: 34, kolom: null, when: null,
        fungsi: "principal_log_append_only", isi: ISI_LOG, ddl: "DDL_S7_2.sql" },
];

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Ekspresi boolean SQL: true hanya bila trigger `p` terpasang PERSIS (bukan sekadar bernama sama). */
export function sqlPenjagaSah(p: Penjaga): string {
    const kolom = p.kolom
        ? `cardinality(t.tgattr::int2[]) = 1 AND t.tgattr[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = t.tgrelid AND a.attname = ${lit(p.kolom)})`
        : "cardinality(t.tgattr::int2[]) = 0";
    // WHEN hilang = lebih ketat (selalu menolak), boleh; WHEN lain (mis. `... AND false`) = tidak sah.
    const when = p.when
        ? `(t.tgqual IS NULL OR regexp_replace(lower(pg_get_triggerdef(t.oid)), '[^a-z]', '', 'g') LIKE ${lit(`%when${p.when}execute%`)})`
        : "t.tgqual IS NULL";
    return [
        "EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_language l ON l.oid = f.prolang",
        `    WHERE t.tgname = ${lit(p.nama)} AND t.tgrelid = to_regclass(${lit(p.tabel)}) AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')`,
        `      AND t.tgtype = ${p.tgtype} AND ${kolom}`,
        `      AND ${when}`,
        `      AND f.proname = ${lit(p.fungsi)} AND f.prorettype = 'trigger'::regtype AND l.lanname = 'plpgsql'`,
        `      AND btrim(regexp_replace(f.prosrc, '\\s+', ' ', 'g')) = ${lit(p.isi)})`,
    ].join("\n");
}

/** Nama trigger penjaga yang TIDAK sah (kosong = semua terpasang persis). */
export const SQL_PENJAGA_HILANG = `SELECT v.nama FROM (VALUES\n${PENJAGA.map((p) => `(${lit(p.nama)}, ${sqlPenjagaSah(p)})`).join(",\n")}\n) AS v(nama, sah) WHERE NOT v.sah`;
