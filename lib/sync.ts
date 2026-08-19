/*
 * Tujuan: Sync terjadwal data Accurate -> cache SQLite lokal (item, customer, sales_invoice, sales_return).
 * Caller: app/api/cron/sync-accurate/route.ts (dipicu scheduler eksternal, bukan request user).
 * Dependensi: Drizzle, tabel sync_state sebagai checkpoint per modul.
 * Catatan Audit F3: dulu onConflictDoNothing (data lama tak pernah ter-update) — kini upsert penuh.
 * ponytail: full resync tiap run (throttled 150ms/halaman); delta sync via lastUpdate kalau volume mulai berat.
 */
import { db } from "./db";
import { syncState, item, customer, salesInvoiceCache, salesReturnCache } from "../db/schema";
import { parseAccurateDateTime } from "./accurate-invoice";
import { eq, sql } from "drizzle-orm";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AccurateCredentials {
    sessionHost: string;
    sessionId: string;
    apiKey: string;
}

export const accurateHeaders = (creds: AccurateCredentials) => ({
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "SmartERP-SyncAgent/1.0",
    "Authorization": `Bearer ${creds.apiKey}`,
    "X-Session-ID": creds.sessionId,
});

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
            headers: accurateHeaders(creds),
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
const bool = (v: unknown): boolean | null => (v === undefined || v === null ? null : Boolean(v));
const nested = (row: Record<string, unknown>, key: string): Record<string, unknown> =>
    (row[key] && typeof row[key] === "object" ? row[key] as Record<string, unknown> : {});

export type SyncModuleName = "item" | "item_stock" | "customer" | "sales_invoice" | "sales_return";

// Watermark delta feed ke Web Sales. Sync ini full-resync tiap run, jadi synced_at HANYA
// boleh maju kalau isi barisnya benar-benar berubah — kalau tidak, Web Sales menarik ulang
// seluruh tabel tiap siklus. raw_data dipakai sebagai proxy hash: payload Accurate utuh,
// jadi perubahan kolom apa pun ikut terdeteksi.
const bumpSyncedAt = (table: string) =>
    sql.raw(`CASE WHEN ${table}.raw_data IS DISTINCT FROM excluded.raw_data THEN now() ELSE ${table}.synced_at END`);

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
                    syncedAt: bumpSyncedAt("item"),
                },
            });
        },
    },
    // Endpoint terpisah dari /item/list.do (dibuktikan live 2026-07-28) — tidak punya lastUpdate,
    // hanya mengembalikan item yang punya stok tercatat. Upsert HANYA kolom stok: item module
    // (di atas) tetap otoritas untuk name/unitPrice/itemType/rawData, supaya insert parsial dari
    // sini (name/no saja, tanpa unitPrice/itemType) tidak menimpa data lebih lengkap yang sudah ada.
    item_stock: {
        endpoint: "/item/list-stock.do",
        fields: "id,no,name,quantity,quantityInAllUnit",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                no: String(row.no ?? ""),
                name: String(row.name ?? ""),
                quantity: num(row.quantity),
                quantityInAllUnit: str(row.quantityInAllUnit),
            }));
            await db.insert(item).values(payloads).onConflictDoUpdate({
                target: item.id,
                set: {
                    quantity: sql`excluded."quantity"`,
                    quantityInAllUnit: sql`excluded."quantity_in_all_unit"`,
                    syncedAt: sql`CASE WHEN "item"."quantity" IS DISTINCT FROM excluded."quantity" THEN now() ELSE "item"."synced_at" END`,
                },
            });
        },
    },
    customer: {
        endpoint: "/customer/list.do",
        fields: "id,customerNo,name,balance,customerLimitAmount,customerLimitAmountValue,customerLimitAge,customerLimitAgeValue,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                customerNo: String(row.customerNo ?? ""),
                name: String(row.name ?? ""),
                balance: num(row.balance),
                creditLimitEnabled: bool(row.customerLimitAmount),
                creditLimitAmount: num(row.customerLimitAmountValue),
                creditAgeLimitEnabled: bool(row.customerLimitAge),
                creditAgeLimitDays: num(row.customerLimitAgeValue),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(customer).values(payloads).onConflictDoUpdate({
                target: customer.id,
                set: {
                    customerNo: sql`excluded."customerNo"`,
                    name: sql`excluded."name"`,
                    balance: sql`excluded."balance"`,
                    creditLimitEnabled: sql`excluded."credit_limit_enabled"`,
                    creditLimitAmount: sql`excluded."credit_limit_amount"`,
                    creditAgeLimitEnabled: sql`excluded."credit_age_limit_enabled"`,
                    creditAgeLimitDays: sql`excluded."credit_age_limit_days"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                    syncedAt: bumpSyncedAt("customer"),
                },
            });
        },
    },
    sales_invoice: {
        endpoint: "/sales-invoice/list.do",
        // Verifikasi live 2026-07-28: outstanding/outstandingAmount/remainingAmount/paidAmount/
        // status/paymentTermName/customerName/branchName TIDAK ADA (diterima Accurate tapi selalu
        // kosong). Nama field yang benar: statusName, age, dueDate, customer (objek bersarang).
        // Verifikasi live 2026-08-19: sisa piutang ADA, namanya `primeOwing` (bukan `outstanding`)
        // — terbukti terisi di list.do, mis. 396000.945944. Bentuk yang sama juga ada di detail.do,
        // jadi jalur webhook (upsertSalesInvoiceById -> upsertPage ini) ikut mengisinya.
        fields: "id,number,customerNo,customer,totalAmount,transDate,dueDate,statusName,age,lastUpdate,primeOwing,primeReceipt",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                number: str(row.number ?? row.no),
                transDate: str(row.transDate),
                customerNo: str(nested(row, "customer").customerNo ?? row.customerNo),
                customerName: str(nested(row, "customer").name),
                totalAmount: num(row.totalAmount),
                outstanding: num(row.primeOwing),
                status: str(row.statusName),
                dueDate: str(row.dueDate),
                age: num(row.age),
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
                lastUpdateAt: parseAccurateDateTime(row.lastUpdate),
                // createDate hanya dikirim detail.do (jalur webhook). Dari list.do nilainya null —
                // COALESCE di set{} menjaga agar cron tidak menghapus yang sudah benar.
                createdAt: parseAccurateDateTime(row.createDate),
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
                    dueDate: sql`excluded."due_date"`,
                    age: sql`excluded."age"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                    // COALESCE: kalau Accurate tidak mengirim lastUpdate di satu panggilan,
                    // jangan hapus nilai yang sudah benar (pelajaran dari raw_data yang tertimpa).
                    lastUpdateAt: sql`coalesce(excluded."last_update_at", sales_invoice.last_update_at)`,
                    createdAt: sql`coalesce(excluded."created_at", sales_invoice.created_at)`,
                    syncedAt: bumpSyncedAt("sales_invoice"),
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
                    syncedAt: bumpSyncedAt("sales_return"),
                },
            });
        },
    },
};

