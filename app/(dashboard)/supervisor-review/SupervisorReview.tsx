/*
 * Tujuan: Layar Supervisor Review (SR-2): ringkasan harian per salesman untuk satu tanggal WITA. Desktop = tabel per cabang (kolom salesman
 *   tetap saat digulir menyamping) + baris TOTAL cabang, lalu Peta (kiri) dan rincian kunjungan salesman terpilih (kanan). Ponsel (< 1024 px) =
 *   kartu per salesman; ketuk kartu → rincian dengan tab Kunjungan | Peta. Tombol WhatsApp per salesman (waUrl dari server).
 *   Data tak lengkap TERLIHAT: memuat / galat bisa diulang / kosong berpesan / "N faktur cabang X belum terbaca rinciannya" / "N toko JKS belum punya koordinat".
 * Caller: app/(dashboard)/supervisor-review/page.tsx.
 * Dependensi: GET /api/supervisor-review (kontrak lib/supervisor-review/kontrak.ts), ./bersama, ./Rincian, ./Peta (SR-3, dimuat dinamis), components/fiori.
 * Main Functions: SupervisorReview (default).
 * Side Effects: fetch GET; tidak menulis apa pun.
 */
"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, Section, Skeleton } from "@/components/fiori/core";
import { FormField, useLoad } from "@/components/fiori/interactive";
import type { BarisSalesman } from "@/lib/supervisor-review/kontrak";
import { jamWita } from "../form-kontrol/shared";
import { angka, bacaSupervisorReview, KOLOM, kunciBaris, namaBaris, rp, tanggalPanjang } from "./bersama";
import { DaftarKunjungan, KepalaSalesman, LabelStatus, Wa } from "./Rincian";

const Peta = dynamic(() => import("./Peta"), { ssr: false, loading: () => <Skeleton rows={3} label="Memuat peta" /> });

