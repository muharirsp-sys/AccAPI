/*
 * Tujuan: Daftar nota yang MASIH tersedia untuk disusun ke wave (anti-join wave_assignment).
 * Caller: UI /rekapan-nota/wave/[id].
 * Dependensi: requirePermission, lib/rekapan-nota/query.
 * Main Functions: GET.
 * Side Effects: Tidak ada (SELECT saja).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { notaPool, ambilSetting } from "@/lib/rekapan-nota/query";
import { parseAreaDikecualikan } from "@/lib/rekapan-nota/classify";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.view");
    if (gate.response) return gate.response;

    const url = new URL(req.url);
    const tanggal = url.searchParams.get("tanggal");
    if (!tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
        return NextResponse.json({ error: "Parameter 'tanggal' (YYYY-MM-DD) wajib." }, { status: 400 });
    }
    const tipe = url.searchParams.get("tipe") === "kanvas" ? "kanvas" : "reguler";

    const [ambangRaw, dikecualikanRaw] = await Promise.all([
        ambilSetting("rekapan.ambang_pareto_karton", "50"),
        ambilSetting("rekapan.area_dikecualikan", "NON,LUAR KOTA"),
    ]);
    const opts = { ambangPareto: Number(ambangRaw) || 50, areaDikecualikan: parseAreaDikecualikan(dikecualikanRaw) };
    const rows = await notaPool(tanggal, { ...opts, tipe });
    // Nota kanvas hilang dari pool reguler secara sengaja (R3.5). Yang berbahaya adalah
    // hilang DIAM-DIAM: kalau salah tandai, tak ada yang tahu sampai kertas keluar.
    // Karena itu jumlahnya ikut dilaporkan, supaya kelihatan di layar penyusunan wave.
    const lawan = await notaPool(tanggal, { ...opts, tipe: tipe === "kanvas" ? "reguler" : "kanvas" });

    return NextResponse.json({
        tanggal, tipe, jumlahNota: rows.length,
        tanpaArea: rows.filter((r) => !r.area).length,
        disembunyikan: lawan.length,
        nota: rows,
    });
}
