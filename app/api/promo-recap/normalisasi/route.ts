/*
 * Tujuan: Menyimpan / mencabut keputusan atas potongan TAK BERTUAN pada faktur Accurate (termasuk
 *         yang terbit lewat web): klaim principal atau tanggungan distributor.
 * Caller: halaman Normalisasi Diskon (/normalisasi-diskon). Barisnya dibaca dari GET /api/promo-recap.
 * Dependensi: db (discount_normalization), rbac. Main Functions: POST, DELETE.
 * Side Effects: menulis `discount_normalization`. TIDAK menulis ke Accurate — fakturnya tetap
 *               apa adanya; yang berubah hanya cara Rekap Promo menggolongkannya.
 *
 * Nominal tiap baris ikut disimpan dan diadu saat rekap (lib/promo-recap `recap`): keputusan yang
 * dikirim dengan nominal karangan tidak berbahaya — ia hanya tidak pernah cocok dan tidak dipakai.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { discountNormalization } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_ROWS = 5000;
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

async function gateOf() {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has("summary.edit")) {
        return { response: NextResponse.json({ ok: false, error: "Akses normalisasi diskon tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

type Kunci = { lineKey: string; positions: string };
const kunciDari = (row: Record<string, unknown>): Kunci => ({ lineKey: text(row.lineKey, 200), positions: text(row.positions, 50) });

export async function POST(request: NextRequest) {
    const gate = await gateOf();
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const bucket = text(body?.bucket, 20);
    if (bucket !== "principal" && bucket !== "distributor") {
        return NextResponse.json({ ok: false, error: "Pilih Disc Claim (principal) atau Disc Distributor" }, { status: 400 });
    }
    const rows = Array.isArray(body?.rows) ? body.rows as Record<string, unknown>[] : [];
    if (rows.length === 0 || rows.length > MAX_ROWS) {
        return NextResponse.json({ ok: false, error: `Jumlah baris harus 1-${MAX_ROWS}` }, { status: 400 });
    }
    const note = text(body?.note, 500);
    const values = [];
    for (const row of rows) {
        const kunci = kunciDari(row);
        const amount = Number(row.amount);
        const transDate = text(row.transDate, 10);
        if (!kunci.lineKey || !kunci.positions || !Number.isFinite(amount) || amount <= 0) {
            return NextResponse.json({ ok: false, error: "Ada baris tanpa kunci atau nominal" }, { status: 400 });
        }
        values.push({
            ...kunci, bucket, amount: String(amount), percent: String(Number(row.percent) || 0),
            invoiceNo: text(row.invoiceNo, 80), invoiceId: text(row.invoiceId, 40),
            transDate: /^\d{4}-\d{2}-\d{2}$/.test(transDate) ? transDate : null,
            customerNo: text(row.customerNo, 80), itemCode: text(row.itemCode, 80),
            note, decidedBy: gate.email!,
        });
    }
    await db.insert(discountNormalization).values(values).onConflictDoUpdate({
        target: [discountNormalization.lineKey, discountNormalization.positions],
        set: {
            bucket: sql`excluded.bucket`, amount: sql`excluded.amount`, percent: sql`excluded.percent`,
            note: sql`excluded.note`, decidedBy: sql`excluded.decided_by`, decidedAt: new Date(),
        },
    });
    return NextResponse.json({ ok: true, disimpan: values.length, bucket });
}

/** Mencabut keputusan: potongannya kembali tak bertuan di Rekap Promo. */
export async function DELETE(request: NextRequest) {
    const gate = await gateOf();
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const keys = (Array.isArray(body?.keys) ? body.keys as Record<string, unknown>[] : []).map(kunciDari)
        .filter((kunci) => kunci.lineKey && kunci.positions);
    if (keys.length === 0 || keys.length > MAX_ROWS) {
        return NextResponse.json({ ok: false, error: `Jumlah baris harus 1-${MAX_ROWS}` }, { status: 400 });
    }
    const gone = await db.delete(discountNormalization)
        .where(or(...keys.map((kunci) => and(eq(discountNormalization.lineKey, kunci.lineKey), eq(discountNormalization.positions, kunci.positions)))))
        .returning({ lineKey: discountNormalization.lineKey });
    return NextResponse.json({ ok: true, dicabut: gone.length });
}
