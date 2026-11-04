/*
 * Tujuan: Bukti pembayaran OPC untuk halaman Pantau Pengajuan Promo (owner 3 Nov 2026). Hanya bila principal batch pembayaran itu ada di
 *   cakupan penonton (profil sales + JKS; admin semua) dan batch-nya bukan Draf; selain itu 404 yang sama (keberadaan tidak dibocorkan).
 *   Path berkas dari off_payment.payment_proof_path (ditulis server), tidak pernah dari input pengguna.
 * Caller: tautan "Lihat bukti" (buktiUrl GET /api/off-program-control/pantau).
 * Dependensi: requirePermissionH (off_program_control.pantau_sales), cakupanPantau/dalamCakupan.
 * Main Functions: GET -> berkas (nosniff, no-store; PDF inline tanpa CSP sandbox, gambar inline + CSP sandbox, jenis lain attachment) | 404.
 * Side Effects: DB read + baca berkas. Tidak menulis.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offPayment } from "@/db/schema";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { cakupanPantau, dalamCakupan } from "@/lib/off-program-control/pantau";

export const runtime = "nodejs";

type Context = { params: Promise<{ paymentId: string }> };

const tidakAda = () => NextResponse.json({ ok: false, error: "Bukti pembayaran tidak ditemukan." }, { status: 404 });
const GAMBAR: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg" };

export async function GET(_request: Request, context: Context) {
    const gate = await requirePermissionH("off_program_control.pantau_sales");
    if (gate.response) return gate.response;
    const { paymentId } = await context.params;
    if (!/^[\w-]{1,64}$/.test(paymentId)) return tidakAda();
    try {
        const [row] = await db.select({
            paymentNo: offPayment.paymentNo, path: offPayment.paymentProofPath, mime: offPayment.paymentProofMime,
            principleCode: offBatch.principleCode, noPengajuan: offBatch.noPengajuan,
        }).from(offPayment).innerJoin(offBatch, eq(offBatch.id, offPayment.batchId))
            .where(and(eq(offPayment.id, paymentId), ne(offBatch.status, "Draft"))).limit(1);
        if (!row?.path || !dalamCakupan(await cakupanPantau(gate.session.user), row.principleCode)) return tidakAda();
        let isi: Buffer;
        try {
            isi = await readFile(row.path);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return tidakAda();
            throw e;
        }
        if (!isi.length) return tidakAda();
        const mime = String(row.mime || "").toLowerCase();
        const pdf = mime === "application/pdf";
        const gambar = GAMBAR[mime];
        const nama = `bukti-${row.noPengajuan.replace(/[^\w.-]+/g, "-")}-ke${row.paymentNo}.${pdf ? "pdf" : gambar ?? "bin"}`;
        return new NextResponse(new Uint8Array(isi), {
            headers: {
                "content-type": pdf ? mime : gambar === "png" ? "image/png" : gambar ? "image/jpeg" : "application/octet-stream",
                "content-disposition": `${pdf || gambar ? "inline" : "attachment"}; filename="${nama}"`,
                "x-content-type-options": "nosniff",
                // CSP sandbox mematikan penampil PDF Chrome (halaman kosong), jadi PDF dibuka tanpa sandbox; nosniff + content-type pasti
                // tetap mencegah berkas dibaca sebagai HTML. Gambar dan jenis lain tetap sandbox (pola app/api/kasir/bukti).
                ...(pdf ? {} : { "content-security-policy": "sandbox" }),
                "cache-control": "private, no-store",
            },
        });
    } catch (error) {
        console.error("[OPC PANTAU BUKTI]", error);
        return NextResponse.json({ ok: false, error: "Bukti pembayaran gagal dibuka." }, { status: 500 });
    }
}
