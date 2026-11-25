/**
 * Tujuan: Laporan penyesuaian Pelunasan (pemilik 25 Nov 2026): faktur yang cara bayarnya di Accurate berbeda dari berkas Excel (uang
 *   masuk rekening yang tidak ada di berkas, mis. berkas Tunai tetapi Accurate Transfer Maybank), siapa pun yang menginput.
 * Caller: app/(dashboard)/pelunasan/Penyesuaian.tsx.
 * Dependensi: pelunasan_unggah (jejak berkas, 0046), kasir_pelunasan + kasir_pelunasan_faktur + kasir_pelunasan_baca (cache pelunasan
 *   Accurate tiap 15 menit), lib/pelunasan-wizard (bandingkanCaraBayar, bersihkanBarisUnggah), lib/rbac/resolve.
 * Main Functions: GET ?tanggal=YYYY-MM-DD&database=ID (keduanya opsional: bawaan = tanggal berkas terbaru) -> {ok, tanggal, databaseId,
 *   tersedia:[{tanggal, databaseId, berkas}], berkas:[{nama, dibuatPada, dikirimPada, baris}], cache:{status, lengkapPada}, rows}.
 * Side Effects: SELECT saja. Izin: pelunasan.kirim atau finance.view.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { bandingkanCaraBayar, bersihkanBarisUnggah, type PelunasanAccurate } from "@/lib/pelunasan-wizard";

type Rec = Record<string, unknown>;

export async function GET(request: Request) {
    const access = await resolveRequestPermissions(request);
    if (access.response) return access.response;
    if (!access.perms!.has("pelunasan.kirim") && !access.perms!.has("finance.view")) {
        return NextResponse.json({ ok: false, code: "forbidden", error: "Laporan penyesuaian butuh izin pelunasan.kirim atau finance.view." }, { status: 403 });
    }
    try {
        const q = new URL(request.url).searchParams;
        const tersedia = ((await db.execute(sql`SELECT database_id, tanggal::text AS tanggal, count(DISTINCT nama_berkas)::int AS berkas
            FROM pelunasan_unggah GROUP BY 1, 2 ORDER BY 2 DESC LIMIT 30`)).rows as Rec[])
            .map((r) => ({ databaseId: String(r.database_id), tanggal: String(r.tanggal), berkas: Number(r.berkas) }));
        const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(q.get("tanggal") ?? "") ? q.get("tanggal")! : tersedia[0]?.tanggal;
        const databaseId = q.get("database")?.trim() || tersedia.find((t) => t.tanggal === tanggal)?.databaseId;
        if (!tanggal || !databaseId) return NextResponse.json({ ok: true, tersedia, tanggal: tanggal ?? null, databaseId: null, berkas: [], cache: null, rows: [] });

        const berkas = (await db.execute(sql`SELECT DISTINCT ON (nama_berkas) nama_berkas, dibuat_pada, dikirim_pada, baris
            FROM pelunasan_unggah WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date
            ORDER BY nama_berkas, dibuat_pada DESC`)).rows as Rec[];
        const isi = berkas.map((b) => ({ nama: String(b.nama_berkas), baris: bersihkanBarisUnggah(b.baris) ?? [] }));
        const faktur = [...new Set(isi.flatMap((b) => b.baris.map((x) => x.faktur)).filter(Boolean))];
        const acc: PelunasanAccurate[] = faktur.length === 0 ? [] : ((await db.execute(sql`
            SELECT f.nomor_faktur AS faktur, p.nomor, f.invoice_payment::float8 AS ip,
                   EXISTS (SELECT 1 FROM kasir_pelunasan_faktur n WHERE n.database_id = p.database_id AND n.pelunasan_id = p.pelunasan_id
                           AND n.invoice_payment < 0) AS ada_retur
            FROM kasir_pelunasan p
            JOIN kasir_pelunasan_faktur f ON f.database_id = p.database_id AND f.pelunasan_id = p.pelunasan_id
            WHERE p.database_id = ${databaseId} AND p.tanggal = ${tanggal}::date AND f.nomor_faktur = ANY(${sql.param(faktur)}::text[])`)).rows as Rec[])
            .map((r) => ({ faktur: String(r.faktur), nomor: String(r.nomor), ip: Number(r.ip), adaRetur: Boolean(r.ada_retur) }));
        const [cache] = (await db.execute(sql`SELECT status, lengkap_pada FROM kasir_pelunasan_baca
            WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date`)).rows as Rec[];

        return NextResponse.json({
            ok: true, tersedia, tanggal, databaseId,
            berkas: berkas.map((b, i) => ({ nama: isi[i].nama, dibuatPada: b.dibuat_pada, dikirimPada: b.dikirim_pada, baris: isi[i].baris.length })),
            cache: cache ? { status: String(cache.status), lengkapPada: cache.lengkap_pada ?? null } : null,
            rows: bandingkanCaraBayar(isi, acc),
        });
    } catch (e) {
        console.error("[pelunasan/penyesuaian]", e);
        return NextResponse.json({ ok: false, error: "Laporan penyesuaian gagal dibaca." }, { status: 500 });
    }
}
