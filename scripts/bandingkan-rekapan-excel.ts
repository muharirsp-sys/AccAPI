/**
 * bandingkan-rekapan-excel.ts
 * Tujuan  : Kriteria lulus Fase 3 (PRD §6) — bandingkan hasil AccAPI dengan workbook Excel
 *           PER SKU PER GRUP, bukan grand total. Grand total bisa cocok sementara isinya
 *           bergeser: persis kasus `Print Rkpn Pagi-HNZ6` (total benar, 395 baris salah pasangan).
 * Caller  : manual, tiap hari selama shadow run.
 *   npx tsx scripts/bandingkan-rekapan-excel.ts --wave 1
 *   [--workbook "<path.xlsx>"] [--sheet "Paste Data Sore"] [--principal "HEINZ ABC"] [--grup HNZ1,HNZ6]
 * Depend. : DATABASE_URL, lib/rekapan-nota/query (jalur kode CETAK yang sebenarnya), xlsx.
 * Efek    : Baca saja. Exit 1 kalau ada selisih yang TIDAK dapat dijelaskan.
 *
 * YANG DIBANDINGKAN: hasil AccAPI vs DATA di `Paste Data Sore` (kolom bantu workbook).
 * YANG TIDAK DIBANDINGKAN: lembar `Print Rekapan Sore-*` itu sendiri. Di situlah E2/E3/E4
 * hidup (referensi sel bergeser, blok formula kependekan, filter pivot menua), jadi kertas
 * yang benar-benar sampai ke gudang MEMANG berbeda dari data yang menghasilkannya. "LULUS"
 * di sini berarti "AccAPI = Excel kalau Excel benar", bukan "AccAPI = kertas kemarin".
 *
 * Sisi Excel memakai KOLOM BANTU MILIK EXCEL SENDIRI (`Area`, `Pareto`, `Isi`, `Hasil Pcs`,
 * `Pemisahan All`, `Pemisah GDI`, `SRP/NON`) — hasil VLOOKUP/formula workbook, bukan hitungan
 * ulang skrip ini. Jadi yang diadu benar-benar dua sistem, bukan satu sistem melawan dirinya.
 * Keanggotaan grup dibaca dari `pick_group_member` di DB, sehingga kedua sisi memakai definisi
 * yang sama dan skrip ini tidak menyimpan salinan aturan yang bisa basi sendiri.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { excelDateToIso } from "../lib/excel-date";

const DEFAULT_WORKBOOK =
    "C:\\Users\\Muhar\\Downloads\\A_New Rekapan Nota 24 AGUST 2026 update.xlsx";

/** Kombinasi grup yang dibandingkan. Aturan versi SORE (kanonik, R2.4). */
const LEMBAR: Record<string, string[]> = {
    HNZ1: ["AREA-1", "VOL-NONPARETO"],
    HNZ2: ["AREA-2", "VOL-NONPARETO"],
    HNZ3: ["AREA-3", "VOL-NONPARETO"],
    HNZ4: ["AREA-4", "VOL-NONPARETO"],
    HNZ5: ["AREA-5", "VOL-NONPARETO"],
    HNZ6: ["VOL-PARETO"],
};

/** dimensi pick_group -> indeks kolom di `Paste Data Sore` (0-based). */
const KOLOM_DIMENSI: Record<string, number> = {
    area: 64,          // "Area"                <- VLOOKUP ke Master Area Heinz
    volume: 65,        // "Pareto / Non Pareto" <- IF(Total Per Nota >= 50)
    outlet_all: 69,    // "Pemisahan All"       <- VLOOKUP ke Pemisah A:C
    outlet_gdi: 70,    // "Pemisah GDI"         <- VLOOKUP ke Pemisah E:G
    sirup: 72,         // "SRP/NON"
    jenis_produk: 12,  // "JENISPRODUK"
};
const KOL_NO_NOTA = 0, KOL_TANGGAL = 1, KOL_KODE_BARANG = 7, KOL_HASIL_PCS = 63, KOL_ISI = 66;

const bersih = (v: unknown) => String(v ?? "").trim().toUpperCase();
const angka = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

type BarisExcel = {
    noNota: string; kodeBarang: string; pcs: number; isi: number;
    dimensi: Record<string, string>;
};

