/*
 * Tujuan: Orkestrasi persistence Master Barang, source upload, konfirmasi 3 tahap, finalisasi, audit, dan export workbook 4-sheet.
 * Caller: app/api/master-barang/route.ts dan scripts/adapt-master-barang.mjs.
 * Dependensi: Drizzle PostgreSQL, db/schema, domain engine, xlsx, filesystem runtime.
 * Main Functions: listMasters, getMasterDetail, createMaster, appendSource, updateCodebook, confirmMasterOverride, finalizeMaster, buildMasterWorkbook, exportMasterWorkbook.
 * Side Effects: DB read/write, file I/O sumber upload, dan pembuatan buffer XLSX.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { masterBarang, masterBarangAudit, masterBarangSource } from "@/db/schema";
import {
    FORM_FIX_COLUMNS,
    NAMA_WIN_MAX,
    findSimilarPrinciples,
    generateMasterBarang,
    normalizePrincipleName,
    type CodebookEntry,
    type FormFixRow,
    type MasterQc,
    type SourceItem,
} from "@/lib/master-barang/engine";

type ConfirmationBucket = {
    revisionHash: string;
    fingerprint: string;
    count: number;
    complete: boolean;
    bulk?: boolean;
    candidates?: Array<{ id: string; principleName: string; score: number }>;
};

export type ConfirmationState = {
    similarity?: ConfirmationBucket;
    len50?: ConfirmationBucket;
    gramasi?: ConfirmationBucket;
};

export type MasterRecord = {
    id: string;
    principleCode: string;
    principleName: string;
    principleNameNorm: string;
    status: string;
    revision: number;
    revisionHash: string;
    sourceItems: SourceItem[];
    codebook: CodebookEntry[];
    formRows: FormFixRow[];
    qc: MasterQc;
    confirmationState: ConfirmationState;
    legacyFileName: string | null;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
};

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CODEBOOK_LEVELS = new Set(["klp", "sub_klp", "sub_klp2", "aroma", "gramasi", "kemasan", "promo", "sachet", "golongan"]);
const asItems = (value: unknown) => Array.isArray(value) ? value as SourceItem[] : [];
const asCodebook = (value: unknown) => Array.isArray(value) ? value as CodebookEntry[] : [];
const asRows = (value: unknown) => Array.isArray(value) ? value as FormFixRow[] : [];
const asQc = (value: unknown) => (value && typeof value === "object" ? value : { errors: 0, warnings: 0, over50: 0, invalidCodeLength: 0, lowConfidence: 0, duplicateCodes: 0, gramasiNearDup: 0, issues: [] }) as MasterQc;
const asConfirmations = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as ConfirmationState : {};

function toRecord(row: typeof masterBarang.$inferSelect): MasterRecord {
    return {
        ...row,
        sourceItems: asItems(row.sourceItems), codebook: asCodebook(row.codebook), formRows: asRows(row.formRows),
        qc: asQc(row.qc), confirmationState: asConfirmations(row.confirmationState),
    };
}

function hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Bangun ulang bucket konfirmasi bulk (len50 + gramasi mirip) dari hasil generate.
// Dipakai di setiap jalur yang meregenerasi Form Fix (appendSource, updateCodebook)
// supaya aturannya satu sumber. similarity di-preserve lewat spread prev.
function qcConfirmations(prev: ConfirmationState, generated: { revisionHash: string; qc: MasterQc; formRows: FormFixRow[] }): ConfirmationState {
    const nearDup = generated.qc.issues.filter((issue) => issue.code === "GRAMASI_NEAR_DUP");
    return {
        ...prev,
        len50: generated.qc.over50 ? { revisionHash: generated.revisionHash, fingerprint: hash(generated.formRows.filter((item) => item.len50 > NAMA_WIN_MAX).map((item) => [item.no, item.namaWin])), count: 0, complete: false, bulk: true } : undefined,
        gramasi: nearDup.length ? { revisionHash: generated.revisionHash, fingerprint: hash(nearDup.map((issue) => [issue.row, issue.message])), count: 0, complete: false, bulk: true } : undefined,
    };
}

function safeFileName(value: string): string {
    return path.basename(value || "source").replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 160) || "source";
}

function storageRoot(): string {
    return path.resolve(process.env.MASTER_BARANG_STORAGE_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "runtime", "master-barang"));
}

function maxUploadBytes(): number {
    const configured = Number(process.env.MASTER_BARANG_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_UPLOAD_BYTES;
}

async function audit(masterId: string, actorId: string, action: string, detail: Record<string, unknown> = {}) {
    await db.insert(masterBarangAudit).values({ id: randomUUID(), masterId, actorId, action, detail, createdAt: new Date() });
}

async function suggestPrincipleCode(name: string): Promise<string> {
    const rows = await db.select({ code: masterBarang.principleCode }).from(masterBarang);
    const used = new Set(rows.map((row) => row.code.toUpperCase()));
    const letters = normalizePrincipleName(name).replace(/[^A-Z]/g, "") || "X";
    for (const letter of [...letters, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]) {
        for (let number = 1; number <= 9; number++) {
            const candidate = `${letter}${number}`;
            if (!used.has(candidate)) return candidate;
        }
    }
    throw new Error("Kapasitas kode principal huruf+angka habis; isi kode 2 karakter secara manual.");
}

export async function listMasters() {
    const rows = await db.select().from(masterBarang).orderBy(desc(masterBarang.updatedAt));
    return rows.map((row) => {
        const item = toRecord(row);
        return {
            id: item.id, principleCode: item.principleCode, principleName: item.principleName, status: item.status,
            revision: item.revision, itemCount: item.formRows.length, errors: item.qc.errors, warnings: item.qc.warnings,
            over50: item.qc.over50, updatedAt: item.updatedAt,
        };
    });
}

export async function getMasterDetail(id: string) {
    const [row] = await db.select().from(masterBarang).where(eq(masterBarang.id, id)).limit(1);
    if (!row) return null;
    const [sources, audits] = await Promise.all([
        db.select({ id: masterBarangSource.id, fileName: masterBarangSource.fileName, mimeType: masterBarangSource.mimeType, fileSize: masterBarangSource.fileSize, sha256: masterBarangSource.sha256, sourceKind: masterBarangSource.sourceKind, extraction: masterBarangSource.extraction, createdAt: masterBarangSource.createdAt })
            .from(masterBarangSource).where(eq(masterBarangSource.masterId, id)).orderBy(desc(masterBarangSource.createdAt)),
        db.select().from(masterBarangAudit).where(eq(masterBarangAudit.masterId, id)).orderBy(desc(masterBarangAudit.createdAt)).limit(100),
    ]);
    return { ...toRecord(row), sources, audits };
}

export async function createMaster(input: { principleName: string; principleCode?: string; legacyFileName?: string | null }, actorId: string, bypassSimilarity = false) {
    const principleName = String(input.principleName || "").trim().toUpperCase();
    if (!principleName) throw new Error("Nama Principle wajib diisi.");
    const principleCode = String(input.principleCode || "").trim().toUpperCase() || await suggestPrincipleCode(principleName);
    if (!/^[A-Z0-9]{2}$/.test(principleCode)) throw new Error("Kode Principle harus 2 karakter huruf/angka, atau kosongkan agar dibuat otomatis.");
    const existing = await db.select({ id: masterBarang.id, principleName: masterBarang.principleName }).from(masterBarang);
    const candidates = bypassSimilarity ? [] : findSimilarPrinciples(principleName, existing);
    const baseHash = hash({ principleName, principleCode, sourceItems: [] });
    const similarityFingerprint = hash(candidates.map(({ id, score }) => [id, score.toFixed(4)]));
    const confirmationState: ConfirmationState = candidates.length ? {
        similarity: { revisionHash: baseHash, fingerprint: similarityFingerprint, count: 0, complete: false, candidates },
    } : {};
    const now = new Date();
    const id = randomUUID();
    await db.insert(masterBarang).values({
        id, principleCode, principleName, principleNameNorm: normalizePrincipleName(principleName),
        status: candidates.length ? "blocked_similarity" : "draft", revision: 1, revisionHash: baseHash,
        sourceItems: [], codebook: [], formRows: [], qc: {}, confirmationState,
        legacyFileName: input.legacyFileName || null, createdBy: actorId, createdAt: now, updatedAt: now,
    });
    await audit(id, actorId, "master.create", { candidates, codeAutoGenerated: !input.principleCode, bypassSimilarity });
    return getMasterDetail(id);
}

export async function appendSource(input: {
    masterId: string; fileName: string; mimeType: string; bytes: Buffer; sourceKind: string;
    extractedItems: SourceItem[]; extraction: Record<string, unknown>;
}, actorId: string) {
    const sizeLimit = maxUploadBytes();
    if (!input.bytes.length || input.bytes.length > sizeLimit) throw new Error(`Ukuran file harus 1 byte sampai ${Math.floor(sizeLimit / 1024 / 1024)} MB.`);
    const [row] = await db.select().from(masterBarang).where(eq(masterBarang.id, input.masterId)).limit(1);
    if (!row) throw new Error("Master Barang tidak ditemukan.");
    const current = toRecord(row);
    if (current.status === "blocked_similarity") throw new Error("Selesaikan 3 konfirmasi nama mirip sebelum upload sumber.");
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const [duplicate] = await db.select({ id: masterBarangSource.id }).from(masterBarangSource)
        .where(and(eq(masterBarangSource.masterId, input.masterId), eq(masterBarangSource.sha256, sha256))).limit(1);
    if (duplicate) throw new Error("File sumber yang sama sudah pernah diupload ke master ini.");
    const generated = generateMasterBarang(current.principleName, current.principleCode, [...current.sourceItems, ...input.extractedItems], current.codebook);
    const nextRevision = current.revision + 1;
    const confirmations = qcConfirmations(current.confirmationState, generated);
    const root = storageRoot();
    const masterDir = path.resolve(/*turbopackIgnore: true*/ root, input.masterId);
    if (!masterDir.startsWith(`${root}${path.sep}`)) throw new Error("Path storage sumber tidak valid.");
    await mkdir(masterDir, { recursive: true });
    const storedName = `${sha256.slice(0, 16)}_${safeFileName(input.fileName)}`;
    const storagePath = path.join(/*turbopackIgnore: true*/ masterDir, storedName);
    await writeFile(/*turbopackIgnore: true*/ storagePath, input.bytes, { flag: "wx" });
    const now = new Date();
    try {
        await db.transaction(async (tx) => {
            await tx.insert(masterBarangSource).values({
                id: randomUUID(), masterId: input.masterId, fileName: safeFileName(input.fileName), mimeType: input.mimeType || "application/octet-stream",
                fileSize: input.bytes.length, sha256, storagePath, sourceKind: input.sourceKind, extraction: input.extraction, createdBy: actorId, createdAt: now,
            });
            const updated = await tx.update(masterBarang).set({
                revision: nextRevision, revisionHash: generated.revisionHash, sourceItems: generated.sourceItems, codebook: generated.codebook,
                formRows: generated.formRows, qc: generated.qc, confirmationState: confirmations, status: "review", updatedAt: now,
            }).where(and(eq(masterBarang.id, input.masterId), eq(masterBarang.revision, current.revision))).returning({ id: masterBarang.id });
            if (!updated.length) throw new Error("Master berubah saat upload diproses; ulangi upload pada revisi terbaru.");
            await tx.insert(masterBarangAudit).values({ id: randomUUID(), masterId: input.masterId, actorId, action: "source.upload", detail: { fileName: input.fileName, sha256, extracted: input.extractedItems.length, revision: nextRevision }, createdAt: now });
        });
    } catch (error) {
        await unlink(storagePath).catch(() => undefined);
        throw error;
    }
    return getMasterDetail(input.masterId);
}

