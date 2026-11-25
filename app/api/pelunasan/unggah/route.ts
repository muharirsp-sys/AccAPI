/**
 * Tujuan: jejak unggahan Pelunasan untuk Hermes (pemilik 25 Nov 2026): POST = ringkasan per baris berkas saat pratinjau dibuat, PATCH =
 *   status & nomor pelunasan sesudah Kirim. Dibaca Hermes (hermes_ro, skrip jaga-pelunasan) untuk dicocokkan dengan cache pelunasan
 *   Accurate (kasir_pelunasan); TIDAK pernah menulis ke Accurate.
 * Caller: app/(dashboard)/pelunasan/Pelunasan.tsx (lewat ./bersama simpanJejak).
 * Dependensi: lib/pelunasan-wizard (bersihkanBarisUnggah), lib/rbac/resolve, lib/db, tabel pelunasan_unggah (db/migrations/0046).
 * Main Functions: POST {id, databaseId, tanggal, namaBerkas, baris} -> {ok}; PATCH {id, baris} -> {ok} (hanya pembuat jejak itu).
 * Side Effects: INSERT/UPDATE pelunasan_unggah. Izin: pelunasan.kirim. Badan ≤ 4 MB, baris divalidasi bentuknya.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pelunasanUnggah } from "@/db/schema";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { bersihkanBarisUnggah } from "@/lib/pelunasan-wizard";

const MAKS_BADAN = 4_000_000;

async function baca(request: Request) {
    const access = await resolveRequestPermissions(request);
    if (access.response) return { galat: access.response };
    if (!access.perms!.has("pelunasan.kirim")) {
        return { galat: NextResponse.json({ ok: false, code: "forbidden", error: "Jejak pelunasan butuh izin pelunasan.kirim." }, { status: 403 }) };
    }
    const teks = await request.text();
    if (teks.length > MAKS_BADAN) return { galat: NextResponse.json({ ok: false, error: "Jejak pelunasan terlalu besar." }, { status: 413 }) };
    let body: Record<string, unknown>;
    try { body = JSON.parse(teks); } catch { return { galat: NextResponse.json({ ok: false, error: "Badan bukan JSON." }, { status: 400 }) }; }
    const id = typeof body.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.id) ? body.id : null;
    const baris = bersihkanBarisUnggah(body.baris);
    if (!id || !baris) return { galat: NextResponse.json({ ok: false, error: "id atau baris jejak tidak sah." }, { status: 400 }) };
    return { userId: String(access.session!.user.id), body, id, baris };
}

export async function POST(request: Request) {
    const r = await baca(request);
    if (r.galat) return r.galat;
    const { body, id, baris, userId } = r;
    const databaseId = typeof body.databaseId === "string" ? body.databaseId.trim().slice(0, 40) : "";
    const tanggal = typeof body.tanggal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.tanggal) ? body.tanggal : "";
    const namaBerkas = typeof body.namaBerkas === "string" ? body.namaBerkas.trim().slice(0, 200) : "";
    if (!databaseId || !tanggal || !namaBerkas) return NextResponse.json({ ok: false, error: "databaseId, tanggal, dan namaBerkas wajib." }, { status: 400 });
    try {
        await db.insert(pelunasanUnggah).values({ id, databaseId, tanggal, namaBerkas, dibuatOleh: userId, baris }).onConflictDoNothing();
        return NextResponse.json({ ok: true });
    } catch (e) {
        console.error("[pelunasan/unggah POST]", e);
        return NextResponse.json({ ok: false, error: "Jejak pelunasan gagal disimpan." }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    const r = await baca(request);
    if (r.galat) return r.galat;
    try {
        const ubah = await db.update(pelunasanUnggah).set({ baris: r.baris, dikirimPada: new Date() })
            .where(and(eq(pelunasanUnggah.id, r.id), eq(pelunasanUnggah.dibuatOleh, r.userId))).returning({ id: pelunasanUnggah.id });
        if (ubah.length === 0) return NextResponse.json({ ok: false, error: "Jejak tidak ditemukan atau bukan milik Anda." }, { status: 404 });
        return NextResponse.json({ ok: true });
    } catch (e) {
        console.error("[pelunasan/unggah PATCH]", e);
        return NextResponse.json({ ok: false, error: "Jejak pelunasan gagal diperbarui." }, { status: 500 });
    }
}
