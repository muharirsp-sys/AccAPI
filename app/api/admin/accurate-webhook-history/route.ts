/*
 * Tujuan: Diagnostik — tanya Accurate langsung apakah webhook pernah terkirim (webhook-history.do),
 * tanpa perlu buka UI Accurate atau ambil access token terenkripsi secara manual.
 * Caller: operator lewat curl, gate sama dengan endpoint cron internal lain.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";

// dd/MM/yyyy — format tanggal Accurate di seluruh API (bukan ISO), lihat ACCURATE_API_REFERENCE.md.
const toAccurateDate = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    // webhook-history.do WAJIB parameter from/to (dibuktikan live: tanpa itu -> 500 "Parameter
    // from is required"). Default 30 hari terakhir sesuai retensi riwayat webhook Accurate;
    // ?from=dd/MM/yyyy&to=dd/MM/yyyy di query kita untuk override manual.
    const { searchParams } = new URL(req.url);
    const now = new Date();
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);
    const from = searchParams.get("from") || toAccurateDate(monthAgo);
    const to = searchParams.get("to") || toAccurateDate(now);

    // Modul pengelolaan sesi (account.accurate.id) — sama host dengan db-list.do, hanya
    // butuh Bearer access token, bukan X-Session-ID per-database.
    const url = `https://account.accurate.id/api/webhook-history.do?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accurate.creds.apiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body, { status: res.status });
}
