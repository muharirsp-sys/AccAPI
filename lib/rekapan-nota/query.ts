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

/** Nama satuan yang dihitung "karton" di master satuan Accurate (dipakai bila master Rekapan kosong). */
const SATUAN_KARTON = `('KRT','CTN','KARTON','DUS','BOX','BAL','PAK','PACK','SAK','BALL')`;

/**
 * Rasio satuan karton barang di Accurate (item.unit2..5 + ratio2..5, disinkron dari item/detail.do): satuan TERBESAR
 * yang namanya satuan karton. Butuh alias `i` (item). Diukur 24 Okt 2026: 3.761 dari 3.767 barang yang punya master
 * Rekapan DAN rasio ini bernilai sama; 193 dari 352 barang tanpa master punya rasio ini.
 */
export const RASIO_KARTON_ACCURATE_SQL = `NULLIF(round(CASE
        WHEN upper(i.unit5_name) IN ${SATUAN_KARTON} THEN i.ratio5
        WHEN upper(i.unit4_name) IN ${SATUAN_KARTON} THEN i.ratio4
        WHEN upper(i.unit3_name) IN ${SATUAN_KARTON} THEN i.ratio3
        WHEN upper(i.unit2_name) IN ${SATUAN_KARTON} THEN i.ratio2 END)::int, 0)`;

/**
 * Isi per karton satu baris (owner 24 Okt 2026: "langsung dari Accurate"): konversi yang dibawa transaksinya >
 * master Rekapan (lembar Konversi) > rasio satuan karton Accurate. Butuh alias `p` (wave_line_pool) dan `i` (item).
 * Satu-satunya salinan aturan ini -- pool, snapshot wave, exception dan lembar cetak memakainya.
 */
export const ISI_SQL = `coalesce(p.konv_tersirat, i.isi_per_karton, ${RASIO_KARTON_ACCURATE_SQL})`;

/**
 * Master outlet per KODE OUTLET fisik. Export Accurate menulis kode outlet ("C-500003"), sedangkan
 * customer.customerNo memakai akhiran principal ("C-500003-HZ", "-KN", ...). Pencocokan persis tidak pernah
 * kena, jadi area dan grup outlet selalu kosong di produksi (diukur 20 Okt 2026: 26/26 outlet "tanpa area"
 * hanya punya baris berakhiran, 22 di antaranya sudah berarea). Cocok = sama persis ATAU kode + "-" + akhiran,
 * sama dengan COCOK_OUTLET di scripts/import-rekapan-master.mjs. Kunci dibangkitkan dari sisi customer (awalan
 * sampai tiap "-") lalu equi-join, bukan LIKE bersarang ratusan kode x puluhan ribu baris.
 * @param saring kondisi SQL atas `k.kunci` (huruf besar) untuk membatasi ke kode yang dibutuhkan.
 * ponytail: membangkitkan kunci dari SEMUA customer tiap panggilan, ~1 dtk di produksi (20 Okt 2026, 32 rb baris,
 *   pool 189 outlet). Bila terasa lambat: kolom kode_outlet terindeks di customer (migrasi, zona AGENTS.md §3).
 */
export const masterOutletSql = (saring: string) => `
    SELECT k.kunci, max(upper(c.area)) AS area, max(c.grup_all) AS grup_all, max(c.grup_gdi) AS grup_gdi,
           max(c.name) AS nama, max(c.alamat) AS alamat
      FROM customer c
     CROSS JOIN LATERAL (SELECT upper(c."customerNo") AS kunci
                         UNION SELECT upper(left(c."customerNo", g - 1)) FROM generate_series(2, length(c."customerNo")) g
                          WHERE substr(c."customerNo", g, 1) = '-') k
     WHERE ${saring}
     GROUP BY k.kunci`;

/** Kondisi SQL: baris customer milik kode outlet di kolom/ekspresi `kode` (persis atau kode + "-" + akhiran). */
export const cocokOutletSql = (kode: string) =>
    `(upper(c."customerNo") = upper(${kode}) OR upper(c."customerNo") LIKE upper(${kode}) || '-%')`;

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
    return rekapanDari(bangunFilter(groups, params), params);
}

