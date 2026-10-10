/*
 * Tujuan: Satu tombol — batch laporan principal yang sudah divalidasi jadi antrean faktur.
 * Caller: halaman Order Principal, tombol "Siapkan faktur" (pratinjau) lalu "Antrekan".
 * Dependensi: lib/principal-invoice, lib/accurate-invoice-write, lib/accurate-units,
 *             lib/order-branch, db (principal_order_*, invoice_outbox), rbac.
 * Main Functions: POST (pratinjau default, `queue: true` menulis antrean), GET (status antrean batch).
 * Side Effects: Pratinjau TIDAK menulis apa pun. `queue: true` menulis baris `invoice_outbox`.
 *   TIDAK ADA request tulis ke Accurate di sini — pengirimannya tetap /api/cron/post-invoices.
 *
 * Gerbangnya berlapis dan semuanya gagal-tertutup:
 *   - batch wajib sudah divalidasi (`validated_at`),
 *   - SO yang punya satu saja baris `review` TIDAK ikut,
 *   - kunci antrean = principal + nomor SO, jadi SO yang sama dari berkas lain bentrok di
 *     primary key dan dilewati, bukan jadi faktur kedua,
 *   - cabang + seri penomoran diambil dari pelanggan; ketidakpastian = SO itu dilewati.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee, invoiceOutbox, principalOrderBatch, principalOrderLine } from "@/db/schema";
import { antrekan, pencariPenekan } from "@/lib/invoice-outbox-actions";
import { pernahDibuang } from "@/lib/invoice-outbox-event";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { groupCandidates, invoiceKey, type BatchLine, type SkippedSo } from "@/lib/principal-invoice";
import { buildInvoicePayload, type InvoicePayload } from "@/lib/accurate-invoice-write";
import { accurateUnits } from "@/lib/accurate-units";
import { resolveOrderBranch } from "@/lib/order-branch";

export const runtime = "nodejs";

async function loadBatch(id: string) {
    const [batch] = await db.select().from(principalOrderBatch).where(eq(principalOrderBatch.id, id));
    if (!batch) return { error: "Batch tidak ditemukan", status: 404 as const };
    const rows = await db.select().from(principalOrderLine)
        .where(eq(principalOrderLine.batchId, id)).orderBy(principalOrderLine.rowNumber);
    return { batch, rows };
}

/**
 * Status antrean untuk satu batch: dilihat dari kunci SO-nya, bukan dari kolom baru. Kuncinya dari SEMUA nomor SO batch (BL-21):
 * SO yang sudah antre/terposting lalu ditinjau lagi (Cabut, Segarkan harga, validasi ulang) bukan kandidat lagi, tetapi barisnya
 * di Antrean Faktur tetap ada — tanpa itu layar menganggap batch bebas dihapus/diganti.
 */
