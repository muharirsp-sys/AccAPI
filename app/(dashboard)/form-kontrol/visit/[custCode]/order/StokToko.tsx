/*
 * Tujuan: Bagian "Stok toko sekarang" halaman order kunjungan (owner 14 Nov 2026: "isi stok toko saat ini berdasarkan data history pengambilan
 *   yang ada"). Daftar = riwayat pengambilan toko (faktur Accurate 3 bulan, per barang + satuan, rata-rata per bulan; lib/riwayat-beli);
 *   salesman mengisi stok di toko per baris. 10 barang teratas WAJIB diisi (0 boleh), sisanya di "Barang lain", tidak wajib.
 *   Salesman input di AccAPI: tiap baris memberi saran order = kebutuhan sebulan − stok (order-kunjungan saranOrder) + tombol Tambah ke order
 *   (barang dibaca ulang dari barang cabang pelanggan: satuan/harga terkini, pola RiwayatBeli).
 * Caller: ./OrderKunjungan.tsx.
 * Dependensi: lib/riwayat-beli (kunciBaris, satuanTambah, Riwayat), lib/form-kontrol/order-kunjungan (saranOrder), components/order/order-cabang(-api)
 *   (bacaBarangKode, kalimatGalat, kunciHarga), components/fiori/*, lib/rekapan-nota/ui.
 * Main Functions: StokToko, barisStokWajib, isianStok.
 * Side Effects: HTTP GET barang (Tambah) saja; stok disimpan pemanggil lewat POST /api/form-kontrol/order-kunjungan.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import type { Load } from "@/components/fiori/interactive";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { kunciBaris, satuanTambah, type BarangRiwayatOrder, type Riwayat } from "@/lib/riwayat-beli";
import { saranOrder } from "@/lib/form-kontrol/order-kunjungan";
import { kalimatGalat, kunciHarga, type BarangPilih, type PelangganPilih } from "@/components/order/order-cabang";
import { bacaBarangKode } from "@/components/order/order-cabang-api";

/** Barang teratas (rata-rata terbesar) yang stoknya wajib diisi. */
export const STOK_WAJIB = 10;
const angka = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
/** "1,5" / "1.5" / "2" -> angka ≥ 0 maks. 2 desimal; selain itu null. */
export const bacaStok = (v: string | undefined): number | null => {
    const t = (v ?? "").trim().replace(",", ".");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
    return Number(t);
};
export const barisStokWajib = (r: Riwayat | null | undefined) => (r ? r.items.slice(0, STOK_WAJIB) : []);
/** Isian POST stok: baris yang terisi sah (wajib maupun lain). */
export function isianStok(r: Riwayat | null | undefined, stok: Record<string, string>) {
    return (r?.items ?? []).flatMap((x) => {
        const n = bacaStok(stok[kunciBaris(x.code, x.unit)]);
        return n === null ? [] : [{ kodeBarang: x.code, namaBarang: x.name || x.code, satuan: x.unit, stok: n, rataBulan: x.rataPerBulan }];
    });
}

type Order = {
    pelanggan: PelangganPilih; tanggal: string; baris: readonly { code: string; unit: string }[];
    tambah: (b: BarangPilih, unit: string, quantity: string) => void;
    /** Alasan Tambah dikunci (mis. item super belum dijawab). */
    kunci?: string;
};
type Aksi = { jenis: "memuat" } | { jenis: "galat"; pesan: string };

