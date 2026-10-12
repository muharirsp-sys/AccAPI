/*
 * Tujuan: Baca/tulis setelan aturan insentif yang boleh diubah tanpa deploy.
 * Caller: app/api/insentif-sales/dashboard, app/api/insentif-sales/settings.
 * Dependensi: lib/db, db/schema (appSetting).
 * Main Functions: getGtAoTargetMode, setGtAoTargetMode, aoFileKey/spvIkutKey/pasanganKey, toggleDaftar, getDaftar, setDaftar,
 *   getBranchNilaiJual, getSmBerhak, getKonstantaBerlabel, readKonstanta, readKonstantaVersi, setKonstanta, tolakLunasTanpaKonstanta.
 * Side Effects: DB read; setter menulis satu baris app_setting.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
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

/**
 * Pengecualian PER BARIS dari ambang 240: daftar "KODE|PRINCIPAL" yang AO-nya dinilai terhadap
 * Target AO di file target. Per periode — sama seperti Status Insentif per baris — supaya
 * menekan tombol bulan ini tidak menggeser nominal bulan yang sudah dibayar.
 * ponytail: daftar JSON baca-ubah-tulis; dua penekanan di detik yang sama bisa saling menimpa.
 *   Pindah ke kolom sales_targets kalau yang menekan tombol ini lebih dari satu-dua orang.
 */
export const aoFileKey = (month: number, year: number) =>
    `insentif_ao_file:${year}-${String(month).padStart(2, "0")}`;
/**
 * Pengecualian per SPV × principal: principal yang TETAP dihitung untuk SPV walau semua sales
 * bawahannya "principle" (sales dibayar principal, SPV-nya dibayar distributor — kasus VINDA
 * Agustus 2026). Daftar "NAMA SPV|PRINCIPAL", per periode, ceiling sama dengan aoFileKey.
 */
export const spvIkutKey = (month: number, year: number) =>
    `insentif_spv_ikut:${year}-${String(month).padStart(2, "0")}`;
/** Kunci "A|B" untuk daftar di atas. Normalisasinya HARUS sama dengan getDaftar, kalau tidak lookup-nya diam-diam tidak pernah cocok. */
export const pasanganKey = (a: string, b: string) =>
    `${a}|${b}`.trim().toUpperCase().replace(/\s+/g, " ");

/**
 * Nyalakan/matikan satu anggota daftar. Dibaca KETAT, bukan lewat getDaftar: getDaftar menelan
 * galat jadi [], dan [] yang ditulis balik menghapus seluruh anggota LAIN pada periode itu.
 * Galat baca / JSON rusak → melempar, tidak menulis apa pun.
 */
export async function toggleDaftar(key: string, item: string, nyala: boolean, actor: string | null): Promise<boolean> {
    const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key)).limit(1);
    const sekarang: unknown = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(sekarang)) throw new Error(`${key}: isi app_setting bukan daftar`);
    const baru = nyala ? [...sekarang, item] : sekarang.filter((v) => v !== item);
    return (await setDaftar(key, baru.map(String), actor)).includes(item);
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
 * Konstanta efektif untuk TAMPILAN (dashboard, spv-dashboard, sm-dashboard). Gagal baca / JSON rusak → BAWAAN, dengan alasan
 * sama seperti setelan lain: setelan yang tak terbaca tidak boleh mematikan halaman. Tetapi DILABELI (S6-0c, peninjau B):
 * dulu bawaan dikembalikan diam-diam lalu Pembayaran menandai lunas nominal hasil bawaan. `gagal_baca` = angka sementara;
 * layar mengunci aksi tulis nominal dan route payments menolak menandai lunas.
 */
export async function getKonstantaBerlabel(): Promise<{ konstanta: Konstanta; konstantaSumber: "tersimpan" | "gagal_baca" }> {
    try {
        return { konstanta: await readKonstanta(), konstantaSumber: "tersimpan" };
    } catch (e) {
        console.warn(`[insentif-settings] gagal baca ${KONSTANTA_KEY}, pakai bawaan (gagal_baca):`,
            e instanceof Error ? e.message : e);
        return { konstanta: DEFAULT_KONSTANTA, konstantaSumber: "gagal_baca" };
    }
}

