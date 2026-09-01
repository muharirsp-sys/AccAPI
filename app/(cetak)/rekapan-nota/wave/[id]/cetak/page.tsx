/*
 * Tujuan: SATU lembar picking berparameter pick_group — pengganti 29+ sheet `Print Rkpn *`.
 * Caller: /rekapan-nota/wave/[id]/cetak?grup=1,7 (tab baru dari layar penyusunan wave).
 * Dependensi: lib/rekapan-nota/query (buildRekapan, ambilPickGroup), lib/db.
 * Main Functions: CetakRekapanPage, pecahNama, satuanKecil.
 * Side Effects: Hanya SELECT. Server component: query di server, tanpa hop API.
 *
 * Daftar nota TIDAK lagi disandingkan sebaris dengan daftar barang. Di versi sebelumnya
 * keduanya berbagi satu <tr> dan hanya sejajar karena kebetulan urutan array — baris ke-5
 * barang tidak punya hubungan apa pun dengan nota ke-5. Tampilan yang MENYIRATKAN hubungan
 * yang tidak ada adalah kelas kesalahan yang sama dengan yang sedang diperbaiki modul ini.
 */
import { Fragment } from "react";
import { pool } from "@/lib/db";
import { ambilPickGroup, buildRekapan } from "@/lib/rekapan-nota/query";
import TombolCetak from "../../../../TombolCetak";

export const dynamic = "force-dynamic";

const ID = (v: number, d = 0) =>
    v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Nama barang beruntun mirip: "ABC KECAP MANIS 62 GR X 48 PCH", "... 130 ML X 48 BTL",
 * "... 250 GR X 24 PCH". Merek berulang, pembedanya di ekor. Jadi ekornya ditebalkan.
 * ponytail: satu regex di angka pertama. Nama tanpa angka tampil biasa — tidak rusak,
 * cuma tidak dapat penekanan.
 */
