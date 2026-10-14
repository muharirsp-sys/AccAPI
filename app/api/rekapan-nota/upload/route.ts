/*
 * Tujuan: Upload export Accurate "Rincian Faktur Penjualan" -> rekap_upload + wave_line_pool.
 *         Menggantikan seluruh ritual paste ke sheet `Paste Data Pagi/Sore`.
 * Caller: UI /rekapan-nota (browser, multipart).
 * Dependensi: requirePermission, lib/rekapan-nota/parse, lib/db (pool pg).
 * Main Functions: POST.
 * Side Effects: DB write (rekap_upload, wave_line_pool, pick_group jenis_produk, wave_exception REKONSILIASI_SELISIH).
 *   Idempoten per SHA-256 file. Jalur /api/laporan-harian/upload TIDAK disentuh.
 * BL-54: file sore memuat nota pagi juga (R3.7). Per nota di tanggal itu: belum ada -> ditulis; isi sama -> dilewati;
 *   isi berubah & belum masuk wave -> diganti isi terbaru; isi berubah & sudah di wave aktif -> pool TIDAK diubah
 *   (wave tetap memakai isi yang dicetak) dan dicatat exception REKONSILIASI_SELISIH. Unggah per tanggal diserialkan
 *   advisory lock: tanpa unique (tanggal,no_nota,kode_barang), dua unggah serentak sama-sama melihat nota "baru".
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { pool } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { parseAccurateExport } from "@/lib/rekapan-nota/parse";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "rekapan_nota.manage");
    if (gate.response) return gate.response;

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: "Body harus multipart/form-data" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
        return NextResponse.json({ error: "Field 'file' (xlsx export Accurate) wajib." }, { status: 400 });
    }
    const tanggal = String(form.get("tanggal") ?? "").trim();

    const buf = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(buf).digest("hex");

    let hasil;
    try {
        // Tanggal kosong: jangan menebak. File uji memuat 45 hari — memilihkan satu
        // tanggal secara diam-diam persis kelas kesalahan yang sedang dihapus.
        hasil = parseAccurateExport(buf, tanggal || "__belum_dipilih__");
    } catch (e) {
        return NextResponse.json({ error: "File tidak bisa dibaca", detail: String(e) }, { status: 422 });
    }
    if (!tanggal) {
        return NextResponse.json(
            { error: "Pilih tanggal data dulu.", tanggalTersedia: hasil.tanggalTersedia },
            { status: 400 },
        );
    }
    if (hasil.lines.length === 0) {
        return NextResponse.json(
            { error: `Tidak ada baris penjualan bruto bertanggal ${tanggal} di file ini.`,
              tanggalTersedia: hasil.tanggalTersedia },
            { status: 422 },
        );
    }

    // jsonb_to_recordset mencocokkan kunci per NAMA, bukan urutan -> payload wajib
    // snake_case persis seperti definisi kolomnya. `tanggal` tidak ikut: sudah tanggal unggahan.
    const baris = (lines: typeof hasil.lines) => JSON.stringify(lines.map((l) => ({
        no_nota: l.noNota, kode_cust: l.kodeCust, customer: l.customer,
        kode_salesman: l.kodeSalesman, salesman: l.salesman,
        kode_barang: l.kodeBarang, nama_barang: l.namaBarang,
        qty: l.qty, satuan: l.satuan, qty_pcs: l.qtyPcs, satuan_kecil: l.satuanKecil,
        konv_tersirat: l.konvTersirat, jenisproduk: l.jenisproduk, principal: l.principal,
        region: l.region, alamat: l.alamat, kota: l.kota,
    })));
    const recordset = (param: string) => `jsonb_to_recordset(${param}::jsonb) AS x(
                 no_nota text, kode_cust text, customer text, kode_salesman text, salesman text,
                 kode_barang text, nama_barang text, qty numeric, satuan text, qty_pcs numeric,
                 satuan_kecil text, konv_tersirat integer, jenisproduk text, principal text,
                 region text, alamat text, kota text)`;
    // Sidik isi nota = yang menentukan barang diambil; alamat/nama outlet yang diketik ulang tidak dihitung "berubah".
    // numeric(14,4) di kedua sisi: angka file dibulatkan persis seperti saat disimpan, jadi isi sama = sidik sama.
    const SIDIK = `min(kode_cust) || '#' || string_agg(concat_ws('|', kode_barang, qty::numeric(14,4), coalesce(satuan,''),
                       qty_pcs::numeric(14,4), coalesce(satuan_kecil,''), coalesce(konv_tersirat::text,'')), ';' ORDER BY kode_barang)`;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // ponytail: satu kunci per tanggal; unggah tanggal lain tetap paralel. Dilepas otomatis di COMMIT/ROLLBACK.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('rekapan_nota.upload'), ($1::date - DATE '2000-01-01'))`, [tanggal]);
        // ON CONFLICT: file sama diunggah serentak -> yang kedua dapat "sudah ada", bukan 500 unique violation.
        const up = await client.query<{ id: string }>(
            `INSERT INTO rekap_upload (nama_file, sha256, tanggal_data, baris_total, baris_masuk, principal, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sha256) DO NOTHING RETURNING id::text`,
            [file.name, sha256, tanggal, hasil.barisTotal, hasil.barisMasuk, hasil.principal, gate.session!.user.id]);
        if (!up.rowCount) {
            await client.query("ROLLBACK");
            const lama = await pool.query<{ id: string; tanggal_data: string }>(
                `SELECT id::text, tanggal_data::text FROM rekap_upload WHERE sha256 = $1`, [sha256]);
            return NextResponse.json({
                sudahAda: true, uploadId: Number(lama.rows[0]?.id), tanggal: lama.rows[0]?.tanggal_data,
                pesan: "File ini sudah pernah di-upload. Pool tidak digandakan.",
            });
        }
        const uploadId = Number(up.rows[0].id);

        // Klasifikasi per nota terhadap pool tanggal yang sama + wave aktif yang memegangnya.
        const kelas = await client.query<{ no_nota: string; kelas: "baru" | "sama" | "berubah"; wave_id: number | null; wave_nama: string | null; n_lama: number; n_baru: number }>(
            `WITH masuk AS (SELECT x.* FROM ${recordset("$2")}),
                  baru AS (SELECT no_nota, ${SIDIK} AS sidik, count(*)::int AS n FROM masuk GROUP BY no_nota),
                  lama AS (SELECT no_nota, ${SIDIK} AS sidik, count(*)::int AS n FROM wave_line_pool
                            WHERE tanggal = $1::date AND no_nota IN (SELECT no_nota FROM baru) GROUP BY no_nota)
             SELECT b.no_nota,
                    CASE WHEN l.no_nota IS NULL THEN 'baru' WHEN l.sidik = b.sidik THEN 'sama' ELSE 'berubah' END AS kelas,
                    wa.wave_id::int, w.nama AS wave_nama, coalesce(l.n, 0) AS n_lama, b.n AS n_baru
               FROM baru b
               LEFT JOIN lama l ON l.no_nota = b.no_nota
               LEFT JOIN wave_assignment wa ON wa.no_nota = b.no_nota AND wa.tanggal_wave = $1::date AND wa.dilepas = false
               LEFT JOIN wave w ON w.id = wa.wave_id`, [tanggal, baris(hasil.lines)]);
        const baru = kelas.rows.filter((r) => r.kelas === "baru").map((r) => r.no_nota);
        const diganti = kelas.rows.filter((r) => r.kelas === "berubah" && r.wave_id == null).map((r) => r.no_nota);
        const selisih = kelas.rows.filter((r) => r.kelas === "berubah" && r.wave_id != null);
        const tulis = new Set([...baru, ...diganti]);

        if (diganti.length) {
            await client.query(`DELETE FROM wave_line_pool WHERE tanggal = $1::date AND no_nota = ANY($2::text[])`, [tanggal, diganti]);
        }
        await client.query(
            `INSERT INTO wave_line_pool (upload_id, tanggal, no_nota, kode_cust, customer, kode_salesman,
                 salesman, kode_barang, nama_barang, qty, satuan, qty_pcs, satuan_kecil, konv_tersirat,
                 jenisproduk, principal, region, alamat, kota)
             SELECT $1, $2::date, x.* FROM ${recordset("$3")}
             ON CONFLICT (upload_id, no_nota, kode_barang) DO NOTHING`,
            [uploadId, tanggal, baris(hasil.lines.filter((l) => tulis.has(l.noNota)))]);
        if (selisih.length) {
            // DO NOTHING: unggah ulang dengan selisih yang sama tidak membuka lagi exception yang sudah ditutup.
            await client.query(
                `INSERT INTO wave_exception (wave_id, jenis, ref_tipe, ref_kode, keterangan)
                 SELECT s.wave_id, 'REKONSILIASI_SELISIH', 'nota', s.no_nota,
                        'Isi nota di file ' || $2 || ' beda dengan yang sudah di wave (' || s.n_lama || ' -> ' || s.n_baru
                        || ' baris); wave tetap memakai isi lama'
                   FROM jsonb_to_recordset($1::jsonb) AS s(wave_id bigint, no_nota text, n_lama int, n_baru int)
                 ON CONFLICT (wave_id, jenis, ref_tipe, ref_kode) DO NOTHING`,
                [JSON.stringify(selisih), file.name]);
        }

        // Alamat outlet hanya ada di baris nota, bukan di cache Accurate. Diisi HANYA kalau
        // masih kosong: alamat master hasil impor lebih rapi daripada yang diketik di nota.
        await client.query(
            `UPDATE customer c SET alamat = s.alamat
               FROM (SELECT DISTINCT ON (kode_cust) kode_cust, alamat
                       FROM wave_line_pool
                      WHERE upload_id = $1 AND coalesce(alamat,'') <> ''
                      ORDER BY kode_cust) s
              WHERE c."customerNo" = s.kode_cust AND coalesce(c.alamat,'') = ''`, [uploadId]);

        // Grup cetak per jenis produk datang dari data, bukan dari master yang dirawat tangan
        // (§5.2 menolak UI master pick_group). Idempoten, jadi aman tiap upload.
        await client.query(
            `WITH baru AS (
                INSERT INTO pick_group (kode, nama, dimensi, urutan_cetak)
                SELECT DISTINCT 'JP-' || upper(jenisproduk), jenisproduk, 'jenis_produk'::pick_dimensi, 95
                  FROM wave_line_pool WHERE upload_id = $1 AND coalesce(jenisproduk,'') <> ''
                ON CONFLICT (kode) DO NOTHING
                RETURNING id, nama)
             INSERT INTO pick_group_member (pick_group_id, nilai)
             SELECT id, nama FROM baru ON CONFLICT DO NOTHING`, [uploadId]);

        await client.query("COMMIT");

        return NextResponse.json({
            uploadId, tanggal, jumlahNota: kelas.rows.length, jumlahBaris: hasil.lines.length,
            barisTotalFile: hasil.barisTotal, principal: hasil.principal,
            tanggalTersedia: hasil.tanggalTersedia,
            notaBaru: baru.length, notaSudahAda: kelas.rows.filter((r) => r.kelas === "sama").length,
            notaDiganti: diganti.length,
            notaSelisih: selisih.map((r) => ({ noNota: r.no_nota, waveId: r.wave_id, wave: r.wave_nama })),
        });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: "Gagal menyimpan pool", detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
