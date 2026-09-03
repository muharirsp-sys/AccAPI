/*
 * Tujuan: SATU lembar TTF (Tanda Terima Faktur) berparameter wave. Varian LK tidak dibuat (Q4).
 * Caller: /rekapan-nota/wave/[id]/ttf (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildTtf), lib/rekapan-nota/ttf-paginasi, lib/db.
 * Main Functions: CetakTtfPage, ekor.
 * Side Effects: Hanya SELECT.
 *
 * Beda kebutuhan dengan lembar picking: TTF adalah dokumen yang DITULISI TANGAN oleh tiga
 * orang berbeda pada waktu berbeda (gudang, sopir, admin). Jadi yang diprioritaskan bukan
 * kerapatan informasi, tapi ruang tulis: baris lebih tinggi, kolom isian benar-benar kosong
 * dan cukup lebar untuk paraf.
 *
 * PAGINASI DIHITUNG DI SERVER, alasan yang sama persis dengan lembar picking: <tfoot>
 * default-nya table-footer-group, jadi baris total diulang di tiap halaman dengan angka
 * grand total yang sama -- kontrol per-lembar yang tidak mengontrol apa pun. Di TTF taruhannya
 * lebih tinggi: satu lembar hilang dari 49 lembar = ~20 nota lenyap tanpa jejak, dan tidak ada
 * yang bisa membuktikannya karena kertasnya tidak bernomor.
 */
import { pool } from "@/lib/db";
import { buildTtf } from "@/lib/rekapan-nota/query";
import { bagiHalamanTtf } from "@/lib/rekapan-nota/ttf-paginasi";
import TombolCetak from "../../../../TombolCetak";

export const dynamic = "force-dynamic";

const ID = (v: number) => v.toLocaleString("id-ID");

/**
 * REGION di export memuat klasifikasi channel + daerah: "RTL BIG (600 KE ATAS)_UTARA PINGGIRAN".
 * Yang dipakai sopir untuk merutekan hanya daerahnya. Klasifikasi channel dibuang dari kertas
 * ini -- bukan disembunyikan karena sempit, tapi karena tidak ada yang membacanya di sini.
 * Sama untuk salesman: "ABC5_JALANI" -> "JALANI", prefiks tim principal tidak menolong sopir.
 */
const ekor = (v: string | null): string => {
    const t = String(v ?? "").trim();
    const i = t.lastIndexOf("_");
    return i >= 0 ? t.slice(i + 1).trim() : t;
};

