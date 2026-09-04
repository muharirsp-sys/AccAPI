/**
 * import-rekapan-master.mjs
 * Tujuan  : Impor SEKALI master Rekapan Nota dari workbook Excel ke kolom baru
 *           item/customer: sheet `Konversi` -> item.isi_per_karton/satuan_besar,
 *           `Master Area Heinz` -> customer.area, `Pemisah` -> customer.grup_all/grup_gdi.
 * Caller  : manual. Run: node scripts/import-rekapan-master.mjs [path-workbook.xlsx]
 * Depend. : xlsx, pg, DATABASE_URL. Migrasi 0002_rekapan_nota.sql wajib sudah jalan.
 * Efek    : UPDATE kolom master (aditif). Tidak menghapus/menyisipkan baris.
 * Catatan : Script MELAPORKAN cocok/tidak cocok dan tidak menelan selisih. 19 SKU tanpa
 *           konversi memang harus muncul sebagai selisih yang diakui (kriteria lulus Fase 1).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import pg from "pg";
import assert from "node:assert/strict";

const DEFAULT_WORKBOOK =
    "C:\\Users\\Muhar\\Downloads\\A_New Rekapan Nota 24 AGUST 2026 update.xlsx";

const norm = (v) => String(v ?? "").trim().toUpperCase();
const kode = (v) => String(v ?? "").trim(); // kode item/customer: TRIM saja, jangan UPPER

/** Baca 3 sheet master jadi baris siap-tulis. Pure: tidak menyentuh DB. */
export function bacaMaster(workbookPath) {
    const wb = XLSX.readFile(workbookPath, { cellStyles: false, cellHTML: false });
    const sheet = (nama) => {
        const s = wb.Sheets[nama];
        if (!s) throw new Error(`Sheet "${nama}" tidak ada di ${workbookPath}`);
        return XLSX.utils.sheet_to_json(s, { header: 1, defval: "", blankrows: false });
    };

    // Konversi: BRG | UNIT | QTYKONV
    const konversi = new Map();
    const konversiNol = [];
    for (const [brg, unit, qtykonv] of sheet("Konversi").slice(1)) {
        const no = kode(brg);
        if (!no) continue;
        const isi = Number(qtykonv);
        if (!Number.isFinite(isi) || isi <= 0) { konversiNol.push(no); continue; }
        konversi.set(no, { isi: Math.round(isi), satuanBesar: norm(unit) }); // R1.2: 'KRT ' -> 'KRT'
    }

    // Master Area Heinz: KODE WIN | NAMA | ALAMAT | AREA
    const area = new Map();
    const alamat = new Map();
    for (const row of sheet("Master Area Heinz").slice(1)) {
        const no = kode(row[0]);
        const nilai = norm(row[3]);
        const alm = String(row[2] ?? "").trim();
        // Alamat diimpor TERPISAH dari area: outlet tanpa area pun alamatnya berguna,
        // dan alamat outlet ter-mapping-lah yang jadi bahan indeks kelurahan.
        if (no && alm) alamat.set(no, alm);
        if (!no || !nilai) continue;
        area.set(no, nilai); // termasuk NON / LUAR KOTA: disimpan apa adanya, difilter di parser (R2.5)
    }

    // Pemisah: blok A:C (Pemisahan All) dan blok E:G (Pemisah GDI) dalam satu sheet
    const grupAll = new Map();
    const grupGdi = new Map();
    for (const row of sheet("Pemisah").slice(1)) {
        const a = kode(row[0]); const ketA = String(row[2] ?? "").trim();
        const e = kode(row[4]); const ketE = String(row[6] ?? "").trim();
        if (a && ketA) grupAll.set(a, ketA);
        if (e && ketE) grupGdi.set(e, ketE);
    }

    return { konversi, konversiNol, area, alamat, grupAll, grupGdi };
}

