/*
 * Tujuan: Lokasi simpan foto Form Kontrol + pengolah foto bersama — di volume data (persisten lintas redeploy), bukan public/.
 *   UPLOAD_DIR = foto bukti kunjungan (disajikan ke sesi mana pun, disapu cron 90 hari). NOO_DIR = berkas PRIVAT NOO (foto KTP + foto toko;
 *   hanya lewat route NOO berotorisasi, TIDAK disapu cron).
 * Caller: app/api/upload/form-kontrol (tulis), app/api/uploads/form-kontrol/[file] (sajikan), app/api/cron/cleanup-uploads (bersihkan),
 *   lib/form-kontrol/noo.ts (NOO_DIR, olahFoto).
 * Dependensi: path native, sharp.
 * Main Functions: UPLOAD_DIR, NOO_DIR, olahFoto, labelWaktu.
 * Side Effects: Tidak ada (olahFoto murni di memori).
 * Catatan: public/ di Next standalone = snapshot build → file runtime tak tersaji & hilang saat redeploy.
 */
import path from "path";
import sharp from "sharp";

// /app/data adalah volume yang sama dengan sqlite.db → foto ikut persisten.
export const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads", "form-kontrol");
/** NOO: DI LUAR data/uploads (route sajian foto kunjungan & cron 90 hari tidak menyentuhnya). Satu kolom nama berkas per foto (noo_toko). */
export const NOO_DIR = path.join(process.cwd(), "data", "private", "noo");

function xmlEscape(s: string) {
    return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

// ponytail: server timestamp (anti-manipulasi client) + overlay 2 baris di kiri-bawah via sharp.
function buildStampSvg(width: number, height: number, line1: string, line2: string) {
    const fs = Math.max(14, Math.round(width / 42));
    const pad = Math.round(fs * 0.6);
    const band = fs * 2 + pad * 3;
    const top = height - band;
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="${top}" width="${width}" height="${band}" fill="black" opacity="0.5"/>
            <text x="${pad}" y="${top + pad + fs}" font-family="sans-serif" font-size="${fs}" fill="white" font-weight="bold">${xmlEscape(line1)}</text>
            <text x="${pad}" y="${top + pad * 2 + fs * 2}" font-family="sans-serif" font-size="${fs}" fill="white">${xmlEscape(line2)}</text>
        </svg>`
    );
}

/** "dd/mm/yyyy hh:mm" waktu SERVER pada zona itu (foto kunjungan lama: Asia/Jakarta; NOO: Asia/Makassar = WITA). */
export function labelWaktu(timeZone: string, now = new Date()) {
    const p = new Intl.DateTimeFormat("en-GB", {
        timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Peninjau A R4: batas piksel masukan (kamera ponsel ≤ ±50 MP jarang; bawaan sharp ±268 MP = bom dekompresi di container 2 GB). */
export const BATAS_PIKSEL_FOTO = 40_000_000;

/**
 * Gambar unggahan → JPEG ≤ 1600 px (orientasi EXIF dipakai lalu metadata dibuang), latar transparan jadi PUTIH (PNG beralfa tidak jadi hitam),
 * opsional cap dua baris di kiri-bawah. Melempar bila bukan gambar yang bisa dibaca sharp atau > BATAS_PIKSEL_FOTO piksel.
 */
export async function olahFoto(masuk: Buffer, cap?: [string, string]): Promise<Buffer> {
    const kecil = await sharp(masuk, { limitInputPixels: BATAS_PIKSEL_FOTO })
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();
    if (!cap) return kecil;
    const img = sharp(kecil);
    const { width, height } = await img.metadata();
    if (!width || !height) return kecil;
    return img.composite([{ input: buildStampSvg(width, height, cap[0], cap[1]), top: 0, left: 0 }]).jpeg({ quality: 72 }).toBuffer();
}
