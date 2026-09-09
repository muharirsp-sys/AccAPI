/*
 * Tujuan: Layout + seluruh gaya cetak lembar gudang. Dirancang untuk dibaca sambil jalan,
 *         satu tangan memegang kertas, di bawah tekanan waktu — bukan untuk dibaca di layar.
 * Caller: app/(cetak)/** (lembar picking & TTF).
 * Dependensi: requirePermissionH (grup ini di luar (dashboard) yang biasa menjaga).
 * Main Functions: CetakLayout.
 * Side Effects: Membaca session/permission; redirect ke login bila tidak berhak.
 *
 * Keputusan desain, semuanya punya alasan operasional:
 * - Satuan SELALU tertulis ("28 KRT", bukan "28"). Tertukarnya satuan besar dan satuan kecil
 *   adalah kesalahan picking paling umum yang dilaporkan literatur gudang.
 * - Jumlah yang harus diambil adalah elemen TERBESAR di barisnya. Angka audit (total pcs dan
 *   faktor konversi) tetap ada, tapi dikecilkan supaya tidak bersaing.
 * - Tanpa garis vertikal. Kolom dipisah oleh ruang dan perataan, bukan oleh kisi; kisi
 *   menambah tinta tanpa menambah keterbacaan.
 * - Zebra tipis + garis tegas tiap 5 baris: mata bisa menyeberang satu baris tanpa tersesat.
 * - Bekerja penuh dalam hitam-putih. Tidak ada informasi yang hanya disampaikan oleh warna.
 */
import { redirect } from "next/navigation";
import { requirePermissionH } from "@/lib/rbac/resolve";

export const dynamic = "force-dynamic";

