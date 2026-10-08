/*
 * Tujuan: Helper murni layar Laporan Harian (Fiori S3): status run dalam bahasa tugas, deteksi run macet, mode email dari catatan.
 * Caller: app/(dashboard)/laporan-harian/LaporanHarian.tsx, ui.test.ts.
 * Dependensi: Tidak ada. Pure.
 * Main Functions: statusRun, modeDariNote, rupiah, MACET_MENIT.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "@/components/fiori/core";

/** Run "sending" lebih lama dari ini dianggap macet (send-state belum bisa mengklaim ulang; BL-29). */
export const MACET_MENIT = 10;

export type StatusRun = { kode: "belum" | "mengirim" | "macet" | "terkirim" | "gagal"; label: string; tone: Tone };

export function statusRun(status: string, createdAt: string | Date, now: Date = new Date()): StatusRun {
    if (status === "sent") return { kode: "terkirim", label: "Terkirim", tone: "pos" };
    if (status === "failed") return { kode: "gagal", label: "Gagal", tone: "neg" };
    if (status === "sending") {
        const umur = (now.getTime() - new Date(createdAt).getTime()) / 60_000;
        return umur > MACET_MENIT ? { kode: "macet", label: "Macet", tone: "warn" } : { kode: "mengirim", label: "Mengirim", tone: "info" };
    }
    return { kode: "belum", label: "Belum dikirim", tone: "neu" };
}

/** Mode email tersimpan di kolom note ("email_mode:closing|daily"); null bila belum pernah dikirim. */
export function modeDariNote(note: string | null | undefined): "closing" | "daily" | null {
    const m = note?.match(/email_mode:(closing|daily)/);
    return m ? (m[1] as "closing" | "daily") : null;
}

export const rupiah = (value: number) => `Rp ${Math.round(value).toLocaleString("id-ID")}`;
