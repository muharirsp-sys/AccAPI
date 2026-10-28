/*
 * Tujuan: SATU lembar picking berparameter pick_group — pengganti 29+ sheet `Print Rkpn *`.
 * Caller: /rekapan-nota/wave/[id]/cetak?grup=1,7 (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildRekapan, ambilPickGroup), lib/db, ../../LembarRekapan, ../../../../BingkaiCetak (WaveTidakAda).
 * Main Functions: CetakRekapanPage.
 * Side Effects: Hanya SELECT. Server component: query di server, tanpa hop API.
 */
import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { ambilPickGroup, buildRekapan } from "@/lib/rekapan-nota/query";
import { judulBerkas, nomorLembar } from "@/lib/rekapan-nota/ui";
import { WaveTidakAda } from "../../../../BingkaiCetak";
import { LembarRekapan } from "../../../LembarRekapan";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ grup?: string }> };
const grupDari = async (searchParams: Props["searchParams"]) =>
    String((await searchParams).grup ?? "").split(",").map(Number).filter(Number.isInteger);

/** Judul = nama berkas PDF saat disimpan: nomor lembar + tanggal-jam cetak (owner 20 Okt 2026). */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
    const id = Number((await params).id);
    const [w, grup] = await Promise.all([
        pool.query<{ tanggal: string }>(`SELECT tanggal::text FROM wave WHERE id = $1`, [id]),
        grupDari(searchParams).then(ambilPickGroup),
    ]);
    if (!w.rowCount) return {};
    return { title: judulBerkas(nomorLembar("RKP", w.rows[0].tanggal, id, grup.map((g) => g.kode).join("+") || "ALL")) };
}

export default async function CetakRekapanPage({ params, searchParams }: Props) {
    const id = Number((await params).id);
    const grupIds = await grupDari(searchParams);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; status: string }>(
        `SELECT nama, tanggal::text, urutan, status::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <WaveTidakAda />;

    const [grup, rekapan] = await Promise.all([ambilPickGroup(grupIds), buildRekapan(id, grupIds)]);
    return (
        <main className="cetak">
            <LembarRekapan id={id} wave={w.rows[0]} rekapan={rekapan} sekarang={new Date()}
                judul={grup.map((g) => g.nama).join("  +  ") || "SEMUA NOTA DI WAVE"}
                kodeGrup={grup.map((g) => g.kode).join("+") || "ALL"} />
        </main>
    );
}