export default async function CetakTtfPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; tipe: string }>(
        `SELECT nama, tanggal::text, urutan, tipe::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];

    const { rows, barisPerLembar } = await buildTtf(id);
    const totalLembar = rows.reduce((a, r) => a + r.lembar, 0);
    const tanggal = new Date(wave.tanggal + "T00:00:00").toLocaleDateString("id-ID",
        { day: "numeric", month: "long", year: "numeric" });

    const halaman = bagiHalamanTtf(rows);
    const totalHalaman = halaman.length;
    const sekarang = new Date();

    return (
        <main className="cetak ttf">
            <div className="layar-saja"><TombolCetak /></div>
            <style>{`
                .ttf tbody td { padding: 2.1mm 1.5mm; }        /* ruang untuk tulisan tangan */
                .ttf .isian { border-bottom: none; background: none !important; }
                .ttf .isian-kotak { border-left: 0.4pt solid var(--garis); }
                .ttf .no { width: 8mm; text-align: right; color: var(--samar); font-size: 7pt; }
                .ttf .faktur { width: 34mm; font-family: "Consolas", ui-monospace, monospace; font-size: 8pt; font-weight: 600; }
                .ttf .lembar { width: 14mm; text-align: center; font-size: 11pt; font-weight: 700; background: var(--tint); }
                /* Nama outlet DIPAKSA satu baris. Bukan soal estetika: kalau ia boleh
                   membungkus, tinggi baris melompat 10,98mm -> 14,4mm dan paginasi di
                   ttf-paginasi.ts (yang menghasilkan "Halaman X dari Y") jadi bohong. */
                .ttf .outlet { font-size: 8pt; overflow: hidden;
                    white-space: nowrap; text-overflow: ellipsis; }
                .ttf .outlet i { display: block; font-style: normal; font-size: 6.5pt; color: var(--samar);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .ttf .tulis { width: 16mm; }
                .ttf .tulis-lebar { width: 22mm; }
            `}</style>

            {halaman.map((isi, h) => {
                // Nomor urut berlanjut antar halaman: "#" di TTF adalah nota ke-berapa dari
                // seluruh wave, bukan nomor baris di kertas. Mengulang dari 1 tiap lembar
                // membuat dua lembar punya "#1" -- persis ambiguitas yang mau dihapus.
                const mulai = halaman.slice(0, h).reduce((a, p) => a + p.length, 0);
                const lembarHalaman = isi.reduce((a, r) => a + r.lembar, 0);
                const terakhir = h === totalHalaman - 1;
                return (
                    <section className="halaman" key={h}>
                        <div className="kop">
                            <div className="kop-baris">
                                <div>
                                    <div className="kop-judul">Tanda Terima Faktur</div>
                                    <div className="kop-sub">
                                        {wave.nama.toUpperCase()} &middot; {tanggal} &middot; Wave #{id}
                                        {wave.tipe === "kanvas" && " · KANVAS"}
                                    </div>
                                </div>
                                <div className="kop-kanan">
                                    <div className="kop-kode">TTF</div>
                                    <div className="kop-hal">Halaman {h + 1} dari {totalHalaman}</div>
                                </div>
                            </div>
                            {/* Angka besar hanya di halaman pertama. Diulang 49 kali ia berhenti
                                dibaca, dan justru menenggelamkan subtotal halaman. */}
                            {h === 0 && (
                                <div className="angka-utama">
                                    <div><b>{ID(rows.length)}</b><span>Nota</span></div>
                                    <div><b>{ID(totalLembar)}</b><span>Lembar faktur</span></div>
                                </div>
                            )}
                        </div>

                        <table>
                            <colgroup>
                                <col style={{ width: "8mm" }} />
                                <col style={{ width: "34mm" }} />
                                <col style={{ width: "12mm" }} />
                                <col />
                                <col style={{ width: "15mm" }} />
                                <col style={{ width: "15mm" }} />
                                <col style={{ width: "22mm" }} />
                                <col style={{ width: "24mm" }} />
                            </colgroup>
                            <thead>
                                <tr className="judul-kolom">
                                    <th className="no">#</th>
                                    <th className="faktur">No. Faktur</th>
                                    <th className="lembar" style={{ textAlign: "center" }}>Lbr</th>
                                    <th className="outlet">Outlet &amp; daerah</th>
                                    <th className="tulis">SRB</th>
                                    <th className="tulis">Batal</th>
                                    <th className="tulis-lebar">Paraf gudang</th>
                                    <th className="tulis-lebar">Tgl antar / paraf</th>
                                </tr>
                            </thead>
                            <tbody>
                                {isi.map((r, i) => (
                                    <tr key={r.no_nota} className={(mulai + i + 1) % 5 === 0 ? "tandai-5" : undefined}>
                                        <td className="no">{mulai + i + 1}</td>
                                        <td className="faktur">{r.no_nota}</td>
                                        <td className="lembar">{r.lembar}</td>
                                        <td className="outlet">
                                            {r.customer}
                                            <i>{[ekor(r.region), ekor(r.salesman)].filter(Boolean).join(" · ")}</i>
                                        </td>
                                        {/* Sengaja kosong: diisi tangan oleh gudang, sopir, dan admin. */}
                                        <td className="tulis isian-kotak" />
                                        <td className="tulis isian-kotak" />
                                        <td className="tulis-lebar isian-kotak" />
                                        <td className="tulis-lebar isian-kotak" />
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                {/* SUBTOTAL lembar ini, bukan grand total. Kalau satu lembar hilang,
                                    penjumlahan subtotal tidak akan sampai ke angka di halaman 1. */}
                                <tr className="total">
                                    <td colSpan={2} className="label">
                                        Subtotal halaman {h + 1} dari {totalHalaman}
                                    </td>
                                    <td className="lembar nilai" style={{ background: "none" }}>{ID(lembarHalaman)}</td>
                                    <td colSpan={5} className="label">
                                        {ID(isi.length)} nota &middot; no. {ID(mulai + 1)}&ndash;{ID(mulai + isi.length)}
                                        {terakhir && ` · total wave ${ID(rows.length)} nota / ${ID(totalLembar)} lembar`}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>

                        {/* Tanda tangan sekali, di halaman terakhir: yang diserahterimakan satu
                            bendel utuh, bukan tiap lembar. */}
                        {terakhir && (
                            <div className="paraf">
                                <div><span>Diserahkan oleh (admin)</span><u /></div>
                                <div><span>Diterima oleh (sopir)</span><u /></div>
                                <div><span>Dikembalikan &amp; dicek</span><u /></div>
                            </div>
                        )}

                        <div className="jejak">
                            <span>
                                Wave #{id} &middot; lembar = pembulatan ke atas dari
                                (jumlah baris nota / {barisPerLembar})
                            </span>
                            <span>
                                Halaman {h + 1} dari {totalHalaman} &middot; dicetak{" "}
                                {sekarang.toLocaleString("id-ID")}
                            </span>
                        </div>
                    </section>
                );
            })}
        </main>
    );
}
