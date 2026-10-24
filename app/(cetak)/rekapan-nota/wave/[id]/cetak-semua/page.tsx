/*
 * Tujuan: Cetak semua (owner 24 Okt 2026) — SEMUA tipe rekapan satu wave + TTF dalam satu cetakan/PDF:
 *   satu lembar per divisi, Heinz per area (HNZ1..), pareto, tanpa area (HNZ-ALL), lalu TTF. Tiap lembar bernomor sendiri
 *   (RKP/<yymm>/<wave>/<kode>) dengan "Halaman X dari Y" sendiri.
 * Caller: tombol "Cetak semua" di /rekapan-nota/wave/[id] (aktif sesudah Rilis).
 * Dependensi: lib/rekapan-nota/query (lembarCetakSemua, buildTtf), lib/db, ../../../LembarRekapan, ../../../LembarTtf.
 * Main Functions: CetakSemuaPage.
 * Side Effects: Hanya SELECT.
 */
import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { buildTtf, lembarCetakSemua } from "@/lib/rekapan-nota/query";
import { judulBerkas, nomorLembar } from "@/lib/rekapan-nota/ui";
import { LembarRekapan } from "../../../LembarRekapan";
import { LembarTtf } from "../../../LembarTtf";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Judul = nama berkas PDF: RKP-<yymm>-<wave>-SEMUA_<yyyymmdd-HHmm>. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const id = Number((await params).id);
    const w = await pool.query<{ tanggal: string }>(`SELECT tanggal::text FROM wave WHERE id = $1`, [id]);
    return w.rowCount ? { title: judulBerkas(nomorLembar("RKP", w.rows[0].tanggal, id, "SEMUA")) } : {};
}

export default async function CetakSemuaPage({ params }: Props) {
    const id = Number((await params).id);
    const w = await pool.query<{ nama: string; tanggal: string; status: string; tipe: string }>(
        `SELECT nama, tanggal::text, status::text, tipe::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];
    const [lembar, ttf] = await Promise.all([lembarCetakSemua(id), buildTtf(id)]);
    const sekarang = new Date();
    return (
        <main className="cetak cetak-semua">
            {lembar.map((l) => (
                <div key={l.kode}>
                    <LembarRekapan id={id} wave={wave} judul={l.judul} kodeGrup={l.kode} rekapan={l.rekapan} sekarang={sekarang}
                        catatan={l.terdaftar ? undefined : "Divisi belum terdaftar"} />
                </div>
            ))}
            <div><LembarTtf id={id} wave={wave} ttf={ttf} sekarang={sekarang} /></div>
        </main>
    );
}
