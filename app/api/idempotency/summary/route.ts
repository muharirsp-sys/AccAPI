/**
 * Tujuan: ringkasan baca-saja pelunasan (sales-receipt) untuk Beranda Admin Incaso (BL-41, owner #8 S6e-2): jumlah Tidak pasti
 *   (UNKNOWN + SENDING basi) dan Gagal boleh diulang (FAILED = tidak terkirim).
 * Caller: Beranda (S6e-2b).
 * Dependensi: lib/idempotency-summary (ringkasanIdempotensi), lib/rbac/resolve.
 * Main Functions: GET -> {ok, uncertain:{unknown, sendingStale, total}, retryable, processingStale, perDatabase:null, staleMinutes, asOf}.
 * Side Effects: SELECT idempotency_log saja.
 * Izin: `pelunasan.kirim` ATAU `finance.resolve_unknown`. perDatabase = null sampai idempotency_log mencatat database (DDL tertunda).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { ringkasanIdempotensi } from "@/lib/idempotency-summary";

export async function GET(request: Request) {
    const access = await resolveRequestPermissions(request);
    if (access.response) return access.response;
    if (!access.perms!.has("pelunasan.kirim") && !access.perms!.has("finance.resolve_unknown")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    try {
        return NextResponse.json({ ok: true, ...(await ringkasanIdempotensi(db, new Date())) });
    } catch (e: unknown) {
        console.error("[idempotency/summary]", e);
        return NextResponse.json({ ok: false, error: "Ringkasan pelunasan gagal dibaca." }, { status: 500 });
    }
}
