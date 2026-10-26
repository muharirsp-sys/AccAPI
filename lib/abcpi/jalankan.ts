/*
 * Tujuan: Satu putaran laporan harian ABCPI — tarik faktur INV + retur RJN cabang ABC (bulan berjalan s.d. tanggal) dan stok
 *   dari API Accurate, susun format template ABCPI, simpan arsip, unggah FTP ABC, email penerima "ABCPI" (Laporan Harian),
 *   kabari admin. Akhir bulan dari cron = DITAHAN (owner 26 Okt 2026): admin dikirimi berkasnya, kirim manual dari web.
 * Caller: app/api/cron/abcpi-harian (20.00 WITA, cron VPS), app/api/laporan-harian/abcpi (pratinjau/kirim manual).
 * Dependensi: lib/abcpi/{laporan,ftp}, resolveSyncCredentials, lib/email, report_recipient, item, xlsx.
 *   Konfigurasi di volume data (bukan env Coolify, tertimpa tiap deploy): data/abcpi/config.json
 *   { "ftp": { "host", "port", "user", "password", "dir" }, "adminEmail" }.
 * Main Functions: jalankanAbcpi, riwayatAbcpi, hariIniWita.
 * Side Effects: HTTP baca Accurate (list.do/detail.do/list-stock.do, tanpa tulis); tulis data/abcpi/<YYYY-MM>/*,
 *   data/abcpi/log.jsonl; unggah FTP; kirim email.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { item, reportRecipient } from "@/db/schema";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { accurateHeaders, type AccurateCredentials } from "@/lib/sync";
import { redactAccurateSecrets } from "@/lib/accurate-redact";
import { sendEmail } from "@/lib/email";
import { unggahFtp, type FtpConfig } from "./ftp";
import { akhirBulan, barangAbc, barisSales, barisStok, keCsv, KOLOM_SO, KOLOM_STOK, petaDari, type Baris } from "./laporan";

const CABANG_ABC = "550"; // branch "ABC" di Accurate (probe 26 Okt 2026); faktur INV/…/AB & retur RJN/…/AB
const GUDANG_BS = "GD0BS";
const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "abcpi");
const WEB = "https://web-super.online/laporan-harian";

export const hariIniWita = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const keAccurate = (iso: string) => iso.split("-").reverse().join("/");
const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Obj = Record<string, unknown>;

async function ambil(creds: AccurateCredentials, jalur: string, params: Record<string, string>) {
    const url = new URL(`${creds.sessionHost}/accurate/api${jalur}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
    for (let coba = 1; ; coba++) {
        const res = await fetch(url, { headers: accurateHeaders(creds), signal: AbortSignal.timeout(60_000) }).catch((e: Error) => e);
        if (res instanceof Error || res.status === 429 || res.status >= 500) {
            if (coba < 4) { await jeda(3000 * coba); continue; }
            throw new Error(`Accurate ${jalur}: ${res instanceof Error ? res.message : `HTTP ${res.status}`}`);
        }
        const body = await res.json().catch(() => null) as { s?: boolean; d?: unknown; m?: unknown; sp?: Obj } | null;
        if (!res.ok || !body?.s) throw new Error(redactAccurateSecrets(`Accurate ${jalur}: HTTP ${res.status} ${String(body?.m ?? body?.d ?? "")}`).slice(0, 300));
        return body;
    }
}

/** Semua halaman list.do (urut id naik: baris baru jatuh di halaman akhir); jumlah wajib sama dengan sp.rowCount. */
async function daftar(creds: AccurateCredentials, jalur: string, params: Record<string, string>): Promise<Obj[]> {
    for (let coba = 1; ; coba++) {
        const rows: Obj[] = [];
        let pageCount = 1, rowCount = 0;
        for (let page = 1; page <= pageCount; page++) {
            const b = await ambil(creds, jalur, { ...params, "sp.page": String(page), "sp.pageSize": "100", "sp.sort": "id|asc" });
            pageCount = Number(b.sp?.pageCount ?? 0);
            rowCount = Number(b.sp?.rowCount ?? 0);
            rows.push(...(b.d as Obj[]));
        }
        if (rows.length === rowCount && new Set(rows.map((r) => r.id)).size === rowCount) return rows;
        if (coba === 3) throw new Error(`Accurate ${jalur}: terbaca ${rows.length} dari ${rowCount} baris (data berubah saat dibaca)`);
    }
}

