import { and, asc, eq, getTableColumns, inArray, sql, type AnyColumn } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
    jksMaster, aoControlDaily, noOrderReason,
    merchandisingCheck, salesmanDailyReport,
    spvBriefing, smControl, kontrolAuditLog, salesProfile, kunjunganLuarRute,
} from "@/db/schema";
import { cocokKodeRute } from "@/lib/order-cabang";
import { DAY_TO_HARI, NO_ORDER_REASONS, hariBaku, kunciHari, paritasMinggu } from "./constants";
import type { AoStatus, TodayRouteRow } from "./types";

// Paritas minggu = paritasMinggu (constants.ts, acuan owner 12 Okt 2026), dihitung dari string tanggal WITA yang dikirim layar.

// FK-MSM butir 2: JKS dibandingkan lewat kunci hari (huruf besar tanpa spasi/tanda) dan pola minggu huruf kecil ter-trim, sehingga JKS lama
// ("SENIN", " Senin ", "JUM'AT", "GENAP") terbaca tanpa unggah ulang. Kunci = kunciHari (constants.ts). ponytail: ekspresi tidak memakai
// indeks (principle, hari_kunjungan); baris sudah disaring sales_code + principle lewat idx_jks_sales_principle.
const kunciHariSql = sql`regexp_replace(upper(coalesce(${jksMaster.hariKunjungan}, '')), '[^A-Z]', '', 'g')`;
const hariIni = (dayName: string) => sql`${kunciHariSql} = ${kunciHari(dayName)}`;
const polaMinggu = (parity: "ganjil" | "genap") => sql`lower(trim(${jksMaster.mingguPattern})) in ('all', ${parity})`;

// FK-MSM butir 5: nama SPV/SM Hierarki dibandingkan sesudah trim + tanpa beda huruf (" spv a " = "SPV A"); nama kosong tidak cocok apa pun.
export const kunciNama = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const samaNama = (kolom: AnyColumn, nama: string) => sql`upper(trim(${kolom})) = ${kunciNama(nama)}`;

export function parseDateString(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
}

// ── JKS ─────────────────────────────────────────────────────────────────────

/**
 * FK-MSM2 butir 3: jejak baris JKS yang DITAMBAHKAN SALESMAN (konfirmasi kunjungan luar rute) — siapa, kapan, dari kunjungan tanggal berapa;
 * null = baris unggahan. Sumbernya kunjungan_luar_rute.jks_id (jks_master tidak diberi kolom baru); konfirmasi paling awal bila lebih dari satu.
 * `jks_master.id` ditulis LITERAL: di kolom select Drizzle merender ${jksMaster.id} tanpa nama tabel ("id" = k.id di subkueri).
 */
export type JejakTambahanSalesman = { oleh: string | null; pada: string; dariKunjungan: string } | null;
const jejakTambahanSalesman = sql<JejakTambahanSalesman>`(SELECT json_build_object('oleh', k.dikonfirmasi_oleh_nama, 'pada', k.dikonfirmasi_pada,
    'dariKunjungan', k.tanggal) FROM ${kunjunganLuarRute} k WHERE k.jks_id = jks_master.id AND k.konfirmasi = 'jks'
    ORDER BY k.dikonfirmasi_pada LIMIT 1)`;

