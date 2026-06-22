/*
 * Tujuan: Lokasi simpan foto bukti kunjungan — di volume data (persisten lintas redeploy), bukan public/.
 * Caller: app/api/upload/form-kontrol (tulis), app/api/uploads/form-kontrol/[file] (sajikan), app/api/cron/cleanup-uploads (bersihkan).
 * Dependensi: path native.
 * Catatan: public/ di Next standalone = snapshot build → file runtime tak tersaji & hilang saat redeploy.
 */
import path from "path";

// /app/data adalah volume yang sama dengan sqlite.db → foto ikut persisten.
export const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads", "form-kontrol");