/** detail.do per dokumen, 4 sekaligus. ponytail: ±1.000 panggilan di akhir bulan (±2 menit); pakai cache sales_invoice bila jadi beban. */
async function rincian(creds: AccurateCredentials, jalur: string, ids: unknown[]) {
    const hasil: unknown[] = new Array(ids.length);
    let i = 0, berhenti = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
        for (let k = i++; k < ids.length && !berhenti; k = i++) {
            try { hasil[k] = (await ambil(creds, jalur, { id: String(ids[k]) })).d; } catch (e) { berhenti = true; throw e; }
        }
    }));
    return hasil;
}

async function konfigurasi(): Promise<{ ftp: FtpConfig; adminEmail: string }> {
    const c = JSON.parse(await readFile(path.join(DIR, "config.json"), "utf8")) as { ftp?: FtpConfig; adminEmail?: string };
    if (!c.ftp?.host || !c.ftp.user || !c.ftp.password || !c.adminEmail) throw new Error("data/abcpi/config.json belum lengkap (ftp.host/user/password, adminEmail)");
    return { ftp: c.ftp, adminEmail: c.adminEmail };
}

/** JSON.parse yang tidak menjatuhkan fitur karena satu berkas/baris rusak (mis. tulisan terpotong saat deploy). */
const urai = <T>(teks: string, cadangan: T): T => { try { return JSON.parse(teks) as T; } catch { return cadangan; } };

/** Baris CSV arsip → objek (angka dikembalikan ke angka) untuk lembar xlsx. */
const dariCsv = (csv: string): Baris[] => {
    const [kepala, ...isi] = csv.trim().split("\r\n");
    const k = kepala.split("|");
    return isi.map((l) => Object.fromEntries(l.split("|").map((v, i) => [k[i], k[i].startsWith("Stock_") ? Number(v) : v])));
};

async function penerimaAbcpi() {
    const [r] = await db.select({ emails: reportRecipient.emails }).from(reportRecipient)
        .where(and(eq(reportRecipient.keyword, "ABCPI"), eq(reportRecipient.active, true))).limit(1);
    return (r?.emails ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes("@"));
}

/** Tarik data Accurate dan susun laporan (tanpa kirim). */
async function susun(tanggal: string) {
    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) throw new Error(accurate.error);
    const creds = accurate.creds;
    const periode = { "filter.branchId": CABANG_ABC, "filter.transDate.op": "BETWEEN",
        "filter.transDate.val[0]": keAccurate(`${tanggal.slice(0, 8)}01`), "filter.transDate.val[1]": keAccurate(tanggal) };
    // Faktur bernomor RJN di cabang ABC bernilai 0 tanpa barang (pasangan retur); RSJ = retur bonus, tidak ikut (owner).
    const fakturList = (await daftar(creds, "/sales-invoice/list.do", { fields: "id,number", ...periode })).filter((r) => String(r.number).startsWith("INV/"));
    const returList = (await daftar(creds, "/sales-return/list.do", { fields: "id,number", ...periode })).filter((r) => !String(r.number).toUpperCase().startsWith("RSJ"));
    const faktur = await rincian(creds, "/sales-invoice/detail.do", fakturList.map((r) => r.id));
    const retur = await rincian(creds, "/sales-return/detail.do", returList.map((r) => r.id));
    const sales = barisSales(faktur, retur);

    const stokSemua = await daftar(creds, "/item/list-stock.do", { fields: "id,no,name,quantity" });
    const stokBs = new Map((await daftar(creds, "/item/list-stock.do", { fields: "id,no,quantity", warehouseName: GUDANG_BS })).map((r) => [String(r.no), Number(r.quantity) || 0]));
    // Barang ABC = ada di peta, atau charField1 master barang (cache sync) = ABC PRESIDENT; master dari rincian dokumen bulan ini
    // membawa charField3 (kode principle) untuk barang yang belum ada di daftar harga.
    const masterAbc = new Set((await db.select({ no: item.no }).from(item).where(sql`(${item.rawData} #>> '{}') ilike '%ABC PRESIDENT%'`)).map((r) => r.no));
    const masterDok = new Map<string, Obj>();
    for (const f of [...faktur, ...retur]) for (const d of ((f as Obj).detailItem as Obj[] | undefined) ?? []) masterDok.set(String((d.item as Obj)?.no), d.item as Obj);
    const stok = barisStok(tanggal, stokSemua
        .filter((r) => masterAbc.has(String(r.no)) || barangAbc(String(r.no), masterDok.get(String(r.no)) ?? {}))
        .map((r) => ({ no: String(r.no), nama: String(r.name ?? ""), total: Number(r.quantity) || 0, bs: stokBs.get(String(r.no)) ?? 0,
            peta: petaDari(String(r.no), masterDok.get(String(r.no)) ?? {}) })));
    return { sales, stok, dokumen: { faktur: fakturList.length, retur: returList.length } };
}