export async function getJksList(filters: {
    salesCode?: string;
    /** Cakupan pemakai (FK-MSM butir 4): hanya kode sales ini; undefined = semua (admin). */
    salesCodes?: string[];
    principle?: string;
    hariKunjungan?: string;
    isActive?: boolean;
} = {}, limit = 100, offset = 0) {
    if (filters.salesCodes?.length === 0) return { rows: [], total: 0 };
    const conditions = [];
    if (filters.salesCode)     conditions.push(eq(jksMaster.salesCode, filters.salesCode));
    if (filters.salesCodes)    conditions.push(inArray(jksMaster.salesCode, filters.salesCodes));
    if (filters.principle)     conditions.push(eq(jksMaster.principle, filters.principle));
    if (filters.hariKunjungan) conditions.push(hariIni(filters.hariKunjungan));
    if (filters.isActive !== undefined) conditions.push(eq(jksMaster.isActive, filters.isActive));

    const [rows, countResult] = await Promise.all([
        db.select({ ...getTableColumns(jksMaster), tambahanSalesman: jejakTambahanSalesman }).from(jksMaster)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(asc(jksMaster.salesCode), asc(jksMaster.custCode))
            .limit(limit).offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(jksMaster)
            .where(conditions.length ? and(...conditions) : undefined),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
}

/**
 * Principal JKS AKTIF dalam cakupan (FK-MSM butir 1) — pengganti daftar principal tetap di layar. `salesCodes` null = semua (admin);
 * [] = tanpa kueri. ponytail: gabungan seluruh cakupan (tim SPV), bukan per salesman; SPV memilih principal dari gabungan timnya.
 */
export async function getJksPrinciples(salesCodes: string[] | null): Promise<string[]> {
    if (salesCodes?.length === 0) return [];
    const rows = await db.selectDistinct({ principle: jksMaster.principle }).from(jksMaster)
        .where(and(eq(jksMaster.isActive, true), salesCodes ? inArray(jksMaster.salesCode, salesCodes) : undefined))
        .orderBy(asc(jksMaster.principle));
    return rows.map((r) => r.principle).filter(Boolean);
}

/**
 * Tulis JKS per baris (kunci sales_code + cust_code + principle). Hari disimpan dalam bentuk BAKU ("SENIN"/"jum'at" → "Senin"/"Jumat");
 * hari tak dikenal (mis. "Minggu", salah ketik) → baris TIDAK ditulis dan dilaporkan di `ditolak` (indeks baris masukan, 0-based).
 * Unggah TIDAK menghapus/menonaktifkan baris yang tidak ada di berkas — termasuk baris tambahan salesman (FK-MSM2 butir 4). Satu-satunya
 * pengecualian (FK-MSM2): baris tambahan salesman berkode LENGKAP (C-1-CBA) yang tokonya ada di berkas dengan kode JKS lain yang cocok
 * (C-1, cocokKodeRute) untuk salesman + principal yang sama → baris tambahan itu DINONAKTIFKAN (tidak dihapus; jejaknya tetap) dan
 * dilaporkan di `digantikan`, supaya toko yang sama tidak dua kali di rute. Kode persis sama = baris yang sama (upsert biasa).
 */
export async function upsertJksRows(rows: {
    salesCode: string; salesName: string; custCode: string; custName: string;
    market?: string; alamat?: string; kota?: string; hariKunjungan?: string;
    mingguPattern?: string; area?: string; rayon?: string; principle: string;
    channel?: string; visitFrequency?: number;
}[]) {
    const now = new Date();
    let imported = 0, skipped = 0;
    const ditolak: { indeks: number; custCode: string; hari: string }[] = [];
    /** salesCode + principal → kode toko (huruf besar) yang ditulis berkas ini. */
    const tertulis = new Map<string, Set<string>>();
    for (const [indeks, r] of rows.entries()) {
        if (!r.salesCode || !r.custCode || !r.principle) { skipped++; continue; }
        const hari = hariBaku(r.hariKunjungan);
        if (hari === null) { ditolak.push({ indeks, custCode: String(r.custCode), hari: String(r.hariKunjungan) }); continue; }
        const polaMasuk = String(r.mingguPattern ?? "").trim().toLowerCase();
        const pattern = (["ganjil", "genap", "all"].includes(polaMasuk) ? polaMasuk : "all") as "ganjil" | "genap" | "all";
        const freq = r.visitFrequency ?? (pattern === "all" ? 4 : 2);
        await db.insert(jksMaster).values({
            id: randomUUID(), salesCode: r.salesCode, salesName: r.salesName,
            custCode: r.custCode, custName: r.custName, market: r.market ?? null,
            alamat: r.alamat ?? null, kota: r.kota ?? null,
            hariKunjungan: hari || null, mingguPattern: pattern,
            area: r.area ?? null, rayon: r.rayon ?? null, principle: r.principle,
            channel: r.channel ?? "TT", visitFrequency: freq,
            isActive: true, createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
            target: [jksMaster.salesCode, jksMaster.custCode, jksMaster.principle],
            set: {
                salesName: r.salesName, custName: r.custName, market: r.market ?? null,
                alamat: r.alamat ?? null, kota: r.kota ?? null,
                hariKunjungan: hari || null, mingguPattern: pattern,
                area: r.area ?? null, rayon: r.rayon ?? null, channel: r.channel ?? "TT",
                visitFrequency: freq, isActive: true, updatedAt: now,
            },
        });
        imported++;
        const k = `${r.salesCode}\u0000${r.principle}`;
        tertulis.set(k, (tertulis.get(k) ?? new Set()).add(String(r.custCode).trim().toUpperCase()));
    }
    const digantikan: { salesCode: string; principle: string; custCode: string; custName: string; kodeBerkas: string }[] = [];
    for (const [k, kode] of tertulis) {
        const [salesCode, principle] = k.split("\u0000");
        const tambahan = await db.select({ id: jksMaster.id, custCode: jksMaster.custCode, custName: jksMaster.custName }).from(jksMaster)
            .where(and(eq(jksMaster.salesCode, salesCode), eq(jksMaster.principle, principle), eq(jksMaster.isActive, true),
                sql`EXISTS (SELECT 1 FROM ${kunjunganLuarRute} k WHERE k.jks_id = jks_master.id AND k.konfirmasi = 'jks')`));
        for (const t of tambahan) {
            if (kode.has(t.custCode.trim().toUpperCase())) continue;
            const kodeBerkas = [...kode].find((u) => cocokKodeRute(u, t.custCode));
            if (!kodeBerkas) continue;
            await db.update(jksMaster).set({ isActive: false, updatedAt: now }).where(eq(jksMaster.id, t.id));
            digantikan.push({ salesCode, principle, custCode: t.custCode, custName: t.custName, kodeBerkas });
        }
    }
    return { imported, skipped, ditolak, digantikan };
}

// ── Today's route with AO status ──────────────────────────────────────────

/**
 * Rute tanggal itu = toko JKS (hari + pola minggu) DITAMBAH kunjungan luar rute salesman tanggal itu (FK-MSM2, `luarRute: true`; juga pada
 * salesman tanpa JKS dan hari tanpa jadwal). Baris luar rute berkode persis sama dengan toko JKS hari itu tidak diulang.
 */
export async function getTodayRoute(salesCode: string, principle: string, dateStr: string): Promise<TodayRouteRow[]> {
    const date = parseDateString(dateStr);
    const dayName = DAY_TO_HARI[date.getDay()];
    const parity = paritasMinggu(dateStr);

    const [jksDb, luar] = await Promise.all([
        dayName ? db.select().from(jksMaster).where(
            and(
                eq(jksMaster.salesCode, salesCode),
                eq(jksMaster.principle, principle),
                hariIni(dayName),
                polaMinggu(parity),
                eq(jksMaster.isActive, true),
            )
        ) : Promise.resolve([]),
        db.select().from(kunjunganLuarRute).where(and(eq(kunjunganLuarRute.salesCode, salesCode),
            eq(kunjunganLuarRute.principle, principle), eq(kunjunganLuarRute.tanggal, dateStr))).orderBy(asc(kunjunganLuarRute.custName)),
    ]);
    const kodeJks = new Set(jksDb.map((j) => j.custCode));
    const jksRows: (typeof jksDb[number] & { luarRute?: boolean })[] = [...jksDb, ...luar.filter((l) => !kodeJks.has(l.custCode)).map((l) => ({
        id: l.id, salesCode: l.salesCode, salesName: "", custCode: l.custCode, custName: l.custName, market: null, alamat: l.alamat, kota: null,
        hariKunjungan: null, mingguPattern: "all", area: null, rayon: null, principle: l.principle, channel: "", visitFrequency: 0,
        isActive: true, createdAt: l.dibuatPada, updatedAt: l.dibuatPada, luarRute: true,
    }))];

    if (jksRows.length === 0) return [];

    const custCodes = jksRows.map(r => r.custCode);
    const aoRows = await db.select().from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.date, dateStr),
            inArray(aoControlDaily.custCode, custCodes),
        )
    );

    const aoMap = new Map(aoRows.map(r => [r.custCode, r]));

    // Monthly order counts for each store
    const monthlyAo = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, date.getMonth() + 1),
            eq(aoControlDaily.periodYear, date.getFullYear()),
            inArray(aoControlDaily.status, ["ordered", "active"]),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);
    const monthlyMap = new Map(monthlyAo.map(r => [r.custCode, r.count]));

    // Stores not_order >= 2 times this month need attention
    const notOrderCounts = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, date.getMonth() + 1),
            eq(aoControlDaily.periodYear, date.getFullYear()),
            eq(aoControlDaily.status, "not_order"),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);
    const attentionSet = new Set(notOrderCounts.filter(r => r.count >= 2).map(r => r.custCode));

    return jksRows.map(j => {
        const ao = aoMap.get(j.custCode);
        return {
            ...j,
            mingguPattern: j.mingguPattern as "ganjil" | "genap" | "all",
            aoStatus: (ao?.status as AoStatus | undefined) ?? null,
            noOrderReasonCode: ao?.noOrderReasonCode ?? null,
            noOrderNote: ao?.noOrderNote ?? null,
            isVisited: ao?.isVisited ?? null,
            checkinAt: ao?.checkinAt ?? null,
            checkinPhotoUrl: ao?.checkinPhotoUrl ?? null,
            checkoutAt: ao?.checkoutAt ?? null,
            checkoutPhotoUrl: ao?.checkoutPhotoUrl ?? null,
            monthlyOrderCount: monthlyMap.get(j.custCode) ?? 0,
            needsAttention: attentionSet.has(j.custCode),
            luarRute: j.luarRute === true,
        };
    });
}

