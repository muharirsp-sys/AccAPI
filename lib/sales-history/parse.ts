/*
 * Tujuan: Parser CSV e-Faktur DJP (multi-record FK/FAPR/OF) → baris item flat untuk Sales History.
 * Caller: app/api/sales-history/import/route.ts (streaming), self-check demo().
 * Main Functions: splitCsvLine, parseIdrDate, parseFkContext, parseOfItem, parseEfakturLines.
 * Side Effects: Tidak ada untuk parser; self-check hanya menulis hasil demo ke console saat file dijalankan langsung.
 * Dependensi: TIDAK ADA (pure) — sengaja bebas import agar bisa di-test di mana saja.
 * Catatan struktur file aktual (sumber kebenaran, bukan PRD):
 *   - 3 baris legenda di atas (FK/LT/OF) = definisi layout, BUKAN data → di-skip via validasi.
 *   - Pola data: 1 FK (header faktur) → 1 FAPR (penjual=kita, diabaikan) → N OF (item).
 *   - Tanggal DD/MM/YYYY. Angka pakai titik desimal, tanpa pemisah ribuan. Diskon hanya Rp. CSV tidak punya satuan, jadi diisi kosong.
 */

export type SalesHistoryItemInput = {
    referensi: string;       // FK[18] — no internal INV/2508/CS0003 (kunci cascade)
    nomorFaktur: string;     // FK[3]  — no faktur pajak
    tanggal: string;         // ISO yyyy-mm-dd (dari FK[6] DD/MM/YYYY)
    customerNama: string;    // FK[8]
    customerNpwp: string;    // FK[7]
    kodeObjek: string;       // OF[1]
    namaProduk: string;      // OF[2]
    qty: number;             // OF[4]
    satuan: string;          // CSV e-Faktur tidak punya satuan
    hargaSatuan: number;     // OF[3]
    hargaTotal: number;      // OF[5] (bruto)
    diskonRp: number;        // OF[6]
    dpp: number;             // OF[7]
    ppn: number;             // OF[8]
};

export type FkContext = {
    referensi: string;
    nomorFaktur: string;
    tanggal: string;
    customerNama: string;
    customerNpwp: string;
};

// Split satu baris CSV jadi field. Menangani quote ganda ("") dan koma di dalam quote.
// ponytail: tidak menangani newline di dalam field — e-Faktur 1 record per baris. Naikkan ke
// parser CSV penuh kalau ketemu field multi-baris.
export function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ",") { out.push(cur); cur = ""; }
            else cur += ch;
        }
    }
    out.push(cur);
    return out;
}

// "27/01/2022" -> "2022-01-27"; null kalau bukan tanggal valid (mis. baris legenda "TANGGAL_FAKTUR").
export function parseIdrDate(s: string): string | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const d = Number(dd), mo = Number(mm);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return `${yyyy}-${mm}-${dd}`;
}

export function num(s: string | undefined): number {
    const n = parseFloat(String(s ?? "").trim());
    return Number.isFinite(n) ? n : 0;
}

// FK row -> konteks faktur. null kalau baris legenda / tanggal invalid (otomatis skip header).
export function parseFkContext(fields: string[]): FkContext | null {
    const tanggal = parseIdrDate(fields[6] ?? "");
    if (!tanggal) return null; // baris legenda atau FK rusak
    const referensi = (fields[18] ?? "").trim();
    return {
        referensi,
        nomorFaktur: (fields[3] ?? "").trim(),
        tanggal,
        customerNama: (fields[8] ?? "").trim(),
        customerNpwp: (fields[7] ?? "").trim(),
    };
}

// OF row + konteks FK aktif -> item. null kalau legenda / qty&harga non-numerik / tanpa konteks.
export function parseOfItem(fields: string[], ctx: FkContext | null): SalesHistoryItemInput | null {
    if (!ctx) return null;
    const qtyRaw = (fields[4] ?? "").trim();
    // Baris legenda OF: kolom JUMLAH_BARANG berisi teks "JUMLAH_BARANG" -> bukan angka -> skip.
    if (qtyRaw === "" || !/^-?\d/.test(qtyRaw)) return null;
    return {
        ...ctx,
        kodeObjek: (fields[1] ?? "").trim(),
        namaProduk: (fields[2] ?? "").trim(),
        qty: num(fields[4]),
        satuan: "",
        hargaSatuan: num(fields[3]),
        hargaTotal: num(fields[5]),
        diskonRp: num(fields[6]),
        dpp: num(fields[7]),
        ppn: num(fields[8]),
    };
}

