/**
 * Tujuan: ringkasan baca-saja pelunasan (sales-receipt) untuk Beranda Admin Incaso (BL-41, owner #8 S6e-2): jumlah Tidak pasti
 *   (UNKNOWN + SENDING basi) dan Gagal boleh diulang (FAILED = tidak terkirim).
 * Caller: Beranda (S6e-2b).
 * Dependensi: lib/idempotency-summary (ringkasanIdempotensi), lib/rbac/resolve.
 * Main Functions: GET -> {ok, uncertain:{unknown, sendingStale, total}, retryable, processingStale, perDatabase:[{databaseId, label, …}],
 *   staleMinutes, asOf}; `?rows=1` menambah {rows:[≤200 baris tanpa payload], rowsTruncated}; `&database=X` menyaring rows
 *   (bukan hitungan) ke database lock X dan menggemakan `rowsDatabaseId`.
 * Side Effects: SELECT idempotency_log saja.
 * Izin: `pelunasan.kirim` ATAU `finance.resolve_unknown`. perDatabase: database lock NULL (baris lama) = label "tidak tercatat".
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { daftarBarisRingkasan, ringkasanIdempotensi } from "@/lib/idempotency-summary";

export async function GET(request: Request) {
    const access = await resolveRequestPermissions(request);
    if (access.response) return access.response;
    if (!access.perms!.has("pelunasan.kirim") && !access.perms!.has("finance.resolve_unknown")) {
        return NextResponse.json({ ok: false, code: "forbidden", error: "Ringkasan pelunasan butuh izin pelunasan.kirim atau finance.resolve_unknown." }, { status: 403 });
    }
    try {
        const now = new Date();
        const q = new URL(request.url).searchParams;
        const dbRows = q.get("database")?.trim() || undefined; // kebutuhan UI S6e-2b: `database=<id>`
        const baris = q.get("rows") === "1"
            ? { ...(await daftarBarisRingkasan(db, now, undefined, dbRows)), ...(dbRows ? { rowsDatabaseId: dbRows } : {}) } : {};
        return NextResponse.json({ ok: true, ...(await ringkasanIdempotensi(db, now)), ...baris });
    } catch (e: unknown) {
        console.error("[idempotency/summary]", e);
        return NextResponse.json({ ok: false, error: "Ringkasan pelunasan gagal dibaca." }, { status: 500 });
    }
}
