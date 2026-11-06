/*
 * Tujuan: Aturan murni laporan Puratos (SalesSync): 5 CSV — sku, delivery, stocks, ttoptions, ta — untuk Tanggal Laporan D
 *   (45 hari kalender D-44..D). Parser kode Puratos & gramasi dari nama barang, pembersih teks, baris DUMMY, validasi silang.
 * Caller: lib/puratos/jalankan.ts. Uji: lib/puratos/laporan.test.ts (susun ulang 5 CSV contoh 02.11.2026 byte demi byte).
 * Format (contoh Puratos): UTF-8 BOM, CRLF, pemisah ";", tanpa kutip, tanggal dd.mm.yyyy, desimal titik, kuantitas kg.
 * Side Effects: tidak ada.
 */
export const HARI = 45;
export const NAMA_BERKAS = ["delivery.csv", "sku.csv", "stocks.csv", "ta.csv", "ttoptions.csv"] as const; // urutan kirim sales_sync.exe

const SATUAN_KG: Record<string, number> = { KG: 1, KGS: 1, GR: 0.001, GRM: 0.001, G: 0.001, ML: 0.001, L: 1, LT: 1, LTR: 1 };
// (?<![\d.,]) bukan \b: nama nyata 'WIPCREAM VANILA12 PCSX400GR' menempelkan angka ke huruf.
const GRAMASI = /(?<![\d.,])(\d+)\s*([A-Z]+?)\s*X\s*(\d+(?:[.,]\d+)?)\s*(KGS|KG|GRM|GR|G|ML|LTR|LT|L)\b/;
const KARTON = new Set(["KRT", "CTN", "KARTON", "DUS", "DOS", "BOX", "BAL"]);
const KODE7 = /(?<!\d)\d{7}(?!\d)/g;

export type Baris = { tanggal: string; faktur: string; pelanggan: string; salesman: string; barang: string; qty: number; nilai: number };
/** Tanggal ISO YYYY-MM-DD. qty = satuan terkecil (pcs), nilai = DPP + PPN; retur negatif. */
export type Data = {
    tanggal: string;
    barang: Map<string, string>; // kode internal → nama (master Accurate + barang lama)
    baris: Baris[];
    stok: Map<string, number>; // `${tanggal}|${kode}` → qty pcs gudang dihitung
    pelanggan: Map<string, [nama: string, alamat: string, kota: string]>;
    salesman: Map<string, string>;
    mapping?: Map<string, { kode?: string; kg?: number }>; // menang atas hasil baca nama
};

// ---------- parser & pembersih ----------

/** Angka 7 digit sesudah kutip pertama (dua kode → yang terakhir); tak ada → angka 7 digit di mana pun ('10PCSX1KG 4026248"CS'). */
export function kodePuratos(nama: string): string | undefined {
    const i = nama.indexOf('"');
    const k = (i >= 0 ? nama.slice(i).match(KODE7) : null) ?? nama.match(KODE7);
    return k?.at(-1);
}

/** kg per pcs dari pola '<n> PCS|PCH|BAG.. X <angka><satuan>': 20 PCSX500GR → 0.5; liter dianggap kg. */
export function gramasi(nama: string): number | undefined {
    const m = GRAMASI.exec(nama.toUpperCase());
    return m ? Number(m[3].replace(",", ".")) * SATUAN_KG[m[4]] : undefined;
}

/** Qty satuan dasar Accurate → pcs: satuan dasar karton (KRT dst.) berisi n pcs menurut nama; PCS/PCH/BAG = 1. */
export function pcsPerSatuanDasar(nama: string, satuanDasar: string | undefined): number {
    const m = GRAMASI.exec(nama.toUpperCase());
    return m && KARTON.has(String(satuanDasar ?? "").toUpperCase()) ? Number(m[1]) : 1;
}

