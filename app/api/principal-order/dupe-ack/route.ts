/*
 * Tujuan: Menyatakan bahwa sebuah SO yang ditahan gerbang kemiripan BUKAN order ganda.
 * Caller: halaman Order Principal, tombol konfirmasi pada SO yang tertahan.
 * Dependensi: db (order_dupe_ack, pencabutan_log), rbac. Main Functions: GET, POST, DELETE.
 * Side Effects: menulis `order_dupe_ack`; SO yang tercatat di sana tidak lagi ditahan gerbang. DELETE (cabut, alasan wajib)
 *   menyalin baris yang dicabut + alasan ke `pencabutan_log` dalam transaksi yang sama (audit desain 001 No 18).
 *
 * Konfirmasinya BERTAHAN, dan itu disengaja: validasi batch dijalankan berulang kali, dan
 * konfirmasi yang hilang tiap kali divalidasi ulang sama saja dengan tidak punya konfirmasi.
 *
 * Yang disimpan bukan hanya "siapa menekan tombol" melainkan ALASAN yang sedang ditahan saat itu.
 * Yang membaca jejak ini nanti perlu tahu APA yang sudah diperiksa orang tersebut — tanda tangan
 * tanpa isi tidak bisa dipertanggungjawabkan.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { orderDupeAck, pencabutanLog } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const text = (value: unknown) => String(value ?? "").trim();
/** Alasan cabut minimal (sesudah trim), sama dengan dialog Cabut di layar (principal-order/LangkahBatch.tsx). */
const ALASAN_CABUT_MIN = 10;

async function gateOf(perlu: "order.view" | "order.create") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses konfirmasi order tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

export async function GET(request: NextRequest) {
    const gate = await gateOf("order.view");
    if (gate.response) return gate.response;
    const principal = text(request.nextUrl.searchParams.get("principal"));
    const rows = await db.select().from(orderDupeAck)
        .where(principal ? eq(orderDupeAck.principal, principal) : undefined);
    return NextResponse.json({ ok: true, acks: rows });
}

export async function POST(request: NextRequest) {
    const gate = await gateOf("order.create");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const principal = text(body?.principal);
    const soNo = text(body?.soNo);
    if (!principal || !soNo) return NextResponse.json({ ok: false, error: "Principal dan nomor SO wajib diisi" }, { status: 400 });

    await db.insert(orderDupeAck).values({
        principal, soNo, reason: text(body?.reason).slice(0, 2000), note: text(body?.note).slice(0, 500),
        confirmedBy: gate.email!,
    }).onConflictDoUpdate({
        target: [orderDupeAck.principal, orderDupeAck.soNo],
        set: { reason: text(body?.reason).slice(0, 2000), note: text(body?.note).slice(0, 500),
            confirmedBy: gate.email!, confirmedAt: new Date() },
    });
    return NextResponse.json({ ok: true, principal, soNo, confirmedBy: gate.email });
}

/**
 * Mencabut konfirmasi: SO-nya kembali ditahan gerbang pada validasi berikutnya. Kunci tetap di query (`principal`, `soNo`); body
 * JSON `{ alasan }` wajib. Baris yang dicabut + alasan disalin ke `pencabutan_log` dalam transaksi yang sama (DELETE ... RETURNING).
 */
export async function DELETE(request: NextRequest) {
    const gate = await gateOf("order.create");
    if (gate.response) return gate.response;
    const principal = text(request.nextUrl.searchParams.get("principal"));
    const soNo = text(request.nextUrl.searchParams.get("soNo"));
    if (!principal || !soNo) return NextResponse.json({ ok: false, error: "Principal dan nomor SO wajib diisi" }, { status: 400 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const alasan = text(body?.alasan).slice(0, 2000);
    if (alasan.length < ALASAN_CABUT_MIN) {
        return NextResponse.json({ ok: false, error: `Alasan mencabut wajib diisi, minimal ${ALASAN_CABUT_MIN} karakter.` }, { status: 400 });
    }
    const dicabut = await db.transaction(async (tx) => {
        const gone = await tx.delete(orderDupeAck)
            .where(and(eq(orderDupeAck.principal, principal), eq(orderDupeAck.soNo, soNo)))
            .returning();
        if (gone.length) {
            await tx.insert(pencabutanLog).values(gone.map((baris) => ({
                jenis: "order_dupe_ack", kunci: `${baris.principal}|${baris.soNo}`, barisLama: baris, alasan, oleh: gate.email!,
            })));
        }
        return gone.length;
    });
    return NextResponse.json({ ok: true, dicabut });
}
