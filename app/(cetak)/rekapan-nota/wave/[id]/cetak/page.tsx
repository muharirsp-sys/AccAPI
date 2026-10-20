/*
 * Tujuan: SATU lembar picking berparameter pick_group — pengganti 29+ sheet `Print Rkpn *`.
 * Caller: /rekapan-nota/wave/[id]/cetak?grup=1,7 (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildRekapan, ambilPickGroup), lib/db.
 * Main Functions: CetakRekapanPage, pecahNama, satuanKecil, bagiHalaman.
 * Side Effects: Hanya SELECT. Server component: query di server, tanpa hop API.
 *
 * PAGINASI DIHITUNG SENDIRI, tidak diserahkan ke browser. Alasannya bukan estetika:
 * <tfoot> default-nya table-footer-group, jadi baris total DIULANG di tiap halaman dengan
 * angka grand total yang sama — kontrol per-lembar yang sebenarnya tidak mengontrol apa pun.
 * Satu lembar bisa hilang tanpa jejak. Dengan membagi halaman di sini, tiap halaman dapat
 * SUBTOTAL-nya sendiri dan nomor "Halaman X dari Y" yang benar.
 *
 * Daftar nota tidak disandingkan sebaris dengan daftar barang: keduanya pernah berbagi satu
 * <tr> dan hanya sejajar karena kebetulan urutan array — tampilan yang menyiratkan hubungan
 * yang tidak ada adalah kelas kesalahan yang sama dengan yang diperbaiki modul ini.
 */
import type { Metadata } from "next";
import { Fragment } from "react";
import { pool } from "@/lib/db";
import { ambilPickGroup, buildRekapan, type WithdrawalRow } from "@/lib/rekapan-nota/query";
import { hariIniWita, jamWita, judulBerkas, nomorLembar } from "@/lib/rekapan-nota/ui";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ grup?: string }> };
const grupDari = async (searchParams: Props["searchParams"]) =>
    String((await searchParams).grup ?? "").split(",").map(Number).filter(Number.isInteger);

/** Judul = nama berkas PDF saat disimpan: nomor lembar + tanggal-jam cetak (owner 20 Okt 2026). */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
    const id = Number((await params).id);
    const [w, grup] = await Promise.all([
        pool.query<{ tanggal: string }>(`SELECT tanggal::text FROM wave WHERE id = $1`, [id]),
        grupDari(searchParams).then(ambilPickGroup),
    ]);
    if (!w.rowCount) return {};
    return { title: judulBerkas(nomorLembar("RKP", w.rows[0].tanggal, id, grup.map((g) => g.kode).join("+") || "ALL")) };
}

const ID = (v: number, d = 0) =>
    v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Anggaran tinggi halaman (mm), DIUKUR dari render nyata bukan ditebak. Versi pertama
 * memakai 7mm/baris; hasil pengukuran 8,8mm, dan 6 dari 10 halaman meluber -- yang berarti
 * browser memecah halaman lagi dan nomor "Halaman X dari Y" jadi bohong.
 * Sisa aman 8mm sengaja disisakan: nama terpanjang bisa sedikit menaikkan tinggi baris.
 */
const TINGGI_BARIS_MM = 8.8;
const TINGGI_PEMISAH_MM = 3;
const RUANG_ISI_MM = 218;        // halaman 2 dst
const RUANG_ISI_HAL1_MM = 205;   // halaman 1 membawa blok empat angka besar
/** Baris panel nota (kanan) per halaman: satu baris teks pendek, jauh lebih rapat dari baris barang. */
const NOTA_PER_PANEL_HAL1 = 40;
const NOTA_PER_PANEL = 43;

type Baris = WithdrawalRow & { keluarga: string; pisah: boolean };

/**
 * Nama barang beruntun mirip: "CB SHAMPOO ALMOND OIL&HONEY 50ML X 96" vs "... 100ML X 48".
 * Merek berulang, PEMBEDANYA di ekor — jadi ekor tidak boleh dipotong. Dipisah supaya
 * pemotongan bisa dikenakan ke kepala saja (lihat .nama di layout: spek flex-none).
 */
