/*
 * Tujuan: Laporan harian Puratos terjadwal — 10.00 WITA kirim 5 CSV siklus H-1 (owner 6 Nov 2026: tanggal 7 mengirim 45 hari s.d. 6 Nov)
 *   ke server Puratos; 11.00/12.00 hanya kirim ulang berkas yang gagal.
 * Caller: cron VPS /etc/cron.d/accapi → accapi-cron.sh dengan Bearer CRON_SECRET.
 *   ?tanggal=YYYY-MM-DD tanggal laporan lain · ?pratinjau=1 susun tanpa kirim · ?ulang=1 tarik ulang Accurate lalu kirim kelima berkas lagi.
 * Dependensi: lib/puratos/jalankan. Side Effects: lihat jalankanPuratos (baca Accurate, POST Puratos, email, arsip data/puratos).
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { hariIniWita } from "@/lib/accurate-baca";
import { jalankanPuratos } from "@/lib/puratos/jalankan";

export const maxDuration = 3600;

/** H-1 (WITA): laporan dikirim pagi untuk siklus yang berakhir kemarin. */
const kemarinWita = () => new Date(Date.parse(`${hariIniWita()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    try {
        const hasil = await jalankanPuratos({ tanggal: q.get("tanggal") || kemarinWita(), sumber: q.get("tanggal") ? "manual" : "cron",
            pratinjau: q.get("pratinjau") === "1", ulang: q.get("ulang") === "1" });
        return NextResponse.json(hasil, { status: hasil.status === "gagal" || hasil.status === "sebagian" ? 502 : 200 });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message] }, { status: 409 });
    }
}
