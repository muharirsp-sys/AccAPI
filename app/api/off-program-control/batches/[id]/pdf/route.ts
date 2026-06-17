import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { canActorAccessOffData, getBatchWithItems, requireOffSession } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
    // Isolasi per-supervisor: SPV hanya boleh mengunduh PDF batch miliknya sendiri.
    if (actor.role === "supervisor" && data.batch.createdBy !== actor.id) {
        return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
    }
    if (!data.batch.pdfPath) return NextResponse.json({ ok: false, error: "PDF has not been generated" }, { status: 404 });

    try {
        const file = await readFile(data.batch.pdfPath);
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${data.batch.noPengajuan.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf"`,
            },
        });
    } catch {
        return NextResponse.json({ ok: false, error: "PDF file not found" }, { status: 404 });
    }
}
