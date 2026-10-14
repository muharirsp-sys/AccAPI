/*
 * Tujuan: Detail satu wave + transisi status (release / confirm / cancel) dan pemilihan pick_group.
 * Caller: UI /rekapan-nota/wave/[id].
 * Dependensi: requirePermission, wave-state, exception, lib/db (pool pg).
 * Main Functions: GET (detail + isi + exception + riwayat), PATCH (aksi transisi / set grup cetak).
 * Side Effects: UPDATE wave, INSERT wave_event, INSERT wave_exception (saat release),
 *   UPDATE wave_assignment (cancel melepas semua nota aktif, BL-25).
 * BL-25: UPDATE transisi bersyarat status lama (409 bila layar lain lebih dulu); set_grup ditolak pada wave tertutup.
 */
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { tolakUbahIsi, transisiWave, type WaveAksi, type WaveStatus } from "@/lib/rekapan-nota/wave-state";
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

    const [nota, exception, grup, tersedia, riwayat] = await Promise.all([
        pool.query(
            `SELECT wa.no_nota, wa.prioritas::text, wa.snap_area, wa.snap_grup_all, wa.snap_grup_gdi,
                    wa.snap_pareto, wa.snap_total_krt::float8, wa.dilepas, wa.dilepas_alasan, wa.dilepas_at,
                    min(coalesce(u.name, wa.dilepas_by)) AS dilepas_oleh,
                    min(p.customer) AS customer, min(p.region) AS region, min(p.salesman) AS salesman,
                    count(p.id)::int AS jumlah_baris, sum(p.qty_pcs)::float8 AS total_pcs
               FROM wave_assignment wa
               LEFT JOIN wave_line_pool p ON p.no_nota = wa.no_nota AND p.tanggal = wa.tanggal_wave
               LEFT JOIN "user" u ON u.id = wa.dilepas_by
              WHERE wa.wave_id = $1
              GROUP BY wa.id
              ORDER BY wa.dilepas, wa.prioritas DESC, wa.no_nota`, [id]),
        // BL-24: nilai master SAAT INI sebagai petunjuk menutup exception, plus siapa/kapan/alasan penutupannya
        // (alasan hanya ada di wave_event -- tanpa kolom baru).
        pool.query(
            `SELECT e.id::int, e.jenis::text, e.ref_tipe, e.ref_kode, e.keterangan, e.status::text,
                    e.resolved_at, coalesce(u.name, e.resolved_by) AS resolved_oleh,
                    CASE e.ref_tipe
                        WHEN 'item' THEN (SELECT max(i.isi_per_karton)::text FROM item i WHERE i.no = e.ref_kode)
                        WHEN 'customer' THEN (SELECT max(c.area) FROM customer c WHERE c."customerNo" = e.ref_kode)
                    END AS master_saat_ini,
                    (SELECT ev.payload->>'alasan' FROM wave_event ev
                      WHERE ev.wave_id = e.wave_id AND ev.event = 'wave.exception_resolved'
                        AND ev.payload->>'exception_id' = e.id::text
                      ORDER BY ev.id DESC LIMIT 1) AS alasan
               FROM wave_exception e LEFT JOIN "user" u ON u.id = e.resolved_by
              WHERE e.wave_id = $1 ORDER BY e.status, e.jenis, e.ref_kode`, [id]),
        pool.query(
            `SELECT g.id::int, g.kode, g.nama, g.dimensi::text
               FROM wave_pick_group wpg JOIN pick_group g ON g.id = wpg.pick_group_id
              WHERE wpg.wave_id = $1 ORDER BY g.urutan_cetak`, [id]),
        // Riwayat untuk bagian "Riwayat" Object Page (baca saja; wave_event append-only).
        pool.query(
            `SELECT e.event, e.created_at, e.payload, coalesce(u.name, e.aktor_id) AS aktor
               FROM wave_event e LEFT JOIN "user" u ON u.id = e.aktor_id
              WHERE e.wave_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`, [id]),
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
        riwayat: riwayat.rows,
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
            // FOR SHARE: konfirmasi/batal serentak menunggu transaksi ini (atau sebaliknya), jadi status yang
            // dibaca di sini adalah status saat grup ditulis -- bukan status saat halaman dibuka.
            const st = await client.query<{ status: WaveStatus }>(`SELECT status::text FROM wave WHERE id = $1 FOR SHARE`, [id]);
            const tolak = tolakUbahIsi(st.rows[0].status, "set_grup");
            if (tolak) {
                await client.query("ROLLBACK");
                return NextResponse.json({ error: tolak }, { status: 409 });
            }
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
    const kolomWaktu = aksi === "release" ? ", released_at = now(), released_by = $4"
        : aksi === "confirm" ? ", confirmed_at = now(), confirmed_by = $4"
        : "";
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // `AND status = <lama>`: gerbang di atas membaca status sebelum transaksi; bila layar lain sudah
        // mengubahnya, UPDATE ini tidak mengenai baris apa pun -> 409, bukan menimpa (BL-25).
        const upd = await client.query(
            `UPDATE wave SET status = $2::wave_status${kolomWaktu} WHERE id = $1 AND status = $3::wave_status`,
            aksi === "cancel" ? [id, hasil.status, wave.status] : [id, hasil.status, wave.status, aktor]);
        if (!upd.rowCount) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "Status wave sudah diubah di layar lain. Muat ulang halaman." }, { status: 409 });
        }
        // Batal melepas semua nota aktif di transaksi yang sama: uq_nota_aktif dan pool berhenti
        // menganggapnya terpakai, jadi nota bisa masuk wave lain hari ini (BL-25).
        const kembali = aksi === "cancel"
            ? (await client.query<{ no_nota: string }>(
                `UPDATE wave_assignment
                    SET dilepas = true, dilepas_alasan = 'wave dibatalkan', dilepas_at = now(), dilepas_by = $2
                  WHERE wave_id = $1 AND dilepas = false RETURNING no_nota`, [id, aktor])).rows.map((r) => r.no_nota)
            : [];
        await client.query(
            `INSERT INTO wave_event (wave_id, event, aktor_id, payload) VALUES ($1,$2,$3,$4::jsonb)`,
            [id, hasil.event, aktor, JSON.stringify({
                jumlah_nota: Number(jumlah.rows[0].n),
                exception_open: open.total,
                alasan: body.alasan ?? null,
                ...(aksi === "cancel" ? { nota_kembali: kembali } : {}),
            })]);
        await client.query("COMMIT");
        return NextResponse.json({ ok: true, status: hasil.status, exceptionOpen: open, notaKembali: kembali.length });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: `Gagal ${aksi}`, detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
