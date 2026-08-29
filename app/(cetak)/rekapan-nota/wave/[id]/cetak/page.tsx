/*
 * Tujuan: SATU template lembar rekapan berparameter pick_group — pengganti 29+ sheet
 *         `Print Rkpn *` / `Print Rekapan *`. Withdrawal (kolom A-H) dan allocation
 *         (kolom J-K) dicetak berdampingan, dua proyeksi dari SATU CTE.
 * Caller: /rekapan-nota/wave/[id]/cetak?grup=1,2 (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildRekapan, ambilPickGroup), lib/db.
 * Main Functions: CetakRekapanPage.
 * Side Effects: Hanya SELECT. Server component: query dijalankan di server, bukan lewat API.
 */
import { pool } from "@/lib/db";
import { ambilPickGroup, buildRekapan } from "@/lib/rekapan-nota/query";
import TombolCetak from "../../../../TombolCetak";

export const dynamic = "force-dynamic";

const angka = (v: number | null | undefined, desimal = 0) =>
    v === null || v === undefined ? "" : Number(v).toLocaleString("id-ID", {
        minimumFractionDigits: desimal, maximumFractionDigits: desimal,
    });

export default async function CetakRekapanPage({
    params, searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ grup?: string }>;
}) {
    const id = Number((await params).id);
    const grupIds = String((await searchParams).grup ?? "")
        .split(",").map(Number).filter(Number.isInteger);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; status: string }>(
        `SELECT nama, tanggal::text, urutan, status::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];

    const [grup, rekapan] = await Promise.all([ambilPickGroup(grupIds), buildRekapan(id, grupIds)]);
    const { withdrawal, allocation, ringkasan } = rekapan;
    const baris = Math.max(withdrawal.length, allocation.length);
    const dicetakPada = new Date().toLocaleString("id-ID");

    return (
        <main className="cetak">
            <div className="layar-saja mb-4"><TombolCetak /></div>

            <h1 className="text-base font-bold">
                REKAPAN NOTA &mdash; {grup.map((g) => g.nama).join(" + ") || "SEMUA NOTA DI WAVE"}
            </h1>
            <p className="mb-2 text-xs">
                Wave {wave.urutan} &quot;{wave.nama}&quot; &middot; {wave.tanggal} &middot; status {wave.status}
            </p>

            <table>
                <thead>
                    <tr>
                        <th colSpan={7}>PENGAMBILAN BARANG</th>
                        <th colSpan={3}>NOMOR NOTA &amp; RAYON</th>
                    </tr>
                    <tr>
                        <th>Kode Barang</th><th>Nama Barang</th><th>Total</th><th>Konv</th>
                        <th>Krt Desimal</th><th>Sat Bsr</th><th>Sat Kcl</th>
                        <th>Nomor Nota</th><th>Rayon</th><th>Pcs</th>
                    </tr>
                </thead>
                <tbody>
                    {Array.from({ length: baris }, (_, i) => {
                        const wRow = withdrawal[i];
                        const aRow = allocation[i];
                        // Konversi tidak ada -> Sat Bsr/Sat Kcl kosong, barisnya TETAP tercetak (R1.3).
                        const tanpaKonversi = wRow && (wRow.isi_per_karton === null || wRow.isi_per_karton === 0);
                        return (
                            <tr key={i}>
                                <td>{wRow?.kode_barang ?? ""}</td>
                                <td>{wRow?.nama_barang ?? ""}</td>
                                <td className="angka">{angka(wRow?.total_pcs)}</td>
                                <td className="angka">{tanpaKonversi ? "?" : angka(wRow?.isi_per_karton)}</td>
                                <td className="angka">{angka(wRow?.krt_desimal, 2)}</td>
                                <td className="angka">{angka(wRow?.sat_bsr)}</td>
                                <td className="angka">{angka(wRow?.sat_kcl)}</td>
                                <td>{aRow ? `${aRow.prioritas === "urgent" ? "* " : ""}${aRow.no_nota}` : ""}</td>
                                <td>{aRow?.region ?? ""}</td>
                                <td className="angka">{angka(aRow?.total_pcs)}</td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <th colSpan={2}>TOTAL</th>
                        <th className="angka">{angka(ringkasan.totalPcs)}</th>
                        <th colSpan={4}></th>
                        <th colSpan={2}>{ringkasan.jumlahNota} nota</th>
                        <th className="angka">{angka(allocation.reduce((a, r) => a + Number(r.total_pcs), 0))}</th>
                    </tr>
                </tfoot>
            </table>

            {/* Kertas yang tergeletak di gudang harus bisa menjawab "ini cetakan yang mana?" (R7.4). */}
            <p className="mt-2 text-[10px]">
                Wave #{id} &middot; grup {grup.map((g) => g.kode).join("+") || "(semua)"} &middot;{" "}
                {ringkasan.jumlahSku} SKU &middot; {ringkasan.jumlahNota} nota &middot;{" "}
                {angka(ringkasan.totalPcs)} pcs &middot; dicetak {dicetakPada}
                {" "}&middot; tanda * = urgent, tanda ? = item belum punya konversi
            </p>
        </main>
    );
}
