/*
 * Tujuan: Mesin status Master Barang — nilai status dan gerbang "nama mirip" di satu tempat (docs/MESIN_STATUS.md).
 * Caller: lib/master-barang/service.ts (appendSource, updateCodebook, finalizeMaster), db/schema.ts (tipe kolom),
 *         lib/mesin-status.test.ts.
 * Dependensi: Tidak ada. Pure.
 * Main Functions: tolakNamaMirip.
 * Side Effects: Tidak ada.
 */

/** blocked_similarity -> draft (3 konfirmasi nama mirip) -> review (ada sumber/kamus) -> ready (finalisasi). */
export type MasterStatus = "blocked_similarity" | "draft" | "review" | "ready";

/** Aksi yang mengisi atau mengunci master. Aksi baru yang menulis master WAJIB didaftarkan di sini. */
export type MasterAksi = "upload" | "kamus" | "finalisasi";

const TOLAK_NAMA_MIRIP: Record<MasterAksi, string> = {
    upload: "Selesaikan 3 konfirmasi nama mirip sebelum upload sumber.",
    kamus: "Selesaikan 3 konfirmasi nama mirip sebelum menyimpan Kamus Kode.",
    finalisasi: "Konfirmasi nama mirip belum selesai 3 tahap.",
};

/**
 * null = boleh; selain itu alasan penolakan. Selama nama principal masih mirip master lain dan belum
 * dikonfirmasi 3 tahap, master belum boleh diisi lewat jalur mana pun — termasuk simpan Kamus Kode, yang
 * menulis status `review` dan dulu membuka gerbang upload/finalisasi tanpa konfirmasi (cek 17 Nov 2026).
 */
export function tolakNamaMirip(status: string, aksi: MasterAksi): string | null {
    return status === "blocked_similarity" ? TOLAK_NAMA_MIRIP[aksi] : null;
}