export async function updateCodebook(masterId: string, codebook: CodebookEntry[], actorId: string) {
    const [row] = await db.select().from(masterBarang).where(eq(masterBarang.id, masterId)).limit(1);
    if (!row) throw new Error("Master Barang tidak ditemukan.");
    const current = toRecord(row);
    if (!Array.isArray(codebook) || codebook.some((entry) => !entry.key || !CODEBOOK_LEVELS.has(entry.level) || !String(entry.code ?? "").match(/^\d{0,4}$/))) {
        throw new Error("Format Kamus Kode tidak valid.");
    }
    const generated = generateMasterBarang(current.principleName, current.principleCode, current.sourceItems, codebook.map((entry) => ({ ...entry, name: String(entry.name || "").trim().toUpperCase(), code: String(entry.code ?? "") })));
    const nextRevision = current.revision + 1;
    const confirmationState = qcConfirmations(current.confirmationState, generated);
    await db.transaction(async (tx) => {
        const updated = await tx.update(masterBarang).set({ revision: nextRevision, revisionHash: generated.revisionHash, codebook: generated.codebook, formRows: generated.formRows, qc: generated.qc, confirmationState, status: "review", updatedAt: new Date() })
            .where(and(eq(masterBarang.id, masterId), eq(masterBarang.revision, current.revision))).returning({ id: masterBarang.id });
        if (!updated.length) throw new Error("Master berubah saat Kamus Kode disimpan; muat ulang revisi terbaru.");
        await tx.insert(masterBarangAudit).values({ id: randomUUID(), masterId, actorId, action: "codebook.update", detail: { revision: nextRevision, entries: generated.codebook.length }, createdAt: new Date() });
    });
    return getMasterDetail(masterId);
}

