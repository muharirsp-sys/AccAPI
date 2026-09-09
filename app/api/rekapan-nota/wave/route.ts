/*
 * Tujuan: Daftar & pembuatan wave rekapan. Jumlah wave per hari BEBAS (Q5) — minimal
 *         Pagi, Siang (urgent), Sore; yang membedakan `urutan`, bukan dua shift hardcode.
 * Caller: UI /rekapan-nota.
 * Dependensi: requirePermission, lib/db (pool pg).
 * Main Functions: GET (daftar per tanggal), POST (buat wave).
 * Side Effects: INSERT wave + wave_event.
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.view");
    if (gate.response) return gate.response;

    const tanggal = new URL(req.url).searchParams.get("tanggal")
        || new Date().toISOString().slice(0, 10);

    const r = await pool.query(
        `SELECT w.id::int AS id, w.tanggal::text, w.urutan, w.nama, w.tipe::text, w.status::text,
                w.created_at, w.released_at,
                count(wa.id) FILTER (WHERE wa.dilepas = false)::int AS jumlah_nota,
                (SELECT count(*)::int FROM wave_exception e
                  WHERE e.wave_id = w.id AND e.status = 'open')     AS exception_open
           FROM wave w
           LEFT JOIN wave_assignment wa ON wa.wave_id = w.id
          WHERE w.tanggal = $1::date
          GROUP BY w.id
          ORDER BY w.urutan`, [tanggal]);

    return NextResponse.json({ tanggal, wave: r.rows });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    const body = await req.json().catch(() => ({})) as {
        tanggal?: string; urutan?: number; nama?: string; tipe?: string; catatan?: string;
    };
    const tanggal = String(body.tanggal ?? "").trim();
    const urutan = Number(body.urutan);
    const nama = String(body.nama ?? "").trim();
    const tipe = body.tipe === "kanvas" ? "kanvas" : "reguler";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return NextResponse.json({ error: "tanggal wajib YYYY-MM-DD" }, { status: 400 });
    if (!Number.isInteger(urutan) || urutan < 1 || urutan > 20) return NextResponse.json({ error: "urutan 1-20" }, { status: 400 });
    if (!nama) return NextResponse.json({ error: "nama wajib (mis. Pagi / Siang / Sore)" }, { status: 400 });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const r = await client.query<{ id: string }>(
            `INSERT INTO wave (tanggal, urutan, nama, tipe, catatan, created_by)
             VALUES ($1::date,$2,$3,$4::wave_tipe,$5,$6)
             ON CONFLICT (tanggal, urutan) DO NOTHING RETURNING id::text`,
            [tanggal, urutan, nama, tipe, body.catatan ?? null, gate.session!.user.id]);
        if (!r.rowCount) {
            await client.query("ROLLBACK");
            return NextResponse.json(
                { error: `Wave urutan ${urutan} untuk tanggal ${tanggal} sudah ada.` }, { status: 409 });
        }
        const id = Number(r.rows[0].id);
        await client.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload)
             VALUES ($1,'wave.created',$2,$3::jsonb)`,
            [id, gate.session!.user.id, JSON.stringify({ tanggal, urutan, nama, tipe })]);
        await client.query("COMMIT");
        return NextResponse.json({ id, tanggal, urutan, nama, tipe, status: "draft" }, { status: 201 });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: "Gagal membuat wave", detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
