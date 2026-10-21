/*
 * Tujuan: Tab "Top 30" /laporan-sales: dua tabel (30 produk, 30 pelanggan teratas sebulan) menurut nilai DPP atau qty, disaring per principal.
 *   Berdampingan di layar ≥ 1536 px, bertumpuk di bawahnya; di ponsel tiap tabel menjadi daftar. Enam keadaan: memuat, siap, kosong,
 *   galat, galat dengan data lama (strip + hasil sebelumnya), tanpa izin (403 → kalimat izin dari ambilFk).
 * Caller: app/(dashboard)/laporan-sales/LaporanSales.tsx (tab "top30", bulan dari pemilih bulan kerangka).
 * Dependensi: lib/laporan-sales/{kontrak,top30} (hanya tipe), ../../form-kontrol/shared (ambilFk), components/fiori/{core,interactive}.
 * Main Functions: Top30 (default).
 * Side Effects: GET /api/laporan-sales/top30?bulan&urut&principle?.
 * Qty: baris yang memuat lebih dari satu satuan (KRT + PCS …) menampilkan "campur (daftar satuan)", bukan jumlah lintas satuan.
 */
"use client";

import { useCallback, useState } from "react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, type Column } from "@/components/fiori/core";
import { FormField, useLoad } from "@/components/fiori/interactive";
import type { PropsTab } from "@/lib/laporan-sales/kontrak";
import type { BarisTop30Satuan, JawabanTop30Satuan } from "@/lib/laporan-sales/top30";
import { ambilFk } from "../../form-kontrol/shared";

const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const angka = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });
const bulanTeks = (bulan: string) => {
    const [t, b] = bulan.split("-").map(Number);
    return new Date(Date.UTC(t, b - 1)).toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });
};
const campur = (r: BarisTop30Satuan) => r.satuan.length > 1;
const qtyTeks = (r: BarisTop30Satuan) => campur(r) ? `campur (${r.satuan.join(", ")})` : `${angka(r.qty)} ${r.satuan[0] ?? ""}`.trim();

const kolom = (judulKode: string): Column<BarisTop30Satuan>[] => [
    { key: "no", header: "Peringkat", cell: (r) => <span className="fi-tnum">{r.peringkat}</span> },
    { key: "kode", header: judulKode, cell: (r) => <span className="fi-mono">{r.kode}</span> },
    { key: "nama", header: "Nama", cell: (r) => r.nama },
    { key: "nilai", header: "Nilai (Rp)", align: "end", cell: (r) => <span className="fi-tnum">{rp(r.nilai)}</span> },
    { key: "qty", header: "Qty", align: "end", cell: (r) => <span className="fi-tnum">{qtyTeks(r)}</span> },
    { key: "faktur", header: "Faktur", align: "end", cell: (r) => <span className="fi-tnum">{angka(r.faktur)}</span> },
];

function Tabel({ judul, judulKode, rows, memuat }: { judul: string; judulKode: string; rows: BarisTop30Satuan[]; memuat: boolean }) {
    return (
        <ResponsiveTable
            title={judul} count={memuat && rows.length === 0 ? undefined : rows.length} columns={kolom(judulKode)} rows={rows} rowKey={(r) => `${r.kode}|${r.nama}`}
            status={memuat ? "memuat" : "siap"} empty={{ title: "Tidak ada data" }}
            mobileItem={(r) => <ListItem doc={`#${r.peringkat} · ${r.kode}`} amount={rp(r.nilai)} title={r.nama} meta={`${qtyTeks(r)} · ${angka(r.faktur)} faktur`} />}
        />
    );
}

export default function Top30({ bulan }: PropsTab) {
    const [principle, setPrinciple] = useState("");
    const [urut, setUrut] = useState<"nilai" | "qty">("nilai");
    const [load, muatUlang] = useLoad(useCallback(() => {
        const p = new URLSearchParams({ bulan, urut, ...(principle ? { principle } : {}) });
        return ambilFk(`/api/laporan-sales/top30?${p}`, (j) => j as unknown as JawabanTop30Satuan, "Laporan Top 30 belum berhasil dimuat.");
    }, [bulan, principle, urut]), { pertahankan: true });

    const data = load.data;
    // Principal terpilih yang tak ada di bulan baru tetap tampil di pilihan (hasilnya kosong, bukan hilang diam-diam).
    const opsi = data?.pilihanPrincipal ?? [];
    const daftar = principle && !opsi.includes(principle) ? [principle, ...opsi] : opsi;
    const saring = (
        <div className="flex flex-wrap items-end gap-3">
            <FormField label="Principal">{(a) => (
                <select {...a} className="fi-input" value={principle} onChange={(e) => setPrinciple(e.target.value)}>
                    <option value="">Semua principal</option>
                    {daftar.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
            )}</FormField>
            <FormField label="Urut menurut">{(a) => (
                <select {...a} className="fi-input" value={urut} onChange={(e) => setUrut(e.target.value === "qty" ? "qty" : "nilai")}>
                    <option value="nilai">Nilai (Rp)</option>
                    <option value="qty">Qty</option>
                </select>
            )}</FormField>
        </div>
    );

    if (load.status === "galat" && !data) return <div className="space-y-4">{saring}<ErrorState message={load.error} onRetry={muatUlang} /></div>;

    const kosong = data && data.produk.length === 0 && data.pelanggan.length === 0;
    const adaCampur = data && [...data.produk, ...data.pelanggan].some(campur);
    const memuat = load.status === "memuat";
    return (
        <div className="space-y-4" aria-busy={memuat || undefined}>
            {saring}
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {load.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            {adaCampur && (
                <MessageStrip tone="info" title="Qty tidak dijumlah lintas satuan">
                    Baris yang memuat lebih dari satu satuan (mis. KRT dan PCS) ditulis &quot;campur&quot; karena satuan berbeda tidak setara.
                    Urut Qty tetap menjumlah apa adanya, jadi baca bersama satuannya.
                </MessageStrip>
            )}
            {kosong ? (
                <EmptyState
                    title={principle ? `Tidak ada penjualan ${principle}` : "Belum ada penjualan"}
                    message={principle ? `Tidak ada faktur ${principle} pada ${bulanTeks(bulan)}. Pilih "Semua principal" atau principal lain.` : `Tidak ada faktur penjualan pada ${bulanTeks(bulan)} di History Penjualan.`} />
            ) : (
                <div className="grid gap-4 2xl:grid-cols-2">
                    <Tabel judul="Top 30 produk" judulKode="Kode produk" rows={data?.produk ?? []} memuat={memuat} />
                    <Tabel judul="Top 30 pelanggan" judulKode="Kode pelanggan" rows={data?.pelanggan ?? []} memuat={memuat} />
                </div>
            )}
        </div>
    );
}