export async function confirmMasterOverride(masterId: string, kind: "similarity" | "len50" | "gramasi", actorId: string) {
    return db.transaction(async (tx) => {
        const [row] = await tx.select().from(masterBarang).where(eq(masterBarang.id, masterId)).limit(1).for("update");
        if (!row) throw new Error("Master Barang tidak ditemukan.");
        const current = toRecord(row);
        const bucket = current.confirmationState[kind];
        if (!bucket) throw new Error("Tidak ada konfirmasi aktif untuk kondisi ini.");
        if (bucket.revisionHash !== current.revisionHash) throw new Error("Draft berubah; konfirmasi lama sudah tidak berlaku.");
        const next = { ...bucket, count: Math.min(3, bucket.count + 1), complete: bucket.count + 1 >= 3 };
        const state = { ...current.confirmationState, [kind]: next };
        const status = kind === "similarity" && next.complete ? "draft" : current.status;
        await tx.update(masterBarang).set({ confirmationState: state, status, updatedAt: new Date() }).where(eq(masterBarang.id, masterId));
        await tx.insert(masterBarangAudit).values({ id: randomUUID(), masterId, actorId, action: `confirm.${kind}`, detail: { step: next.count, complete: next.complete, revision: current.revision }, createdAt: new Date() });
        return { kind, count: next.count, required: 3, complete: next.complete, status };
    });
}

