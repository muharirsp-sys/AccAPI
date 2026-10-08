/*
 * Tujuan: Tab Kontrol Frekuensi Kunjungan (Fiori S5, it05): over-visit per toko untuk satu salesman × principal × bulan, ringkasan
 *   kapasitas dari server (simulation). Server menghitung hanya bila kode sales DAN principal terisi (eq keduanya), jadi layar meminta
 *   keduanya alih-alih menampilkan "kosong" yang menyesatkan. SM memilih salesman dari kode timnya (scope yang sudah dimuat).
 * Caller: form-kontrol/FormKontrol.tsx (tab "frekuensi").
 * Dependensi: ../shared (Scope, FreqRow, PRINCIPLES, hariIniWita, ambilFk), components/fiori/{core,interactive}.
 * Main Functions: TabFrekuensi (default).
 * Side Effects: GET /api/form-kontrol/frequency?month&year&salesCode&principle.
 */
"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ListItem, ResponsiveTable, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { PRINCIPLES, ambilFk, hariIniWita, type FreqRow, type Scope } from "../shared";

type Simulasi = { workDays?: number; visitsPerDay?: number; totalSlots: number; capacity1x: number; capacity2x: number; capacity4x: number };
type Data = { rows: FreqRow[]; simulation: Simulasi | null };
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export default function TabFrekuensi({ scope }: { scope: Scope }) {
    const [tahun, bulanIni] = hariIniWita().split("-").map(Number);
    const tim = scope.allowedSalesCodes;
    const [principle, setPrinciple] = useState(PRINCIPLES[0]);
    const [month, setMonth] = useState(bulanIni);
    const [salesCode, setSalesCode] = useState(scope.salesCode ?? (tim?.length === 1 ? tim[0] : ""));
    const lengkap = Boolean(salesCode.trim() && principle);
    // SM/SPV tanpa salesman tertaut: tidak ada yang bisa dipilih — jelaskan, jangan minta "Pilih salesman".
    const timKosong = tim !== null && tim.length === 0 && !scope.salesCode;

    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Data>> => {
        // Tanpa kode sales/principal server pasti mengembalikan kosong (filter eq) — tidak perlu ditanyakan.
        if (!salesCode.trim() || !principle) return { status: "siap", data: { rows: [], simulation: null } };
        const p = new URLSearchParams({ month: String(month), year: String(tahun), salesCode: salesCode.trim(), principle });
        return ambilFk(`/api/form-kontrol/frequency?${p}`, (j) => ({ rows: (j.rows ?? []) as FreqRow[], simulation: (j.simulation ?? null) as Simulasi | null }),
            "Data frekuensi belum berhasil dimuat.");
    }, [salesCode, principle, month, tahun]), { pertahankan: true });

    const rows = load.data?.rows ?? [];
    const sim = load.data?.simulation ?? null;
    const over = rows.filter((r) => r.overVisit).length;

    const kolom: Column<FreqRow>[] = [
        { key: "kode", header: "Kode toko", cell: (r) => <span className="fi-mono">{r.custCode}</span> },
        { key: "nama", header: "Nama toko", cell: (r) => r.custName },
        { key: "pola", header: "Pola minggu", cell: (r) => r.mingguPattern },
        { key: "freq", header: "Frekuensi", align: "end", cell: (r) => <span className="fi-tnum">{r.visitFrequency}×/bln</span> },
        { key: "aktual", header: "Aktual", align: "end", cell: (r) => <span className="fi-tnum">{r.actualVisits}×</span> },
        { key: "status", header: "Status", cell: (r) => r.overVisit ? <StatusBadge tone="warn">Over-visit</StatusBadge> : <StatusBadge tone="pos">Normal</StatusBadge> },
    ];

    const pilihSales = tim === null ? (
        <FormField label="Kode sales" required>{(a) => <input {...a} className="fi-input" value={salesCode} onChange={(e) => setSalesCode(e.target.value)} placeholder="mis. kode salesman" />}</FormField>
    ) : tim.length > 1 ? (
        <FormField label="Salesman" required>{(a) => (
            <select {...a} className="fi-input" value={salesCode} onChange={(e) => setSalesCode(e.target.value)}>
                <option value="">Pilih kode sales tim…</option>
                {tim.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
        )}</FormField>
    ) : null;

    return (
        <>
            <FilterBar
                title="Kontrol Frekuensi Kunjungan"
                activeCount={0}
                onReset={() => { setPrinciple(PRINCIPLES[0]); setMonth(bulanIni); }}
                actions={<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} disabled={!lengkap} onClick={muatUlang}>Muat ulang</Button>}
                search={pilihSales ?? undefined}
                fields={
                    <>
                        <FormField label="Principal" required>{(a) => (
                            <select {...a} className="fi-input" value={principle} onChange={(e) => setPrinciple(e.target.value)}>
                                {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Bulan">{(a) => (
                            <select {...a} className="fi-input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                                {BULAN.map((b, i) => <option key={b} value={i + 1}>{b} {tahun}</option>)}
                            </select>
                        )}</FormField>
                    </>
                }
            />
            <p className="fi-small fi-muted">Optimalkan cakupan — hindari over-visit agar waktu salesman tidak terbuang. Toko 1×/bulan yang dikunjungi 2× = over-visit.</p>
            {sim && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="fi-kc"><span>Hari kerja / bulan</span><b>{sim.workDays ?? Math.floor(sim.totalSlots / 20)}</b><small>estimasi</small></div>
                    <div className="fi-kc"><span>Kunjungan / hari</span><b>{sim.visitsPerDay ?? 20}</b><small>kapasitas</small></div>
                    <div className="fi-kc"><span>Total slot</span><b>{sim.totalSlots}</b><small>1× = {sim.capacity1x} · 2× = {sim.capacity2x} · 4× = {sim.capacity4x} toko</small></div>
                    <div className="fi-kc" data-tone={over ? "warn" : "pos"}><span>Over-visit</span><b>{over}</b><small>toko bulan ini</small></div>
                </div>
            )}
            {timKosong ? (
                <EmptyState title="Belum ada salesman di tim Anda" message="Salesman muncul setelah admin mengisi SM/SPV mereka di Hierarki Sales." />
            ) : !lengkap ? (
                <EmptyState title="Pilih salesman dan principal" message="Frekuensi dihitung per salesman per principal; isi keduanya untuk melihat toko yang over-visit." />
            ) : (
                <ResponsiveTable
                    title="Frekuensi per toko"
                    count={rows.length}
                    columns={kolom}
                    rows={rows}
                    rowKey={(r) => r.custCode}
                    status={load.status}
                    error={load.error}
                    onRetry={muatUlang}
                    empty={{ title: "Tidak ada toko JKS aktif untuk salesman dan principal ini", message: "Periksa kode sales atau impor JKS lebih dulu." }}
                    mobileItem={(r) => (
                        <ListItem doc={<span className="fi-mono">{r.custCode}</span>} amount={<span className="fi-tnum">{r.actualVisits}× / {r.visitFrequency}×</span>}
                            title={r.custName} meta={`Pola ${r.mingguPattern}`}
                            badge={r.overVisit ? <StatusBadge tone="warn">Over-visit</StatusBadge> : <StatusBadge tone="pos">Normal</StatusBadge>} />
                    )}
                />
            )}
            <VariantNote bl="BL-48">
                Kapasitas memakai 24 hari kerja × 20 kunjungan tetap dari server. &quot;Aktual&quot; menghitung hari yang punya baris status rute,
                termasuk baris &quot;tidak dikunjungi&quot;.
            </VariantNote>
        </>
    );
}
