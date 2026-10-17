/*
 * Tujuan: Baca, ubah, dan hapus satu baris terjemahan kode principal -> kode internal.
 * Caller: halaman Mapping Principal.
 * Dependensi: db/schema (principalMapping), lib/rbac/resolve, drizzle, lib/principal/pemakai (S7-2b).
 * Main Functions: GET (daftar + cari), PUT (tambah/ubah satu baris), DELETE (satu baris).
 * Side Effects: DB read/write pada `principal_mapping`; DB read tabel principal resmi.
 *
 * S7-2b: principal WAJIB dikenal Data Principal (alias -> principal/varian aktif) dan disimpan dengan NAMA RESMI-nya (nama varian,
 * mis. "KINO NON FOOD", atau nama principal), jadi ejaan lain tidak membuat set mapping kedua. Tak dikenal = 400
 * PRINCIPAL_TIDAK_DIKENAL, nonaktif = 409 PRINCIPAL_NONAKTIF (kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md).
 *
 * Izin memakai modul `principles` yang sudah ada: ini master data principal, bukan modul baru.
 * `view` untuk membaca, `upload` untuk mengubah, `delete` untuk menghapus.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { principalMapping } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { KINDS, type MappingKind } from "@/lib/principal-mapping";
import { muatDataResmi, periksaPrincipal, wajibPrincipal } from "@/lib/principal/pemakai";
import { jawabGalat } from "@/lib/principal/tulis";

export const runtime = "nodejs";

const KIND_NAMES = Object.keys(KINDS) as MappingKind[];
const MAX_LIMIT = 200;

function kindOf(raw: string | null): MappingKind | null {
    return KIND_NAMES.includes(raw as MappingKind) ? (raw as MappingKind) : null;
}

/** Baca/hapus: ejaan yang dikenal -> nama resmi (set yang sama dengan simpan); tak dikenal -> apa adanya (data lama tetap terbaca). */
async function namaBaca(teks: string) {
    const h = periksaPrincipal(teks, await muatDataResmi());
    return h.status === "tak_dikenal" ? teks : h.principal.nama;
}

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.view")) {
        return NextResponse.json({ ok: false, error: "Akses mapping principal tidak diizinkan" }, { status: 403 });
    }
    const params = request.nextUrl.searchParams;
    const kind = kindOf(params.get("kind"));
    if (!kind) return NextResponse.json({ ok: false, error: `kind harus salah satu dari ${KIND_NAMES.join(", ")}` }, { status: 400 });
    const teks = (params.get("principal") ?? "").trim();
    if (!teks) return NextResponse.json({ ok: false, error: "Parameter principal wajib diisi" }, { status: 400 });
    let principal: string;
    try {
        principal = await namaBaca(teks);
    } catch (error) {
        return jawabGalat(error, "MAPPING");
    }

    const search = (params.get("q") ?? "").trim();
    const limit = Math.min(Number(params.get("limit")) || 50, MAX_LIMIT);
    const offset = Math.max(Number(params.get("offset")) || 0, 0);
    const where = and(
        eq(principalMapping.principal, principal),
        eq(principalMapping.kind, kind),
        search ? or(ilike(principalMapping.sourceCode, `%${search}%`), ilike(principalMapping.targetCode, `%${search}%`)) : undefined,
    );

    const [rows, total] = await Promise.all([
        db.select().from(principalMapping).where(where).orderBy(asc(principalMapping.sourceCode)).limit(limit).offset(offset),
        db.select({ value: count() }).from(principalMapping).where(where),
    ]);
    return NextResponse.json({ ok: true, principal, rows, total: total[0]?.value ?? 0, limit, offset });
}

