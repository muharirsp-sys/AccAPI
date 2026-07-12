/*
 * Tujuan: Trigger sync terjadwal Accurate -> cache lokal (Audit F2+F3, prasyarat PRD 02/03/04).
 * Caller: Scheduler eksternal (Coolify scheduled task / cron) dengan Bearer CRON_SECRET.
 * Kredensial Accurate: userId dari env ACCURATE_SYNC_USER_ID, fallback sesi OAuth terbaru.
 * Side Effects: tulis tabel item/customer/sales_invoice/sales_return + sync_state.
 */
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateOAuthSession } from "@/db/schema";
import { requireCronSecret } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";
import { SYNC_MODULE_NAMES, syncModule, type SyncModuleName } from "@/lib/sync";

export const maxDuration = 3600; // sync penuh bisa lama; jalan out-of-band, bukan request user

async function resolveSyncUserId(): Promise<string | null> {
    const fromEnv = (process.env.ACCURATE_SYNC_USER_ID || "").trim();
    if (fromEnv) return fromEnv;
    const [latest] = await db.select({ userId: accurateOAuthSession.userId })
        .from(accurateOAuthSession)
        .orderBy(desc(accurateOAuthSession.updatedAt))
        .limit(1);
    return latest?.userId ?? null;
}

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const url = new URL(req.url);
    const requested = (url.searchParams.get("modules") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const modules = (requested.length > 0 ? requested : SYNC_MODULE_NAMES)
        .filter((m): m is SyncModuleName => (SYNC_MODULE_NAMES as string[]).includes(m));
    if (modules.length === 0) {
        return NextResponse.json({ ok: false, error: `modules tidak valid. Pilihan: ${SYNC_MODULE_NAMES.join(",")}` }, { status: 400 });
    }

    const userId = await resolveSyncUserId();
    if (!userId) {
        return NextResponse.json({ ok: false, error: "Tidak ada sesi Accurate. Set ACCURATE_SYNC_USER_ID atau login Accurate dulu." }, { status: 503 });
    }
    const session = await getAccurateSession(userId);
    if (!session?.sessionHost || !session.sessionId || !session.accessToken) {
        return NextResponse.json({ ok: false, error: "Sesi Accurate belum lengkap (host/session/token)." }, { status: 503 });
    }

    const creds = { sessionHost: session.sessionHost, sessionId: session.sessionId, apiKey: session.accessToken };
    const results: Record<string, unknown> = {};
    // Sequential — hormati rate limit Accurate; durasi per modul dicatat sebagai bukti beban.
    for (const mod of modules) {
        results[mod] = await syncModule(mod, creds);
    }
    const ok = Object.values(results).every((r) => (r as { success: boolean }).success);
    return NextResponse.json({ ok, results }, { status: ok ? 200 : 502 });
}
