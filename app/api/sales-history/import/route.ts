/*
 * Tujuan: Import CSV e-Faktur ke sales-history-inv.db (streaming, memori terbatas) via halaman upload.
 * Caller: app/(dashboard)/sales-history/page.tsx (fetch POST body = file mentah).
 * Main Functions: POST.
 * Side Effects: Delete+insert sales_history_item di sales-history-inv.db untuk source_file yang sama; satuan CSV diisi kosong.
 * Dependensi: lib/sales-history/parse.ts (parser), lib/sales-history/db.ts (DB terpisah), RBAC resolve.
 * Guard: sales_history.manage (default-deny). Idempotent: hapus baris source_file sama sebelum isi ulang.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { ensureSalesHistorySchema, salesClient, salesDb, salesHistoryItem } from "@/lib/sales-history/db";
import { SUMBER_ACCURATE } from "@/lib/sales-history/accurate";
import {
    parseFkContext,
    parseOfItem,
    splitCsvLine,
    type FkContext,
    type SalesHistoryItemInput,
} from "@/lib/sales-history/parse";

export const runtime = "nodejs";
export const maxDuration = 300; // file besar -> beri waktu

const BATCH = 1000;
const MAX_LINE_BYTES = 1_000_000; // tolak baris CSV tunggal > ~1MB agar buf tak tumbuh tak terbatas
// ponytail: lock in-memory single-instance per sourceFile; upgrade ke DB lock bila jalan multi-node
const inFlight = new Set<string>();

export async function POST(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.manage");
    if (gate.response) return gate.response;

    const sourceFile = (request.headers.get("x-filename") || "upload.csv").replace(/[^\w.\-]/g, "_");
    if (sourceFile === SUMBER_ACCURATE) {
        return NextResponse.json({ ok: false, error: "Nama berkas dicadangkan untuk salinan Accurate. Ganti nama berkas." }, { status: 400 });
    }
    if (!request.body) {
        return NextResponse.json({ ok: false, error: "Body kosong." }, { status: 400 });
    }

    // Cegah race: upload sourceFile sama bersamaan bisa interleave delete+insert -> data loss parsial.
    if (inFlight.has(sourceFile)) {
        return NextResponse.json({ ok: false, error: "File dengan nama sama sedang diproses. Tunggu sampai selesai." }, { status: 409 });
    }
    inFlight.add(sourceFile);

    try {
        await ensureSalesHistorySchema();
        // Re-import idempotent: bersihkan data file ini dulu.
        await salesDb.delete(salesHistoryItem).where(eq(salesHistoryItem.sourceFile, sourceFile));

        const reader = request.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let ctx: FkContext | null = null;
        let batch: (SalesHistoryItemInput & { sourceFile: string })[] = [];
        let total = 0;

        const flush = async () => {
            if (!batch.length) return;
            await salesDb.insert(salesHistoryItem).values(batch);
            total += batch.length;
            batch = [];
        };

        const handleLine = (line: string) => {
            if (!line.trim()) return;
            const fields = splitCsvLine(line);
            const tag = (fields[0] ?? "").trim();
            if (tag === "FK") ctx = parseFkContext(fields);
            else if (tag === "OF") {
                const item = parseOfItem(fields, ctx);
                if (item) batch.push({ ...item, sourceFile });
            }
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (buf.indexOf("\n") < 0 && buf.length > MAX_LINE_BYTES) {
                return NextResponse.json({ ok: false, error: "Baris CSV melebihi batas ukuran." }, { status: 400 });
            }
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                handleLine(buf.slice(0, nl).replace(/\r$/, ""));
                buf = buf.slice(nl + 1);
                if (batch.length >= BATCH) await flush();
            }
        }
        handleLine(buf.replace(/\r$/, "")); // baris terakhir tanpa newline
        await flush();
        // Berkas menang atas salinan Accurate (cron sales-history-accurate): buang baris Accurate untuk faktur yang kini ada di berkas ini.
        await salesClient.execute({
            sql: "DELETE FROM sales_history_item WHERE source_file = ? AND referensi IN (SELECT referensi FROM sales_history_item WHERE source_file = ?)",
            args: [SUMBER_ACCURATE, sourceFile],
        });

        return NextResponse.json({ ok: true, sourceFile, imported: total });
    } catch (error) {
        console.error("[SALES HISTORY IMPORT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengimpor data." }, { status: 500 });
    } finally {
        inFlight.delete(sourceFile);
    }
}