function xlsx(sales: Baris[], stok: Baris[]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sales, { header: [...KOLOM_SO] }), "Template SO");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stok, { header: [...KOLOM_STOK] }), "Template Stok");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

type Status = { ftp?: { waktu: string; berkas: Array<{ nama: string; bytes: number }> }; email?: { waktu: string; ke: number }; ditahan?: string };
export type HasilAbcpi = {
    tanggal: string; sumber: "cron" | "manual"; status: "terkirim" | "sebagian" | "ditahan" | "dilewati" | "gagal" | "pratinjau";
    baris?: { sales: number; stok: number; faktur: number; retur: number }; ftp?: string; email?: string; galat: string[]; peringatan: string[];
};

let berjalan = false; // satu proses Node per container: cron dan tombol web tidak boleh menumpuk

/**
 * kirim=false → hanya susun (pratinjau, kembalikan xlsx). Cron: kanal yang sudah sukses untuk tanggal itu dilewati (aman diulang
 * 21.00/22.00); akhir bulan ditahan. Manual: selalu kirim kedua kanal (tombol web, dengan konfirmasi).
 */
export async function jalankanAbcpi({ tanggal, kirim, sumber }: { tanggal: string; kirim: boolean; sumber: "cron" | "manual" }): Promise<HasilAbcpi & { xlsx?: Buffer }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || tanggal > hariIniWita()) throw new Error(`Tanggal tidak sah: ${tanggal}`);
    if (berjalan) throw new Error("Laporan ABCPI sedang diproses; coba lagi beberapa menit lagi.");
    berjalan = true;
    const ymd = tanggal.replaceAll("-", "");
    const folder = path.join(DIR, tanggal.slice(0, 7));
    const berkasStatus = path.join(folder, `SP_${ymd}.status.json`);
    const hasil: HasilAbcpi = { tanggal, sumber, status: "gagal", galat: [], peringatan: [] };
    let adminEmail = "";
    try {
        await mkdir(folder, { recursive: true });
        const status = urai<Status>(await readFile(berkasStatus, "utf8").catch(() => "{}"), {});
        const ulang = sumber === "cron";
        // Cron hanya melewati kanal yang sukses SESUDAH jadwal 20.00 WITA (12.00 UTC): kiriman manual siang hari tidak
        // membekukan laporan malam itu, tetapi perbaikan manual sesudah 20.00 tidak dikirim ulang oleh putaran 21.00/22.00.
        const sesudahJadwal = (w?: string) => Boolean(w && w >= `${tanggal}T12:00:00.000Z`);
        const tahan = kirim && ulang && akhirBulan(tanggal);
        if (kirim && ulang && (tahan ? status.ditahan : sesudahJadwal(status.ftp?.waktu) && sesudahJadwal(status.email?.waktu))) {
            hasil.status = "dilewati";
            return hasil;
        }
        const cfg = kirim ? await konfigurasi() : null;
        adminEmail = cfg?.adminEmail ?? "";

        const nama = { sales: `SP_${ymd}_SALES.csv`, stok: `SP_${ymd}_STOCK.csv`, xlsx: `ABCPI_SP_${ymd}.xlsx` };
        const { sales, stok, dokumen } = await susun(tanggal);
        // Tanggal lampau (closing yang ditahan, kirim ulang): stok memakai arsip putaran tanggal itu, bukan stok hari ini.
        const stokArsip = tanggal < hariIniWita() ? await readFile(path.join(folder, nama.stok), "utf8").catch(() => null) : null;
        const barisStokFinal = stokArsip ? dariCsv(stokArsip) : stok.baris;
        hasil.baris = { sales: sales.baris.length, stok: barisStokFinal.length, ...dokumen };
        hasil.galat = sales.galat;
        if (stokArsip) hasil.peringatan.push(`Stok memakai arsip ${nama.stok} (posisi saat putaran tanggal itu)`);
        else if (stok.lewat.length) hasil.peringatan.push(`Stok tanpa kode principle tidak dilaporkan: ${stok.lewat.join(", ")}`);
        if (!sales.baris.length) hasil.peringatan.push("Tidak ada faktur/retur ABC bulan ini sampai tanggal laporan");
        const csvSales = Buffer.from(keCsv(KOLOM_SO, sales.baris));
        const csvStok = Buffer.from(stokArsip ?? keCsv(KOLOM_STOK, stok.baris));
        const buku = xlsx(sales.baris, barisStokFinal);
        if (!cfg) { hasil.status = "pratinjau"; return { ...hasil, xlsx: buku }; }
        if (sales.galat.length) throw new Error("Validasi gagal — tidak dikirim ke FTP maupun email ABCPI");
        if (!barisStokFinal.length) throw new Error("Stok barang ABC kosong — sesi Accurate membuka database yang salah? Tidak dikirim");

        await Promise.all([writeFile(path.join(folder, nama.sales), csvSales), writeFile(path.join(folder, nama.stok), csvStok), writeFile(path.join(folder, nama.xlsx), buku)]);
        const simpanStatus = () => writeFile(berkasStatus, JSON.stringify(status, null, 1));
        const lampiran = [{ filename: nama.xlsx, content: buku, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }];
        const tgl = tanggal.split("-").reverse().join("/");
        const periode = `01–${tgl}`;

        if (tahan) {
            const ok = await sendEmail({ to: cfg.adminEmail, subject: `[ABCPI] Closing ${tgl} DITAHAN — kirim manual`, attachments: [...lampiran,
                { filename: nama.sales, content: csvSales, contentType: "text/csv" }, { filename: nama.stok, content: csvStok, contentType: "text/csv" }],
                text: [`Laporan closing ABCPI ${periode} (${hasil.baris.sales} baris penjualan, ${hasil.baris.stok} baris stok) sudah disusun tetapi BELUM dikirim ke FTP maupun email ABCPI.`,
                    `Periksa lampiran, lalu kirim dari ${WEB} (bagian "Laporan ABCPI", tanggal ${tgl}, tombol Kirim). Penjualan ditarik ulang dari Accurate saat tombol ditekan; stok memakai posisi pukul 20.00 di lampiran ini.`,
                    ...hasil.peringatan.map((p) => `Peringatan: ${p}`)].join("\n\n") });
            if (!ok) throw new Error("Email pemberitahuan closing ke admin gagal (cek SMTP)");
            status.ditahan = new Date().toISOString();
            await simpanStatus();
            hasil.status = "ditahan";
            return hasil;
        }

        // Status disimpan segera sesudah tiap kanal sukses: putaran yang terputus (deploy) tidak mengirim ulang kanal itu.
        let ftpOk = ulang && sesudahJadwal(status.ftp?.waktu), emailOk = ulang && sesudahJadwal(status.email?.waktu);
        if (!ftpOk) {
            try {
                status.ftp = { waktu: new Date().toISOString(), berkas: await unggahFtp(cfg.ftp, [{ nama: nama.sales, isi: csvSales }, { nama: nama.stok, isi: csvStok }]) };
                ftpOk = true;
                await simpanStatus();
            } catch (e) { hasil.galat.push(`FTP: ${(e as Error).message}`); }
        }
        if (!emailOk) {
            const ke = await penerimaAbcpi().catch((e: Error) => { hasil.galat.push(`Email: penerima tidak terbaca (${e.message})`); return null; });
            if (ke && !ke.length) hasil.galat.push("Email: penerima keyword ABCPI (Laporan Harian › Penerima laporan) kosong/nonaktif");
            else if (ke && await sendEmail({ to: ke, subject: `Laporan Harian ABCPI - CV Surya Perkasa - ${tgl}`, attachments: lampiran,
                text: [`Yth. Tim ABC President Indonesia,`,
                    `Terlampir laporan penjualan (faktur dan retur) periode ${periode} serta stok per ${tgl} dari CV Surya Perkasa dalam format template ABCPI.\nBerkas yang sama telah diunggah ke FTP: ${nama.sales}, ${nama.stok}.`,
                    `Dikirim otomatis oleh sistem AccAPI.`, `Terima kasih.`].join("\n\n") })) {
                status.email = { waktu: new Date().toISOString(), ke: ke.length };
                emailOk = true;
                await simpanStatus();
            } else if (ke) hasil.galat.push("Email ke ABCPI gagal terkirim (cek SMTP)");
        }
        hasil.ftp = ftpOk && status.ftp ? `${status.ftp.berkas.map((b) => `${b.nama} ${b.bytes} byte`).join(", ")} (${status.ftp.waktu})` : "gagal";
        hasil.email = emailOk && status.email ? `${status.email.ke} alamat (${status.email.waktu})` : "gagal";
        hasil.status = ftpOk && emailOk ? "terkirim" : ftpOk || emailOk ? "sebagian" : "gagal";
        return hasil;
    } catch (e) {
        hasil.galat.push((e as Error).message);
        hasil.status = "gagal";
        return hasil;
    } finally {
        berjalan = false;
        if (kirim && hasil.status !== "dilewati") await catat(hasil, adminEmail);
    }
}

