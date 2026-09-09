/*
 * Tujuan: Detail satu wave + transisi status (release / confirm / cancel) dan pemilihan pick_group.
 * Caller: UI /rekapan-nota/wave/[id].
 * Dependensi: requirePermission, wave-state, exception, lib/db (pool pg).
 * Main Functions: GET (detail + isi + exception), PATCH (aksi transisi / set grup cetak).
 * Side Effects: UPDATE wave, INSERT wave_event, INSERT wave_exception (saat release).
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { transisiWave, type WaveAksi, type WaveStatus } from "@/lib/rekapan-nota/wave-state";
import { deteksiException, hitungExceptionOpen } from "@/lib/rekapan-nota/exception";

export const runtime = "nodejs";

type WaveRow = { id: number; tanggal: string; urutan: number; nama: string; tipe: string; status: WaveStatus };

async function ambilWave(id: number): Promise<WaveRow | null> {
    const r = await pool.query<WaveRow>(
        `SELECT id::int, tanggal::text, urutan, nama, tipe::text, status::text
           FROM wave WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await requirePermission(req, "rekapan_nota.view");
    if (gate.response) return gate.response;
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "id tidak valid" }, { status: 400 });

    const wave = await ambilWave(id);
    if (!wave) return NextResponse.json({ error: "Wave tidak ditemukan" }, { status: 404 });

    const [nota, exception, grup, tersedia] = await Promise.all([
        pool.query(
            `SELECT wa.no_nota, wa.prioritas::text, wa.snap_area, wa.snap_grup_all, wa.snap_grup_gdi,
                    wa.snap_pareto, wa.snap_total_krt::float8, wa.dilepas, wa.dilepas_alasan,
                    min(p.customer) AS customer, min(p.region) AS region, min(p.salesman) AS salesman,
                    count(p.id)::int AS jumlah_baris, sum(p.qty_pcs)::float8 AS total_pcs
               FROM wave_assignment wa
               LEFT JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
              WHERE wa.wave_id = $1
              GROUP BY wa.id
              ORDER BY wa.dilepas, wa.prioritas DESC, wa.no_nota`, [id]),
        pool.query(
            `SELECT id::int, jenis::text, ref_tipe, ref_kode, keterangan, status::text
               FROM wave_exception WHERE wave_id = $1 ORDER BY status, jenis, ref_kode`, [id]),
        pool.query(
            `SELECT g.id::int, g.kode, g.nama, g.dimensi::text
               FROM wave_pick_group wpg JOIN pick_group g ON g.id = wpg.pick_group_id
              WHERE wpg.wave_id = $1 ORDER BY g.urutan_cetak`, [id]),
        // Daftar grup yang bisa dipilih ikut di sini supaya UI tidak perlu route kedua.
        pool.query(
            `SELECT id::int, kode, nama, dimensi::text FROM pick_group
              WHERE aktif ORDER BY urutan_cetak, kode`),
    ]);

    return NextResponse.json({
        wave,
        nota: nota.rows,
        exception: exception.rows,
        pickGroup: grup.rows,
        pickGroupTersedia: tersedia.rows,
    });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "id tidak valid" }, { status: 400 });

    const body = await req.json().catch(() => ({})) as { aksi?: string; pickGroupIds?: number[]; alasan?: string };
    const wave = await ambilWave(id);
    if (!wave) return NextResponse.json({ error: "Wave tidak ditemukan" }, { status: 404 });
    const aktor = gate.session!.user.id;

    // Pemilihan grup cetak bukan transisi status — ia boleh diubah selama wave belum ditutup.
    if (body.aksi === "set_grup") {
        const ids = (body.pickGroupIds ?? []).map(Number).filter(Number.isInteger);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM wave_pick_group WHERE wave_id = $1`, [id]);
            if (ids.length) {
                await client.query(
                    `INSERT INTO wave_pick_group (wave_id, pick_group_id)
                     SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [id, ids]);
            }
            await client.query(
                `INSERT INTO wave_event (wave_id, event, aktor_id, payload)
                 VALUES ($1,'wave.groups_selected',$2,$3::jsonb)`,
                [id, aktor, JSON.stringify({ pick_group_ids: ids })]);
            await client.query("COMMIT");
            return NextResponse.json({ ok: true, pickGroupIds: ids });
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            return NextResponse.json({ error: "Gagal menyimpan grup cetak", detail: String(e) }, { status: 500 });
        } finally {
            client.release();
        }
    }

    const aksi = body.aksi as WaveAksi;
    if (!["release", "confirm", "cancel"].includes(aksi)) {
        return NextResponse.json({ error: "aksi harus release | confirm | cancel | set_grup" }, { status: 400 });
    }

    // Exception dideteksi SEBELUM gerbang: release memang boleh jalan dengan exception open,
    // tapi daftarnya harus sudah ada supaya ada yang bisa menutupnya (R1.4).
    if (aksi === "release") await deteksiException(id);

    const jumlah = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM wave_assignment WHERE wave_id = $1 AND dilepas = false`, [id]);
    const open = await hitungExceptionOpen(id);
    const hasil = transisiWave(wave.status, aksi, {
        jumlahNota: Number(jumlah.rows[0].n), konversiOpen: open.konversi,
    });
    if (!hasil.ok) return NextResponse.json({ error: hasil.alasan }, { status: 409 });

    // Cancel tidak menstempel siapa pun di kolom rilis/konfirmasi -- jejaknya di wave_event.
    const kolomWaktu = aksi === "release" ? ", released_at = now(), released_by = $3"
        : aksi === "confirm" ? ", confirmed_at = now(), confirmed_by = $3"
        : "";
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE wave SET status = $2::wave_status${kolomWaktu} WHERE id = $1`,
            aksi === "cancel" ? [id, hasil.status] : [id, hasil.status, aktor]);
        await client.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,$2,$3,$4::jsonb)`,
            [id, hasil.event, aktor, JSON.stringify({
                jumlah_nota: Number(jumlah.rows[0].n),
                exception_open: open.total,
                alasan: body.alasan ?? null,
            })]);
        await client.query("COMMIT");
        return NextResponse.json({ ok: true, status: hasil.status, exceptionOpen: open });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: `Gagal ${aksi}`, detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
