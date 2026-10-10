/*
 * Tujuan: "Selesaikan tidak pasti" (AM-047 / BL-16) — baris antrean faktur TIDAK PASTI ditetapkan
 *         terposting atau tidak terposting berdasarkan pencarian LANGSUNG di Accurate + alasan.
 * Caller: halaman Antrean Faktur (dialog `selesai`, S6c — belum ada tombol).
 * Dependensi: lib/invoice-outbox-actions (selesaikanTidakPasti, pencariPenekan), rbac.
 * Main Functions: POST { orderId, keputusan: "terposting" | "tidak_terposting", alasan }.
 * Side Effects: Ubah satu baris invoice_outbox + event `selesaikan` (satu transaksi). Request ke
 *   Accurate HANYA baca (list.do/detail.do) dengan sesi penekan. TIDAK ADA tulis ke Accurate.
 *
 * Izin: `order.resolve_unknown` (kunci kapabilitas S6-0d E6) — order.edit TIDAK cukup. Belum ada di
 * grup produksi mana pun; IT Support menambahkannya ke grup yang ditunjuk owner (D-17).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { cekInputSelesaikan, pencariPenekan, selesaikanTidakPasti } from "@/lib/invoice-outbox-actions";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "order.resolve_unknown");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const orderId = String(body.orderId ?? "").trim();
    const keputusan = String(body.keputusan ?? "").trim();
    const alasan = String(body.alasan ?? "").slice(0, 1000);
    // Validasi murah dulu: tanpa keputusan/alasan yang sah tidak ada pencarian ke Accurate.
    const salah = cekInputSelesaikan({ orderId, keputusan, alasan });
    if (salah) return NextResponse.json({ ok: false, error: salah }, { status: 400 });

    const pencari = await pencariPenekan(db, String(gate.session?.user?.id ?? ""));
    const result = await selesaikanTidakPasti(db, {
        orderId, keputusan, alasan,
        actor: String(gate.session?.user?.email ?? gate.session?.user?.id ?? ""),
        cari: pencari.cari, targetDb: pencari.targetDb,
    });
    return NextResponse.json(result.body, { status: result.status });
}
