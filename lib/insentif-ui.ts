/*
 * Tujuan: Bagian murni halaman Insentif Sales (Fiori S4c): enam halaman + izinnya, tipe respons API, format angka,
 *   dan alasan Rp 0. Tanpa React supaya bisa dipakai rute server (pengalihan) dan diuji.
 * Caller: app/(dashboard)/insentif-sales/** (page.tsx server + klien), lib/insentif-ui.test.ts.
 * Dependensi: lib/insentif-konstanta (tipe Konstanta).
 * Main Functions: HALAMAN, halamanTerlihat, halamanAwal, sebabNol, readApi, formatPctText/Qty/Ratio.
 * Side Effects: Tidak ada.
 */
import type { Konstanta } from "@/lib/insentif-konstanta";

export type HalamanKey = "dashboard" | "saya" | "pembayaran" | "data" | "support" | "pengaturan";
/** Identitas hierarki akun (user.hierarchyRole bila nama juga terisi); null = belum ditautkan. */
export type PeranHierarki = "sales" | "spv" | "sm" | null;

/**
 * Enam halaman insentif (it07) dan izin yang membukanya; satu key cukup. Rute di bawah /insentif-sales tetap dijaga
 * `insentif_sales.view` oleh layout dashboard — ini menentukan halaman mana yang TAMPIL, endpoint tetap memeriksa izinnya sendiri.
 * Izin tiap halaman = izin tulis/baca endpoint yang dipakainya (lihat requirePermission di app/api/insentif-sales/**).
 * `peran` = identitas hierarki yang juga membuka halaman itu: SPV/SM tertaut dengan izin `view` saja dulu jatuh ke Dashboard SM.
 */
export const HALAMAN: ReadonlyArray<{ key: HalamanKey; href: string; label: string; izin: readonly string[]; peran?: readonly PeranHierarki[] }> = [
    { key: "dashboard", href: "/insentif-sales", label: "Dashboard", izin: ["view_dashboard", "view_all", "manage"], peran: ["spv", "sm"] },
    { key: "saya", href: "/insentif-sales/saya", label: "Insentif saya", izin: [], peran: ["sales"] },
    { key: "pembayaran", href: "/insentif-sales/pembayaran", label: "Pembayaran", izin: ["manage_payment", "manage"] },
    { key: "data", href: "/insentif-sales/data-periode", label: "Data periode", izin: ["upload_target", "upload_progress", "manage_hierarchy", "manage"] },
    { key: "support", href: "/insentif-sales/support", label: "Support principal", izin: ["input_support", "upload_target", "manage"] },
    { key: "pengaturan", href: "/insentif-sales/pengaturan", label: "Pengaturan", izin: ["manage", "manage_hierarchy"] },
];

/**
 * Halaman yang boleh dibuka: izin ATAU identitas hierarki. Akun insentif tanpa halaman lain mendapat "Insentif saya".
 * ponytail: grup utama per user (BL-37) belum ada; ganti tebakan "tanpa halaman lain" saat BL-37 masuk lewat tracker AM.
 */
export function halamanTerlihat(perms: ReadonlySet<string>, peran: PeranHierarki = null): typeof HALAMAN[number][] {
    const lain = HALAMAN.filter((h) => h.izin.some((k) => perms.has(`insentif_sales.${k}`)) || (peran !== null && h.peran?.includes(peran)));
    return lain.length > 0 ? lain : HALAMAN.filter((h) => h.key === "saya");
}

/** `?view=` dari tab lama (tautan tersimpan) → halaman barunya. */
const VIEW_LAMA: Record<string, HalamanKey> = { sm: "dashboard", spv: "dashboard", sales: "dashboard", finance: "pembayaran", admin: "data" };

/** Halaman tujuan /insentif-sales: tab lama dari `?view=` bila boleh, selain itu halaman pertama yang boleh. */
export function halamanAwal(perms: ReadonlySet<string>, viewLama?: string | null, peran: PeranHierarki = null): HalamanKey {
    const boleh = halamanTerlihat(perms, peran);
    const minta = viewLama ? VIEW_LAMA[viewLama] : undefined;
    return boleh.find((h) => h.key === minta)?.key ?? boleh[0].key;
}