export const SYNC_MODULE_NAMES = Object.keys(SYNC_MODULES) as SyncModuleName[];

// 2b. Refresh SATU faktur dari webhook "Faktur Penjualan".
// detail.do terlalu mahal untuk sync massal (1 panggilan per faktur), tapi di jalur webhook
// justru pas: 1 event = 1 faktur yang memang baru berubah, plus baris item ikut terbawa.
// Sisa tagihan sendiri kini juga ada di list.do lewat `primeOwing`, jadi cron tidak lagi
// tertinggal soal itu (verifikasi live 2026-08-19).
// Idempoten: upsert by primary key, jadi retry webhook Accurate aman diulang.
export async function upsertSalesInvoiceById(id: number, creds: AccurateCredentials) {
    const url = `${creds.sessionHost}/accurate/api/sales-invoice/detail.do?id=${id}`;
    const res = await fetch(url, { headers: accurateHeaders(creds), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`detail.do faktur ${id}: HTTP ${res.status}`);

    const body = await res.json();
    if (!body?.s || !body?.d) throw new Error(`detail.do faktur ${id}: ${body?.m || "respons tanpa data"}`);

    const row = body.d as Record<string, unknown>;
    await SYNC_MODULES.sales_invoice.upsertPage([row]);

    // Ringkasan untuk log/response — bukti cepat bahwa baris yang benar yang tersimpan.
    return {
        id,
        number: str(row.number),
        customerName: str(nested(row, "customer").name),
        totalAmount: num(row.totalAmount),
        // `outstanding` di detail.do itu BOOLEAN (true/false), bukan nominal — memakainya di sini
        // membuat log webhook menulis "sisa 1" untuk faktur bernilai jutaan. Nominalnya primeOwing.
        outstanding: num(row.primeOwing),
        status: str(row.statusName),
    };
}

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
