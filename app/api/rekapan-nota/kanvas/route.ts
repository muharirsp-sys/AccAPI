/*
 * Tujuan: Penandaan nota kanvas (Q16) — dikelompokkan per salesman, karena di situlah nota
 *         kanvas menggumpal. Tanda melekat pada NO_NOTA supaya selamat dari upload ulang.
 * Caller: UI /rekapan-nota/kanvas.
 * Dependensi: requirePermission, lib/db (pool pg).
 * Main Functions: GET (nota per salesman + status tanda), POST (tandai), DELETE (batal tandai).
 * Side Effects: INSERT/DELETE nota_kanvas.
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.view");
    if (gate.response) return gate.response;

    const tanggal = new URL(req.url).searchParams.get("tanggal");
    if (!tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
        return NextResponse.json({ error: "Parameter 'tanggal' (YYYY-MM-DD) wajib." }, { status: 400 });
    }

    // Sekali jalan: nota hari itu + status tanda + apakah sudah terkunci di wave kanvas
    // yang sudah dirilis (batal tandai tidak boleh lagi, barangnya sudah keluar).
    const r = await pool.query(
        `SELECT p.no_nota,
                coalesce(max(p.kode_salesman), '-')  AS kode_salesman,
                coalesce(max(p.salesman), '(tanpa salesman)') AS salesman,
                max(p.customer)                       AS customer,
                count(*)::int                         AS jumlah_baris,
                sum(p.qty_pcs)::float8                AS total_pcs,
                (k.no_nota IS NOT NULL)               AS kanvas,
                bool_or(w.status <> 'draft' AND w.tipe = 'kanvas') AS terkunci,
                bool_or(wa.wave_id IS NOT NULL)       AS di_wave
           FROM wave_line_pool p
           LEFT JOIN nota_kanvas k     ON k.no_nota = p.no_nota
           LEFT JOIN wave_assignment wa ON wa.no_nota = p.no_nota AND wa.dilepas = false
           LEFT JOIN wave w             ON w.id = wa.wave_id
          WHERE p.tanggal = $1::date
          GROUP BY p.no_nota, k.no_nota
          ORDER BY coalesce(max(p.salesman), 'zzz'), p.no_nota`, [tanggal]);

    const nihil = await pool.query<{ ditandai_at: string; catatan: string | null; oleh: string }>(
        `SELECT n.ditandai_at, n.catatan, coalesce(u.name, n.ditandai_by) AS oleh
           FROM kanvas_nihil n LEFT JOIN "user" u ON u.id = n.ditandai_by
          WHERE n.tanggal = $1::date`, [tanggal]);

    return NextResponse.json({
        tanggal,
        jumlahNota: r.rowCount,
        ditandai: r.rows.filter((x) => x.kanvas).length,
        nihil: nihil.rows[0] ?? null,
        nota: r.rows,
    });
}

/** Pernyataan "tanggal ini tidak ada nota kanvas" — dan siapa yang menyatakannya. */
export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    const body = await req.json().catch(() => ({})) as { tanggal?: string; nihil?: boolean; catatan?: string };
    const tanggal = String(body.tanggal ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
        return NextResponse.json({ error: "tanggal wajib YYYY-MM-DD" }, { status: 400 });
    }

    if (body.nihil === false) {
        await pool.query(`DELETE FROM kanvas_nihil WHERE tanggal = $1::date`, [tanggal]);
        return NextResponse.json({ ok: true, nihil: null });
    }

    // Menyatakan "tidak ada" selagi ada yang bertanda adalah kontradiksi. Ditolak di sini,
    // bukan dibiarkan jadi dua kebenaran yang saling membantah di layar.
    const ada = await pool.query<{ n: string }>(
        // DISTINCT no_nota: satu nota punya banyak baris pool, dan pesannya menyebut "nota".
        `SELECT count(DISTINCT k.no_nota)::text n FROM nota_kanvas k
           JOIN wave_line_pool p ON p.no_nota = k.no_nota AND p.tanggal = $1::date`, [tanggal]);
    if (Number(ada.rows[0].n) > 0) {
        return NextResponse.json({
            error: `Masih ada ${ada.rows[0].n} nota bertanda kanvas untuk tanggal ini. ` +
                `Cabut tandanya dulu kalau memang tidak ada kanvas hari ini.`,
        }, { status: 409 });
    }

    await pool.query(
        `INSERT INTO kanvas_nihil (tanggal, catatan, ditandai_by) VALUES ($1::date, $2, $3)
         ON CONFLICT (tanggal) DO UPDATE SET catatan = excluded.catatan,
             ditandai_by = excluded.ditandai_by, ditandai_at = now()`,
        [tanggal, body.catatan ?? null, gate.session!.user.id]);
    return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    const body = await req.json().catch(() => ({})) as { noNota?: string[]; catatan?: string };
    const noNota = (body.noNota ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!noNota.length) return NextResponse.json({ error: "noNota[] wajib." }, { status: 400 });

    // Nota yang sudah masuk wave REGULER tidak boleh ditandai kanvas: kertasnya mungkin
    // sudah keluar. Lepas dulu lewat take-out, baru tandai.
    const bentrok = await pool.query<{ no_nota: string; nama: string }>(
        `SELECT wa.no_nota, w.nama FROM wave_assignment wa JOIN wave w ON w.id = wa.wave_id
          WHERE wa.dilepas = false AND w.tipe = 'reguler' AND wa.no_nota = ANY($1::text[])`, [noNota]);
    if (bentrok.rowCount) {
        return NextResponse.json({
            error: "Sebagian nota sudah masuk wave reguler. Lepas dulu (take-out) sebelum ditandai kanvas.",
            bentrok: bentrok.rows,
        }, { status: 409 });
    }

    const r = await pool.query<{ no_nota: string }>(
        `INSERT INTO nota_kanvas (no_nota, catatan, ditandai_by)
         SELECT unnest($1::text[]), $2, $3
         ON CONFLICT (no_nota) DO NOTHING
         RETURNING no_nota`, [noNota, body.catatan ?? null, gate.session!.user.id]);

    return NextResponse.json({ ditandai: r.rows.map((x) => x.no_nota), diminta: noNota.length });
}

export async function DELETE(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    const body = await req.json().catch(() => ({})) as { noNota?: string[] };
    const noNota = (body.noNota ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!noNota.length) return NextResponse.json({ error: "noNota[] wajib." }, { status: 400 });

    // Batal tandai hanya selama notanya belum masuk wave kanvas yang sudah dirilis.
    const terkunci = await pool.query<{ no_nota: string; nama: string }>(
        `SELECT wa.no_nota, w.nama FROM wave_assignment wa JOIN wave w ON w.id = wa.wave_id
          WHERE wa.dilepas = false AND w.tipe = 'kanvas' AND w.status <> 'draft'
            AND wa.no_nota = ANY($1::text[])`, [noNota]);
    if (terkunci.rowCount) {
        return NextResponse.json({
            error: "Sebagian nota sudah ada di wave kanvas yang dirilis; tandanya tidak bisa dicabut.",
            terkunci: terkunci.rows,
        }, { status: 409 });
    }

    const r = await pool.query<{ no_nota: string }>(
        `DELETE FROM nota_kanvas WHERE no_nota = ANY($1::text[]) RETURNING no_nota`, [noNota]);
    return NextResponse.json({ dibatalkan: r.rows.map((x) => x.no_nota) });
}
