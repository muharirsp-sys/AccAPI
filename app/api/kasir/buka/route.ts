/*
 * Tujuan: Buka kembali hari Kasir yang terkunci (K2a, BL-59; owner 11 Okt T1) — OM/Admin (`kasir.buka`), alasan ≥ 15 huruf; terkunci
 *   lagi otomatis 20.00 WITA berikutnya sesudah waktu buka.
 * Caller: K2b dialog `buka` di /kasir. Kontrak: docs/handover/KASIR-KONTRAK.md §8.7.
 * Dependensi: lib/kasir/hari (uraiBuka, bukaHari), lib/rbac/resolve (kasir.buka).
 * Main Functions: POST { tanggal, alasan } -> 200 { kunciBerikutnya } | 400 | 409 TIDAK_TERKUNCI | 500 | 502 TIDAK_PASTI.
 * Side Effects: INSERT kasir_hari_event `buka` (append-only; + `kunci` sistem bila kunci 20.00 belum dicatat). TANPA Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, bukaHari, jawabanGalat, uraiBuka } from "@/lib/kasir/hari";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.buka");
    if (gate.response) return gate.response;
    try {
        const isian = uraiBuka(await request.json().catch(() => null), bawaanHari.sekarang());
        return NextResponse.json({ ok: true, ...(await bukaHari(isian, gate.session.user.id, bawaanHari)) });
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR BUKA]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
