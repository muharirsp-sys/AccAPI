/*
 * Tujuan: "Selesaikan tidak pasti" (AM-047 / BL-16) — baris antrean faktur TIDAK PASTI ditetapkan
 *         terposting atau tidak terposting berdasarkan pencarian LANGSUNG di Accurate + alasan.
 * Caller: halaman Antrean Faktur (dialog `selesai`, S6c): GET saat dialog dibuka, POST saat keputusan disimpan.
 * Dependensi: lib/invoice-outbox-actions (cariTidakPasti, selesaikanTidakPasti, pencariPenekan), rbac.
 * Main Functions: GET ?orderId= (hasil pencarian SEBELUM keputusan, S6c), POST { orderId, keputusan: "terposting" | "tidak_terposting", alasan }.
 * Side Effects: GET BACA SAJA (tanpa penyapu, tanpa event). POST mengubah satu baris invoice_outbox + event `selesaikan`
 *   (satu transaksi). Request ke Accurate HANYA baca (list.do/detail.do) dengan sesi penekan. TIDAK ADA tulis ke Accurate.
 *
 * Izin: `order.resolve_unknown` (kunci kapabilitas S6-0d E6) — order.edit TIDAK cukup. Belum ada di
 * grup produksi mana pun; IT Support menambahkannya ke grup yang ditunjuk owner (D-17).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { cariTidakPasti, cekInputSelesaikan, pencariPenekan, sekaliJalan, selesaikanTidakPasti } from "@/lib/invoice-outbox-actions";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Hasil pencarian untuk dialog Selesaikan — tampil sebelum petugas memilih; POST mencari ulang saat memutuskan. */
export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "order.resolve_unknown");
    if (gate.response) return gate.response;
    const orderId = (request.nextUrl.searchParams.get("orderId") ?? "").trim();
    if (!orderId) return NextResponse.json({ ok: false, error: "orderId wajib diisi" }, { status: 400 });
    const userId = String(gate.session?.user?.id ?? "");
    // Dialog dibuka ulang / Cari lagi selagi pencarian berjalan: satu pencarian ke Accurate, jawaban dipakai bersama.
    const result = await sekaliJalan(`${userId}:${orderId}`, async () => cariTidakPasti(db, { orderId, cari: (await pencariPenekan(db, userId)).cari }));
    return NextResponse.json(result.body, { status: result.status });
}

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
