/*
 * Tujuan: Isi wave — tambah nota dari pool, ubah prioritas, dan take-out berapproval gudang.
 *         Eksklusivitas dijamin unique index `uq_nota_aktif`, bukan validasi aplikasi:
 *         SELECT-lalu-INSERT punya jendela balapan, unique index tidak.
 * Caller: UI /rekapan-nota/wave/[id].
 * Dependensi: resolveRequestPermissions (otorisasi majemuk: manage vs approve_takeout), lib/db.
 * Main Functions: POST (tambah nota), PATCH (prioritas | takeout).
 * Side Effects: INSERT/UPDATE wave_assignment + wave_event.
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { ambilSetting } from "@/lib/rekapan-nota/query";
import { parseAreaDikecualikan } from "@/lib/rekapan-nota/classify";

export const runtime = "nodejs";

type WaveRow = { id: number; tanggal: string; tipe: string; status: string };

async function ambilWave(id: number): Promise<WaveRow | null> {
    const r = await pool.query<WaveRow>(
        `SELECT id::int, tanggal::text, tipe::text, status::text FROM wave WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await resolveRequestPermissions(req);
    if (gate.response) return gate.response;
    if (!gate.perms!.has("rekapan_nota.manage"))
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const id = Number((await ctx.params).id);
    const body = await req.json().catch(() => ({})) as { noNota?: string[]; prioritas?: string };
    const noNota = (body.noNota ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!noNota.length) return NextResponse.json({ error: "noNota[] wajib." }, { status: 400 });

    const wave = await ambilWave(id);
    if (!wave) return NextResponse.json({ error: "Wave tidak ditemukan" }, { status: 404 });
    if (wave.status !== "draft")
        return NextResponse.json({ error: `Wave sudah "${wave.status}"; isinya tidak boleh berubah.` }, { status: 409 });

    const prioritas = body.prioritas === "urgent" ? "urgent" : "normal";
    const kanvas = wave.tipe === "kanvas";
    const [ambangRaw, dikecualikanRaw] = await Promise.all([
        ambilSetting("rekapan.ambang_pareto_karton", "50"),
        ambilSetting("rekapan.area_dikecualikan", "NON,LUAR KOTA"),
    ]);
    const dikecualikan = parseAreaDikecualikan(dikecualikanRaw).map((a) => a.toUpperCase());

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Snapshot klasifikasi dihitung SEKARANG dan disimpan: master boleh berubah besok,
        // rekapan hari ini tidak boleh ikut berubah (R2.2).
        const ins = await client.query<{ no_nota: string }>(
            `WITH src AS (
                SELECT p.no_nota,
                       max(upper(c.area))                  AS area,
                       coalesce(max(c.grup_all), 'Gabung') AS grup_all,
                       coalesce(max(c.grup_gdi), 'Gabung') AS grup_gdi,
                       sum(p.qty_pcs / NULLIF(coalesce(p.konv_tersirat, i.isi_per_karton), 0)) AS total_krt
                  FROM wave_line_pool p
                  LEFT JOIN customer c ON c."customerNo" = p.kode_cust
                  LEFT JOIN item i     ON i.no = p.kode_barang
                 WHERE p.tanggal = $2::date AND p.no_nota = ANY($3::text[])
                 GROUP BY p.no_nota)
             INSERT INTO wave_assignment (wave_id, wave_tipe, no_nota, tanggal_wave, prioritas,
                 snap_grup_all, snap_grup_gdi, snap_area, snap_pareto, snap_total_krt, snap_kanvas, created_by)
             SELECT $1, $6::wave_tipe, src.no_nota, $2::date, $5::wave_prioritas,
                    src.grup_all, src.grup_gdi, src.area,
                    (src.total_krt >= $4), src.total_krt, $7::boolean, $8
               FROM src
              WHERE EXISTS (SELECT 1 FROM nota_kanvas k WHERE k.no_nota = src.no_nota) = $7
                AND coalesce(src.area, '') <> ALL ($9::text[])
             ON CONFLICT DO NOTHING
             RETURNING no_nota`,
            [id, wave.tanggal, noNota, Number(ambangRaw) || 50, prioritas,
                wave.tipe, kanvas, gate.session!.user.id, dikecualikan]);

        const masuk = ins.rows.map((r) => r.no_nota);
        const ditolak = noNota.filter((n) => !masuk.includes(n));

        // "Kenapa nota ini tidak ada di rekapan sore?" — dijawab dalam satu query, sesuatu
        // yang hari ini mustahil. Karena itu penolakan ikut dicatat, bukan cuma dibalas 409.
        let pemilik: unknown[] = [];
        if (ditolak.length) {
            const own = await client.query(
                `SELECT wa.no_nota, wa.wave_id::int, w.tanggal::text, w.nama
                   FROM wave_assignment wa JOIN wave w ON w.id = wa.wave_id
                  WHERE wa.dilepas = false AND wa.no_nota = ANY($1::text[])`, [ditolak]);
            pemilik = own.rows;
            await client.query(
                `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,'wave.nota_add_rejected',$2,$3::jsonb)`,
                [id, gate.session!.user.id, JSON.stringify({ no_nota: ditolak, pemilik })]);
        }
        if (masuk.length) {
            await client.query(
                `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,'wave.nota_added',$2,$3::jsonb)`,
                [id, gate.session!.user.id, JSON.stringify({ no_nota: masuk, prioritas })]);
        }
        await client.query("COMMIT");

        return NextResponse.json({ masuk, ditolak, pemilik }, { status: ditolak.length ? 409 : 200 });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: "Gagal menambah nota", detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const gate = await resolveRequestPermissions(req);
    if (gate.response) return gate.response;

    const id = Number((await ctx.params).id);
    const body = await req.json().catch(() => ({})) as
        { aksi?: string; noNota?: string; prioritas?: string; alasan?: string };
    const noNota = String(body.noNota ?? "").trim();
    if (!noNota) return NextResponse.json({ error: "noNota wajib." }, { status: 400 });

    if (body.aksi === "prioritas") {
        if (!gate.perms!.has("rekapan_nota.manage"))
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const prioritas = body.prioritas === "urgent" ? "urgent" : "normal";
        // Prioritas memengaruhi URUTAN, bukan keanggotaan (R4.2): ia tidak boleh membuat
        // nota hilang dari lembar mana pun — yang persis terjadi di workbook hari ini.
        const r = await pool.query(
            `UPDATE wave_assignment SET prioritas = $3::wave_prioritas
              WHERE wave_id = $1 AND no_nota = $2 AND dilepas = false`, [id, noNota, prioritas]);
        if (!r.rowCount) return NextResponse.json({ error: "Nota tidak ada di wave ini." }, { status: 404 });
        await pool.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,'wave.prioritas_changed',$2,$3::jsonb)`,
            [id, gate.session!.user.id, JSON.stringify({ no_nota: noNota, ke: prioritas })]);
        return NextResponse.json({ ok: true, prioritas });
    }

    if (body.aksi === "takeout") {
        // Q9: melepas nota butuh persetujuan gudang, dengan alasan wajib. Yang memaksa
        // alasan terisi adalah ck_takeout di DB, bukan kesopanan di sini.
        if (!gate.perms!.has("rekapan_nota.approve_takeout"))
            return NextResponse.json({ error: "Butuh permission rekapan_nota.approve_takeout" }, { status: 403 });
        const alasan = String(body.alasan ?? "").trim();
        if (alasan.length < 5) return NextResponse.json({ error: "alasan wajib diisi (min 5 karakter)." }, { status: 400 });

        const r = await pool.query(
            `UPDATE wave_assignment
                SET dilepas = true, dilepas_alasan = $3, dilepas_at = now(), dilepas_by = $4
              WHERE wave_id = $1 AND no_nota = $2 AND dilepas = false`,
            [id, noNota, alasan, gate.session!.user.id]);
        if (!r.rowCount) return NextResponse.json({ error: "Nota tidak ada / sudah dilepas." }, { status: 404 });
        await pool.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,'wave.nota_released',$2,$3::jsonb)`,
            [id, gate.session!.user.id, JSON.stringify({ no_nota: noNota, alasan })]);
        return NextResponse.json({ ok: true, pesan: "Nota kembali ke pool." });
    }

    return NextResponse.json({ error: "aksi harus prioritas | takeout" }, { status: 400 });
}
