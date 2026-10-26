/*
 * Tujuan: Tab "Coverage Ganda" /laporan-sales — toko JKS aktif yang dilayani > 1 salesman untuk principal yang sama (padanan EskaLink Compare/
 *   Double Coverage): ringkasan "N toko dilayani > 1 salesman dari M toko JKS", pilihan principal, tabel Toko | Principal | Salesman (hari + minggu).
 *   Tanpa bulan: JKS = rute berlaku sekarang, jadi prop `bulan` diabaikan. Enam keadaan: memuat, siap, kosong, galat, galat dengan data lama, tanpa izin.
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 * Dependensi: GET /api/laporan-sales/coverage (kontrak lib/laporan-sales/kontrak.ts), ../../form-kontrol/shared (ambilFk), components/fiori.
 * Main Functions: Coverage (default). Side Effects: fetch GET; tidak menulis apa pun.
 */
"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, ErrorState, ListItem, ResponsiveTable } from "@/components/fiori/core";
import { FormField, useLoad, type Load } from "@/components/fiori/interactive";
import type { BarisCoverage, JawabanCoverage, SalesmanCoverage } from "@/lib/laporan-sales/kontrak";
import { ambilFk } from "../../form-kontrol/shared";

const UMUM = "Coverage Ganda belum berhasil dimuat.";
const angka = (n: number) => new Intl.NumberFormat("id-ID").format(n);
// ponytail: penolakan dikenali dari kalimat ambilFk (403 tanpa izin / HIERARKI_BELUM_TERTAUT) — mengulang tidak membantu, jadi tanpa "Coba lagi".
const DITOLAK = /tidak punya izin|belum tertaut ke hierarki/;

/** Jawaban + principal yang diminta: label ringkasan harus ikut DATA-nya, bukan pilihan terbaru (data lama dipertahankan selagi memuat/galat). */
type Hasil = JawabanCoverage & { principle: string };

async function baca(principle: string): Promise<Load<Hasil>> {
    const l = await ambilFk(`/api/laporan-sales/coverage${principle ? `?principle=${encodeURIComponent(principle)}` : ""}`, (j) => ({ ...(j as unknown as JawabanCoverage), principle }), UMUM);
    return l.status === "siap" && !Array.isArray(l.data?.baris) ? { status: "galat", error: `${UMUM} Jawaban server tidak dikenali.` } : l;
}

const labelMinggu = (m: string) => m.split(", ").filter(Boolean).map((x) => (x === "all" ? "setiap minggu" : x === "ganjil" ? "minggu ganjil" : x === "genap" ? "minggu genap" : `minggu ${x}`)).join(", ");
/** "Nama (KODE) · Senin · minggu 1,3" — kode hanya bila beda dari nama. */
const teksSalesman = (s: SalesmanCoverage) =>
    [s.salesNama === s.salesCode ? s.salesNama : `${s.salesNama} (${s.salesCode})`, s.hari || "hari belum diisi", labelMinggu(s.minggu)].filter(Boolean).join(" · ");

export default function Coverage() {
    const [principle, setPrinciple] = useState("");
    // pertahankan: tabel lama tetap tampil (redup) selagi principal baru dimuat; galat muat ulang = data lama + strip "hasil sebelumnya".
    const [load, muatUlang] = useLoad(useCallback(() => baca(principle), [principle]), { pertahankan: true });
    const h = load.data;
    const ditolak = !h && load.status === "galat" && DITOLAK.test(load.error ?? "");
    const toko = new Set((h?.baris ?? []).map((b) => b.custCode)).size;

    return (
        <div className="space-y-4">
            <p className="fi-small fi-muted">Toko JKS aktif yang dilayani lebih dari satu salesman untuk principal yang sama. Rute JKS berlaku sekarang, jadi pilihan bulan tidak berpengaruh di tab ini.</p>
            <div className="flex flex-wrap items-end gap-3">
                <FormField label="Principal">
                    {(a) => (
                        <select {...a} className="fi-input" value={principle} onChange={(e) => setPrinciple(e.target.value)}>
                            <option value="">Semua principal</option>
                            {h?.pilihanPrincipal.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    )}
                </FormField>
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat"} onClick={muatUlang}>Muat ulang</Button>
            </div>
            {h && <p aria-live="polite"><b>{angka(toko)}</b> toko dilayani lebih dari satu salesman dari <b>{angka(h.totalToko)}</b> toko JKS{h.principle ? ` ${h.principle}` : ""}.</p>}
            {/* Penolakan izin = galat (role alert), bukan keadaan kosong (audit No 127); tanpa Coba lagi karena mengulang tidak membantu. */}
            {ditolak ? <ErrorState title="Coverage Ganda tidak bisa dibuka" message={load.error} /> : (
                <ResponsiveTable<BarisCoverage>
                    title="Toko × principal dilayani lebih dari satu salesman" count={h?.baris.length}
                    rows={h?.baris ?? []} rowKey={(b) => `${b.custCode}|${b.principle}`}
                    status={load.status} error={load.error} onRetry={muatUlang}
                    empty={h && h.totalToko === 0
                        ? { title: "Belum ada toko JKS", message: "Tidak ada toko JKS aktif dalam cakupan Anda untuk pilihan ini." }
                        : { title: "Tidak ada toko ganda", message: "Setiap toko JKS dalam cakupan Anda dilayani satu salesman per principal." }}
                    columns={[
                        { key: "toko", header: "Toko", cell: (b) => <><b>{b.custName || b.custCode}</b><br /><span className="fi-small fi-muted">{b.custCode}</span></> },
                        { key: "principle", header: "Principal", cell: (b) => b.principle },
                        { key: "salesman", header: "Salesman", cell: (b) => <ul>{b.salesman.map((s) => <li key={s.salesCode}>{teksSalesman(s)}</li>)}</ul> },
                    ]}
                    mobileItem={(b) => (
                        <ListItem doc={b.custName || b.custCode} meta={`${b.custCode} · ${b.principle}`} amount={`${b.salesman.length} salesman`}
                            title={<>{b.salesman.map((s) => <span key={s.salesCode} className="block">{teksSalesman(s)}</span>)}</>} />
                    )}
                />
            )}
        </div>
    );
}
