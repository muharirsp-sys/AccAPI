/*
 * Tujuan: Tombol per baris — AO satu baris GT/TT dinilai terhadap Target AO di file target,
 *   bukan ambang 240, tanpa memindah setelan global.
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SupportInputSection (kolom Ambang AO).
 * Dependensi: lib/db, db/schema (appSetting), lib/insentif-settings (aoFileKey, aoFileRowKey, setDaftar),
 *   lib/rbac/resolve, lib/insentif-hierarchy-scope.
 * Main Functions: PATCH { salesCode, principle, periodMonth, periodYear, pakaiFile }.
 * Side Effects: Menulis app_setting dan MENGUBAH NOMINAL AO baris itu pada periode itu saja.
 *   Izin & cakupan sama dengan ubah Status Insentif per baris (targets/status).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSetting } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";
import { aoFileKey, aoFileRowKey, setDaftar } from "@/lib/insentif-settings";

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) ?? {};
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const salesCode = typeof body.salesCode === "string" ? body.salesCode.trim() : "";
    const principle = typeof body.principle === "string" ? body.principle.trim() : "";
    const bulan = Number(body.periodMonth);
    const tahun = Number(body.periodYear);
    if (!salesCode || !principle) {
        return NextResponse.json({ error: "Kode Salesman dan Principal wajib diisi." }, { status: 400 });
    }
    if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12 || !Number.isInteger(tahun) || tahun < 2020 || tahun > 2100) {
        return NextResponse.json({ error: "Periode tidak valid." }, { status: 400 });
    }
    // Boolean ketat: "false" (string) yang lolos sebagai truthy akan MENYALAKAN tombolnya.
    if (typeof body.pakaiFile !== "boolean") {
        return NextResponse.json({ error: "pakaiFile harus true/false." }, { status: 400 });
    }

    const scope = await getScopeForUser(gate.session.user.id, { month: bulan, year: tahun }, gate.perms);
    if (scope !== null && !scope.has(salesCode)) {
        return NextResponse.json({ error: `Baris ${salesCode}: di luar cakupan tim Anda.` }, { status: 403 });
    }

    const key = aoFileKey(bulan, tahun);
    const baris = aoFileRowKey(salesCode, principle);
    // Baca KETAT, bukan getDaftar: getDaftar menelan galat jadi [], dan di sini [] lalu ditulis
    // balik berarti tombol baris LAIN pada periode ini ikut terhapus. Galat → 500, tidak menulis.
    const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key)).limit(1);
    const sekarang: string[] = row?.value ? JSON.parse(row.value) : [];
    const baru = body.pakaiFile ? [...sekarang, baris] : sekarang.filter((v) => v !== baris);
    const tersimpan = await setDaftar(key, baru, gate.session.user.id);
    return NextResponse.json({ pakaiFile: tersimpan.includes(baris) });
}
