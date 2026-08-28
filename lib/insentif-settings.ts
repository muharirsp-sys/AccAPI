/*
 * Tujuan: Baca/tulis setelan aturan insentif yang boleh diubah tanpa deploy.
 * Caller: app/api/insentif-sales/dashboard, app/api/insentif-sales/settings.
 * Dependensi: lib/db, db/schema (appSetting).
 * Main Functions: getGtAoTargetMode, setGtAoTargetMode.
 * Side Effects: DB read; setter menulis satu baris app_setting.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSetting } from "@/db/schema";

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
