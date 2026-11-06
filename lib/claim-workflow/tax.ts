/*
 * Tujuan: Aturan persetujuan Tax (owner 6 Nov 2026): klaim yang memuat PPN atau PPh wajib disetujui tim Tax sebelum Claim mencetak
 *   surat, kwitansi, dan rekap. Claim mengisi No Claim, mengirim ke Tax; Tax menyetujui atau mengembalikan dengan catatan.
 *   Persetujuan mengikat nilai pajak saat itu (sidik); nilai berubah sesudahnya = harus dikirim ulang.
 * Caller: app/api/claim-workflow/[id]/tax (aksi), [id] (detail), [id]/status (mark_ready), lib/claim-workflow/tax-db (gerbang dokumen).
 * Main Functions: perluTax, sidikPajak, tahapTax, alasanTaxDokumen.
 * Side Effects: Tidak ada (server saja: memakai node:crypto).
 */
import { createHash } from "node:crypto";
import { claimWorkflowStatuses as S } from "./constants";

export const TAX_STATUS = { menunggu: "menunggu", dikembalikan: "dikembalikan", disetujui: "disetujui" } as const;

export type ItemPajak = { id: string; dpp: number; ppnRate: number; ppnAmount: number; pphRate: number; pphAmount: number };
export type KlaimPajak = { status: string; taxStatus: string | null; taxSidik: string | null };
export type TahapTax = "tidak_perlu" | "belum_dikirim" | "menunggu" | "dikembalikan" | "disetujui" | "berubah";

const ada = (v: number) => Number(v || 0) > 0;

/** Klaim berpajak = ada item dengan PPN atau PPh (tarif atau nilai). Tanpa keduanya Claim langsung mencetak. */
export const perluTax = (items: ItemPajak[]) =>
    items.some((i) => ada(i.ppnRate) || ada(i.ppnAmount) || ada(i.pphRate) || ada(i.pphAmount));

/** Sidik nilai pajak semua item (urutan item tidak berpengaruh). Berubah bila DPP, tarif, atau nilai PPN/PPh satu item berubah. */
export function sidikPajak(items: ItemPajak[]): string {
    const baris = [...items].sort((a, b) => a.id.localeCompare(b.id))
        .map((i) => [i.id, i.dpp, i.ppnRate, i.ppnAmount, i.pphRate, i.pphAmount].map((v) => String(v ?? 0)).join("|"));
    return createHash("sha256").update(baris.join("\n")).digest("hex").slice(0, 24);
}

export function tahapTax(klaim: KlaimPajak, items: ItemPajak[]): TahapTax {
    if (!perluTax(items)) return "tidak_perlu";
    if (klaim.taxStatus === TAX_STATUS.disetujui) return klaim.taxSidik === sidikPajak(items) ? "disetujui" : "berubah";
    if (klaim.taxStatus === TAX_STATUS.menunggu || klaim.taxStatus === TAX_STATUS.dikembalikan) return klaim.taxStatus;
    return "belum_dikirim";
}

/** Klaim yang boleh diubah (Draf / Perlu revisi). Aturan Tax hanya berlaku di sini: klaim yang sudah Siap dikirim atau lebih tidak dikunci. */
export const klaimTerbuka = (status: string) => status === S.draft || status === S.needRevision;

const ALASAN: Record<Exclude<TahapTax, "tidak_perlu" | "disetujui">, string> = {
    belum_dikirim: "Klaim ini memuat PPN/PPh: kirim ke Tax dulu. Surat klaim, ringkasan, dan kwitansi bisa dibuat setelah Tax menyetujui.",
    menunggu: "Klaim ini sedang diperiksa Tax. Surat klaim, ringkasan, dan kwitansi bisa dibuat setelah Tax menyetujui.",
    dikembalikan: "Klaim ini dikembalikan Tax. Perbaiki sesuai catatan Tax, kirim ulang, lalu buat dokumen setelah disetujui.",
    berubah: "Nilai PPN/PPh berubah sejak disetujui Tax. Kirim ulang ke Tax sebelum membuat dokumen.",
};

/** Alasan surat klaim, ringkasan (rekap), dan kwitansi belum boleh dibuat atau diunduh; "" bila boleh. */
export function alasanTaxDokumen(klaim: KlaimPajak, items: ItemPajak[]): string {
    if (!klaimTerbuka(klaim.status)) return "";
    const t = tahapTax(klaim, items);
    return t === "tidak_perlu" || t === "disetujui" ? "" : ALASAN[t];
}
