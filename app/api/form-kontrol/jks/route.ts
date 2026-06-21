import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import * as XLSX from "xlsx";
import { getJksList, upsertJksRows } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const salesCode     = searchParams.get("salesCode") ?? undefined;
        const principle     = searchParams.get("principle") ?? undefined;
        // UI mengirim `hari`; terima juga `hariKunjungan` untuk kompatibilitas.
        const hariKunjungan = searchParams.get("hari") ?? searchParams.get("hariKunjungan") ?? undefined;
        const page          = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
        const limit         = Math.min(200, parseInt(searchParams.get("limit") ?? "50", 10));
        const offset        = (page - 1) * limit;

        const result = await getJksList({ salesCode, principle, hariKunjungan, isActive: true }, limit, offset);
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
            v = ["ganjil", "genap", "all"].includes(low) ? low : "all";
        }
        if (field === "visitFrequency") v = parseInt(String(v), 10) || undefined;
        out[field] = v;
    }
    return out;
}

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const contentType = req.headers.get("content-type") ?? "";
        let rows: Record<string, unknown>[] = [];

        if (contentType.includes("multipart/form-data")) {
            // Import Excel dari UI (TabJks kirim file .xlsx via FormData).
            const form = await req.formData();
            const file = form.get("file");
            if (!(file instanceof File)) {
                return NextResponse.json({ error: "File tidak ditemukan" }, { status: 400 });
            }
            const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            if (!sheet) return NextResponse.json({ error: "Sheet kosong" }, { status: 400 });
            const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
            rows = raw.map(mapExcelRow);
        } else {
            const body = await req.json();
            rows = Array.isArray(body) ? body : (body.rows ?? []);
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return NextResponse.json({ error: "Tidak ada baris untuk diimport" }, { status: 400 });
        }
        const result = await upsertJksRows(rows as Parameters<typeof upsertJksRows>[0]);
        return NextResponse.json({ success: true, ...result });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Gagal import" }, { status: 500 });
    }
}
