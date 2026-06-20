import { NextResponse } from "next/server";
import { readdir, stat, unlink } from "fs/promises";
import path from "path";

// ponytail: 90-day retention, turunkan jika disk mepet
const RETENTION_DAYS = 90;

export async function GET(req: Request) {
    const secret = new URL(req.url).searchParams.get("secret");
    if (!secret || secret !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const dir = path.join(process.cwd(), "public", "uploads", "form-kontrol");
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    let deleted = 0;
    let errors = 0;

    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        // dir belum ada (belum ada upload) = gak ada yang dibersihin
        return NextResponse.json({ deleted: 0, errors: 0, retentionDays: RETENTION_DAYS });
    }

    await Promise.all(
        files.map(async (file) => {
            const filePath = path.join(dir, file);
            try {
                const { mtimeMs } = await stat(filePath);
                if (mtimeMs < cutoff) {
                    await unlink(filePath);
                    deleted++;
                }
            } catch {
                errors++;
            }
        })
    );

    return NextResponse.json({ deleted, errors, retentionDays: RETENTION_DAYS });
}
