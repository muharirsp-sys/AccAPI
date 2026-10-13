/*
 * Tujuan: "Batalkan" kunjungan LUAR RUTE yang salah tambah (owner 13 Okt 2026) — batal LUNAK, bukan DELETE.
 * Caller: app/(dashboard)/form-kontrol/tabs/LuarRute.tsx (BatalkanLuarRute di Rute hari ini).
 * Dependensi: lib/form-kontrol (resolveScope, batalLuarRute), lib/order-cabang (jawabGalat), lib/beranda (witaToday).
 * Main Functions: POST { id }.
 * Side Effects: UPDATE kunjungan_luar_rute.dibatalkan_pada/oleh + kontrol_audit_log `luar_rute/batal`.
 *
 * Hanya akun salesman pemilik baris (identitas SESI, bukan isian klien) → 403 BUKAN_MILIK; hanya hari ini WITA server → 409 BUKAN_HARI_INI;
 * belum ada check-in/status AO/merchandising → selain itu 409 SUDAH_DIKUNJUNGI; sudah batal → 409 SUDAH_DIBATALKAN; sudah masuk JKS → 409.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { batalLuarRute, resolveScope } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        if (!id) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Kunjungan luar rute wajib dipilih." });
        const scope = await resolveScope(session);
        if (!scope.salesCode) {
            return jawabGalat({ status: 403, kode: "BUKAN_MILIK", error: "Kunjungan luar rute hanya dibatalkan oleh salesman pemiliknya dari akunnya sendiri." });
        }
        const hasil = await batalLuarRute({ id, salesCode: scope.salesCode, hariIni: witaToday(), aktorId: String(session.user.id),
            aktorNama: session.user.name ?? null });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, row: hasil.row });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
