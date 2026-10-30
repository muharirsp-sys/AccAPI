/*
 * Tujuan: Bagian SPV OFF Program Control di luar form batch (Fiori S4d): pengingat kelengkapan belum lengkap
 *   (IncompleteDocumentsReminderPanel kode lama) dan Pengajuan diskon SPV (DiscountDashboard kode lama, jejak digital). Payload dan
 *   validasi = kode lama. Form ajukan pengembalian selisih kini satu komponen bersama di SmRefund.tsx (audit desain No 76).
 * Caller: opc/peran/Spv.tsx.
 * Dependensi: components/fiori/{core,interactive}, opc/Bersama (ambilOpc, tulisOpc, tanganiTulis, pesanTidakPasti, tipe),
 *   opc/peran/SpvForm (parseUiCurrency, kodePrincipal), lib/off-program-control/constants, lib/opc-ui, lib/promo-ui, lib/tampil (KOSONG).
 * Main Functions: PengingatKelengkapan, DiskonSpv.
 * Side Effects: GET + POST (FormData) /api/off-program-control/discount.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { offPrinciples } from "@/lib/off-program-control/constants";
import { tanggalOpc, waktuWita, type BatchOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { ambilOpc, pesanTidakPasti, tanganiTulis, tulisOpc, type OpcKonteks } from "../Bersama";
import { kodePrincipal, parseUiCurrency } from "./SpvForm";

/** Batch milik SPV yang ditandai Klaim "kelengkapan belum lengkap" (finalStatus Incomplete Documents). Kosong = tidak dirender. */
export function PengingatKelengkapan({ batches, buka, href }: { batches: BatchOpc[]; buka: (id: string) => void; href: (id: string) => string }) {
    const xs = batches.filter((b) => b.finalStatus === "Incomplete Documents");
    if (xs.length === 0) return null;
    return (
        <Section title="Pengingat kelengkapan belum lengkap" subtitle={`${xs.length} batch · lengkapi berkas sesuai catatan Klaim`}>
            <ul className="fi-list" style={{ display: "block" }} aria-label="Batch dengan kelengkapan belum lengkap">
                {xs.map((b) => (
                    <li key={b.id}>
                        <ListItem doc={b.noPengajuan} title={`${b.principleName} (${b.principleCode})`}
                            meta={`Catatan Klaim: ${b.finalClaimNote || KOSONG} · diperbarui ${waktuWita(b.updatedAt)}`}
                            badge={<StatusBadge tone="warn">Kelengkapan belum lengkap</StatusBadge>} href={href(b.id)} onClick={() => buka(b.id)} />
                    </li>
                ))}
            </ul>
        </Section>
    );
}

type Diskon = {
    id: string; toko: string; principleCode?: string | null; principleName?: string | null; program?: string | null; nominal: number;
    alasan?: string | null; tanggal?: string | null; status: string; catatan?: string | null; documentUrl?: string | null; documentName?: string | null;
    createdByName?: string | null; createdAt?: number | string | null;
};

/**
 * Dashboard Diskon SPV (Revisi I kode lama): jejak digital, BELUM approval resmi. Hanya peran Supervisor yang mencatat (selaras
 * backend); Admin baca-saja. Saringan cari + bulan/rentang dikirim ke server (search, dateFrom, dateTo) seperti kode lama.
 */
