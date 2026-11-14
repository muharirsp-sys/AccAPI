/*
 * Tujuan: Validasi Lokasi Form Kontrol (owner 14 Nov 2026; Admin/IT = form_kontrol.manage):
 *   GET  ?bagian=ringkasan | pengajuan (&status=menunggu|disetujui|ditolak) | antrean.
 *   POST multipart `file` = berkas audit selisih titik Web-LL (sheet 1_SANGAT_BERBEDA / 2_BERBEDA / 3_ALAMAT_KELIRU) -> titik toko 'validasi'
 *        (radius 100 m), baris ber-LATITUDE/LONGITUDE BENAR -> titik baru 'fix' (20 m). Satu baris bermasalah = tidak ada yang ditulis.
 *   POST JSON {aksi:"putuskan", id, keputusan:"disetujui"|"ditolak", pindahTitik, catatan} | {aksi:"tetapkan", custCode, lat, lng}.
 * Caller: app/(dashboard)/form-kontrol/tabs/TabLokasi.tsx.
 * Dependensi: lib/form-kontrol/{lokasi,lokasi-db}, lib/supervisor-review/ringkasan (BATAS_LAT/LNG), xlsx, writeKontrolAudit.
 * Side Effects: tulis toko_koordinat, pengajuan_lokasi, kontrol_audit_log.
 */
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { writeKontrolAudit } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";
import { SHEET_STATUS_TITIK, bacaStatusTitik } from "@/lib/form-kontrol/lokasi";
import { antreanLokasi, daftarPengajuan, putuskanPengajuan, ringkasanLokasi, terapkanStatusTitik, tetapkanTitik } from "@/lib/form-kontrol/lokasi-db";
import { BATAS_LAT, BATAS_LNG } from "@/lib/supervisor-review/ringkasan";

const BATAS_BERKAS = 20 * 1024 * 1024;
const STATUS_AJUAN = ["menunggu", "disetujui", "ditolak"] as const;

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        const p = new URL(req.url).searchParams;
        const bagian = p.get("bagian") ?? "ringkasan";
        if (bagian === "pengajuan") {
            const status = STATUS_AJUAN.find((s) => s === p.get("status")) ?? "menunggu";
            return NextResponse.json({ rows: await daftarPengajuan(status) });
        }
        if (bagian === "antrean") return NextResponse.json({ rows: await antreanLokasi(witaToday()) });
        return NextResponse.json({ ringkasan: await ringkasanLokasi() });
    } catch {
        return NextResponse.json({ error: "Data validasi lokasi belum berhasil dimuat." }, { status: 500 });
    }
}

const angka = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const user = gate.session.user;
    try {
        if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
            if (Number(req.headers.get("content-length") ?? 0) > BATAS_BERKAS + 64 * 1024) {
                return NextResponse.json({ kode: "BERKAS_TERLALU_BESAR", error: "Berkas lebih dari 20 MB." }, { status: 413 });
            }
            const file = (await req.formData()).get("file");
            if (!(file instanceof File) || file.size > BATAS_BERKAS) return NextResponse.json({ kode: "BERKAS_WAJIB", error: "Pilih berkas .xlsx (maks. 20 MB)." }, { status: 400 });
            // Hanya tiga sheet status yang diurai (berkas audit memuat sheet SEMUA_TOKO / SEMUA_TITIK_LAPANGAN berisi belasan ribu baris).
            const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer", sheets: [...SHEET_STATUS_TITIK] });
            const sheets = Object.fromEntries(wb.SheetNames.filter((n) => wb.Sheets[n])
                .map((n) => [n, XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[n], { defval: "" })]));
            const hasil = bacaStatusTitik(sheets);
            if (hasil.sheetDibaca.length === 0) {
                return NextResponse.json({ kode: "SHEET_TIDAK_ADA", error: `Berkas tidak memuat sheet ${SHEET_STATUS_TITIK.join(", ")}.` }, { status: 400 });
            }
            if (hasil.galat.length) {
                return NextResponse.json({ kode: "BERKAS_BERMASALAH", galat: hasil.galat.slice(0, 50),
                    error: `Tidak ada yang ditulis: ${hasil.galat.length} baris bermasalah (mis. ${hasil.galat[0].sheet} baris ${hasil.galat[0].baris}: ${hasil.galat[0].pesan})` }, { status: 400 });
            }
            const tulis = await terapkanStatusTitik(hasil.baris, user.id);
            await writeKontrolAudit("toko_koordinat", "status", "unggah_status_titik", user.id, user.name ?? null,
                { berkas: file.name, sheet: hasil.sheetDibaca, baris: hasil.baris.length, ...tulis });
            return NextResponse.json({ success: true, sheet: hasil.sheetDibaca, baris: hasil.baris.length, ...tulis });
        }

        const body = await req.json() as Record<string, unknown>;
        if (body.aksi === "putuskan") {
            // Owner 14 Nov 2026: pengajuan lokasi diputus IT = akun ber-role admin (form_kontrol.manage juga dipegang Manager / Admin Sales).
            if (user.role !== "admin") return NextResponse.json({ kode: "HANYA_IT", error: "Pengajuan lokasi hanya bisa diputus Admin (IT)." }, { status: 403 });
            const keputusan = body.keputusan === "disetujui" || body.keputusan === "ditolak" ? body.keputusan : null;
            if (typeof body.id !== "string" || !keputusan) return NextResponse.json({ kode: "ISIAN_WAJIB", error: "Pengajuan dan keputusan wajib." }, { status: 400 });
            const catatan = typeof body.catatan === "string" && body.catatan.trim() ? body.catatan.trim().slice(0, 300) : null;
            if (keputusan === "ditolak" && !catatan) return NextResponse.json({ kode: "CATATAN_WAJIB", error: "Tulis alasan penolakan untuk salesman dan SPV." }, { status: 400 });
            const h = await putuskanPengajuan(body.id, keputusan, { pindahTitik: body.pindahTitik === true, catatan, oleh: user.id });
            if ("galat" in h) return jawabGalat(h.galat);
            await writeKontrolAudit("pengajuan_lokasi", body.id, keputusan, user.id, user.name ?? null, { pindahTitik: h.titikDipindah, catatan });
            return NextResponse.json({ success: true, titikDipindah: h.titikDipindah });
        }
        if (body.aksi === "tetapkan") {
            const lat = angka(body.lat), lng = angka(body.lng);
            const custCode = typeof body.custCode === "string" ? body.custCode.trim() : "";
            if (!custCode || lat === null || lng === null || lat < BATAS_LAT[0] || lat > BATAS_LAT[1] || lng < BATAS_LNG[0] || lng > BATAS_LNG[1]) {
                return NextResponse.json({ kode: "TITIK_TIDAK_SAH", error: "Kode toko dan titik di wilayah Indonesia wajib." }, { status: 400 });
            }
            const h = await tetapkanTitik(custCode, lat, lng, user.id);
            if ("galat" in h) return jawabGalat(h.galat);
            await writeKontrolAudit("toko_koordinat", custCode, "tetapkan_titik", user.id, user.name ?? null, { lat, lng });
            return NextResponse.json({ success: true });
        }
        return NextResponse.json({ kode: "AKSI_TIDAK_DIKENAL", error: "Aksi tidak dikenal." }, { status: 400 });
    } catch {
        return NextResponse.json({ error: "Validasi lokasi gagal disimpan; tidak ada yang ditulis." }, { status: 500 });
    }
}