export async function PUT(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.upload")) {
        return NextResponse.json({ ok: false, error: "Akses ubah mapping tidak diizinkan" }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Body tidak valid" }, { status: 400 });

    const teks = String(body.principal ?? "").trim();
    const kind = kindOf(String(body.kind ?? ""));
    const sourceCode = String(body.sourceCode ?? "").trim();
    const targetCode = String(body.targetCode ?? "").trim();
    if (!teks || !kind || !sourceCode || !targetCode) {
        return NextResponse.json({ ok: false, error: "principal, kind, sourceCode, dan targetCode wajib diisi" }, { status: 400 });
    }
    // ISI wajib untuk barang: aturan satuan menaikkan baris ke KRT hanya bila QTY habis
    // dibagi ISI. Mapping barang tanpa ISI membuat satuan baris salah, bukan sekadar kosong.
    const packSize = body.packSize === "" || body.packSize === null || body.packSize === undefined ? null : Number(body.packSize);
    if (kind === "item" && (packSize === null || !Number.isFinite(packSize) || packSize <= 0)) {
        return NextResponse.json({ ok: false, error: "ISI per karton wajib diisi dan harus lebih dari nol untuk mapping barang" }, { status: 400 });
    }
    const unit = String(body.unit ?? "").trim().toUpperCase() || null;
    if (kind === "item" && !unit) {
        return NextResponse.json({ ok: false, error: "Satuan wajib diisi untuk mapping barang" }, { status: 400 });
    }
    let principal: string;
    try {
        principal = wajibPrincipal(teks, await muatDataResmi()).nama;
    } catch (error) {
        return jawabGalat(error, "MAPPING");
    }

    await db.insert(principalMapping).values({
        principal, kind, sourceCode, targetCode,
        unit: kind === "item" ? unit : null,
        packSize: kind === "item" && packSize !== null ? String(packSize) : null,
        note: String(body.note ?? "").trim().slice(0, 500),
        updatedBy: gate.session?.user?.email ?? "",
        updatedAt: new Date(),
    }).onConflictDoUpdate({
        target: [principalMapping.principal, principalMapping.kind, principalMapping.sourceCode],
        set: {
            targetCode, unit: kind === "item" ? unit : null,
            packSize: kind === "item" && packSize !== null ? String(packSize) : null,
            note: String(body.note ?? "").trim().slice(0, 500),
            updatedBy: gate.session?.user?.email ?? "", updatedAt: new Date(),
        },
    });
    return NextResponse.json({ ok: true, principal });
}

export async function DELETE(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.delete")) {
        return NextResponse.json({ ok: false, error: "Akses hapus mapping tidak diizinkan" }, { status: 403 });
    }
    const params = request.nextUrl.searchParams;
    const kind = kindOf(params.get("kind"));
    const teks = (params.get("principal") ?? "").trim();
    const sourceCode = (params.get("sourceCode") ?? "").trim();
    if (!kind || !teks || !sourceCode) {
        return NextResponse.json({ ok: false, error: "principal, kind, dan sourceCode wajib diisi" }, { status: 400 });
    }
    let principal: string;
    try {
        principal = await namaBaca(teks);
    } catch (error) {
        return jawabGalat(error, "MAPPING");
    }
    const removed = await db.delete(principalMapping).where(and(
        eq(principalMapping.principal, principal),
        eq(principalMapping.kind, kind),
        eq(principalMapping.sourceCode, sourceCode),
    )).returning({ sourceCode: principalMapping.sourceCode });
    return NextResponse.json({ ok: true, removed: removed.length });
}

/** Ringkasan jumlah baris per jenis, untuk kepala halaman. */
export async function POST() {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.view")) {
        return NextResponse.json({ ok: false, error: "Akses mapping principal tidak diizinkan" }, { status: 403 });
    }
    const rows = await db
        .select({ principal: principalMapping.principal, kind: principalMapping.kind, total: count(),
                  updatedAt: sql<string>`max(${principalMapping.updatedAt})` })
        .from(principalMapping)
        .groupBy(principalMapping.principal, principalMapping.kind)
        .orderBy(asc(principalMapping.principal), asc(principalMapping.kind));
    return NextResponse.json({ ok: true, summary: rows });
}
