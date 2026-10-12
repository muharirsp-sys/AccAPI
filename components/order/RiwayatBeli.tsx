/*
 * Tujuan: Panel "Biasa diambil toko ini" (O3, owner 12 Okt 2026 sesi 13): setelah pelanggan dipilih, barang yang pernah dibeli toko itu
 *   (rata-rata per bulan + satuan, terakhir beli; urut terbesar, 10 teratas + "Lihat semua") supaya sales tahu apa yang biasa diambil.
 *   Tombol Tambah menambah baris order dengan satuan itu dan jumlah = pembulatan ke atas rata-rata (bisa diubah) — barang dibaca ulang dari
 *   pencarian barang cabang pelanggan (harga/satuan terkini), lalu pratinjau dihitung ulang seperti biasa (sidik). Barang yang kini tak bisa
 *   diorder tampil bertanda tanpa tombol. Keadaan: memuat / belum ada riwayat / galat + Coba lagi / sebagian faktur tanpa rincian (catatan).
 * Caller: app/(dashboard)/sales/OrderSales.tsx (peran sales), app/(dashboard)/orders/OrderBaru.tsx (peran petugas).
 * Dependensi: GET /api/customers/riwayat-beli (lib/riwayat-beli: bentuk + logika murni), ./order-cabang-api (bacaBarangKode = GET
 *   /api/items/search), ./order-cabang, app/(dashboard)/form-kontrol/lapangan (ambilJson), components/fiori/*, lib/rekapan-nota/ui.
 * Main Functions: RiwayatBeli.
 * Side Effects: HTTP GET saja; tidak menyimpan apa pun (baris baru hanya masuk isian order di layar).
 */
"use client";

import { useCallback, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button, MessageStrip, Section, Skeleton, StatusBadge } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { bacaRiwayat, jumlahTambah, kunciBaris, satuanTambah, urlRiwayat, type BarangRiwayatOrder, type Riwayat } from "@/lib/riwayat-beli";
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

    async function tambah(x: BarangRiwayatOrder) {
        const k = kunciBaris(x.code, x.unit);
        const set = (a: Aksi | null) => setAksi((prev) => { const s = { ...prev }; if (a) s[k] = a; else delete s[k]; return s; });
        set({ jenis: "memuat" });
        // Dibaca ulang dari pencarian barang cabang pelanggan: cabang/suspended/satuan/harga TERKINI (riwayat bisa lebih tua dari master).
        const h = await bacaBarangKode(x.code, pelanggan, tanggal, new AbortController().signal, peran);
        if (!h.ok) { set("batal" in h ? null : { jenis: "galat", pesan: kalimatGalat(h.galat) }); return; }
        if (!h.data) { set({ jenis: "galat", pesan: `${x.code} tidak ada lagi di barang cabang ${pelanggan.branchName} (nonaktif atau pindah cabang). Cari barang lain.` }); return; }
        const s = satuanTambah(h.data, x.unit, peran, kunciHarga(pelanggan.id, tanggal));
        if ("alasan" in s) { set({ jenis: "galat", pesan: s.alasan }); return; }
        set(null);
        onTambah(h.data, s.unit, String(jumlahTambah(x.rataPerBulan)));
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
                {r && r.ringkasan.jumlahFaktur === 0 && <p className="fi-muted" style={{ margin: 0 }}>Toko ini belum punya riwayat faktur sejak {sejak}.</p>}
                {r && r.ringkasan.jumlahFaktur > 0 && r.items.length === 0 && (
                    <p className="fi-muted" style={{ margin: 0 }}>
                        Ada {r.ringkasan.jumlahFaktur} faktur sejak {sejak}, tetapi rincian barangnya belum tersedia di data kami — rata-rata belum bisa dihitung.
                    </p>
                )}
                {items.length > 0 && (
                    <ul aria-label="Riwayat beli toko" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {items.map((x) => {
                            const k = kunciBaris(x.code, x.unit);
                            const a = aksi[k];
                            const n = jumlahTambah(x.rataPerBulan);
                            return (
                                // Dua kolom (nama | rata-rata, keterangan | aksi): di ponsel 390 px tombol tetap sebaris dengan barangnya.
                                <li key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: "2px 12px", padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                                    <b style={{ overflowWrap: "anywhere" }}>{x.name || x.code}</b>
                                    <span className="fi-tnum" style={{ whiteSpace: "nowrap", justifySelf: "end" }}><b>{angka(x.rataPerBulan)} {x.unit}</b><span className="fi-small fi-muted"> / bulan</span></span>
                                    <span className="fi-small fi-muted" style={{ overflowWrap: "anywhere" }}>
                                        <span className="fi-mono">{x.code}</span> · terakhir {tanggalPendek(x.terakhirBeli)} · {x.jumlahFaktur} faktur
                                    </span>
                                    <span style={{ justifySelf: "end", display: "grid", gap: 2, justifyItems: "end", textAlign: "right" }}>
                                        {!x.bisaDiorder ? (
                                            <>
                                                <StatusBadge tone="warn">Tidak bisa diorder</StatusBadge>
                                                {x.alasan && <span className="fi-small fi-muted">{x.alasan}</span>}
                                            </>
                                        ) : diOrder.has(k) ? (
                                            <StatusBadge tone="neu">Sudah di order</StatusBadge>
                                        ) : (
                                            <Button variant="secondary" icon={<Plus className="fi-icon" aria-hidden />} busy={a?.jenis === "memuat"} disabled={Boolean(tanpaTanggal)} disabledReason={tanpaTanggal}
                                                aria-label={`Tambah ${n} ${x.unit} ${x.name || x.code}`} onClick={() => void tambah(x)}>Tambah {n} {x.unit}</Button>
                                        )}
                                    </span>
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
                        {r.ringkasan.tanpaRincian} dari {r.ringkasan.jumlahFaktur} faktur sejak {sejak} belum punya rincian barang di data kami — rata-rata bisa lebih kecil dari kenyataan.
                    </p>
                )}
                {r && r.items.length > 0 && (
                    <p className="fi-small fi-muted" style={{ margin: "8px 0 0" }}>
                        Rata-rata = jumlah dibeli ÷ {angka(r.jendela.bulanTeramati)} bulan
                        {r.ringkasan.dataSejak && r.ringkasan.dataSejak > r.jendela.dari ? ` (data toko ini baru ada sejak ${tanggalPendek(r.ringkasan.dataSejak)})` : ` (sejak ${sejak})`}.
                        Bonus promo tidak dihitung; retur belum dikurangkan. Tambah memakai pembulatan ke atas — jumlahnya bisa diubah di baris order.
                    </p>
                )}
            </div>
        </Section>
    );
}