export function StokToko({ riwayat, muatUlang, stok, ubahStok, terkunci, order, alasanTanpa }: {
    riwayat: Load<Riwayat>; muatUlang: () => void; stok: Record<string, string>; ubahStok: (kunci: string, nilai: string) => void;
    terkunci: boolean; order?: Order;
    /** Riwayat tidak bisa dibaca sama sekali (toko belum terdaftar sebagai pelanggan cabang Anda): kalimat sebabnya. */
    alasanTanpa?: string;
}) {
    const [semua, setSemua] = useState(false);
    const [aksi, setAksi] = useState<Record<string, Aksi>>({});
    const lepas = useRef<AbortController | null>(null);
    useEffect(() => { const c = new AbortController(); lepas.current = c; return () => c.abort(); }, []);
    const diOrder = new Set((order?.baris ?? []).filter((l) => l.code.trim()).map((l) => kunciBaris(l.code, l.unit)));

    async function tambah(x: BarangRiwayatOrder, n: number) {
        const sinyal = lepas.current?.signal;
        if (!sinyal || !order) return;
        const k = kunciBaris(x.code, x.unit);
        const set = (a: Aksi | null) => setAksi((prev) => { const s = { ...prev }; if (a) s[k] = a; else delete s[k]; return s; });
        set({ jenis: "memuat" });
        const h = await bacaBarangKode(x.code, order.pelanggan, order.tanggal, sinyal, "sales");
        if (!h.ok) { set("batal" in h ? null : { jenis: "galat", pesan: kalimatGalat(h.galat) }); return; }
        if (!h.data) { set({ jenis: "galat", pesan: `${x.code} tidak ada lagi di barang cabang ${order.pelanggan.branchName}. Cari barang lain di bagian Order.` }); return; }
        const s = satuanTambah(h.data, x.unit, "sales", kunciHarga(order.pelanggan.id, order.tanggal));
        if ("alasan" in s) { set({ jenis: "galat", pesan: s.alasan }); return; }
        set(null);
        order.tambah(h.data, s.unit, String(Math.max(1, n)));
    }

    const r = riwayat.data;
    const wajib = barisStokWajib(r);
    const lain = r ? r.items.slice(STOK_WAJIB) : [];
    const nIsi = wajib.filter((x) => bacaStok(stok[kunciBaris(x.code, x.unit)]) !== null).length;
    const sejak = r ? tanggalPendek(r.jendela.dari) : "";

    const baris = (x: BarangRiwayatOrder, wajibIsi: boolean) => {
        const k = kunciBaris(x.code, x.unit);
        const isi = stok[k] ?? "";
        const n = bacaStok(isi);
        const salah = isi.trim() !== "" && n === null;
        const saran = saranOrder(x.rataPerBulan, n);
        const a = aksi[k];
        const id = `stok-${k.replace(/[^A-Za-z0-9]/g, "-")}`;
        return (
            <li key={k} className="grid gap-2" style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
                <div className="min-w-0">
                    <b className="fi-small" style={{ overflowWrap: "anywhere" }}>{x.name || x.code}</b>
                    <span className="fi-codes">{x.code} · terakhir {tanggalPendek(x.terakhirBeli)} · {x.jumlahFaktur} faktur</span>
                </div>
                <div className="grid items-end gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 8.5rem" }}>
                    <div className="grid gap-0.5">
                        <span className="fi-caption fi-muted">Rata-rata ambil</span>
                        <span className="fi-tnum"><b>{angka(x.rataPerBulan)}</b> {x.unit}<span className="fi-small fi-muted"> / bulan</span></span>
                    </div>
                    <div className="grid gap-0.5">
                        <label htmlFor={id} className="fi-caption fi-muted">Stok di toko{wajibIsi ? " *" : ""}</label>
                        <div className="flex items-center gap-1.5">
                            <input id={id} className="fi-input fi-tnum" inputMode="decimal" autoComplete="off" value={isi} disabled={terkunci} placeholder="0"
                                aria-invalid={salah || undefined} aria-describedby={salah ? `${id}-galat` : undefined}
                                aria-label={`Stok di toko ${x.name || x.code} (${x.unit})${wajibIsi ? ", wajib" : ""}`}
                                onChange={(e) => ubahStok(k, e.target.value)} style={{ minWidth: 0 }} />
                            <span className="fi-small fi-muted">{x.unit}</span>
                        </div>
                    </div>
                </div>
                {salah && <p id={`${id}-galat`} className="fi-small fi-msg" role="alert" style={{ margin: 0 }}>Isi angka 0 atau lebih (desimal pakai koma, maks. 2 angka).</p>}
                {order && n !== null && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="fi-small fi-tnum">{saran > 0 ? <>Saran order <b>{saran} {x.unit}</b></> : <span className="fi-muted">Stok cukup untuk sebulan</span>}</span>
                        {!x.bisaDiorder ? <StatusBadge tone="warn">Tidak bisa diorder</StatusBadge>
                            : diOrder.has(k) ? <StatusBadge tone="neu">Sudah di order</StatusBadge>
                                : <Button variant="secondary" icon={<Plus className="fi-icon" aria-hidden />} busy={a?.jenis === "memuat"}
                                    disabled={Boolean(order.kunci)} disabledReason={order.kunci}
                                    aria-label={`Tambah ${Math.max(1, saran)} ${x.unit} ${x.name || x.code} ke order`} onClick={() => void tambah(x, saran)}>
                                    Tambah {Math.max(1, saran)} {x.unit}
                                </Button>}
                    </div>
                )}
                {!x.bisaDiorder && x.alasan && order && <span className="fi-small fi-muted" style={{ overflowWrap: "anywhere" }}>{x.alasan}</span>}
                {a?.jenis === "galat" && <p className="fi-small fi-msg" role="alert" style={{ margin: 0 }}>{a.pesan}</p>}
            </li>
        );
    };

    return (
        <section className="fi-panel grid gap-2" aria-labelledby="judul-stok-toko">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="fi-title-3" id="judul-stok-toko">Stok toko sekarang</h2>
                {wajib.length > 0 && <StatusBadge tone={nIsi === wajib.length ? "pos" : "neu"}>{nIsi} dari {wajib.length} diisi</StatusBadge>}
            </div>
            <p className="fi-small fi-muted">
                Hitung stok di toko untuk barang yang biasa diambil toko ini{r ? ` (faktur sejak ${sejak})` : ""}. {wajib.length > 0 ? `${wajib.length} barang teratas wajib diisi; isi 0 bila kosong.` : ""}
            </p>
            {alasanTanpa ? (
                <MessageStrip tone="warn" title="Riwayat pengambilan toko ini tidak bisa dibaca.">{alasanTanpa} Stok tidak wajib diisi untuk kunjungan ini.</MessageStrip>
            ) : riwayat.status === "memuat" && !r ? <Skeleton rows={3} label="Memuat riwayat pengambilan toko" />
                : riwayat.status === "galat" && !r ? (
                    <MessageStrip tone="warn" title="Riwayat pengambilan toko belum terbaca.">
                        {riwayat.error} Ini bukan berarti toko belum pernah mengambil barang. Stok tidak wajib selama riwayat belum terbaca.{" "}
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                    </MessageStrip>
                ) : r && r.items.length === 0 ? (
                    <p className="fi-small" style={{ margin: 0 }}>
                        {r.ringkasan.jumlahFaktur === 0 ? `Toko ini belum punya faktur sejak ${sejak}, jadi tidak ada stok yang perlu dihitung.`
                            : `Ada ${r.ringkasan.jumlahFaktur} faktur sejak ${sejak}, tetapi rincian barangnya belum tersedia di data kami; stok tidak wajib.`}
                    </p>
                ) : (
                    <>
                        <ul aria-label="Stok toko, barang yang wajib diisi" style={{ listStyle: "none", margin: 0, padding: 0 }}>{wajib.map((x) => baris(x, true))}</ul>
                        {lain.length > 0 && (
                            <div>
                                <Button variant="tertiary" aria-expanded={semua} onClick={() => setSemua((v) => !v)}>
                                    {semua ? "Sembunyikan barang lain" : `Barang lain (${lain.length}) · tidak wajib`}
                                </Button>
                                {semua && <ul aria-label="Stok toko, barang lain" style={{ listStyle: "none", margin: 0, padding: 0 }}>{lain.map((x) => baris(x, false))}</ul>}
                            </div>
                        )}
                        {r && r.ringkasan.tanpaRincian > 0 && (
                            <p className="fi-small fi-why" style={{ margin: 0 }}>{r.ringkasan.tanpaRincian} dari {r.ringkasan.jumlahFaktur} faktur belum punya rincian barang, jadi rata-rata bisa lebih kecil dari kenyataan.</p>
                        )}
                    </>
                )}
        </section>
    );
}
