/*
 * Tujuan: Perpanjang masa aktif webhook Accurate (webhook-renew.do). Tanpa ini webhook bisa
 *         kedaluwarsa dan berhenti mengirim TANPA error — cron sync 4x/hari menutupinya jadi
 *         kematiannya tidak kelihatan.
 * Caller: cron VPS (/etc/cron.d/accapi) dengan Bearer CRON_SECRET.
 * Dependensi: lib/api-security (gate), lib/accurate-session (access token).
 * Side Effects: mengubah masa aktif webhook di sisi Accurate.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";

// ponytail: pass-through respons Accurate apa adanya, tanpa retry/parse. Sekali seminggu,
// idempoten, dan kalau gagal tinggal panggil lagi. Tambah retry hanya kalau terbukti flaky.
// CATATAN: parameter webhook-renew.do belum diverifikasi live (dokumentasi Accurate hanya
// menyebut "perpanjang masa aktif webhook"). Kalau balasannya 500/parameter required, lihat
// body pass-through di response ini untuk nama parameter yang diminta.
export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    const res = await fetch("https://account.accurate.id/api/webhook-renew.do", {
        headers: { Authorization: `Bearer ${accurate.creds.apiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    console.log(`[WEBHOOK RENEW] HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 500)}`);
    return NextResponse.json({ ok: res.ok, status: res.status, accurate: body }, { status: res.ok ? 200 : 502 });
}