// ── AO Control ───────────────────────────────────────────────────────────────

export async function upsertAoControl(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    status: AoStatus; isVisited?: boolean; noOrderReasonCode?: string | null;
    noOrderNote?: string | null; createdBy?: string;
}) {
    const now = new Date();
    const [, m, y] = data.date.split("-").map(Number);
    const [yearStr] = data.date.split("-");
    const periodYear = parseInt(yearStr, 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);

    const existing = await db.select({ id: aoControlDaily.id })
        .from(aoControlDaily)
        .where(and(
            eq(aoControlDaily.salesCode, data.salesCode),
            eq(aoControlDaily.custCode, data.custCode),
            eq(aoControlDaily.principle, data.principle),
            eq(aoControlDaily.date, data.date),
        )).limit(1);

    if (existing.length > 0) {
        await db.update(aoControlDaily).set({
            status: data.status,
            isVisited: data.isVisited ?? null,
            noOrderReasonCode: data.noOrderReasonCode ?? null,
            noOrderNote: data.noOrderNote ?? null,
            updatedAt: now,
        }).where(eq(aoControlDaily.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(aoControlDaily).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        periodMonth, periodYear,
        status: data.status, isVisited: data.isVisited ?? null,
        noOrderReasonCode: data.noOrderReasonCode ?? null,
        noOrderNote: data.noOrderNote ?? null,
        autoMatched: false, source: "manual",
        createdBy: data.createdBy ?? null,
        createdAt: now, updatedAt: now,
    });
    return id;
    void m; void y;
}

export async function getAoForDate(salesCode: string, principle: string, dateStr: string) {
    return db.select().from(aoControlDaily).where(
        and(
            salesCode ? eq(aoControlDaily.salesCode, salesCode) : undefined,
            principle ? eq(aoControlDaily.principle, principle) : undefined,
            eq(aoControlDaily.date, dateStr),
        )
    );
}

// ── Reasons ──────────────────────────────────────────────────────────────────

// ponytail: kode di NO_ORDER_REASONS yang belum ada barisnya di DB (mis. R15 Toko tutup) ikut
// tampil tanpa migrasi data; baris DB (termasuk yang dinonaktifkan) tetap menang.
export async function getReasons() {
    const rows = await db.select().from(noOrderReason).orderBy(asc(noOrderReason.sortOrder));
    const inDb = new Set(rows.map((r) => r.reasonCode));
    return [...rows.filter((r) => r.isActive), ...NO_ORDER_REASONS.filter((r) => !inDb.has(r.reasonCode))]
        .sort((a, b) => a.sortOrder - b.sortOrder);
}

// ── Merchandising ─────────────────────────────────────────────────────────────

export async function saveMerchandising(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    produkJelas: boolean; displayRapi: boolean; dibersihkan: boolean;
    ditataulang: boolean; posisiMudah: boolean; semuaSku: boolean;
    photoUrl?: string | null; stepPhotos?: Record<string, string> | null; note?: string | null;
}) {
    const existing = await db.select({ id: merchandisingCheck.id })
        .from(merchandisingCheck)
        .where(and(
            eq(merchandisingCheck.salesCode, data.salesCode),
            eq(merchandisingCheck.custCode, data.custCode),
            eq(merchandisingCheck.principle, data.principle),
            eq(merchandisingCheck.date, data.date),
        )).limit(1);

    const values = {
        produkJelas: data.produkJelas, displayRapi: data.displayRapi,
        dibersihkan: data.dibersihkan, ditataulang: data.ditataulang,
        posisiMudah: data.posisiMudah, semuaSku: data.semuaSku,
        photoUrl: data.photoUrl ?? null,
        stepPhotos: data.stepPhotos ?? null,
        note: data.note ?? null,
    };

    if (existing.length > 0) {
        await db.update(merchandisingCheck).set(values)
            .where(eq(merchandisingCheck.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(merchandisingCheck).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        ...values, createdAt: new Date(),
    });
    return id;
}

export async function getMerchandisingForDate(salesCode: string, principle: string, dateStr: string) {
    return db.select().from(merchandisingCheck).where(
        and(
            eq(merchandisingCheck.salesCode, salesCode),
            eq(merchandisingCheck.principle, principle),
            eq(merchandisingCheck.date, dateStr),
        )
    );
}

// ── Salesman Daily Report ────────────────────────────────────────────────────

// ponytail: satu sumber agregat — dipakai saveReport (persist) & getReport (preview live).
// totalActive = jumlah toko berstatus "priority".
async function computeReportSummary(salesCode: string, dateStr: string) {
    const aoRows = await db.select().from(aoControlDaily).where(
        and(eq(aoControlDaily.salesCode, salesCode), eq(aoControlDaily.date, dateStr))
    );

    const totalOrder      = aoRows.filter(r => r.status === "ordered" || r.status === "active").length;
    const totalNotOrder   = aoRows.filter(r => r.status === "not_order").length;
    const totalNotVisited = aoRows.filter(r => r.status === "not_visited").length;
    const totalActive     = aoRows.filter(r => r.status === "priority").length;

    const reasonSummary: Record<string, number> = {};
    for (const r of aoRows) {
        if (r.noOrderReasonCode) reasonSummary[r.noOrderReasonCode] = (reasonSummary[r.noOrderReasonCode] ?? 0) + 1;
    }

    const date = parseDateString(dateStr);
    const dayName = DAY_TO_HARI[date.getDay()];
    let totalTokoJks = aoRows.length;
    if (dayName) {
        const parity = paritasMinggu(dateStr);
        const cnt = await db.select({ count: sql<number>`count(*)` }).from(jksMaster).where(
            and(
                eq(jksMaster.salesCode, salesCode),
                hariIni(dayName),
                polaMinggu(parity),
                eq(jksMaster.isActive, true),
            )
        );
        totalTokoJks = cnt[0]?.count ?? aoRows.length;
    }

    return { totalTokoJks, totalOrder, totalActive, totalNotOrder, totalNotVisited, reasonSummary };
}

export async function saveReport(data: {
    salesCode: string; date: string; tindakLanjut: string;
}) {
    const periodYear = parseInt(data.date.split("-")[0], 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);
    const now = new Date();

    const { totalTokoJks, totalOrder, totalActive, totalNotOrder, totalNotVisited, reasonSummary } =
        await computeReportSummary(data.salesCode, data.date);

    const existing = await db.select({ id: salesmanDailyReport.id })
        .from(salesmanDailyReport)
        .where(and(eq(salesmanDailyReport.salesCode, data.salesCode), eq(salesmanDailyReport.date, data.date)))
        .limit(1);

    if (existing.length > 0) {
        await db.update(salesmanDailyReport).set({
            totalTokoJks, totalOrder, totalActive,
            totalNotOrder, totalNotVisited,
            reasonSummary, tindakLanjut: data.tindakLanjut, submittedAt: now,
        }).where(eq(salesmanDailyReport.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(salesmanDailyReport).values({
        id, salesCode: data.salesCode, date: data.date,
        periodMonth, periodYear,
        totalTokoJks, totalOrder, totalActive,
        totalNotOrder, totalNotVisited,
        reasonSummary, tindakLanjut: data.tindakLanjut, submittedAt: now,
    });
    return id;
}

export async function getReport(salesCode: string, dateStr: string) {
    const saved = await db.select().from(salesmanDailyReport).where(
        and(eq(salesmanDailyReport.salesCode, salesCode), eq(salesmanDailyReport.date, dateStr))
    ).limit(1);
    if (saved.length > 0) return saved;

    // ponytail: belum submit → kirim angka LIVE dari AO (submittedAt:null) biar salesman & SPV
    // lihat progres tanpa nunggu salesman klik submit. Baris sintetis, tidak dipersist.
    const live = await computeReportSummary(salesCode, dateStr);
    return [{
        id: null, salesCode, date: dateStr,
        periodMonth: parseInt(dateStr.split("-")[1], 10),
        periodYear: parseInt(dateStr.split("-")[0], 10),
        ...live,
        tindakLanjut: "", submittedAt: null,
        spvAck: false, spvAckBy: null, spvAckAt: null,
    }];
}

// SPV acknowledge laporan harian salesman. Non-admin: hanya boleh ack anak buahnya
// (salesProfile.spvName/smName == nama supervisor). Return null jika tak berhak / report belum ada.
// ack=false (S5-4a) = batalkan tanda dibaca; cakupan sama. Jejak siapa/kapan (beserta nilai sebelumnya)
// ditulis ke kontrol_audit_log dalam transaksi yang sama (kolom spvAckBy/At ikut dikosongkan saat batal).
export async function acknowledgeReport(data: {
    salesCode: string; date: string; ackBy: string;
    supervisorName?: string | null; isAdmin: boolean; ack?: boolean;
    actorId: string; actorName: string | null;
}): Promise<boolean> {
    if (!data.isAdmin) {
        const prof = await db.select({ spvName: salesProfile.spvName, smName: salesProfile.smName })
            .from(salesProfile).where(eq(salesProfile.salesCode, data.salesCode)).limit(1);
        const p = prof[0];
        const saya = kunciNama(data.supervisorName);
        if (!p || !saya || (kunciNama(p.spvName) !== saya && kunciNama(p.smName) !== saya)) return false;
    }
    const existing = await db.select({ id: salesmanDailyReport.id, spvAckBy: salesmanDailyReport.spvAckBy, spvAckAt: salesmanDailyReport.spvAckAt })
        .from(salesmanDailyReport)
        .where(and(eq(salesmanDailyReport.salesCode, data.salesCode), eq(salesmanDailyReport.date, data.date))).limit(1);
    if (existing.length === 0) return false; // laporan belum disubmit
    const ack = data.ack !== false;
    const prev = existing[0];
    const now = new Date();
    await db.transaction(async (tx) => {
        await tx.update(salesmanDailyReport)
            .set(ack ? { spvAck: true, spvAckBy: data.ackBy, spvAckAt: now } : { spvAck: false, spvAckBy: null, spvAckAt: null })
            .where(eq(salesmanDailyReport.id, prev.id));
        await tx.insert(kontrolAuditLog).values({
            id: randomUUID(), entity: "report", entityId: prev.id, action: ack ? "ack" : "ack_cancel",
            actorId: data.actorId, actorName: data.actorName,
            payload: { salesCode: data.salesCode, date: data.date, prevAckBy: prev.spvAckBy, prevAckAt: prev.spvAckAt },
            createdAt: now,
        });
    });
    return true;
}

// ── Briefing ─────────────────────────────────────────────────────────────────

export async function saveBriefing(data: {
    spvName: string; date: string; session: "pagi" | "sore";
    agenda?: unknown; tokoDialas?: unknown; penyebab?: string; solusi?: string;
    createdBy?: string;
}) {
    const id = randomUUID();
    await db.insert(spvBriefing).values({
        id, spvName: data.spvName.trim(), date: data.date, session: data.session,
        agenda: data.agenda ?? null, tokoDialas: data.tokoDialas ?? null,
        penyebab: data.penyebab ?? null, solusi: data.solusi ?? null,
        createdBy: data.createdBy ?? null, createdAt: new Date(),
    });
    return id;
}

export async function getBriefings(spvName: string, dateStr: string) {
    if (!kunciNama(spvName)) return [];
    return db.select().from(spvBriefing).where(
        and(samaNama(spvBriefing.spvName, spvName), eq(spvBriefing.date, dateStr))
    );
}

// Semua salesCode di bawah satu SPV — untuk RBAC scope SPV.
export async function getSalesCodesForSpv(spvName: string): Promise<string[]> {
    if (!kunciNama(spvName)) return [];
    const rows = await db.select({ salesCode: salesProfile.salesCode })
        .from(salesProfile).where(samaNama(salesProfile.spvName, spvName));
    return rows.map(r => r.salesCode).filter(Boolean) as string[];
}

// Semua salesCode di bawah satu SM — untuk RBAC scope SM.
export async function getSalesCodesForSm(smName: string): Promise<string[]> {
    if (!kunciNama(smName)) return [];
    const rows = await db.select({ salesCode: salesProfile.salesCode })
        .from(salesProfile).where(samaNama(salesProfile.smName, smName));
    return rows.map(r => r.salesCode).filter(Boolean) as string[];
}

// SPV di bawah satu SM + briefing mereka hari itu — untuk Kontrol SM (ganti hardcode).
/** Nama SPV (unik menurut trim + tanpa beda huruf; tampil = ejaan pertama ter-trim) di bawah satu SM. */
export async function getSpvNamesForSm(smName: string): Promise<string[]> {
    if (!kunciNama(smName)) return [];
    const profiles = await db.select({ spvName: salesProfile.spvName })
        .from(salesProfile).where(samaNama(salesProfile.smName, smName)).orderBy(asc(salesProfile.salesCode));
    const unik = new Map<string, string>();
    for (const p of profiles) { const k = kunciNama(p.spvName); if (k && !unik.has(k)) unik.set(k, p.spvName!.trim()); }
    return [...unik.values()];
}

export async function getSmSpvBriefings(smName: string, dateStr: string) {
    const spvNames = await getSpvNamesForSm(smName);
    if (spvNames.length === 0) return [];
    // KC2: cocok trim + tanpa beda huruf, satu baris per SPV (" spv a " dan "SPV A" = satu).
    const briefings = await db.select().from(spvBriefing).where(
        and(eq(spvBriefing.date, dateStr), inArray(sql`upper(trim(${spvBriefing.spvName}))`, spvNames.map(kunciNama)))
    );
    return spvNames.map(name => ({
        spvName: name,
        briefings: briefings.filter(b => kunciNama(b.spvName) === kunciNama(name)).map(b => ({
            session: b.session, penyebab: b.penyebab ?? null, solusi: b.solusi ?? null,
        })),
    }));
}

// ── SM Control ────────────────────────────────────────────────────────────────

export async function saveSmControl(data: {
    smName: string; date: string; spvChecked?: unknown;
    jksChecked?: boolean; fotoChecked?: boolean;
    coachingNote?: string; deviations?: unknown; followUp?: string; createdBy?: string;
}) {
    const id = randomUUID();
    await db.insert(smControl).values({
        id, smName: data.smName.trim(), date: data.date,
        spvChecked: data.spvChecked ?? null,
        jksChecked: data.jksChecked ?? false,
        fotoChecked: data.fotoChecked ?? false,
        coachingNote: data.coachingNote ?? null,
        deviations: data.deviations ?? null,
        followUp: data.followUp ?? null,
        createdBy: data.createdBy ?? null,
        createdAt: new Date(),
    });
    return id;
}

export async function getSmControl(smName: string, dateStr: string) {
    if (!kunciNama(smName)) return [];
    return db.select().from(smControl).where(
        and(samaNama(smControl.smName, smName), eq(smControl.date, dateStr))
    ).limit(1);
}

// ── Frequency ────────────────────────────────────────────────────────────────

export async function getFrequencyData(salesCode: string, principle: string, periodMonth: number, periodYear: number) {
    const jksRows = await db.select().from(jksMaster).where(
        and(
            eq(jksMaster.salesCode, salesCode),
            eq(jksMaster.principle, principle),
            eq(jksMaster.isActive, true),
        )
    );

    if (jksRows.length === 0) return { rows: [], simulation: null };

    const custCodes = jksRows.map(r => r.custCode);
    const aoRows = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, periodMonth),
            eq(aoControlDaily.periodYear, periodYear),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);

    const visitMap = new Map(aoRows.map(r => [r.custCode, r.count]));

    const rows = jksRows.map(j => ({
        ...j,
        actualVisits: visitMap.get(j.custCode) ?? 0,
        overVisit: (visitMap.get(j.custCode) ?? 0) > j.visitFrequency,
    }));

    const WORK_DAYS = 24, VISITS_PER_DAY = 20;
    const totalSlots = WORK_DAYS * VISITS_PER_DAY;
    const simulation = {
        workDays: WORK_DAYS, visitsPerDay: VISITS_PER_DAY, totalSlots,
        capacity1x: totalSlots,
        capacity2x: Math.floor(totalSlots / 2),
        capacity4x: Math.floor(totalSlots / 4),
    };

    return { rows, simulation };
}

// ── Scope ─────────────────────────────────────────────────────────────────────

export async function getScopeForUser(userId: string) {
    const profile = await db.select().from(salesProfile)
        .where(eq(salesProfile.userId, userId)).limit(1);
    return profile[0] ?? null;
}

export async function getAllSalesProfiles() {
    return db.select().from(salesProfile).orderBy(asc(salesProfile.salesName));
}

export async function updateSalesHierarchy(salesCode: string, spvName: string | null, smName: string | null) {
    // Disimpan ter-trim (butir 5); isian bukan teks/kosong = null.
    const bersih = (v: unknown) => (typeof v === "string" ? v.trim() : "") || null;
    await db.update(salesProfile)
        .set({ spvName: bersih(spvName), smName: bersih(smName), updatedAt: new Date() })
        .where(eq(salesProfile.salesCode, salesCode));
}

// ── Check-in / Check-out ──────────────────────────────────────────────────────

// ponytail: heuristik fake-GPS sederhana, FLAG saja (tidak memblok kunjungan).
// accuracy>1000m terdeteksi sekarang. Jarak-dari-toko & GPS-vs-IP butuh koordinat toko / lookup IP
// yang belum tersedia — tambah kalau jksMaster sudah punya lat/lng atau ada provider IP geo.
function computeGpsFlag(lat: number | null, lng: number | null, accuracy: number | null): string | null {
    const flags: string[] = [];
    if (lat === null || lng === null) flags.push("tanpa_lokasi");
    if (accuracy !== null && accuracy > 1000) flags.push("akurasi_rendah");
    return flags.length ? flags.join(",") : null;
}

export async function saveCheckin(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    photoUrl: string; createdBy?: string;
    lat?: number | null; lng?: number | null; accuracy?: number | null;
}) {
    const now = new Date();
    const periodYear = parseInt(data.date.split("-")[0], 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);
    const lat = data.lat ?? null, lng = data.lng ?? null, accuracy = data.accuracy ?? null;
    const gpsFlag = computeGpsFlag(lat, lng, accuracy);

    const existing = await db.select({ id: aoControlDaily.id })
        .from(aoControlDaily)
        .where(and(
            eq(aoControlDaily.salesCode, data.salesCode),
            eq(aoControlDaily.custCode, data.custCode),
            eq(aoControlDaily.principle, data.principle),
            eq(aoControlDaily.date, data.date),
        )).limit(1);

    if (existing.length > 0) {
        await db.update(aoControlDaily).set({
            checkinAt: now, checkinPhotoUrl: data.photoUrl,
            checkinLat: lat, checkinLng: lng, checkinAccuracy: accuracy, gpsFlag,
            isVisited: true, updatedAt: now,
        }).where(eq(aoControlDaily.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(aoControlDaily).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        periodMonth, periodYear,
        status: "not_visited", isVisited: true,
        checkinAt: now, checkinPhotoUrl: data.photoUrl,
        checkinLat: lat, checkinLng: lng, checkinAccuracy: accuracy, gpsFlag,
        noOrderReasonCode: null, noOrderNote: null,
        checkoutAt: null, checkoutPhotoUrl: null,
        autoMatched: false, source: "manual",
        createdBy: data.createdBy ?? null, createdAt: now, updatedAt: now,
    });
    return id;
}

export async function saveCheckout(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    photoUrl: string;
}) {
    const now = new Date();
    await db.update(aoControlDaily).set({
        checkoutAt: now, checkoutPhotoUrl: data.photoUrl, updatedAt: now,
    }).where(and(
        eq(aoControlDaily.salesCode, data.salesCode),
        eq(aoControlDaily.custCode, data.custCode),
        eq(aoControlDaily.principle, data.principle),
        eq(aoControlDaily.date, data.date),
    ));
}

// ── Visit detail ──────────────────────────────────────────────────────────────

export async function getVisitDetail(
    salesCode: string, custCode: string, principle: string, dateStr: string
) {
    const [storeRows, aoRows, merchRows] = await Promise.all([
        db.select().from(jksMaster).where(
            and(
                eq(jksMaster.salesCode, salesCode),
                eq(jksMaster.custCode, custCode),
                eq(jksMaster.principle, principle),
            )
        ).limit(1),
        db.select().from(aoControlDaily).where(
            and(
                eq(aoControlDaily.salesCode, salesCode),
                eq(aoControlDaily.custCode, custCode),
                eq(aoControlDaily.principle, principle),
                eq(aoControlDaily.date, dateStr),
            )
        ).limit(1),
        db.select().from(merchandisingCheck).where(
            and(
                eq(merchandisingCheck.salesCode, salesCode),
                eq(merchandisingCheck.custCode, custCode),
                eq(merchandisingCheck.principle, principle),
                eq(merchandisingCheck.date, dateStr),
            )
        ).limit(1),
    ]);

    let store: (typeof storeRows[number] & { luarRute?: boolean }) | undefined = storeRows[0];
    if (!store) {
        // FK-MSM2: toko tidak di JKS → kunjungan luar rute salesman ini pada TANGGAL itu (tanpa baris luar rute = tetap "tidak ditemukan").
        const [l] = await db.select({ k: kunjunganLuarRute, salesName: salesProfile.salesName }).from(kunjunganLuarRute)
            .leftJoin(salesProfile, eq(salesProfile.salesCode, kunjunganLuarRute.salesCode))
            .where(and(eq(kunjunganLuarRute.salesCode, salesCode), eq(kunjunganLuarRute.custCode, custCode),
                eq(kunjunganLuarRute.principle, principle), eq(kunjunganLuarRute.tanggal, dateStr))).limit(1);
        if (l) store = { id: l.k.id, salesCode, salesName: l.salesName ?? "", custCode, custName: l.k.custName, market: null, alamat: l.k.alamat,
            kota: null, hariKunjungan: null, mingguPattern: "all", area: null, rayon: null, principle, channel: "", visitFrequency: 0, isActive: true,
            createdAt: l.k.dibuatPada, updatedAt: l.k.dibuatPada, luarRute: true };
    }
    if (!store) return null;
    return {
        store,
        ao: aoRows[0] ?? null,
        merch: merchRows[0] ?? null,
    };
}

// ── SPV Dashboard ─────────────────────────────────────────────────────────────

export async function getSpvDashboard(spvName: string, dateStr: string) {
    if (!kunciNama(spvName)) return [];
    const profiles = await db.select().from(salesProfile)
        .where(samaNama(salesProfile.spvName, spvName));

    if (profiles.length === 0) return [];

    const salesCodes = profiles.map(p => p.salesCode);
    const periodYear  = parseInt(dateStr.split("-")[0], 10);
    const periodMonth = parseInt(dateStr.split("-")[1], 10);

    const [aoRows, reportRows, jksRows, merchRows, luarRows] = await Promise.all([
        db.select({
            salesCode: aoControlDaily.salesCode,
            custCode: aoControlDaily.custCode,
            status: aoControlDaily.status,
            checkinAt: aoControlDaily.checkinAt,
            checkoutAt: aoControlDaily.checkoutAt,
            gpsFlag: aoControlDaily.gpsFlag,
            checkinPhotoUrl: aoControlDaily.checkinPhotoUrl,
            checkoutPhotoUrl: aoControlDaily.checkoutPhotoUrl,
        }).from(aoControlDaily).where(
            and(
                eq(aoControlDaily.date, dateStr),
                inArray(aoControlDaily.salesCode, salesCodes),
            )
        ),
        db.select().from(salesmanDailyReport).where(
            and(
                eq(salesmanDailyReport.date, dateStr),
                inArray(salesmanDailyReport.salesCode, salesCodes),
            )
        ),
        db.select({ custCode: jksMaster.custCode, custName: jksMaster.custName })
            .from(jksMaster).where(inArray(jksMaster.salesCode, salesCodes)),
        db.select().from(merchandisingCheck).where(
            and(
                eq(merchandisingCheck.date, dateStr),
                inArray(merchandisingCheck.salesCode, salesCodes),
            )
        ),
        db.select({ salesCode: kunjunganLuarRute.salesCode, custCode: kunjunganLuarRute.custCode, custName: kunjunganLuarRute.custName })
            .from(kunjunganLuarRute).where(and(eq(kunjunganLuarRute.tanggal, dateStr), inArray(kunjunganLuarRute.salesCode, salesCodes))),
    ]);

    const reportMap = new Map(reportRows.map(r => [r.salesCode, r]));
    const custNameMap = new Map([...luarRows, ...jksRows].map(j => [j.custCode, j.custName]));
    // FK-MSM2: kunjungan luar rute ditandai di detail kunjungan SPV.
    const luarSet = new Set(luarRows.map((l) => `${l.salesCode}|${l.custCode}`));
    // merch per toko per sales: hitung 6 item + simpan stepPhotos untuk dilihat SPV
    const merchMap = new Map(merchRows.map(m => [`${m.salesCode}|${m.custCode}`, m]));

    return profiles.map(p => {
        const rows = aoRows.filter(r => r.salesCode === p.salesCode);
        const report = reportMap.get(p.salesCode);
        const totalRoute = rows.length;

        // Also count JKS total for today
        const ordered    = rows.filter(r => r.status === "ordered" || r.status === "active").length;
        const notOrder   = rows.filter(r => r.status === "not_order").length;
        const notVisited = rows.filter(r => r.status === "not_visited").length;
        const checkedIn  = rows.filter(r => r.checkinAt !== null).length;
        const checkedOut = rows.filter(r => r.checkoutAt !== null).length;

        // P4/P5: durasi per toko (on-the-fly, tanpa kolom baru) + flag durasi & GPS untuk review SPV.
        const visits = rows
            .filter(r => r.checkinAt !== null)
            .map(r => {
                const ci = r.checkinAt ? r.checkinAt.getTime() : null;
                const co = r.checkoutAt ? r.checkoutAt.getTime() : null;
                const durationMinutes = (ci !== null && co !== null) ? Math.max(0, Math.round((co - ci) / 60000)) : null;
                const durFlag = durationMinutes === null ? null
                    : durationMinutes < 5 ? "durasi_singkat"
                    : durationMinutes > 120 ? "durasi_lama" : null;
                const m = merchMap.get(`${p.salesCode}|${r.custCode}`);
                const merchDone = m
                    ? [m.produkJelas, m.displayRapi, m.dibersihkan, m.ditataulang, m.posisiMudah, m.semuaSku].filter(Boolean).length
                    : 0;
                return {
                    custCode: r.custCode,
                    custName: custNameMap.get(r.custCode) ?? r.custCode,
                    luarRute: luarSet.has(`${p.salesCode}|${r.custCode}`),
                    status: r.status,
                    checkinAt: r.checkinAt ? r.checkinAt.toISOString() : null,
                    checkoutAt: r.checkoutAt ? r.checkoutAt.toISOString() : null,
                    durationMinutes,
                    gpsFlag: r.gpsFlag ?? null,
                    durFlag,
                    checkinPhotoUrl: r.checkinPhotoUrl ?? null,
                    checkoutPhotoUrl: r.checkoutPhotoUrl ?? null,
                    merchDone,
                    merchTotal: 6,
                    merchStepPhotos: (m?.stepPhotos as Record<string, string> | null) ?? null,
                };
            })
            .sort((a, b) => (a.checkinAt ?? "").localeCompare(b.checkinAt ?? ""));

        const totalFieldMinutes = visits.reduce((a, v) => a + (v.durationMinutes ?? 0), 0);

        return {
            salesCode: p.salesCode,
            salesName: p.salesName,
            totalRoute,
            ordered,
            notOrder,
            notVisited,
            checkedIn,
            checkedOut,
            submittedAt: report?.submittedAt ?? null,
            tindakLanjut: report?.tindakLanjut ?? null,
            spvAck: report?.spvAck ?? false,
            spvAckAt: report?.spvAckAt ? report.spvAckAt.toISOString() : null,
            visits,
            totalFieldMinutes,
            // Additional month context
            periodMonth,
            periodYear,
        };
    });
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeKontrolAudit(
    entity: string, entityId: string, action: string,
    actorId: string | null, actorName: string | null, payload?: unknown
) {
    await db.insert(kontrolAuditLog).values({
        id: randomUUID(), entity, entityId, action,
        actorId, actorName, payload: payload ?? null,
        createdAt: new Date(),
    });
}
