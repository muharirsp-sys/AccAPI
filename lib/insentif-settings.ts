/*
 * Tujuan: Baca/tulis setelan aturan insentif yang boleh diubah tanpa deploy.
 * Caller: app/api/insentif-sales/dashboard, app/api/insentif-sales/settings.
 * Dependensi: lib/db, db/schema (appSetting).
 * Main Functions: getGtAoTargetMode, setGtAoTargetMode, getDaftar, setDaftar,
 *   getBranchNilaiJual, getSmBerhak, getKonstanta, setKonstanta.
 * Side Effects: DB read; setter menulis satu baris app_setting.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSetting } from "@/db/schema";
import { DEFAULT_BRANCH_NILAI_JUAL } from "./insentif-value-source";
import { SM_BERHAK_INSENTIF } from "./insentif-sm-calc";
import { DEFAULT_KONSTANTA, parseKonstanta, type Konstanta } from "./insentif-konstanta";

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

// ── Konstanta uang skema (pool, bobot, ambang, rate, strata, PPh) ───────
// Sampai 2026-09-03 semua angka ini sengaja TIDAK dapat dikonfigurasi (lihat catatan audit di
// handover). Diubah atas permintaan user: satu blob JSON di app_setting, dioper ke fungsi
// kalkulasi sebagai parameter `k`. Lihat lib/insentif-konstanta.ts.

export const KONSTANTA_KEY = "insentif_konstanta";

/**
 * Konstanta efektif. Gagal baca / JSON rusak → BAWAAN, dengan alasan sama seperti setelan
 * lain: dashboard insentif memanggil ini di jalur utamanya, dan setelan yang tak terbaca
 * tidak boleh mematikan halaman atau menggeser seluruh nominal ke nol.
 */
export async function getKonstanta(): Promise<Konstanta> {
    try {
        const [row] = await db
            .select({ value: appSetting.value })
            .from(appSetting)
            .where(eq(appSetting.key, KONSTANTA_KEY))
            .limit(1);
        if (row?.value == null) return DEFAULT_KONSTANTA;
        return parseKonstanta(JSON.parse(row.value));
    } catch (e) {
        console.warn(`[insentif-settings] gagal baca ${KONSTANTA_KEY}, pakai bawaan:`,
            e instanceof Error ? e.message : e);
        return DEFAULT_KONSTANTA;
    }
}

/**
 * Simpan konstanta. `patch` digabung di atas yang TERSIMPAN (bukan di atas bawaan), supaya
 * editor boleh mengirim satu field saja tanpa mengembalikan angka lain ke bawaan.
 * Yang disimpan selalu hasil parseKonstanta: kunci asing dan nilai di luar batas tidak masuk DB.
 */
export async function setKonstanta(patch: unknown, actor: string | null): Promise<Konstanta> {
    const sekarang = await getKonstanta();
    const gabung = {
        gt: { ...sekarang.gt, ...(objek(patch, "gt")) },
        mt: { ...sekarang.mt, ...(objek(patch, "mt")) },
        spv: { ...sekarang.spv, ...(objek(patch, "spv")) },
        sm: { ...sekarang.sm, ...(objek(patch, "sm")) },
        pph: { ...sekarang.pph, ...(objek(patch, "pph")) },
    };
    const baru = parseKonstanta(gabung);
    const now = new Date();
    const value = JSON.stringify(baru);
    await db
        .insert(appSetting)
        .values({ key: KONSTANTA_KEY, value, updatedBy: actor, updatedAt: now })
        .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedBy: actor, updatedAt: now } });
    return baru;
}

function objek(raw: unknown, nama: string): Record<string, unknown> {
    if (raw == null || typeof raw !== "object") return {};
    const g = (raw as Record<string, unknown>)[nama];
    return g != null && typeof g === "object" ? (g as Record<string, unknown>) : {};
}
