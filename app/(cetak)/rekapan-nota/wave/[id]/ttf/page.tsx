/*
 * Tujuan: SATU template TTF (Tanda Terima Faktur) berparameter wave — proyeksi KEDUA dari
 *         wave yang sama, bukan alur terpisah (R5.1). Varian LK tidak dibuat (Q4).
 * Caller: /rekapan-nota/wave/[id]/ttf (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildTtf), lib/db.
 * Main Functions: CetakTtfPage.
 * Side Effects: Hanya SELECT.
 */
import { pool } from "@/lib/db";
import { buildTtf } from "@/lib/rekapan-nota/query";
import TombolCetak from "../../../../TombolCetak";

export const dynamic = "force-dynamic";

export default async function CetakTtfPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number }>(
        `SELECT nama, tanggal::text, urutan FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];

    const { rows, barisPerLembar } = await buildTtf(id);
    const totalLembar = rows.reduce((a, r) => a + r.lembar, 0);

    return (
        <main className="cetak">
            <div className="layar-saja mb-4"><TombolCetak /></div>

            <h1 className="text-base font-bold">TANDA TERIMA FAKTUR &mdash; {wave.nama.toUpperCase()}</h1>
            <p className="mb-2 text-xs">Wave {wave.urutan} &middot; {wave.tanggal}</p>

            <table>
                <thead>
                    <tr>
                        <th>No</th><th>No. Faktur</th><th>Lembar</th><th>Nama Outlet</th>
                        <th>1 = SRB</th><th>Batal</th><th>Daerah</th><th>Sales</th>
                        <th>Paraf Gdg</th><th>Tgl Antr</th><th>Paraf Admin</th><th>Keterangan</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={r.no_nota}>
                            <td className="angka">{i + 1}</td>
                            <td>{r.no_nota}</td>
                            <td className="angka">{r.lembar}</td>
                            <td>{r.customer}</td>
                            {/* Kolom operasional sengaja KOSONG: diisi tangan di kertas oleh
                                gudang, sopir, dan admin pada waktu yang berbeda (R5.3). */}
                            <td></td><td></td>
                            <td>{r.region}</td>
                            <td>{r.salesman}</td>
                            <td></td><td></td><td></td><td></td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr>
                        <th colSpan={2}>TOTAL</th>
                        <th className="angka">{totalLembar}</th>
                        <th colSpan={9}>{rows.length} nota</th>
                    </tr>
                </tfoot>
            </table>

            <p className="mt-2 text-[10px]">
                Wave #{id} &middot; {rows.length} nota &middot; {totalLembar} lembar &middot;{" "}
                lembar = pembulatan ke atas dari (jumlah baris nota / {barisPerLembar}) &middot;{" "}
                dicetak {new Date().toLocaleString("id-ID")}
            </p>
        </main>
    );
}
