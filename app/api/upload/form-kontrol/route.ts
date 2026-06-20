import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

        if (!file.type.startsWith("image/")) {
            return NextResponse.json({ error: "Only image files allowed" }, { status: 400 });
        }
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
            return NextResponse.json({ error: "Ukuran file maksimal 5MB." }, { status: 400 });
        }

        const filename = `${randomUUID()}.jpg`;
        const dir = path.join(process.cwd(), "public", "uploads", "form-kontrol");
        await mkdir(dir, { recursive: true });

        const buf = await sharp(Buffer.from(await file.arrayBuffer()))
            .rotate()
            .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 72 })
            .toBuffer();
        await writeFile(path.join(dir, filename), buf);

        return NextResponse.json({ url: `/uploads/form-kontrol/${filename}` });
    } catch {
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
