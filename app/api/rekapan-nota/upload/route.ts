/*
 * Tujuan: Upload export Accurate "Rincian Faktur Penjualan" -> rekap_upload + wave_line_pool.
 *         Menggantikan seluruh ritual paste ke sheet `Paste Data Pagi/Sore`.
 * Caller: UI /rekapan-nota (browser, multipart).
 * Dependensi: requirePermission, lib/rekapan-nota/parse, lib/db (pool pg).
 * Main Functions: POST.
 * Side Effects: DB write (rekap_upload, wave_line_pool, pick_group jenis_produk).
 *   Idempoten per SHA-256 file. Jalur /api/laporan-harian/upload TIDAK disentuh.
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

    const client = await pool.connect();
    try {
        const lama = await client.query<{ id: string; tanggal_data: string }>(
            `SELECT id::text, tanggal_data::text FROM rekap_upload WHERE sha256 = $1`, [sha256]);
        if (lama.rowCount) {
            return NextResponse.json({
                sudahAda: true, uploadId: Number(lama.rows[0].id), tanggal: lama.rows[0].tanggal_data,
                pesan: "File ini sudah pernah di-upload. Pool tidak digandakan.",
            });
        }

        await client.query("BEGIN");
        const up = await client.query<{ id: string }>(
            `INSERT INTO rekap_upload (nama_file, sha256, tanggal_data, baris_total, baris_masuk, principal, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
            [file.name, sha256, tanggal, hasil.barisTotal, hasil.barisMasuk, hasil.principal, gate.session!.user.id]);
        const uploadId = Number(up.rows[0].id);

        await client.query(
            `INSERT INTO wave_line_pool (upload_id, tanggal, no_nota, kode_cust, customer, kode_salesman,
                 salesman, kode_barang, nama_barang, qty, satuan, qty_pcs, satuan_kecil, konv_tersirat,
                 jenisproduk, principal, region, alamat, kota)
             SELECT $1, $2::date, x.* FROM jsonb_to_recordset($3::jsonb) AS x(
                 no_nota text, kode_cust text, customer text, kode_salesman text, salesman text,
                 kode_barang text, nama_barang text, qty numeric, satuan text, qty_pcs numeric,
                 satuan_kecil text, konv_tersirat integer, jenisproduk text, principal text,
                 region text, alamat text, kota text)
             ON CONFLICT (upload_id, no_nota, kode_barang) DO NOTHING`,
            // jsonb_to_recordset mencocokkan kunci per NAMA, bukan urutan -> payload wajib
            // snake_case persis seperti definisi kolomnya. `tanggal` tidak ikut: sudah $2.
            [uploadId, tanggal, JSON.stringify(hasil.lines.map((l) => ({
                no_nota: l.noNota, kode_cust: l.kodeCust, customer: l.customer,
                kode_salesman: l.kodeSalesman, salesman: l.salesman,
                kode_barang: l.kodeBarang, nama_barang: l.namaBarang,
                qty: l.qty, satuan: l.satuan, qty_pcs: l.qtyPcs, satuan_kecil: l.satuanKecil,
                konv_tersirat: l.konvTersirat, jenisproduk: l.jenisproduk, principal: l.principal,
                region: l.region, alamat: l.alamat, kota: l.kota,
            })))]);

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

        const jumlahNota = new Set(hasil.lines.map((l) => l.noNota)).size;
        return NextResponse.json({
            uploadId, tanggal, jumlahNota, jumlahBaris: hasil.lines.length,
            barisTotalFile: hasil.barisTotal, principal: hasil.principal,
            tanggalTersedia: hasil.tanggalTersedia,
        });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return NextResponse.json({ error: "Gagal menyimpan pool", detail: String(e) }, { status: 500 });
    } finally {
        client.release();
    }
}
