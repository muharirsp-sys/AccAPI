import { NextResponse } from "next/server";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offPayment } from "@/db/schema";
import { canActorAccessOffData, requireOffSession } from "@/lib/off-program-control";

type Context = { params: Promise<{ paymentId: string }> };

export async function GET(_request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    try {
        const { paymentId } = await context.params;
        const [payment] = await db.select().from(offPayment).where(eq(offPayment.id, paymentId));
        if (!payment) return NextResponse.json({ ok: false, error: "Bukti pembayaran tidak ditemukan." }, { status: 404 });
        if (!payment.paymentProofPath) return NextResponse.json({ ok: false, error: "Payment ini belum memiliki file bukti pembayaran." }, { status: 404 });
        if (!fs.existsSync(payment.paymentProofPath)) return NextResponse.json({ ok: false, error: "File bukti pembayaran tidak ditemukan di server." }, { status: 404 });
        const stats = fs.statSync(payment.paymentProofPath);
        if (stats.size <= 0) return NextResponse.json({ ok: false, error: "File bukti pembayaran kosong." }, { status: 404 });
        const bytes = fs.readFileSync(payment.paymentProofPath);
        const fileName = (payment.paymentProofName || "bukti-pembayaran").replace(/"/g, "");
        return new NextResponse(bytes, {
            headers: {
                "Content-Type": payment.paymentProofMime || "application/octet-stream",
                "Content-Disposition": `inline; filename="${fileName}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("[OFF PAYMENT PROOF ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membuka bukti pembayaran." }, { status: 500 });
    }
}
