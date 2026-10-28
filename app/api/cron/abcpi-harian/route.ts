/*
 * Tujuan: Laporan harian ABCPI terjadwal — 20.00 WITA (ulang 21.00/22.00 untuk kanal yang gagal), FTP + email; akhir bulan ditahan.
 * Caller: cron VPS /etc/cron.d/accapi → accapi-cron.sh dengan Bearer CRON_SECRET. ?tanggal=YYYY-MM-DD untuk mengulang hari lain.
 * Dependensi: lib/abcpi/jalankan. Side Effects: lihat jalankanAbcpi (baca Accurate, FTP, email, arsip data/abcpi).
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { hariIniWita, jalankanAbcpi } from "@/lib/abcpi/jalankan";

export const maxDuration = 3600;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;
    const tanggal = new URL(req.url).searchParams.get("tanggal") || hariIniWita();
    try {
        const hasil = await jalankanAbcpi({ tanggal, kirim: true, sumber: "cron" });
        return NextResponse.json(hasil, { status: hasil.status === "gagal" || hasil.status === "sebagian" ? 502 : 200 });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message] }, { status: 409 });
    }
}
