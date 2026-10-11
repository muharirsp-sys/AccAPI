/*
 * Tujuan: Cron pembaca pelunasan Kasir ↔ Incaso (K1b, BL-59): segarkan cache pelunasan Accurate hari ini (WITA) + hari sebelumnya
 *   sampai hari kerja sebelumnya (Senin: Sabtu & Minggu), berurutan — status tersimpan per tanggal terlihat di UI/Beranda.
 * Caller: crontab VPS (Bearer CRON_SECRET), dipasang IT. Usul jadwal K-2: tiap 15 menit 07.00–21.00 WITA Senin–Sabtu + `?penuh=1`
 *   sekali 19.30 WITA (faktur yang disunting mengganti salesman TANPA mengubah lastUpdate pelunasan).
 * Dependensi: lib/kasir/baca-pelunasan, lib/kasir/pembaca (tanggalCron), lib/api-security (requireCronSecret).
 * Main Functions: GET ?tanggal=YYYY-MM-DD (satu tanggal), ?penuh=1 (baca ulang semua detail), ?check=1 (laporan status tanpa Accurate).
 *   200 hanya bila SEMUA tanggal lengkap; sesi sinkron mati -> 503; selain itu 502 dengan rincian per tanggal.
 * Side Effects: GET Accurate sales-receipt list.do/detail.do (baca-saja) + tulis cache kasir_pelunasan, kasir_pelunasan_faktur, kasir_pelunasan_baca. ?check=1 = SELECT saja.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { todayWita } from "@/lib/insentif-payment-date";
import { bacaPelunasanHari, databaseIdSinkron, statusBaca, type HasilBaca } from "@/lib/kasir/baca-pelunasan";
import { PESAN_SESI_SINKRON, tanggalCron, tanggalSah } from "@/lib/kasir/pembaca";

export const runtime = "nodejs";
export const maxDuration = 900;

/** Putaran `sebagian` (batas waktu 45 dtk per putaran) dilanjutkan paling banyak sekian kali per tanggal per run. */
const MAKS_LANJUT = 3;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;
    const sp = new URL(req.url).searchParams;
    const hariIni = todayWita(new Date());
    const satu = sp.get("tanggal");
    if (satu !== null && (!tanggalSah(satu) || satu > hariIni)) {
        return NextResponse.json({ ok: false, error: `tanggal wajib YYYY-MM-DD dan tidak melewati hari ini (${hariIni} WITA)` }, { status: 400 });
    }
    const daftar = satu ? [satu] : tanggalCron(hariIni);
    const penuh = sp.get("penuh") === "1";
    try {
        if (sp.get("check") === "1") {
            const databaseId = await databaseIdSinkron();
            return NextResponse.json({ ok: true, checkOnly: true, penuh, tanggal: daftar, sesiSinkron: Boolean(databaseId),
                status: databaseId ? await Promise.all(daftar.map((t) => statusBaca(databaseId, t))) : [] });
        }
        const hasil: Record<string, unknown>[] = [];
        for (const tanggal of daftar) {
            let h: HasilBaca = await bacaPelunasanHari({ tanggal, pemicu: "cron", penuh });
            // Lanjutan TANPA penuh: baca penuh menandai cache basi, jadi sisa yang belum terbaca tetap dibaca.
            for (let i = 0; i < MAKS_LANJUT && h.jenis === "selesai" && h.status.status === "sebagian"; i++) {
                h = await bacaPelunasanHari({ tanggal, pemicu: "cron" });
            }
            if (h.jenis === "kredensial") {
                return NextResponse.json({ ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, detail: h.pesan, hasil }, { status: 503 });
            }
            const s = h.status;
            hasil.push({ tanggal, jenis: h.jenis, status: s.status, sebab: s.sebab, pesan: s.pesan, jumlahDaftar: s.jumlahDaftar, sisaDetail: s.sisaDetail,
                ditolak: s.ditolak.length });
        }
        const lengkap = hasil.every((r) => r.status === "lengkap");
        const sesi = hasil.some((r) => r.sebab === "sesi_sinkron");
        return NextResponse.json({ ok: lengkap, ...(sesi ? { kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON } : {}), hasil },
            { status: lengkap ? 200 : sesi ? 503 : 502 });
    } catch (error) {
        console.error("[CRON KASIR PELUNASAN]", error);
        return NextResponse.json({ ok: false, error: "Gagal membaca pelunasan Accurate." }, { status: 500 });
    }
}
