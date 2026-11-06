/*
 * Tujuan: Laporan harian Puratos (pengganti SalesSync / sales_sync.exe di laptop) — tarik faktur + retur cabang PURATOS 45 hari dan stok
 *   GD01+GDLJ per tanggal dari Accurate, susun 5 CSV (lib/puratos/laporan), kirim satu per satu ke server Puratos, arsip + status per
 *   tanggal, kabari admin. Excel (Sales_report/Stok_report) tidak dibuat — owner 6 Nov 2026: cukup 5 CSV.
 * Protokol (dibaca dari sales_sync.exe 1.0.0, 6 Nov 2026): POST multipart ke http://puratos-eu.spot2d.com/upload/auto, field `__login`,
 *   `__password`, berkas `ufile` (nama tanpa .csv, text/plain), tanpa ikut redirect; sukses = HTTP 200 + jawaban memuat "was accepted".
 * Caller: app/api/cron/puratos-harian (10.00 WITA, tanggal laporan H-1; 11.00/12.00 hanya mengirim ulang berkas yang gagal dari arsip).
 * Dependensi: lib/puratos/{laporan,lama.json}, lib/accurate-baca (jatah laju bersama), resolveSyncCredentials, lib/email.
 *   Konfigurasi di volume data (bukan env Coolify, tertimpa tiap deploy): data/puratos/config.json { "login", "password", "adminEmail", "url"? };
 *   data/puratos/pelanggan-lama.json { kode: [nama, alamat] } (opsional; data pribadi tidak masuk repo publik).
 * Main Functions: jalankanPuratos, kumpulkan.
 * Side Effects: HTTP baca Accurate (list.do/detail.do/list-stock.do); POST ke server Puratos; tulis data/puratos/<tanggal>/*,
 *   data/puratos/log.jsonl; email admin.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { ambil, daftar, hariIniWita, keAccurate, rincian, type Obj } from "@/lib/accurate-baca";
import type { AccurateCredentials } from "@/lib/sync";
import { sendEmail } from "@/lib/email";
import lama from "./lama.json";
import { NAMA_BERKAS, pcsPerSatuanDasar, periode, susun, tgl, kodePelanggan, type Baris, type Data } from "./laporan";

const URL_PURATOS = "http://puratos-eu.spot2d.com/upload/auto";
const CABANG = "PURATOS", PRINCIPAL = "PURATOS", GUDANG = ["GD01", "GDLJ"]; // GD0BS = gudang rusak, tidak dihitung
const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "puratos");

type Config = { login: string; password: string; adminEmail: string; url?: string };
type Status = { dibuat?: string; berkas: Record<string, { waktu: string; jawaban: string }> };
export type HasilPuratos = {
    tanggal: string; sumber: "cron" | "manual"; status: "terkirim" | "sebagian" | "gagal" | "dilewati" | "pratinjau";
    ringkasan?: Record<string, number>; terkirim: string[]; galat: string[]; peringatan: string[];
};

const urai = <T>(teks: string, cadangan: T): T => { try { return JSON.parse(teks) as T; } catch { return cadangan; } };

async function konfigurasi(): Promise<Config> {
    // Pesan JSON.parse memuat potongan isi berkas (kata sandi) — jangan diteruskan ke log/email.
    const c = urai<Partial<Config>>(await readFile(path.join(DIR, "config.json"), "utf8").catch(() => ""), {});
    if (!c.login || !c.password || !c.adminEmail) throw new Error("data/puratos/config.json belum lengkap (login, password, adminEmail)");
    return c as Config;
}

/** Kerja paralel terbatas (jatah laju tetap diatur giliran() di lib/accurate-baca). */
async function paralel<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(xs.length);
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { for (let k = i++; k < xs.length; k = i++) out[k] = await f(xs[k]); }));
    return out;
}

/**
 * Stok per tanggal per gudang. list-stock.do (asOfDate, warehouseName) tak bisa disaring per barang dan maks 100 baris/halaman
 * (4.000+ barang), tetapi urut kode bawaan (no;id) mengumpulkan barang Puratos di beberapa halaman: baca penuh sekali, lalu tiap
 * tanggal×gudang hanya halaman itu; bila ada barang Puratos tak terbaca (urutan bergeser), tanggal×gudang itu dibaca penuh.
 */