/**
 * Kunci pencocokan outlet. `customer.customerNo` di produksi = kode outlet + akhiran
 * principal ("C-BUR015-KN", "C-BUR015-M2", "C-BUR015-MSM"); workbook memetakan outlet
 * FISIKNYA ("C-BUR015"). Satu outlet = 5-10 baris customer, dan areanya sama untuk
 * semuanya: area adalah lokasi toko, bukan atribut principal.
 *
 * Sengaja BUKAN `regexp_replace(no, '-[A-Za-z0-9]+$', '')`. Diukur di produksi 2026-09-04:
 * outlet TANPA akhiran principal ("C-MTR002") dipotong jadi "C", dan ribuan baris runtuh
 * ke satu kode palsu — lebih buruk daripada nol kecocokan yang jujur, karena tidak
 * kelihatan salah. 43 dari 32.012 baris punya anomali semacam itu.
 *
 * Case-insensitive karena "c-put030-M2" dan "C-GRA010-SZ" sama-sama ada di produksi.
 * Tanda '-' wajib sesudah kode: tanpa itu "C-TOK15" ikut menyambar "C-TOK156-KN".
 */
const COCOK_OUTLET = `(upper("customerNo") = upper($1) OR upper("customerNo") LIKE upper($1) || '-%')`;

/**
 * Kalau satu kode workbook adalah awalan kode workbook lain ("C-AL" vs "C-AL-0546"),
 * pencocokan berawalan menulis ke baris yang sama dua kali dan yang menang adalah yang
 * kebetulan belakangan. Dideteksi, bukan diserahkan ke nasib.
 */
export function tabrakanPrefiks(daftarKode) {
    const set = new Set(daftarKode.map((k) => String(k).toUpperCase()));
    const tabrakan = [];
    for (const k of set) {
        for (let i = k.indexOf("-"); i > 0; i = k.indexOf("-", i + 1)) {
            if (set.has(k.slice(0, i))) tabrakan.push([k.slice(0, i), k]);
        }
    }
    return tabrakan;
}

async function updateBatch(client, sql, entries) {
    let cocok = 0;
    let baris = 0;   // satu kode outlet menyentuh banyak baris customer (satu per principal)
    const tidakCocok = [];
    for (const [key, ...values] of entries) {
        const res = await client.query(sql, [key, ...values]);
        if (res.rowCount > 0) { cocok += 1; baris += res.rowCount; } else tidakCocok.push(key);
    }
    return { cocok, baris, tidakCocok };
}

function lapor(judul, total, { cocok, baris, tidakCocok }) {
    const ekor = baris !== undefined && baris !== cocok ? ` (${baris} baris customer)` : "";
    console.log(`\n${judul}: ${cocok}/${total} cocok${ekor}, ${tidakCocok.length} tidak ada padanannya`);
    if (tidakCocok.length) console.log("  contoh:", tidakCocok.slice(0, 10).join(", "));
}

