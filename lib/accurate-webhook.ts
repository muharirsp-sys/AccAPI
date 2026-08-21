/*
 * Tujuan: Parsing payload webhook Accurate (dipisah dari route supaya bisa diuji tanpa server).
 * Caller: app/api/webhook/accurate/route.ts, tests/webhook-payload-parse.spec.ts.
 */

// Bentuk payload dibuktikan live 2026-08-11 (webhook_events.log production): array envelope
// { databaseId, type: "SALES_INVOICE", timestamp, uuid, data: [{ salesInvoiceId, salesInvoiceNo,
// isDownPayment, salesInvoiceTotalAmount, action: "WRITE" }] } — BUKAN { eventType, module, id }
// seperti tebakan awal. `data` adalah array (bisa >1 baris per envelope).
export function flattenSalesInvoiceIds(payload: unknown): number[] {
    const envelopes = (Array.isArray(payload) ? payload : [payload]) as Array<{
        type?: string;
        data?: Array<{ salesInvoiceId?: unknown }>;
    }>;
    const ids: number[] = [];
    for (const envelope of envelopes) {
        if (envelope?.type !== "SALES_INVOICE") continue;
        for (const record of envelope?.data ?? []) {
            const id = Number(record?.salesInvoiceId);
            if (Number.isFinite(id) && id > 0) ids.push(id);
        }
    }
    return ids;
}

// ponytail: regex global, BUKAN JSON.parse per baris. Alasannya bukan kemalasan — route webhook
// memotong payload jumbo di 100.000 karakter, jadi sebagian baris memang JSON tidak lengkap dan
// JSON.parse akan membuangnya utuh. Regex tetap menemukan id di baris terpotong.
// Ceiling: seluruh isi log dibaca ke memori; kalau nanti melewati beberapa ratus MB, ganti ke
// pembacaan per baris (readline).
export function extractLoggedInvoiceIds(logText: string): number[] {
    const ids = new Set<number>();
    for (const m of logText.matchAll(/"salesInvoiceId":\s*(\d+)/g)) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id > 0) ids.add(id);
    }
    return [...ids];
}

// Varian dengan batas waktu: hanya id dari entri log yang receivedAt-nya >= sinceMs.
// Perlu karena log menyimpan SELURUH riwayat, dan mayoritas id lama sudah dihapus di Accurate
// (1.189 dari 15.436 per 2026-08-21) — tanpa batas ini penambal mengejar hantu tiap jam.
// Per baris, bukan seluruh teks: satu baris log = satu event dengan satu receivedAt.
export function extractLoggedInvoiceIdsSince(logText: string, sinceMs: number): number[] {
    const ids = new Set<number>();
    for (const line of logText.split("\n")) {
        if (!line) continue;
        const stamp = line.match(/"receivedAt":"([^"]+)"/)?.[1];
        // Baris tanpa receivedAt yang bisa dibaca: ikut disertakan, lebih baik mencoba sekali
        // daripada melewatkan faktur yang benar-benar hilang.
        if (stamp) {
            const at = new Date(stamp).getTime();
            if (Number.isFinite(at) && at < sinceMs) continue;
        }
        for (const m of line.matchAll(/"salesInvoiceId":\s*(\d+)/g)) {
            const id = Number(m[1]);
            if (Number.isFinite(id) && id > 0) ids.add(id);
        }
    }
    return [...ids];
}
