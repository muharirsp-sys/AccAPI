/*
 * Tujuan: State machine wave rekapan — draft -> released -> confirmed | cancelled.
 *         Aturan gerbangnya di satu tempat, bukan tersebar di route handler.
 * Caller: app/api/rekapan-nota/wave/[id]/{route,nota/route,exception/route}.ts, rules.test.ts.
 * Dependensi: Tidak ada. Pure.
 * Main Functions: transisiWave, tolakUbahIsi.
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

/** Perubahan isi yang bukan transisi status. Penjagaan server, bukan hanya tombol yang dimatikan (BL-25). */
export type UbahIsi = "tambah" | "takeout" | "prioritas" | "set_grup" | "tutup_exception";

const BOLEH_UBAH: Record<UbahIsi, { dari: WaveStatus[]; akibat: string }> = {
    tambah: { dari: ["draft"], akibat: "nota tidak bisa ditambah" },
    // Wave tertutup = kertasnya final: lepas nota / ubah prioritas / grup cetak tidak boleh lagi.
    takeout: { dari: ["draft", "released"], akibat: "nota tidak bisa dilepas" },
    prioritas: { dari: ["draft", "released"], akibat: "prioritas tidak bisa diubah" },
    set_grup: { dari: ["draft", "released"], akibat: "grup cetak tidak bisa diubah" },
    // Selisih file (BL-54) bisa muncul setelah konfirmasi dan tetap perlu ditutup; wave batal tidak punya pekerjaan lagi.
    tutup_exception: { dari: ["draft", "released", "confirmed"], akibat: "exception tidak bisa ditutup" },
};

const STATUS_KATA: Record<WaveStatus, string> = {
    draft: "masih draf", released: "sudah dirilis", confirmed: "sudah dikonfirmasi", cancelled: "sudah dibatalkan",
};

/** null = boleh; selain itu alasan 409 yang dibaca pengguna. */
export function tolakUbahIsi(status: WaveStatus, aksi: UbahIsi): string | null {
    const b = BOLEH_UBAH[aksi];
    return b.dari.includes(status) ? null : `Wave ${STATUS_KATA[status] ?? status}; ${b.akibat}. Muat ulang halaman.`;
}
