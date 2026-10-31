/*
 * Tujuan: Laporan Enigma (Enesis / Marketama Indah) terjadwal — 20.30 WITA (ulang 21.30/22.30 hanya bila gagal teknis), unggah portal; akhir bulan ditahan.
 * Caller: cron VPS /etc/cron.d/accapi → accapi-cron.sh dengan Bearer CRON_SECRET. ?tanggal=YYYY-MM-DD untuk tanggal lain.
 * Dependensi: lib/enigma/jalankan. Side Effects: lihat jalankanEnigma (baca Accurate, unggah enigma.enesis.com, email admin).
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { hariIniWita } from "@/lib/accurate-baca";
import { jalankanEnigma } from "@/lib/enigma/jalankan";

export const maxDuration = 3600;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;
    const tanggal = new URL(req.url).searchParams.get("tanggal") || hariIniWita();
    try {
        const hasil = await jalankanEnigma({ tanggal, kirim: true, sumber: "cron" });
        return NextResponse.json(hasil, { status: hasil.status === "gagal" ? 502 : 200 });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message] }, { status: 409 });
    }
}
