/*
 * Tujuan: API tunggal Master Barang untuk list/detail, create, upload/extract, input manual, Kamus Kode, konfirmasi 3 tahap, adaptasi legacy, finalisasi, dan export.
 * Caller: app/(dashboard)/master-barang/page.tsx dan script/operator migrasi.
 * Dependensi: RBAC resolve, service/legacy Master Barang, FastAPI /master-barang/extract, filesystem runtime.
 * Main Functions: GET dan POST.
 * Side Effects: DB read/write, file read/write, HTTP call ke FastAPI, dan download XLSX/source.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { adaptLegacyDirectory } from "@/lib/master-barang/legacy";
import {
    appendSource,
    confirmMasterOverride,
    createMaster,
    exportMasterWorkbook,
    finalizeMaster,
    getMasterDetail,
    getSourceFile,
    listMasters,
    updateCodebook,
} from "@/lib/master-barang/service";
import type { CodebookEntry, SourceItem } from "@/lib/master-barang/engine";

export const runtime = "nodejs";
export const maxDuration = 300;

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

function errorResponse(error: unknown, status = 400) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[MASTER BARANG]", error);
    return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "master_barang.view");
    if (gate.response) return gate.response;
    const { searchParams } = request.nextUrl;
    const id = (searchParams.get("id") || "").trim();
    try {
        if (searchParams.get("export") && id) {
            if (!gate.perms?.has("master_barang.export")) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
            const output = await exportMasterWorkbook(id);
            return new NextResponse(new Uint8Array(output.buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${output.fileName.replace(/"/g, "")}"`, "Cache-Control": "private, no-store" } });
        }
        const sourceId = (searchParams.get("sourceId") || "").trim();
        if (sourceId && id) {
            const source = await getSourceFile(id, sourceId);
            if (!source) return NextResponse.json({ ok: false, error: "Sumber tidak ditemukan." }, { status: 404 });
            const root = path.resolve(process.env.MASTER_BARANG_STORAGE_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "runtime", "master-barang"));
            const stored = path.resolve(/*turbopackIgnore: true*/ source.storagePath);
            if (!stored.startsWith(`${root}${path.sep}`)) return NextResponse.json({ ok: false, error: "Path sumber tidak valid." }, { status: 400 });
            return new NextResponse(new Uint8Array(await readFile(/*turbopackIgnore: true*/ stored)), { headers: { "Content-Type": source.mimeType, "Content-Disposition": `attachment; filename="${source.fileName.replace(/"/g, "")}"`, "Cache-Control": "private, no-store" } });
        }
        if (id) {
            const detail = await getMasterDetail(id);
            return detail ? NextResponse.json({ ok: true, master: detail }) : NextResponse.json({ ok: false, error: "Master Barang tidak ditemukan." }, { status: 404 });
        }
        return NextResponse.json({ ok: true, masters: await listMasters() });
    } catch (error) {
        return errorResponse(error, 500);
    }
}

export async function POST(request: NextRequest) {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
        const gate = await requirePermission(request, "master_barang.upload");
        if (gate.response) return gate.response;
        try {
            const form = await request.formData();
            const masterId = String(form.get("masterId") || "").trim();
            const file = form.get("file");
            if (!masterId || !(file instanceof File)) return NextResponse.json({ ok: false, error: "masterId dan file wajib diisi." }, { status: 400 });
            const forwarded = new FormData();
            forwarded.append("file", file, file.name || "source");
            const response = await fetch(`${fastapiBase()}/master-barang/extract`, {
                method: "POST", body: forwarded,
                headers: { cookie: request.headers.get("cookie") || "" },
            });
            const extracted = await response.json() as { ok?: boolean; error?: string; detail?: string; items?: SourceItem[]; extraction?: Record<string, unknown>; sourceKind?: string };
            if (!response.ok || !extracted.ok) return NextResponse.json({ ok: false, error: extracted.error || "Ekstraksi FastAPI gagal.", detail: extracted.detail || null }, { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
            const bytes = Buffer.from(await file.arrayBuffer());
            const detail = await appendSource({ masterId, fileName: file.name, mimeType: file.type || "application/octet-stream", bytes, sourceKind: extracted.sourceKind || "upload", extractedItems: Array.isArray(extracted.items) ? extracted.items : [], extraction: extracted.extraction || {} }, gate.session!.user.id);
            return NextResponse.json({ ok: true, master: detail, extracted: extracted.items?.length || 0 });
        } catch (error) {
            return errorResponse(error);
        }
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Body JSON tidak valid." }, { status: 400 });
    }
    const action = String(body.action || "");
    const permission = action === "create" || action === "confirm_similarity" ? "master_barang.create"
        : action === "adapt_legacy" ? "master_barang.manage"
            : action === "update_codebook" ? "master_barang.edit"
                : action === "manual_items" ? "master_barang.upload"
                    : "master_barang.generate";
    const gate = await requirePermission(request, permission);
    if (gate.response) return gate.response;
    const actorId = gate.session!.user.id;
    try {
        if (action === "create") {
            const master = await createMaster({ principleName: String(body.principleName || ""), principleCode: String(body.principleCode || "") || undefined }, actorId);
            return NextResponse.json({ ok: true, master });
        }
        const masterId = String(body.masterId || "").trim();
        if (action === "manual_items") {
            const items = Array.isArray(body.items) ? body.items as SourceItem[] : [];
            if (!masterId || !items.length || items.some((item) => !String(item.namaBarang || "").trim())) throw new Error("masterId dan minimal satu Nama Barang wajib diisi.");
            const bytes = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), items }, null, 2), "utf8");
            const master = await appendSource({ masterId, fileName: `manual-input-${Date.now()}.json`, mimeType: "application/json", bytes, sourceKind: "manual", extractedItems: items, extraction: { engine: "manual", rows: items.length } }, actorId);
            return NextResponse.json({ ok: true, master });
        }
        if (action === "update_codebook") {
            const codebook = Array.isArray(body.codebook) ? body.codebook as CodebookEntry[] : [];
            return NextResponse.json({ ok: true, master: await updateCodebook(masterId, codebook, actorId) });
        }
        if (action === "confirm_similarity" || action === "confirm_len50") {
            const kind = action === "confirm_similarity" ? "similarity" : "len50";
            return NextResponse.json({ ok: true, confirmation: await confirmMasterOverride(masterId, kind, actorId) });
        }
        if (action === "finalize") return NextResponse.json({ ok: true, master: await finalizeMaster(masterId, actorId) });
        if (action === "adapt_legacy") {
            const directory = path.join(/*turbopackIgnore: true*/ process.cwd(), "master_barang_principle");
            return NextResponse.json({ ok: true, report: await adaptLegacyDirectory(directory, actorId) });
        }
        return NextResponse.json({ ok: false, error: "Action tidak dikenal." }, { status: 400 });
    } catch (error) {
        return errorResponse(error);
    }
}
