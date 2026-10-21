/*
 * Tujuan: Tab "Monitoring Harian" /laporan-sales (padanan EskaLink "Daily Monitoring Sales/Customer"): tabel per (pelanggan, salesman) —
 *   MTD lalu D1…Dn (nilai DPP faktur INV per tanggal; sel 0 = "–"). Gulir menyamping HANYA di dalam tabel (kolom Pelanggan menempel di
 *   kiri). Cari pelanggan/salesman + saringan cabang; paginasi klien 50 baris. Ponsel = daftar (pelanggan, salesman, MTD).
 *   Keadaan: memuat, siap, kosong (belum ada faktur ≠ belum terbaca rinciannya ≠ tidak cocok), galat bisa diulang, galat dengan data lama
 *   (judul menyebut bulan data lama bila bulan terpilih sudah berganti), tanpa izin (403 = galat berpesan).
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 * Dependensi: GET /api/laporan-sales/harian (kontrak lib/laporan-sales/kontrak.ts JawabanHarian), ambilFk (form-kontrol/shared), Fiori kit.
 * Main Functions: Harian (default).
 * Side Effects: fetch GET; tidak menulis apa pun.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Button, ListItem, MessageStrip, ResponsiveTable, type Column } from "@/components/fiori/core";
import { FormField, useLoad } from "@/components/fiori/interactive";
import { rentangBulan, type BarisHarian, type JawabanHarian, type PropsTab } from "@/lib/laporan-sales/kontrak";
import { rupiah } from "@/lib/promo-ui";
import { ambilFk } from "../../form-kontrol/shared";

const PER_HALAMAN = 50;
const NF = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
/** Kolom Pelanggan menempel di kiri saat tabel digulir menyamping (th sudah sticky di atas); lebar dijaga agar nama tak terhimpit. */
const CSS = `.lap-harian .fi-table th:first-child, .lap-harian .fi-table td:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); box-shadow: inset -1px 0 0 var(--line); }
.lap-harian .fi-table th:first-child { z-index: 2; background: var(--surface-2); }
.lap-harian .fi-table tbody tr:hover td:first-child { background: var(--surface-2); }`;

const salesman = (b: BarisHarian) => b.salesNama ? `${b.salesNama} (${b.salesCode})` : "Tanpa salesman";

