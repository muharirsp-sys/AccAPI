/*
 * Tujuan: Tab "Tidak Order" /laporan-sales (padanan EskaLink "Unproductive Report") — ringkasan "X dari Y kunjungan tidak order (Z%)", tabel Alasan
 *   (Alasan, Kategori, Jumlah, %), tabel Per salesman, pilihan cabang; ponsel = daftar ListItem.
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx (props: bulan).
 * Dependensi: GET /api/laporan-sales/tidak-order, lib/laporan-sales/tidak-order (persen — murni; tipe), Fiori kit, ambilFk (form-kontrol/shared).
 * Main Functions: TidakOrder. Side Effects: HTTP GET saat bulan/cabang berganti.
 * Enam keadaan (diputuskan di tab, bukan per tabel — dua tabel memakai satu muatan): memuat (Skeleton), siap, kosong (EmptyState "Belum ada
 *   kunjungan tercatat"), galat (ErrorState + Coba lagi), galat dengan data lama (strip + isi lama), tanpa izin (403 -> ErrorState; 403
 *   HIERARKI_BELUM_TERTAUT membawa kalimat server).
 */
"use client";

import { useCallback, useState } from "react";
import { EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Skeleton, type Column } from "@/components/fiori/core";
import { FormField, useLoad } from "@/components/fiori/interactive";
import type { BarisAlasan, PropsTab } from "@/lib/laporan-sales/kontrak";
import { persen, type JawabanTidakOrderLengkap } from "@/lib/laporan-sales/tidak-order";
import { ambilFk } from "../../form-kontrol/shared";

const angka = (n: number) => n.toLocaleString("id-ID");
const pct = (n: number | null) => (n === null ? "–" : `${n.toLocaleString("id-ID")}%`);
const kapital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "–");

type Salesman = JawabanTidakOrderLengkap["perSalesman"][number];

export default function TidakOrder({ bulan }: PropsTab) {
    const [cabang, setCabang] = useState("");
    const [load, muatUlang] = useLoad(useCallback(() => ambilFk(
        `/api/laporan-sales/tidak-order?bulan=${bulan}${cabang ? `&cabang=${encodeURIComponent(cabang)}` : ""}`,
        (j) => j as unknown as JawabanTidakOrderLengkap, "Laporan Tidak Order gagal dimuat."), [bulan, cabang]), { pertahankan: true });
    const d = load.data;

    if (!d) return load.status === "galat" ? <ErrorState message={load.error} onRetry={muatUlang} /> : <Skeleton />;

    const pilihan = [...new Set([...d.pilihanCabang, ...(cabang ? [cabang] : [])])]; // cabang terpilih tetap ada di daftar walau bulan lain tak memilikinya
    const pilih = pilihan.length > 0 && (
        <div style={{ maxWidth: 260 }}><FormField label="Cabang">{(a) => (
            <select {...a} className="fi-input" value={cabang} onChange={(e) => setCabang(e.target.value)}>
                <option value="">Semua cabang</option>
                {pilihan.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
        )}</FormField></div>
    );
    const status = load.status === "memuat" ? "memuat" : "siap"; // galat sudah ditangani strip di atas, bukan per tabel

    const kolomAlasan: Column<BarisAlasan>[] = [
        { key: "label", header: "Alasan", cell: (r) => r.label },
        { key: "kategori", header: "Kategori", cell: (r) => kapital(r.kategori) },
        { key: "jumlah", header: "Jumlah", align: "end", cell: (r) => angka(r.jumlah) },
        { key: "persen", header: "%", align: "end", cell: (r) => pct(persen(r.jumlah, d.tidakOrder)) },
    ];
    const kolomSales: Column<Salesman>[] = [
        { key: "salesNama", header: "Salesman", cell: (r) => r.salesNama },
        { key: "jumlah", header: "Jumlah", align: "end", cell: (r) => angka(r.jumlah) },
    ];
    const kosongTabel = { title: "Tidak ada kunjungan tanpa order", message: "Semua kunjungan yang tercatat bulan ini menghasilkan order." };

    return (
        <div className="space-y-3">
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {load.error} Yang tampil adalah hasil sebelumnya{d.bulan !== bulan ? ` (bulan ${d.bulan})` : ""}.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                </MessageStrip>
            )}
            {pilih}
            {d.kunjungan === 0 ? (
                <EmptyState title="Belum ada kunjungan tercatat bulan ini"
                    message={cabang ? `Tidak ada kunjungan tercatat untuk cabang ${cabang}. Pilih "Semua cabang" untuk melihat seluruhnya.` : "Data terisi saat salesman check-in di Form Kontrol."} />
            ) : (
                <div className={`space-y-3 ${status === "memuat" ? "fi-busy" : ""}`} aria-busy={status === "memuat" || undefined}>
                    <div>
                        <p className="text-lg"><strong>{angka(d.tidakOrder)}</strong> dari <strong>{angka(d.kunjungan)}</strong> kunjungan tidak order (<strong>{pct(persen(d.tidakOrder, d.kunjungan))}</strong>)</p>
                        <p className="text-sm opacity-70">Kunjungan = toko × principal per hari yang sudah punya hasil di Form Kontrol (order atau tidak order); toko yang belum diisi hasilnya tidak dihitung.</p>
                    </div>
                    <ResponsiveTable
                        title="Alasan tidak order" count={d.alasan.length || undefined}
                        columns={kolomAlasan} rows={d.alasan} rowKey={(r) => r.kode || "__tanpa-alasan"} status={status} empty={kosongTabel}
                        mobileItem={(r) => <ListItem doc={r.label} amount={angka(r.jumlah)} title={kapital(r.kategori)} meta={pct(persen(r.jumlah, d.tidakOrder))} />}
                    />
                    <ResponsiveTable
                        title="Tidak order per salesman" count={d.perSalesman.length || undefined}
                        columns={kolomSales} rows={d.perSalesman} rowKey={(r) => r.salesCode} status={status} empty={kosongTabel}
                        mobileItem={(r) => <ListItem doc={r.salesNama} amount={angka(r.jumlah)} meta={`${pct(persen(r.jumlah, d.tidakOrder))} dari tidak order`} />}
                    />
                </div>
            )}
        </div>
    );
}
