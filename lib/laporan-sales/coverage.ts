/*
 * Tujuan: Laporan Sales — tab "Coverage Ganda" (padanan EskaLink Compare/Double Coverage): toko JKS aktif yang dilayani > 1 salesman
 *   untuk principal yang sama, lengkap dengan hari + pola minggu tiap salesman. Kontrak: lib/laporan-sales/kontrak.ts (JawabanCoverage).
 * Caller: app/api/laporan-sales/coverage/route.ts (GET).
 * Dependensi: lib/db, db/schema (jks_master), lib/form-kontrol/scope (UserScope, tipe saja), ./kontrak (tipe jawaban).
 * Main Functions: susunCoverage (MURNI: pengelompokan + normalisasi + cakupan), muatCoverage (satu kueri baris JKS aktif -> susunCoverage).
 * Side Effects: Tidak ada (baca saja).
 *
 * Aturan:
 * - Ganda = (cust_code, principle) dengan > 1 sales_code BERBEDA. Kode dibandingkan dengan trim + huruf besar ("c-1 " = "C-1");
 *   satu salesman dengan dua baris JKS untuk toko yang sama (hari berbeda / beda huruf) BUKAN ganda — barisnya digabung.
 * - Cakupan: global = semua. Non-global = kelompok yang SALAH SATU salesman-nya ada di allowedSalesCodes; kelompok itu tampil UTUH
 *   (semua salesman, juga yang di luar cakupan) supaya SPV tahu bentrok dengan siapa. Kelompok tanpa salesman dalam cakupan disembunyikan.
 *   Karena itu pengelompokan memakai SEMUA baris JKS aktif, bukan hanya baris cakupan (kalau tidak, bentrok dengan salesman luar tak terlihat).
 * - totalToko = COUNT DISTINCT cust_code JKS aktif dalam cakupan (toko yang punya baris salesman cakupan), dibatasi principal bila dipilih.
 *   pilihanPrincipal = principal JKS aktif dalam cakupan (tidak ikut menyempit oleh pilihan principal).
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jksMaster } from "@/db/schema";
import type { UserScope } from "@/lib/form-kontrol/scope";
import type { BarisCoverage, JawabanCoverage, SalesmanCoverage } from "./kontrak";

export type BarisJks = {
    salesCode: string; salesName: string; custCode: string; custName: string; principle: string;
    hariKunjungan: string | null; mingguPattern: string | null;
};

/** Kode baku untuk membandingkan: trim + huruf besar. */
export const kodeBaku = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const urut = (a: string, b: string) => a.localeCompare(b, "id");
/** Nilai tak kosong, ter-trim, tanpa duplikat (huruf besar/kecil dianggap sama; yang pertama dipertahankan), urutan kemunculan. */
const unik = (xs: (string | null | undefined)[]) => {
    const m = new Map<string, string>();
    for (const x of xs) { const t = (x ?? "").trim(); if (t && !m.has(t.toLowerCase())) m.set(t.toLowerCase(), t); }
    return [...m.values()];
};

/**
 * Murni. `rows` = SEMUA baris JKS aktif; `allowedSalesCodes` null = global; `principle` null/"" = semua principal.
 * Urutan baris: principal, nama toko, kode toko; salesman per kelompok: kode salesman.
 */
export function susunCoverage(rows: BarisJks[], allowedSalesCodes: string[] | null, principle: string | null): JawabanCoverage {
    const boleh = allowedSalesCodes === null ? null : new Set(allowedSalesCodes.map(kodeBaku));
    const dalamCakupan = (r: BarisJks) => boleh === null || boleh.has(kodeBaku(r.salesCode));
    const pilih = kodeBaku(principle);

    const kelompok = new Map<string, BarisJks[]>();
    const tokoCakupan = new Set<string>();
    const principalCakupan = new Set<string>();
    for (const r of rows) {
        if (dalamCakupan(r)) {
            principalCakupan.add(kodeBaku(r.principle));
            if (!pilih || kodeBaku(r.principle) === pilih) tokoCakupan.add(kodeBaku(r.custCode));
        }
        if (pilih && kodeBaku(r.principle) !== pilih) continue;
        const kunci = `${kodeBaku(r.custCode)}\u0000${kodeBaku(r.principle)}`;
        kelompok.set(kunci, [...(kelompok.get(kunci) ?? []), r]);
    }

    const baris: BarisCoverage[] = [];
    for (const anggota of kelompok.values()) {
        const perSales = new Map<string, BarisJks[]>();
        for (const r of anggota) perSales.set(kodeBaku(r.salesCode), [...(perSales.get(kodeBaku(r.salesCode)) ?? []), r]);
        if (perSales.size < 2 || !anggota.some(dalamCakupan)) continue;
        const salesman: SalesmanCoverage[] = [...perSales.entries()].sort(([a], [b]) => urut(a, b)).map(([salesCode, rs]) => ({
            salesCode, salesNama: unik(rs.map((r) => r.salesName))[0] ?? salesCode,
            hari: unik(rs.map((r) => r.hariKunjungan)).join(", "), minggu: unik(rs.map((r) => (r.mingguPattern ?? "").toLowerCase())).join(", "),
        }));
        const pertama = [...anggota].sort((a, b) => urut(kodeBaku(a.salesCode), kodeBaku(b.salesCode)));
        baris.push({ custCode: kodeBaku(anggota[0].custCode), custName: unik(pertama.map((r) => r.custName))[0] ?? "", principle: kodeBaku(anggota[0].principle), salesman });
    }
    baris.sort((a, b) => urut(a.principle, b.principle) || urut(a.custName, b.custName) || urut(a.custCode, b.custCode));
    return { pilihanPrincipal: [...principalCakupan].filter(Boolean).sort(urut), totalToko: tokoCakupan.size, baris };
}

/**
 * Satu kueri: semua baris JKS aktif (±ribuan baris), dikelompokkan di susunCoverage. ponytail: seluruh JKS aktif dibaca tiap permintaan —
 * batasnya puluhan ribu baris; naik ke kueri `cust_code IN (toko cakupan)` bila JKS jauh lebih besar.
 */
export async function muatCoverage(scope: Pick<UserScope, "allowedSalesCodes">, principle: string | null): Promise<JawabanCoverage> {
    const rows = await db.select({ salesCode: jksMaster.salesCode, salesName: jksMaster.salesName, custCode: jksMaster.custCode, custName: jksMaster.custName,
        principle: jksMaster.principle, hariKunjungan: jksMaster.hariKunjungan, mingguPattern: jksMaster.mingguPattern })
        .from(jksMaster).where(eq(jksMaster.isActive, true)).orderBy(jksMaster.salesCode, jksMaster.id);
    return susunCoverage(rows, scope.allowedSalesCodes, principle);
}
