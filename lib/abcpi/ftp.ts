/*
 * Tujuan: Unggah berkas laporan ke FTP ABC — klien FTP pasif minimal (USER/PASS/TYPE I/CWD/PASV/STOR/SIZE/QUIT),
 *   pengganti FTP-ABC.exe/ftp_upload.py di laptop. Ukuran di server dicek ulang dengan SIZE sebagai bukti terkirim utuh.
 * Caller: lib/abcpi/jalankan.ts; uji lib/abcpi/ftp.test.ts (server palsu lokal).
 * Dependensi: node:net. Main Functions: unggahFtp.
 * Side Effects: koneksi FTP keluar ke host konfigurasi.
 * ponytail: hanya FTP polos + PASV (setara ftplib otomasi lama yang dipakai sejak Juni 2026); FTPS/EPSV bila server ABC berganti.
 */
import net from "node:net";

export type FtpConfig = { host: string; port?: number; user: string; password: string; dir?: string };
type Balasan = { kode: number; teks: string };

/** Pembaca balasan kontrol FTP (termasuk balasan multi-baris "220-…" s.d. "220 …"). */
function pembaca(sock: net.Socket) {
    const antre: Balasan[] = [];
    const tunggu: Array<{ ok: (b: Balasan) => void; gagal: (e: Error) => void }> = [];
    let sisa = "", awal: string | null = null, kumpul = "", putus: Error | null = null;
    sock.on("data", (d) => {
        sisa += d.toString("utf8");
        for (let i = sisa.indexOf("\n"); i >= 0; i = sisa.indexOf("\n")) {
            const baris = sisa.slice(0, i).replace(/\r$/, "");
            sisa = sisa.slice(i + 1);
            kumpul += `${baris} `;
            const m = /^(\d{3})([ -])/.exec(baris);
            if (awal === null ? !m : !(m && m[1] === awal && m[2] === " ")) continue;
            if (awal === null && m![2] === "-") { awal = m![1]; continue; }
            const b = { kode: Number(m![1]), teks: kumpul.trim() };
            awal = null; kumpul = "";
            const w = tunggu.shift();
            if (w) w.ok(b); else antre.push(b);
        }
    });
    const akhiri = (e: Error) => { putus ??= e; for (const w of tunggu.splice(0)) w.gagal(putus); };
    sock.on("error", akhiri);
    sock.on("close", () => akhiri(new Error("Koneksi FTP tertutup")));
    return () => new Promise<Balasan>((ok, gagal) => {
        const b = antre.shift();
        if (b) ok(b); else if (putus) gagal(putus); else tunggu.push({ ok, gagal });
    });
}

const tersambung = (s: net.Socket) => new Promise<void>((ok, gagal) => { s.once("connect", ok); s.once("error", gagal); });

/** Unggah tiap berkas ke `dir`; galat pertama menghentikan semuanya (tidak ada unggah sebagian yang diam). */
export async function unggahFtp(cfg: FtpConfig, berkas: Array<{ nama: string; isi: Buffer }>, batasMs = 60_000) {
    const port = cfg.port ?? 21;
    const ctl = net.connect(port, cfg.host);
    ctl.setTimeout(batasMs, () => ctl.destroy(new Error(`FTP ${cfg.host}: tidak ada jawaban ${batasMs / 1000} detik`)));
    const balas = pembaca(ctl);
    const harap = async (awalan: string, b?: Balasan) => {
        const r = b ?? await balas();
        if (!String(r.kode).startsWith(awalan)) throw new Error(`FTP ${cfg.host}: ${r.teks}`);
        return r;
    };
    const perintah = (c: string) => { ctl.write(`${c}\r\n`); return balas(); };
    const hasil: Array<{ nama: string; bytes: number }> = [];
    try {
        await tersambung(ctl);
        await harap("2");
        const user = await perintah(`USER ${cfg.user}`);
        if (user.kode === 331) await harap("2", await perintah(`PASS ${cfg.password}`));
        else await harap("2", user);
        await harap("2", await perintah("TYPE I"));
        if (cfg.dir) await harap("2", await perintah(`CWD ${cfg.dir}`));
        for (const f of berkas) {
            const pasv = await harap("227", await perintah("PASV"));
            const p = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.teks);
            if (!p) throw new Error(`FTP ${cfg.host}: PASV tak terbaca (${pasv.teks})`);
            // Alamat IP dari PASV diabaikan (NAT): sambung ke host kontrol, seperti ftplib.
            const data = net.connect(Number(p[5]) * 256 + Number(p[6]), cfg.host);
            data.on("error", () => undefined); // galat data muncul lewat close(hadError) di bawah
            data.setTimeout(batasMs, () => data.destroy(new Error(`FTP ${cfg.host}: data ${f.nama} macet`)));
            await tersambung(data);
            await harap("1", await perintah(`STOR ${f.nama}`));
            await new Promise<void>((ok, gagal) => { data.once("close", (salah) => (salah ? gagal(new Error(`FTP ${cfg.host}: data ${f.nama} terputus`)) : ok())); data.end(f.isi); });
            await harap("2");
            const size = await perintah(`SIZE ${f.nama}`);
            if (size.kode === 213 && Number(size.teks.split(" ").pop()) !== f.isi.length) {
                throw new Error(`FTP ${cfg.host}: ${f.nama} di server ${size.teks.split(" ").pop()} byte, dikirim ${f.isi.length}`);
            }
            hasil.push({ nama: f.nama, bytes: f.isi.length });
        }
        await perintah("QUIT").catch(() => undefined);
        return hasil;
    } finally {
        ctl.destroy();
    }
}
