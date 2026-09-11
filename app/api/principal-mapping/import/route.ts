/*
 * Tujuan: Muat tiga sheet terjemahan principal (KINO.xlsx) sekaligus ke `principal_mapping`.
 * Caller: halaman Mapping Principal, tombol "Impor berkas".
 * Dependensi: xlsx, lib/principal-mapping, db/schema, lib/rbac/resolve.
 * Main Functions: POST.
 * Side Effects: DB write (upsert) HANYA bila `apply=true`; tanpa itu murni pratinjau.
 *
 * Default pratinjau, sama seperti importir kelas outlet: berkas principal sering salah versi,
 * dan menimpa mapping dengan berkas yang keliru membuat setiap baris faktur salah barang.
 * Mengganti (bukan menambah) per jenis yang diimpor juga disengaja — kode yang dicabut
 * principal harus benar-benar hilang, bukan menumpuk dari muatan sebelumnya.
 */
import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { principalMapping } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { KINDS, readMappingSheet, type MappingKind } from "@/lib/principal-mapping";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const KIND_NAMES = Object.keys(KINDS) as MappingKind[];

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("principles.upload")) {
        return NextResponse.json({ ok: false, error: "Akses impor mapping tidak diizinkan" }, { status: 403 });
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Pilih berkas xlsx terlebih dahulu" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "Berkas maksimal 10 MB" }, { status: 413 });

    const principal = String(form?.get("principal") ?? "").trim();
    if (!principal) return NextResponse.json({ ok: false, error: "Nama principal wajib diisi" }, { status: 400 });
    const apply = String(form?.get("apply") ?? "") === "true";
    const picked = String(form?.get("kinds") ?? "").split(",").map((k) => k.trim()).filter(Boolean) as MappingKind[];
    const kinds = picked.length ? picked.filter((k) => KIND_NAMES.includes(k)) : KIND_NAMES;
    if (!kinds.length) return NextResponse.json({ ok: false, error: `kinds harus berisi ${KIND_NAMES.join(", ")}` }, { status: 400 });

    let book: XLSX.WorkBook;
    try {
        book = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    } catch {
        return NextResponse.json({ ok: false, error: "Berkas tidak bisa dibaca sebagai xlsx" }, { status: 422 });
    }

    const report = kinds.map((kind) => {
        const { rows, issues } = readMappingSheet(book, kind);
        return { kind, label: KINDS[kind].label, sheet: KINDS[kind].sheet, count: rows.length, issues, rows };
    });
    const usable = report.filter((entry) => entry.rows.length > 0);
    if (!apply) {
        return NextResponse.json({
            ok: true, applied: false, principal,
            result: report.map(({ rows, ...rest }) => ({ ...rest, sample: rows.slice(0, 5) })),
        });
    }
    if (!usable.length) {
        return NextResponse.json({ ok: false, error: "Tidak ada satu pun baris yang bisa dimuat dari berkas ini" }, { status: 422 });
    }

    const by = gate.session?.user?.email ?? "";
    const now = new Date();
    await db.transaction(async (tx) => {
        await tx.delete(principalMapping).where(and(
            eq(principalMapping.principal, principal),
            inArray(principalMapping.kind, usable.map((entry) => entry.kind)),
        ));
        for (const entry of usable) {
            // Dipotong per 1000 supaya satu berkas besar tidak jadi satu statement raksasa.
            for (let start = 0; start < entry.rows.length; start += 1000) {
                await tx.insert(principalMapping).values(entry.rows.slice(start, start + 1000).map((row) => ({
                    principal, kind: row.kind, sourceCode: row.sourceCode, targetCode: row.targetCode,
                    unit: row.unit, packSize: row.packSize === null ? null : String(row.packSize),
                    note: "", updatedBy: by, updatedAt: now,
                })));
            }
        }
    });

    return NextResponse.json({
        ok: true, applied: true, principal,
        result: report.map(({ rows, ...rest }) => ({ ...rest, sample: rows.slice(0, 5) })),
    });
}
