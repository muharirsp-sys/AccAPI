/*
 * Tujuan: Satu putaran laporan Enigma (Enesis / PT Marketama Indah) — faktur INV + retur cabang MIX FOOD bulan berjalan s.d. tanggal
 *   dari Accurate (barang berpemasok Marketama), susun template_enigma.xlsx, unggah ke portal Enigma, laporkan hasilnya ke admin
 *   (validation_error beserta Detail log). Pengganti workbook manual "Format Report Enigma Enesis.xlsx" + unggah tangan.
 * Caller: app/api/cron/enigma-harian (20.30 WITA, cron VPS), app/api/laporan-harian/enigma (pratinjau/unggah manual).
 * Dependensi: lib/accurate-baca (jatah laju bersama ABCPI), lib/enigma/{laporan,portal}, resolveSyncCredentials, lib/email, xlsx.
 *   Konfigurasi di volume: data/enigma/config.json { "subdistId", "password", "adminEmail" }.
 * Main Functions: jalankanEnigma, riwayatEnigma.
 * Side Effects: HTTP baca Accurate + baca cache sales_invoice; unggah ke enigma.enesis.com; tulis data/enigma/*; kirim email admin.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { daftar, hariIniWita, keAccurate, rincian } from "@/lib/accurate-baca";
import { sendEmail } from "@/lib/email";
import { barisEnigma, KOLOM_ENIGMA, type BarisEnigma } from "./laporan";
import { unggahEnigma } from "./portal";

const CABANG_MIX_FOOD = "150"; // barang Marketama ikut cabang MIX FOOD; disaring per baris lewat pemasok (owner 26 Okt 2026)
const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "enigma");
const WEB = "https://web-super.online/laporan-harian";
const urai = <T>(teks: string, cadangan: T): T => { try { return JSON.parse(teks) as T; } catch { return cadangan; } };

async function konfigurasi() {
    // Pesan JSON.parse memuat potongan isi berkas (bisa password) — jangan diteruskan ke log/email.
    const c = urai<{ subdistId?: string; password?: string; adminEmail?: string }>(await readFile(path.join(DIR, "config.json"), "utf8").catch(() => ""), {});
    if (!c.subdistId || !c.password || !c.adminEmail) throw new Error("data/enigma/config.json belum lengkap (subdistId, password, adminEmail)");
    return { akun: { id: String(c.subdistId), password: c.password }, adminEmail: c.adminEmail };
}

/** Tarik Accurate dan susun baris Enigma (tanpa unggah). */
async function susun(tanggal: string) {
    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) throw new Error(accurate.error);
    const creds = accurate.creds;
    const periode = { "filter.branchId": CABANG_MIX_FOOD, "filter.transDate.op": "BETWEEN",
        "filter.transDate.val[0]": keAccurate(`${tanggal.slice(0, 8)}01`), "filter.transDate.val[1]": keAccurate(tanggal) };
    const fakturList = (await daftar(creds, "/sales-invoice/list.do", { fields: "id,number", ...periode })).filter((r) => String(r.number).startsWith("INV/"));
    const returList = (await daftar(creds, "/sales-return/list.do", { fields: "id,number", ...periode })).filter((r) => !String(r.number).toUpperCase().startsWith("RSJ"));
    const baris: BarisEnigma[] = [];
    const lewat = new Map<string, string>(), outletBaru = new Map<string, string>(), galat = new Set<string>();
    const tampung = (h: ReturnType<typeof barisEnigma>) => {
        baris.push(...h.baris);
        h.lewat.forEach((v, k) => lewat.set(k, v));
        h.outletBaru.forEach((v, k) => outletBaru.set(k, v));
        h.galat.forEach((g) => galat.add(g));
    };
    // detail.do semua faktur & retur MIX FOOD, 200 per potong agar memori kecil. ponytail: ±2.500 panggilan di akhir bulan (±10 menit
    // pada 4 req/dtk); cache sales_invoice tidak bisa dipakai (lihat lib/accurate-baca) — tambah versi/optLock di cache bila jadi beban.
    for (const [daftarDok, jalur, retur] of [[fakturList, "/sales-invoice/detail.do", false], [returList, "/sales-return/detail.do", true]] as const) {
        for (let i = 0; i < daftarDok.length; i += 200) tampung(barisEnigma(await rincian(creds, jalur, daftarDok.slice(i, i + 200).map((r) => r.id)), retur));
    }
    return { baris, lewat, outletBaru, galat: [...galat], dokumen: { faktur: fakturList.length, retur: returList.length } };
}

