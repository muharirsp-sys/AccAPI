/*
 * Tujuan: Tab "Drop Size" /laporan-sales — nilai per faktur per tipe outlet (padanan EskaLink "Drop Size by Type Outlet"): tabel Tipe, Toko,
 *   Faktur, Nilai, Drop size, Nilai/toko + baris Total tertimbang, pilihan cabang, daftar ListItem di ponsel.
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx (props: bulan).
 * Dependensi: GET /api/laporan-sales/drop-size, lib/laporan-sales/drop-size (totalDropSize — murni), Fiori kit, ambilFk (form-kontrol/shared).
 * Main Functions: DropSize. Side Effects: HTTP GET saat bulan/cabang berganti.
 * Enam keadaan: memuat (Skeleton), siap, kosong (EmptyState), galat (ErrorState + Coba lagi), galat dengan data lama (strip + tabel lama),
 *   tanpa izin (403 -> ErrorState "Akun Anda tidak punya izin untuk ini."; tab ini memang disembunyikan server tanpa izin).
 */
"use client";

import { useCallback, useState } from "react";
import { ListItem, MessageStrip, ResponsiveTable, type Column } from "@/components/fiori/core";
import { FormField, useLoad } from "@/components/fiori/interactive";
import type { BarisDropSize, PropsTab } from "@/lib/laporan-sales/kontrak";
import { totalDropSize, type JawabanDropSizeLengkap } from "@/lib/laporan-sales/drop-size";
import { ambilFk } from "../../form-kontrol/shared";

const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const angka = (n: number) => n.toLocaleString("id-ID");

export default function DropSize({ bulan }: PropsTab) {
    const [cabang, setCabang] = useState("");
    const [load, muatUlang] = useLoad(useCallback(() => ambilFk(
        `/api/laporan-sales/drop-size?bulan=${bulan}${cabang ? `&cabang=${encodeURIComponent(cabang)}` : ""}`,
        (j) => j as unknown as JawabanDropSizeLengkap, "Drop Size gagal dimuat."), [bulan, cabang]), { pertahankan: true });
    const d = load.data;
    const baris = d?.baris ?? [];
    const total = totalDropSize(baris);
    const rows = baris.length > 0 ? [...baris, total] : [];
    const pilihan = [...new Set([...(d?.pilihanCabang ?? []), ...(cabang ? [cabang] : [])])]; // cabang terpilih tetap ada di daftar walau bulan lain tak memilikinya
    const nama = (r: BarisDropSize) => (r === total ? <strong>{r.tipe}</strong> : r.tipe);
    const kolom: Column<BarisDropSize>[] = [
        { key: "tipe", header: "Tipe", cell: nama },
        { key: "toko", header: "Toko", align: "end", cell: (r) => angka(r.toko) },
        { key: "faktur", header: "Faktur", align: "end", cell: (r) => angka(r.faktur) },
        { key: "nilai", header: "Nilai", align: "end", cell: (r) => rupiah(r.nilai) },
        { key: "dropSize", header: "Drop size", align: "end", cell: (r) => rupiah(r.dropSize) },
        { key: "nilaiPerToko", header: "Nilai/toko", align: "end", cell: (r) => rupiah(r.nilaiPerToko) },
    ];
    return (
        <div className="space-y-3">
            {d && d.fakturTanpaDpp > 0 && (
                <MessageStrip tone="warn" title="Sebagian faktur belum terbaca.">
                    {angka(d.fakturTanpaDpp)} faktur belum terbaca DPP-nya sehingga tidak dihitung di tabel ini.
                </MessageStrip>
            )}
            <ResponsiveTable
                title="Drop Size per tipe outlet" count={baris.length || undefined}
                columns={kolom} rows={rows} rowKey={(r) => (r === total ? "__total" : r.tipe)}
                status={load.status} error={load.error} onRetry={muatUlang}
                empty={{ title: "Belum ada faktur", message: cabang ? `Tidak ada faktur ber-DPP untuk cabang ${cabang} pada bulan ini. Pilih "Semua cabang" untuk melihat seluruhnya.` : "Belum ada faktur ber-DPP pada bulan ini." }}
                actions={<div style={{ minWidth: 220 }}><FormField label="Cabang">{(a) => (
                    <select {...a} className="fi-input" value={cabang} onChange={(e) => setCabang(e.target.value)}>
                        <option value="">Semua cabang</option>
                        {pilihan.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                )}</FormField></div>}
                mobileItem={(r) => <ListItem doc={nama(r)} amount={rupiah(r.nilai)} title={`Drop size ${rupiah(r.dropSize)} · ${rupiah(r.nilaiPerToko)}/toko`} meta={`${angka(r.toko)} toko · ${angka(r.faktur)} faktur`} />}
            />
        </div>
    );
}
