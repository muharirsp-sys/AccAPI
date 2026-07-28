/**
 * Tujuan: Cursor keyset untuk delta feed Web Internal -> Web Sales (GET /api/ext/changes).
 * Caller: app/api/ext/changes/route.ts; Web Sales menyimpan cursor apa adanya sebagai string opaque.
 * Dependensi: tidak ada (pure) — supaya bisa diuji tanpa DB/HTTP.
 * Main Functions: parseCursor, formatCursor, clampLimit.
 * Side Effects: tidak ada.
 */

export type ExtCursor = { syncedAt: Date; id: number };

export const EXT_DEFAULT_LIMIT = 500;
export const EXT_MAX_LIMIT = 1000;

/**
 * Format: `<ISO synced_at>|<id>`. Pakai tuple `(synced_at, id)` bukan timestamp saja —
 * beberapa baris bisa punya synced_at identik (satu batch upsert = satu `now()`), dan
 * cursor timestamp-saja akan melewatkan sisa baris dengan timestamp yang sama.
 */
export function formatCursor(c: ExtCursor): string {
    return `${c.syncedAt.toISOString()}|${c.id}`;
}

/** null = format tidak valid (caller balas 400, JANGAN diam-diam full resync). */
export function parseCursor(raw: string): ExtCursor | null {
    const sep = raw.lastIndexOf("|");
    if (sep <= 0) return null;
    const syncedAt = new Date(raw.slice(0, sep));
    const id = Number(raw.slice(sep + 1));
    if (Number.isNaN(syncedAt.getTime())) return null;
    if (!Number.isInteger(id) || id < 0) return null;
    return { syncedAt, id };
}

export function clampLimit(raw: string | null): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return EXT_DEFAULT_LIMIT;
    return Math.min(n, EXT_MAX_LIMIT);
}
