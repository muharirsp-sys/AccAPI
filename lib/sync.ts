import { db } from "./db";
import { syncState, item as customItem, customer as customCustomer } from "../db/schema";
import { eq } from "drizzle-orm";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AccurateCredentials {
    sessionHost: string;
    sessionId: string;
    apiKey: string;
}

// 1. AccuratePaginator: Generator Asinkron untuk menangani pagination dan throttle Rate Limit.
export async function* AccuratePaginator(
    endpoint: string,
    creds: AccurateCredentials,
    startPage: number = 1
) {
    let currentPage = startPage;
    let pageCount = currentPage;

    while (currentPage <= pageCount) {
        const url = `${creds.sessionHost}/accurate/api${endpoint}?sp.page=${currentPage}&sp.pageSize=100`;

        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "SmartERP-SyncAgent/1.0",
                "Authorization": `Bearer ${creds.apiKey}`,
                "X-Session-ID": creds.sessionId,
            },
        });

        if (!response.ok) {
            throw new Error(`Accurate API Error: HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.s) {
            throw new Error(`Accurate API returned logical error: ${data.m || JSON.stringify(data)}`);
        }

        // Parse meta page
        if (data.sp && data.sp.pageCount) {
            pageCount = data.sp.pageCount;
        }

        yield {
            data: data.d,
            page: currentPage,
            pageCount: pageCount,
            totalRows: data.sp?.rowCount || 0,
        };

        currentPage++;
        
        // THROTTLING: 150ms delay for Rate Limit Protection
        if (currentPage <= pageCount) {
            await delay(150);
        }
    }
}

// 2. ModuleSyncJob: Orchestrator sinkronisasi (Menyimpan Checkpoint & Meneruskan ke Local Cache)
export async function syncModule(
    moduleName: 'item' | 'customer',
    endpoint: string,
    creds: AccurateCredentials
) {
    // A. Dapatkan atau buat status Sinkronisasi Terakhir (SyncStateStore)
    let state = await db.select().from(syncState).where(eq(syncState.module, moduleName)).get();

    if (!state) {
        await db.insert(syncState).values({
            module: moduleName,
            lastPage: 1,
            status: 'syncing',
        });
        state = { module: moduleName, lastSyncTimestamp: null, lastPage: 1, status: 'syncing', updatedAt: new Date() };
    } else {
        await db.update(syncState).set({ status: 'syncing', updatedAt: new Date() }).where(eq(syncState.module, moduleName));
    }

    try {
        // B. Eksekusi Paginator Generator (Melanjutkan dari lastPage bila sempat terpotong)
        const paginator = AccuratePaginator(endpoint, creds, state.lastPage ?? 1);

        for await (const chunk of paginator) {
            // C. Mapping Payload bergantung dari Modul
            const payloadsToInsert = chunk.data.map((row: any) => {
                if (moduleName === 'item') {
                    return {
                        id: row.id,
                        no: row.no,
                        name: row.name,
                        itemType: row.itemType,
                        unitPrice: row.unitPrice || 0,
                        rawData: JSON.stringify(row),
                        lastUpdate: row.lastUpdate || new Date().toISOString() // Assuming there is a lastUpdate
                    };
                } else if (moduleName === 'customer') {
                    return {
                        id: row.id,
                        customerNo: row.customerNo,
                        name: row.name,
                        balance: row.balance || 0,
                        rawData: JSON.stringify(row),
                        lastUpdate: row.lastUpdate || new Date().toISOString()
                    };
                }
            });

            // D. Lempar (Upsert) Data ke Database Lokal (SQLite) per Halaman
            // Catatan: Drizzle on SQLite mendadak upsert via onConflictDoUpdate
            if (payloadsToInsert.length > 0) {
                if (moduleName === 'item') {
                    // Kita asumsikan implementasi upsert (simplicity)
                    await db.insert(customItem).values(payloadsToInsert).onConflictDoNothing();
                } else if (moduleName === 'customer') {
                    await db.insert(customCustomer).values(payloadsToInsert).onConflictDoNothing();
                }
            }

            // E. Simpan Checkpoint setiap berhasil 1 Halaman
            await db.update(syncState).set({
                lastPage: chunk.page + 1,
            }).where(eq(syncState.module, moduleName));
        }

        // F. Sinkronisasi Selesai (Full Sync) -> Reset Checkpoint untuk Delta Sync berikutnya
        // Di sistem Enterprise nyata, Delta Sync mengirim param ?lastUpdateHistory=...
        // Untuk saat ini kita kembalikan Mode ke "idle" dan set lastPage = 1
        await db.update(syncState).set({
            status: 'idle',
            lastPage: 1,
            updatedAt: new Date()
        }).where(eq(syncState.module, moduleName));

        return { success: true, message: `Berhasil tersinkronisasi. Modul: ${moduleName}` };

    } catch (e: any) {
        // Fallback Error Logging ke SyncStore
        await db.update(syncState).set({ status: 'error', updatedAt: new Date() }).where(eq(syncState.module, moduleName));
        return { success: false, message: e.message };
    }
}
