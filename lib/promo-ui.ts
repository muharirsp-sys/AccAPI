/*
 * Tujuan: Helper murni layar Promo (Fiori S4a): satu kosakata beban, status aturan, format rupiah/persen/tanggal, dan
 *   kalimat "artinya" sebuah aturan. Tidak ada logic bisnis baru — hanya penyajian.
 * Caller: app/(dashboard)/{summary,aturan-promo,rekap-promo,normalisasi-diskon}/*.tsx, promo-ui.test.ts.
 * Dependensi: Tidak ada. Pure.
 * Main Functions: rupiah, persen, tgl, BEBAN, bebanDari, statusAturan, bentukAturan, manfaat, JENIS_MANFAAT, artinya.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "@/components/fiori/core";

/** Rupiah dengan desimal hanya bila nilainya berdesimal; koma desimal (D-19). */
export function rupiah(value: number | string): string {
    const v = Number(value || 0);
    const pecahan = Math.abs(v - Math.trunc(v)) > 1e-9;
    return `Rp ${v.toLocaleString("id-ID", { minimumFractionDigits: pecahan ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** 2.25 → "2,25%" (koma desimal di semua layar). */
export const persen = (value: number | string) => `${String(value).replace(".", ",")}%`;

/** ISO → dd/mm/yyyy, bentuk tanggal di Accurate dan di surat. */
export const tgl = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

/** Satu kosakata beban di semua layar Promo (menggantikan Kita/Principal dan Disc Claim/Disc Distributor). */
export const BEBAN = {
    principal: { label: "Klaim principal", hint: "bisa ditagihkan ke principal", tone: "pos" as Tone },
    distributor: { label: "Beban distributor", hint: "jadi biaya distributor sendiri", tone: "warn" as Tone },
} as const;
export type BebanKey = keyof typeof BEBAN;
export const bebanDari = (benefitBeban: string): BebanKey => (benefitBeban.toUpperCase() === "PRINCIPAL" ? "principal" : "distributor");

export type StatusAturanKey = "aktif" | "nonaktif" | "berakhir" | "belum";
export const STATUS_ATURAN: Record<StatusAturanKey, { label: string; tone: Tone }> = {
    aktif: { label: "Aktif", tone: "pos" },
    nonaktif: { label: "Nonaktif", tone: "neu" },
    berakhir: { label: "Berakhir", tone: "neu" },
    belum: { label: "Belum mulai", tone: "info" },
};

/** Nonaktif mengalahkan masa berlaku: aturan mati diabaikan gerbang, apa pun tanggalnya. */
export function statusAturan(rule: { active: boolean; periodStart: string | null; periodEnd: string | null }, hariIni: string): StatusAturanKey {
    if (!rule.active) return "nonaktif";
    if (rule.periodEnd && rule.periodEnd.slice(0, 10) < hariIni) return "berakhir";
    if (rule.periodStart && rule.periodStart.slice(0, 10) > hariIni) return "belum";
    return "aktif";
}

/** Bentuk aturan, dibaca dari isinya. */
export function bentukAturan(rule: { customerCode: string; itemCode: string }) {
    if (rule.customerCode && !rule.itemCode) return { label: "Tarif outlet", hint: "berlaku untuk semua barang outlet ini" };
    if (rule.itemCode) return { label: "Per barang", hint: "hanya untuk barang ini" };
    return { label: "Tingkat faktur", hint: "satu potongan untuk seluruh nota" };
}

export const JENIS_MANFAAT: Record<string, string> = { DISC_PCT: "Diskon persen", DISC_RP: "Potongan rupiah", BONUS_QTY: "Bonus barang" };

/** "2,25%", "Rp 20.000", "bonus 1" dari jenis + nilai manfaat. */
export function manfaat(benefitType: string, benefitValue: string | number): string {
    if (benefitType === "DISC_RP") return rupiah(benefitValue);
    if (benefitType === "BONUS_QTY") return `bonus ${benefitValue}`;
    return persen(benefitValue);
}

type RuleLike = {
    customerCode?: string; itemCode?: string; channel?: string; outletList?: string; outletListMode?: string;
    benefitBeban?: string; benefitType?: string; benefitValue?: string; triggerQty?: string; triggerUnit?: string; tierNo?: number;
};

/** Satu kalimat arti sebuah aturan, untuk orang yang tidak membaca kolom. */
export function artinya(rule: RuleLike): string {
    const daftar = rule.outletList
        ? rule.outletListMode === "EXCLUDE" ? ` yang BUKAN peserta ${rule.outletList}` : ` peserta ${rule.outletList}`
        : "";
    const chan = rule.channel ? ` berkategori ${rule.channel === "GT" ? "TT (GT)" : rule.channel} di Accurate` : "";
    const siapa = rule.customerCode ? `Outlet ${rule.customerCode}` : `Semua outlet${chan}${daftar}`;
    const barang = rule.itemCode ? `barang ${rule.itemCode}` : "semua barang";
    const beban = bebanDari(rule.benefitBeban ?? "") === "principal"
        ? "termasuk klaim principal — bisa ditagihkan"
        : "termasuk beban distributor — jadi biaya sendiri";
    const n = (v: string | undefined) => Number(v || 0).toLocaleString("id-ID");
    const ambang = Number(rule.triggerQty) > 0
        ? rule.triggerUnit === "RP" ? ` kalau belanjanya minimal Rp ${n(rule.triggerQty)},` : ` kalau beli minimal ${n(rule.triggerQty)} ${rule.triggerUnit},`
        : "";
    if (rule.benefitType === "DISC_RP") return `${siapa}${ambang} dapat potongan ${rupiah(rule.benefitValue ?? 0)} untuk seluruh nota. Potongan ini ${beban}.`;
    if (rule.benefitType === "BONUS_QTY") return `${siapa}${ambang} dapat bonus barang ${rule.benefitValue ?? ""}. Bonus ini ${beban}.`;
    return `${siapa} dapat diskon ${persen(rule.benefitValue ?? "")} atas ${barang}${ambang ? ambang.replace(",", "") : ""}, `
        + `tertulis di kolom DISC_${rule.tierNo ?? 1} pada laporan principal. Potongan ini ${beban}.`;
}