async function stok(creds: AccurateCredentials, hari: string[], nos: Set<string>, pcs: Map<string, number>) {
    const halaman = async (p: Record<string, string>, nomor: number) =>
        await ambil(creds, "/item/list-stock.do", { ...p, "sp.page": String(nomor), "sp.pageSize": "100" }) as { d?: Obj[]; sp?: Obj };
    const penuh = async (p: Record<string, string>) => {
        const pertama = await halaman(p, 1);
        const sisa = await paralel(Array.from({ length: Math.max(0, Number(pertama.sp?.pageCount ?? 1) - 1) }, (_, i) => i + 2), 4, (h) => halaman(p, h));
        return [pertama, ...sisa].flatMap((b) => b.d ?? []);
    };
    const awal = await penuh({ asOfDate: keAccurate(hari.at(-1)!), warehouseName: GUDANG[0] });
    const hal = [...new Set(awal.flatMap((r, i) => (nos.has(String(r.no)) ? [Math.floor(i / 100) + 1] : [])))];
    const hasil = new Map<string, number>();
    await paralel(GUDANG.flatMap((g) => hari.map((d) => [g, d] as const)), 4, async ([g, d]) => {
        const p = { asOfDate: keAccurate(d), warehouseName: g };
        let rows = (await Promise.all(hal.map((h) => halaman(p, h)))).flatMap((b) => b.d ?? []);
        if (![...nos].every((no) => rows.some((r) => String(r.no) === no))) rows = await penuh(p);
        for (const r of rows) {
            const no = String(r.no);
            if (nos.has(no)) hasil.set(`${d}|${no}`, (hasil.get(`${d}|${no}`) ?? 0) + (Number(r.quantity) || 0) * pcs.get(no)!);
        }
    });
    return hasil;
}

/** Data Accurate → masukan laporan (baca saja). */
export async function kumpulkan(creds: AccurateCredentials, tanggal: string): Promise<{ data: Data; dokumen: { faktur: number; retur: number } }> {
    const hari = periode(tanggal);
    const items = await daftar(creds, "/item/list.do", { fields: "id,no,name,charField1,charField2,unit1" });
    const pur = items.filter((i) => `${i.charField1 ?? ""} ${i.charField2 ?? ""}`.toUpperCase().includes(PRINCIPAL));
    if (!pur.length) throw new Error(`Tidak ada barang berprincipal ${PRINCIPAL} (charField1/charField2) di master Accurate`);
    const barang = new Map(pur.map((i) => [String(i.no), String(i.name ?? "")]));
    const pcs = new Map(pur.map((i) => [String(i.no), pcsPerSatuanDasar(String(i.name ?? ""), String((i.unit1 as Obj | null)?.name ?? ""))]));
    const nos = new Set(barang.keys());
    const mapping = new Map<string, { kode?: string; kg?: number }>(Object.entries(lama.gramasi).map(([no, kg]) => [no, { kg }]));
    for (const [no, [nama, kode]] of Object.entries(lama.barang)) {
        if (!barang.has(no)) { barang.set(no, nama); mapping.set(no, { ...mapping.get(no), kode }); } // barang lama: stok 0
    }

    const cabang = (await daftar(creds, "/branch/list.do", { fields: "id,name" })).find((b) => String(b.name).toUpperCase() === CABANG)?.id;
    if (!cabang) throw new Error(`Cabang ${CABANG} tidak ditemukan di Accurate`);
    const per = { "filter.branchId": String(cabang), "filter.transDate.op": "BETWEEN", "filter.transDate.val[0]": keAccurate(hari[0]), "filter.transDate.val[1]": keAccurate(tanggal) };
    const fakturList = await daftar(creds, "/sales-invoice/list.do", { ...per, fields: "id,number" });
    const returList = await daftar(creds, "/sales-return/list.do", { ...per, fields: "id,number" }); // termasuk RSJ (contoh Puratos)
    const dok = [...(await rincian(creds, "/sales-invoice/detail.do", fakturList.map((r) => r.id))).map((d) => [d as Obj, 1] as const),
        ...(await rincian(creds, "/sales-return/detail.do", returList.map((r) => r.id))).map((d) => [d as Obj, -1] as const)];

    const baris: Baris[] = [];
    const pelangganId = new Map<string, unknown>(), salesman = new Map<string, string>();
    for (const [x, tanda] of dok) {
        if (/batal/i.test(String(x.statusName ?? ""))) continue;
        const c = (x.customer ?? {}) as Obj;
        const plg = kodePelanggan(c.customerNo, c.name);
        pelangganId.set(plg, x.customerId ?? c.id);
        for (const li of (x.detailItem as Obj[] | undefined) ?? []) {
            const no = String((li.item as Obj | undefined)?.no ?? "");
            if (!nos.has(no)) continue;
            const sm = ((li.salesmanList as Obj[] | undefined) ?? [])[0] ?? {};
            if (sm.number) salesman.set(String(sm.number), String(sm.name ?? li.salesmanName ?? ""));
            const nilai = Number(li.dppAmount ?? li.totalPrice ?? 0) + Number(li.tax1Amount ?? 0);
            baris.push({ tanggal: String(x.transDate).split("/").reverse().join("-"), faktur: String(x.number), pelanggan: plg, salesman: String(sm.number ?? ""),
                barang: no, qty: tanda * Number(li.quantityDefault ?? 0) * pcs.get(no)!, nilai: tanda * nilai });
        }
    }
    // ttoptions/ta = semua yang PERNAH bertransaksi di cabang PURATOS (list.do memuat customer & masterSalesman tanpa detail.do).
    for (const jalur of ["/sales-invoice/list.do", "/sales-return/list.do"]) {
        for (const x of await daftar(creds, jalur, { "filter.branchId": String(cabang), fields: "id,customer,masterSalesman" })) {
            const c = (x.customer ?? {}) as Obj, ms = (x.masterSalesman ?? {}) as Obj;
            if (c.id && !pelangganId.has(kodePelanggan(c.customerNo, c.name))) pelangganId.set(kodePelanggan(c.customerNo, c.name), c.id);
            if (ms.number && !salesman.has(String(ms.number))) salesman.set(String(ms.number), String(ms.name ?? ""));
        }
    }
    const ids = [...pelangganId].filter(([, id]) => id);
    const detail = await rincian(creds, "/customer/detail.do", ids.map(([, id]) => id));
    const pelanggan = new Map<string, [string, string, string]>(ids.map(([kode], i) => {
        const c = (detail[i] ?? {}) as Obj;
        return [kode, [String(c.name ?? ""), String(c.billStreet || c.shipStreet || ""), String(c.billCity || c.shipCity || "")]];
    }));
    // Pelanggan yang pernah dilaporkan tetapi tak punya transaksi cabang PURATOS lagi: data pribadi → volume, bukan repo publik.
    const pelangganLama = urai<Record<string, [string, string]>>(await readFile(path.join(DIR, "pelanggan-lama.json"), "utf8").catch(() => ""), {});
    for (const [kode, [nama, alamat]] of Object.entries(pelangganLama)) if (!pelanggan.has(kode)) pelanggan.set(kode, [nama, alamat, ""]);
    for (const e of await daftar(creds, "/employee/list.do", { fields: "id,number,name" })) { // nama salesman terbaru
        if (salesman.has(String(e.number)) && e.name) salesman.set(String(e.number), String(e.name));
    }

    return { data: { tanggal, barang, baris, stok: await stok(creds, hari, nos, pcs), pelanggan, salesman, mapping },
        dokumen: { faktur: fakturList.length, retur: returList.length } };
}

