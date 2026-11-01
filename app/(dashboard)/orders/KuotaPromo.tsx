/*
 * Tujuan: Kuota Promo (owner 1 Nov 2026): budget diskon sell-in per SKU = qty DIBELI berdiskon surat - qty yang SUDAH KELUAR ke
 *   outlet berdiskon sama; tiap order beku memotongnya, dan diskon/bonus berhenti saat habis (semua menu order lewat satu hitungan).
 * Caller: ./kuota/page.tsx (/orders/kuota). Dependensi: FastAPI GET /orders/kuota, POST /orders/kuota/hitung (multipart), POST
 *   /orders/kuota; ./order-ui; components/fiori/{core,interactive}; lib/tampil.
 * Main Functions: KuotaPromo.
 * Side Effects: HTTP; Simpan mengganti budget satu surat. Tidak ada tulis ke Accurate.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Button, MessageStrip, Skeleton } from "@/components/fiori/core";
import { FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { fastapi, fastapiForm, pesanJawaban, sukses } from "./order-ui";

type Surat = { surat_program: string; mulai: string; selesai: string; programs: { id: string; name: string; codes: string[] }[] };
type Kuota = { surat_program: string; code: string; quantity: string; unit: string; isi: string; sumber: string; updated_by: string; updated_at: string; sisa: string | null };
type Data = { surat: Surat[]; kuota: Kuota[] };
type Hitung = {
    surat_program: string; sebelum: string;
    baris: { kode: string; nama: string; satuan: string; isi: number | null; beli: string; keluar: string; budget: string;
        pola_beli: Record<string, string>; pola_keluar: Record<string, string>; tak_terhitung: string[] }[];
};

const angka = (v: string | number) => Number(v).toLocaleString("id-ID", { maximumFractionDigits: 2 });
/** "1.440 PCS (20 KRT)" bila isi karton diketahui. */
const qty = (v: string, unit: string, isi: string | number | null) =>
    `${angka(v)} ${unit}${Number(isi) > 0 ? ` (${angka(Number(v) / Number(isi))} KRT)` : ""}`;
const pola = (p: Record<string, string>) => Object.entries(p).map(([d, q]) => `${d}%: ${angka(q)}`).join("; ") || KOSONG;