const DESKTOP = "(min-width: 1024px)";
const langgan = (cb: () => void) => { const m = window.matchMedia(DESKTOP); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
/** Satu tata letak sekaligus (bukan DOM ganda): Peta (Leaflet) tidak boleh terpasang dua kali. Server/hidrasi = desktop; data baru ada sesudah dimuat. */
const useDesktop = () => useSyncExternalStore(langgan, () => window.matchMedia(DESKTOP).matches, () => true);

const TOMBOL_NAMA: CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", fontWeight: 600, color: "var(--brand)", cursor: "pointer", textAlign: "left" };
/** Kolom salesman menempel di kiri saat tabel digulir menyamping (`.fi-table th` sudah sticky di atas). */
const TEMPEL: CSSProperties = { position: "sticky", left: 0, zIndex: 2, minWidth: "9rem", boxShadow: "inset -1px 0 0 var(--line)" };
const TEMPEL_TH: CSSProperties = { left: 0, zIndex: 3, minWidth: "9rem", boxShadow: "inset -1px 0 0 var(--line)" };
const MIN_PETA: CSSProperties = { minHeight: 360 };

export default function SupervisorReview({ hariIni }: { hariIni: string }) {
    const [tanggal, setTanggal] = useState(hariIni);
    const [cabang, setCabang] = useState("");
    const [principle, setPrinciple] = useState("");
    const [pilih, setPilih] = useState<string | null>(null);
    const [tab, setTab] = useState<"kunjungan" | "peta">("kunjungan");
    // pertahankan: pilihan saringan + tabel lama tetap tampil (redup) selagi saringan/tanggal baru dimuat.
    const [load, muatUlang] = useLoad(useCallback(() => bacaSupervisorReview({ tanggal, cabang, principle }), [tanggal, cabang, principle]), { pertahankan: true });
    const desktop = useDesktop();
    const h = load.data;

    const gantiTanggal = (t: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(t) && t <= hariIni) { setTanggal(t); setPilih(null); } };
    const pilihSalesman = (b: BarisSalesman | null) => { setPilih(b ? kunciBaris(b) : null); setTab("kunjungan"); };

    const kepala = (
        <header className="fi-page-head">
            <div className="fi-page-bar">
                <h1>Supervisor Review</h1>
                <span className="fi-spacer" />
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat"} onClick={muatUlang}>Muat ulang</Button>
            </div>
            <p>Ringkasan harian per salesman dalam cakupan Anda: kunjungan Form Kontrol digabung dengan faktur Accurate. Nilai Order = DPP sebelum PPN.</p>
            <div className="flex flex-wrap items-end gap-3">
                <FormField label="Tanggal">
                    {(a) => <input {...a} className="fi-input" type="date" max={hariIni} value={tanggal} onChange={(e) => gantiTanggal(e.target.value)} />}
                </FormField>
                <FormField label="Cabang">
                    {(a) => (
                        <select {...a} className="fi-input" value={cabang} onChange={(e) => { setCabang(e.target.value); setPilih(null); }}>
                            <option value="">Semua cabang</option>
                            {h?.pilihanCabang.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    )}
                </FormField>
                <FormField label="Principal">
                    {(a) => (
                        <select {...a} className="fi-input" value={principle} onChange={(e) => { setPrinciple(e.target.value); setPilih(null); }}>
                            <option value="">Semua principal</option>
                            {h?.pilihanPrinciple.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    )}
                </FormField>
                {h && <span className="fi-small fi-muted" aria-live="polite">{tanggalPanjang(h.tanggal)} · data per {jamWita(h.diperbaruiPada)} WITA</span>}
            </div>
        </header>
    );

    if (!h) {
        return (
            <div className="fi-page">
                {kepala}
                {load.status === "galat" ? <ErrorState title="Supervisor Review belum bisa ditampilkan" message={load.error} onRetry={muatUlang} />
                    : <Skeleton rows={8} label="Memuat Supervisor Review" />}
            </div>
        );
    }

    const belumTerbaca = h.fakturBelumTerbaca.filter((f) => f.jumlah > 0);
    const catatan = (
        <>
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {(load.error ?? "").replace("Supervisor Review belum berhasil dimuat.", "").trim()} Yang tampil adalah hasil sebelumnya.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                </MessageStrip>
            )}
            {h.pesan && h.salesman.length > 0 && <MessageStrip tone="warn">{h.pesan.teks}</MessageStrip>}
            {belumTerbaca.length > 0 && (
                <MessageStrip tone="warn" title="Faktur belum lengkap.">
                    <ul className="list-disc pl-5">
                        {belumTerbaca.map((f) => <li key={f.cabang}>{angka(f.jumlah)} faktur cabang {f.cabang} belum terbaca rinciannya; angka Quantity, Item, dan Nilai cabang ini belum lengkap.</li>)}
                    </ul>
                </MessageStrip>
            )}
            {h.tokoTanpaKoordinat > 0 && (
                <MessageStrip tone="info">{angka(h.tokoTanpaKoordinat)} toko JKS belum punya koordinat; toko itu hanya tampil di tabel dan rincian, tidak di peta.</MessageStrip>
            )}
        </>
    );

    const grup = new Map<string, BarisSalesman[]>();
    for (const b of h.salesman) grup.set(b.cabang, [...(grup.get(b.cabang) ?? []), b]);
    const total = new Map(h.totalCabang.map((t) => [t.cabang, t]));
    const terpilih = h.salesman.find((b) => kunciBaris(b) === pilih) ?? null;
    // ponytail: baris "Tanpa salesman terpetakan" (salesCode "") ada satu per cabang, tetapi Kunjungan tak membawa cabang → keduanya menampilkan kunjungan salesCode "" yang sama.
    const kunjunganDari = (b: BarisSalesman) => h.kunjungan.filter((k) => k.salesCode === b.salesCode);
    const petaUntuk = (b: BarisSalesman | null) => <div style={MIN_PETA}><Peta penanda={h.penanda} kunjungan={h.kunjungan} salesCodeTerpilih={b ? b.salesCode : null} /></div>;

    let isi;
    if (h.salesman.length === 0) {
        isi = <EmptyState title={h.pesan ? "Belum ada data untuk ditampilkan" : "Tidak ada salesman untuk ditampilkan"}
            message={h.pesan?.teks ?? "Tidak ada salesman dalam cakupan dan saringan ini pada tanggal tersebut."} />;
    } else if (desktop) {
        isi = (
            <>
                <Section title="Ringkasan per salesman" subtitle={`${angka(h.salesman.length)} salesman · ${angka(grup.size)} cabang`}>
                    <div className="fi-tablescroll">
                        <table className="fi-table">
                            <caption className="sr-only">Ringkasan per salesman, per cabang</caption>
                            <thead>
                                <tr>
                                    <th scope="col" style={TEMPEL_TH}>Salesman</th>
                                    <th scope="col">Status</th>
                                    {KOLOM.map((c) => <th key={c.key} scope="col" className="fi-end">{c.header}</th>)}
                                    <th scope="col">WhatsApp</th>
                                </tr>
                            </thead>
                            {[...grup].map(([nmCabang, rows]) => {
                                const t = total.get(nmCabang);
                                return (
                                    <tbody key={nmCabang}>
                                        <tr><th scope="rowgroup" style={TEMPEL_TH}>{nmCabang}</th><th colSpan={KOLOM.length + 2} /></tr>
                                        {rows.map((b) => {
                                            const sel = kunciBaris(b) === pilih;
                                            return (
                                                <tr key={kunciBaris(b)} data-selected={sel || undefined}>
                                                    <td style={{ ...TEMPEL, background: sel ? "var(--brand-tint)" : "var(--surface)" }}>
                                                        <button type="button" style={TOMBOL_NAMA} aria-pressed={sel} onClick={() => pilihSalesman(sel ? null : b)}>{namaBaris(b)}</button>
                                                        {b.salesCode !== "" && <span className="fi-codes">{b.salesCode}</span>}
                                                    </td>
                                                    <td><LabelStatus status={b.status} /></td>
                                                    {KOLOM.map((c) => <td key={c.key} className="fi-end">{c.teks(b)}</td>)}
                                                    <td><Wa b={b} /></td>
                                                </tr>
                                            );
                                        })}
                                        {t && (
                                            <tr style={{ background: "var(--brand-tint)", fontWeight: 700 }}>
                                                <th scope="row" style={{ ...TEMPEL_TH, background: "var(--brand-tint)", color: "inherit" }}>TOTAL {nmCabang}</th>
                                                <td />
                                                {KOLOM.map((c) => <td key={c.key} className="fi-end">{c.teks(t)}</td>)}
                                                <td />
                                            </tr>
                                        )}
                                    </tbody>
                                );
                            })}
                        </table>
                    </div>
                </Section>
                <div className="grid grid-cols-2 gap-3">
                    <Section title="Peta kunjungan" subtitle={terpilih ? namaBaris(terpilih) : "semua salesman dalam cakupan"}
                        actions={terpilih && <Button variant="tertiary" onClick={() => pilihSalesman(null)}>Lihat semua salesman</Button>}>
                        {petaUntuk(terpilih)}
                    </Section>
                    <Section title="Rincian kunjungan">
                        {terpilih
                            ? <><KepalaSalesman b={terpilih} /><DaftarKunjungan rows={kunjunganDari(terpilih)} kartu={false} /></>
                            : <EmptyState title="Pilih salesman" message="Klik nama salesman di tabel untuk melihat rincian kunjungannya." />}
                    </Section>
                </div>
            </>
        );
    } else if (terpilih) {
        isi = (
            <div className="grid gap-3">
                <div><Button variant="tertiary" icon={<ChevronLeft className="fi-icon" aria-hidden />} onClick={() => pilihSalesman(null)}>Kembali ke daftar</Button></div>
                <section className="fi-sect" aria-label={`Rincian ${namaBaris(terpilih)}`}>
                    <KepalaSalesman b={terpilih} />
                    <div className="px-4 py-3"><dl className="fi-attrs">{KOLOM.map((c) => <div key={c.key}><dt>{c.header}</dt><dd>{c.teks(terpilih)}</dd></div>)}</dl></div>
                    <div role="tablist" aria-label="Rincian salesman" className="flex gap-2 px-4 pb-3">
                        {(["kunjungan", "peta"] as const).map((t) => (
                            <Button key={t} role="tab" aria-selected={tab === t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>{t === "kunjungan" ? "Kunjungan" : "Peta"}</Button>
                        ))}
                    </div>
                    <div role="tabpanel" aria-label={tab === "kunjungan" ? "Kunjungan" : "Peta"}>
                        {tab === "kunjungan" ? <DaftarKunjungan rows={kunjunganDari(terpilih)} kartu /> : petaUntuk(terpilih)}
                    </div>
                </section>
            </div>
        );
    } else {
        isi = (
            <div className="grid gap-3">
                {[...grup].map(([nmCabang, rows]) => {
                    const t = total.get(nmCabang);
                    return (
                        <Section key={nmCabang} title={nmCabang} subtitle={t ? `Total: EC ${angka(t.ec)} / Call Plan ${angka(t.callPlan)} · ${rp(t.nilaiOrder)}` : undefined}>
                            <ul aria-label={`Salesman ${nmCabang}`} style={{ listStyle: "none", margin: 0, padding: 0 }}>
                                {rows.map((b) => (
                                    <li key={kunciBaris(b)}>
                                        <ListItem onClick={() => pilihSalesman(b)} doc={namaBaris(b)} amount={rp(b.nilaiOrder)}
                                            title={`EC / Call Plan: ${angka(b.ec)} / ${angka(b.callPlan)}`} meta={<LabelStatus status={b.status} />} />
                                        {b.salesCode !== "" && <div className="flex flex-wrap items-center gap-2 px-4 pb-3"><Wa b={b} petunjuk /></div>}
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    );
                })}
            </div>
        );
    }

    return (
        <div className="fi-page">
            {kepala}
            {catatan}
            <div className={load.status === "memuat" ? "fi-busy grid gap-3" : "grid gap-3"} aria-busy={load.status === "memuat" || undefined}>{isi}</div>
        </div>
    );
}