export async function finalizeMaster(masterId: string, actorId: string) {
    await db.transaction(async (tx) => {
        const [row] = await tx.select().from(masterBarang).where(eq(masterBarang.id, masterId)).limit(1).for("update");
        if (!row) throw new Error("Master Barang tidak ditemukan.");
        const current = toRecord(row);
        if (current.status === "blocked_similarity") throw new Error("Konfirmasi nama mirip belum selesai 3 tahap.");
        if (!current.formRows.length) throw new Error("Form Fix masih kosong.");
        if (current.qc.errors > 0) throw new Error(`Masih ada ${current.qc.errors} error QC yang wajib diperbaiki lewat Kamus Kode.`);
        if (current.qc.over50 > 0 && (!current.confirmationState.len50?.complete || current.confirmationState.len50.revisionHash !== current.revisionHash)) {
            throw new Error(`Ada ${current.qc.over50} Nama Win lebih dari ${NAMA_WIN_MAX} karakter; jalankan konfirmasi bulk sampai 3 tahap.`);
        }
        if ((current.qc.gramasiNearDup ?? 0) > 0 && (!current.confirmationState.gramasi?.complete || current.confirmationState.gramasi.revisionHash !== current.revisionHash)) {
            throw new Error(`Ada ${current.qc.gramasiNearDup} pasangan gramasi mirip (<30%); jalankan konfirmasi bulk sampai 3 tahap.`);
        }
        const now = new Date();
        await tx.update(masterBarang).set({ status: "ready", updatedAt: now }).where(eq(masterBarang.id, masterId));
        await tx.insert(masterBarangAudit).values({ id: randomUUID(), masterId, actorId, action: "master.finalize", detail: { revision: current.revision, items: current.formRows.length, len50Bulk: Boolean(current.confirmationState.len50?.complete) }, createdAt: now });
    });
    return getMasterDetail(masterId);
}