/** Jejak putaran (data/abcpi/log.jsonl) + kabar ke admin: bukti tiap kiriman dan peringatan bila gagal. */
async function catat(hasil: HasilAbcpi, adminEmail: string) {
    await appendFile(path.join(DIR, "log.jsonl"), `${JSON.stringify({ waktu: new Date().toISOString(), ...hasil })}\n`).catch(() => undefined);
    const admin = adminEmail || await konfigurasi().then((c) => c.adminEmail, () => "");
    if (!admin || hasil.status === "ditahan") return;
    const kanal = (v?: string) => (v ? (v === "gagal" ? "gagal" : "ok") : "-");
    await sendEmail({ to: admin, subject: `[ABCPI] ${hasil.status.toUpperCase()} ${hasil.tanggal} (${hasil.sumber}) — FTP ${kanal(hasil.ftp)}, email ${kanal(hasil.email)}`,
        text: [`Tanggal laporan: ${hasil.tanggal} (bulan berjalan s.d. tanggal ini)`, `Sumber: ${hasil.sumber}`, `Status: ${hasil.status}`,
            hasil.baris && `Baris: ${hasil.baris.sales} penjualan (${hasil.baris.faktur} faktur, ${hasil.baris.retur} retur), ${hasil.baris.stok} stok`,
            hasil.ftp && `FTP: ${hasil.ftp}`, hasil.email && `Email ABCPI: ${hasil.email}`,
            ...hasil.galat.map((g) => `Galat: ${g}`), ...hasil.peringatan.map((p) => `Peringatan: ${p}`),
            hasil.status !== "terkirim" && `Cron mengulang pukul 21.00 dan 22.00 WITA untuk kanal yang gagal, atau kirim manual dari ${WEB}.`,
        ].filter(Boolean).join("\n") }).catch(() => undefined);
}

/** 20 putaran terakhir (log.jsonl) untuk riwayat di layar. */
export async function riwayatAbcpi() {
    const teks = await readFile(path.join(DIR, "log.jsonl"), "utf8").catch(() => "");
    return teks.trim().split("\n").filter(Boolean).slice(-20).reverse()
        .map((l) => urai<(HasilAbcpi & { waktu: string }) | null>(l, null)).filter((r) => r !== null);
}
