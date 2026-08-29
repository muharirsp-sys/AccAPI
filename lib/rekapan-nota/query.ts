/*
 * Tujuan: Dua proyeksi rekapan (withdrawal per SKU + allocation per nota) dari SATU CTE,
 *         plus TTF per nota. Inilah yang membuat balance jadi jaminan struktural: selama
 *         himpunan baris sumbernya sama, selisih tidak mungkin terjadi.
 * Caller: app/(dashboard)/rekapan-nota/wave/[id]/cetak & ttf, API pool/wave.
 * Dependensi: lib/db (pool pg), lib/rekapan-nota/classify.
 * Main Functions: buildRekapan, buildTtf, ambilPickGroup, ambilSetting.
 * Side Effects: Hanya SELECT.
 */
import { pool } from "@/lib/db";

export type PickGroupRow = { id: number; kode: string; nama: string; dimensi: string; nilai: string[] };

export type WithdrawalRow = {
    kode_barang: string; nama_barang: string | null; isi_per_karton: number | null;
    total_pcs: number; krt_desimal: number | null; sat_bsr: number | null; sat_kcl: number | null;
};
export type AllocationRow = {
    no_nota: string; customer: string | null; region: string | null;
    prioritas: string; total_pcs: number;
};
export type Rekapan = {
    withdrawal: WithdrawalRow[];
    allocation: AllocationRow[];
    ringkasan: { jumlahSku: number; jumlahNota: number; totalPcs: number };
};