export function DiskonSpv({ ctx }: { ctx: OpcKonteks }) {
    const bisaKelola = ctx.peran === "supervisor";
    const [cari, setCari] = useState("");
    const [bulan, setBulan] = useState("");
    const [dari, setDari] = useState("");
    const [sampai, setSampai] = useState("");
    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Diskon[]>> => {
        const params = new URLSearchParams();
        if (cari.trim()) params.set("search", cari.trim());
        if (dari || sampai) {
            if (dari) params.set("dateFrom", dari);
            if (sampai) params.set("dateTo", sampai);
        } else if (bulan) {
            const [y, m] = bulan.split("-");
            const akhir = new Date(Number(y), Number(m), 0).getDate();
            params.set("dateFrom", `${y}-${m}-01`);
            params.set("dateTo", `${y}-${m}-${String(akhir).padStart(2, "0")}`);
        }
        const q = params.toString();
        return ambilOpc(`/api/off-program-control/discount${q ? `?${q}` : ""}`, (j) => (Array.isArray(j.submissions) ? (j.submissions as Diskon[]) : []),
            "Pengajuan diskon belum berhasil dimuat.");
    }, [cari, bulan, dari, sampai]), { pertahankan: true });
    const [pesan, setPesan] = useState<string | null>(null);
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);
    const nSaringan = [cari.trim(), bulan || dari || sampai].filter(Boolean).length;
    const hapusSaringan = () => { setCari(""); setBulan(""); setDari(""); setSampai(""); };
    const rows = load.data ?? [];

    const kolom: Column<Diskon>[] = [
        { key: "tgl", header: "Tanggal", cell: (r) => (r.tanggal ? tanggalOpc(r.tanggal) : waktuWita(r.createdAt)) },
        { key: "toko", header: "Toko/customer", cell: (r) => r.toko },
        { key: "principal", header: "Principal", cell: (r) => r.principleName || KOSONG },
        { key: "nominal", header: "Nominal", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.nominal)}</span> },
        { key: "program", header: "Program", secondary: true, cell: (r) => r.program || KOSONG },
        { key: "alasan", header: "Alasan", secondary: true, cell: (r) => r.alasan || KOSONG },
        { key: "status", header: "Status", secondary: true, cell: (r) => r.status },
        { key: "user", header: "Dicatat oleh", secondary: true, cell: (r) => r.createdByName || KOSONG },
        { key: "dok", header: "Dokumen", secondary: true, cell: (r) => (r.documentUrl ? <a href={r.documentUrl} target="_blank" rel="noreferrer">{r.documentName || "Lihat"}</a> : KOSONG) },
    ];

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <MessageStrip tone="info" title="Pengajuan diskon SPV:">
                {ctx.peran === "admin"
                    ? "Halaman ini adalah jejak digital pengajuan diskon SPV dan belum menjadi workflow approval resmi."
                    : "Modul ini hanya jejak digital pengajuan diskon. Workflow approval belum aktif dan data tidak memengaruhi alur OFF Program Control."}
            </MessageStrip>
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {tidakPasti && <MessageStrip tone="warn" title="Hasil pencatatan terakhir belum pasti." onClose={() => setTidakPasti(null)}>{tidakPasti}</MessageStrip>}
            {bisaKelola && (
                <FormDiskon ctx={ctx} selesai={(p) => { setTidakPasti(null); setPesan(p); muatUlang(); }}
                    tidakPasti={(p) => { setTidakPasti(p); muatUlang(); }} />
            )}
            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar
                    title="Saringan pengajuan diskon"
                    activeCount={nSaringan}
                    onReset={hapusSaringan}
                    search={<FormField label="Cari diskon">{(a) => <input {...a} className="fi-input" type="search" placeholder="Toko, principal, program, alasan" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={<>
                        <FormField label="Bulan">{(a) => <input {...a} className="fi-input" type="month" value={bulan} onChange={(e) => { setBulan(e.target.value); setDari(""); setSampai(""); }} />}</FormField>
                        <FormField label="Dari tanggal">{(a) => <input {...a} className="fi-input" type="date" value={dari} onChange={(e) => { setDari(e.target.value); setBulan(""); }} />}</FormField>
                        <FormField label="Sampai tanggal">{(a) => <input {...a} className="fi-input" type="date" value={sampai} onChange={(e) => { setSampai(e.target.value); setBulan(""); }} />}</FormField>
                    </>}
                    chips={[
                        ...(cari.trim() ? [{ label: `Cari: ${cari.trim()}`, onRemove: () => setCari("") }] : []),
                        ...(bulan ? [{ label: `Bulan: ${bulan.split("-").reverse().join("/")}`, onRemove: () => setBulan("") }] : []),
                        ...(dari || sampai ? [{ label: `Tanggal: ${dari ? tanggalOpc(dari) : "awal"} – ${sampai ? tanggalOpc(sampai) : "akhir"}`, onRemove: () => { setDari(""); setSampai(""); } }] : []),
                    ]}
                />
                <ResponsiveTable title="Daftar pengajuan diskon" count={load.data ? rows.length : undefined} columns={kolom} rows={rows} rowKey={(r) => r.id}
                    status={load.status} error={load.error} onRetry={muatUlang}
                    empty={nSaringan > 0
                        ? { title: "Tidak ada pengajuan diskon yang cocok dengan saringan", action: <Button onClick={hapusSaringan}>Hapus saringan</Button> }
                        : { title: "Belum ada pengajuan diskon." }}
                    mobileItem={(r) => (
                        <ListItem doc={r.tanggal ? tanggalOpc(r.tanggal) : waktuWita(r.createdAt)} amount={rupiah(r.nominal)} title={r.toko}
                            meta={[r.principleName, r.program, r.alasan, r.createdByName].filter(Boolean).join(" · ")} badge={<StatusBadge tone="neu">{r.status}</StatusBadge>} />
                    )} />
            </div>
        </div>
    );
}

