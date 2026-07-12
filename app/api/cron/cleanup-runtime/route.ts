/*
 * Tujuan: Purge artefak runtime yang regenerable (Audit F6). PDF OPC/claim = arsip, TIDAK disentuh.
 * Caller: Scheduler eksternal (Coolify scheduled task) dengan Bearer CRON_SECRET.
 * Side Effects: unlink file lebih tua dari retensi di folder yang terdaftar saja.
 */
import { NextResponse } from "next/server";
import { readdir, stat, unlink } from "fs/promises";
import path from "path";
import { requireCronSecret } from "@/lib/api-security";

// ponytail: daftar eksplisit folder regenerable + retensi per folder. Folder arsip
// (runtime/claim-workflow, runtime/off-program-control) sengaja TIDAK ada di sini.
const TARGETS: Array<{ dir: string; retentionDays: number }> = [
    { dir: "runtime/laporan-harian", retentionDays: 90 },
    { dir: "runtime_logs", retentionDays: 90 },
];
const GLOB_PREFIX = { parent: "runtime", prefix: "sales-history-build", retentionDays: 30 };

async function purgeDirRecursive(dir: string, cutoff: number): Promise<{ deleted: number; errors: number }> {
    let deleted = 0, errors = 0;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return { deleted, errors }; // folder belum ada
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) {
                const sub = await purgeDirRecursive(full, cutoff);
                deleted += sub.deleted; errors += sub.errors;
            } else {
                const { mtimeMs } = await stat(full);
                if (mtimeMs < cutoff) { await unlink(full); deleted++; }
            }
        } catch {
            errors++;
        }
    }
    return { deleted, errors };
}

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const results: Record<string, { deleted: number; errors: number; retentionDays: number }> = {};
    for (const t of TARGETS) {
        const cutoff = Date.now() - t.retentionDays * 24 * 60 * 60 * 1000;
        results[t.dir] = { ...(await purgeDirRecursive(t.dir, cutoff)), retentionDays: t.retentionDays };
    }

    // runtime/sales-history-build* (folder build timestamped)
    try {
        const cutoff = Date.now() - GLOB_PREFIX.retentionDays * 24 * 60 * 60 * 1000;
        const entries = await readdir(GLOB_PREFIX.parent, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith(GLOB_PREFIX.prefix)) {
                const full = path.join(GLOB_PREFIX.parent, entry.name);
                results[full] = { ...(await purgeDirRecursive(full, cutoff)), retentionDays: GLOB_PREFIX.retentionDays };
            }
        }
    } catch { /* runtime/ belum ada */ }

    return NextResponse.json({ ok: true, results });
}
