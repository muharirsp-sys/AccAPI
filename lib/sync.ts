/*
 * Tujuan: Sync terjadwal data Accurate -> cache SQLite lokal (item, customer, sales_invoice, sales_return).
 * Caller: app/api/cron/sync-accurate/route.ts (dipicu scheduler eksternal, bukan request user).
 * Dependensi: Drizzle, tabel sync_state sebagai checkpoint per modul.
 * Catatan Audit F3: dulu onConflictDoNothing (data lama tak pernah ter-update) — kini upsert penuh.
 * ponytail: full resync tiap run (throttled 150ms/halaman); delta sync via lastUpdate kalau volume mulai berat.
 */
import { db } from "./db";
import { syncState, item, customer, salesInvoiceCache, salesReturnCache } from "../db/schema";
import { eq, sql } from "drizzle-orm";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AccurateCredentials {
    sessionHost: string;
    sessionId: string;
    apiKey: string;
}

// 1. AccuratePaginator: Generator asinkron pagination + throttle rate limit.
// Catatan: Accurate list.do TANPA parameter `fields` hanya mengembalikan { id } per baris
// (dibuktikan production 2026-07-13: raw_data == {"id":2331}) — fields wajib eksplisit.
export async function* AccuratePaginator(
    endpoint: string,
    creds: AccurateCredentials,
    startPage: number = 1,
    fields?: string
) {
    let currentPage = startPage;
    let pageCount = currentPage;

    while (currentPage <= pageCount) {
        const fieldsParam = fields ? `&fields=${encodeURIComponent(fields)}` : "";
        const url = `${creds.sessionHost}/accurate/api${endpoint}?sp.page=${currentPage}&sp.pageSize=100${fieldsParam}`;

        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "SmartERP-SyncAgent/1.0",
                "Authorization": `Bearer ${creds.apiKey}`,
                "X-Session-ID": creds.sessionId,
            },
            signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
            throw new Error(`Accurate API Error: HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.s) {
            throw new Error(`Accurate API returned logical error: ${data.m || JSON.stringify(data)}`);
        }

        if (data.sp && data.sp.pageCount) {
            pageCount = data.sp.pageCount;
        }

        yield {
            data: data.d as Array<Record<string, unknown>>,
            page: currentPage,
            pageCount,
            totalRows: data.sp?.rowCount || 0,
        };

        currentPage++;
        if (currentPage <= pageCount) {
            await delay(150); // rate limit Accurate
        }
    }
}

// Helper null-safe: tidak mengarang angka — field absen jadi null, payload utuh tetap di rawData.
const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const nested = (row: Record<string, unknown>, key: string): Record<string, unknown> =>
    (row[key] && typeof row[key] === "object" ? row[key] as Record<string, unknown> : {});

export type SyncModuleName = "item" | "customer" | "sales_invoice" | "sales_return";

// 2. Registry modul sync: endpoint + fields (WAJIB — list.do tanpa `fields` hanya
// mengembalikan { id }, dibuktikan live production 2026-07-13) + upsert per halaman.
const SYNC_MODULES: Record<SyncModuleName, {
    endpoint: string;
    fields: string;
    upsertPage: (rows: Array<Record<string, unknown>>) => Promise<void>;
}> = {
    item: {
        endpoint: "/item/list.do",
        // "id" wajib eksplisit — Accurate TIDAK menyertakannya otomatis saat fields diisi
        // (dibuktikan live 2026-07-13: tanpa "id" → NaN saat insert, primary key gagal).
        fields: "id,no,name,unitPrice,itemType,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                no: String(row.no ?? ""),
                name: String(row.name ?? ""),
                itemType: str(row.itemType),
                unitPrice: num(row.unitPrice),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(item).values(payloads).onConflictDoUpdate({
                target: item.id,
                set: {
                    no: sql`excluded."no"`,
                    name: sql`excluded."name"`,
                    itemType: sql`excluded."itemType"`,
                    unitPrice: sql`excluded."unitPrice"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                },
            });
        },
    },
    customer: {
        endpoint: "/customer/list.do",
        fields: "id,customerNo,name,balance,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                customerNo: String(row.customerNo ?? ""),
                name: String(row.name ?? ""),
                balance: num(row.balance),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(customer).values(payloads).onConflictDoUpdate({
                target: customer.id,
                set: {
                    customerNo: sql`excluded."customerNo"`,
                    name: sql`excluded."name"`,
                    balance: sql`excluded."balance"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                },
            });
        },
    },
    sales_invoice: {
        endpoint: "/sales-invoice/list.do",
        // outstanding/status/customerName: nama field Accurate yang benar belum diketahui
        // (diuji live 2026-07-13, tidak muncul di respons) — TBD saat PRD 02 Incaso dibangun.
        fields: "id,number,customerNo,totalAmount,transDate,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                number: str(row.number ?? row.no),
                transDate: str(row.transDate),
                customerNo: str(nested(row, "customer").customerNo ?? row.customerNo),
                customerName: str(nested(row, "customer").name ?? row.customerName),
                totalAmount: num(row.totalAmount),
                outstanding: num(row.outstanding ?? row.outstandingAmount),
                status: str(row.status ?? row.statusName),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(salesInvoiceCache).values(payloads).onConflictDoUpdate({
                target: salesInvoiceCache.id,
                set: {
                    number: sql`excluded."number"`,
                    transDate: sql`excluded."trans_date"`,
                    customerNo: sql`excluded."customer_no"`,
                    customerName: sql`excluded."customer_name"`,
                    totalAmount: sql`excluded."total_amount"`,
                    outstanding: sql`excluded."outstanding"`,
                    status: sql`excluded."status"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                },
            });
        },
    },
    sales_return: {
        endpoint: "/sales-return/list.do",
        // status/customerName: nama field belum diketahui (diuji live, tidak muncul) — TBD.
        fields: "id,number,customerNo,totalAmount,transDate,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                number: str(row.number ?? row.no),
                transDate: str(row.transDate),
                customerNo: str(nested(row, "customer").customerNo ?? row.customerNo),
                customerName: str(nested(row, "customer").name ?? row.customerName),
                totalAmount: num(row.totalAmount),
                status: str(row.status ?? row.statusName),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(salesReturnCache).values(payloads).onConflictDoUpdate({
                target: salesReturnCache.id,
                set: {
                    number: sql`excluded."number"`,
                    transDate: sql`excluded."trans_date"`,
                    customerNo: sql`excluded."customer_no"`,
                    customerName: sql`excluded."customer_name"`,
                    totalAmount: sql`excluded."total_amount"`,
                    status: sql`excluded."status"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                },
            });
        },
    },
};

export const SYNC_MODULE_NAMES = Object.keys(SYNC_MODULES) as SyncModuleName[];

// 3. syncModule: orchestrator dengan checkpoint per halaman + watermark selesai.
export async function syncModule(moduleName: SyncModuleName, creds: AccurateCredentials) {
    const mod = SYNC_MODULES[moduleName];
    if (!mod) return { success: false, message: `Modul sync tidak dikenal: ${moduleName}` };

    // D4: .get() sqlite-only — pg pakai destructure limit(1)
    let [state] = await db.select().from(syncState).where(eq(syncState.module, moduleName)).limit(1);
    if (!state) {
        await db.insert(syncState).values({ module: moduleName, lastPage: 1, status: "syncing", updatedAt: new Date() });
        state = { module: moduleName, lastSyncTimestamp: null, lastPage: 1, status: "syncing", updatedAt: new Date() };
    } else {
        await db.update(syncState).set({ status: "syncing", updatedAt: new Date() }).where(eq(syncState.module, moduleName));
    }

    const startedAt = Date.now();
    let totalRows = 0;
    try {
        const paginator = AccuratePaginator(mod.endpoint, creds, state.lastPage ?? 1, mod.fields);
        for await (const chunk of paginator) {
            if (chunk.data.length > 0) {
                await mod.upsertPage(chunk.data);
                totalRows += chunk.data.length;
            }
            // Checkpoint per halaman — run terputus bisa dilanjutkan.
            await db.update(syncState).set({ lastPage: chunk.page + 1, updatedAt: new Date() }).where(eq(syncState.module, moduleName));
        }

        await db.update(syncState).set({
            status: "idle",
            lastPage: 1,
            lastSyncTimestamp: new Date().toISOString(),
            updatedAt: new Date(),
        }).where(eq(syncState.module, moduleName));

        return { success: true, message: `Sync ${moduleName} selesai`, rows: totalRows, durationMs: Date.now() - startedAt };
    } catch (e) {
        await db.update(syncState).set({ status: "error", updatedAt: new Date() }).where(eq(syncState.module, moduleName));
        return { success: false, message: e instanceof Error ? e.message : String(e), rows: totalRows, durationMs: Date.now() - startedAt };
    }
}
