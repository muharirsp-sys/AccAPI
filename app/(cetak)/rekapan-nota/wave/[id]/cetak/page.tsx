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
import { Fragment } from "react";
import { pool } from "@/lib/db";
import { ambilPickGroup, buildRekapan, type WithdrawalRow } from "@/lib/rekapan-nota/query";
import TombolCetak from "../../../../TombolCetak";

export const dynamic = "force-dynamic";

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
/** Nota per halaman penutup. 3 kolom x ~40 baris; diukur, bukan ditebak. */
const NOTA_PER_HALAMAN = 111;

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

export default async function CetakRekapanPage({
    params, searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ grup?: string }>;
}) {
    const id = Number((await params).id);
    const grupIds = String((await searchParams).grup ?? "")
        .split(",").map(Number).filter(Number.isInteger);

    const w = await pool.query<{ nama: string; tanggal: string; urutan: number; status: string }>(
        `SELECT nama, tanggal::text, urutan, status::text FROM wave WHERE id = $1`, [id]);
    if (!w.rowCount) return <p>Wave tidak ditemukan.</p>;
    const wave = w.rows[0];

    const [grup, rekapan] = await Promise.all([ambilPickGroup(grupIds), buildRekapan(id, grupIds)]);
    const { withdrawal, allocation, ringkasan } = rekapan;

    const krtDari = (r: WithdrawalRow) => Math.floor(Number(r.sat_bsr) || 0);
    const totalKarton = withdrawal.reduce((a, r) => a + krtDari(r), 0);
    const kodeGrup = grup.map((g) => g.kode).join("+") || "ALL";
    const tanggal = new Date(wave.tanggal + "T00:00:00").toLocaleDateString("id-ID",
        { day: "numeric", month: "long", year: "numeric" });

    const sekarang = new Date();
    // Dicetak di hari yang berbeda dari tanggal wave = besar kemungkinan cetak ulang, dan
    // lembar lama mungkin masih beredar di gudang. Dua lembar sama = risiko ambil dobel.
    const cetakUlang = sekarang.toISOString().slice(0, 10) !== wave.tanggal;
    const adaUrgent = allocation.some((a) => a.prioritas === "urgent");

    const baris: Baris[] = withdrawal.map((r, i) => ({
        ...r,
        keluarga: r.kode_barang.slice(0, 5),
        pisah: i > 0 && r.kode_barang.slice(0, 5) !== withdrawal[i - 1].kode_barang.slice(0, 5),
    }));
    const halaman = bagiHalaman(baris);

    // Daftar nota ikut dipaginasi. Ditempel utuh di satu halaman, 169 nota membuatnya
    // 340mm dan browser memecahnya di luar hitungan -- nomor halaman jadi bohong lagi.
    const halamanNota: typeof allocation[] = [];
    for (let i = 0; i < allocation.length; i += NOTA_PER_HALAMAN) {
        halamanNota.push(allocation.slice(i, i + NOTA_PER_HALAMAN));
    }
    if (!halamanNota.length) halamanNota.push([]);
    const totalHalaman = halaman.length + halamanNota.length;

    return (
        <main className="cetak">
            <div className="layar-saja"><TombolCetak /></div>

            {halaman.map((isi, h) => {
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
                                </div>
                                <div className="kop-kanan">
                                    <div className="kop-kode">{kodeGrup}</div>
                                    <div className="kop-hal">Halaman {h + 1} dari {totalHalaman}</div>
                                </div>
                            </div>
                            {/* Empat angka besar hanya di halaman pertama. Diulang sepuluh kali,
                                ia berhenti dibaca dan justru menenggelamkan subtotal halaman. */}
                            {h === 0 && (
                                <div className="angka-utama">
                                    <div><b>{ID(ringkasan.jumlahSku)}</b><span>Jenis barang</span></div>
                                    <div><b>{ID(totalKarton)}</b><span>Karton penuh</span></div>
                                    <div><b>{ID(ringkasan.totalPcs)}</b><span>Total pcs</span></div>
                                    <div><b>{ID(ringkasan.jumlahNota)}</b><span>Nota</span></div>
                                </div>
                            )}
                        </div>

                        <table>
                            <colgroup>
                                <col style={{ width: "7mm" }} />
                                <col style={{ width: "30mm" }} />
                                <col />
                                <col style={{ width: "38mm" }} />
                                <col style={{ width: "24mm" }} />
                            </colgroup>
                            <thead>
                                <tr className="judul-kolom">
                                    <th className="centang" />
                                    <th className="kode">Kode</th>
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
                                            {r.pisah && <tr className="keluarga"><td colSpan={5} /></tr>}
                                            <tr>
                                                <td className="centang"><i /></td>
                                                <td className="kode">{r.kode_barang}</td>
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
                                                    {ID(Number(r.total_pcs))} {kecil.toLowerCase()}
                                                    {" · "}{tanpaKonversi ? "isi ?" : `isi ${ID(konv!)}`}
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
                                        Subtotal halaman {h + 1} dari {totalHalaman}
                                    </td>
                                    <td className="label">{ID(isi.length)} jenis barang</td>
                                    <td className="ambil nilai">
                                        {ID(krtHalaman)} <span className="satuan">KRT</span>
                                    </td>
                                    <td className="audit kuat">{ID(pcsHalaman)} pcs</td>
                                </tr>
                            </tfoot>
                        </table>

                        <div className="jejak">
                            <span>
                                Wave #{id} &middot; {kodeGrup} &middot; urut kode barang
                                {adaUrgent && " · ▲ = urgent"}
                            </span>
                            <span>
                                Halaman {h + 1} dari {totalHalaman} &middot; dicetak{" "}
                                {sekarang.toLocaleString("id-ID")}
                            </span>
                        </div>
                    </section>
                );
            })}

            {/* Halaman penutup: tanda tangan + daftar nota, ikut dipaginasi supaya tidak
                pernah melebihi satu kertas. Empat angka besar TIDAK diulang di sini --
                sudah ada di halaman 1, dan mengulangnya cuma menenggelamkan isi. */}
            {halamanNota.map((nota, n) => {
                const nomor = halaman.length + n + 1;
                return (
                    <section className="halaman penutup" key={`n${n}`}>
                        <div className="kop">
                            <div className="kop-baris">
                                <div>
                                    <div className="kop-judul">
                                        Nota dalam lembar ini
                                        {halamanNota.length > 1 && ` (${n + 1}/${halamanNota.length})`}
                                    </div>
                                    <div className="kop-sub">
                                        {grup.map((g) => g.nama).join("  +  ") || "SEMUA NOTA DI WAVE"}
                                        {" · "}{wave.nama.toUpperCase()} &middot; {tanggal} &middot; Wave #{id}
                                        {cetakUlang && <b className="ulang">Cetak ulang</b>}
                                    </div>
                                </div>
                                <div className="kop-kanan">
                                    <div className="kop-kode">{kodeGrup}</div>
                                    <div className="kop-hal">Halaman {nomor} dari {totalHalaman}</div>
                                </div>
                            </div>
                        </div>

                        {/* Verifikasi dua langkah, hanya di halaman penutup pertama. */}
                        {n === 0 && (
                            <div className="paraf">
                                <div><span>Diambil oleh</span><u /></div>
                                <div><span>Diperiksa oleh</span><u /></div>
                                <div><span>Jam selesai</span><u /></div>
                            </div>
                        )}

                        <section className="blok-nota">
                            <h2>
                                {ID(nota.length)} nota
                                {halamanNota.length > 1 && ` dari ${ID(ringkasan.jumlahNota)}`}
                                {" · "}{ID(ringkasan.totalPcs)} pcs total lembar ini
                            </h2>
                            <div className="grid-nota">
                                {nota.map((a) => (
                                    <div key={a.no_nota} className={a.prioritas === "urgent" ? "urgent" : undefined}>
                                        <b>{a.no_nota}</b>
                                        <i>{ID(Number(a.total_pcs))}</i>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <div className="jejak">
                            <span>
                                Wave #{id} &middot; {kodeGrup}
                                {adaUrgent && " · \u25B2 = urgent"}
                            </span>
                            <span>
                                Halaman {nomor} dari {totalHalaman} &middot; dicetak{" "}
                                {sekarang.toLocaleString("id-ID")}
                            </span>
                        </div>
                    </section>
                );
            })}
        </main>
    );
}
