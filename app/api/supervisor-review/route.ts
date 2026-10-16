/*
 * Tujuan: Supervisor Review — ringkasan harian per salesman (tabel + TOTAL cabang + rincian kunjungan + penanda peta + WhatsApp) untuk satu
 *   tanggal WITA (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.3; kontrak lib/supervisor-review/kontrak.ts).
 * Caller: app/(dashboard)/supervisor-review/** (SR-2/SR-3).
 * Dependensi: lib/rbac/resolve (supervisor_review.view), lib/form-kontrol/scope resolveScope (SPV tim, SM bawahan, Admin/Manager semua — SM
 *   TIDAK 403), lib/supervisor-review/db.
 * Main Functions: GET ?tanggal=YYYY-MM-DD&cabang=&principle= -> JawabanSupervisorReview. Side Effects: tidak ada (baca saja).
 * Catatan: SENGAJA di luar /api/form-kontrol — prefiks itu mendapat Cache-Control private, max-age=300; layar ini butuh angka terkini.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { witaToday } from "@/lib/beranda";
import { tanggalSah } from "@/lib/kasir/pembaca";
import { muatSupervisorReview } from "@/lib/supervisor-review/db";

export async function GET(req: Request) {
    const gate = await requirePermissionH("supervisor_review.view");
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    const tanggal = q.get("tanggal")?.trim() || witaToday();
    if (!tanggalSah(tanggal)) return NextResponse.json({ kode: "TANGGAL_TIDAK_SAH", error: "Tanggal harus YYYY-MM-DD." }, { status: 400 });
    try {
        const scope = await resolveScope(gate.session);
        const jawaban = await muatSupervisorReview(scope, { tanggal, cabang: q.get("cabang")?.trim() || null, principle: q.get("principle")?.trim() || null });
        return NextResponse.json(jawaban, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[supervisor-review] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Supervisor Review." }, { status: 500 });
    }
}
