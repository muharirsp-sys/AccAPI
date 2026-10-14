/*
 * Tujuan: Menutup exception wave — Selesai (sudah diperbaiki) atau Abaikan (diterima, alasan wajib). BL-24:
 *         tanpa ini wave dengan exception KONVERSI_* tidak pernah bisa dikonfirmasi tanpa SQL manual.
 * Caller: UI /rekapan-nota/wave/[id] (tabel Exception).
 * Dependensi: requirePermission (rekapan_nota.manage, sama dengan transisi wave), wave-state, lib/db (pool pg).
 * Main Functions: PATCH.
 * Side Effects: UPDATE wave_exception (status, resolved_at/by) bersyarat status='open'; INSERT wave_event
 *   'wave.exception_resolved' (alasan disimpan di payload — tanpa kolom baru).
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { tolakUbahIsi, type WaveStatus } from "@/lib/rekapan-nota/wave-state";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;
    const id = Number((await ctx.params).id);
    const body = await req.json().catch(() => ({})) as { exceptionId?: number; aksi?: string; alasan?: string };
    const exceptionId = Number(body.exceptionId);
    if (!Number.isInteger(id) || !Number.isInteger(exceptionId))
        return NextResponse.json({ error: "id wave dan exceptionId wajib angka." }, { status: 400 });
    if (body.aksi !== "selesai" && body.aksi !== "abaikan")
        return NextResponse.json({ error: "aksi harus selesai | abaikan" }, { status: 400 });
    const alasan = String(body.alasan ?? "").trim();
    // Mengabaikan = menerima angka yang dipertanyakan; tanpa alasan, jejaknya tidak bisa dipertanggungjawabkan.
    if (body.aksi === "abaikan" && alasan.length < 5)
        return NextResponse.json({ error: "alasan wajib diisi (min 5 karakter)." }, { status: 400 });
    const status = body.aksi === "selesai" ? "selesai" : "diabaikan";
    const aktor = gate.session!.user.id;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const w = await client.query<{ status: WaveStatus }>(`SELECT status::text FROM wave WHERE id = $1 FOR SHARE`, [id]);
        if (!w.rowCount) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "Wave tidak ditemukan" }, { status: 404 });
        }
        const tolak = tolakUbahIsi(w.rows[0].status, "tutup_exception");
        if (tolak) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: tolak }, { status: 409 });
        }
        // `AND status = 'open'`: dua layar menutup exception yang sama -> yang kedua 409, bukan menimpa
        // keputusan (dan pelaku) yang pertama.
        const r = await client.query<{ jenis: string; ref_tipe: string; ref_kode: string }>(
            `UPDATE wave_exception SET status = $3::wave_exception_status, resolved_at = now(), resolved_by = $4
              WHERE id = $1 AND wave_id = $2 AND status = 'open'
              RETURNING jenis::text, ref_tipe, ref_kode`, [exceptionId, id, status, aktor]);
        if (!r.rowCount) {
            const ada = await client.query<{ status: string }>(
                `SELECT status::text FROM wave_exception WHERE id = $1 AND wave_id = $2`, [exceptionId, id]);
            await client.query("ROLLBACK");
            return ada.rowCount
                ? NextResponse.json({ error: `Exception sudah ditandai ${ada.rows[0].status} di layar lain. Muat ulang halaman.` }, { status: 409 })
                : NextResponse.json({ error: "Exception tidak ada di wave ini." }, { status: 404 });
        }
        const e = r.rows[0];
        await client.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,'wave.exception_resolved',$2,$3::jsonb)`,
            [id, aktor, JSON.stringify({ exception_id: exceptionId, jenis: e.jenis, ref_tipe: e.ref_tipe, ref_kode: e.ref_kode, status, alasan: alasan || null })]);
        await client.query("COMMIT");
        return NextResponse.json({ ok: true, status });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: "Gagal menutup exception", detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
