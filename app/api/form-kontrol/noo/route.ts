/*
 * Tujuan: NOO — toko baru dari kunjungan salesman (owner 13 Okt 2026). GET = daftar NOO dalam cakupan (TANPA NIK/HP); POST (multipart) =
 *   salesman mengajukan toko yang belum ada di Accurate → kunjungan HARI INI bertanda NOO.
 * Caller: app/(dashboard)/form-kontrol/tabs/{TabNoo,NooFormulir}.tsx.
 * Dependensi: lib/form-kontrol/noo (aksesNoo, bolehBacaNoo, buatNoo, daftarNoo, tampilanNoo), lib/form-kontrol/noo-aturan (periksaIsianNoo),
 *   lib/form-kontrol (getJksPrinciples), lib/order-cabang (cakupanCabang, jawabGalat), lib/beranda (witaToday).
 * Main Functions: GET ?status=a,b&salesCode=, POST FormData { id (UUID klien), salesCode, principle, namaToko, namaPemilik, alamat, noHp, nik,
 *   namaKtp, lat, lng, akurasi, fotoToko (berkas), fotoKtp (berkas), pemilikSama ("ya"), alasanDuplikat }.
 * Side Effects: POST menulis noo_toko + kunjungan_luar_rute + kontrol_audit_log + dua berkas di data/private/noo (lib/form-kontrol/noo).
 *
 * Aturan POST (server; galat { ok:false, kode, error } berkalimat Indonesia, TANPA nilai NIK/HP):
 *   - izin form_kontrol.submit; HANYA akun salesman pemilik kode sales itu → 403 BUKAN_PEMILIK; tanggal = hari ini WITA server;
 *   - isian wajib + format (NIK 16 angka, HP seluler Indonesia, GPS wajib) → 400; dua foto wajib gambar ≤ 5 MB → 400 FOTO_*;
 *   - cabang = cabang karyawan Accurate salesman (O1; galat tautan diteruskan); principal = JKS aktif / cabang (sama dengan luar rute);
 *   - NIK/HP sama dengan NOO lain yang belum ditolak → 409 NOO_DUPLIKAT (+ `pembanding` kode/toko/status HANYA untuk NOO milik salesman
 *     sendiri; milik orang lain hanya `lain` [{cocok}] — peninjau A R3) kecuali pemilikSama=ya + alasan ≥ 10 huruf (→ tanda duplikat, pemutus
 *     WAJIB mengonfirmasi); id sama dikirim ulang dengan isian sama = baris lama (200), isian berbeda = 409 ID_BEDA_ISI;
 *   - Content-Length > 2 × 5 MB + 512 KB → 413 sebelum body dibaca; foto > 40 MP ditolak sharp (FOTO_TIDAK_SAH).
 * GET: status aktif (menunggu/disetujui) selalu lengkap; selesai (ditolak/terdaftar) BATAS_SELESAI terbaru + `selesaiTerpotong`.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getJksPrinciples } from "@/lib/form-kontrol";
import { BATAS_SELESAI, aksesNoo, bolehBacaNoo, buatNoo, daftarNoo, tampilanNoo } from "@/lib/form-kontrol/noo";
import { periksaIsianNoo, type StatusNoo } from "@/lib/form-kontrol/noo-aturan";
import { cakupanCabang, jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS: readonly StatusNoo[] = ["menunggu_spv", "disetujui", "ditolak", "terdaftar"];
const MAKS_FOTO = 5 * 1024 * 1024;
// Peninjau A R4: body ditolak SEBELUM dibaca bila Content-Length jelas melebihi dua foto 5 MB + isian (req.formData membaca seluruh body).
const MAKS_BODY = 2 * MAKS_FOTO + 512 * 1024;

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const a = await aksesNoo(gate.session, gate.perms!);
        const p = new URL(req.url).searchParams;
        const status = (p.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (status.some((s) => !(STATUS as readonly string[]).includes(s))) {
            return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Status NOO tidak dikenal." });
        }
        const salesCode = (p.get("salesCode") ?? "").trim();
        if (a.scope.allowedSalesCodes === null ? !bolehBacaNoo(a, "") : salesCode && !bolehBacaNoo(a, salesCode)) {
            return jawabGalat({ status: 403, kode: "LUAR_CAKUPAN", error: "Daftar toko baru di luar cakupan akun Anda." });
        }
        const { rows, selesaiTerpotong } = await daftarNoo(a, { status: status as StatusNoo[], salesCode: salesCode || undefined });
        return NextResponse.json({ ok: true, rows: rows.map((r) => tampilanNoo(r, a)), selesaiTerpotong, batasSelesai: BATAS_SELESAI },
            { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        if (Number(req.headers.get("content-length") ?? 0) > MAKS_BODY) {
            return jawabGalat({ status: 413, kode: "FOTO_TERLALU_BESAR", error: "Kiriman terlalu besar: tiap foto maksimal 5 MB. Ambil ulang foto." });
        }
        const form = await req.formData().catch(() => null);
        if (!form) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Formulir toko baru tidak terbaca; kirim ulang." });
        const teks = (k: string) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
        const id = teks("id").toLowerCase(), salesCode = teks("salesCode"), principle = teks("principle");
        if (!UUID.test(id) || !salesCode || !principle) {
            return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Kode sales, principal, dan id pengajuan wajib; muat ulang formulir." });
        }
        const cek = periksaIsianNoo((k) => { const v = form.get(k); return typeof v === "string" ? v : ""; });
        if ("galat" in cek) return jawabGalat({ status: 400, ...cek.galat });
        const foto: Record<"fotoToko" | "fotoKtp", Buffer> = { fotoToko: Buffer.alloc(0), fotoKtp: Buffer.alloc(0) };
        for (const [k, label] of [["fotoToko", "Foto toko"], ["fotoKtp", "Foto KTP"]] as const) {
            const f = form.get(k);
            if (!(f instanceof File) || f.size === 0) return jawabGalat({ status: 400, kode: "FOTO_WAJIB", error: `${label} wajib diambil.` });
            if (!f.type.startsWith("image/")) return jawabGalat({ status: 400, kode: "FOTO_TIDAK_SAH", error: `${label} harus berkas gambar.` });
            if (f.size > MAKS_FOTO) return jawabGalat({ status: 400, kode: "FOTO_TERLALU_BESAR", error: `${label} maksimal 5 MB.` });
            foto[k] = Buffer.from(await f.arrayBuffer());
        }
        const pemilikSama = teks("pemilikSama") === "ya";
        const alasanDuplikat = teks("alasanDuplikat").replace(/\s+/g, " ");
        if (pemilikSama && (alasanDuplikat.length < 10 || alasanDuplikat.length > 500)) {
            return jawabGalat({ status: 400, kode: "ALASAN_DUPLIKAT_WAJIB", error: "Alasan \"pemilik sama\" wajib diisi (10–500 karakter) untuk SPV." });
        }

        const a = await aksesNoo(session, gate.perms!);
        if (a.scope.salesCode !== salesCode) {
            return jawabGalat({ status: 403, kode: "BUKAN_PEMILIK", error: "Toko baru hanya diajukan salesman pemilik rute dari akunnya sendiri." });
        }
        const c = await cakupanCabang(String(session.user.id), gate.perms!);
        if ("galat" in c) return jawabGalat(c.galat);
        if (c.cakupan.semua) {
            return jawabGalat({ status: 403, kode: "CABANG_TIDAK_DIKETAHUI", error: "Toko baru butuh cabang karyawan Accurate salesman; akun ini berakses semua cabang." });
        }
        // Principal = sama dengan kunjungan luar rute (app/api/form-kontrol/luar-rute/route.ts): JKS aktif salesman, tanpa JKS = nama cabang.
        const jks = await getJksPrinciples([salesCode]);
        const boleh = jks.length ? jks : c.cakupan.branchName ? [c.cakupan.branchName] : [];
        if (!boleh.includes(principle)) {
            return jawabGalat({ status: 403, kode: "PRINCIPAL_LUAR_CAKUPAN", error: `Principal ${principle} bukan principal Anda (${boleh.join(", ") || "belum ada JKS maupun cabang Accurate"}).` });
        }
        const hasil = await buatNoo({
            id, salesCode, salesName: a.scope.salesName ?? null, principle, tanggal: witaToday(), branchId: c.cakupan.branchId,
            branchName: c.cakupan.branchName || null, isian: cek.isian, fotoToko: foto.fotoToko, fotoKtp: foto.fotoKtp,
            duplikat: pemilikSama ? { alasan: alasanDuplikat } : null, aktorId: a.userId, aktorNama: session.user.name ?? null,
        });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, baru: hasil.baru, row: tampilanNoo(hasil.row, a, true) }, { status: hasil.baru ? 201 : 200 });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