export default function KuotaPromo({ permKeys }: { permKeys: string[] }) {
    const bolehAtur = useMemo(() => new Set(permKeys).has("summary.edit"), [permKeys]);
    const [data, muat] = useLoad(useCallback(async (): Promise<Load<Data>> => {
        const j = await fastapi("GET", "/orders/kuota");
        if (sukses(j)) return { status: "siap", data: j.data as unknown as Data };
        return { status: "galat", error: pesanJawaban(j, "Kuota promo gagal dimuat.") };
    }, []), { pertahankan: true });
    const [surat, setSurat] = useState("");
    const [beli, setBeli] = useState<File | null>(null);
    const [jual, setJual] = useState<File | null>(null);
    const [hitung, setHitung] = useState<Hitung | null>(null);
    const [kerja, setKerja] = useState<"" | "hitung" | "simpan">("");
    const [pesan, setPesan] = useState<{ tone: "pos" | "neg"; teks: string } | null>(null);

    const daftar = data.data;
    const pilihan = surat || daftar?.surat[0]?.surat_program || "";

    async function hitungBudget() {
        if (!beli || !jual) return;
        setKerja("hitung"); setPesan(null); setHitung(null);
        const form = new FormData();
        form.append("surat_program", pilihan); form.append("beli", beli); form.append("jual", jual);
        const j = await fastapiForm("/orders/kuota/hitung", form);
        setKerja("");
        if (sukses(j)) setHitung(j.data as unknown as Hitung);
        else setPesan({ tone: "neg", teks: pesanJawaban(j, "Budget gagal dihitung.") });
    }

    async function simpan() {
        if (!hitung) return;
        setKerja("simpan"); setPesan(null);
        // Kode tanpa satu pun pembelian berdiskon surat tidak punya satuan: tidak disimpan = belum diisi = tanpa diskon.
        const rows = hitung.baris.filter((b) => b.satuan).map((b) => ({ code: b.kode, quantity: b.budget, unit: b.satuan, isi: b.isi ?? "" }));
        const j = await fastapi("POST", "/orders/kuota", { surat_program: hitung.surat_program, rows, sumber: `${beli?.name ?? ""} - ${jual?.name ?? ""}` });
        setKerja("");
        if (sukses(j)) { setHitung(null); setPesan({ tone: "pos", teks: `Budget ${hitung.surat_program} tersimpan (${rows.length} SKU).` }); muat(); }
        else setPesan({ tone: "neg", teks: pesanJawaban(j, "Budget gagal disimpan.") });
    }

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Penjualan</span></li><li><Link href="/orders">Order Masuk</Link></li><li><span aria-current="page">Kuota Promo</span></li></ol></nav>
                <div className="fi-page-bar"><h1>Kuota Promo</h1></div>
                <p>Diskon sell-in yang sudah diterima saat membeli dari principal hanya boleh keluar sebanyak barang yang dibeli dengan diskon itu.
                    Tiap order (Order Baru, Order Sales, tarikan) memotong sisa; baris yang melebihi sisa tidak mendapat diskon, bonus yang melebihi sisa tidak diberikan.
                    Program berkuota = baris Summary yang keterangannya memuat &quot;kuota beli&quot;.</p>
            </header>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}

            {data.status === "galat" && !daftar ? (
                <MessageStrip tone="neg" title="Kuota promo tidak terbaca.">{data.error} <button type="button" className="fi-btn fi-btn--tertiary" onClick={muat}>Coba lagi</button></MessageStrip>
            ) : !daftar ? <Skeleton rows={4} label="Memuat kuota promo" /> : daftar.surat.length === 0 ? (
                <MessageStrip tone="warn" title="Belum ada program berkuota yang terbit.">Terbitkan Summary dengan keterangan &quot;kuota beli&quot; pada baris programnya.</MessageStrip>
            ) : daftar.surat.map((s) => {
                const baris = daftar.kuota.filter((k) => k.surat_program === s.surat_program);
                const tanpa = [...new Set(s.programs.flatMap((p) => p.codes))].filter((c) => !baris.some((k) => k.code === c));
                return (
                    <section key={s.surat_program} className="fi-panel" aria-label={`Kuota ${s.surat_program}`}>
                        <h2>{s.surat_program} <span className="fi-small fi-muted">{s.mulai} s.d. {s.selesai} · {s.programs.map((p) => p.name).join(", ")}</span></h2>
                        <div className="fi-tablescroll" tabIndex={0} role="group" aria-label={`Kuota ${s.surat_program}`}>
                            <table className="fi-table"><caption className="sr-only">Kuota per SKU</caption>
                                <thead><tr><th>Kode</th><th className="text-right">Budget</th><th className="text-right">Terpakai</th><th className="text-right">Sisa</th><th>Sumber</th></tr></thead>
                                <tbody>
                                    {baris.map((k) => (
                                        <tr key={k.code}>
                                            <td className="fi-mono">{k.code}</td>
                                            <td className="text-right fi-tnum">{qty(k.quantity, k.unit, k.isi)}</td>
                                            <td className="text-right fi-tnum">{k.sisa === null ? KOSONG : qty(String(Number(k.quantity) - Number(k.sisa)), k.unit, k.isi)}</td>
                                            <td className="text-right fi-tnum">{k.sisa === null ? KOSONG : qty(k.sisa, k.unit, k.isi)}</td>
                                            <td className="fi-small">{k.sumber || KOSONG}<br />{k.updated_by} · {waktuWita(k.updated_at)} WITA</td>
                                        </tr>
                                    ))}
                                    {baris.length === 0 && <tr><td colSpan={5}>Budget belum diisi: semua SKU surat ini belum mendapat diskon.</td></tr>}
                                </tbody>
                            </table>
                        </div>
                        {baris.length > 0 && tanpa.length > 0 && <p className="fi-small fi-why">Tanpa budget (tidak mendapat diskon): {tanpa.join(", ")}.</p>}
                    </section>
                );
            })}

            {daftar && daftar.surat.length > 0 && (
                <section className="fi-panel" aria-label="Hitung budget">
                    <h2>Hitung budget dari Accurate</h2>
                    {!bolehAtur ? <p className="fi-small fi-why">Mengatur budget butuh izin ubah Summary.</p> : (
                        <>
                            <p className="fi-small fi-muted">Unggah Rincian Faktur Pembelian dan Rincian Faktur Penjualan (cabang principal, dengan kolom Diskon %).
                                Budget = qty beli yang diskonnya sesuai surat - qty jual berdiskon sama sebelum program mulai.</p>
                            <div className="flex flex-wrap items-end gap-3">
                                <FormField label="Surat program" required>{(a) => (
                                    <select {...a} className="fi-input" value={pilihan} onChange={(e) => { setSurat(e.target.value); setHitung(null); }}>
                                        {daftar.surat.map((s) => <option key={s.surat_program} value={s.surat_program}>{s.surat_program}</option>)}
                                    </select>)}</FormField>
                                <FormField label="Rincian Faktur Pembelian (.xlsx)" required>{(a) => (
                                    <input {...a} type="file" accept=".xlsx" onChange={(e) => { setBeli(e.target.files?.[0] ?? null); setHitung(null); }} />)}</FormField>
                                <FormField label="Rincian Faktur Penjualan (.xlsx)" required>{(a) => (
                                    <input {...a} type="file" accept=".xlsx" onChange={(e) => { setJual(e.target.files?.[0] ?? null); setHitung(null); }} />)}</FormField>
                                <Button variant="primary" busy={kerja === "hitung"} disabled={!beli || !jual || Boolean(kerja)}
                                    disabledReason={!beli || !jual ? "Pilih kedua berkas ekspor Accurate" : undefined} onClick={hitungBudget}>Hitung</Button>
                            </div>
                        </>
                    )}
                    {hitung && (
                        <>
                            <div className="fi-tablescroll" tabIndex={0} role="group" aria-label="Pratinjau budget">
                                <table className="fi-table"><caption className="sr-only">Pratinjau budget {hitung.surat_program}</caption>
                                    <thead><tr><th>Barang</th><th className="text-right">Dibeli berdiskon surat</th><th className="text-right">Sudah keluar (sebelum {hitung.sebelum})</th><th className="text-right">Budget</th></tr></thead>
                                    <tbody>
                                        {hitung.baris.map((b) => (
                                            <tr key={b.kode}>
                                                <td><span className="fi-mono">{b.kode}</span><span className="fi-sub">{b.nama || "tidak ada pembelian berdiskon surat"}</span>
                                                    {b.tak_terhitung.length > 0 && <span className="fi-sub fi-why">Tidak terhitung (satuan): {b.tak_terhitung.join("; ")}</span>}</td>
                                                <td className="text-right fi-tnum">{b.satuan ? qty(b.beli, b.satuan, b.isi) : KOSONG}<span className="fi-sub">{pola(b.pola_beli)}</span></td>
                                                <td className="text-right fi-tnum">{b.satuan ? qty(b.keluar, b.satuan, b.isi) : KOSONG}<span className="fi-sub">{pola(b.pola_keluar)}</span></td>
                                                <td className="text-right fi-tnum"><b>{b.satuan ? qty(b.budget, b.satuan, b.isi) : "0"}</b></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <Button variant="primary" busy={kerja === "simpan"} disabled={Boolean(kerja)} onClick={simpan}>Simpan budget {hitung.surat_program}</Button>
                            <p className="fi-small fi-muted">Simpan mengganti budget surat ini; order yang sudah tersimpan tetap memotongnya.</p>
                        </>
                    )}
                </section>
            )}
        </div>
    );
}
