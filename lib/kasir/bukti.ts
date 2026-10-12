/*
 * Tujuan: Berkas bukti setoran Transfer Kasir (K2a, BL-59; owner 12 Okt: unggah foto/PDF bukti WAJIB untuk Transfer) — jenis dari MAGIC
 *   BYTES (bukan ekstensi/MIME klien), batas ukuran, nama dibuat server (UUID), tulis eksklusif, baca/hapus hanya nama berpola ketat.
 * Caller: lib/kasir/hari.ts (catatSetoran), app/api/kasir/setoran (unggah), app/api/kasir/bukti (unduh).
 * Dependensi: node:fs/promises, node:path, node:crypto.
 * Main Functions: jenisBukti, simpanBukti, hapusBukti, bacaBukti, namaBuktiSah.
 * Side Effects: tulis/baca/hapus berkas di `tempatBukti.dir` (bawaan: data/uploads/kasir-bukti = volume data frontend, mekanisme sama
 *   dengan foto Form Kontrol lib/form-kontrol/uploads.ts). TIDAK disentuh cron cleanup-uploads (retensi bukti uang = permanen).
 *
 * ponytail: berkas di volume data satu instance (pola Form Kontrol). Plafon: multi-instance / cadangan terpisah butuh penyimpanan bersama
 * (mis. bytea seperti promo-rule approval) — jalan naik = kolom bytea + DDL.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Batas berkas bukti (sama dengan bukti pembayaran OPC & foto Form Kontrol). */
export const MAKS_BUKTI_BYTES = 5 * 1024 * 1024;
/** Badan permintaan setoran maksimal (berkas + JSON) — ditolak SEBELUM dibaca bila content-length melebihi. */
export const MAKS_BADAN_SETORAN_BYTES = 6 * 1024 * 1024;

export type JenisBukti = "jpg" | "png" | "pdf";
export const MIME_BUKTI: Record<JenisBukti, string> = { jpg: "image/jpeg", png: "image/png", pdf: "application/pdf" };

/** Lokasi berkas (uji mengganti `dir` ke direktori sementara lalu memulihkannya). */
export const tempatBukti = { dir: path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads", "kasir-bukti") };

/** Nama berkas yang sah = `<uuid v4 huruf kecil>.<jpg|png|pdf>` — satu-satunya bentuk yang pernah ditulis server (anti path traversal). */
const POLA_NAMA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;
export const namaBuktiSah = (nama: unknown): nama is string => typeof nama === "string" && POLA_NAMA.test(nama);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Jenis berkas dari MAGIC BYTES: JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, PDF "%PDF-". Lainnya null. */
export function jenisBukti(b: Uint8Array): JenisBukti | null {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b.length >= 8 && PNG.every((x, i) => b[i] === x)) return "png";
    if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-") return "pdf";
    return null;
}

const lokasi = (nama: string) => path.join(/*turbopackIgnore: true*/ tempatBukti.dir, path.basename(nama));

/** Tulis berkas baru bernama UUID (flag `wx`: tidak pernah menimpa). Hasil = nama yang disimpan di kasir_setoran.bukti_transfer. */
export async function simpanBukti(isi: Uint8Array, jenis: JenisBukti): Promise<string> {
    await mkdir(/*turbopackIgnore: true*/ tempatBukti.dir, { recursive: true });
    const nama = `${randomUUID()}.${jenis}`;
    await writeFile(/*turbopackIgnore: true*/ lokasi(nama), isi, { flag: "wx" });
    return nama;
}

/** Hapus berkas yang BELUM terikat ke baris setoran (galat pasti sebelum commit). Nama tak berpola = diabaikan; galat fs ditelan. */
export async function hapusBukti(nama: string | null | undefined): Promise<void> {
    if (!namaBuktiSah(nama)) return;
    await unlink(/*turbopackIgnore: true*/ lokasi(nama)).catch(() => undefined);
}

/** Baca berkas bukti; null bila nama tak berpola atau berkas tidak ada. */
export async function bacaBukti(nama: string | null | undefined): Promise<{ isi: Buffer; jenis: JenisBukti } | null> {
    if (!namaBuktiSah(nama)) return null;
    try {
        return { isi: await readFile(/*turbopackIgnore: true*/ lokasi(nama)), jenis: nama.slice(nama.lastIndexOf(".") + 1) as JenisBukti };
    } catch {
        return null;
    }
}
