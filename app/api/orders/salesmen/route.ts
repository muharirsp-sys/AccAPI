/*
 * Tujuan: Daftar salesman aktif dari master pegawai Accurate untuk pilihan "Salesman" di dialog Antrekan faktur Order Masuk (C7).
 * Caller: app/(dashboard)/orders (dialog Antrekan). Izin `order.edit` — sama dengan POST /api/orders/[id]/invoice yang memakainya.
 * Dependensi: db accurate_employee (sync employee/list.do), lib/rbac/resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 *
 * Syaratnya sama dengan yang diperiksa saat antre (lib/order-salesman): `salesman = true` dan tidak `suspended`. Yang tampil di sini
 * tetap diperiksa ulang di server saat antre — daftar ini hanya pilihan, bukan otoritas.
 */
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET() {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh memilih salesman faktur" }, { status: 403 });
    }
    const rows = await db.select({ number: accurateEmployee.number, name: accurateEmployee.name, branchId: accurateEmployee.branchId })
        .from(accurateEmployee)
        .where(and(eq(accurateEmployee.salesman, true), eq(accurateEmployee.suspended, false)))
        .orderBy(asc(accurateEmployee.name));
    return NextResponse.json({ ok: true, salesmen: rows.filter((row) => row.number.trim()) });
}
