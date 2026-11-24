/*
 * Tujuan: Unduh seluruh mapping satu principal (barang, pelanggan, salesman, merek surat) sebagai xlsx.
 * Caller: halaman Mapping Principal, tombol "Unduh Excel".
 * Dependensi: xlsx, lib/principal-mapping (writeMappingBook), db/schema, lib/rbac/resolve, lib/principal/pemakai, lib/tampil.
 * Main Functions: GET.
 * Side Effects: DB read `principal_mapping` dan tabel principal resmi. Tidak menulis apa pun.
 *
 * Bentuk berkas = bentuk impor (nama sheet dan judul kolom yang dikenali importir), jadi alurnya unduh -> ubah di Excel -> impor.
 * Izin `principles.view`, sama dengan membaca daftar mapping.
 */
import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { principalMapping } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { writeMappingBook, type MappingKind } from "@/lib/principal-mapping";
import { muatDataResmi, periksaPrincipal } from "@/lib/principal/pemakai";
import { jawabGalat } from "@/lib/principal/tulis";
import { hariIniWita, waktuWita } from "@/lib/tampil";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.view")) {
        return NextResponse.json({ ok: false, error: "Akses mapping principal tidak diizinkan" }, { status: 403 });
    }
    const teks = (request.nextUrl.searchParams.get("principal") ?? "").trim();
    if (!teks) return NextResponse.json({ ok: false, error: "Parameter principal wajib diisi" }, { status: 400 });

    let principal: string;
    try {
        // Sama dengan GET daftar: ejaan yang dikenal -> nama resmi; tak dikenal -> apa adanya (data lama tetap terunduh).
        const h = periksaPrincipal(teks, await muatDataResmi());
        principal = h.status === "tak_dikenal" ? teks : h.principal.nama;
    } catch (error) {
        return jawabGalat(error, "MAPPING UNDUH");
    }

    const rows = await db.select().from(principalMapping)
        .where(eq(principalMapping.principal, principal))
        .orderBy(asc(principalMapping.kind), asc(principalMapping.sourceCode));
    const book = writeMappingBook(rows.map((row) => ({
        kind: row.kind as MappingKind, sourceCode: row.sourceCode, targetCode: row.targetCode,
        unit: row.unit, packSize: row.packSize === null ? null : Number(row.packSize),
        note: row.note, updatedBy: row.updatedBy, updatedAt: waktuWita(row.updatedAt),
    })));
    const nama = `mapping-${principal.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "principal"}-${hariIniWita()}.xlsx`;
    return new NextResponse(new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer), {
        headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": `attachment; filename="${nama}"`,
            "x-jumlah-baris": String(rows.length),
        },
    });
}
