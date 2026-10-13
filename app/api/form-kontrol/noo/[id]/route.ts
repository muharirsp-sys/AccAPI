/*
 * Tujuan: Satu NOO (toko baru, owner 13 Okt 2026). GET = rincian (NIK TERSAMAR, tanpa foto KTP) + pembanding duplikat + saran pelanggan
 *   untuk penautan (Admin, status disetujui; ?cari= = cari nama/kode di cabang NOO). POST = aksi: setujui / tolak (SPV tim, SM atas SPV
 *   bawahannya, grup Admin), tautkan (Admin), kunjungi (salesman pengaju, hari ini).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabNoo.tsx.
 * Dependensi: lib/form-kontrol/noo, lib/form-kontrol (getJksPrinciples), lib/order-cabang (cakupanCabang, jawabGalat), lib/beranda (witaToday).
 * Main Functions: GET, POST { aksi: "setujui", konfirmasiPemilikSama? } | { aksi: "tolak", alasan } | { aksi: "tautkan", customerId } |
 *   { aksi: "kunjungi", principle }.
 * Side Effects: POST = UPDATE noo_toko / INSERT kunjungan_luar_rute + kontrol_audit_log (lib/form-kontrol/noo).
 *
 * Izin per aksi (gerbang + hakNoo): setujui/tolak = form_kontrol.noo_setujui; tautkan = form_kontrol.manage; kunjungi = form_kontrol.submit.
 * NOO di luar cakupan = 404 NOO_TIDAK_ADA (keberadaannya tidak dibuka).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getJksPrinciples } from "@/lib/form-kontrol";
import { aksesNoo, ambilNoo, hakNoo, kunjungiNoo, putuskanNoo, ringkasPembanding, saranPelanggan, tampilanNoo, tautkanNoo } from "@/lib/form-kontrol/noo";
import { cakupanCabang, jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

type Konteks = { params: Promise<{ id: string }> };
const TIDAK_ADA = { status: 404, kode: "NOO_TIDAK_ADA", error: "Pengajuan toko baru ini tidak ditemukan dalam cakupan Anda; muat ulang daftarnya." };
const IZIN_AKSI = { setujui: "form_kontrol.noo_setujui", tolak: "form_kontrol.noo_setujui", tautkan: "form_kontrol.manage", kunjungi: "form_kontrol.submit" } as const;

export async function GET(req: Request, { params }: Konteks) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const { id } = await params;
        const a = await aksesNoo(gate.session, gate.perms!);
        const r = await ambilNoo(id);
        if (!r || !hakNoo(a, r).baca) return jawabGalat(TIDAK_ADA);
        const cari = new URL(req.url).searchParams.get("cari") ?? "";
        return NextResponse.json({
            ok: true, row: tampilanNoo(r, a, true), pembanding: await ringkasPembanding(r.duplikatDengan),
            saran: hakNoo(a, r).tautkan ? await saranPelanggan(r, cari) : null,
        }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request, { params }: Konteks) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const aksi = typeof body?.aksi === "string" ? body.aksi : "";
    if (!(aksi in IZIN_AKSI)) {
        // Tetap di belakang sesi: tanpa gerbang izin yang dikenal, minta izin baca dulu supaya 401/403 tidak bocor sebagai 400.
        const g = await requirePermissionH("form_kontrol.view");
        if (g.response) return g.response;
        return jawabGalat({ status: 400, kode: "AKSI_TIDAK_DIKENAL", error: "Aksi harus setujui, tolak, tautkan, atau kunjungi." });
    }
    const gate = await requirePermissionH(IZIN_AKSI[aksi as keyof typeof IZIN_AKSI]);
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        const { id } = await params;
        const a = await aksesNoo(session, gate.perms!);
        const aktorNama = session.user.name ?? null;
        if (aksi === "setujui" || aksi === "tolak") {
            const hasil = await putuskanNoo({ id, keputusan: aksi, alasan: typeof body?.alasan === "string" ? body.alasan : "",
                konfirmasiPemilikSama: body?.konfirmasiPemilikSama === true, a, aktorNama });
            if ("galat" in hasil) return jawabGalat(hasil.galat);
            return NextResponse.json({ ok: true, row: tampilanNoo(hasil.row, a, true) });
        }
        if (aksi === "tautkan") {
            const customerId = typeof body?.customerId === "number" && Number.isSafeInteger(body.customerId) ? body.customerId : null;
            if (customerId === null) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Pilih pelanggan hasil sync yang akan ditautkan." });
            const hasil = await tautkanNoo({ id, customerId, a, aktorNama });
            if ("galat" in hasil) return jawabGalat(hasil.galat);
            return NextResponse.json({ ok: true, row: tampilanNoo(hasil.row, a, true) });
        }
        // kunjungi: principal = JKS aktif / cabang Accurate salesman (sama dengan luar rute); tanggal = hari ini WITA server.
        const principle = typeof body?.principle === "string" ? body.principle.trim() : "";
        if (!principle) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Principal kunjungan wajib." });
        if (!a.scope.salesCode) return jawabGalat({ status: 403, kode: "BUKAN_PEMILIK", error: "Hanya salesman pengaju yang menambahkan kunjungan toko baru ini." });
        const c = await cakupanCabang(String(session.user.id), gate.perms!);
        if ("galat" in c) return jawabGalat(c.galat);
        const jks = await getJksPrinciples([a.scope.salesCode]);
        const boleh = jks.length ? jks : !c.cakupan.semua && c.cakupan.branchName ? [c.cakupan.branchName] : [];
        if (!boleh.includes(principle)) {
            return jawabGalat({ status: 403, kode: "PRINCIPAL_LUAR_CAKUPAN", error: `Principal ${principle} bukan principal Anda (${boleh.join(", ") || "belum ada JKS maupun cabang Accurate"}).` });
        }
        const hasil = await kunjungiNoo({ id, principle, tanggal: witaToday(), a, aktorNama });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, baru: hasil.baru, row: hasil.row }, { status: hasil.baru ? 201 : 200 });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
