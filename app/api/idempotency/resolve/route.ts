/**
 * Tujuan: "Selesaikan" pelunasan TIDAK PASTI (owner #7 S6e-2) — GET = pratinjau pencarian BACA-SAJA di Accurate sebelum Finance
 *   memutuskan (pola invoice-outbox/resolve). Sidik jari sama dengan penahanan riwayat di proxy (periksaRiwayatAccurate).
 * Caller: dialog Selesaikan wizard Pelunasan / Beranda (S6e-2b).
 * Dependensi: idempotency_log, lib/accurate-session, lib/accurate-forward (bacaAccurate), lib/pelunasan/pratinjau-ganda.
 * Main Functions: GET ?key=…(&key=…, 1–50) -> {ok, databaseId, databaseAlias, rows:[{key, status, …, eligible, found, receiptNumbers, readError}]}.
 * Side Effects: SELECT idempotency_log; GET Accurate list.do/detail.do dengan sesi PEMANGGIL. Tidak menulis apa pun.
 * Izin: finance.resolve_unknown. POST (keputusan terposting/tidak_ada, tercatat) BELUM ADA — menunggu DDL (kolom database di
 *   idempotency_log + tabel jejak penyelesaian), lihat docs/handover/S6e2-KONTRAK-API.md §5/§8.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { isAllowedAccurateHost } from "@/lib/api-security";
import { bacaAccurate } from "@/lib/accurate-forward";
import { periksaRiwayatAccurate } from "@/lib/pelunasan/pratinjau-ganda";
import { STALE_PROCESSING_MS } from "@/lib/idempotency-lock";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Umur minimum SENDING sebelum boleh diselesaikan (pola Finance purchase-payment: 2 mnt). PROCESSING = basi lock (15 mnt). */
const SENDING_BASI_MS = 2 * 60 * 1000;

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "finance.resolve_unknown");
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
        rows.map((r) => ({ key: r.key, customerNo: r.customerNo ?? "", transDate: r.transDate ?? "" })),
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
            const receiptNumbers = riwayat.cocok.get(r.key) ?? [];
            return {
                key: r.key, status: r.status, customerNo: r.customerNo, transDate: r.transDate, invoiceNo: r.invoiceNo, amount: r.amount,
                updatedAt: r.updatedAt, ageSeconds: umur === null ? null : Math.floor(umur / 1000),
                eligible: r.status === "UNKNOWN"
                    || (r.status === "SENDING" && umur !== null && umur >= SENDING_BASI_MS)
                    || (r.status === "PROCESSING" && umur !== null && umur > STALE_PROCESSING_MS),
                found: readError ? null : receiptNumbers.length > 0,
                receiptNumbers,
                readError,
            };
        }),
    });
}
