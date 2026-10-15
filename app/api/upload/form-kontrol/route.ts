import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { UPLOAD_DIR, labelWaktu, olahFoto } from "@/lib/form-kontrol/uploads";

const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

        const salesName = (formData.get("salesName") as string | null)?.trim() || "";
        const custName  = (formData.get("custName") as string | null)?.trim() || "";
        const lat = formData.get("lat") as string | null;
        const lng = formData.get("lng") as string | null;

        if (!file.type.startsWith("image/")) {
            return NextResponse.json({ error: "Only image files allowed" }, { status: 400 });
        }
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
            return NextResponse.json({ error: "Ukuran file maksimal 5MB." }, { status: 400 });
        }

        const filename = `${randomUUID()}.jpg`;
        const dir = UPLOAD_DIR;
        await mkdir(dir, { recursive: true });

        // Cap (sales | toko | waktu-server | koordinat) di kiri-bawah foto; PNG beralfa berlatar putih (lib/form-kontrol/uploads olahFoto).
        const coordTxt = (lat && lng) ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}` : "Lokasi tidak terdeteksi";
        const line1 = [salesName, custName].filter(Boolean).join(" | ") || "Kunjungan";
        const out = await olahFoto(Buffer.from(await file.arrayBuffer()), [line1, `${labelWaktu("Asia/Jakarta")} | ${coordTxt}`]);
        await writeFile(path.join(dir, filename), out);

        return NextResponse.json({ url: `/api/uploads/form-kontrol/${filename}` });
    } catch {
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
