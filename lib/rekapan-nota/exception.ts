/*
 * Tujuan: Deteksi exception wave — set-based, sekali per transisi draft -> released.
 *         Pengganti sel "salah conversi" yang rusak: exception punya status dan pemilik.
 * Caller: app/api/rekapan-nota/wave/[id]/route.ts (aksi release).
 * Dependensi: lib/db (pool pg).
 * Main Functions: deteksiException, hitungExceptionOpen.
 * Side Effects: INSERT ke wave_exception (idempoten lewat ON CONFLICT DO NOTHING).
 */
import { pool } from "@/lib/db";

type Deteksi = { jenis: string; sql: string };

// Semua query berbentuk: SELECT DISTINCT ref_tipe, ref_kode, keterangan  FROM ... WHERE wave_id = $1
const DETEKSI: Deteksi[] = [
    {
        // E1: penyebab 48 dari 473 nota hilang dari lembar HNZ. Sekarang barisnya tetap
        // tercetak (Sat Bsr kosong) DAN ada yang bertanggung jawab menutupnya.
        jenis: "KONVERSI_TIDAK_ADA",
        // Dievaluasi per SKU, BUKAN per baris. Lembar picking menghitung per SKU, jadi satu
        // baris ber-konv_tersirat sudah cukup membuat kolom Konv terisi (R1.7). Versi per
        // baris berbunyi untuk SKU yang sebenarnya bisa dihitung -- alarm yang salah menyala.
        sql: `SELECT 'item'::text, p.kode_barang,
                     'Item tidak punya isi per karton; Sat Bsr/Sat Kcl tidak dapat dihitung'
                FROM wave_assignment wa
                JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
                LEFT JOIN item i ON i.no = p.kode_barang
               WHERE wa.wave_id = $1 AND wa.dilepas = false
               GROUP BY p.kode_barang
              HAVING count(coalesce(p.konv_tersirat, i.isi_per_karton)) = 0`,
    },
    {
        // R1.6: faktor konversi yang dibawa transaksinya sendiri vs master. Baseline uji
        // 65/65 SKU cocok — jadi exception ini seharusnya sepi, dan itu yang bikin berguna.
        jenis: "KONVERSI_BEDA_DENGAN_EXPORT",
        sql: `SELECT DISTINCT 'item'::text, p.kode_barang,
                     'Konversi di export ' || p.konv_tersirat || ' beda dengan master ' || i.isi_per_karton
                FROM wave_assignment wa
                JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
                JOIN item i ON i.no = p.kode_barang
               WHERE wa.wave_id = $1 AND wa.dilepas = false
                 AND p.konv_tersirat IS NOT NULL AND i.isi_per_karton IS NOT NULL
                 AND p.konv_tersirat <> i.isi_per_karton`,
    },
    {
        // Eks formula Check Pcs — satu-satunya pengaman workbook yang masih hidup.
        jenis: "SATUAN_TIDAK_KONSISTEN",
        sql: `SELECT DISTINCT 'item'::text, p.kode_barang,
                     'Satuan ' || p.satuan || ' tetapi qty satuan kecil < isi per karton'
                FROM wave_assignment wa
                JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
                LEFT JOIN item i ON i.no = p.kode_barang
               WHERE wa.wave_id = $1 AND wa.dilepas = false
                 AND upper(coalesce(p.satuan,'')) IN ('CTN','KRT')
                 AND p.qty_pcs < coalesce(p.konv_tersirat, i.isi_per_karton)`,
    },
    {
        // Per CUSTOMER, bukan per baris nota: ~168 vs ~2.900. Daftar yang menyusut kalau
        // dikerjakan itulah bentuk antrean kerja yang benar (Q2).
        jenis: "OUTLET_TANPA_AREA",
        sql: `SELECT DISTINCT 'customer'::text, p.kode_cust,
                     'Outlet belum ada di master area; notanya tidak masuk lembar area mana pun'
                FROM wave_assignment wa
                JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
               WHERE wa.wave_id = $1 AND wa.dilepas = false AND wa.snap_area IS NULL`,
    },
    {
        // Penjaga kelengkapan upload: principal yang 30 hari terakhir selalu ada, hari ini tidak.
        jenis: "PRINCIPAL_BELUM_MASUK",
        sql: `SELECT DISTINCT 'principal'::text, riwayat.principal,
                     'Principal ada di upload 30 hari terakhir tetapi tidak ada di pool tanggal wave ini'
                FROM wave w
                JOIN LATERAL (
                    SELECT DISTINCT pool.principal
                      FROM wave_line_pool pool
                     WHERE pool.principal IS NOT NULL
                       AND pool.tanggal BETWEEN w.tanggal - 30 AND w.tanggal - 1
                ) riwayat ON true
               WHERE w.id = $1
                 AND NOT EXISTS (
                    SELECT 1 FROM wave_line_pool hari_ini
                     WHERE hari_ini.tanggal = w.tanggal AND hari_ini.principal = riwayat.principal)`,
    },
];

// KONVERSI_NOL sengaja tidak dideteksi: ck_item_isi_positif melarang 0 di master dan
// deriveKonvTersirat menolak rasio <= 0, jadi nilainya mustahil sampai ke sini. Query
// untuk kondisi yang tak bisa terjadi = kode yang lahir langsung jadi sampah.

/**
 * Idempoten: boleh dijalankan ulang setelah admin memperbaiki master, tanpa menumpuk duplikat.
 * @returns jumlah exception BARU per jenis
 */
export async function deteksiException(waveId: number): Promise<Record<string, number>> {
    const hasil: Record<string, number> = {};
    for (const d of DETEKSI) {
        const r = await pool.query(
            `INSERT INTO wave_exception (wave_id, jenis, ref_tipe, ref_kode, keterangan)
             SELECT $1, '${d.jenis}'::wave_exception_jenis, s.ref_tipe, s.ref_kode, s.keterangan
               FROM (${d.sql}) AS s(ref_tipe, ref_kode, keterangan)
              WHERE s.ref_kode IS NOT NULL AND s.ref_kode <> ''
             ON CONFLICT (wave_id, jenis, ref_tipe, ref_kode) DO NOTHING`, [waveId]);
        if (r.rowCount) hasil[d.jenis] = r.rowCount;
    }
    return hasil;
}

/** Hanya KONVERSI_* yang memblokir confirm (R1.4). Sisanya informasi, bukan gerbang. */
export async function hitungExceptionOpen(waveId: number): Promise<{ total: number; konversi: number }> {
    const r = await pool.query<{ total: string; konversi: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE jenis::text LIKE 'KONVERSI%')::text AS konversi
           FROM wave_exception WHERE wave_id = $1 AND status = 'open'`, [waveId]);
    return { total: Number(r.rows[0]?.total ?? 0), konversi: Number(r.rows[0]?.konversi ?? 0) };
}
