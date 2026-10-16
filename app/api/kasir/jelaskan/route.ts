/*
 * Tujuan: Jelaskan selisih orang atau uang tak teralokasi Kasir ↔ Incaso (K2a, BL-59) — penjelasan ≥ 15 huruf berkunci ANGKA (dihitung
 *   ulang server; beda = 409 ANGKA_BERUBAH). Tidak mensyaratkan status baca `lengkap` (orkestrator 12 Okt).
 * Caller: K2b dialog `jelaskan` di /kasir. Kontrak: docs/handover/KASIR-KONTRAK.md §8.5.
 * Dependensi: lib/kasir/hari (uraiJelaskan, jelaskan), lib/rbac/resolve (kasir.catat).
 * Main Functions: POST -> 200 { id } | { sudahAda } | 400 | 409 ANGKA_BERUBAH / TIDAK_PERLU_DIJELASKAN / HARI_TERKUNCI | 503 SESI_SINKRON
 *   | 500 | 502 TIDAK_PASTI.
 * Side Effects: INSERT kasir_selisih_catatan / kasir_tak_teralokasi_catatan (append-only). TANPA Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, jawabanGalat, jelaskan, uraiJelaskan } from "@/lib/kasir/hari";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.catat");
    if (gate.response) return gate.response;
    try {
        const isian = uraiJelaskan(await request.json().catch(() => null), bawaanHari.sekarang());
        return NextResponse.json({ ok: true, ...(await jelaskan(isian, gate.session.user.id, bawaanHari)) });
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR JELASKAN]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