function argv(nama: string): string | undefined {
    const i = process.argv.indexOf(`--${nama}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function bacaExcel(workbook: string, sheet: string, tanggal: string, principal: string | null) {
    // cellDates WAJIB: tanpa itu TANGGAL kembali sebagai serial mentah dan excelDateToIso
    // menolak semuanya -- sisi Excel jadi kosong dan seluruh perbandingan omong kosong.
    const wb = XLSX.readFile(workbook, { cellDates: true, cellStyles: false, cellHTML: false });
    const ws = wb.Sheets[sheet];
    if (!ws) throw new Error(`Sheet "${sheet}" tidak ada di ${workbook}`);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: false });

    const baris: BarisExcel[] = [];
    let totalBaris = 0, bedaTanggal = 0, bedaPrincipal = 0;
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const noNota = String(r[KOL_NO_NOTA] ?? "").trim();
        if (!noNota) continue; // sisa blok formula, bukan data
        totalBaris += 1;
        // excelDateToIso: serial Excel dibaca SheetJS jadi 23:59:35 hari sebelumnya. Tanpa
        // koreksi ini seluruh sheet terbaca mundur satu hari dan pembandingnya jadi omong kosong.
        if (excelDateToIso(r[KOL_TANGGAL]) !== tanggal) { bedaTanggal += 1; continue; }
        if (principal && bersih(r[KOLOM_DIMENSI.jenis_produk]) !== principal) { bedaPrincipal += 1; continue; }

        const dimensi: Record<string, string> = {};
        for (const [dim, kol] of Object.entries(KOLOM_DIMENSI)) dimensi[dim] = bersih(r[kol]);
        baris.push({
            noNota,
            kodeBarang: String(r[KOL_KODE_BARANG] ?? "").trim(),
            pcs: angka(r[KOL_HASIL_PCS]),
            isi: angka(r[KOL_ISI]),
            dimensi,
        });
    }
    return { baris, totalBaris, bedaTanggal, bedaPrincipal };
}

/** OR di dalam satu dimensi, AND antar-dimensi — sama persis dengan bangunFilter() di query.ts. */
function lolosFilter(b: BarisExcel, perDimensi: Map<string, Set<string>>): boolean {
    for (const [dim, nilai] of perDimensi) {
        if (dim === "volume" && nilai.size === 2) continue; // pareto + non pareto = tanpa penyaringan
        if (!nilai.has(b.dimensi[dim] ?? "")) return false;
    }
    return true;
}

async function main() {
    try { process.loadEnvFile(".env.local"); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL wajib di-set.");

    // Dynamic import: lib/db membaca DATABASE_URL saat modulnya dimuat.
    const { pool } = await import("../lib/db");
    const { buildRekapan } = await import("../lib/rekapan-nota/query");

    const waveId = Number(argv("wave"));
    if (!Number.isInteger(waveId)) throw new Error("--wave <id> wajib.");
    const workbook = argv("workbook") || DEFAULT_WORKBOOK;
    const sheet = argv("sheet") || "Paste Data Sore";
    const principal = argv("principal") === "" ? null : (argv("principal") ?? "HEINZ ABC").toUpperCase();
    const lembarDipilih = (argv("grup") || Object.keys(LEMBAR).join(",")).split(",").map((s) => s.trim());

    const w = await pool.query<{ tanggal: string; nama: string; urutan: number }>(
        `SELECT tanggal::text, nama, urutan FROM wave WHERE id = $1`, [waveId]);
    if (!w.rowCount) throw new Error(`Wave ${waveId} tidak ada.`);
    const wave = w.rows[0];

    const g = await pool.query<{ id: number; kode: string; dimensi: string; nilai: string[] }>(
        `SELECT g.id::int, g.kode, g.dimensi::text AS dimensi,
                coalesce(array_agg(m.nilai) FILTER (WHERE m.nilai IS NOT NULL), '{}') AS nilai
           FROM pick_group g LEFT JOIN pick_group_member m ON m.pick_group_id = g.id
          GROUP BY g.id`);
    const perKode = new Map(g.rows.map((x) => [x.kode, x]));

    const excel = bacaExcel(workbook, sheet, wave.tanggal, principal);

    console.log(`Wave #${waveId} "${wave.nama}" (urutan ${wave.urutan}) tanggal ${wave.tanggal}`);
    console.log(`Excel  : ${sheet} — ${excel.totalBaris} baris data, ${excel.baris.length} lolos filter`);
    console.log(`         (${excel.bedaTanggal} beda tanggal, ${excel.bedaPrincipal} beda principal)`);
    if (principal) {
        console.log(`CATATAN: dibatasi principal "${principal}". Pivot HNZ di Excel sebenarnya`);
        console.log(`         menjumlahkan SEMUA principal; pembandingan penuh butuh export`);
        console.log(`         Accurate tanpa filter principal. Pakai --principal "" untuk itu.`);
    }

    // Nasib tiap nota pada tanggal ini, langsung dari DB. Dipakai supaya "nota tidak ada di
    // wave ini" harus DIBUKTIKAN (ada di wave lain / ditandai kanvas / area dikecualikan),
    // bukan diterima sebagai alasan gratis yang menelan kelalaian nyata.
    const nasib = await pool.query<{ no_nota: string; nasib: string }>(
        `SELECT p.no_nota,
                CASE WHEN k.no_nota IS NOT NULL                    THEN 'kanvas'
                     WHEN upper(coalesce(c.area,'')) IN ('NON','LUAR KOTA') THEN 'area dikecualikan'
                     WHEN wa.wave_id IS NOT NULL AND wa.wave_id <> $2 THEN 'wave lain (#'||wa.wave_id||')'
                     WHEN wa.wave_id = $2                          THEN 'di wave ini'
                     ELSE 'BELUM DISUSUN' END AS nasib
           FROM (SELECT DISTINCT no_nota, kode_cust FROM wave_line_pool WHERE tanggal = $1::date) p
           LEFT JOIN customer c    ON c."customerNo" = p.kode_cust
           LEFT JOIN nota_kanvas k ON k.no_nota = p.no_nota
           LEFT JOIN wave_assignment wa ON wa.no_nota = p.no_nota AND wa.dilepas = false`,
        [wave.tanggal, waveId]);
    const nasibNota = new Map(nasib.rows.map((r) => [r.no_nota, r.nasib]));

    let totalTakTerjelaskan = 0;
    for (const nama of lembarDipilih) {
        const kodeGrup = LEMBAR[nama];
        if (!kodeGrup) { console.log(`\n[${nama}] tidak dikenal — lewati.`); continue; }
        const grup = kodeGrup.map((k) => perKode.get(k)).filter(Boolean) as typeof g.rows;
        if (grup.length !== kodeGrup.length) {
            console.log(`\n[${nama}] pick_group belum di-seed (${kodeGrup.join("+")}) — lewati.`);
            continue;
        }

        const perDimensi = new Map<string, Set<string>>();
        for (const x of grup) {
            const set = perDimensi.get(x.dimensi) ?? new Set<string>();
            for (const v of x.nilai) set.add(bersih(v));
            perDimensi.set(x.dimensi, set);
        }

        // Sisi Excel: SUM(Hasil Pcs) per KODE_BARANG atas baris yang lolos filter grup.
        const sisiExcel = new Map<string, number>();
        const notaPerSku = new Map<string, Set<string>>();
        for (const b of excel.baris) {
            if (!lolosFilter(b, perDimensi)) continue;
            sisiExcel.set(b.kodeBarang, (sisiExcel.get(b.kodeBarang) ?? 0) + b.pcs);
            const set = notaPerSku.get(b.kodeBarang) ?? new Set<string>();
            set.add(b.noNota);
            notaPerSku.set(b.kodeBarang, set);
        }

        // Sisi AccAPI: jalur kode cetak yang sebenarnya, bukan query tandingan.
        const rekapan = await buildRekapan(waveId, grup.map((x) => x.id));
        const sisiAccapi = new Map(rekapan.withdrawal.map((r) => [r.kode_barang, Number(r.total_pcs)]));

        const semuaSku = [...new Set([...sisiExcel.keys(), ...sisiAccapi.keys()])].sort();
        const cocok: string[] = [];
        const selisih: { sku: string; excel: number; accapi: number; sebab: string }[] = [];

        for (const sku of semuaSku) {
            const e = sisiExcel.get(sku);
            const a = sisiAccapi.get(sku);
            if (e !== undefined && a !== undefined && Math.abs(e - a) < 1e-9) { cocok.push(sku); continue; }
            selisih.push({
                sku, excel: e ?? 0, accapi: a ?? 0,
                sebab: jelaskan(sku, e, a, excel.baris, perDimensi, notaPerSku.get(sku) ?? new Set(), nasibNota),
            });
        }

        const takTerjelaskan = selisih.filter((s) => s.sebab.startsWith("TIDAK TERJELASKAN"));
        totalTakTerjelaskan += takTerjelaskan.length;

        console.log(`\n[${nama}]  ${kodeGrup.join(" + ")}`);
        console.log(`  SKU cocok ${cocok.length}/${semuaSku.length}` +
            `  ·  Excel ${sum(sisiExcel)} pcs  ·  AccAPI ${sum(sisiAccapi)} pcs` +
            `  ·  nota AccAPI ${rekapan.ringkasan.jumlahNota}`);
        for (const s of selisih.slice(0, 15)) {
            console.log(`  - ${s.sku}: Excel ${s.excel} vs AccAPI ${s.accapi}  [${s.sebab}]`);
        }
        if (selisih.length > 15) console.log(`  ... ${selisih.length - 15} selisih lain tidak ditampilkan`);
    }

    console.log(`\n${"=".repeat(70)}`);
    if (totalTakTerjelaskan === 0) {
        console.log("LULUS: tidak ada selisih yang tak terjelaskan.");
    } else {
        console.log(`GAGAL: ${totalTakTerjelaskan} SKU berselisih tanpa sebab yang dikenali.`);
        console.log("Selisih yang WAJAR hanya yang lahir dari cacat workbook (E1-E6, PRD §2.3)");
        console.log("— yaitu AccAPI lebih benar. Sisanya berarti ada yang salah di AccAPI.");
    }
    await pool.end();
    process.exit(totalTakTerjelaskan === 0 ? 0 : 1);
}

const sum = (m: Map<string, number>) =>
    [...m.values()].reduce((a, b) => a + b, 0).toLocaleString("id-ID", { maximumFractionDigits: 0 });

/**
 * Selisih hanya boleh lolos kalau sebabnya BISA DISEBUT. "Mungkin karena..." tidak dihitung —
 * itulah bedanya pembanding ini dengan melihat dua angka lalu mengangguk.
 */
function jelaskan(
    sku: string, excel: number | undefined, accapi: number | undefined,
    baris: BarisExcel[], perDimensi: Map<string, Set<string>>,
    notaSku: Set<string>, nasibNota: Map<string, string>,
): string {
    const barisSku = baris.filter((b) => b.kodeBarang === sku);

    if (excel === undefined && accapi !== undefined) {
        // E1: Isi = 0 -> In Crt = #DIV/0! -> Pareto kosong -> baris gugur dari SELURUH pivot HNZ.
        if (barisSku.some((b) => b.isi === 0)) return "E1 workbook: SKU tanpa konversi, barisnya gugur dari pivot Excel";
        // Outlet tanpa area: tidak masuk lembar area mana pun di Excel.
        if (perDimensi.has("area") && barisSku.some((b) => !b.dimensi.area || b.dimensi.area === "0"))
            return "Outlet belum dipetakan: tidak lolos filter area Excel";
        return "TIDAK TERJELASKAN";
    }
    if (accapi === undefined && excel !== undefined) {
        // Setiap nota penyumbang harus punya nasib yang bisa disebut. Satu saja yang
        // "BELUM DISUSUN" atau tidak dikenal DB = ada yang benar-benar tercecer.
        const tercecer = [...notaSku].filter((n) => {
            const s = nasibNota.get(n);
            return !s || s === "BELUM DISUSUN" || s === "di wave ini";
        });
        if (tercecer.length === 0) {
            const alasan = [...new Set([...notaSku].map((n) => nasibNota.get(n)!))];
            return `Nota sah di luar wave ini: ${alasan.join(", ")}`;
        }
        return `TIDAK TERJELASKAN (${tercecer.length} nota tercecer, mis. ${tercecer[0]})`;
    }
    if (barisSku.some((b) => b.isi === 0)) return "E1 workbook: sebagian baris SKU ini tanpa konversi";
    return "TIDAK TERJELASKAN";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
