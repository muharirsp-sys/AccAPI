/*
 * Tujuan: Diagnostik — tanya Accurate langsung apakah webhook pernah terkirim (webhook-history.do),
 * tanpa perlu buka UI Accurate atau ambil access token terenkripsi secara manual.
 * Caller: operator lewat curl, gate sama dengan endpoint cron internal lain.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    // Modul pengelolaan sesi (account.accurate.id) — sama host dengan db-list.do, hanya
    // butuh Bearer access token, bukan X-Session-ID per-database.
    const res = await fetch("https://account.accurate.id/api/webhook-history.do", {
        headers: { Authorization: `Bearer ${accurate.creds.apiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body, { status: res.status });
}
