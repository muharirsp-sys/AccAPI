/*
 * Tujuan: Perpanjang masa aktif webhook Accurate (webhook-renew.do). Tanpa ini webhook bisa
 *         kedaluwarsa dan berhenti mengirim TANPA error — cron sync 4x/hari menutupinya jadi
 *         kematiannya tidak kelihatan. Masa aktif webhook 7 hari (terverifikasi live).
 * Caller: cron VPS (/etc/cron.d/accapi) dengan Bearer CRON_SECRET.
 * Dependensi: lib/api-security (gate), lib/accurate-session (access token).
 * Side Effects: mengubah masa aktif webhook di sisi Accurate.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";

// ponytail: pass-through respons Accurate apa adanya, tanpa retry/parse. Sekali seminggu,
// idempoten, dan kalau gagal tinggal panggil lagi. Tambah retry hanya kalau terbukti flaky.
// Diverifikasi live 2026-08-19: GET tanpa parameter apa pun -> {"s":true,"d":"26/08/2026"},
// yaitu tanggal kedaluwarsa BARU. Masa aktif webhook Accurate cuma 7 HARI — karena itu cron-nya
// HARIAN (0 4 * * *), bukan mingguan: kalau mingguan, satu run gagal = webhook mati sampai
// minggu berikutnya, dan matinya senyap (sync 4x/hari menutupi gejalanya).
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
