/*
 * Tujuan: Faktur (INV) + retur (RJN) Accurate cabang ABC dan stok → baris laporan harian ABCPI sesuai template ABCPI.xlsx
 *   (sheet "Template SO" 41 kolom dan "Template Stok"), plus CSV pipe untuk FTP ABC (pengganti otomasi Excel lokal).
 * Caller: lib/abcpi/jalankan.ts; uji lib/abcpi/laporan.test.ts.
 * Dependensi: peta-barang.json (kode barang → [kode principle, isi]; daftar harga sheet "ABC PI" Okt 2026, null = non-produk).
 * Main Functions: barisSales, barisStok, keCsv, rincianDiskon, mingguExcel, akhirBulan.
 * Side Effects: tidak ada (murni).
 * Aturan pemilik (26 Okt 2026): diskon bertingkat dipecah per tingkat ke Disc1..5_Ext (Internal 0); EC = 1 di baris barang
 *   pertama tiap faktur; retur RSJ tidak ikut; isi bulan berjalan s.d. tanggal laporan.
 */
import petaBarang from "./peta-barang.json";

export const KOLOM_SO = ["DistID", "NoOrder", "TglOrder", "Tipe", "NoInv", "Tgl", "DueDate", "SlsID", "SlsNm", "SlsOpr", "CustID", "CustNm",
    "Alamat", "EC", "PcDist", "PCode", "NmProduk", "InPcs", "SPrice1", "SPrice2", "Qty", "Disc1_Int", "Disc2_Int", "Disc3_Int", "Disc4_Int",
    "Disc5_Int", "Disc_Int", "Disc1_Ext", "Disc2_ext", "Disc3_Ext", "Disc4_Ext", "Disc5_Ext", "Disc_Ext", "TotDisc", "JumJ", "DPP", "PPN", "NET",
    "Pkn", "Bln", "Thn"] as const;
export const KOLOM_STOK = ["DistID", "Tanggal", "Nama Barang", "PcDist", "Pcode", "Stock_Baik", "Stock_BS", "Stock_Exp"] as const;
export type Baris = Record<string, string | number>;

const DIST_ID = "SP";
// SlsOpr: 01 Taking Order, 02 Canvas, 03 Shopsales (aturan otomasi lama, config.py SLSOPR_MAP).
const SLS_OPR: Record<string, string> = { "M-SP10": "03" };

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const angka = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
/** Teks aman untuk CSV pipe: tanpa koma, pipe, dan baris baru (sama dengan clean_text otomasi lama). */
export const teks = (v: unknown) => String(v ?? "").replace(/,/g, ".").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
/** dd/MM/yyyy (Accurate) → yyyy-MM-dd; selain itu "". */
export const isoDariAccurate = (v: unknown) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? "").trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

/** WEEKNUM(tanggal; 1) Excel: minggu mulai Minggu, minggu 1 memuat 1 Januari. */
export function mingguExcel(iso: string) {
    const t = new Date(`${iso}T00:00:00Z`);
    const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.floor(((t.getTime() - jan1.getTime()) / 86_400_000 + jan1.getUTCDay()) / 7) + 1;
}