const GAYA = `
@page { size: A4 portrait; margin: 12mm 10mm; }

/* Root layout aplikasi memasang tiga lapis gradient position:fixed seukuran layar dan
   latar gelap di <body>. Elemen fixed DIULANG di setiap halaman cetak, dan gradient tidak
   bisa digambar sebagai vektor -- Chrome merasterisasi tiap halaman jadi bitmap A4 penuh.
   Itu yang membuat PDF berat dibuka, bukan isi tabelnya. Halaman cetak dipaksa polos. */
@media print {
    html, body { background: #fff !important; }
    body > div.fixed, body > [class*="radial-gradient"], body > [class*="linear-gradient"] {
        display: none !important;
    }
}
.cetak-akar { background: #fff; }

.cetak {
    --tinta: #111;
    --samar: #6b6b6b;
    --garis: #d4d4d4;
    --garis-tegas: #9a9a9a;
    --tint: #f2f2f2;
    font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: var(--tinta);
    font-size: 8pt;
    line-height: 1.25;
    max-width: 190mm;
    margin: 0 auto;
    font-variant-numeric: tabular-nums;
}
.cetak * { box-sizing: border-box; }

/* ---------- Kop: identitas lembar, diulang tiap halaman ---------- */
.kop { border-bottom: 1.5pt solid var(--tinta); padding-bottom: 2mm; }
.kop-baris { display: flex; align-items: flex-start; justify-content: space-between; gap: 6mm; }
.kop-judul { font-size: 15pt; font-weight: 700; letter-spacing: -0.01em; line-height: 1.1; }
.kop-sub { margin-top: 1mm; font-size: 8pt; color: var(--samar); }
.kop-kode {
    flex: none; border: 1.5pt solid var(--tinta); border-radius: 1.5mm;
    padding: 1mm 2.5mm; font-size: 12pt; font-weight: 700; letter-spacing: 0.02em;
}

/* Tiga angka yang harus terbaca dalam satu detik. */
.angka-utama { display: flex; gap: 8mm; margin-top: 2.5mm; }
.angka-utama div { line-height: 1.05; }
.angka-utama b { display: block; font-size: 13pt; font-weight: 700; }
.angka-utama span { font-size: 6.5pt; color: var(--samar); text-transform: uppercase; letter-spacing: 0.08em; }

/* ---------- Tabel ---------- */
.cetak table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cetak thead { display: table-header-group; }
.cetak tr { break-inside: avoid; page-break-inside: avoid; }

/* Satu <section> = satu halaman kertas. Paginasi dihitung di server supaya tiap halaman
   bisa membawa SUBTOTAL-nya sendiri; diserahkan ke browser, <tfoot> mengulang grand total
   di tiap halaman dan kontrol per-lembar jadi palsu. */
.halaman { break-after: page; page-break-after: always; }
.halaman:last-of-type { break-after: auto; page-break-after: auto; }
.kop-kanan { flex: none; text-align: right; }
.kop-hal { margin-top: 1.5mm; font-size: 6.5pt; color: var(--samar);
    text-transform: uppercase; letter-spacing: 0.08em; }
.ulang { margin-left: 2mm; padding: 0.3mm 1.5mm; border: 0.75pt solid var(--tinta);
    border-radius: 1mm; font-size: 7pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--tinta); }

.judul-kolom th {
    font-size: 6.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--samar); text-align: left; padding: 1.5mm 1.5mm 1mm;
    border-bottom: 0.75pt solid var(--garis-tegas);
}
.judul-kolom th.kanan { text-align: right; }

/* Garis di <tr>, bukan di tiap <td>. Dengan border-collapse, garis per sel jadi lima
   persegi terisi per baris; di lembar 276 baris itu ribuan objek gambar yang harus
   diproses pembaca PDF sebelum halaman muncul. Zebra dibuang sekalian: garis tiap
   5 baris sudah cukup menuntun mata, dan dua-duanya bersamaan cuma menambah tinta. */
/* Garis di <tr>, bukan di tiap <td>. Semua baris bergaris SAMA: versi sebelumnya menebalkan
   tiap baris ke-5 dihitung dari urutan data, padahal di kertas ada baris pemisah keluarga
   yang menyela -- ritmenya pecah dan garis tebalnya terbaca sebagai cacat cetak. Pengelompokan
   diserahkan sepenuhnya ke pemisah keluarga, yang punya arti (satu keluarga = satu area rak). */
.cetak tbody td { padding: 1.1mm 1.5mm; vertical-align: top; }
.cetak tbody tr { border-bottom: 0.4pt solid var(--garis); }

/* Kotak centang: picking tanpa tempat mencentang = jalan menghitung ulang. */
.centang { width: 7mm; }
.centang i { display: block; width: 3.6mm; height: 3.6mm; border: 0.75pt solid var(--tinta); border-radius: 0.5mm; }

.kode { width: 30mm; font-family: "Consolas", "SF Mono", ui-monospace, monospace; font-size: 7.5pt; letter-spacing: -0.02em; }

/* Nama: prefiks merek diredam, spesifikasi ukuran/kemasan ditebalkan. Untuk produk yang
   namanya beruntun mirip, pembedanya justru ada di ekor nama. */
.nama { font-size: 8pt; }
.nama > span { display: block; }
.nama { display: flex; align-items: baseline; gap: 0; white-space: nowrap; overflow: hidden; }
.nama .merek { color: var(--samar); flex: 0 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis;
    /* Spasi akhir merek hilang di batas flex item -- jaraknya dikembalikan lewat padding. */
    padding-right: 1.1mm; }
.nama .spek { font-weight: 700; flex: 0 0 auto; }        /* pembeda: tidak pernah dipotong */
.nama .kode-internal { color: #9a9a9a; font-size: 7pt; flex: 0 1 auto; min-width: 0;
    padding-left: 1.2mm; overflow: hidden; text-overflow: ellipsis; }

/* Jumlah ambil: pahlawan barisnya. Angka dan satuan punya kolom sendiri supaya SEJAJAR
   ke bawah -- deretan angka yang rata bisa dipindai sekali lihat, yang gerigi tidak. */
.ambil { width: 38mm; background: var(--tint); white-space: nowrap; text-align: right; }
.ambil span { display: inline-block; vertical-align: baseline; }
.ambil .n  { width: 11mm; text-align: right; font-size: 11.5pt; font-weight: 700; letter-spacing: -0.01em; }
.ambil .u  { width: 7mm;  text-align: left;  font-size: 7pt;  font-weight: 700; padding-left: 0.7mm; }
.ambil .n2 { width: 9mm;  text-align: right; font-size: 8pt; font-weight: 600; }
.ambil .u2 { width: 6mm;  text-align: left;  font-size: 6.5pt; font-weight: 600; color: var(--samar); padding-left: 0.7mm; }
.audit { width: 24mm; text-align: right; font-size: 6.5pt; color: var(--samar); white-space: nowrap; }

/* Exception harus KELIHATAN salah, bukan disamarkan jadi tanda tanya. */
td.ambil.cacat { background: #dcdcdc; text-align: center; }
td.ambil.cacat b { font-size: 7pt; font-weight: 700; white-space: nowrap; }

/* Pemisah keluarga produk: prefiks kode berubah = rak lain. Pengganti master lokasi
   yang belum ada — cukup untuk membuat urutan ambil terasa berkelompok. */
tr.keluarga { border-bottom: none !important; }
tr.keluarga td { border: none; height: 3mm; padding: 0; background: none !important; }

/* ---------- Total & tanda tangan ---------- */
.total td { border-top: 1.5pt solid var(--tinta); border-bottom: none; padding-top: 2mm; font-weight: 700; background: none !important; }
.total .label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.08em; color: var(--samar); }
.total .nilai { font-size: 11pt; }
.total .satuan { font-size: 7pt; }
.total .kuat { font-size: 8pt; font-weight: 700; color: var(--tinta); }
.total td.ambil { background: none; }

.paraf { display: flex; gap: 10mm; margin-top: 8mm; break-inside: avoid; }
.paraf div { flex: 1; }
.paraf span { display: block; font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: var(--samar); }
.paraf u { display: block; margin-top: 9mm; border-top: 0.75pt solid var(--tinta); text-decoration: none; }

/* ---------- Blok nota (allocation) ---------- */
.blok-nota { margin-top: 7mm; break-inside: auto; }
.blok-nota h2 { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    border-bottom: 0.75pt solid var(--garis-tegas); padding-bottom: 1mm; margin: 0 0 2mm; }
.grid-nota { columns: 3; column-gap: 6mm; font-size: 7pt; }
.grid-nota div { break-inside: avoid; padding: 0.7mm 0; border-bottom: 0.3pt dotted var(--garis); display: flex; justify-content: space-between; gap: 2mm; }
.grid-nota b { font-weight: 600; font-family: "Consolas", ui-monospace, monospace; }
.grid-nota i { font-style: normal; color: var(--samar); text-align: right; }
.grid-nota .urgent { font-weight: 700; }
.grid-nota .urgent b::before { content: "\\25B2\\00A0"; }

/* ---------- Jejak cetakan ---------- */
.jejak { margin-top: 6mm; padding-top: 1.5mm; border-top: 0.4pt solid var(--garis);
    font-size: 6pt; color: var(--samar); display: flex; justify-content: space-between; gap: 4mm; }

/* ---------- Hanya layar ---------- */
.layar-saja { margin-bottom: 6mm; }
.tombol-cetak { border: 1px solid #333; border-radius: 6px; padding: 8px 18px; font-size: 13px; font-weight: 600; background: #111; color: #fff; cursor: pointer; }
@media print { .layar-saja { display: none !important; } }
`;

export default async function CetakLayout({ children }: { children: React.ReactNode }) {
    const gate = await requirePermissionH("rekapan_nota.print");
    if (gate.response) redirect("/login");

    return (
        <div className="cetak-akar" style={{ color: "#111", minHeight: "100vh", padding: "8mm" }}>
            <style>{GAYA}</style>
            {children}
        </div>
    );
}
