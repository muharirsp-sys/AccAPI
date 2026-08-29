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

async function updateBatch(client, sql, entries) {
    let cocok = 0;
    const tidakCocok = [];
    for (const [key, ...values] of entries) {
        const res = await client.query(sql, [key, ...values]);
        if (res.rowCount > 0) cocok += 1; else tidakCocok.push(key);
    }
    return { cocok, tidakCocok };
}

function lapor(judul, total, { cocok, tidakCocok }) {
    console.log(`\n${judul}: ${cocok}/${total} cocok, ${tidakCocok.length} tidak ada padanannya`);
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

        await client.query("BEGIN");
        const hasilKonversi = await updateBatch(client,
            `UPDATE item SET isi_per_karton = $2, satuan_besar = $3 WHERE no = $1`,
            [...m.konversi].map(([no, v]) => [no, v.isi, v.satuanBesar]));
        const hasilArea = await updateBatch(client,
            `UPDATE customer SET area = $2 WHERE "customerNo" = $1`, [...m.area]);
        const hasilAlamat = await updateBatch(client,
            `UPDATE customer SET alamat = $2 WHERE "customerNo" = $1`, [...m.alamat]);
        const hasilAll = await updateBatch(client,
            `UPDATE customer SET grup_all = $2 WHERE "customerNo" = $1`, [...m.grupAll]);
        const hasilGdi = await updateBatch(client,
            `UPDATE customer SET grup_gdi = $2 WHERE "customerNo" = $1`, [...m.grupGdi]);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