/** true bila besok sudah bulan lain (laporan closing → ditahan, kirim manual). */
export const akhirBulan = (iso: string) => {
    const t = new Date(`${iso}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.getUTCDate() === 1;
};

/**
 * Potongan bertingkat "1+1.25" atas `bruto` → 5 nominal (tingkat 6 dst. digabung ke tingkat 5). Jumlahnya dipaksa sama
 * dengan `total` (itemCashDiscount Accurate) — selisih pembulatan masuk tingkat terakhir; tanpa persen → seluruhnya tingkat 1.
 */
export function rincianDiskon(bruto: number, persen: unknown, total: number): number[] {
    const tingkat = [0, 0, 0, 0, 0];
    if (!total) return tingkat;
    const p = String(persen ?? "").split("+").map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && x > 0);
    let sisa = bruto, terakhir = 0;
    p.forEach((x, i) => {
        const nilai = sisa * x / 100;
        sisa -= nilai;
        terakhir = Math.min(i, 4);
        tingkat[terakhir] += nilai;
    });
    tingkat[terakhir] += total - tingkat.reduce((a, b) => a + b, 0);
    return tingkat;
}

export type Peta = { kode: string; isi: number } | null;
const PETA = petaBarang as unknown as Record<string, [string, number] | null>;
/** Kode principle: daftar harga dulu, lalu charField3 master barang Accurate. undefined = belum dikenal; null = dilewati. */
export function petaDari(kode: string, item: Obj): Peta | undefined {
    const p = PETA[kode];
    if (p === null) return null;
    if (p) return { kode: p[0], isi: p[1] };
    const cf3 = String(item.charField3 ?? "").trim();
    if (cf3 && angka(item.ratio2) > 0) return { kode: cf3, isi: angka(item.ratio2) };
    return undefined;
}
export const barangAbc = (kode: string, item: Obj) => kode in PETA ||/ABC PRESIDENT/i.test(String(item.charField1 ?? ""));

/** Faktur dan retur (jawaban detail.do) → baris "Template SO". Retur bernomor RSJ dan faktur non-INV dibuang di sini juga. */
export function barisSales(faktur: unknown[], retur: unknown[]) {
    const baris: Baris[] = [];
    const galat = new Set<string>();
    const dok = [...faktur.map((f) => ({ f: o(f), retur: false })), ...retur.map((f) => ({ f: o(f), retur: true }))];
    for (const { f, retur: isRetur } of dok) {
        const nomor = teks(f.number);
        if (isRetur ? nomor.toUpperCase().startsWith("RSJ") : !nomor.toUpperCase().startsWith("INV/")) continue;
        const tgl = isoDariAccurate(f.transDate);
        if (!tgl) { galat.add(`${nomor}: tanggal transaksi tidak terbaca (${String(f.transDate)})`); continue; }
        const cust = o(f.customer);
        const namaCust = teks(cust.name);
        const custId = /\{([^}]+)\}\s*$/.exec(String(cust.name ?? ""))?.[1].trim() ?? teks(cust.customerNo).replace(/-[A-Z0-9]{2,4}$/, "");
        const rinci = (Array.isArray(f.detailItem) ? f.detailItem as unknown[] : []).map(o).sort((a, b) => angka(a.seq) - angka(b.seq));
        let ec = isRetur ? 0 : 1;
        for (const d of rinci) {
            const item = o(d.item);
            const kode = teks(item.no ?? d.itemNo);
            if (!barangAbc(kode, item)) continue;
            const peta = petaDari(kode, item);
            if (peta === null) continue;
            if (!peta) { galat.add(`Barang ${kode} (${teks(item.name ?? d.detailName)}) belum punya kode principle ABCPI. Tambahkan di daftar harga/peta-barang`); continue; }
            const tanda = isRetur ? -1 : 1;
            const rasio = angka(d.unitRatio) || 1;
            const qty = angka(d.quantity) * rasio;
            const hargaPcs = angka(d.unitPrice) / rasio;
            const bruto = d.grossAmount === undefined ? angka(d.quantity) * angka(d.unitPrice) : angka(d.grossAmount);
            // Faktur tanpa pajak (taxable=false, mis. INV/2610/AB00381): dppAmount 0 → DPP = totalPrice (bruto − potongan).
            const dpp = angka(d.dppAmount) || angka(d.totalPrice), ppn = angka(d.tax1Amount);
            const bonus = Math.abs(dpp) < 0.005; // freegoods: nilai 0, qty tetap (catatan template)
            const disc = bonus ? [0, 0, 0, 0, 0] : rincianDiskon(bruto, d.itemDiscPercent, angka(d.itemCashDiscount)).map((x) => x * tanda);
            const sales = o(Array.isArray(d.salesmanList) ? d.salesmanList[0] : undefined);
            const slsId = teks(sales.number);
            const so = o(d.salesOrder);
            const r: Baris = {
                DistID: DIST_ID, NoOrder: teks(so.number) || nomor, TglOrder: isoDariAccurate(so.transDate) || tgl,
                Tipe: bonus ? "B" : isRetur ? "R" : "F", NoInv: nomor, Tgl: tgl, DueDate: isRetur ? "" : isoDariAccurate(f.dueDate),
                SlsID: slsId, SlsNm: teks(d.salesmanName ?? sales.name ?? f.masterSalesmanName), SlsOpr: SLS_OPR[slsId] ?? "01",
                CustID: custId, CustNm: namaCust, Alamat: teks(f.toAddress), EC: String(ec),
                PcDist: kode, PCode: peta.kode, NmProduk: teks(item.name ?? d.detailName), InPcs: peta.isi,
                SPrice1: hargaPcs * peta.isi, SPrice2: hargaPcs, Qty: qty * tanda,
                Disc1_Int: 0, Disc2_Int: 0, Disc3_Int: 0, Disc4_Int: 0, Disc5_Int: 0, Disc_Int: 0,
                Disc1_Ext: disc[0], Disc2_ext: disc[1], Disc3_Ext: disc[2], Disc4_Ext: disc[3], Disc5_Ext: disc[4],
                Disc_Ext: disc.reduce((a, b) => a + b, 0), TotDisc: disc.reduce((a, b) => a + b, 0),
                JumJ: bonus ? 0 : bruto * tanda, DPP: bonus ? 0 : dpp * tanda, PPN: bonus ? 0 : ppn * tanda, NET: bonus ? 0 : (dpp + ppn) * tanda,
                Pkn: String(mingguExcel(tgl)).padStart(2, "0"), Bln: tgl.slice(5, 7), Thn: tgl.slice(0, 4),
            };
            ec = 0;
            baris.push(r);
        }
    }
    return { baris, galat: [...galat] };
}

/** Stok per barang (satuan terkecil): Baik = semua gudang − GD0BS, BS = GD0BS, Exp = 0 (aturan otomasi lama). */
export function barisStok(tanggal: string, stok: Array<{ no: string; nama: string; total: number; bs: number; peta: Peta | undefined }>) {
    const baris: Baris[] = [];
    const lewat: string[] = [];
    for (const s of [...stok].sort((a, b) => a.no.localeCompare(b.no))) {
        if (s.peta === null || (!s.total && !s.bs)) continue;
        if (!s.peta) { lewat.push(`${s.no} (${teks(s.nama)})`); continue; }
        baris.push({ DistID: DIST_ID, Tanggal: tanggal, "Nama Barang": teks(s.nama), PcDist: s.no, Pcode: s.peta.kode,
            Stock_Baik: Math.round(s.total - s.bs), Stock_BS: Math.round(s.bs), Stock_Exp: 0 });
    }
    return { baris, lewat };
}

/** Angka CSV: titik desimal, maks 3 desimal, tanpa nol buntut (fmt_num otomasi lama). */
const angkaCsv = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));

/** CSV pipe + CRLF, tanpa tanda kutip (format yang diterima FTP ABC sejak Juni 2026). */
export function keCsv(kolom: readonly string[], baris: Baris[]) {
    const sel = (v: string | number | undefined) => (typeof v === "number" ? angkaCsv(Object.is(v, -0) ? 0 : v) : teks(v));
    return [kolom.join("|"), ...baris.map((r) => kolom.map((k) => sel(r[k])).join("|"))].join("\r\n") + "\r\n";
}
