/*
 * Tujuan: Sync terjadwal data Accurate -> cache SQLite lokal (item, customer, sales_invoice, sales_return).
 * Caller: app/api/cron/sync-accurate/route.ts (dipicu scheduler eksternal, bukan request user).
 * Dependensi: Drizzle, sync_state, program-realization-store untuk jejak benefit faktur aktual.
 * Main Functions: syncModule, upsertSalesInvoiceById. Side Effects: HTTP baca, cache dan verifikasi realisasi.
 * Catatan Audit F3: dulu onConflictDoNothing (data lama tak pernah ter-update) — kini upsert penuh.
 * ponytail: full resync tiap run (throttled 150ms/halaman); delta sync via lastUpdate kalau volume mulai berat.
 */
import { db } from "./db";
import { syncState, branch, accurateAutoNumber, accurateUnit, accurateEmployee, item, customer, salesInvoiceCache, salesReturnCache } from "../db/schema";
import { parseAccurateDateTime } from "./accurate-invoice";
import { matchBranchAutoNumbers } from "./branch-auto-number";
import { eq, sql } from "drizzle-orm";
import { recordInvoiceRealization } from "./program-realization-store";
import { cabangDariTag, normalNama, petaCabang } from "./order-cabang";
import { redactAccurateSecrets } from "./accurate-redact";
import { ringkasFaktur } from "./supervisor-review/ringkas-faktur";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AccurateCredentials {
    databaseId?: string;
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
            throw new Error(`Accurate API returned logical error: ${redactAccurateSecrets(String(data.m || JSON.stringify(data)))}`);
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

export type SyncModuleName = "branch" | "auto_number" | "unit" | "employee" | "item" | "item_stock" | "customer" | "sales_invoice" | "sales_return";

// Watermark delta feed ke Web Sales. Sync ini full-resync tiap run, jadi synced_at HANYA
// boleh maju kalau isi barisnya benar-benar berubah — kalau tidak, Web Sales menarik ulang
// seluruh tabel tiap siklus. raw_data dipakai sebagai proxy hash: payload Accurate utuh,
// jadi perubahan kolom apa pun ikut terdeteksi.
/**
 * Alamat customer dari Accurate: billStreet + billCity + billProvince, bagian kosong dibuang.
 * Bukan `shipStreet`: yang dipakai mesin usulan area adalah lokasi outletnya, dan alamat
 * kirim bisa berupa gudang/ekspedisi yang wilayahnya lain sama sekali.
 */
export function alamatAccurate(row: Record<string, unknown>): string | null {
    const bagian = [row.billStreet, row.billCity, row.billProvince]
        .map((v) => String(v ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    return bagian.length ? bagian.join(", ") : null;
}

const bumpSyncedAt = (table: string) =>
    sql.raw(`CASE WHEN ${table}.raw_data IS DISTINCT FROM excluded.raw_data THEN now() ELSE ${table}.synced_at END`);

// `suspended` hanya ditimpa bila jawaban Accurate MEMBAWA field itu: list.do memintanya eksplisit, tetapi detail.do (jalur webhook)
// bentuknya lain. Field absen = "tidak tahu", bukan "aktif" — pola yang sama dengan cabang pelanggan di bawah.
// raw_data bertipe jsonb tetapi ISINYA STRING JSON (lib/promo-recap, produksi 2026-09-12: jsonb_typeof = "string") -> diurai dulu
// (`#>> '{}'` lalu ::jsonb; berlaku juga bila suatu hari isinya objek).
const suspendedBila = (table: string) =>
    sql.raw(`CASE WHEN (excluded.raw_data #>> '{}')::jsonb -> 'suspended' IS NOT NULL THEN excluded."suspended" ELSE ${table}."suspended" END`);
// Tag divisi barang (cabang order) dengan aturan yang SAMA (O1 putaran 1, butir 10): list.do memintanya eksplisit dan detail.do webhook
// MEMBAWA charField1/2 (probe produksi 12 Okt 2026), tetapi bentuk jawaban tanpa key `charField2` = "tidak tahu" -> cabang lama
// DIPERTAHANKAN, bukan dikosongkan. Key ada (termasuk null/"") = ditimpa: tag dikosongkan di Accurate = tanpa cabang = tak bisa diorder.
const tagBila = (kolom: "branch_id" | "char_field2") =>
    sql.raw(`CASE WHEN (excluded.raw_data #>> '{}')::jsonb -> 'charField2' IS NOT NULL THEN excluded."${kolom}" ELSE item."${kolom}" END`);

/**
 * Satu baris item/list.do (atau detail.do webhook) -> kolom tabel `item`. Murni supaya pemetaan tag divisi bisa diuji tanpa DB.
 * O1 (owner 12 Okt 2026): `charField2` = tag divisi -> cabang (lib/order-cabang). Tag absen/kosong/tak dikenal = branch_id NULL =
 * barang TIDAK bisa diorder (gagal tertutup) — tak dikenal/kosong dihitung pemanggil supaya tidak diam.
 */
export function barisItem(row: Record<string, unknown>, peta: ReadonlyMap<string, number>) {
    const tag = cabangDariTag(row.charField2, peta);
    return {
        jenis: tag.jenis,
        // Key absen = jawaban tanpa tag (cabang lama dipertahankan saat upsert) — tidak dihitung "(kosong)".
        adaTag: "charField2" in row,
        tag: normalNama(row.charField2) || "(kosong)",
        payload: {
            id: Number(row.id),
            no: String(row.no ?? ""),
            name: String(row.name ?? ""),
            itemType: str(row.itemType),
            unitPrice: num(row.unitPrice),
            branchId: tag.branchId,
            suspended: row.suspended === true,
            charField2: str(row.charField2),
            rawData: JSON.stringify(row),
            lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
        },
    };
}

/** Hitungan tag yang membuat barang tak bisa diorder padahal bukan non-jual (tak dikenal / kosong). */
export type TagTakDikenal = Record<string, number>;

// 2. Registry modul sync: endpoint + fields (WAJIB — list.do tanpa `fields` hanya
// mengembalikan { id }, dibuktikan live production 2026-07-13) + upsert per halaman.
const SYNC_MODULES: Record<SyncModuleName, {
    endpoint: string;
    fields: string;
    upsertPage: (rows: Array<Record<string, unknown>>) => Promise<void | TagTakDikenal>;
}> = {
    // Cabang: 22 baris, satu halaman. Kecil tapi WAJIB — penomoran faktur Accurate berjalan
    // per cabang, jadi order tanpa branchId yang benar akan masuk urutan cabang default.
    // `defaultBranch`/`suspended` ikut diminta; kalau Accurate tidak mengenalnya, field itu
    // DIABAIKAN DIAM-DIAM (tidak error) dan kolomnya tetap default — periksa hasil sync
    // pertama, jangan asumsikan terisi.
    branch: {
        endpoint: "/branch/list.do",
        fields: "id,name,defaultBranch,suspended,lastUpdate",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                name: String(row.name ?? ""),
                defaultBranch: row.defaultBranch === true,
                suspended: row.suspended === true,
                rawData: JSON.stringify(row),
                lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
            }));
            await db.insert(branch).values(payloads).onConflictDoUpdate({
                target: branch.id,
                set: {
                    name: sql`excluded."name"`,
                    defaultBranch: sql`excluded."default_branch"`,
                    suspended: sql`excluded."suspended"`,
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                    syncedAt: bumpSyncedAt("branch"),
                },
            });
        },
    },
    // Penomoran dokumen. Kecil (155 baris) tapi wajib: seri Faktur Penjualan (`SI`) inilah
    // yang dikirim sebagai `typeAutoNumber` supaya nomor faktur mengikuti cabangnya.
    // auto-number/list.do TIDAK punya rujukan cabang dan detail.do-nya 404 (probe 2026-09-09),
    // jadi pemetaan cabang->seri hidup di branch.si_auto_number_id, bukan di sini.
    auto_number: {
        endpoint: "/auto-number/list.do",
        fields: "id,name,transactionType,autoNumberType,counterDigit,suspended",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                name: String(row.name ?? ""),
                transactionType: String(row.transactionType ?? ""),
                autoNumberType: String(row.autoNumberType ?? ""),
                counterDigit: row.counterDigit === null || row.counterDigit === undefined ? null : Number(row.counterDigit),
                suspended: row.suspended === true,
                rawData: JSON.stringify(row),
            }));
            await db.insert(accurateAutoNumber).values(payloads).onConflictDoUpdate({
                target: accurateAutoNumber.id,
                set: {
                    name: sql`excluded."name"`,
                    transactionType: sql`excluded."transaction_type"`,
                    autoNumberType: sql`excluded."auto_number_type"`,
                    counterDigit: sql`excluded."counter_digit"`,
                    suspended: sql`excluded."suspended"`,
                    rawData: sql`excluded."raw_data"`,
                    syncedAt: bumpSyncedAt("accurate_auto_number"),
                },
            });
        },
    },
    // Master satuan: 37 baris. Sumber `detailItem[].itemUnitId` saat membuat faktur, dan
    // ruang id-nya sama dengan item.unitNId (dibuktikan 2026-09-09).
    unit: {
        endpoint: "/unit/list.do",
        fields: "id,name,suspended",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                name: String(row.name ?? "").trim().toUpperCase(),
                suspended: row.suspended === true,
                rawData: JSON.stringify(row),
            }));
            await db.insert(accurateUnit).values(payloads).onConflictDoUpdate({
                target: accurateUnit.id,
                set: {
                    name: sql`excluded."name"`,
                    suspended: sql`excluded."suspended"`,
                    rawData: sql`excluded."raw_data"`,
                    syncedAt: bumpSyncedAt("accurate_unit"),
                },
            });
        },
    },
    // Sumber `masterSalesmanId` baris faktur. `salesman/list.do` TIDAK ADA (404 "URL API tidak
    // tepat", diuji live 2026-09-12); salesman adalah pegawai bertanda `salesman: true`, dan
    // `number`-nya sama persis dengan kode salesman internal kita.
    employee: {
        endpoint: "/employee/list.do",
        fields: "id,number,name,branchId,salesman,suspended",
        upsertPage: async (rows) => {
            const payloads = rows.map((row) => ({
                id: Number(row.id),
                number: String(row.number ?? "").trim().toUpperCase(),
                name: String(row.name ?? "").trim(),
                branchId: num(row.branchId),
                salesman: row.salesman === true,
                suspended: row.suspended === true,
                rawData: JSON.stringify(row),
            }));
            await db.insert(accurateEmployee).values(payloads).onConflictDoUpdate({
                target: accurateEmployee.id,
                set: {
                    number: sql`excluded."number"`,
                    name: sql`excluded."name"`,
                    branchId: sql`excluded."branch_id"`,
                    salesman: sql`excluded."salesman"`,
                    suspended: sql`excluded."suspended"`,
                    rawData: sql`excluded."raw_data"`,
                    syncedAt: bumpSyncedAt("accurate_employee"),
                },
            });
        },
    },
    item: {
        endpoint: "/item/list.do",
        // "id" wajib eksplisit — Accurate TIDAK menyertakannya otomatis saat fields diisi
        // (dibuktikan live 2026-07-13: tanpa "id" → NaN saat insert, primary key gagal).
        // O1 (probe produksi 12 Okt 2026): charField2 = tag divisi (-> cabang), charField1 = perusahaan principal, preferedVendor =
        // pemasok utama (dua terakhir hanya di raw_data). itemCategory TIDAK dipakai (4.087 barang "Umum").
        fields: "id,no,name,unitPrice,itemType,charField1,charField2,suspended,preferedVendor,lastUpdate",
        upsertPage: async (rows) => {
            // 22 baris; dibaca per halaman supaya cabang yang baru tersinkron langsung terpakai. Modul branch berjalan lebih dulu di cron.
            const peta = petaCabang(await db.select({ id: branch.id, name: branch.name }).from(branch));
            const takDikenal: TagTakDikenal = {};
            const payloads = rows.map((row) => {
                const b = barisItem(row, peta);
                if (b.adaTag && (b.jenis === "tak_dikenal" || b.jenis === "kosong")) takDikenal[b.tag] = (takDikenal[b.tag] ?? 0) + 1;
                return b.payload;
            });
            await db.insert(item).values(payloads).onConflictDoUpdate({
                target: item.id,
                set: {
                    no: sql`excluded."no"`,
                    name: sql`excluded."name"`,
                    itemType: sql`excluded."itemType"`,
                    unitPrice: sql`excluded."unitPrice"`,
                    // Tag divisi ditimpa bila jawaban MEMBAWA key charField2 (lihat tagBila); key absen = cabang lama tetap.
                    branchId: tagBila("branch_id"),
                    charField2: tagBila("char_field2"),
                    suspended: suspendedBila("item"),
                    rawData: sql`excluded."raw_data"`,
                    lastUpdate: sql`excluded."last_update"`,
                    syncedAt: bumpSyncedAt("item"),
                },
            });
            return takDikenal;
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
        // billStreet/City/Province ditambahkan 2026-09-03. Accurate PUNYA alamatnya sejak
        // dulu (ACCURATE_API_REFERENCE.md:281); kolomnya kosong bukan karena Accurate tidak
        // mengirim, tapi karena tidak pernah diminta di sini. Alamat = satu-satunya sinyal
        // mesin usulan area, dan tanpa itu cakupannya runtuh ~79% -> ~21%.
        // `category` = TIPE OUTLET, `branch` = cabang pemilik pelanggan; keduanya hanya datang
        // sebagai OBJEK. Varian datar (categoryId/branchId/salesman) diabaikan diam-diam oleh
        // list.do — dibuktikan probe live 2026-09-09.
        // `suspended` (O1, 12 Okt 2026): pelanggan suspended tidak bisa dipilih untuk order baru (lib/order-cabang).
        fields: "id,customerNo,name,balance,customerLimitAmount,customerLimitAmountValue,customerLimitAge,customerLimitAgeValue,billStreet,billCity,billProvince,priceCategory,category,branch,suspended,lastUpdate",
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
                alamat: alamatAccurate(row),
                // priceCategory datang sebagai objek {id,name} — penentu tier harga pelanggan.
                priceCategoryId: num((row.priceCategory as Record<string, unknown> | undefined)?.id),
                priceCategoryName: str((row.priceCategory as Record<string, unknown> | undefined)?.name),
                categoryId: num((row.category as Record<string, unknown> | undefined)?.id ?? row.categoryId),
                categoryName: str((row.category as Record<string, unknown> | undefined)?.name) || str(row.customerCategoryName),
                // DUA bentuk, dan keduanya nyata. `list.do` (cron) mengirim `branch` sebagai
                // OBJEK; `detail.do` (jalur webhook) mengirim `branchId` DATAR plus
                // `customerBranchName`, tanpa objek `branch` sama sekali. Membaca objeknya saja
                // membuat setiap pelanggan yang disegarkan webhook KEHILANGAN cabangnya —
                // dan cabang adalah penentu harga (satu baris harga per kategori x satuan x
                // CABANG). Akibatnya di produksi 2026-09-12: 84 pelanggan tanpa cabang, harga
                // jatuh ke cabang lain, dan 11 baris SATU SAMA ditahan sebagai "harga tidak
                // sesuai" padahal harga di Accurate sudah benar.
                branchId: num((row.branch as Record<string, unknown> | undefined)?.id ?? row.branchId),
                branchName: str((row.branch as Record<string, unknown> | undefined)?.name) || str(row.customerBranchName),
                suspended: row.suspended === true,
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
                    priceCategoryId: sql`excluded."price_category_id"`,
                    categoryId: sql`excluded."category_id"`,
                    categoryName: sql`excluded."category_name"`,
                    // COALESCE, bukan timpa: jawaban yang tidak membawa cabang tidak boleh
                    // MENGHAPUS cabang yang sudah benar. Bentuk jawaban Accurate berbeda antar
                    // endpoint, dan pelajaran yang sama sudah dibayar dua kali hari ini —
                    // raw_data faktur dan cabang pelanggan. Kosong berarti "tidak tahu",
                    // bukan "tidak punya".
                    branchId: sql`coalesce(excluded."branch_id", customer.branch_id)`,
                    branchName: sql`coalesce(nullif(excluded."branch_name", ''), customer.branch_name)`,
                    priceCategoryName: sql`excluded."price_category_name"`,
                    suspended: suspendedBila("customer"),
                    // ISI KALAU KOSONG, tidak pernah menimpa. Alamat dari `Master Area Heinz`
                    // sudah dinormalkan tangan dan memuat `Kel./Kec.` yang dibaca parseKelKec();
                    // yang dari Accurate mentah dan sering tanpa keduanya. Menimpa = menukar
                    // sinyal bagus dengan sinyal buruk, diam-diam, 4x sehari.
                    // nullif: alamat Accurate yang kosong tidak boleh "mengisi" apa pun.
                    alamat: sql`CASE WHEN coalesce(customer.alamat, '') = ''
                                     THEN nullif(excluded."alamat", '')
                                     ELSE customer.alamat END`,
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
                // Supervisor Review (spec 2026-10-16 §3.2): salesman header, Σ qty satuan terkecil, jumlah baris, Σ DPP. list.do tanpa
                // detailItem -> semuanya null -> penjaga di set{} mempertahankan ringkasan dari detail.do.
                ...ringkasFaktur(row),
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
                    // JANGAN menimpa rincian baris dengan jawaban yang tidak punya rincian.
                    // `list.do` (cron) tidak mengirim `detailItem`; `detail.do` (webhook) iya.
                    // Tanpa penjagaan ini, sync terjadwal menghapus satu-satunya salinan baris
                    // faktur yang dipakai Rekap Promo DAN verifikasi balik (butir 4.30) — dan
                    // keduanya lalu melaporkan "tidak ada apa-apa" dengan nada meyakinkan.
                    // ponytail: cocokkan teksnya, karena raw_data tersimpan sebagai STRING JSON
                    // di kolom jsonb sehingga operator `?` tidak bisa dipakai. Kalau suatu saat
                    // penyimpanannya diperbaiki jadi objek, ganti dengan `raw_data ? 'detailItem'`.
                    rawData: sql`case when excluded."raw_data"::text like '%detailItem%'
                                       or sales_invoice.raw_data::text not like '%detailItem%'
                                  then excluded."raw_data" else sales_invoice.raw_data end`,
                    lastUpdate: sql`excluded."last_update"`,
                    // COALESCE: kalau Accurate tidak mengirim lastUpdate di satu panggilan,
                    // jangan hapus nilai yang sudah benar (pelajaran dari raw_data yang tertimpa).
                    lastUpdateAt: sql`coalesce(excluded."last_update_at", sales_invoice.last_update_at)`,
                    createdAt: sql`coalesce(excluded."created_at", sales_invoice.created_at)`,
                    // Ringkasan Supervisor Review mengikuti aturan raw_data di atas: jawaban TANPA rincian (list.do -> null) tidak
                    // mengosongkan; jawaban BER-rincian (qty_total terisi) menang utuh — termasuk salesman yang dikosongkan di Accurate,
                    // yang dengan coalesce polos akan tertinggal salesman lama.
                    salesmanId: sql`case when excluded."qty_total" is not null then excluded."salesman_id" else sales_invoice.salesman_id end`,
                    qtyTotal: sql`coalesce(excluded."qty_total", sales_invoice.qty_total)`,
                    jumlahItem: sql`coalesce(excluded."jumlah_item", sales_invoice.jumlah_item)`,
                    dpp: sql`coalesce(excluded."dpp", sales_invoice.dpp)`,
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
// Dibedakan dari Error biasa supaya pemanggil bisa memisahkan "faktur sudah dihapus di Accurate"
// (kondisi normal, tidak perlu dicoba lagi) dari kegagalan nyata seperti timeout atau sesi mati.
export class AccurateInvoiceGoneError extends Error {
    constructor(public readonly invoiceId: number) {
        super(`Faktur ${invoiceId} tidak ada lagi di Accurate (detail.do)`);
        this.name = "AccurateInvoiceGoneError";
    }
}

/**
 * Jawaban detail.do faktur yang MEMBUKTIKAN fakturnya sudah tidak ada di Accurate. Dua bentuk:
 * - `s:true` dengan `d` kosong — dibuktikan live 2026-08-21 pada 20 id dari webhook_events.log.
 * - `s:false` dengan `d: ["Faktur Penjualan tidak tepat"]` — faktur dihapus (sebagian dibuat ulang
 *   dengan nomor sama, id baru), probe produksi 15 Okt 2026: 164 baris hantu, sisa ±Rp 86 jt.
 * Selain itu (sesi mati, galat lain, `s:false` tanpa pesan) BUKAN bukti: pemanggil menghapus baris
 * cache atas dasar ini, jadi yang ragu jatuh ke galat biasa dan dicoba lagi.
 */
export function fakturSudahTiada(body: unknown): boolean {
    const b = body as { s?: unknown; d?: unknown } | null;
    if (b?.s === true && !b.d) return true;
    return b?.s === false && Array.isArray(b.d)
        && b.d.some((m) => typeof m === "string" && /^Faktur Penjualan tidak tepat\.?$/i.test(m.trim()));
}

/**
 * Satu pelanggan/barang yang diberitahukan webhook -> segarkan cache master kita.
 *
 * Kenapa perlu: master `customer` dan `item` adalah SALINAN hasil sync, bukan sambungan
 * langsung. Kategori harga pelanggan yang diubah di Accurate tidak terlihat sampai cron
 * berikutnya (4x sehari) — dan gerbang validasi memakai kategori itu untuk menentukan harga.
 * Nyata terjadi 2026-09-11: kategori HINDA MART diubah ke TT, tetapi 11 baris faktur tetap
 * tertahan karena cache masih MT.
 *
 * `detail.do` dipakai, sama seperti jalur faktur. Kalau field kunci (`customerNo`/`no`) tidak
 * ada pada jawabannya, barisnya TIDAK ditulis: menimpa master dengan nilai kosong jauh lebih
 * buruk daripada menunggu cron.
 */
export async function upsertMasterById(
    kind: "customer" | "item", id: number, creds: AccurateCredentials,
): Promise<{ kind: string; id: number; code: string }> {
    const path = kind === "customer" ? "customer" : "item";
    const url = `${creds.sessionHost}/accurate/api/${path}/detail.do?id=${id}`;
    const res = await fetch(url, { headers: accurateHeaders(creds), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`detail.do ${kind} ${id}: HTTP ${res.status}`);
    const body = await res.json();
    const row = body?.d as Record<string, unknown> | undefined;
    if (!row) throw new Error(`detail.do ${kind} ${id}: respons tanpa data`);

    const code = String((kind === "customer" ? row.customerNo : row.no) ?? "").trim();
    if (!code) throw new Error(`detail.do ${kind} ${id}: tanpa ${kind === "customer" ? "customerNo" : "no"}; tidak ditulis`);

    const takDikenal = await SYNC_MODULES[kind].upsertPage([row]);
    if (takDikenal && Object.keys(takDikenal).length) {
        console.warn(`[sync] webhook item ${code}: tag charField2 tanpa cabang -> tidak bisa diorder: ${JSON.stringify(takDikenal)}`);
    }
    return { kind, id, code };
}

export async function upsertSalesInvoiceById(id: number, creds: AccurateCredentials) {
    const url = `${creds.sessionHost}/accurate/api/sales-invoice/detail.do?id=${id}`;
    const res = await fetch(url, { headers: accurateHeaders(creds), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`detail.do faktur ${id}: HTTP ${res.status}`);

    const body = await res.json();
    // Faktur yang sudah dihapus di Accurate: buang juga salinannya. list.do (cron) tidak pernah
    // menghapus baris, jadi tanpa ini faktur hantu tinggal selamanya — tampil ganda di /faktur
    // ("Belum Lunas"), ikut Rekap Promo, riwayat beli, dan feed Web Sales. Accurate sumber kebenaran;
    // baris yang ternyata masih hidup kembali lewat sync list.do berikutnya.
    // Pagar: hanya bila sesi terbuka pada database faktur (ACCURATE_INVOICE_DB_ID, pagar yang sama dengan kirim
    // faktur). Sesi di database lain juga menjawab "tidak tepat" untuk faktur sah — itu bukan bukti hapus.
    if (fakturSudahTiada(body)) {
        const dbFaktur = String(process.env.ACCURATE_INVOICE_DB_ID || "").trim();
        if (dbFaktur && String(creds.databaseId ?? "") === dbFaktur) {
            const dibuang = await db.delete(salesInvoiceCache).where(eq(salesInvoiceCache.id, id))
                .returning({ number: salesInvoiceCache.number, outstanding: salesInvoiceCache.outstanding });
            if (dibuang.length) console.log(`[sync] faktur ${id} ${dibuang[0].number ?? "-"} (sisa ${dibuang[0].outstanding ?? "-"}) tidak ada di Accurate -> cache dibuang`);
        } else {
            console.warn(`[sync] faktur ${id} tidak ada di Accurate, cache TIDAK dibuang: database sesi ${creds.databaseId ?? "?"} bukan ACCURATE_INVOICE_DB_ID (${dbFaktur || "kosong"})`);
        }
        if (creds.databaseId) await recordInvoiceRealization(creds.databaseId, String(id), null);
        throw new AccurateInvoiceGoneError(id);
    }
    // Accurate menaruh pesan galatnya di `d` (daftar kalimat), bukan di `m`: 31 faktur September
    // gagal ditambal 26 Sep 2026 dengan pesan kosong "respons gagal", sebabnya tidak terbaca.
    if (!body?.s) {
        const pesan = [body?.m, ...(Array.isArray(body?.d) ? body.d : [body?.d])]
            .filter((bagian): bagian is string => typeof bagian === "string" && bagian.trim() !== "").join("; ");
        throw new Error(`detail.do faktur ${id}: ${redactAccurateSecrets(pesan) || `respons gagal ${redactAccurateSecrets(JSON.stringify(body)).slice(0, 300)}`}`);
    }

    const row = body.d as Record<string, unknown>;
    await SYNC_MODULES.sales_invoice.upsertPage([row]);
    if (creds.databaseId) await recordInvoiceRealization(creds.databaseId, String(id), row);

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

/** Pasangkan cabang dengan seri Faktur Penjualan miliknya; kembalikan jumlah yang terpasang. */
async function linkBranchAutoNumbers() {
    const branches = await db.select({ id: branch.id, name: branch.name }).from(branch);
    const autoNumbers = await db.select({
        id: accurateAutoNumber.id, name: accurateAutoNumber.name,
        transactionType: accurateAutoNumber.transactionType, suspended: accurateAutoNumber.suspended,
    }).from(accurateAutoNumber);
    if (branches.length === 0 || autoNumbers.length === 0) return 0;

    let linked = 0;
    for (const row of matchBranchAutoNumbers(branches, autoNumbers)) {
        await db.update(branch).set({ siAutoNumberId: row.autoNumberId }).where(eq(branch.id, row.branchId));
        if (row.autoNumberId !== null) linked += 1;
    }
    return linked;
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
    // O1: tag barang yang tak bisa dipetakan ke cabang — dicatat (log + hasil), tidak diam.
    const tagTakDikenal: TagTakDikenal = {};
    try {
        const paginator = AccuratePaginator(mod.endpoint, creds, state.lastPage ?? 1, mod.fields);
        for await (const chunk of paginator) {
            if (chunk.data.length > 0) {
                const catat = await mod.upsertPage(chunk.data);
                for (const [tag, n] of Object.entries(catat ?? {})) tagTakDikenal[tag] = (tagTakDikenal[tag] ?? 0) + n;
                totalRows += chunk.data.length;
            }
            // Checkpoint per halaman — run terputus bisa dilanjutkan.
            await db.update(syncState).set({ lastPage: chunk.page + 1, updatedAt: new Date() }).where(eq(syncState.module, moduleName));
        }

        // Pemasangan cabang <-> seri penomoran Faktur Penjualan dijalankan ulang setiap kali
        // salah satu sisinya tersegarkan, jadi cabang atau seri yang baru ditambahkan di
        // Accurate ikut terpasang tanpa langkah manual. Idempoten.
        const matched = moduleName === "branch" || moduleName === "auto_number"
            ? await linkBranchAutoNumbers()
            : 0;

        await db.update(syncState).set({
            status: "idle",
            lastPage: 1,
            lastSyncTimestamp: new Date().toISOString(),
            updatedAt: new Date(),
        }).where(eq(syncState.module, moduleName));

        const takDikenal = Object.keys(tagTakDikenal).length ? { tagTakDikenal } : {};
        if (takDikenal.tagTakDikenal) console.warn(`[sync] ${moduleName}: tag charField2 tanpa cabang -> tidak bisa diorder: ${JSON.stringify(tagTakDikenal)}`);
        return { success: true, message: `Sync ${moduleName} selesai`, rows: totalRows, durationMs: Date.now() - startedAt, ...(matched ? { branchAutoNumberLinked: matched } : {}), ...takDikenal };
    } catch (e) {
        await db.update(syncState).set({ status: "error", updatedAt: new Date() }).where(eq(syncState.module, moduleName));
        return { success: false, message: e instanceof Error ? e.message : String(e), rows: totalRows, durationMs: Date.now() - startedAt };
    }
}
