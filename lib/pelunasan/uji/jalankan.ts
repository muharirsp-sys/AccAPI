/**
 * Tujuan: menjalankan lib/pelunasan atas satu fixture PERSIS seperti halaman api-wrapper (deteksi dulu, lalu parse);
 *   toast direkam dalam bentuk panggilan `toast[jenis](pesan, opsi?)` agar sebanding dengan golden kode lama.
 * Caller: lib/pelunasan/*.test.ts.
 * Side Effects: tidak ada selain panggilan ke emulator yang diberikan.
 */
import { deteksiFormatPelunasan, parsePelunasan, type JenisLapor } from "../parser.ts";
import type { AccurateFetch } from "../retur.ts";
import type { buatEmulator } from "./emulator-accurate.ts";
import type { Fixture } from "./fixture.ts";

export async function jalankanLib(fx: Fixture, emu: ReturnType<typeof buatEmulator>) {
    const toasts: unknown[][] = [];
    if (!deteksiFormatPelunasan(fx.rows)) return { payload: null, manualRows: null, toasts };
    const { trxDate, isKeySaved, ...peta } = fx.opsi;
    const hasil = await parsePelunasan(fx.rows, {
        trxDate, isKeySaved, peta, accurateFetch: emu.accurateFetch as AccurateFetch,
        lapor: (jenis: JenisLapor, pesan: string, opsi?: { id: string }) => { toasts.push(opsi ? [jenis, pesan, opsi] : [jenis, pesan]); },
    });
    return { payload: hasil.payload, manualRows: hasil.manualRows, toasts };
}
