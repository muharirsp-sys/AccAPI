/*
 * Tujuan: Baca/tulis setelan aturan insentif yang boleh diubah tanpa deploy.
 * Caller: app/api/insentif-sales/dashboard, app/api/insentif-sales/settings.
 * Dependensi: lib/db, db/schema (appSetting).
 * Main Functions: getGtAoTargetMode, setGtAoTargetMode, getDaftar, setDaftar,
 *   getBranchNilaiJual, getSmBerhak.
 * Side Effects: DB read; setter menulis satu baris app_setting.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSetting } from "@/db/schema";
import { DEFAULT_BRANCH_NILAI_JUAL } from "./insentif-value-source";
import { SM_BERHAK_INSENTIF } from "./insentif-sm-calc";

export const GT_AO_TARGET_KEY = "insentif_gt_ao_target";

/**
 * "fixed240" = semua sales GT/TT dinilai terhadap ambang 240 (perilaku sejak awal).
 * "file"     = dinilai terhadap Target AO baris itu di file target.
 * Pilihan ini mengubah NOMINAL yang dibayar, jadi defaultnya sengaja perilaku lama:
 * tabel app_setting yang belum terisi tidak boleh diam-diam menggeser uang.
 */
export type GtAoTargetMode = "fixed240" | "file";

/**
 * Kegagalan baca TIDAK dilempar. Dashboard insentif memanggil ini di jalur utamanya, dan
 * setelan yang tak terbaca (tabel belum dibuat di produksi, hak akses dicabut) pernah
 * mematikan SELURUH halaman — terjadi 2026-08-27, tepat setelah tabel ini diperkenalkan.
 * Jatuh ke perilaku lama (ambang 240) jauh lebih baik daripada layar kosong: nominalnya
 * sama dengan sebelum toggle ada. Kegagalannya dicatat, bukan ditelan diam-diam.
 */
export async function getGtAoTargetMode(): Promise<GtAoTargetMode> {
    try {
        const [row] = await db
            .select({ value: appSetting.value })
            .from(appSetting)
            .where(eq(appSetting.key, GT_AO_TARGET_KEY))
            .limit(1);
        return row?.value === "file" ? "file" : "fixed240";
    } catch (e) {
        console.warn(`[insentif-settings] gagal baca ${GT_AO_TARGET_KEY}, pakai ambang 240:`,
            e instanceof Error ? e.message : e);
        return "fixed240";
    }
}

export async function setGtAoTargetMode(mode: GtAoTargetMode, actor: string | null) {
    const now = new Date();
    await db
        .insert(appSetting)
        .values({ key: GT_AO_TARGET_KEY, value: mode, updatedBy: actor, updatedAt: now })
        .onConflictDoUpdate({
            target: appSetting.key,
            set: { value: mode, updatedBy: actor, updatedAt: now },
        });
}

// ── Setelan berbentuk DAFTAR ────────────────────────────────────────────
// Dua aturan di bawah ini sebelumnya konstanta di kode, dan keduanya SUDAH pernah berubah
// karena keputusan bisnis (ABC pindah ke NILAI_JUAL 2026-08-29). Setiap perubahan berarti
// deploy, padahal isinya cuma daftar nama.
//
// Yang TIDAK dipindah ke sini: tabel rate SPV, strata SM, bobot pool GT/MT, dan ambang 100%.
// Semuanya di dalam fungsi kalkulasi murni yang jadi bagian paling sehat modul ini; membuatnya
// dapat dikonfigurasi berarti mengalirkan parameter ke seluruh pemanggil + test-nya, dan itu
// pekerjaan tersendiri, bukan tempelan. Lihat catatan audit di handover.

export const BRANCH_NILAI_JUAL_KEY = "insentif_branch_nilai_jual";
export const SM_BERHAK_KEY = "insentif_sm_berhak";

/**
 * Baca setelan berbentuk daftar string. Gagal baca / JSON rusak / bukan array → pakai
 * `fallback`, dengan alasan yang sama seperti getGtAoTargetMode: setelan yang tak terbaca
 * tidak boleh mematikan halaman atau diam-diam menggeser uang ke daftar kosong.
 *
 * Daftar KOSONG yang tersimpan sengaja dianggap sah (bukan jatuh ke fallback) — "tidak ada
 * SM yang berhak" adalah keputusan yang valid dan harus bisa dinyatakan.
 */
export async function getDaftar(key: string, fallback: readonly string[]): Promise<string[]> {
    try {
        const [row] = await db
            .select({ value: appSetting.value })
            .from(appSetting)
            .where(eq(appSetting.key, key))
            .limit(1);
        if (row?.value == null) return [...fallback];
        const parsed: unknown = JSON.parse(row.value);
        if (!Array.isArray(parsed)) return [...fallback];
        return parsed
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim().toUpperCase().replace(/\s+/g, " "))
            .filter(Boolean);
    } catch (e) {
        console.warn(`[insentif-settings] gagal baca ${key}, pakai bawaan:`,
            e instanceof Error ? e.message : e);
        return [...fallback];
    }
}

export async function setDaftar(key: string, nilai: string[], actor: string | null) {
    const bersih = [...new Set(
        nilai.map((v) => String(v).trim().toUpperCase().replace(/\s+/g, " ")).filter(Boolean),
    )].sort();
    const now = new Date();
    await db
        .insert(appSetting)
        .values({ key, value: JSON.stringify(bersih), updatedBy: actor, updatedAt: now })
        .onConflictDoUpdate({
            target: appSetting.key,
            set: { value: JSON.stringify(bersih), updatedBy: actor, updatedAt: now },
        });
    return bersih;
}

/** Cabang (JENISPRODUK) yang realisasi Value-nya diambil dari NILAI_JUAL, bukan DPP. */
export function getBranchNilaiJual(): Promise<string[]> {
    return getDaftar(BRANCH_NILAI_JUAL_KEY, DEFAULT_BRANCH_NILAI_JUAL);
}

/** Nama SM yang ikut skema insentif SM. */
export function getSmBerhak(): Promise<string[]> {
    return getDaftar(SM_BERHAK_KEY, SM_BERHAK_INSENTIF);
}
