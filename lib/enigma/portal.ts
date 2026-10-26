/*
 * Tujuan: Klien portal Enigma (https://enigma.enesis.com, "Sistem Pelaporan Sales Distributor") — login ID distributor + password
 *   (tanpa captcha), unggah xlsx, tunggu status di Riwayat Upload, baca Detail log bila validation_error.
 * Caller: lib/enigma/jalankan.ts; uji lib/enigma/portal.test.ts (server tiruan lokal).
 * Dependensi: fetch/FormData bawaan Node. Main Functions: unggahEnigma, uraiRiwayat, uraiDetail, isianTersembunyi.
 * Side Effects: HTTP ke portal Enigma (login, POST berkas = laporan masuk ke Enesis).
 * Bentuk portal (dibaca 26 Okt 2026): POST /login {subdist_id, password}; form unggah POST / multipart `excel_file` + hidden
 *   `__ncforminfo` (disisipkan firewall NetScaler di HTML); baris riwayat `/upload_detail/<id>` + status; Detail "Status : …",
 *   "Keterangan : …", "Detail log:" berisi "<pesan> pada baris | <n>".
 */
export type HasilUnggah = { id: number; status: string; keterangan: string; log: string[] };
export type BarisRiwayat = { id: number; tanggal: string; berkas: string; status: string };

const tanpaTag = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, "\"");

/** Baris Riwayat Upload (tabel di beranda), terbaru dulu sesuai urutan portal. */
export function uraiRiwayat(html: string): BarisRiwayat[] {
    return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].flatMap(([, tr]) => {
        const id = /\/upload_detail\/(\d+)/.exec(tr)?.[1];
        const sel = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => tanpaTag(m[1]).replace(/\s+/g, " ").trim());
        return id && sel.length >= 4 ? [{ id: Number(id), tanggal: sel[0], berkas: sel[1], status: sel[2] }] : [];
    });
}

/** Halaman Detail upload → status, keterangan, dan baris log (pesan validasi). */
export function uraiDetail(html: string) {
    const teks = tanpaTag(html).split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    const nilai = (label: string) => { const i = teks.indexOf(label); return i >= 0 && teks[i + 1] === ":" ? teks[i + 2] ?? "" : ""; };
    const awalLog = teks.indexOf("Detail log:");
    return { status: nilai("Status"), keterangan: nilai("Keterangan"), log: awalLog >= 0 ? teks.slice(awalLog + 1) : [] };
}

/** Semua input hidden di HTML (NetScaler menyisipkan `__ncforminfo` yang wajib ikut dikirim). */
export function isianTersembunyi(html: string) {
    const isian: Record<string, string> = {};
    for (const [tag] of html.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
        const nama = /name=["']([^"']+)["']/.exec(tag)?.[1];
        if (nama) isian[nama] = /value=["']([^"']*)["']/.exec(tag)?.[1] ?? "";
    }
    return isian;
}

const FINAL = (status: string) => status === "success" || /error|gagal|fail/i.test(status);
const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sesi HTTP dengan cookie dan redirect manual (cookie sesi dikirim lewat 302 sesudah login). */
function sesi(dasar: string) {
    const kue = new Map<string, string>();
    return async function minta(jalur: string, init: RequestInit = {}) {
        let url = new URL(jalur, dasar), opsi = init;
        for (let lompat = 0; lompat < 6; lompat++) {
            const res = await fetch(url, { ...opsi, redirect: "manual", signal: AbortSignal.timeout(120_000),
                headers: { ...(opsi.headers as Record<string, string> | undefined), cookie: [...kue].map(([k, v]) => `${k}=${v}`).join("; ") } });
            for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) kue.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
            const lokasi = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && lokasi) { url = new URL(lokasi, url); opsi = { method: "GET" }; await res.arrayBuffer(); continue; }
            return { res, html: await res.text(), url };
        }
        throw new Error(`Enigma: redirect berputar di ${jalur}`);
    };
}

/** Login → unggah → tunggu status final (default ≤15 menit) → baca Detail. Galat = belum pasti terunggah, dilaporkan ke admin. */
export async function unggahEnigma(akun: { id: string; password: string }, berkas: Buffer, namaBerkas: string,
    opsi: { dasar?: string; tungguMs?: number; selaMs?: number } = {}): Promise<HasilUnggah> {
    const { dasar = "https://enigma.enesis.com", tungguMs = 15 * 60_000, selaMs = 15_000 } = opsi;
    const minta = sesi(dasar);
    const halamanLogin = await minta("/login");
    await minta("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...isianTersembunyi(halamanLogin.html), subdist_id: akun.id, password: akun.password }).toString() });
    const beranda = await minta("/");
    if (!/name=["']excel_file["']/.test(beranda.html)) throw new Error("Enigma: login ditolak atau halaman unggah tidak ditemukan (cek ID/password di data/enigma/config.json)");
    const sebelum = Math.max(0, ...uraiRiwayat(beranda.html).map((r) => r.id));

    const form = new FormData();
    for (const [k, v] of Object.entries(isianTersembunyi(beranda.html))) form.append(k, v);
    form.append("excel_file", new Blob([new Uint8Array(berkas)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), namaBerkas);
    const kirim = await minta("/", { method: "POST", body: form });
    if (kirim.res.status >= 400) throw new Error(`Enigma: unggah ditolak HTTP ${kirim.res.status}`);

    for (const batas = Date.now() + tungguMs; ;) {
        const baru = uraiRiwayat((await minta("/")).html).filter((r) => r.id > sebelum).sort((a, b) => b.id - a.id)[0];
        if (baru && FINAL(baru.status)) {
            const detail = uraiDetail((await minta(`/upload_detail/${baru.id}`)).html);
            return { id: baru.id, status: baru.status, keterangan: detail.keterangan, log: detail.log };
        }
        if (Date.now() > batas) throw new Error(baru ? `Enigma: unggahan ${baru.id} belum selesai diproses (status "${baru.status}")` : "Enigma: unggahan tidak muncul di Riwayat Upload");
        await jeda(selaMs);
    }
}
