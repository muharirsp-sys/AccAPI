/*
 * Tujuan: Detail satu faktur (header + baris item, qty, harga) langsung dari Accurate detail.do.
 * Caller: app/(dashboard)/faktur/page.tsx saat baris diperluas.
 * Dependensi: lib/accurate-session (kredensial sistem), lib/accurate-invoice (mapper), RBAC.
 * Side Effects: 1 panggilan HTTP ke Accurate per pembukaan faktur (read-only).
 *
 * Kenapa ambil live, bukan dari kolom raw_data: cron sync 4x/hari menimpa raw_data pakai respons
 * list.do yang TIDAK punya detailItem (lib/sync.ts). Detail item di raw_data cuma bertahan sampai
 * sync berikutnya — membacanya dari sana akan "bekerja" saat diuji lalu kosong senyap besoknya.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { mapFakturDetail } from "@/lib/accurate-invoice";
import { accurateHeaders } from "@/lib/sync";

export const runtime = "nodejs";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    const id = Number((await ctx.params).id);
    if (!Number.isFinite(id) || id <= 0) {
        return NextResponse.json({ ok: false, error: "ID faktur tidak valid." }, { status: 400 });
    }

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    try {
        const res = await fetch(`${accurate.creds.sessionHost}/accurate/api/sales-invoice/detail.do?id=${id}`, {
            headers: accurateHeaders(accurate.creds),
            signal: AbortSignal.timeout(30_000),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.s || !body?.d) {
            return NextResponse.json(
                { ok: false, error: `Accurate menolak detail faktur: ${body?.m || `HTTP ${res.status}`}` },
                { status: 502 },
            );
        }

        // ?raw=1 memunculkan respons Accurate apa adanya — dipakai sekali untuk membuktikan nama
        // field detailItem (lihat catatan di lib/accurate-invoice.ts), bukan untuk pemakaian normal.
        const raw = request.nextUrl.searchParams.get("raw") === "1" ? body.d : undefined;
        return NextResponse.json({ ok: true, faktur: mapFakturDetail(body.d), raw });
    } catch (error) {
        console.error("[FAKTUR DETAIL ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil detail dari Accurate." }, { status: 502 });
    }
}
