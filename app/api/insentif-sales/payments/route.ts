/*
 * Tujuan: GET list + POST create payment records Insentif Sales.
 * Caller: app/(dashboard)/insentif-sales/page.tsx untuk tabel insentif.
 * Dependensi: db/schema (incentivePayments), lib/insentif-sales (requireSalesSession).
 * Main Functions: GET list payments per periode (month opsional — tanpa month = seluruh tahun,
 *   dipakai strip "Rekap Pembayaran Tahunan"); POST create/update payment record.
 *   Baris SPV & SM ikut di tabel yang sama, ditandai sales_code berprefiks "SPV:"/"SM:"
 *   (lihat lib/insentif-payee.ts) — tanpa migrasi DB.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser, getUserHierarchyIdentity, payeeInScope } from "@/lib/insentif-hierarchy-scope";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    // month OPSIONAL. Dulu absen → default bulan berjalan, sehingga strip 12 bulan yang cuma
    // mengirim ?year= selalu balik 1 bulan saja dan 11 bulan lain tampak "belum ada data".
    const monthParam = searchParams.get("month");
    const month = monthParam === null ? null : parseInt(monthParam, 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const conditions = [eq(incentivePayments.periodYear, year)];
    if (month !== null) conditions.push(eq(incentivePayments.periodMonth, month));
    if (principle) conditions.push(eq(incentivePayments.principle, principle));
    if (branch) conditions.push(eq(incentivePayments.branch, branch));

    // Filter kepemilikan setara Finance. Ini endpoint REKAP — celah paling umum adalah filter
    // benar di /dashboard tapi lupa di sini, dan isinya justru nominal uang 12 bulan untuk
    // semua sales, semua SPV, dan semua SM (audit 2026-08-28, H1).
    // Scope dihitung per bulan yang diminta; untuk rekap tahunan dipakai bulan berjalan sebagai
    // acuan keanggotaan tim (kepemilikan salesCode bisa berpindah antar bulan).
    const acuan = month ?? new Date().getMonth() + 1;
    const [allRows, scope, identity] = await Promise.all([
        db.select().from(incentivePayments).where(and(...conditions)),
        getScopeForUser(gate.session.user.id, { month: acuan, year }, gate.perms),
        getUserHierarchyIdentity(gate.session.user.id),
    ]);
    const rows = allRows.filter((r) => payeeInScope(scope, identity, r.salesCode));

    return NextResponse.json({ month, year, rows });
}

interface PaymentInput {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    periodMonth: number;
    periodYear: number;
    totalIncentive: number;
    paymentStatus?: "belum" | "lunas" | "tunggakan";
    paymentProofUrl?: string;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_payment");
    if (gate.response) return gate.response;

    let body: PaymentInput;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.salesCode || !body.periodMonth || !body.periodYear) {
        return NextResponse.json({ error: "salesCode, periodMonth, periodYear required" }, { status: 400 });
    }
    // Nominal adalah uang yang akan dibayarkan — tolak NaN/Infinity/negatif di trust boundary.
    if (!Number.isFinite(Number(body.totalIncentive)) || Number(body.totalIncentive) < 0) {
        return NextResponse.json({ error: "totalIncentive tidak valid" }, { status: 400 });
    }
    // Dibulatkan ke rupiah: transfer bank tidak bisa berisi sen, dan total rekap yang
    // dijumlahkan dari nilai pecahan tidak akan sama dengan jumlah baris yang ditampilkan.
    const totalIncentive = Math.round(Number(body.totalIncentive));

    const now = new Date();
    const actor = gate.session.user.id;
    const actorName = gate.session.user.name ?? null;
    const markingLunas = body.paymentStatus === "lunas";

    // Kunci = salesCode + principle + period (mix → 1 payment per principle), ditegakkan oleh
    // uq_incentive_payments_key di DB sejak 2026-08-24. Ini penting justru karena UI menembak
    // satu POST PER BARIS secara paralel (Promise.allSettled di handleMarkLunas): dengan pola
    // SELECT-cek-lalu-INSERT yang lama, dua request untuk key yang sama bisa lolos berbarengan
    // dan menghasilkan DUA baris pembayaran untuk satu orang (audit temuan C2 + H3).
    const [row] = await db
        .insert(incentivePayments)
        .values({
            id: randomUUID(),
            salesCode: body.salesCode,
            salesName: body.salesName,
            principle: body.principle,
            branch: body.branch,
            periodMonth: body.periodMonth,
            periodYear: body.periodYear,
            totalIncentive,
            paymentStatus: body.paymentStatus ?? "belum",
            paymentProofUrl: body.paymentProofUrl ?? null,
            paymentDate: markingLunas ? now : null,
            paidBy: markingLunas ? actor : null,
            paidByName: markingLunas ? actorName : null,
            updatedBy: actor,
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [incentivePayments.salesCode, incentivePayments.principle, incentivePayments.periodMonth, incentivePayments.periodYear],
            set: {
                salesName: body.salesName,
                totalIncentive,
                paymentStatus: body.paymentStatus ?? "belum",
                paymentProofUrl: body.paymentProofUrl ?? null,
                // Diisi hanya saat menandai lunas — dulu cabang UPDATE tidak mengisinya sama
                // sekali (berbeda dari PATCH), jadi pembayaran bisa jadi "lunas" tanpa jejak.
                ...(markingLunas ? { paymentDate: now, paidBy: actor, paidByName: actorName } : {}),
                updatedBy: actor,
                updatedAt: now,
                // createdAt sengaja TIDAK di-set.
            },
        })
        .returning({ id: incentivePayments.id, createdAt: incentivePayments.createdAt });

    const action = row.createdAt.getTime() === now.getTime() ? "created" : "updated";
    return NextResponse.json({ id: row.id, action }, { status: action === "created" ? 201 : 200 });
}
