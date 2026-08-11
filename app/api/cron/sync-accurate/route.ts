/*
 * Tujuan: Trigger sync terjadwal Accurate -> cache lokal (Audit F2+F3, prasyarat PRD 02/03/04).
 * Caller: Scheduler eksternal (Coolify scheduled task / cron) dengan Bearer CRON_SECRET.
 * Kredensial Accurate: userId dari env ACCURATE_SYNC_USER_ID, fallback sesi OAuth terbaru.
 * Side Effects: tulis tabel item/customer/sales_invoice/sales_return + sync_state.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { SYNC_MODULE_NAMES, syncModule, type SyncModuleName } from "@/lib/sync";

export const maxDuration = 3600; // sync penuh bisa lama; jalan out-of-band, bukan request user

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

    // Refresh X-Session-ID ikut ditangani di sini — dulu cron berhenti total sampai ada
    // yang membuka UI /api-wrapper.
    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    const creds = accurate.creds;
    const results: Record<string, unknown> = {};
    // Sequential — hormati rate limit Accurate; durasi per modul dicatat sebagai bukti beban.
    for (const mod of modules) {
        results[mod] = await syncModule(mod, creds);
    }
    const ok = Object.values(results).every((r) => (r as { success: boolean }).success);
    return NextResponse.json({ ok, results }, { status: ok ? 200 : 502 });
}
