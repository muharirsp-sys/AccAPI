/*
 * Tujuan: Ubah Status Insentif satu/beberapa baris target tanpa mengunggah ulang file target.
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SupportInputSection (tabel per baris).
 * Dependensi: lib/db, db/schema (salesTargets), lib/insentif-sales-calc (normalizeStatus),
 *   lib/rbac/resolve, lib/insentif-hierarchy-scope.
 * Main Functions: PATCH — set status_insentif per (salesCode, principle, periode).
 * Side Effects: Menulis sales_targets dan MENGUBAH NOMINAL yang dibayar untuk baris itu:
 *   "principle" membuat insentifnya Rp 0 sekaligus mengeluarkannya dari penyebut mix,
 *   sehingga nominal principal LAIN pada salesman yang sama ikut bergeser.
 *
 * Kenapa endpoint sendiri, bukan lewat POST /targets: POST adalah upsert baris LENGKAP —
 * memakainya untuk mengubah satu kolom menuntut klien mengirim ulang seluruh angka target,
 * dan satu field yang lupa disertakan akan menimpa target dengan 0.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesTargets } from "@/db/schema";
import { normalizeStatus } from "@/lib/insentif-sales-calc";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";

interface StatusInput {
    salesCode: string;
    principle: string;
    periodMonth: number;
    periodYear: number;
    statusInsentif: string;
}

export async function PATCH(req: NextRequest) {
    // Izin yang sama dengan unggah target: ini mengubah isi baris target, dan siapa pun yang
    // bisa mengunggah target sudah bisa mengubah kolom ini lewat file.
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;

    let body: StatusInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // ── PASS 1: validasi seluruh payload sebelum menyentuh DB ────────────────────
    // Perubahan status menggeser uang. Gagal di baris ke-3 setelah 2 baris tertulis berarti
    // separuh keputusan tersimpan dan tidak ada yang tahu mana yang sudah kena.
    const prepared: Array<{ row: StatusInput; status: string }> = [];
    for (const t of body) {
        if (!t?.salesCode?.trim() || !t?.principle?.trim()) {
            return NextResponse.json(
                { error: "Setiap baris wajib punya Kode Salesman dan Principal." },
                { status: 400 },
            );
        }
        const bulan = Number(t.periodMonth);
        const tahun = Number(t.periodYear);
        if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12
            || !Number.isInteger(tahun) || tahun < 2020 || tahun > 2100) {
            return NextResponse.json(
                { error: `Baris ${t.salesCode}/${t.principle}: periode tidak valid.` },
                { status: 400 },
            );
        }
        let status: string;
        try {
            // normalizeStatus MELEMPAR untuk nilai asing, bukan jatuh ke default. Status yang
            // salah ketik dan diam-diam jadi "distributor_principle" berarti baris yang
            // seharusnya Rp 0 tetap dibayar.
            status = normalizeStatus(t.statusInsentif ?? "");
        } catch (e) {
            return NextResponse.json(
                { error: `Baris ${t.salesCode}/${t.principle}: ${e instanceof Error ? e.message : "Status tidak valid"}` },
                { status: 400 },
            );
        }
        prepared.push({ row: { ...t, periodMonth: bulan, periodYear: tahun }, status });
    }
    if (prepared.length === 0) return NextResponse.json({ updated: 0 });

    // ── PASS 2: kepemilikan ──────────────────────────────────────────────────────
    // Tanpa ini SPV/SM ter-scope bisa mengubah status baris siapa pun se-perusahaan, dan
    // status adalah tombol yang bisa menyetel insentif orang lain jadi Rp 0.
    const acuan = prepared[0].row;
    const scope = await getScopeForUser(
        gate.session.user.id,
        { month: acuan.periodMonth, year: acuan.periodYear },
        gate.perms,
    );
    if (scope !== null) {
        const luar = prepared.find((p) => !scope.has(p.row.salesCode));
        if (luar) {
            return NextResponse.json(
                { error: `Baris ${luar.row.salesCode}: di luar cakupan tim Anda.` },
                { status: 403 },
            );
        }
    }

    const now = new Date();
    let updated = 0;
    let tidakDitemukan = 0;
    await db.transaction(async (tx) => {
        for (const { row, status } of prepared) {
            const hasil = await tx
                .update(salesTargets)
                .set({ statusInsentif: status, updatedBy: gate.session.user.id, updatedAt: now })
                .where(and(
                    eq(salesTargets.salesCode, row.salesCode),
                    eq(salesTargets.principle, row.principle),
                    eq(salesTargets.periodMonth, row.periodMonth),
                    eq(salesTargets.periodYear, row.periodYear),
                ));
            // Baris tanpa target TIDAK dibuat di sini: status tanpa angka target tetap
            // menghasilkan Rp 0, dan menyisipkan baris target bernilai 0 lewat pintu ini
            // akan memunculkan penerima baru yang tidak pernah diunggah siapa pun.
            if ((hasil.rowCount ?? 0) > 0) updated++;
            else tidakDitemukan++;
        }
    });

    return NextResponse.json({ updated, tidakDitemukan });
}
