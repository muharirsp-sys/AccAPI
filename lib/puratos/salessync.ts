/*
 * Tujuan: Tiruan setia sales_sync.exe 1.0.0 (pengirim Puratos, dibongkar statis 6 Nov 2026): unggah satu berkas + log berformat sama.
 *   Log = format bawaan loguru `YYYY-MM-DD HH:mm:ss.SSS | LEVEL    | modul:fungsi:baris - pesan`, modul/fungsi/baris dan teks pesan
 *   persis dari exe asli, jam WITA — admin membaca log yang sama seperti dari laptop.
 * Protokol: POST multipart {__login, __password, ufile (nama tanpa .csv, text/plain)}, tanpa ikut redirect;
 *   sukses = HTTP 200 + jawaban memuat "was accepted" (tanpa peka huruf).
 * Caller: lib/puratos/jalankan.ts. Uji: lib/puratos/salessync.test.ts (server tiruan lokal).
 * Side Effects: HTTP POST ke server Puratos.
 */
export const GARIS = "=".repeat(60);
const REDIRECT = new Set([301, 302, 303, 307, 308]); // requests.Response.is_redirect

/** Jam WITA (UTC+8, tanpa DST) seperti jam laptop Makassar tempat sales_sync.exe dulu berjalan. */
export const waktuWita = (ms = Date.now()) => new Date(ms + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 23);

export class LogSalesSync {
    readonly baris: string[] = [];
    constructor(private readonly jam: () => string = () => waktuWita()) {}
    tulis(level: "INFO" | "SUCCESS" | "WARNING" | "ERROR", tempat: string, pesan: string) {
        this.baris.push(`${this.jam()} | ${level.padEnd(8)} | ${tempat} - ${pesan}`);
    }
    main(level: "INFO" | "SUCCESS" | "WARNING" | "ERROR", baris: number, pesan: string) { this.tulis(level, `__main__:main:${baris}`, pesan); }
    teks() { return `${this.baris.join("\n")}\n`; }
}

/** Satu berkas, persis uploader.upload_file. Kembali jawaban server bila diterima, null bila gagal (sudah tercatat di log). */
export async function unggahBerkas(o: { url: string; login: string; password: string; nama: string; isi: Buffer; log: LogSalesSync }): Promise<string | null> {
    const { log, nama } = o;
    const keGagal = () => { log.tulis("ERROR", "uploader:move_to_failed:246", `Moved to failed : ${nama}`); return null; };
    log.tulis("INFO", "uploader:upload_file:24", `Processing : ${nama}`);
    try {
        const form = new FormData();
        form.append("__login", o.login);
        form.append("__password", o.password);
        form.append("ufile", new Blob([new Uint8Array(o.isi)], { type: "text/plain" }), nama.replace(/\.[^.]+$/, ""));
        const res = await fetch(o.url, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        log.tulis("INFO", "uploader:upload_file:81", `HTTP Status : ${res.status}`);
        const lokasi = res.headers.get("location");
        if (lokasi && REDIRECT.has(res.status)) {
            log.tulis("ERROR", "uploader:upload_file:97", `Server redirected to : ${lokasi}`);
            return keGagal();
        }
        const teks = (await res.text()).trim();
        log.tulis("INFO", "uploader:upload_file:115", `Server Response : ${teks}`);
        if (res.status !== 200) { log.tulis("ERROR", "uploader:upload_file:126", `Upload failed : ${nama}`); return keGagal(); }
        if (!teks.toLowerCase().includes("was accepted")) {
            log.tulis("ERROR", "uploader:upload_file:143", `Server did not confirm file acceptance : ${nama}`);
            return keGagal();
        }
        log.tulis("SUCCESS", "uploader:upload_file:159", `Uploaded : ${nama}`);
        log.tulis("SUCCESS", "uploader:upload_file:191", `Archived : ${nama}`);
        return teks || "was accepted";
    } catch (e) {
        log.tulis("ERROR", "uploader:upload_file:199", `Upload error : ${nama}`);
        log.tulis("ERROR", "uploader:upload_file:204", (e as Error).message);
        return keGagal();
    }
}

/** Kepala log main(): START SALES SYNC + konfigurasi. */
export function awalLog(log: LogSalesSync, versi = "1.0.0") {
    log.main("INFO", 100, GARIS); log.main("INFO", 101, "START SALES SYNC"); log.main("INFO", 102, GARIS);
    log.main("INFO", 108, "Loading configuration...");
    log.main("INFO", 146, `Sales Sync Version: ${versi}`);
}

export function mulaiKirimLog(log: LogSalesSync) {
    log.main("INFO", 196, GARIS); log.main("INFO", 197, "START HTTP POST"); log.main("INFO", 198, GARIS);
}

/** Penutup log main(): FINAL SUMMARY; PROCESS FINISHED hanya bila tak ada yang gagal. */
export function ringkasLog(log: LogSalesSync, n: { uploaded: number; failed: number; skipped: number }) {
    log.main("INFO", 258, GARIS); log.main("INFO", 259, "FINAL SUMMARY"); log.main("INFO", 260, GARIS);
    log.main("INFO", 262, `Uploaded : ${n.uploaded}`);
    log.main("INFO", 266, `Failed   : ${n.failed}`);
    log.main("INFO", 270, `Skipped  : ${n.skipped}`);
    log.main("INFO", 274, GARIS);
    if (n.failed === 0) log.main("SUCCESS", 278, "PROCESS FINISHED");
    else log.main("WARNING", 284, "PROCESS FINISHED WITH ERRORS");
}