/** Teks CSV: , ; → titik, _ → spasi, buang kutip ganda, rapikan spasi & titik ganda ('TOKO A , TK' → 'TOKO A. TK'). */
export function bersih(teks: unknown): string {
    const t = String(teks ?? "").replace(/[,;]/g, ".").replaceAll("_", " ").replaceAll('"', "").replace(/\.{2,}/g, ".").replace(/\s+\./g, ".");
    return t.replace(/\s+/g, " ").trim();
}

export const bersihSalesman = (nama: unknown) => String(nama ?? "").replace(/[,;]/g, ".").trim();

/** Nama SKU: tanpa bagian kode; PRTS → PURATOS; B> / kode berakhiran B → ' (B)'. */
export function deskripsi(kode: string, nama: string): string {
    let n = nama.split('"', 1)[0].trim();
    const k = kodePuratos(nama);
    if (k && n.includes(k)) n = n.slice(0, n.lastIndexOf(k)).trim();
    const b = n.startsWith("B>") || kode.toUpperCase().endsWith("B");
    n = bersih(n.replace(/^B>/, "").trim().replace(/^PRTS\s/, "PURATOS "));
    return b && !n.endsWith("(B)") ? `${n} (B)` : n;
}

/** Buang {KODE} dan sisa sesudahnya: 'TOKO B {C-TKB001} (C.O.D)' → 'TOKO B'. */
export const namaPelanggan = (nama: string) => bersih(nama.split("{", 1)[0]);

/** customerNo tanpa akhiran cabang ('C-TKC001-PT' → 'C-TKC001'; isi {…} bisa salah ketik 'C-TKC.001'); kosong → {KODE} di nama. */
export function kodePelanggan(customerNo: unknown, nama: unknown): string {
    let no = String(customerNo ?? "").trim();
    if (no.split("-").length > 2) no = no.slice(0, no.lastIndexOf("-"));
    return no || /\{([^}]+)\}/.exec(String(nama ?? ""))?.[1].trim() || "";
}

export function alamatLengkap(alamat: string, kota: string): string {
    const a = alamat.trim(), k = kota.trim();
    return bersih(k && !a.toUpperCase().includes(k.toUpperCase()) ? `${a}, ${k}` : a);
}

/** Desimal titik, maks 3 desimal, tanpa pemisah ribuan, tanpa -0. */
export function angka(x: number): string {
    const s = x.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" || s === "" ? "0" : s;
}