/** @param filter klausa "AND ..." atas alias wa/p (boleh kosong); params[0] WAJIB waveId. */
async function rekapanDari(filter: string, params: unknown[]): Promise<Rekapan> {
    const cte = `
        WITH baris AS (
            SELECT p.no_nota, p.customer, p.region, p.kode_barang, p.nama_barang,
                   ${ISI_SQL} AS isi_per_karton,
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

export type LembarTipe = { kode: string; judul: string; terdaftar: boolean; rekapan: Rekapan };

const JENIS_SQL = `upper(coalesce(p.jenisproduk, ''))`;
const DIVISI_HEINZ = "HEINZ ABC";

/**
 * Cetak semua (owner 24 Okt 2026): nota KEY ACCOUNT (grup outlet_all selain Gabung: Alfa & Indo, Sat & Midi, IDM & IDG, Satu Sama,
 * Ektong) dan MT GDI (outlet_gdi) dapat lembar sendiri lintas divisi, urut cetak grup, SESUDAH lembar divisi; nota itu tidak
 * muncul di lembar divisi (tiap baris tepat satu lembar). Sisanya (Gabungan): SATU lembar per DIVISI, urut nama. HEINZ ABC dipecah:
 * HNZ1..n = grup cetak dimensi area (urut cetak) untuk nota NON pareto, HNZ(n+1) = nota pareto (seperti HNZ6 Excel),
 * HNZ-ALL = Heinz non-pareto yang areanya kosong atau di luar semua grup area. Area/pareto = SNAPSHOT wave.
 * Lembar kosong tidak dibuat. Nota dua divisi muncul di kedua lembar dengan barang divisinya saja.
 * Grup jenis_produk dibuat OTOMATIS saat unggah (upload/route.ts); divisi yang grupnya tidak ada/nonaktif tetap DICETAK
 * (kode JP-<divisi>, terdaftar=false): tidak ada nota yang hilang.
 */
export async function lembarCetakSemua(waveId: number): Promise<LembarTipe[]> {
    const [divisi, terdaftar, area, ka] = await Promise.all([
        pool.query<{ jenis: string }>(
            `SELECT DISTINCT ${JENIS_SQL} AS jenis
               FROM wave_assignment wa JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
              WHERE wa.wave_id = $1 AND wa.dilepas = false`, [waveId]),
        pool.query<{ kode: string; nama: string; nilai: string }>(
            `SELECT g.kode, g.nama, upper(m.nilai) AS nilai FROM pick_group g JOIN pick_group_member m ON m.pick_group_id = g.id
              WHERE g.aktif AND g.dimensi = 'jenis_produk' ORDER BY g.urutan_cetak, g.kode`),
        pool.query<{ nama: string; nilai: string[] }>(
            `SELECT g.nama, array_agg(upper(m.nilai)) AS nilai FROM pick_group g JOIN pick_group_member m ON m.pick_group_id = g.id
              WHERE g.aktif AND g.dimensi = 'area' GROUP BY g.id ORDER BY g.urutan_cetak, g.kode`),
        // Key account (owner 24 Okt 2026): grup outlet_all / outlet_gdi selain "Gabung" -- Alfa & Indo, Sat & Midi, IDM & IDG,
        // Satu Sama, Ektong, MT GDI. Nilai "Gabung" = outlet biasa, bukan key account.
        pool.query<{ kode: string; nama: string; dimensi: string; nilai: string[] }>(
            `SELECT g.kode, g.nama, g.dimensi::text, array_agg(upper(m.nilai)) AS nilai
               FROM pick_group g JOIN pick_group_member m ON m.pick_group_id = g.id
              WHERE g.aktif AND g.dimensi IN ('outlet_all', 'outlet_gdi') AND upper(m.nilai) <> 'GABUNG'
              GROUP BY g.id ORDER BY g.urutan_cetak, g.kode`),
    ]);
    const grupDivisi = new Map(terdaftar.rows.map((r) => [r.nilai, r]));
    const semuaArea = area.rows.flatMap((g) => g.nilai);
    const kaAll = ka.rows.filter((g) => g.dimensi === "outlet_all").flatMap((g) => g.nilai);
    const kaGdi = ka.rows.filter((g) => g.dimensi === "outlet_gdi").flatMap((g) => g.nilai);
    const GRUP_ALL = `upper(coalesce(wa.snap_grup_all, ''))`;
    const GRUP_GDI = `upper(coalesce(wa.snap_grup_gdi, ''))`;

    // Tiap baris nota masuk TEPAT SATU lembar: key account outlet_all lebih dulu, lalu MT GDI (outlet_gdi), sisanya
    // (Gabungan) per divisi -- Heinz per area. `saring` menambah parameternya sendiri lewat p() supaya nomor $n benar.
    type P = (v: unknown) => string;
    const rencana: { kode: string; judul: string; terdaftar: boolean; saring: (p: P) => string }[] = [];
    const bukanKa = (p: P) => `AND ${GRUP_ALL} <> ALL(${p(kaAll)}::text[]) AND ${GRUP_GDI} <> ALL(${p(kaGdi)}::text[])`;
    for (const { jenis } of [...divisi.rows].sort((a, b) => a.jenis.localeCompare(b.jenis))) {
        if (jenis !== DIVISI_HEINZ) {
            const g = grupDivisi.get(jenis);
            rencana.push({ kode: g?.kode ?? `JP-${jenis || "TANPA DIVISI"}`, judul: g?.nama ?? (jenis || "TANPA DIVISI"),
                terdaftar: Boolean(g), saring: (p) => `${bukanKa(p)} AND ${JENIS_SQL} = ${p(jenis)}` });
            continue;
        }
        const heinz = (p: P) => `${bukanKa(p)} AND ${JENIS_SQL} = ${p(jenis)}`;
        area.rows.forEach((g, i) => rencana.push({ kode: `HNZ${i + 1}`, judul: `${DIVISI_HEINZ} · ${g.nama}`, terdaftar: true,
            saring: (p) => `${heinz(p)} AND wa.snap_pareto IS NOT TRUE AND upper(coalesce(wa.snap_area, '')) = ANY(${p(g.nilai)}::text[])` }));
        rencana.push({ kode: `HNZ${area.rows.length + 1}`, judul: `${DIVISI_HEINZ} · Pareto`, terdaftar: true,
            saring: (p) => `${heinz(p)} AND wa.snap_pareto IS TRUE` });
        rencana.push({ kode: "HNZ-ALL", judul: `${DIVISI_HEINZ} · Tanpa area`, terdaftar: true,
            saring: (p) => `${heinz(p)} AND wa.snap_pareto IS NOT TRUE AND NOT (upper(coalesce(wa.snap_area, '')) = ANY(${p(semuaArea)}::text[]))` });
    }
    for (const g of ka.rows) {
        rencana.push({ kode: g.kode, judul: g.nama, terdaftar: true, saring: g.dimensi === "outlet_all"
            ? (p) => `AND ${GRUP_ALL} = ANY(${p(g.nilai)}::text[])`
            : (p) => `AND ${GRUP_GDI} = ANY(${p(g.nilai)}::text[]) AND ${GRUP_ALL} <> ALL(${p(kaAll)}::text[])` });
    }
    const hasil: LembarTipe[] = [];
    for (const r of rencana) {
        const params: unknown[] = [waveId];
        const filter = r.saring((v) => { params.push(v); return `$${params.length}`; });
        const rekapan = await rekapanDari(filter, params);
        if (rekapan.allocation.length) hasil.push({ kode: r.kode, judul: r.judul, terdaftar: r.terdaftar, rekapan });
    }
    return hasil;
}

export type NotaPool = {
    no_nota: string; kode_cust: string; customer: string | null;
    kode_salesman: string | null; salesman: string | null; region: string | null;
    area: string | null; grup_all: string; grup_gdi: string;
    jumlah_baris: number; total_pcs: number; total_krt: number | null;
    pareto: boolean | null; kanvas: boolean;
    /** Nota memuat HEINZ ABC — hanya nota ini yang butuh area (lembar HNZ1-5). */
    heinz: boolean;
};

/**
 * Pool nota yang tersedia untuk wave berikutnya = ANTI-JOIN ke wave_assignment, bukan
 * pencocokan daftar manual (R3.2). File sore memuat nota pagi + sore sekaligus; yang
 * memisahkan mana yang sudah turun adalah keanggotaan wave, bukan isi file (R3.7).
 * Outlet ber-area NON / LUAR KOTA IKUT, sama seperti TTF di Excel (owner 19 Okt 2026; menggantikan R2.5).
 */
export async function notaPool(
    tanggal: string,
    opts: { tipe?: "reguler" | "kanvas"; ambangPareto?: number } = {},
): Promise<NotaPool[]> {
    const tipe = opts.tipe ?? "reguler";
    const ambang = opts.ambangPareto ?? 50;

    const r = await pool.query<NotaPool>(
        `WITH mo AS (${masterOutletSql(`k.kunci IN (SELECT upper(kode_cust) FROM wave_line_pool WHERE tanggal = $1::date)`)})
         SELECT p.no_nota,
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
                sum(p.qty_pcs / NULLIF(${ISI_SQL}, 0))::float8 AS total_krt,
                (sum(p.qty_pcs / NULLIF(${ISI_SQL}, 0)) >= $2)  AS pareto,
                (k.no_nota IS NOT NULL)          AS kanvas,
                bool_or(upper(coalesce(p.jenisproduk,'')) = 'HEINZ ABC') AS heinz
           FROM wave_line_pool p
           LEFT JOIN mo c       ON c.kunci = upper(p.kode_cust)
           LEFT JOIN item i     ON i.no = p.kode_barang
           LEFT JOIN nota_kanvas k ON k.no_nota = p.no_nota
          WHERE p.tanggal = $1::date
            AND NOT EXISTS (SELECT 1 FROM wave_assignment wa
                             WHERE wa.no_nota = p.no_nota AND wa.dilepas = false)
            AND (k.no_nota IS NOT NULL) = $3
          GROUP BY p.no_nota, k.no_nota
          ORDER BY p.no_nota`,
        [tanggal, ambang, tipe === "kanvas"]);
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
