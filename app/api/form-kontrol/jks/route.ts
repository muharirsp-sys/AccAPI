import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { requirePermissionH } from "@/lib/rbac/resolve";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { salesProfile } from "@/db/schema";
import { POLA_JKS, canAccessSales, getJksList, isiKoordinatLapangan, resolveScope, upsertJksRows, writeKontrolAudit } from "@/lib/form-kontrol";
import { bacaJksWebLl, cariSheetWebLl, type PetaJks } from "@/lib/form-kontrol/jks-webll";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(req.url);
        const salesCode     = searchParams.get("salesCode") ?? undefined;
        const principle     = searchParams.get("principle") ?? undefined;
        // UI mengirim `hari`; terima juga `hariKunjungan` untuk kompatibilitas.
        const hariKunjungan = searchParams.get("hari") ?? searchParams.get("hariKunjungan") ?? undefined;
        const page          = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
        const limit         = Math.min(200, parseInt(searchParams.get("limit") ?? "50", 10));
        const offset        = (page - 1) * limit;

        // FK-MSM butir 4: cakupan dari server (parameter `salesCodes` klien diabaikan) — SPV hanya timnya, salesman hanya miliknya,
        // admin/manager/admin_sales semua. Kode sales di luar cakupan = 403 (bukan daftar kosong yang menyesatkan).
        const scope = await resolveScope(gate.session);
        if (salesCode && !canAccessSales(scope, salesCode)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const salesCodes = scope.allowedSalesCodes ?? undefined;
        const result = await getJksList({ salesCode, salesCodes, principle, hariKunjungan, isActive: true }, limit, offset);
        return NextResponse.json({ ...result, page, limit });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// Map header Excel (ID/EN, case/spasi-insensitive) → field upsertJksRows.
const HEADER_MAP: Record<string, string> = {
    salescode: "salesCode", kodesales: "salesCode", kodesalesman: "salesCode", sales: "salesCode",
    salesname: "salesName", namasales: "salesName", namasalesman: "salesName",
    custcode: "custCode", kodetoko: "custCode", kodecustomer: "custCode", kodepelanggan: "custCode",
    custname: "custName", namatoko: "custName", namacustomer: "custName", namapelanggan: "custName",
    market: "market", channel: "channel",
    alamat: "alamat", address: "alamat",
    kota: "kota", city: "kota",
    hari: "hariKunjungan", harikunjungan: "hariKunjungan", day: "hariKunjungan",
    pola: "mingguPattern", polaminggu: "mingguPattern", minggupattern: "mingguPattern", pattern: "mingguPattern",
    area: "area", rayon: "rayon",
    principle: "principle", principal: "principle", prinsipal: "principle",
    freq: "visitFrequency", frekuensi: "visitFrequency", visitfrequency: "visitFrequency", frequency: "visitFrequency",
};

function normalizeKey(k: string): string {
    return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapExcelRow(raw: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw)) {
        const field = HEADER_MAP[normalizeKey(key)];
        if (!field) continue;
        let v: unknown = typeof val === "string" ? val.trim() : val;
        if (field === "mingguPattern" && typeof v === "string") {
            const low = v.toLowerCase();
            v = (POLA_JKS as readonly string[]).includes(low) ? low : "all";
        }
        if (field === "visitFrequency") v = parseInt(String(v), 10) || undefined;
        out[field] = v;
    }
    return out;
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;

    try {
        const contentType = req.headers.get("content-type") ?? "";
        let rows: Record<string, unknown>[] = [];
        const excel = contentType.includes("multipart/form-data");
        // Mode ganti (lib/form-kontrol upsertJksRows): FormData `ganti=1` / JSON `ganti: true`.
        let ganti = false;

        if (excel) {
            // Import Excel dari UI (TabJks kirim file .xlsx via FormData).
            const form = await req.formData();
            const file = form.get("file");
            if (!(file instanceof File)) {
                return NextResponse.json({ error: "File tidak ditemukan" }, { status: 400 });
            }
            const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
            // JKS Web-LL (owner 13 Nov 2026): sheet "JKS semua sales" + peta salesman/principal pilihan Admin; SELALU mengganti JKS lama
            // principal itu ("Diganti per principal"), dan satu baris bermasalah = tidak ada yang ditulis.
            const sheetWebLl = cariSheetWebLl(wb.SheetNames);
            if (sheetWebLl) return imporWebLl(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetWebLl], { defval: "" }),
                form.get("peta"), gate.session.user);
            const sheet = wb.Sheets[wb.SheetNames[0]];
            if (!sheet) return NextResponse.json({ error: "Sheet kosong" }, { status: 400 });
            const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
            rows = raw.map(mapExcelRow);
            ganti = form.get("ganti") === "1";
        } else {
            const body = await req.json();
            rows = Array.isArray(body) ? body : (body.rows ?? []);
            ganti = !Array.isArray(body) && body.ganti === true;
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return NextResponse.json({ error: "Tidak ada baris untuk diimport" }, { status: 400 });
        }
        const { ditolak, gantiBatal, ...result } = await upsertJksRows(rows as Parameters<typeof upsertJksRows>[0], { ganti });
        // Nomor baris seperti yang dilihat pengunggah: Excel = baris sheet (baris 1 = judul kolom); JSON = urutan ke-n.
        const baris = ditolak.map((d) => ({ baris: d.indeks + (excel ? 2 : 1), custCode: d.custCode, hari: d.hari }));
        if (gantiBatal) {
            const contoh = baris.slice(0, 5).map((d) => `baris ${d.baris} (${d.custCode}: "${d.hari}")`).join("; ");
            return NextResponse.json({ kode: "GANTI_DIBATALKAN", skipped: result.skipped, ditolak: baris,
                error: `Ganti JKS dibatalkan, tidak ada yang ditulis: ${result.skipped} baris tanpa kode sales/kode toko/principal, `
                    + `${baris.length} baris hari tidak dikenal${contoh ? ` (${contoh})` : ""}. Perbaiki berkasnya lalu ulangi.` }, { status: 400 });
        }
        return NextResponse.json({ success: true, ...result, ditolak: baris });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Gagal import" }, { status: 500 });
    }
}