/** Pembulatan bank seperti contoh 02.11.2026: 342712.5 → 342712, 2115970.5015 → 2115971. */
export function rupiah(x: number): number {
    const f = Math.floor(x), d = x - f;
    return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

/** 45 tanggal ISO D-44..D (hari kalender, Minggu & libur ikut). */
export function periode(d: string): string[] {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Array.from({ length: HARI }, (_, i) => new Date(t - (HARI - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export const tgl = (iso: string) => iso.split("-").reverse().join(".");
const urut = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // titik kode, bukan locale: sama dengan contoh

// ---------- penyusun ----------

export type Hasil = { berkas: Record<string, Buffer>; ringkasan: Record<string, number>; peringatan: string[]; galat: string[] };

const csv = (header: string, baris: string[]) => Buffer.from(`﻿${[header, ...baris].join("\r\n")}\r\n`, "utf8");

export function susun(data: Data, distributor = "113"): Hasil {
    const galat: string[] = [], peringatan: string[] = [];
    const hari = periode(data.tanggal);

    const kodeP = new Map<string, string>(), kg = new Map<string, number>();
    for (const [no, nama] of data.barang) {
        const m = data.mapping?.get(no);
        const k = m?.kode || kodePuratos(nama);
        if (k) kodeP.set(no, k);
        const g = m?.kg || gramasi(nama);
        if (g) {
            kg.set(no, g);
            // ponytail: ambang kasar; data nyata '12 PCSX500KG' (mestinya 500GR) — koreksi di lib/puratos/lama.json
            if (g > 25 && !m?.kg) peringatan.push(`Gramasi ${no} = ${g} kg/pcs dari nama, cek satuan`);
        }
    }
    const tanpaKode = [...data.barang.keys()].filter((no) => !kodeP.has(no)).sort(urut);
    if (tanpaKode.length) peringatan.push(`${tanpaKode.length} barang Puratos tanpa kode Puratos (tidak masuk sku.csv): ${tanpaKode.join(", ")}`);
    const sku = [...kodeP.keys()].sort(urut);
    const tanpaKg = [...new Set([...sku, ...data.baris.map((b) => b.barang)])].filter((no) => !kg.has(no)).sort(urut);
    if (tanpaKg.length) return { berkas: {}, ringkasan: {}, peringatan, galat: [`Gramasi tidak terbaca dari nama barang: ${tanpaKg.join(", ")}`] };

    // delivery: jumlah per (tanggal, faktur, pelanggan, salesman, barang); semua SKU bertransaksi hadir di tiap tanggal (DUMMY).
    const asli = new Map<string, { t: string; f: string; p: string; s: string; b: string; kg: number; rp: number }>();
    for (const b of data.baris) {
        const k = [b.tanggal, b.faktur, b.pelanggan, b.salesman, b.barang].join("\u0000");
        const v = asli.get(k) ?? { t: b.tanggal, f: b.faktur, p: b.pelanggan, s: b.salesman, b: b.barang, kg: 0, rp: 0 };
        v.kg += b.qty * kg.get(b.barang)!;
        v.rp += b.nilai;
        asli.set(k, v);
    }
    const skuKirim = [...new Set([...asli.values()].map((v) => v.b))].sort(urut);
    const ada = new Set([...asli.values()].map((v) => `${v.t}|${v.b}`));
    const deliv: Array<[string, string, number, string, string]> = [...asli.values()].map((v) => [v.t, v.b, 0, v.f,
        `${distributor};${v.p};${tgl(v.t)};${v.b};${angka(v.kg)};${rupiah(v.rp)};${v.s};${v.f}`]);
    for (const d of hari) for (const no of skuKirim) if (!ada.has(`${d}|${no}`)) deliv.push([d, no, 1, "", `${distributor};C-DUMMY;${tgl(d)};${no};0;0;DUMMY;0`]);
    deliv.sort((a, b) => urut(a[0], b[0]) || urut(a[1], b[1]) || a[2] - b[2] || urut(a[3], b[3]));
    const delivery = deliv.map((r) => r[4]);

    // stocks: semua SKU × 45 tanggal, 4 kolom (tanpa ; buntut walau header 5 kolom).
    const stokKg = (d: string, no: string) => (data.stok.get(`${d}|${no}`) ?? 0) * kg.get(no)!;
    const stocks = hari.flatMap((d) => sku.map((no) => `${distributor};${tgl(d)};${no};${angka(stokKg(d, no))}`));
    const skuCsv = sku.map((no) => `${distributor};${no};${deskripsi(no, data.barang.get(no)!)};${kodeP.get(no)};;3`);

    const plg = [...data.pelanggan].map(([k, [n, a, kt]]) => [k, namaPelanggan(n), alamatLengkap(a, kt)] as const).sort((x, y) => urut(x[0], y[0]));
    const tt = [...plg.map(([k, n, a]) => `${distributor};${k};${n};${a};${n};${a};`), `${distributor};C-DUMMY;DUMMY;DUMMY;DUMMY;DUMMY;`];
    const ta = [...[...data.salesman].sort((x, y) => urut(x[0], y[0])).map(([k, n]) => `${distributor};${k};${bersihSalesman(n)}`), `${distributor};DUMMY;DUMMY`];

    const berkas: Record<string, Buffer> = {
        "sku.csv": csv("Distributor's id;Distributor's product code;SKU Description;Producer's SKU code;EAN (bar code);ID units of measurement", skuCsv),
        "delivery.csv": csv("Distributor's id;Client's ERP code;Date;Distributor's product code;Quantity;Sales value;Sales agent's code;Invoice number", delivery),
        "stocks.csv": csv("Distributor's id;Date;Distributor's product code;Quantity;Expiry date", stocks),
        "ttoptions.csv": csv("Distributor's id;Client's ERP code;Client's name;Client's address;Outlet name;Outlet address;Customer type", tt),
        "ta.csv": csv("Distributor's id;Sales agent's code;Name Sales Agent", ta),
    };

    // ---------- validasi (gagal = jangan kirim), dibaca ulang dari isi CSV ----------
    const dv = delivery.map((r) => r.split(";"));
    const ttKode = new Set(tt.map((r) => r.split(";")[1])), taKode = new Set(ta.map((r) => r.split(";")[1])), skuSet = new Set(sku);
    const beda = (xs: string[], ys: Set<string>) => [...new Set(xs)].filter((x) => !ys.has(x)).sort(urut);
    if (beda(dv.map((r) => r[3]), skuSet).length) galat.push(`Barang di delivery tanpa kode Puratos (tidak ada di sku.csv): ${beda(dv.map((r) => r[3]), skuSet).join(", ")}`);
    if (beda(dv.map((r) => r[1]), ttKode).length) galat.push(`Pelanggan di delivery tidak ada di ttoptions: ${beda(dv.map((r) => r[1]), ttKode).join(", ")}`);
    if (beda(dv.map((r) => r[6]), taKode).length) galat.push(`Salesman di delivery tidak ada di ta: ${beda(dv.map((r) => r[6]), taKode).join(", ")}`);
    if (skuKirim.length && hari.some((d) => new Set(dv.filter((r) => r[2] === tgl(d)).map((r) => r[3])).size !== skuKirim.length))
        galat.push("delivery: tiap tanggal (45) harus memuat semua SKU yang bertransaksi");
    if (stocks.length !== sku.length * HARI) galat.push(`stocks: ${stocks.length} baris ≠ ${sku.length} SKU × ${HARI}`);
    for (const [nama, isi] of Object.entries(berkas)) if (isi.includes(",")) galat.push(`${nama} memuat koma`);
    for (const d of hari) {
        const src = data.baris.filter((b) => b.tanggal === d), f = dv.filter((r) => r[2] === tgl(d) && r[1] !== "C-DUMMY");
        const rpApi = src.reduce((s, b) => s + b.nilai, 0), rpFile = f.reduce((s, r) => s + Number(r[5]), 0);
        // ponytail: toleransi Rp 2 (spesifikasi) dilonggarkan 0,5/baris — pembulatan per baris faktur bisa menumpuk.
        if (Math.abs(rpApi - rpFile) > Math.max(2, 0.5 * f.length)) galat.push(`${tgl(d)}: nilai delivery Rp ${rpFile} ≠ sumber Rp ${rpApi.toFixed(2)}`);
        const kgApi = src.reduce((s, b) => s + b.qty * kg.get(b.barang)!, 0), kgFile = f.reduce((s, r) => s + Number(r[4]), 0);
        if (Math.abs(kgApi - kgFile) > 0.01 * Math.max(1, f.length)) galat.push(`${tgl(d)}: kg delivery ${kgFile} ≠ sumber ${kgApi}`);
    }

    const ringkasan = {
        sku: skuCsv.length, delivery: delivery.length, stocks: stocks.length, ttoptions: tt.length, ta: ta.length, barisAsli: asli.size,
        nilai: dv.reduce((s, r) => s + Number(r[5]), 0), kg: Math.round(dv.reduce((s, r) => s + Number(r[4]), 0) * 1000) / 1000,
        stokKgD: Math.round(sku.reduce((s, no) => s + stokKg(data.tanggal, no), 0) * 1000) / 1000,
    };
    return { berkas, ringkasan, peringatan, galat };
}