/** Satu sheet seperti template_enigma.xlsx; DATE_INVOICE = tanggal Excel (yyyymmdd), sisanya nilai apa adanya. */
function xlsx(baris: BarisEnigma[]) {
    const ws = XLSX.utils.json_to_sheet(baris, { header: [...KOLOM_ENIGMA] });
    const kolom = XLSX.utils.encode_col(KOLOM_ENIGMA.indexOf("DATE_INVOICE"));
    baris.forEach((b, i) => {
        const [y, m, d] = String(b.DATE_INVOICE).split("-").map(Number);
        ws[`${kolom}${i + 2}`] = { t: "n", v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000, z: "yyyymmdd" };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

type Status = { unggah?: { waktu: string; id: number; status: string } };
export type HasilEnigma = {
    tanggal: string; sumber: "cron" | "manual"; status: "terkirim" | "validation_error" | "dilewati" | "gagal" | "pratinjau";
    baris?: { sales: number; faktur: number; retur: number }; portal?: string; log?: string[]; galat: string[]; peringatan: string[];
};

let berjalan = false;

/**
 * kirim=false → pratinjau xlsx. Cron: tanggal yang sudah punya hasil final (success ATAU validation_error) sesudah 20.30 WITA
 * dilewati — validation_error tidak diulang otomatis (datanya perlu dibetulkan, mengulang hanya menumpuk unggahan gagal).
 * Manual: selalu unggah.
 */
export async function jalankanEnigma({ tanggal, kirim, sumber }: { tanggal: string; kirim: boolean; sumber: "cron" | "manual" }): Promise<HasilEnigma & { xlsx?: Buffer }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || tanggal > hariIniWita()) throw new Error(`Tanggal tidak sah: ${tanggal}`);
    if (berjalan) throw new Error("Laporan Enigma sedang diproses; coba lagi beberapa menit lagi.");
    berjalan = true;
    const ymd = tanggal.replaceAll("-", "");
    const folder = path.join(DIR, tanggal.slice(0, 7));
    const berkasStatus = path.join(folder, `ENIGMA_${ymd}.status.json`);
    const hasil: HasilEnigma = { tanggal, sumber, status: "gagal", galat: [], peringatan: [] };
    let adminEmail = "";
    try {
        await mkdir(folder, { recursive: true });
        const status = urai<Status>(await readFile(berkasStatus, "utf8").catch(() => "{}"), {});
        if (kirim && sumber === "cron" && status.unggah && status.unggah.waktu >= `${tanggal}T12:30:00.000Z`) {
            hasil.status = "dilewati";
            return hasil;
        }
        const cfg = kirim ? await konfigurasi() : null;
        adminEmail = cfg?.adminEmail ?? "";

        const { baris, lewat, outletBaru, galat, dokumen } = await susun(tanggal);
        hasil.baris = { sales: baris.length, faktur: dokumen.faktur, retur: dokumen.retur };
        hasil.galat = galat;
        if (lewat.size) hasil.peringatan.push(`Barang Marketama tanpa PRODUK_ID_MI tidak dilaporkan (tambahkan di lib/enigma/peta.json): ${[...lewat].map(([k, v]) => `${k} ${v}`).join("; ")}`);
        if (outletBaru.size) hasil.peringatan.push(`Pelanggan baru diberi TYPE_OUTLET "MTI OTHERS": ${[...outletBaru].map(([k, v]) => `${k} ${v}`).join("; ")}`);
        const buku = xlsx(baris);
        if (!cfg) { hasil.status = "pratinjau"; return { ...hasil, xlsx: buku }; }
        if (galat.length) throw new Error("Isian wajib Enigma kosong. Tidak diunggah");
        if (!baris.length) throw new Error("Tidak ada baris Marketama bulan ini. Tidak diunggah (cek sesi/database Accurate)");

        await writeFile(path.join(folder, `ENIGMA_${ymd}.xlsx`), buku);
        // Begitu portal menerima berkas, tandai "diproses": galat sesudahnya (status tak terbaca) tidak memicu unggah ulang oleh cron.
        const h = await unggahEnigma(cfg.akun, buku, "template_enigma.xlsx", { diterima: async () => {
            status.unggah = { waktu: new Date().toISOString(), id: 0, status: "diproses" };
            await writeFile(berkasStatus, JSON.stringify(status, null, 1));
        } });
        status.unggah = { waktu: new Date().toISOString(), id: h.id, status: h.status };
        await writeFile(berkasStatus, JSON.stringify(status, null, 1));
        hasil.portal = `unggahan ${h.id}: ${h.status}${h.keterangan ? ` (${h.keterangan})` : ""}`;
        hasil.log = h.log;
        hasil.status = h.status === "success" ? "terkirim" : "validation_error";
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

/** Jejak (data/enigma/log.jsonl) + email admin: bukti sukses, Detail log bila validation_error, penyebab bila gagal. */
async function catat(hasil: HasilEnigma, adminEmail: string) {
    await appendFile(path.join(DIR, "log.jsonl"), `${JSON.stringify({ waktu: new Date().toISOString(), ...hasil, log: hasil.log?.slice(0, 200) })}\n`).catch(() => undefined);
    const admin = adminEmail || await konfigurasi().then((c) => c.adminEmail, () => "");
    if (!admin) return;
    // Ringkas log Enigma per jenis pesan: "QTY_CRT tidak sesuai … pada baris | 56" ×173 → satu baris + daftar nomor baris.
    const kelompok = new Map<string, string[]>();
    for (const l of hasil.log ?? []) { const [pesan, no = ""] = l.split("|").map((s) => s.trim()); kelompok.set(pesan, [...(kelompok.get(pesan) ?? []), no]); }
    await sendEmail({ to: admin, subject: `[Enigma] ${hasil.status.toUpperCase()} ${hasil.tanggal} (${hasil.sumber})`,
        text: [`Laporan Enigma (Marketama Indah) bulan berjalan s.d. ${hasil.tanggal}`, `Status: ${hasil.status}`,
            hasil.baris && `Baris: ${hasil.baris.sales} (dari ${hasil.baris.faktur} faktur dan ${hasil.baris.retur} retur cabang MIX FOOD)`,
            hasil.portal && `Portal: ${hasil.portal}`,
            ...[...kelompok].map(([p, n]) => `Validasi: ${p}, ${n.length} baris (${n.slice(0, 30).join(", ")}${n.length > 30 ? ", …" : ""})`),
            ...hasil.galat.map((g) => `Galat: ${g}`), ...hasil.peringatan.map((p) => `Peringatan: ${p}`),
            hasil.status === "validation_error" && `Perbaiki data/peta lalu unggah ulang dari ${WEB} (bagian "Laporan Enigma").`,
            hasil.status === "gagal" && `Cron mengulang pukul 21.30 dan 22.30 WITA, atau unggah manual dari ${WEB}.`,
        ].filter(Boolean).join("\n") }).catch(() => undefined);
}

/** 20 putaran terakhir untuk riwayat di layar. */
export async function riwayatEnigma() {
    const teks = await readFile(path.join(DIR, "log.jsonl"), "utf8").catch(() => "");
    return teks.trim().split("\n").filter(Boolean).slice(-20).reverse()
        .map((l) => urai<(HasilEnigma & { waktu: string }) | null>(l, null)).filter((r) => r !== null);
}