async function main() {
    try { process.loadEnvFile(".env.local"); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL wajib di-set.");

    const workbookPath = process.argv[2] || DEFAULT_WORKBOOK;
    console.log("Workbook:", workbookPath);
    const m = bacaMaster(workbookPath);
    console.log(`Terbaca: Konversi ${m.konversi.size} SKU (${m.konversiNol.length} QTYKONV nol/kosong), ` +
        `Area ${m.area.size} outlet, Alamat ${m.alamat.size}, ` +
        `Pemisahan All ${m.grupAll.size}, Pemisah GDI ${m.grupGdi.size}`);

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
        // Kunci upsert customer adalah customerNo. Kalau ternyata tidak unik, satu kode
        // bisa menulis area ke dua baris berbeda tanpa ketahuan. Berhenti, jangan tebak.
        const dup = await client.query(
            `SELECT "customerNo", count(*) c FROM customer GROUP BY 1 HAVING count(*) > 1 LIMIT 5`);
        if (dup.rowCount > 0) {
            throw new Error(`customer.customerNo TIDAK unik (contoh: ` +
                dup.rows.map((r) => `${r.customerNo} x${r.c}`).join(", ") +
                `). Bersihkan dulu sebelum impor master.`);
        }

        // Pencocokan berawalan aman HANYA kalau tidak ada kode workbook yang jadi awalan
        // kode workbook lain. Kalau ada, dua baris master menulis ke customer yang sama.
        const tabrakan = tabrakanPrefiks([
            ...m.area.keys(), ...m.alamat.keys(), ...m.grupAll.keys(), ...m.grupGdi.keys(),
        ]);
        if (tabrakan.length) {
            throw new Error(`Kode master saling berawalan, pencocokan jadi ambigu: ` +
                tabrakan.slice(0, 5).map(([a, b]) => `${a} < ${b}`).join(", ") +
                ` (total ${tabrakan.length}). Bereskan di workbook dulu.`);
        }

        await client.query("BEGIN");
        const hasilKonversi = await updateBatch(client,
            `UPDATE item SET isi_per_karton = $2, satuan_besar = $3 WHERE no = $1`,
            [...m.konversi].map(([no, v]) => [no, v.isi, v.satuanBesar]));
        const hasilArea = await updateBatch(client,
            `UPDATE customer SET area = $2 WHERE ${COCOK_OUTLET}`, [...m.area]);
        const hasilAlamat = await updateBatch(client,
            `UPDATE customer SET alamat = $2 WHERE ${COCOK_OUTLET}`, [...m.alamat]);
        const hasilAll = await updateBatch(client,
            `UPDATE customer SET grup_all = $2 WHERE ${COCOK_OUTLET}`, [...m.grupAll]);
        const hasilGdi = await updateBatch(client,
            `UPDATE customer SET grup_gdi = $2 WHERE ${COCOK_OUTLET}`, [...m.grupGdi]);
        await client.query("COMMIT");

        lapor("Konversi -> item", m.konversi.size, hasilKonversi);
        lapor("Master Area Heinz -> customer.area", m.area.size, hasilArea);
        lapor("Master Area Heinz -> customer.alamat", m.alamat.size, hasilAlamat);
        lapor("Pemisahan All -> customer.grup_all", m.grupAll.size, hasilAll);
        lapor("Pemisah GDI -> customer.grup_gdi", m.grupGdi.size, hasilGdi);
        if (m.konversiNol.length)
            console.log(`\nQTYKONV nol/kosong (akan jadi exception KONVERSI_NOL):`, m.konversiNol.join(", "));

        const sisa = await client.query(`SELECT count(*)::int c FROM item WHERE isi_per_karton IS NULL`);
        console.log(`\nItem tanpa isi_per_karton setelah impor: ${sisa.rows[0].c} ` +
            `(inilah yang memicu KONVERSI_TIDAK_ADA, bukan disembunyikan).`);
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
    } finally {
        await client.end();
    }
}

/**
 * `node scripts/import-rekapan-master.mjs --self-check` — tanpa DB, tanpa workbook.
 * Menjaga aturan pencocokan outlet, satu-satunya bagian script ini yang punya cabang.
 */
function selfCheck() {
    const { strictEqual: eq, deepStrictEqual: deq } = assert;
    // Pola SQL: kode cocok persis, atau diikuti '-' + akhiran principal.
    const cocok = (kodeWb, customerNo) =>
        customerNo.toUpperCase() === kodeWb.toUpperCase() ||
        customerNo.toUpperCase().startsWith(kodeWb.toUpperCase() + "-");

    eq(cocok("C-BUR015", "C-BUR015-KN"), true, "kode + akhiran principal");
    eq(cocok("C-BUR015", "C-BUR015"), true, "outlet tanpa akhiran principal");
    eq(cocok("C-GRA010", "c-gra010-M2"), true, "customerNo huruf kecil");
    eq(cocok("C-BAN019", "C-BAN019-"), true, "akhiran kosong, tanda '-' menggantung");
    // Yang HARUS ditolak: tanpa '-' pemisah, "C-TOK15" akan menyambar "C-TOK156".
    eq(cocok("C-TOK15", "C-TOK156-KN"), false, "awalan tanpa '-' tidak boleh cocok");
    eq(cocok("C-TOK156", "C-TOK15-KN"), false, "kode lebih panjang dari customerNo");

    deq(tabrakanPrefiks(["C-AL0546", "C-BUR015"]), [], "kode normal tidak bertabrakan");
    eq(tabrakanPrefiks(["C-AL", "C-AL-0546"]).length, 1, "awalan sesama kode master terdeteksi");
    eq(tabrakanPrefiks(["c-al", "C-AL-0546"]).length, 1, "deteksi tabrakan case-insensitive");

    console.log("self-check aturan pencocokan outlet: 9 lulus");
}

if (process.argv[2] === "--self-check") selfCheck();
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
