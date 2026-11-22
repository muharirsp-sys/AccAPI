/*
 * Tujuan: Panel "Biasa diambil toko ini" (O3, owner 12 Okt 2026 sesi 13): setelah pelanggan dipilih, barang yang pernah dibeli toko itu
 *   (rata-rata per bulan + satuan, terakhir beli; urut terbesar, 10 teratas + "Lihat semua") supaya sales tahu apa yang biasa diambil.
 *   Owner 12 Nov 2026: sales WAJIB mengisi stok toko per barang + satuan dulu; saran = rata-rata − stok toko, ke atas (0 = "Stok toko cukup",
 *   tanpa tombol; petugas boleh kosong = 0). Stok toko hanya di layar, tidak ikut order.
 *   Tombol Tambah menambah baris order dengan satuan itu dan jumlah = saran (bisa diubah) — barang dibaca ulang dari
 *   pencarian barang cabang pelanggan (harga/satuan terkini), lalu pratinjau dihitung ulang seperti biasa (sidik). Barang yang kini tak bisa
 *   diorder tampil bertanda tanpa tombol. Keadaan: memuat / belum ada riwayat / galat + Coba lagi / sebagian faktur tanpa rincian (catatan) /
 *   faktur rusak dilewati (catatan). Ganti pelanggan membatalkan pembacaan barang Tambah yang masih berjalan.
 * Caller: app/(dashboard)/sales/OrderSales.tsx (peran sales), app/(dashboard)/orders/OrderBaru.tsx (peran petugas).
 * Dependensi: GET /api/customers/riwayat-beli (lib/riwayat-beli: bentuk + logika murni), ./order-cabang-api (bacaBarangKode = GET
 *   /api/items/search), ./order-cabang, app/(dashboard)/form-kontrol/lapangan (ambilJson), components/fiori/*, lib/rekapan-nota/ui.
 * Main Functions: RiwayatBeli.
 * Side Effects: HTTP GET saja; tidak menyimpan apa pun (baris baru hanya masuk isian order di layar).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button, MessageStrip, Section, Skeleton, StatusBadge } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { bacaRiwayat, bacaStokToko, kunciBaris, saranTambah, satuanTambah, urlRiwayat, type BarangRiwayatOrder, type Riwayat } from "@/lib/riwayat-beli";
import { galatDariJawaban, kalimatGalat, kunciHarga, tanggalSah, type BarangPilih, type PelangganPilih, type Peran } from "./order-cabang";
import { bacaBarangKode } from "./order-cabang-api";

const TERATAS = 10;
const angka = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 1 });

type Props = {
    pelanggan: PelangganPilih;
    /** Tanggal order (harga barang yang ditambahkan mengikuti tanggal ini). */
    tanggal: string;
    peran: Peran;
    /** Baris order sekarang: barang + satuan yang sudah ada tidak ditawarkan lagi. */
    baris: readonly { code: string; unit: string }[];
    /** Tambah baris order: barang (dari pencarian barang cabang pelanggan), satuan master, jumlah usulan. */
    onTambah: (b: BarangPilih, unit: string, quantity: string) => void;
};

/** Satu panel per pelanggan (`key`): ganti pelanggan = keadaan tombol & "Lihat semua" mulai dari awal. */
export function RiwayatBeli(props: Props) {
    return <Panel key={props.pelanggan.customerNo} {...props} />;
}

type Aksi = { jenis: "memuat" } | { jenis: "galat"; pesan: string };

