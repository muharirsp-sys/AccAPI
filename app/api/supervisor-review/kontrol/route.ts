/*
 * Tujuan: Supervisor Review — panel "Kontrol bulan ini" (owner 13 Nov 2026): per salesman, tanggal 1 s.d. tanggal tampilan: ORDER Form Kontrol vs
 *   faktur (dua tipe sales), toko pindahan / outlet potensi / kelas A yang sudah order, target vs omzet faktur, penawaran item super, lokasi perkiraan.
 * Caller: app/(dashboard)/supervisor-review/Kontrol.tsx.
 * Dependensi: lib/rbac/resolve (supervisor_review.view), lib/form-kontrol/scope resolveScope, lib/supervisor-review/kontrol-db.
 * Main Functions: GET ?tanggal=YYYY-MM-DD&cabang=&principle=. Side Effects: tidak ada (baca saja). Di luar /api/form-kontrol (tanpa cache 5 mnt).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { witaToday } from "@/lib/beranda";
import { tanggalSah } from "@/lib/kasir/pembaca";
import { muatKontrol } from "@/lib/supervisor-review/kontrol-db";

export async function GET(req: Request) {
    const gate = await requirePermissionH("supervisor_review.view");
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    const tanggal = q.get("tanggal")?.trim() || witaToday();
    if (!tanggalSah(tanggal)) return NextResponse.json({ kode: "TANGGAL_TIDAK_SAH", error: "Tanggal harus YYYY-MM-DD." }, { status: 400 });
    try {
        const jawaban = await muatKontrol(await resolveScope(gate.session), { tanggal, cabang: q.get("cabang")?.trim() || null, principle: q.get("principle")?.trim() || null });
        return NextResponse.json(jawaban, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[supervisor-review/kontrol] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat kontrol bulan ini." }, { status: 500 });
    }
}