function pecahNama(nama: string): { merek: string; spek: string; kode: string } {
    // Prefiks 'P>' ikut terbawa dari sumber pada sebagian item. Noise, bukan informasi.
    const bersih = nama.replace(/^\s*P>\s*/i, "");
    // Kode internal di ekor ditulis dengan kutip yang tidak pernah ditutup ('"KR02').
    // Kutipnya dibuang; kodenya tetap ada karena membantu mencari di rak.
    const pisahKode = bersih.match(/^([^"]*)(".*)$/);
    const inti = (pisahKode?.[1] ?? bersih).trim();
    const kode = (pisahKode?.[2] ?? "").replace(/"/g, " ").replace(/\s+/g, " ").trim();
    // Digit harus diawali spasi: tanpa itu "CLOUD9" terbelah di tengah kata.
    const m = inti.match(/^(.*?\s)(\d.*)$/);
    return m ? { merek: m[1], spek: m[2], kode } : { merek: inti, spek: "", kode };
}

/** Satuan kecil dari ekor nama ("X 48 BTL" -> BTL). Default PCS. */
function satuanKecil(nama: string): string {
    return nama.match(/\b(?:X|x)\s*\d+\s*([A-Z]{2,4})\s*$/)?.[1] ?? "PCS";
}

/** Rayon "RTL BIG (600 KE ATAS)_UTARA KOTA": wilayah (ekor) ditebalkan, kanal (kepala) diredam; sama seperti TTF. */
const ekor = (v: string | null) => { const t = String(v ?? "").trim(); const i = t.lastIndexOf("_"); return i >= 0 ? t.slice(i + 1).trim() : t; };
const kepala = (v: string | null) => { const t = String(v ?? "").trim(); const i = t.lastIndexOf("_"); return i >= 0 ? t.slice(0, i).trim() : ""; };

/** Semua baris kini satu baris teks (nama tidak membungkus), jadi tingginya seragam. */
function bagiHalaman(baris: Baris[]): Baris[][] {
    const halaman: Baris[][] = [];
    let sekarang: Baris[] = [];
    let tinggi = 0;
    for (const r of baris) {
        const t = TINGGI_BARIS_MM + (r.pisah ? TINGGI_PEMISAH_MM : 0);
        const anggaran = halaman.length === 0 ? RUANG_ISI_HAL1_MM : RUANG_ISI_MM;
        if (tinggi + t > anggaran && sekarang.length) {
            halaman.push(sekarang);
            sekarang = [];
            tinggi = 0;
        }
        sekarang.push(r);
        tinggi += t;
    }
    if (sekarang.length) halaman.push(sekarang);
    return halaman.length ? halaman : [[]];
}

export default async function CetakRekapanPage({ params, searchParams }: Props) {
    const id = Number((await params).id);
    const grupIds = await grupDari(searchParams);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; status: string }>(
        `SELECT nama, tanggal::text, urutan, status::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];

    const [grup, rekapan] = await Promise.all([ambilPickGroup(grupIds), buildRekapan(id, grupIds)]);
    const { withdrawal, allocation, ringkasan } = rekapan;

    const krtDari = (r: WithdrawalRow) => Math.floor(Number(r.sat_bsr) || 0);
    const totalKarton = withdrawal.reduce((a, r) => a + krtDari(r), 0);
    const kodeGrup = grup.map((g) => g.kode).join("+") || "ALL";
    const noLembar = nomorLembar("RKP", wave.tanggal, id, kodeGrup);
    const tanggal = new Date(wave.tanggal + "T00:00:00").toLocaleDateString("id-ID",
        { day: "numeric", month: "long", year: "numeric" });

    const sekarang = new Date();
    // Dicetak di hari yang berbeda dari tanggal wave = besar kemungkinan cetak ulang, dan
    // lembar lama mungkin masih beredar di gudang. Dua lembar sama = risiko ambil dobel.
    const cetakUlang = hariIniWita(sekarang) !== wave.tanggal;
    const dicetak = jamWita(sekarang);
    const adaUrgent = allocation.some((a) => a.prioritas === "urgent");

    const baris: Baris[] = withdrawal.map((r, i) => ({
        ...r,
        keluarga: r.kode_barang.slice(0, 5),
        pisah: i > 0 && r.kode_barang.slice(0, 5) !== withdrawal[i - 1].kode_barang.slice(0, 5),
    }));
    const halaman = bagiHalaman(baris);

    // DUA PANEL (owner 20 Okt 2026, seperti Excel): barang di kiri, nota & rayon di kanan, di halaman
    // yang SAMA. Keduanya dipaginasi sendiri-sendiri dan bernomor sendiri: baris kanan TIDAK sejajar
    // dengan baris kiri dan tidak boleh terbaca begitu (nota ke-3 bukan pemesan barang ke-3).
    const halamanNota: { mulai: number; isi: typeof allocation }[] = [];
    for (let i = 0; i < allocation.length;) {
        const n = halamanNota.length === 0 ? NOTA_PER_PANEL_HAL1 : NOTA_PER_PANEL;
        halamanNota.push({ mulai: i, isi: allocation.slice(i, i + n) });
        i += n;
    }
    const barisBarangAda = baris.length > 0;
    const totalHalaman = Math.max(barisBarangAda ? halaman.length : 0, halamanNota.length, 1);

    return (
        <main className="cetak">
            {Array.from({ length: totalHalaman }, (_, h) => {
                const isi = barisBarangAda ? halaman[h] ?? [] : [];
                const nota = halamanNota[h];
                const krtHalaman = isi.reduce((a, r) => a + krtDari(r), 0);
                const pcsHalaman = isi.reduce((a, r) => a + Number(r.total_pcs), 0);
                return (
                    <section className="halaman" key={h}>
                        <div className="kop">
                            <div className="kop-baris">
                                <div>
                                    <div className="kop-judul">
                                        {grup.map((g) => g.nama).join("  +  ") || "SEMUA NOTA DI WAVE"}
                                    </div>
                                    <div className="kop-sub">
                                        {wave.nama.toUpperCase()} &middot; {tanggal} &middot; Wave #{id}
                                        {wave.status !== "released" && ` · ${wave.status.toUpperCase()}`}
                                        {cetakUlang && <b className="ulang">Cetak ulang</b>}
                                    </div>
                                    <div className="kop-sub">No. <b>{noLembar}</b> &middot; dicetak {dicetak} WITA</div>
                                </div>
                                <div className="kop-kanan">
                                    <div className="kop-kode">{kodeGrup}</div>
                                    <div className="kop-hal">Halaman {h + 1} dari {totalHalaman}</div>
                                </div>
                            </div>
                            {/* Empat angka besar + paraf hanya di halaman pertama. Diulang tiap halaman,
                                ia berhenti dibaca dan justru menenggelamkan subtotal halaman. */}
                            {h === 0 && (
                                <div className="angka-utama">
                                    <div><b>{ID(ringkasan.jumlahSku)}</b><span>Jenis barang</span></div>
                                    <div><b>{ID(totalKarton)}</b><span>Karton penuh</span></div>
                                    <div><b>{ID(ringkasan.totalPcs)}</b><span>Total pcs</span></div>
                                    <div><b>{ID(ringkasan.jumlahNota)}</b><span>Nota</span></div>
                                    <div className="paraf-ringkas">
                                        <div><span>Diambil oleh</span><u /></div>
                                        <div><span>Diperiksa oleh</span><u /></div>
                                        <div><span>Jam selesai</span><u /></div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="dua-panel">
                            <div>
                                {isi.length === 0 ? (
                                    <p className="panel-habis">
                                        {barisBarangAda ? `Daftar barang selesai di halaman ${halaman.length}.` : "Tidak ada barang untuk grup ini."}
                                    </p>
                                ) : (
                                    <table>
                                        <colgroup>
                                            <col style={{ width: "6mm" }} />
                                            <col />
                                            <col style={{ width: "33mm" }} />
                                            <col style={{ width: "15mm" }} />
                                        </colgroup>
                                        <thead>
                                            <tr className="judul-kolom">
                                                <th className="centang" />
                                                <th>Nama barang</th>
                                                <th className="kanan ambil">Ambil</th>
                                                <th className="kanan audit">Pcs / isi</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {isi.map((r) => {
                                                const konv = r.isi_per_karton;
                                                const tanpaKonversi = konv === null || konv === 0;
                                                const { merek, spek, kode } = pecahNama(r.nama_barang ?? "");
                                                const kecil = satuanKecil(r.nama_barang ?? "");
                                                const krt = krtDari(r);
                                                const kcl = Number(r.sat_kcl) || 0;

                                                return (
                                                    <Fragment key={r.kode_barang}>
                                                        {r.pisah && <tr className="keluarga"><td colSpan={4} /></tr>}
                                                        <tr>
                                                            <td className="centang"><i /></td>
                                                            <td className="nama">
                                                                {/* spek TIDAK boleh terpotong: di situlah pembeda
                                                                    antar varian. Yang dipotong kepala mereknya. */}
                                                                <span className="merek">{merek}</span>
                                                                <span className="spek">{spek}</span>
                                                                {kode && <span className="kode-internal">{kode}</span>}
                                                            </td>
                                                            {tanpaKonversi ? (
                                                                <td className="ambil cacat"><b>KONVERSI BELUM ADA</b></td>
                                                            ) : (
                                                                <td className="ambil">
                                                                    {/* Nol karton tidak boleh jadi angka terbesar:
                                                                        mata mendarat di "0" padahal yang diambil
                                                                        justru satuan kecilnya. */}
                                                                    {krt > 0 ? (
                                                                        <>
                                                                            <span className="n">{ID(krt)}</span>
                                                                            {/* isi 1 = barang tidak dikarton (jerigen,
                                                                                drum). Menyebutnya KRT menyesatkan. */}
                                                                            <span className="u">{konv === 1 ? kecil : "KRT"}</span>
                                                                            <span className="n2">{kcl > 0 ? `+${ID(kcl)}` : ""}</span>
                                                                            <span className="u2">{kcl > 0 ? kecil : ""}</span>
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <span className="n">{ID(kcl)}</span>
                                                                            <span className="u">{kecil}</span>
                                                                            <span className="n2" /><span className="u2" />
                                                                        </>
                                                                    )}
                                                                </td>
                                                            )}
                                                            <td className="audit">
                                                                {ID(Number(r.total_pcs))} / {tanpaKonversi ? "?" : ID(konv!)}
                                                            </td>
                                                        </tr>
                                                    </Fragment>
                                                );
                                            })}
                                        </tbody>
                                        <tfoot>
                                            {/* SUBTOTAL halaman ini, bukan grand total. Kalau satu lembar hilang,
                                                penjumlahan subtotal tidak akan sampai ke total di halaman 1. */}
                                            <tr className="total">
                                                <td colSpan={2} className="label">
                                                    Subtotal hal. {h + 1} &middot; {ID(isi.length)} jenis barang
                                                </td>
                                                <td className="ambil nilai">
                                                    {ID(krtHalaman)} <span className="satuan">KRT</span>
                                                </td>
                                                <td className="audit kuat">{ID(pcsHalaman)} pcs</td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                )}
                            </div>

                            <div className="panel-nota">
                                <div className="judul-kolom-nota">
                                    <span>Nomor nota &amp; rayon</span>
                                    {nota && <span>{ID(nota.mulai + 1)}–{ID(nota.mulai + nota.isi.length)} dari {ID(allocation.length)}</span>}
                                </div>
                                {nota ? nota.isi.map((a, i) => (
                                    <div key={a.no_nota} className={a.prioritas === "urgent" ? "nota urgent" : "nota"}>
                                        <i>{nota.mulai + i + 1}</i>
                                        <b>{a.no_nota}</b>
                                        <span><em>{ekor(a.region)}</em> {kepala(a.region)}</span>
                                    </div>
                                )) : (
                                    <p className="panel-habis">
                                        {allocation.length ? `Daftar nota selesai di halaman ${halamanNota.length}.` : "Tidak ada nota."}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="jejak">
                            <span>
                                Wave #{id} &middot; {kodeGrup} &middot; barang urut kode barang
                                {adaUrgent && " · ▲ = urgent"}
                            </span>
                            <span>
                                Halaman {h + 1} dari {totalHalaman} &middot; dicetak{" "}
                                {dicetak} WITA
                            </span>
                        </div>
                    </section>
                );
            })}
        </main>
    );
}