export default function Harian({ bulan }: PropsTab) {
    const [cabang, setCabang] = useState("");
    const [cari, setCari] = useState("");
    const [hal, setHal] = useState(0);
    // pertahankan: bulan/cabang berganti -> tabel lama tetap tampil (redup) sampai jawaban baru tiba.
    const [load, muatUlang] = useLoad(useCallback(() => ambilFk<JawabanHarian>(
        `/api/laporan-sales/harian?${new URLSearchParams(cabang ? { bulan, cabang } : { bulan })}`,
        (j) => j as unknown as JawabanHarian, "Monitoring Harian belum berhasil dimuat."), [bulan, cabang]), { pertahankan: true });
    const d = load.data;
    const q = cari.trim().toLowerCase();
    const tersaring = useMemo(() => !d ? [] : !q ? d.baris : d.baris.filter((b) => `${b.custNama} ${b.custNo} ${b.salesNama ?? ""} ${b.salesCode ?? ""}`.toLowerCase().includes(q)), [d, q]);
    const terakhir = Math.max(0, Math.ceil(tersaring.length / PER_HALAMAN) - 1);
    const h = Math.min(hal, terakhir);
    const awal = h * PER_HALAMAN;
    const hari = d?.hari ?? rentangBulan(bulan).hari;
    const pilihan = d ? (cabang && !d.pilihanCabang.includes(cabang) ? [cabang, ...d.pilihanCabang] : d.pilihanCabang) : cabang ? [cabang] : [];

    const kolom: Column<BarisHarian>[] = [
        { key: "pelanggan", header: "Pelanggan", cell: (b) => <span style={{ display: "inline-block", minWidth: "11rem" }}><b>{b.custNama}</b><br /><span className="fi-small fi-muted">{b.custNo}</span></span> },
        { key: "salesman", header: "Salesman", cell: (b) => b.salesNama ? <>{b.salesNama} <span className="fi-small fi-muted">{b.salesCode}</span></> : <span className="fi-muted">Tanpa salesman</span> },
        { key: "cabang", header: "Cabang", cell: (b) => b.cabang },
        { key: "mtd", header: "MTD", align: "end", cell: (b) => <b>{rupiah(Math.round(b.mtd))}</b> },
        ...Array.from({ length: hari }, (_, i): Column<BarisHarian> => ({ key: `d${i + 1}`, header: `D${i + 1}`, align: "end", cell: (b) => b.perHari[i] ? NF.format(b.perHari[i]) : "–" })),
    ];
    // Judul kosong tidak boleh bertentangan dengan strip: ada faktur yang belum terbaca ≠ "tidak ada faktur".
    const kosong = d && d.baris.length === 0 && d.fakturTanpaDpp > 0
        ? { title: "Belum ada faktur yang terbaca rinciannya", message: "Nilainya muncul setelah rincian faktur tersinkron dari Accurate." }
        : d && d.baris.length === 0 && !cabang
            ? { title: "Belum ada faktur bulan ini", message: "Tidak ada faktur penjualan (INV) pada bulan ini dalam cakupan Anda." }
            : { title: "Tidak ada yang cocok", message: "Ubah kata pencarian atau pilihan cabang." };

    return (
        <div className="lap-harian space-y-3">
            <style>{CSS}</style>
            <p className="fi-small fi-muted">Nilai = DPP faktur penjualan (INV) per tanggal faktur; MTD = jumlah sejak tanggal 1. Satu baris per pelanggan dan salesman.</p>
            <div className="flex flex-wrap items-end gap-3">
                <FormField label="Cabang">
                    {(a) => (
                        <select {...a} className="fi-input" value={cabang} onChange={(e) => { setCabang(e.target.value); setHal(0); }}>
                            <option value="">Semua cabang</option>
                            {pilihan.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    )}
                </FormField>
                <FormField label="Cari pelanggan atau salesman">
                    {(a) => <input {...a} className="fi-input" type="search" value={cari} onChange={(e) => { setCari(e.target.value); setHal(0); }} />}
                </FormField>
            </div>
            {d && d.fakturTanpaDpp > 0 && (
                <MessageStrip tone="warn" title="Faktur belum lengkap.">
                    {NF.format(d.fakturTanpaDpp)} faktur belum terbaca rinciannya (DPP kosong); nilainya belum masuk tabel.
                </MessageStrip>
            )}
            <ResponsiveTable title={d && d.bulan !== bulan ? `Monitoring harian (${d.bulan})` : "Monitoring harian"} count={tersaring.length} columns={kolom} rows={tersaring.slice(awal, awal + PER_HALAMAN)}
                rowKey={(b) => `${b.custNo}|${b.salesCode ?? ""}`} status={load.status} error={load.error} onRetry={muatUlang} empty={kosong}
                mobileItem={(b) => <ListItem doc={b.custNama} amount={rupiah(Math.round(b.mtd))} title={salesman(b)} meta={b.cabang} />} />
            {tersaring.length > PER_HALAMAN && (
                <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Halaman tabel">
                    <span className="fi-small fi-muted" aria-live="polite">Baris {NF.format(awal + 1)}–{NF.format(Math.min(awal + PER_HALAMAN, tersaring.length))} dari {NF.format(tersaring.length)}</span>
                    <span className="flex gap-2">
                        <Button disabled={h === 0} onClick={() => setHal(h - 1)}>Sebelumnya</Button>
                        <Button disabled={h >= terakhir} onClick={() => setHal(h + 1)}>Berikutnya</Button>
                    </span>
                </nav>
            )}
        </div>
    );
}
