/*
 * Tujuan: Antrean mapping area outlet + mesin usulan. Master area yang belum lengkap adalah
 *         penyebab tunggal terbesar nota hilang dari lembar HNZ (19 dari 131 nota, 21 Agu 2026).
 * Caller: UI /rekapan-nota/area.
 * Dependensi: requirePermission, lib/rekapan-nota/area-suggest, lib/db.
 * Main Functions: GET (outlet tanpa area + usulan), POST (terima satuan / massal).
 * Side Effects: UPDATE customer.area. Usulan TIDAK pernah ditulis otomatis (R9.1).
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { usulkanArea, bangunIndeks, type Outlet, type OutletTerpetakan } from "@/lib/rekapan-nota/area-suggest";

export const runtime = "nodejs";
export const maxDuration = 120;

async function ambilTerpetakan(): Promise<OutletTerpetakan[]> {
    // Hanya outlet ter-mapping YANG PUNYA ALAMAT yang berguna sebagai bahan indeks:
    // Kel./Kec. di alamat itulah satu-satunya sinyalnya. Diisi sekali dari
    // `Master Area Heinz` lewat scripts/import-rekapan-master.mjs, lalu dijaga
    // segar dari alamat yang ikut tiap baris nota saat upload.
    const r = await pool.query<{ kode: string; nama: string; alamat: string | null; area: string }>(
        `SELECT "customerNo" AS kode, name AS nama, alamat, area
           FROM customer
          WHERE area IS NOT NULL AND upper(area) NOT IN ('NON','LUAR KOTA')
            AND coalesce(alamat,'') <> ''`);
    return r.rows;
}

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.view");
    if (gate.response) return gate.response;

    // Antrean kerja = outlet yang benar-benar berjualan tapi belum dipetakan. Outlet yang
    // tidak pernah muncul di nota bukan pekerjaan siapa-siapa hari ini.
    const target = await pool.query<{ kode: string; nama: string; alamat: string | null; jumlah_nota: number }>(
        `SELECT p.kode_cust AS kode,
                coalesce(max(c.name), max(p.customer))     AS nama,
                coalesce(max(c.alamat), max(p.alamat))     AS alamat,
                count(DISTINCT p.no_nota)::int             AS jumlah_nota
           FROM wave_line_pool p
           LEFT JOIN customer c ON c."customerNo" = p.kode_cust
          WHERE c.area IS NULL
          GROUP BY p.kode_cust
          ORDER BY count(DISTINCT p.no_nota) DESC, p.kode_cust`);

    if (!target.rowCount) return NextResponse.json({ jumlah: 0, outlet: [] });

    const indeks = bangunIndeks(await ambilTerpetakan());
    const outlet = target.rows.map((t) => {
        const o: Outlet = { kode: t.kode, nama: t.nama ?? "", alamat: t.alamat };
        const usul = usulkanArea(o, indeks);
        return { ...t, usulan: usul?.area ?? null, keyakinan: usul?.keyakinan ?? null, alasan: usul?.alasan ?? null };
    });

    return NextResponse.json({
        jumlah: outlet.length,
        dapatUsulan: outlet.filter((o) => o.usulan).length,
        tinggi: outlet.filter((o) => o.keyakinan === "TINGGI").length,
        outlet,
    });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    const body = await req.json().catch(() => ({})) as { terima?: { kode: string; area: string }[] };
    const terima = (body.terima ?? [])
        .map((t) => ({ kode: String(t.kode ?? "").trim(), area: String(t.area ?? "").trim().toUpperCase() }))
        .filter((t) => t.kode && t.area);
    if (!terima.length) return NextResponse.json({ error: "terima[] {kode, area} wajib." }, { status: 400 });

    const r = await pool.query<{ kode: string }>(
        `UPDATE customer c SET area = v.area
           FROM jsonb_to_recordset($1::jsonb) AS v(kode text, area text)
          WHERE c."customerNo" = v.kode
        RETURNING c."customerNo" AS kode`, [JSON.stringify(terima)]);

    const tersimpan = r.rows.map((x) => x.kode);
    return NextResponse.json({
        tersimpan: tersimpan.length,
        gagal: terima.filter((t) => !tersimpan.includes(t.kode)).map((t) => t.kode),
    });
}