/** Form "Buat Pengajuan Diskon" (kode lama). Validasi toko & nominal wajib (kalimat kode lama); kirim FormData lewat dialog. */
function FormDiskon({ ctx, selesai, tidakPasti }: { ctx: OpcKonteks; selesai: (pesan: string) => void; tidakPasti: (pesan: string) => void }) {
    const [toko, setToko] = useState("");
    const [principleName, setPrincipleName] = useState("");
    const [program, setProgram] = useState("");
    const [nominal, setNominal] = useState("");
    const [alasan, setAlasan] = useState("");
    const [tanggal, setTanggal] = useState("");
    const [catatan, setCatatan] = useState("");
    const [docFile, setDocFile] = useState<File | null>(null);
    const [kunciFile, setKunciFile] = useState(0); // input file tidak bisa dikosongkan lewat value; dipasang ulang saat reset
    const [dialog, setDialog] = useState(false);
    const dirty = Boolean(toko || principleName || program || nominal || alasan || tanggal || catatan || docFile);
    const { setDraf } = ctx;
    useEffect(() => { setDraf(dirty); return () => setDraf(false); }, [dirty, setDraf]);
    const kurang = !toko.trim() ? "Toko/customer wajib diisi." : !nominal.trim() ? "Nominal diskon wajib diisi." : undefined;
    const reset = () => {
        setToko(""); setPrincipleName(""); setProgram(""); setNominal(""); setAlasan(""); setTanggal(""); setCatatan(""); setDocFile(null);
        setKunciFile((k) => k + 1);
    };

    return (
        <Section title="Catat pengajuan diskon" subtitle="jejak digital, belum approval">
            <div className="fi-sect-in">
                <div className="fi-formgrid">
                    <FormField label="Toko / customer" required>{(a) => <input {...a} className="fi-input" value={toko} onChange={(e) => setToko(e.target.value)} />}</FormField>
                    <FormField label="Principal">{(a) => (
                        <select {...a} className="fi-input" value={principleName} onChange={(e) => setPrincipleName(e.target.value)}>
                            <option value="">Pilih principal…</option>
                            {offPrinciples.map((p) => <option key={p.code} value={p.name}>{p.name}</option>)}
                        </select>
                    )}</FormField>
                    <FormField label="Program">{(a) => <input {...a} className="fi-input" value={program} onChange={(e) => setProgram(e.target.value)} />}</FormField>
                    <FormField label="Nominal diskon" required>{(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" placeholder="Rp 0" value={nominal} onChange={(e) => setNominal(e.target.value)} />}</FormField>
                    <FormField label="Tanggal">{(a) => <input {...a} className="fi-input" type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />}</FormField>
                    <FormField label="Dokumen pendukung (opsional)" help="PDF, PNG, atau JPG; maksimal 5 MB.">{(a) => (
                        <input {...a} key={kunciFile} className="fi-input" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setDocFile(e.target.files?.[0] || null)} />
                    )}</FormField>
                </div>
                <FormField label="Alasan">{(a) => <textarea {...a} className="fi-input" rows={2} value={alasan} onChange={(e) => setAlasan(e.target.value)} />}</FormField>
                <FormField label="Catatan">{(a) => <textarea {...a} className="fi-input" rows={2} value={catatan} onChange={(e) => setCatatan(e.target.value)} />}</FormField>
                <div className="fi-btnrow">
                    <span className="fi-small fi-subtle" style={{ flex: 1 }}>{kurang ?? (dirty ? "Isian belum dicatat." : "")}</span>
                    <Button variant="primary" disabled={Boolean(kurang)} disabledReason={kurang} onClick={() => setDialog(true)}>Catat pengajuan diskon…</Button>
                </div>
            </div>
            <ConfirmDialog
                open={dialog}
                onClose={() => setDialog(false)}
                tag="Jejak digital"
                title={`Catat pengajuan diskon untuk ${toko.trim()}?`}
                description="Hanya jejak digital: belum ada alur persetujuan dan tidak memengaruhi alur OFF Program Control."
                facts={[
                    ["Toko / customer", toko.trim()],
                    ["Principal", principleName || KOSONG],
                    ["Program", program || KOSONG],
                    ["Nominal", rupiah(parseUiCurrency(nominal))],
                    ["Tanggal", tanggalOpc(tanggal)],
                    ["Dokumen", docFile?.name || "Tidak ada"],
                ]}
                confirmLabel="Catat pengajuan"
                onConfirm={async () => {
                    // submitDiscount (kode lama): FormData dengan kunci yang sama.
                    const formData = new FormData();
                    formData.append("toko", toko.trim());
                    formData.append("principleName", principleName);
                    formData.append("principleCode", kodePrincipal(principleName));
                    formData.append("program", program);
                    formData.append("nominal", nominal);
                    formData.append("alasan", alasan);
                    formData.append("tanggal", tanggal);
                    formData.append("catatan", catatan);
                    if (docFile) formData.append("document", docFile);
                    await tulisOpc("/api/off-program-control/discount", {
                        body: formData, gagal: "Gagal menyimpan pengajuan diskon.", putus: pesanTidakPasti("pengajuan diskon ini", "daftar pengajuan diskon"),
                    }).catch(tanganiTulis(tidakPasti, () => setDialog(false)));
                    reset();
                    setDialog(false);
                    selesai("Pengajuan diskon tercatat sebagai jejak digital.");
                }}
            />
        </Section>
    );
}
