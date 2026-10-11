/*
 * Tujuan: Cron pembaca pelunasan Kasir ↔ Incaso (K1b, BL-59): segarkan cache pelunasan Accurate hari ini (WITA) + hari sebelumnya
 *   sampai hari kerja sebelumnya (Senin: Sabtu & Minggu), berurutan — status tersimpan per tanggal terlihat di UI/Beranda.
 * Caller: crontab VPS (Bearer CRON_SECRET), dipasang IT. Usul jadwal K-2: tiap 15 menit 07.00–21.00 WITA Senin–Sabtu + `?penuh=1`
 *   sekali 19.30 WITA (faktur yang disunting mengganti salesman TANPA mengubah lastUpdate pelunasan).
 * Dependensi: lib/kasir/baca-pelunasan, lib/kasir/pembaca (tanggalCron), lib/api-security (requireCronSecret).
 * Main Functions: GET ?tanggal=YYYY-MM-DD (satu tanggal), ?penuh=1 (baca ulang semua detail), ?check=1 (laporan status tanpa Accurate).
 *   200 bila SEMUA tanggal lengkap; 202 bila sisanya hanya `sedang_dibaca` (tombol/cron lain memegang lease — bukan galat); sesi sinkron
 *   mati -> 503; selain itu 502 dengan rincian. `penuh=1` yang bertemu lease pemegang lain MENUNGGU (tiap 5 dtk) sampai lease selesai /
 *   kedaluwarsa, baru menyerah `PENUH_TERTUNDA` (502) — baca penuh 19.30 tidak hilang karena bertabrakan dengan cron tiap 15 menit.
 * Side Effects: GET Accurate sales-receipt list.do/detail.do (baca-saja) + tulis cache kasir_pelunasan, kasir_pelunasan_faktur, kasir_pelunasan_baca. ?check=1 = SELECT saja.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { todayWita } from "@/lib/insentif-payment-date";
import { bacaPelunasanHari, bawaan, databaseIdSinkron, LEASE_DETIK, publikkan, statusBaca, type HasilBaca } from "@/lib/kasir/baca-pelunasan";
import { PESAN_SESI_SINKRON, tanggalCron, tanggalSah } from "@/lib/kasir/pembaca";

export const runtime = "nodejs";
export const maxDuration = 900;

/** Putaran `sebagian` (batas waktu 45 dtk per putaran) dilanjutkan paling banyak sekian kali per tanggal per run. */
const MAKS_LANJUT = 3;
/** Baca penuh menunggu lease pemegang lain: jeda antarpercobaan dan batas tunggu per tanggal (> lease 2 mnt). */
const JEDA_TUNGGU_MS = 5_000;
const TUNGGU_PENUH_MS = (LEASE_DETIK + 30) * 1000;
/** Tidak memulai putaran baru sesudah ini (curl --max-time 900; satu putaran ≤ ±70 dtk). */
const BATAS_ROUTE_MS = 780_000;

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
                status: databaseId ? await Promise.all(daftar.map(async (t) => publikkan(await statusBaca(databaseId, t)))) : [] });
        }
        const batasRoute = bawaan.sekarang() + BATAS_ROUTE_MS;
        const hasil: Record<string, unknown>[] = [];
        for (const tanggal of daftar) {
            if (bawaan.sekarang() >= batasRoute) {
                hasil.push({ tanggal, status: "tidak_sempat", kode: "BATAS_ROUTE", pesan: "Batas waktu cron habis sebelum tanggal ini dibaca." });
                continue;
            }
            let h: HasilBaca = await bacaPelunasanHari({ tanggal, pemicu: "cron", penuh });
            if (penuh) {
                const batasTunggu = Math.min(bawaan.sekarang() + TUNGGU_PENUH_MS, batasRoute);
                while (h.jenis === "sedang_dibaca" && bawaan.sekarang() + JEDA_TUNGGU_MS <= batasTunggu) {
                    await bawaan.tidur(JEDA_TUNGGU_MS);
                    h = await bacaPelunasanHari({ tanggal, pemicu: "cron", penuh });
                }
            }
            // Lanjutan TANPA penuh: baca penuh menandai cache basi, jadi sisa yang belum terbaca tetap dibaca.
            for (let i = 0; i < MAKS_LANJUT && h.jenis === "selesai" && h.status.status === "sebagian" && bawaan.sekarang() < batasRoute; i++) {
                h = await bacaPelunasanHari({ tanggal, pemicu: "cron" });
            }
            if (h.jenis === "kredensial") {
                return NextResponse.json({ ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, detail: h.pesan, hasil }, { status: 503 });
            }
            const s = h.status;
            const sibuk = h.jenis === "sedang_dibaca" || h.jenis === "lease_hilang";
            // PENUH_TERTUNDA dicatat di baris status (terlihat UI) dan klaim berikutnya (cron 15 menit / tombol) menjalankan baca penuh.
            if (penuh && sibuk) await bawaan.toko().tandaiPenuhTertunda(s.databaseId, tanggal);
            hasil.push({ tanggal, jenis: h.jenis, status: sibuk ? "sedang_dibaca" : s.status, sebab: s.sebab, pesan: s.pesan, jumlahDaftar: s.jumlahDaftar,
                sisaDetail: s.sisaDetail, ditolak: s.ditolak.length,
                ...(sibuk ? penuh ? { kode: "PENUH_TERTUNDA", keterangan: "Baca penuh menunggu pembaca lain sampai batas waktu — dicatat; klaim berikutnya membaca penuh." }
                    : { keterangan: "Dibaca pembaca lain (tombol/cron lain) — tanggal ini dilewati, bukan galat." } : {}) });
        }
        const lengkap = hasil.every((r) => r.status === "lengkap");
        // Cron biasa yang bertemu lease pemegang lain bukan galat (202); baca penuh yang menyerah sesudah menunggu = galat (PENUH_TERTUNDA).
        const terima = !lengkap && hasil.every((r) => r.status === "lengkap" || (r.status === "sedang_dibaca" && !r.kode));
        const sesi = hasil.some((r) => r.sebab === "sesi_sinkron");
        return NextResponse.json({ ok: lengkap || terima, ...(sesi ? { kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON } : {}), hasil },
            { status: lengkap ? 200 : terima ? 202 : sesi ? 503 : 502 });
    } catch (error) {
        console.error("[CRON KASIR PELUNASAN]", error);
        return NextResponse.json({ ok: false, error: "Gagal membaca pelunasan Accurate." }, { status: 500 });
    }
}