// Convenience non-streaming: kumpulan baris -> item. Dipakai test; route pakai loop streaming.
export function parseEfakturLines(lines: Iterable<string>): SalesHistoryItemInput[] {
    const items: SalesHistoryItemInput[] = [];
    let ctx: FkContext | null = null;
    for (const line of lines) {
        if (!line.trim()) continue;
        const fields = splitCsvLine(line);
        const tag = (fields[0] ?? "").trim();
        if (tag === "FK") ctx = parseFkContext(fields);
        else if (tag === "OF") {
            const item = parseOfItem(fields, ctx);
            if (item) items.push(item);
        }
        // FAPR / LT / lainnya: diabaikan.
    }
    return items;
}

// ponytail: self-check pakai sampel nyata (header legenda + 1 faktur + 2 item). Jalankan:
//   node --experimental-strip-types lib/sales-history/parse.ts
export function demo() {
    const assert = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); };
    const sample = [
        '"FK","KD_JENIS_TRANSAKSI","FG_PENGGANTI","NOMOR_FAKTUR","MASA_PAJAK","TAHUN_PAJAK","TANGGAL_FAKTUR","NPWP","NAMA","ALAMAT_LENGKAP","JUMLAH_DPP","JUMLAH_PPN","JUMLAH_PPNBM","ID_KETERANGAN_TAMBAHAN","FG_UANG_MUKA","UANG_MUKA_DPP","UANG_MUKA_PPN","UANG_MUKA_PPNBM","REFERENSI","KODE_DOKUMEN_PENDUKUNG"',
        '"LT","NPWP","NAMA","JALAN","BLOK","NOMOR","RT","RW","KECAMATAN","KELURAHAN","KABUPATEN","PROPINSI","KODE_POS","NOMOR_TELEPON"',
        '"OF","KODE_OBJEK","NAMA","HARGA_SATUAN","JUMLAH_BARANG","HARGA_TOTAL","DISKON","DPP","PPN","TARIF_PPNBM","PPNBM"',
        '"FK","01","0","0032210460189","1","2022","27/01/2022","026729277054000","PT. MIDI UTAMA INDONESIA","Jl. Sutera","2567459","256746","0","","0","0","0","0","INV/2201/AB0511",',
        '"FAPR","CV SURYA PERKASA","JL.TODDOPULI","FREDY TJANLISAN","KOTA MAKASSAR","20220202081436","BASE64SIG=="',
        '"OF","263010200040","ABC BVK KIN DAIRY 200ML@24 YGT STRAWBERY ""KY101702","165818.0","5.0","829090.0","26759.0","802331.0","80233.0","0","0.0"',
        '"OF","26031020450030","NU GTEA ORI 24BTL X 450ML ""BT","4737.0","24.0","113694.0","0.0","113694.0","12506.0","0","0.0"',
    ];
    const items = parseEfakturLines(sample);
    assert(items.length === 2, `harus 2 item, dapat ${items.length}`);
    assert(items[0].referensi === "INV/2201/AB0511", "referensi nyangkut dari FK");
    assert(items[0].tanggal === "2022-01-27", `tanggal ISO, dapat ${items[0].tanggal}`);
    assert(items[0].customerNama === "PT. MIDI UTAMA INDONESIA", "customer dari FK");
    assert(items[0].qty === 5 && items[0].hargaSatuan === 165818, "angka OF terparse");
    assert(items[0].namaProduk.includes('"KY101702'), "quote ganda di nama produk ter-unescape");
    assert(items[0].diskonRp === 26759, "diskon Rp terparse");
    assert(items[1].diskonRp === 0, "item kedua diskon 0");
    // Legenda tidak ikut jadi data:
    assert(!items.some((i) => i.nomorFaktur === "NOMOR_FAKTUR"), "baris legenda FK di-skip");
    console.log("OK: parse.ts demo lulus,", items.length, "item.");
}

if (process.argv[1]?.endsWith("parse.ts")) {
    demo();
}