function Panel({ pelanggan, tanggal, peran, baris, onTambah }: Props) {
    const no = pelanggan.customerNo;
    const muat = useCallback(async (): Promise<Load<Riwayat>> => {
        const j = await ambilJson(urlRiwayat(no), { credentials: "include" });
        const r = j.status >= 200 && j.status < 300 && j.data?.ok === true ? bacaRiwayat(j.data) : null;
        if (r) return { status: "siap", data: r };
        const g = galatDariJawaban(j, peran);
        return { status: "galat", error: kalimatGalat(g) };
    }, [no, peran]);
    const [riwayat, muatUlang] = useLoad(muat);
    const [semua, setSemua] = useState(false);
    const [aksi, setAksi] = useState<Record<string, Aksi>>({});
    const diOrder = new Set(baris.filter((l) => l.code.trim()).map((l) => kunciBaris(l.code, l.unit)));
    const tanpaTanggal = tanggalSah(tanggal) ? undefined : "Isi tanggal order dulu";
    // Ganti pelanggan = panel ini dilepas (`key`) -> pembacaan barang Tambah yang masih berjalan DIBATALKAN: tanpa ini jawabannya tiba
    // sesudahnya dan barang pelanggan LAMA masuk ke order pelanggan baru (onTambah = setLines(prev => ...)).
    const lepas = useRef<AbortController | null>(null);
    useEffect(() => { const c = new AbortController(); lepas.current = c; return () => c.abort(); }, []);

    // Stok toko per barang + satuan (teks ketikan). Sales WAJIB mengisinya (0 bila habis) sebelum Tambah; petugas Order Baru boleh
    // kosong (= 0, saran = rata-rata seperti dulu). Hanya di layar: tidak dikirim/disimpan bersama order.
    const [stokToko, setStokToko] = useState<Record<string, string>>({});
    const wajibStok = peran === "sales";

    async function tambah(x: BarangRiwayatOrder, jumlah: number) {
        const sinyal = lepas.current?.signal;
        if (!sinyal) return;
        const k = kunciBaris(x.code, x.unit);
        const set = (a: Aksi | null) => setAksi((prev) => { const s = { ...prev }; if (a) s[k] = a; else delete s[k]; return s; });
        set({ jenis: "memuat" });
        // Dibaca ulang dari pencarian barang cabang pelanggan: cabang/suspended/satuan/harga TERKINI (riwayat bisa lebih tua dari master).
        const h = await bacaBarangKode(x.code, pelanggan, tanggal, sinyal, peran);
        if (!h.ok) { set("batal" in h ? null : { jenis: "galat", pesan: kalimatGalat(h.galat) }); return; }
        if (!h.data) { set({ jenis: "galat", pesan: `${x.code} tidak ada lagi di barang cabang ${pelanggan.branchName} (nonaktif atau pindah cabang). Cari barang lain.` }); return; }
        const s = satuanTambah(h.data, x.unit, peran, kunciHarga(pelanggan.id, tanggal));
        if ("alasan" in s) { set({ jenis: "galat", pesan: s.alasan }); return; }
        set(null);
        onTambah(h.data, s.unit, String(jumlah));
    }

    const r = riwayat.data;
    const items = r ? (semua ? r.items : r.items.slice(0, TERATAS)) : [];
    const sejak = r ? tanggalPendek(r.jendela.dari) : "";
    return (
        <Section title="Biasa diambil toko ini" subtitle={r ? `rata-rata per bulan · ${angka(r.jendela.bulanTeramati)} bulan terakhir` : "rata-rata per bulan"}>
            <div className="fi-sect-in" aria-live="polite">
                {riwayat.status === "memuat" && !r && <Skeleton rows={3} label="Memuat riwayat beli toko" />}
                {riwayat.status === "galat" && (
                    <MessageStrip tone="neg" title="Riwayat beli toko belum terbaca.">
                        {riwayat.error}{r ? " Yang tampil adalah hasil sebelumnya." : " Ini bukan berarti toko belum pernah beli."}{" "}
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                    </MessageStrip>
                )}
                {r && r.ringkasan.jumlahFaktur === 0 && r.ringkasan.dilewati === 0 && <p className="fi-muted" style={{ margin: 0 }}>Toko ini belum punya riwayat faktur sejak {sejak}.</p>}
                {r && r.ringkasan.jumlahFaktur > 0 && r.items.length === 0 && (
                    <p className="fi-muted" style={{ margin: 0 }}>
                        Ada {r.ringkasan.jumlahFaktur} faktur sejak {sejak}, tetapi rincian barangnya belum tersedia di data kami, jadi rata-rata belum bisa dihitung.
                    </p>
                )}
                {items.length > 0 && (
                    <ul aria-label="Riwayat beli toko" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {items.map((x) => {
                            const k = kunciBaris(x.code, x.unit);
                            const a = aksi[k];
                            const nama = x.name || x.code;
                            // Baris yang bisa ditambah: kolom stok toko + tombol bersaran. Lainnya: tanda saja (tanpa kolom stok).
                            const isiStok = x.bisaDiorder && !diOrder.has(k);
                            const teks = stokToko[k] ?? "";
                            const stok = bacaStokToko(teks) ?? (wajibStok || teks.trim() ? null : 0);
                            const n = stok === null ? null : saranTambah(x.rataPerBulan, stok);
                            const alasanStok = teks.trim() ? "Stok toko harus bilangan bulat 0 atau lebih" : "Isi stok toko dulu (0 bila habis)";
                            const meta = (
                                <span className="fi-small fi-muted" style={{ overflowWrap: "anywhere", ...(isiStok ? { gridColumn: "1 / -1" } : {}) }}>
                                    <span className="fi-mono">{x.code}</span> · terakhir {tanggalPendek(x.terakhirBeli)} · {x.jumlahFaktur} faktur
                                </span>
                            );
                            return (
                                // Dua kolom (nama | rata-rata, stok toko | aksi): di ponsel 390 px tombol tetap sebaris dengan barangnya.
                                <li key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: "2px 12px", padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                                    <b style={{ overflowWrap: "anywhere" }}>{nama}</b>
                                    <span className="fi-tnum" style={{ whiteSpace: "nowrap", justifySelf: "end" }}><b>{angka(x.rataPerBulan)} {x.unit}</b><span className="fi-small fi-muted"> / bulan</span></span>
                                    {meta}
                                    {isiStok ? (
                                        <>
                                            <label className="fi-small" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginTop: 4 }}>
                                                <span style={{ whiteSpace: "nowrap" }}>Stok toko</span>
                                                <input className="fi-input fi-tnum" inputMode="numeric" autoComplete="off" style={{ width: 72, flex: "none" }}
                                                    aria-label={`Stok toko ${nama} (${x.unit})`} placeholder={wajibStok ? "wajib" : "0"} value={teks}
                                                    aria-invalid={(teks.trim() !== "" && bacaStokToko(teks) === null) || undefined}
                                                    onChange={(e) => { const v = e.target.value; setStokToko((p) => ({ ...p, [k]: v })); }} />
                                                <span>{x.unit}</span>
                                            </label>
                                            <span style={{ justifySelf: "end", marginTop: 4 }}>
                                                {n === 0 ? (
                                                    <StatusBadge tone="pos">Stok toko cukup</StatusBadge>
                                                ) : (
                                                    <Button variant="secondary" icon={<Plus className="fi-icon" aria-hidden />} busy={a?.jenis === "memuat"}
                                                        disabled={Boolean(tanpaTanggal) || n === null} disabledReason={tanpaTanggal ?? (n === null ? alasanStok : undefined)}
                                                        aria-label={n === null ? `Tambah ${nama} ${x.unit}` : `Tambah ${n} ${x.unit} ${nama}`}
                                                        onClick={() => { if (n) void tambah(x, n); }}>{n === null ? "Tambah" : `Tambah ${n} ${x.unit}`}</Button>
                                                )}
                                            </span>
                                        </>
                                    ) : (
                                        <span style={{ justifySelf: "end" }}>
                                            {!x.bisaDiorder ? <StatusBadge tone="warn">Tidak bisa diorder</StatusBadge> : <StatusBadge tone="neu">Sudah di order</StatusBadge>}
                                        </span>
                                    )}
                                    {/* Alasan di baris PENUH, bukan di sel kanan: alasan bertag (`tanpa cabang (tag "…" tidak bisa diorder)`) selebar
                                        teksnya di sel `auto` meruntuhkan kolom nama ke 0 px di 390 px. */}
                                    {!x.bisaDiorder && x.alasan && <span className="fi-small fi-muted" style={{ gridColumn: "1 / -1", overflowWrap: "anywhere" }}>{x.alasan}</span>}
                                    {a?.jenis === "galat" && <p className="fi-small fi-msg" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }}>{a.pesan}</p>}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {r && r.items.length > TERATAS && (
                    <div style={{ marginTop: 8 }}>
                        <Button variant="tertiary" onClick={() => setSemua((v) => !v)}>{semua ? `Tampilkan ${TERATAS} teratas` : `Lihat semua (${r.items.length})`}</Button>
                    </div>
                )}
                {r && r.ringkasan.tanpaRincian > 0 && r.items.length > 0 && (
                    <p className="fi-small fi-why" style={{ margin: "8px 0 0" }}>
                        {r.ringkasan.tanpaRincian} dari {r.ringkasan.jumlahFaktur} faktur sejak {sejak} belum punya rincian barang di data kami, jadi rata-rata bisa lebih kecil dari kenyataan.
                    </p>
                )}
                {r && r.ringkasan.dilewati > 0 && (
                    <p className="fi-small fi-why" style={{ margin: "8px 0 0" }}>
                        {r.ringkasan.dilewati} faktur toko ini dilewati karena tanggal atau isinya tidak terbaca di data kami, jadi tidak ikut dihitung.
                    </p>
                )}
                {r && r.items.length > 0 && (
                    <p className="fi-small fi-muted" style={{ margin: "8px 0 0" }}>
                        Rata-rata = jumlah dibeli ÷ {angka(r.jendela.bulanTeramati)} bulan
                        {r.ringkasan.dataSejak && r.ringkasan.dataSejak > r.jendela.dari ? ` (data toko ini baru ada sejak ${tanggalPendek(r.ringkasan.dataSejak)})` : ` (sejak ${sejak})`}.
                        Bonus promo tidak dihitung; retur belum dikurangkan. Saran Tambah = rata-rata per bulan − stok toko (satuan yang sama),
                        dibulatkan ke atas{wajibStok ? "; stok toko wajib diisi, 0 bila habis" : "; stok toko kosong = 0"}. Jumlahnya bisa diubah di baris order.
                    </p>
                )}
            </div>
        </Section>
    );
}