function pecahNama(nama: string): { merek: string; spek: string; kode: string } {
    // Kode internal di ekor ('..."KR02', '"BT101202"BV01') bukan pembeda yang dilihat
    // picker -- diredam, tidak dibuang.
    const pisahKode = nama.match(/^([^"]*)(".*)$/);
    const inti = (pisahKode?.[1] ?? nama).trim();
    const kode = pisahKode?.[2] ?? "";
    // Digit harus diawali spasi: tanpa itu "CLOUD9" terbelah di tengah kata.
    const m = inti.match(/^(.*?\s)(\d.*)$/);
    return m ? { merek: m[1], spek: m[2], kode } : { merek: inti, spek: "", kode };
}

/** Satuan kecil dari ekor nama ("X 48 BTL" -> BTL). Default PCS. */
function satuanKecil(nama: string): string {
    return nama.match(/\b(?:X|x)\s*\d+\s*([A-Z]{2,4})\s*$/)?.[1] ?? "PCS";
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

    const totalKarton = withdrawal.reduce((a, r) => a + Math.floor(Number(r.sat_bsr) || 0), 0);
    const tanggal = new Date(wave.tanggal + "T00:00:00").toLocaleDateString("id-ID",
        { day: "numeric", month: "long", year: "numeric" });

    // Batas keluarga produk dihitung SEBELUM render, bukan dengan variabel yang dimutasi
    // sambil memetakan baris.
    const baris = withdrawal.map((r, i) => {
        const keluarga = r.kode_barang.slice(0, 5);
        return {
            ...r,
            keluarga,
            pisah: i > 0 && keluarga !== withdrawal[i - 1].kode_barang.slice(0, 5),
            tandai5: (i + 1) % 5 === 0,
        };
    });

    return (
        <main className="cetak">
            <div className="layar-saja"><TombolCetak /></div>

            <table>
                <thead>
                    {/* Kop ikut tiap halaman: satu lembar yang tergeletak di lantai gudang
                        harus bisa dikenali tanpa mencari halaman pertamanya. */}
                    <tr><th colSpan={5} style={{ padding: 0, border: "none" }}>
                        <div className="kop">
                            <div className="kop-baris">
                                <div>
                                    <div className="kop-judul">
                                        {grup.map((g) => g.nama).join("  +  ") || "SEMUA NOTA DI WAVE"}
                                    </div>
                                    <div className="kop-sub">
                                        {wave.nama.toUpperCase()} &middot; {tanggal} &middot; Wave #{id}
                                        {wave.status !== "released" && ` · ${wave.status.toUpperCase()}`}
                                    </div>
                                </div>
                                <div className="kop-kode">{grup.map((g) => g.kode).join("+") || "ALL"}</div>
                            </div>
                            <div className="angka-utama">
                                <div><b>{ID(ringkasan.jumlahSku)}</b><span>Jenis barang</span></div>
                                <div><b>{ID(totalKarton)}</b><span>Karton penuh</span></div>
                                <div><b>{ID(ringkasan.totalPcs)}</b><span>Total pcs</span></div>
                                <div><b>{ID(ringkasan.jumlahNota)}</b><span>Nota</span></div>
                            </div>
                        </div>
                    </th></tr>
                    <tr className="judul-kolom">
                        <th className="centang" />
                        <th className="kode">Kode</th>
                        <th>Nama barang</th>
                        <th className="kanan ambil">Ambil</th>
                        <th className="kanan audit">Periksa</th>
                    </tr>
                </thead>

                <tbody>
                    {baris.map((r) => {
                        const isi = r.isi_per_karton;
                        const tanpaKonversi = isi === null || isi === 0;
                        const { merek, spek, kode } = pecahNama(r.nama_barang ?? "");
                        const kecil = satuanKecil(r.nama_barang ?? "");
                        const krt = Math.floor(Number(r.sat_bsr) || 0);
                        const kcl = Number(r.sat_kcl) || 0;

                        return (
                            <Fragment key={r.kode_barang}>
                                {r.pisah && (
                                    <tr className="keluarga"><td colSpan={5} /></tr>
                                )}
                                <tr className={r.tandai5 ? "tandai-5" : undefined}>
                                    <td className="centang"><i /></td>
                                    <td className="kode">{r.kode_barang}</td>
                                    <td className="nama">
                                        <span className="merek">{merek}</span>
                                        <span className="spek">{spek}</span>
                                        {kode && <span className="kode-internal"> {kode}</span>}
                                    </td>
                                    {tanpaKonversi ? (
                                        <td className="ambil cacat"><b>KONVERSI BELUM ADA</b></td>
                                    ) : (
                                        <td className="ambil">
                                            {/* Nol karton TIDAK boleh jadi angka terbesar di baris:
                                                mata mendarat di "0" padahal yang diambil justru
                                                satuan kecilnya. Tanpa karton penuh, satuan kecil
                                                yang naik jadi angka utama. */}
                                            {krt > 0 ? (
                                                <>
                                                    <span className="n">{ID(krt)}</span>
                                                    {/* isi 1 = barang tidak dikarton (jerigen, drum).
                                                        Menyebutnya "KRT" salah dan menyesatkan. */}
                                                    <span className="u">{isi === 1 ? kecil : "KRT"}</span>
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
                                        {" · "}{tanpaKonversi ? "isi ?" : `isi ${ID(isi!)}`}
                                    </td>
                                </tr>
                            </Fragment>
                        );
                    })}
                </tbody>

                <tfoot>
                    <tr className="total">
                        <td colSpan={2} className="label">Total lembar ini</td>
                        <td className="label" />
                        <td className="ambil nilai" style={{ background: "none" }}>
                            {ID(totalKarton)} <span className="satuan">KRT</span>
                        </td>
                        <td className="audit" style={{ fontSize: "8pt", color: "#111", fontWeight: 700 }}>
                            {ID(ringkasan.totalPcs)} pcs
                        </td>
                    </tr>
                </tfoot>
            </table>

            {/* Verifikasi dua langkah: yang mengambil dan yang memeriksa adalah orang berbeda. */}
            <div className="paraf">
                <div><span>Diambil oleh</span><u /></div>
                <div><span>Diperiksa oleh</span><u /></div>
                <div><span>Jam selesai</span><u /></div>
            </div>

            <section className="blok-nota">
                <h2>Nota dalam lembar ini &mdash; {ID(ringkasan.jumlahNota)}</h2>
                <div className="grid-nota">
                    {allocation.map((a) => (
                        <div key={a.no_nota} className={a.prioritas === "urgent" ? "urgent" : undefined}>
                            <b>{a.no_nota}</b>
                            <i>{ID(Number(a.total_pcs))}</i>
                        </div>
                    ))}
                </div>
            </section>

            <div className="jejak">
                <span>
                    Wave #{id} &middot; {grup.map((g) => g.kode).join("+") || "(semua grup)"} &middot;{" "}
                    urut kode barang &middot; &#9650; = urgent
                </span>
                <span>Dicetak {new Date().toLocaleString("id-ID")}</span>
            </div>
        </main>
    );
}