/** Satu berkas ke server Puratos, persis sales_sync.exe. */
async function kirimBerkas(cfg: Config, nama: string, isi: Buffer): Promise<string> {
    const form = new FormData();
    form.append("__login", cfg.login);
    form.append("__password", cfg.password);
    form.append("ufile", new Blob([new Uint8Array(isi)], { type: "text/plain" }), nama.replace(/\.csv$/, ""));
    const res = await fetch(cfg.url || URL_PURATOS, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const teks = (await res.text().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 300);
    if (res.status !== 200) throw new Error(`${nama}: HTTP ${res.status}${res.headers.get("location") ? ` → ${res.headers.get("location")}` : ""} ${teks}`);
    if (!teks.toLowerCase().includes("was accepted")) throw new Error(`${nama}: server tidak mengonfirmasi ("${teks}")`);
    return teks;
}

let berjalan = false; // satu proses Node per container: cron dan pemanggilan manual tidak boleh menumpuk

/**
 * pratinjau: susun saja (tanpa simpan/kirim). Cron: berkas tersimpan untuk tanggal itu dikirim ulang hanya yang belum diterima
 * (11.00/12.00), semua sudah diterima → dilewati. ulang (manual): tarik ulang dari Accurate dan kirim kelima berkas lagi.
 */
export async function jalankanPuratos({ tanggal, sumber, pratinjau = false, ulang = false }:
    { tanggal: string; sumber: "cron" | "manual"; pratinjau?: boolean; ulang?: boolean }): Promise<HasilPuratos> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal) || tanggal > hariIniWita()) throw new Error(`Tanggal tidak sah: ${tanggal}`);
    if (berjalan) throw new Error("Laporan Puratos sedang diproses; coba lagi beberapa menit lagi.");
    berjalan = true;
    const folder = path.join(DIR, tanggal), berkasStatus = path.join(folder, "status.json");
    const hasil: HasilPuratos = { tanggal, sumber, status: "gagal", terkirim: [], galat: [], peringatan: [] };
    let cfg: Config | null = null;
    try {
        let status = urai<Status>(await readFile(berkasStatus, "utf8").catch(() => ""), { berkas: {} });
        if (!pratinjau && !ulang && NAMA_BERKAS.every((n) => status.berkas[n])) { hasil.status = "dilewati"; return hasil; }
        cfg = pratinjau ? null : await konfigurasi();
        let berkas: Record<string, Buffer> | null = null;
        if (!pratinjau && !ulang && status.dibuat) {
            const isi = await Promise.all(NAMA_BERKAS.map((n) => readFile(path.join(folder, n)).catch(() => null)));
            if (isi.every(Boolean)) berkas = Object.fromEntries(NAMA_BERKAS.map((n, i) => [n, isi[i]!]));
        }
        if (!berkas) {
            const accurate = await resolveSyncCredentials();
            if (!accurate.creds) throw new Error(accurate.error);
            const { data, dokumen } = await kumpulkan(accurate.creds, tanggal);
            const h = susun(data);
            hasil.ringkasan = { ...h.ringkasan, ...dokumen };
            hasil.peringatan.push(...h.peringatan);
            if (h.galat.length) { hasil.galat.push(...h.galat); throw new Error("Validasi gagal, tidak dikirim ke Puratos"); }
            if (!h.ringkasan.sku) throw new Error("sku.csv kosong. Sesi Accurate membuka database yang salah? Tidak dikirim");
            if (pratinjau) { hasil.status = "pratinjau"; return hasil; }
            await mkdir(folder, { recursive: true });
            await Promise.all(NAMA_BERKAS.map((n) => writeFile(path.join(folder, n), h.berkas[n])));
            berkas = h.berkas;
            status = { dibuat: new Date().toISOString(), berkas: {} };
            await writeFile(berkasStatus, JSON.stringify(status, null, 1));
        }
        // Status disimpan segera sesudah tiap berkas diterima: putaran yang terputus (deploy) tidak mengirim ulang berkas itu.
        for (const n of NAMA_BERKAS) {
            if (status.berkas[n]) { hasil.terkirim.push(n); continue; }
            try {
                status.berkas[n] = { waktu: new Date().toISOString(), jawaban: await kirimBerkas(cfg!, n, berkas[n]) };
                await writeFile(berkasStatus, JSON.stringify(status, null, 1));
                hasil.terkirim.push(n);
            } catch (e) { hasil.galat.push((e as Error).message); }
        }
        hasil.status = hasil.terkirim.length === NAMA_BERKAS.length ? "terkirim" : hasil.terkirim.length ? "sebagian" : "gagal";
        return hasil;
    } catch (e) {
        hasil.galat.push((e as Error).message);
        hasil.status = "gagal";
        return hasil;
    } finally {
        berjalan = false;
        if (!pratinjau && hasil.status !== "dilewati") await catat(hasil, cfg?.adminEmail, folder);
    }
}

