/**
 * Tujuan: "Selesaikan" pelunasan TIDAK PASTI (owner #7 S6e-2) — GET = pratinjau pencarian BACA-SAJA di Accurate sebelum Finance
 *   memutuskan (pola invoice-outbox/resolve). Kandidat = pelunasan pelanggan+tanggal yang menyentuh faktur baris (sama dengan
 *   bukti POST, lib/idempotency-resolve targetDariLog), dengan nomor + faktur + nominal agar Finance bisa memilih `terposting`.
 * Caller: dialog Selesaikan wizard Pelunasan / Beranda (S6e-2b).
 * Dependensi: idempotency_log, lib/accurate-session, lib/accurate-forward (bacaAccurate), lib/pelunasan/pratinjau-ganda.
 * Main Functions: GET ?key=…(&key=…, 1–50) -> {ok, databaseId, databaseAlias, rows:[{key, status, …, eligible, found, receiptNumbers, candidates, readError}]};
 *   POST {key, decision, accurateNumber?, reason, checkedSource, expectedDatabaseId} -> lib/idempotency-resolve (cari dulu, lalu tetapkan).
 * Side Effects: GET = SELECT + GET Accurate list.do/detail.do dengan sesi PEMANGGIL, tanpa tulis. POST = pencarian yang sama lalu
 *   satu transaksi UPDATE idempotency_log + INSERT idempotency_resolution. TIDAK ADA tulis ke Accurate.
 * Izin: finance.resolve_unknown (GET & POST). Kontrak: docs/handover/S6e2-KONTRAK-API.md §4–§5.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyLog } from "@/db/schema";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { isAllowedAccurateHost } from "@/lib/api-security";
import { bacaAccurate } from "@/lib/accurate-forward";
import { periksaRiwayatAccurate } from "@/lib/pelunasan/pratinjau-ganda";
import { bolehDiselesaikan, cekInputSelesaikan, kandidatUI, nomorKandidat, selesaikanPelunasan, targetDariLog } from "@/lib/idempotency-resolve";

export const runtime = "nodejs";
export const maxDuration = 120;

/** finance.resolve_unknown. 403 berbentuk galat route ini `{ok:false, code:"forbidden", error}` (kebutuhan UI S6e-2b); 401 tetap lama. */
async function gerbang(request: Request) {
    const a = await resolveRequestPermissions(request);
    if (a.response) return { response: a.response, session: null };
    if (!a.perms!.has("finance.resolve_unknown")) {
        return { response: NextResponse.json({ ok: false, code: "forbidden", error: "Selesaikan pelunasan butuh izin finance.resolve_unknown." }, { status: 403 }), session: null };
    }
    return { response: null, session: a.session! };
}

export async function GET(request: NextRequest) {
    const gate = await gerbang(request);
    if (gate.response) return gate.response;
    const keys = [...new Set(request.nextUrl.searchParams.getAll("key").map((k) => k.trim()).filter(Boolean))];
    if (!keys.length || keys.length > 50) {
        return NextResponse.json({ ok: false, error: "key wajib, 1–50 per permintaan." }, { status: 400 });
    }
    const rows = await db.select().from(idempotencyLog).where(inArray(idempotencyLog.key, keys));
    if (!rows.length) return NextResponse.json({ ok: false, error: "Baris pelunasan tidak ditemukan." }, { status: 404 });

    const sesi = await getAccurateSession(String(gate.session.user.id));
    if (!sesi?.sessionHost || !sesi.sessionId || !sesi.accessToken || !isAllowedAccurateHost(sesi.sessionHost)) {
        return NextResponse.json({ ok: false, error: "Sesi Accurate belum lengkap. Login dan buka database yang diperiksa dulu.", code: "ACCURATE_SESSION_INCOMPLETE" }, { status: 400 });
    }
    const riwayat = await periksaRiwayatAccurate(
        rows.map(targetDariLog),
        bacaAccurate({ sessionHost: sesi.sessionHost, sessionId: sesi.sessionId, accessToken: sesi.accessToken }),
    );
    const now = Date.now();
    return NextResponse.json({
        ok: true,
        databaseId: sesi.databaseId ?? null,
        databaseAlias: sesi.databaseAlias ?? null,
        rows: rows.map((r) => {
            const t = (r.updatedAt ?? r.createdAt)?.getTime();
            const umur = t === undefined ? null : now - t;
            const readError = riwayat.gagal.get(r.key) ?? null;
            const candidates = riwayat.mirip.get(r.key) ?? [];
            return {
                key: r.key, status: r.status, customerNo: r.customerNo, transDate: r.transDate, invoiceNo: r.invoiceNo, amount: r.amount,
                updatedAt: r.updatedAt, ageSeconds: umur === null ? null : Math.floor(umur / 1000),
                eligible: bolehDiselesaikan(r, new Date(now)),
                found: readError ? null : candidates.length > 0,
                receiptNumbers: nomorKandidat(candidates),
                candidates: candidates.map(kandidatUI),
                readError,
            };
        }),
    });
}

export async function POST(request: NextRequest) {
    const gate = await gerbang(request);
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    // Validasi murah dulu: tanpa keputusan/alasan yang sah tidak ada pencarian ke Accurate.
    const inp = cekInputSelesaikan(body);
    if (typeof inp === "string") return NextResponse.json({ ok: false, error: inp }, { status: 400 });
    const expected = typeof body?.expectedDatabaseId === "string" || typeof body?.expectedDatabaseId === "number" ? String(body.expectedDatabaseId).trim() : "";
    if (!expected) return NextResponse.json({ ok: false, code: "DATABASE_REQUIRED", error: "expectedDatabaseId wajib (database yang diperiksa)." }, { status: 400 });

    const sesi = await getAccurateSession(String(gate.session.user.id));
    if (!sesi?.sessionHost || !sesi.sessionId || !sesi.accessToken || !sesi.databaseId || !isAllowedAccurateHost(sesi.sessionHost)) {
        return NextResponse.json({ ok: false, code: "ACCURATE_SESSION_INCOMPLETE", error: "Sesi Accurate belum lengkap. Login dan buka database yang diperiksa dulu." }, { status: 400 });
    }
    if (String(sesi.databaseId) !== expected) {
        return NextResponse.json({ ok: false, code: "database_changed", databaseId: sesi.databaseId, databaseAlias: sesi.databaseAlias ?? null,
            error: `Database Accurate sesi berubah (kini ${sesi.databaseAlias || sesi.databaseId}). Muat ulang lalu cari lagi. Tidak ada yang diubah.` }, { status: 409 });
    }
    const baca = bacaAccurate({ sessionHost: sesi.sessionHost, sessionId: sesi.sessionId, accessToken: sesi.accessToken });
    const hasil = await selesaikanPelunasan(db, {
        // Tinjauan B5: jejak = user id (seperti idempotency_override & Finance resolve), bukan email yang bisa berubah.
        ...inp, actor: String(gate.session.user.id), sessionDatabaseId: String(sesi.databaseId),
    }, (t) => periksaRiwayatAccurate([t], baca));
    return NextResponse.json(hasil.body, { status: hasil.status });
}