export async function ambilSetting(key: string, fallback: string): Promise<string> {
    const r = await pool.query<{ value: string }>(`SELECT value FROM app_setting WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? fallback;
}

export async function ambilPickGroup(ids: number[]): Promise<PickGroupRow[]> {
    if (!ids.length) return [];
    const r = await pool.query<PickGroupRow>(
        `SELECT g.id, g.kode, g.nama, g.dimensi::text AS dimensi,
                coalesce(array_agg(m.nilai) FILTER (WHERE m.nilai IS NOT NULL), '{}') AS nilai
           FROM pick_group g
           LEFT JOIN pick_group_member m ON m.pick_group_id = g.id
          WHERE g.id = ANY($1::bigint[])
          GROUP BY g.id
          ORDER BY g.urutan_cetak, g.kode`, [ids]);
    return r.rows;
}

/** Ekspresi SRP/NON di SQL — satu-satunya salinan aturan R6.5 di sisi query. */
const EKSPRESI_SIRUP = `CASE WHEN upper(coalesce(p.jenisproduk,'')) <> 'HEINZ ABC' THEN NULL
        WHEN upper(coalesce(p.kode_barang,'')) LIKE 'A1092%'
          OR upper(coalesce(p.nama_barang,'')) LIKE '%SIRUP%' THEN 'SIRUP'
        ELSE 'NON SIRUP' END`;

/**
 * Grup dari dimensi berbeda di-AND-kan, grup dalam dimensi sama di-OR-kan — persis seperti
 * pivot Excel memakai filter Area DAN filter Pareto sekaligus. Tanpa ini, "cetak HNZ1"
 * (area 1/10/PGU DAN non-pareto) tidak bisa dinyatakan sama sekali.
 */
function bangunFilter(groups: PickGroupRow[], params: unknown[]): string {
    const perDimensi = new Map<string, string[]>();
    for (const g of groups) {
        const nilai = perDimensi.get(g.dimensi) ?? [];
        nilai.push(...g.nilai);
        perDimensi.set(g.dimensi, nilai);
    }

    const klausa: string[] = [];
    for (const [dimensi, nilai] of perDimensi) {
        if (!nilai.length) continue;
        if (dimensi === "volume") {
            const set = new Set(nilai.map((v) => v.toUpperCase()));
            if (set.size === 2) continue; // pareto + non pareto = tanpa penyaringan
            klausa.push(`wa.snap_pareto IS NOT DISTINCT FROM ${set.has("PARETO") ? "true" : "false"}`);
            continue;
        }
        const kolom = dimensi === "area" ? "wa.snap_area"
            : dimensi === "outlet_all" ? "wa.snap_grup_all"
            : dimensi === "outlet_gdi" ? "wa.snap_grup_gdi"
            : dimensi === "jenis_produk" ? "p.jenisproduk"
            : dimensi === "sirup" ? `(${EKSPRESI_SIRUP})`
            : null;
        if (!kolom) continue;
        params.push(nilai);
        klausa.push(`${kolom} = ANY($${params.length}::text[])`);
    }
    return klausa.length ? `AND ${klausa.join(" AND ")}` : "";
}

/**
 * Satu CTE `baris`, dua GROUP BY. Withdrawal digroup HANYA per kode_barang: kalau digroup
 * ikut isi_per_karton, satu SKU yang konversinya beda antar baris akan tercetak dua kali —
 * persis kelas kesalahan yang bikin gudang mengambil dobel.
 */
export async function buildRekapan(waveId: number, groupIds: number[]): Promise<Rekapan> {
    const groups = await ambilPickGroup(groupIds);
    const params: unknown[] = [waveId];
    const filter = bangunFilter(groups, params);

    const cte = `
        WITH baris AS (
            SELECT p.no_nota, p.customer, p.region, p.kode_barang, p.nama_barang,
                   coalesce(p.konv_tersirat, i.isi_per_karton) AS isi_per_karton,
                   p.qty_pcs, wa.prioritas
              FROM wave_assignment wa
              JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
              LEFT JOIN item i ON i.no = p.kode_barang
             WHERE wa.wave_id = $1 AND wa.dilepas = false ${filter}
        )`;

    // NULLIF -> NULL, bukan error, saat konversi tidak ada: barisnya TETAP tercetak dengan
    // Sat Bsr/Sat Kcl kosong (R1.3) — kebalikan dari Excel yang menghilangkan notanya.
    const withdrawal = await pool.query<WithdrawalRow>(`${cte}
        SELECT kode_barang,
               min(nama_barang)                                   AS nama_barang,
               max(isi_per_karton)::int                           AS isi_per_karton,
               sum(qty_pcs)::float8                               AS total_pcs,
               (sum(qty_pcs) / NULLIF(max(isi_per_karton), 0))::float8 AS krt_desimal,
               floor(sum(qty_pcs) / NULLIF(max(isi_per_karton), 0))::int AS sat_bsr,
               (sum(qty_pcs) - floor(sum(qty_pcs) / NULLIF(max(isi_per_karton), 0))
                    * max(isi_per_karton))::float8                AS sat_kcl
          FROM baris GROUP BY kode_barang ORDER BY kode_barang`, params);

    const allocation = await pool.query<AllocationRow>(`${cte}
        SELECT no_nota, min(customer) AS customer, min(region) AS region,
               min(prioritas::text) AS prioritas, sum(qty_pcs)::float8 AS total_pcs
          FROM baris GROUP BY no_nota
          ORDER BY min(prioritas::text) DESC, no_nota`, params);

    const totalPcs = withdrawal.rows.reduce((a, r) => a + Number(r.total_pcs), 0);
    return {
        withdrawal: withdrawal.rows,
        allocation: allocation.rows,
        ringkasan: {
            jumlahSku: withdrawal.rows.length,
            jumlahNota: allocation.rows.length,
            totalPcs,
        },
    };
}

export type NotaPool = {
    no_nota: string; kode_cust: string; customer: string | null;
    kode_salesman: string | null; salesman: string | null; region: string | null;
    area: string | null; grup_all: string; grup_gdi: string;
    jumlah_baris: number; total_pcs: number; total_krt: number | null;
    pareto: boolean | null; kanvas: boolean;
};

/**
 * Pool nota yang tersedia untuk wave berikutnya = ANTI-JOIN ke wave_assignment, bukan
 * pencocokan daftar manual (R3.2). File sore memuat nota pagi + sore sekaligus; yang
 * memisahkan mana yang sudah turun adalah keanggotaan wave, bukan isi file (R3.7).
 */
export async function notaPool(
    tanggal: string,
    opts: { tipe?: "reguler" | "kanvas"; areaDikecualikan?: string[]; ambangPareto?: number } = {},
): Promise<NotaPool[]> {
    const tipe = opts.tipe ?? "reguler";
    const dikecualikan = (opts.areaDikecualikan ?? ["NON", "LUAR KOTA"]).map((a) => a.toUpperCase());
    const ambang = opts.ambangPareto ?? 50;

    const r = await pool.query<NotaPool>(
        `SELECT p.no_nota,
                min(p.kode_cust)                 AS kode_cust,
                min(p.customer)                  AS customer,
                min(p.kode_salesman)             AS kode_salesman,
                min(p.salesman)                  AS salesman,
                min(p.region)                    AS region,
                max(upper(c.area))               AS area,
                coalesce(max(c.grup_all), 'Gabung') AS grup_all,
                coalesce(max(c.grup_gdi), 'Gabung') AS grup_gdi,
                count(*)::int                    AS jumlah_baris,
                sum(p.qty_pcs)::float8           AS total_pcs,
                sum(p.qty_pcs / NULLIF(coalesce(p.konv_tersirat, i.isi_per_karton), 0))::float8 AS total_krt,
                (sum(p.qty_pcs / NULLIF(coalesce(p.konv_tersirat, i.isi_per_karton), 0)) >= $3)  AS pareto,
                (k.no_nota IS NOT NULL)          AS kanvas
           FROM wave_line_pool p
           LEFT JOIN customer c ON c."customerNo" = p.kode_cust
           LEFT JOIN item i     ON i.no = p.kode_barang
           LEFT JOIN nota_kanvas k ON k.no_nota = p.no_nota
          WHERE p.tanggal = $1::date
            AND NOT EXISTS (SELECT 1 FROM wave_assignment wa
                             WHERE wa.no_nota = p.no_nota AND wa.dilepas = false)
            AND (k.no_nota IS NOT NULL) = $4
          GROUP BY p.no_nota, k.no_nota
         HAVING coalesce(max(upper(c.area)), '') <> ALL ($2::text[])
          ORDER BY p.no_nota`,
        [tanggal, dikecualikan, ambang, tipe === "kanvas"]);
    return r.rows;
}

export type TtfRow = {
    no_nota: string; customer: string | null; region: string | null;
    salesman: string | null; kota: string | null; jumlah_baris: number; lembar: number;
};

/** Proyeksi kedua dari wave yang sama, bukan alur terpisah (R5.1). */
export async function buildTtf(waveId: number): Promise<{ rows: TtfRow[]; barisPerLembar: number }> {
    const barisPerLembar = Number(await ambilSetting("rekapan.baris_per_lembar_faktur", "13")) || 13;
    const r = await pool.query<TtfRow>(
        `SELECT p.no_nota,
                min(p.customer)  AS customer,
                min(p.region)    AS region,
                min(p.salesman)  AS salesman,
                min(p.kota)      AS kota,
                count(*)::int    AS jumlah_baris,
                greatest(ceil(count(*)::numeric / $2), 1)::int AS lembar
           FROM wave_assignment wa
           JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
          WHERE wa.wave_id = $1 AND wa.dilepas = false
          GROUP BY p.no_nota
          ORDER BY p.no_nota`, [waveId, barisPerLembar]);
    return { rows: r.rows, barisPerLembar };
}
