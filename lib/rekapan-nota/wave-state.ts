/*
 * Tujuan: State machine wave rekapan — draft -> released -> confirmed | cancelled.
 *         Aturan gerbangnya di satu tempat, bukan tersebar di route handler.
 * Caller: app/api/rekapan-nota/wave/[id]/route.ts, rules.test.ts.
 * Dependensi: Tidak ada. Pure.
 * Main Functions: transisiWave.
 * Side Effects: Tidak ada.
 */

export type WaveStatus = "draft" | "released" | "confirmed" | "cancelled";
export type WaveAksi = "release" | "confirm" | "cancel";

export type KonteksTransisi = {
    /** Jumlah nota aktif di wave. Wave kosong tidak boleh dirilis: kertas kosong bukan rekapan. */
    jumlahNota: number;
    /** Exception KONVERSI_* berstatus `open`. Memblokir confirm, TIDAK memblokir release. */
    konversiOpen: number;
};

export type HasilTransisi =
    | { ok: true; status: WaveStatus; event: string }
    | { ok: false; alasan: string };

const IZIN: Record<WaveAksi, { dari: WaveStatus[]; ke: WaveStatus; event: string }> = {
    release: { dari: ["draft"], ke: "released", event: "wave.released" },
    confirm: { dari: ["released"], ke: "confirmed", event: "wave.confirmed" },
    cancel: { dari: ["draft", "released"], ke: "cancelled", event: "wave.cancelled" },
};

export function transisiWave(dari: WaveStatus, aksi: WaveAksi, ctx: KonteksTransisi): HasilTransisi {
    const izin = IZIN[aksi];
    if (!izin) return { ok: false, alasan: `Aksi tidak dikenal: ${aksi}` };
    if (!izin.dari.includes(dari))
        return { ok: false, alasan: `Wave berstatus "${dari}" tidak bisa di-${aksi}.` };

    if (aksi === "release" && ctx.jumlahNota === 0)
        return { ok: false, alasan: "Wave belum berisi nota apa pun." };

    // Gudang tidak boleh diblokir: release tetap jalan meski ada exception open.
    // Yang tidak boleh adalah menutup wave sementara angkanya masih dipertanyakan (R1.4).
    if (aksi === "confirm" && ctx.konversiOpen > 0)
        return {
            ok: false,
            alasan: `Masih ada ${ctx.konversiOpen} exception konversi berstatus open. ` +
                `Tutup dulu, atau tandai diabaikan.`,
        };

    return { ok: true, status: izin.ke, event: izin.event };
}