export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses antrean faktur tidak diizinkan" }, { status: 403 });
    }
    const id = (request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "Parameter id wajib diisi" }, { status: 400 });
    const loaded = await loadBatch(id);
    if ("error" in loaded) return NextResponse.json({ ok: false, error: loaded.error }, { status: loaded.status });

    const { candidates } = groupCandidates(loaded.batch.principal, loaded.rows as unknown as BatchLine[], {
        fallbackDate: String(loaded.batch.period).slice(0, 10),
    });
    const keys = [...new Set(loaded.rows.map((row) => invoiceKey(loaded.batch.principal, row.soNo)))];
    const queued = keys.length
        ? await db.select({
            orderId: invoiceOutbox.orderId, state: invoiceOutbox.state,
            number: invoiceOutbox.accurateNumber, error: invoiceOutbox.lastError,
        }).from(invoiceOutbox).where(inArray(invoiceOutbox.orderId, keys))
        : [];
    return NextResponse.json({ ok: true, id, candidates: candidates.length, queue: queued });
}

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh menyiapkan faktur" }, { status: 403 });
    }
    const id = (request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "Parameter id wajib diisi" }, { status: 400 });
    const wantQueue = await request.json().then((body) => body?.queue === true).catch(() => false);

    const loaded = await loadBatch(id);
    if ("error" in loaded) return NextResponse.json({ ok: false, error: loaded.error }, { status: loaded.status });
    const { batch, rows } = loaded;
    if (!batch.validatedAt) {
        return NextResponse.json({ ok: false, error: "Batch ini belum divalidasi; jalankan Validasi dulu" }, { status: 409 });
    }

    const { candidates, skipped } = groupCandidates(batch.principal, rows as unknown as BatchLine[], {
        fallbackDate: String(batch.period).slice(0, 10),
        batchLabel: batch.fileName,
    });
    if (candidates.length === 0) {
        return NextResponse.json({ ok: false, error: "Tidak ada SO yang seluruh barisnya lolos validasi", skipped }, { status: 422 });
    }

    const master = await accurateUnits();
    if (!master.units) return NextResponse.json({ ok: false, error: master.error }, { status: 503 });

    // Sales per SO: kode internal dari baris batch -> id pegawai Accurate. `employee.number`
    // memang sama dengan kode internal kita (dibuktikan live 2026-09-12), jadi jembatannya
    // diturunkan dari master, bukan diketik ulang di mapping — kolom yang diisi tangan akan
    // basi diam-diam tiap kali sales berganti, dan itu sudah pernah terjadi.
    const salesmanBySo = new Map<string, string>();
    for (const row of rows) {
        const code = (row.salesmanInternal ?? "").trim().toUpperCase();
        if (code && !salesmanBySo.has(row.soNo)) salesmanBySo.set(row.soNo, code);
    }
    const salesmanIds = new Map<string, number>();
    const codes = [...new Set(salesmanBySo.values())];
    if (codes.length) {
        // Yang `suspended` sengaja tidak ikut: memasang sales nonaktif pada faktur baru hanya
        // memindahkan kesalahan, bukan memperbaikinya. Fakturnya tetap terbit, tanpa sales.
        const employees = await db.select({ number: accurateEmployee.number, id: accurateEmployee.id })
            .from(accurateEmployee)
            .where(and(inArray(accurateEmployee.number, codes), eq(accurateEmployee.salesman, true),
                eq(accurateEmployee.suspended, false)));
        for (const employee of employees) salesmanIds.set(employee.number, employee.id);
    }

    // Sudah pernah diantrekan? Jangan sentuh: `posted` dan `unknown` berarti fakturnya PASTI
    // atau MUNGKIN sudah ada di Accurate, dan faktur ganda di sana tidak bisa dibatalkan.
    const existing = await db.select({ orderId: invoiceOutbox.orderId, state: invoiceOutbox.state })
        .from(invoiceOutbox).where(inArray(invoiceOutbox.orderId, candidates.map((candidate) => candidate.key)));
    const already = new Map(existing.map((row) => [row.orderId, row.state]));

    type Ready = {
        key: string; soNo: string; customerNo: string; orderDate: string; lineCount: number;
        gross: number; net: number; branch: string; payload: InvoicePayload;
        salesman: string; salesmanId: number;
    };
    const ready: Ready[] = [];
    const blocked: SkippedSo[] = [...skipped];

    for (const candidate of candidates) {
        const state = already.get(candidate.key);
        if (state) { blocked.push({ soNo: candidate.soNo, reason: `sudah ada di antrean faktur (status ${state})` }); continue; }
        const resolved = await resolveOrderBranch(candidate.customerNo);
        if (!resolved.branch) { blocked.push({ soNo: candidate.soNo, reason: resolved.error }); continue; }
        try {
            const payload = buildInvoicePayload(candidate.order, {
                unitIds: master.units,
                branchId: resolved.branch.branchId,
                typeAutoNumber: resolved.branch.autoNumberId,
                label: candidate.soNo,
                masterSalesmanId: salesmanIds.get(salesmanBySo.get(candidate.soNo) ?? ""),
                // Nomor pegawai yang SAMA dengan id di atas, hanya bila id-nya ketemu (aktif, sales).
                salesmanNumber: salesmanIds.has(salesmanBySo.get(candidate.soNo) ?? "")
                    ? salesmanBySo.get(candidate.soNo) : undefined,
            });
            ready.push({
                key: candidate.key, soNo: candidate.soNo, customerNo: candidate.customerNo,
                orderDate: candidate.orderDate, lineCount: candidate.lineCount,
                gross: candidate.gross, net: candidate.net, branch: resolved.branch.branchName, payload,
                // Pratinjau harus menyebut sales yang TIDAK ketemu, bukan diam: itulah faktur
                // yang nanti terbit tanpa sales dan baru ketahuan setelah masuk Accurate.
                salesman: salesmanBySo.get(candidate.soNo) ?? "",
                salesmanId: payload.masterSalesmanId ?? 0,
            });
        } catch (error) {
            blocked.push({ soNo: candidate.soNo, reason: error instanceof Error ? error.message : "payload faktur gagal dibuat" });
        }
    }

    if (!wantQueue) {
        // Pratinjau: payload persis yang akan diantrekan, tanpa menulis DB dan tanpa Accurate. SO yang
        // pernah dibuang ditandai: saat diantrekan, fakturnya dicari dulu di Accurate (E2).
        const dibuang = await pernahDibuang(db, ready.map((entry) => entry.key));
        return NextResponse.json({ ok: true, dry_run: true, id, ready: ready.map((entry) => ({ ...entry, pernahDibuang: dibuang.has(entry.key) })), skipped: blocked });
    }
    if (ready.length === 0) {
        return NextResponse.json({ ok: false, error: "Tidak ada SO yang bisa diantrekan", skipped: blocked }, { status: 422 });
    }

    const queuedBy = String(gate.session?.user?.email ?? gate.session?.user?.id ?? "");
    // Baris antrean + event `antre` satu transaksi (BL-17). SO yang PERNAH dibuang dicari dulu di
    // Accurate (E2) dengan sesi penekan: ketemu = terposting tanpa kirim; gagal = tidak diantrekan.
    const pencari = await pencariPenekan(db, String(gate.session?.user?.id ?? ""));
    const hasil = await antrekan(db, {
        entries: ready.map((entry) => ({ orderId: entry.key, customerNo: entry.payload.customerNo, orderDate: entry.orderDate, payload: entry.payload })),
        // BL-21: tulisan antrean mengunci baris batch (bentrok dengan Hapus/Ganti batch yang berjalan bersamaan).
        actor: queuedBy, targetDb: pencari.targetDb, cari: pencari.cari, detail: { batch_id: id }, batchId: id,
    });
    const soOf = new Map(ready.map((entry) => [entry.key, entry.soNo]));
    blocked.push(...hasil.blocked.map((entry) => ({ soNo: soOf.get(entry.orderId) ?? entry.orderId, reason: entry.reason })));

    return NextResponse.json({
        ok: true, id, queued: hasil.queued.length,
        keys: hasil.queued, alreadyPosted: hasil.posted, skipped: blocked,
    });
}
