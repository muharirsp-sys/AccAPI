import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

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

        const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
        const filename = `${randomUUID()}.${ext}`;
        const dir = path.join(process.cwd(), "public", "uploads", "form-kontrol");
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, filename), Buffer.from(await file.arrayBuffer()));

        return NextResponse.json({ url: `/uploads/form-kontrol/${filename}` });
    } catch {
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