/**
 * Pagar route payments (POST dan PATCH [id]) sebelum menandai LUNAS: nominal datang dari klien (BL-27 hitung ulang server belum
 * ada) dan dihitung dashboard dengan konstanta. Selama konstanta tersimpan tak terbaca, dashboard menghitung dengan BAWAAN
 * (getKonstantaBerlabel → "gagal_baca") — nominal itu tidak boleh ditandai lunas. Layar sudah mengunci tombolnya; ini pagar
 * server bila layar lama/terbuka saat gangguan atau API langsung tetap mengirim. Jawaban 503 = tolak, null = boleh lanjut.
 * ponytail: hanya memastikan konstanta TERBACA saat menulis, bukan bahwa nominal klien dihitung darinya — itu BL-27.
 */
export async function tolakLunasTanpaKonstanta(): Promise<NextResponse | null> {
    try {
        await readKonstanta();
        return null;
    } catch {
        return NextResponse.json(
            { error: "Konstanta insentif tersimpan gagal dibaca; nominal belum pasti sehingga belum bisa ditandai lunas. Coba lagi nanti.", code: "KONSTANTA_GAGAL_BACA" },
            { status: 503 },
        );
    }
}

/**
 * Baca STRICT untuk jalur tulis (AM-020): gagal baca / JSON rusak MELEMPAR. Belum pernah
 * disimpan = bawaan (itu memang nilai yang berlaku, bukan fallback).
 */
export async function readKonstanta(): Promise<Konstanta> {
    return (await readKonstantaVersi()).konstanta;
}

/** AM-045: versi = updatedAt (ISO) baris tersimpan, null = belum pernah disimpan. Token CAS editor. */
export async function readKonstantaVersi(): Promise<{ konstanta: Konstanta; versi: string | null }> {
    const row = await bacaBarisKonstanta();
    if (!row) return { konstanta: DEFAULT_KONSTANTA, versi: null };
    return { konstanta: parseKonstanta(JSON.parse(row.value)), versi: row.updatedAt.toISOString() };
}

async function bacaBarisKonstanta() {
    const [row] = await db
        .select({ value: appSetting.value, updatedAt: appSetting.updatedAt })
        .from(appSetting)
        .where(eq(appSetting.key, KONSTANTA_KEY))
        .limit(1);
    return row ?? null;
}

/** Admin lain sudah menyimpan konstanta sejak editor ini memuatnya (AM-045) → 409, bukan timpa. */
export class KonstantaBerubahError extends Error {
    constructor() {
        super("Konstanta sudah diubah admin lain sejak editor dimuat. Muat ulang, lalu ulangi perubahan.");
    }
}

/**
 * Simpan konstanta. `patch` digabung di atas yang TERSIMPAN (bukan di atas bawaan), supaya
 * editor boleh mengirim satu field saja tanpa mengembalikan angka lain ke bawaan.
 * Yang disimpan selalu hasil parseKonstanta: kunci asing dan nilai di luar batas tidak masuk DB.
 * Dasar gabungan dibaca strict: bila tersimpan tak terbaca, JANGAN menulis bawaan + patch.
 * AM-045: `versi` = versi yang dimuat editor; beda dari yang tersimpan → KonstantaBerubahError.
 */
export async function setKonstanta(patch: unknown, actor: string | null, versi: string | null): Promise<{ konstanta: Konstanta; versi: string }> {
    const row = await bacaBarisKonstanta();
    if ((row ? row.updatedAt.toISOString() : null) !== versi) throw new KonstantaBerubahError();
    const sekarang = row ? parseKonstanta(JSON.parse(row.value)) : DEFAULT_KONSTANTA;
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
    // Tulis BERSYARAT pada isi yang tadi dibaca: penyimpan lain di antara baca dan tulis → 0 baris.
    // Syaratnya isi, bukan updatedAt — baris dari SQL now() bermikrodetik, Date JS hanya milidetik.
    const ditulis = row
        ? await db.update(appSetting)
            .set({ value, updatedBy: actor, updatedAt: now })
            .where(and(eq(appSetting.key, KONSTANTA_KEY), eq(appSetting.value, row.value)))
            .returning({ key: appSetting.key })
        : await db.insert(appSetting)
            .values({ key: KONSTANTA_KEY, value, updatedBy: actor, updatedAt: now })
            .onConflictDoNothing()
            .returning({ key: appSetting.key });
    if (ditulis.length === 0) throw new KonstantaBerubahError();
    return { konstanta: baru, versi: now.toISOString() };
}

function objek(raw: unknown, nama: string): Record<string, unknown> {
    if (raw == null || typeof raw !== "object") return {};
    const g = (raw as Record<string, unknown>)[nama];
    return g != null && typeof g === "object" ? (g as Record<string, unknown>) : {};
}