/** Jejak putaran (data/puratos/log.jsonl) + kabar ke admin dengan 5 CSV terlampir bila ada. */
async function catat(hasil: HasilPuratos, adminEmail: string | undefined, folder: string) {
    await mkdir(DIR, { recursive: true }).catch(() => undefined);
    await appendFile(path.join(DIR, "log.jsonl"), `${JSON.stringify({ waktu: new Date().toISOString(), ...hasil })}\n`).catch(() => undefined);
    const admin = adminEmail || await konfigurasi().then((c) => c.adminEmail, () => "");
    if (!admin) return;
    const lampiran = (await Promise.all(NAMA_BERKAS.map(async (n) => {
        const content = await readFile(path.join(folder, n)).catch(() => null);
        return content ? [{ filename: n as string, content, contentType: "text/csv" }] : [];
    }))).flat();
    const r = hasil.ringkasan;
    await sendEmail({ to: admin, subject: `[Puratos] ${hasil.status.toUpperCase()} ${tgl(hasil.tanggal)} (${hasil.sumber}): ${hasil.terkirim.length}/5 berkas diterima`,
        attachments: lampiran,
        text: [`Tanggal laporan: ${tgl(hasil.tanggal)} (periode 45 hari ${tgl(periode(hasil.tanggal)[0])} s/d ${tgl(hasil.tanggal)})`, `Status: ${hasil.status}`,
            r && `Baris: sku ${r.sku}, delivery ${r.delivery} (${r.barisAsli} asli dari ${r.faktur} faktur + ${r.retur} retur), stocks ${r.stocks}, ttoptions ${r.ttoptions}, ta ${r.ta}`,
            r && `Nilai 45 hari Rp ${r.nilai.toLocaleString("id-ID")}, ${r.kg.toLocaleString("id-ID")} kg; stok ${tgl(hasil.tanggal)} ${r.stokKgD.toLocaleString("id-ID")} kg`,
            `Diterima server Puratos: ${hasil.terkirim.join(", ") || "-"}`,
            ...hasil.galat.map((g) => `Galat: ${g}`), ...hasil.peringatan.map((p) => `Peringatan: ${p}`),
            hasil.status !== "terkirim" && "Cron mengulang pukul 11.00 dan 12.00 WITA untuk berkas yang belum diterima.",
        ].filter(Boolean).join("\n") }).catch(() => undefined);
}