/** Peta dari FormData `peta` (JSON {sales:{…}, principal:{…}}); bentuk lain = null. */
function bacaPeta(v: FormDataEntryValue | null): PetaJks | null {
    try {
        const p = JSON.parse(typeof v === "string" ? v : "") as Partial<PetaJks>;
        const objek = (o: unknown) => o && typeof o === "object" && Object.values(o).every((x) => typeof x === "string");
        return objek(p.sales) && objek(p.principal) ? { sales: p.sales!, principal: p.principal! } : null;
    } catch { return null; }
}

async function imporWebLl(rows: Record<string, unknown>[], petaMentah: FormDataEntryValue | null, user: { id: string; name?: string | null }) {
    const peta = bacaPeta(petaMentah);
    if (!peta) return NextResponse.json({ kode: "PETA_WAJIB", error: "Berkas JKS Web-LL perlu peta salesman dan principal. Pilih ulang berkasnya di dialog impor." }, { status: 400 });
    // Kode sales di peta wajib profil Hierarki yang ada (ketikan lama / profil terhapus = ditolak sebelum menulis apa pun).
    const kodePeta = [...new Set(Object.values(peta.sales).filter(Boolean))];
    const ada = new Set(kodePeta.length ? (await db.select({ k: salesProfile.salesCode }).from(salesProfile).where(inArray(salesProfile.salesCode, kodePeta))).map((r) => r.k) : []);
    const asing = kodePeta.filter((k) => !ada.has(k));
    if (asing.length) return NextResponse.json({ kode: "SALES_TIDAK_DIKENAL", error: `Kode sales tidak ada di Hierarki: ${asing.join(", ")}.` }, { status: 400 });

    const { baris, galat, koordinat } = bacaJksWebLl(rows, peta);
    if (galat.length || baris.length === 0) {
        // Layar hanya menampilkan `error` (tulisFk): contoh baris bermasalah wajib ada di kalimatnya, bukan hanya di `ditolak`.
        const contoh = galat.slice(0, 5).map((g) => `baris ${g.baris}${g.kode ? ` (${g.kode})` : ""}: ${g.pesan}`).join("; ");
        return NextResponse.json({ kode: "GANTI_DIBATALKAN", ditolak: galat, error: galat.length
            ? `Impor JKS dibatalkan, tidak ada yang ditulis: ${galat.length} baris bermasalah — ${contoh}${galat.length > 5 ? `; dan ${galat.length - 5} baris lain` : ""}. Perbaiki peta atau berkasnya lalu ulangi.`
            : "Berkas tidak berisi baris JKS." }, { status: 400 });
    }
    const { ditolak, gantiBatal, ...hasil } = await upsertJksRows(baris, { ganti: true });
    if (gantiBatal) {
        return NextResponse.json({ kode: "GANTI_DIBATALKAN", ditolak: ditolak.map((d) => ({ baris: d.indeks + 2, kode: d.custCode, pesan: `Hari "${d.hari}" tidak dikenal.` })),
            error: "Impor JKS dibatalkan, tidak ada yang ditulis." }, { status: 400 });
    }
    const koordinatBaru = await isiKoordinatLapangan(koordinat, user.id);
    const principal = [...new Set(baris.map((b) => b.principle))];
    await writeKontrolAudit("jks", principal.join(","), "impor_webll", user.id, user.name ?? null,
        { principal, baris: baris.length, dinonaktifkan: hasil.dinonaktifkan, koordinatBaru, peta });
    return NextResponse.json({ success: true, format: "webll", ...hasil, ditolak: [], koordinatBaru });
}