// ── Tipe respons API ────────────────────────────────────────────────────────
export interface ApiRow {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel: string;
    tipeSales?: string;
    statusInsentif?: string;
    support?: number;
    spvName: string | null;
    smName: string | null;
    target: { value: number; ec: number; ao: number; ia: number; isq: number; splm: number };
    real: { value: number; ec: number; ao: number; ia: number; isq: number };
    pct: { value: number; ec: number; ao: number; isq: number; total: number };
    incentive: { value: number; ec: number; ao: number; isq: number; total: number };
    /** Penyebut AO yang dipakai membayar (240 atau Target AO file). */
    ambangAo: number;
    /** Tombol per baris "pakai Target AO file" menyala untuk periode ini. */
    aoFile: boolean;
    paymentStatus: string;
}

export interface ProgressFeedStatus {
    progressKeys: number;
    targetKeys: number;
    matchedKeys: number;
    unmatchedKeys: number;
    /** Kombinasi yang punya baris target tapi nilainya 0 — tidak dibayar sama sekali. */
    zeroTargetKeys: number;
    ready: boolean;
}

export interface PaymentRow {
    id: string;
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    periodMonth: number;
    periodYear: number;
    totalIncentive: number;
    paymentStatus: "belum" | "lunas" | "tunggakan";
    paymentProofUrl: string | null;
    paymentDate: number | null;
}

/** Cakupan baris dari GET dashboard: `dibatasi` = akun dengan identitas hierarki (SPV/SM/sales). */
export interface Cakupan { dibatasi: boolean; jumlahKode?: number; identitas?: { role: string; name: string } | null }

/**
 * Pilihan Status Insentif per baris target. Nilainya HARUS sama dengan yang diterima
 * lib/insentif-sales-calc.normalizeStatus — label di sini cuma untuk manusia.
 * distributor_principle: ikut skema, support principle dikurangkan dari pool · distributor: support diabaikan ·
 * principle: TIDAK ikut skema — Rp 0 dan keluar dari penyebut mix.
 */
export const STATUS_INSENTIF_OPSI = [
    { value: "distributor_principle", label: "Distributor + Principle" },
    { value: "distributor", label: "Distributor" },
    { value: "principle", label: "Principle" },
] as const;
export const LABEL_STATUS: Record<string, string> = Object.fromEntries(STATUS_INSENTIF_OPSI.map((o) => [o.value, o.label]));

export function paymentSelectionKey(row: { salesCode: string; principle: string }) {
    return `${row.salesCode}::${row.principle}`;
}

/**
 * Baca respons API dengan aman. `res.json()` langsung meledak jadi "Unexpected token 'B'…" ketika yang balik BUKAN dari
 * aplikasi kita (502/504 proxy, halaman login, HTML galat Next) dan menyembunyikan status HTTP-nya.
 */
export async function readApi(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 120).trim() || "respons kosong"}`);
    }
}

/** Persentase dari API sudah berskala 0-100 (lib/insentif-sales.pct), bukan rasio. */
export const formatPctText = (v: number) => `${v.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
/** Cacahan EC/AO/IA. Target boleh pecahan (mis. IA 204,8), realisasi selalu bulat. */
export const formatQty = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
/** ISQ = item per outlet, rasio kecil: 2 desimal supaya target 0,04 tidak tampil "0". */
export const formatRatio = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 });

/**
 * Kenapa baris ini Rp 0 (null = tidak nol / tidak ada sebab yang dikenali). Urutannya mengikuti urutan penolakan di kalkulasi.
 */
export function sebabNol(r: ApiRow, k: Konstanta): string | null {
    if (r.incentive.total > 0) return null;
    if (r.statusInsentif === "principle") return "tidak ikut skema";
    if (!(r.target.value > 0)) return "target belum diisi";
    if (!(r.real.value > 0)) return "penjualan bersih ≤ 0";
    if (r.channel !== "GT" && r.channel !== "TT" && r.channel !== "MT") return `channel "${r.channel}" tak dikenal`;
    if ((r.support ?? 0) >= k.gt.pool1) return "ditanggung principle";
    const pctAoDibayar = r.ambangAo > 0 ? (r.real.ao / r.ambangAo) * 100 : 0;
    const ambangPct = k.gt.ambangBayar * 100;
    if (r.pct.value < ambangPct && pctAoDibayar < ambangPct) return `belum ${formatPctText(ambangPct)}`;
    return null;
}
