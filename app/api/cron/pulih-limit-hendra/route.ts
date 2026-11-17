/*
 * Tujuan: Pemulih Limit Piutang + Limit Hari pelanggan bercatatan "Hendra" (owner 17 Nov 2026, lib/pelanggan-hendra): limit
 *         yang diubah IMPOR MASSAL dikembalikan ke acuan; edit satuan menjadi acuan baru; kolom lain tidak pernah disentuh.
 * Caller: cron VPS (/etc/cron.d/accapi → accapi-cron.sh) dengan Bearer CRON_SECRET — usul tiap 15 menit. Tanpa baris cron baru pun
 *         pemulih tetap jalan di akhir /api/cron/sync-accurate (4x sehari). `?coba=1` = hanya melaporkan, tidak menulis.
 *         Env PULIH_LIMIT_HENDRA=mati = saklar darurat (pemulih berhenti; pengamat & penjaga tetap jalan).
 * Dependensi: lib/api-security (gate), lib/accurate-session (sesi sync), lib/pelanggan-hendra.
 * Side Effects: customer/save.do (id + 4 kolom limit) untuk pelanggan yang limitnya diubah impor; tabel limit_hendra_acuan.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { jalankanPulihLimitHendra, ringkasPulih } from "@/lib/pelanggan-hendra";

export const maxDuration = 600;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });

    const { sessionHost, sessionId, apiKey } = accurate.creds;
    const coba = new URL(req.url).searchParams.get("coba") === "1";
    try {
        const hasil = await jalankanPulihLimitHendra({ sessionHost, sessionId, accessToken: apiKey }, { coba });
        if ("mati" in hasil) return NextResponse.json({ ok: true, mati: true, pesan: "PULIH_LIMIT_HENDRA=mati: pemulih dimatikan" });
        if ("tertunda" in hasil) return NextResponse.json({ ok: true, tertunda: true, pesan: hasil.tertunda });
        console.log(`[PULIH LIMIT HENDRA] ${ringkasPulih(hasil)}`);
        return NextResponse.json({ ok: hasil.gagal.length === 0, ...hasil }, { status: hasil.gagal.length === 0 ? 200 : 502 });
    } catch (e) {
        console.error("[PULIH LIMIT HENDRA] galat", e instanceof Error ? e.message : e);
        return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
}