export function buildMasterWorkbook(detail: Pick<MasterRecord, "principleName" | "sourceItems" | "codebook" | "formRows" | "qc">): { buffer: Buffer; fileName: string } {
    const wb = XLSX.utils.book_new();
    const form = [
        FORM_FIX_COLUMNS.map((column) => column.label),
        ...detail.formRows.map((row) => FORM_FIX_COLUMNS.map((column) => row[column.key] ?? "")),
    ];
    const source = detail.sourceItems.map((item, index) => ({ NO: index + 1, "Kode Pcpl": item.kodePcpl ?? "", "Klp Brg Pcpl": item.kelompokPcpl ?? "", "Nama Barang Principle": item.namaBarang, "ISI/CTN": item.isiCtn ?? "", Gramasi: item.gramasi ?? "", Kemasan: item.kemasan ?? "", "Halaman Sumber": item.sourcePage ?? "", "Baris Sumber": item.sourceRow ?? "", Confidence: item.confidence ?? 1, Review: (item.reviewNotes ?? []).join("; ") }));
    const codebook = detail.codebook.map((entry) => ({ Level: entry.level, Scope: entry.scope, "Nama Sumber": entry.sourceName, Nama: entry.name, Kode: entry.code, Generated: entry.generated ? "YA" : "TIDAK" }));
    const qc = [
        { Severity: "SUMMARY", Code: "ERRORS", Row: "", Message: detail.qc.errors },
        { Severity: "SUMMARY", Code: "WARNINGS", Row: "", Message: detail.qc.warnings },
        { Severity: "SUMMARY", Code: "LEN50", Row: "", Message: detail.qc.over50 },
        ...detail.qc.issues.map((issue) => ({ Severity: issue.severity.toUpperCase(), Code: issue.code, Row: issue.row ?? "", Message: issue.message })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(form), "Form Fix");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(source), "Sumber PDF");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(codebook), "Kamus Kode");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(qc), "QC");
    for (const ws of Object.values(wb.Sheets)) {
        ws["!autofilter"] = { ref: ws["!ref"] || "A1:A1" };
        const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
        ws["!cols"] = Array.from({ length: range.e.c + 1 }, (_, column) => {
            let width = 12;
            for (let row = range.s.r; row <= Math.min(range.e.r, 200); row++) {
                const value = ws[XLSX.utils.encode_cell({ r: row, c: column })]?.v;
                width = Math.max(width, String(value ?? "").length + 2);
            }
            return { wch: Math.min(width, 50) };
        });
    }
    const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));
    return { buffer, fileName: `MASTER BARANG ${detail.principleName.replace(/[^A-Z0-9]+/gi, " ").trim()}.xlsx` };
}

export async function exportMasterWorkbook(masterId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const detail = await getMasterDetail(masterId);
    if (!detail) throw new Error("Master Barang tidak ditemukan.");
    return buildMasterWorkbook(detail);
}

export async function getSourceFile(masterId: string, sourceId: string) {
    const [row] = await db.select().from(masterBarangSource).where(and(eq(masterBarangSource.id, sourceId), eq(masterBarangSource.masterId, masterId))).limit(1);
    return row ?? null;
}
