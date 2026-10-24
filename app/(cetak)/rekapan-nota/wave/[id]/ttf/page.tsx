/*
 * Tujuan: Halaman cetak TTF (Tanda Terima Faktur) satu wave. Varian LK tidak dibuat (Q4).
 * Caller: /rekapan-nota/wave/[id]/ttf (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildTtf), lib/db, ../../LembarTtf.
 * Main Functions: CetakTtfPage.
 * Side Effects: Hanya SELECT.
 */
import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { buildTtf } from "@/lib/rekapan-nota/query";
import { judulBerkas, nomorLembar } from "@/lib/rekapan-nota/ui";
import { LembarTtf } from "../../../LembarTtf";

export const dynamic = "force-dynamic";

/** Judul = nama berkas PDF saat disimpan: nomor TTF + tanggal-jam cetak (owner 20 Okt 2026). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
    const id = Number((await params).id);
    const w = await pool.query<{ tanggal: string }>(`SELECT tanggal::text FROM wave WHERE id = $1`, [id]);
    return w.rowCount ? { title: judulBerkas(nomorLembar("TTF", w.rows[0].tanggal, id)) } : {};
}

export default async function CetakTtfPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; tipe: string }>(
        `SELECT nama, tanggal::text, urutan, tipe::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    return (
        <main className="cetak">
            <LembarTtf id={id} wave={w.rows[0]} ttf={await buildTtf(id)} sekarang={new Date()} />
        </main>
    );
}
