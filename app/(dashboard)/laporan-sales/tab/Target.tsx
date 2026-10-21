/*
 * Tujuan: Tab "Target vs Realisasi" /laporan-sales — target insentif vs realisasi DPP MTD per cabang × principal untuk bulan yang dipilih
 *   di halaman (padanan EskaLink "Target vs Realization Monthly"). Angka = dashboard Insentif Sales (hitungan server lib/laporan-sales/target):
 *   realisasi hanya untuk salesman × principal bertarget; sisanya satu strip info (`tanpaTarget`), tidak masuk baris/Total.
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx.
 * Dependensi: GET /api/laporan-sales/target?bulan, lib/laporan-sales/kontrak (JawabanTarget), Fiori kit, form-kontrol/shared (ambilFk).
 * Main Functions: Target.
 * Side Effects: HTTP GET saat bulan berganti / Coba lagi. Enam keadaan lewat ResponsiveTable: memuat, siap, kosong, galat, galat dengan data
 *   lama, tanpa izin (403 → pesan galat berkalimat izin).
 * Catatan: baris Total = baris terakhir tabel (ResponsiveTable tanpa slot footer); ponytail: tidak dihitung di klien, diambil dari jawaban server.
 */
"use client";

import { useCallback } from "react";
import { ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column, type Tone } from "@/components/fiori/core";
import { useLoad } from "@/components/fiori/interactive";
import { ambilFk } from "../../form-kontrol/shared";
import { TAB, type BarisTarget, type JawabanTarget, type PropsTab } from "@/lib/laporan-sales/kontrak";

const API = TAB.find((t) => t.id === "target")!.api;
const NF = new Intl.NumberFormat("id-ID");
const NF_PERSEN = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const rupiah = (n: number) => `Rp ${NF.format(Math.round(n))}`;

type Baris = BarisTarget & { total?: true };

/** Nada capaian: ≥ 100 baik, < 70 kritis, di antaranya waspada; tanpa target = netral (bukan 0%). */
function Persen({ persen }: { persen: number | null }) {
    if (persen === null) return <StatusBadge tone="neu">Tanpa target</StatusBadge>;
    const tone: Tone = persen >= 100 ? "pos" : persen < 70 ? "neg" : "warn";
    return <StatusBadge tone={tone}>{NF_PERSEN.format(persen)}%</StatusBadge>;
}

const KOLOM: Column<Baris>[] = [
    { key: "cabang", header: "Cabang", cell: (b) => (b.total ? <b>Total</b> : b.cabang) },
    { key: "principle", header: "Principal", cell: (b) => (b.total ? "" : b.principle) },
    { key: "salesman", header: "Salesman", align: "end", cell: (b) => (b.total ? "" : NF.format(b.salesman)) },
    { key: "target", header: "Target", align: "end", cell: (b) => (b.total ? <b>{rupiah(b.target)}</b> : rupiah(b.target)) },
    { key: "realisasi", header: "Realisasi", align: "end", cell: (b) => (b.total ? <b>{rupiah(b.realisasi)}</b> : rupiah(b.realisasi)) },
    { key: "persen", header: "%", align: "end", cell: (b) => <Persen persen={b.persen} /> },
];

export default function Target({ bulan }: PropsTab) {
    const muat = useCallback(() => ambilFk(`${API}?bulan=${encodeURIComponent(bulan)}`, (j) => j as unknown as JawabanTarget, "Target vs Realisasi gagal dimuat."), [bulan]);
    const [load, muatUlang] = useLoad(muat);
    const data = load.data;
    // Bulan tanpa baris = tanpa baris Total juga (keadaan kosong, bukan tabel berisi nol).
    const rows: Baris[] = data && data.baris.length > 0 ? [...data.baris, { cabang: "Total", principle: "", salesman: 0, ...data.total, total: true }] : [];
    const semuaNol = data !== undefined && data.baris.length > 0 && data.total.target === 0;

    return (
        <div className="space-y-3">
            {load.status === "siap" && data && data.baris.length === 0 && (
                <MessageStrip tone="info" title={data.tanpaTarget.kombinasi > 0 ? "Target bulan ini belum diunggah." : "Target/progres bulan ini belum diunggah."}>Pilih bulan lain di kolom Bulan.</MessageStrip>
            )}
            {load.status === "siap" && semuaNol && (
                <MessageStrip tone="warn" title="Semua target bulan ini bernilai 0.">Persen tidak bisa dihitung.</MessageStrip>
            )}
            {load.status === "siap" && data && data.tanpaTarget.kombinasi > 0 && (
                <MessageStrip tone="info">
                    {NF.format(data.tanpaTarget.kombinasi)} kombinasi salesman × principal belum punya target — realisasi {rupiah(data.tanpaTarget.realisasi)} tidak dihitung (sama dengan dashboard Insentif).
                </MessageStrip>
            )}
            <ResponsiveTable
                title="Target vs Realisasi per cabang"
                count={data?.baris.length}
                columns={KOLOM}
                rows={rows}
                rowKey={(b) => (b.total ? "total" : `${b.cabang}\u0000${b.principle}`)}
                status={load.status}
                error={load.error}
                onRetry={muatUlang}
                empty={{ title: "Belum ada data bulan ini", message: "Target atau progres harian bulan ini belum diunggah." }}
                mobileItem={(b) => (
                    <ListItem
                        doc={b.total ? "Total" : b.principle}
                        amount={rupiah(b.realisasi)}
                        title={b.total ? undefined : b.cabang}
                        meta={`Target ${rupiah(b.target)}${b.total ? "" : ` · ${NF.format(b.salesman)} salesman`}`}
                        badge={<Persen persen={b.persen} />}
                    />
                )}
            />
        </div>
    );
}
