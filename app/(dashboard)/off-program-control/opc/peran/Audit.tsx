/*
 * Tujuan: Modul Log audit OFF Program Control (Fiori S4d, tab `audit`; Klaim, admin): daftar log aksi semua batch (port AuditTimeline
 *   old-opc.tsx 9578–9917) dengan cari + bulan/rentang tanggal di server, ekspor CSV, koreksi non-destruktif lewat dialog, dan tombol
 *   membuka batchnya di kolom kedua tab lain.
 * Caller: OpcApp.tsx (MODUL.audit).
 * Dependensi: opc/Bersama (ambilOpc, tulisOpc, kontrak), components/fiori/{core,interactive}, lib/opc-ui.
 * Main Functions: Audit.
 * Side Effects: GET /api/off-program-control/audit?search&dateFrom&dateTo (cari ditunda 300 ms); tautan GET ...&format=csv (tab baru);
 *   POST /api/off-program-control/audit/[id]/correction {correctionReason, note} — baris koreksi baru, log asal tidak diubah.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, PencilLine } from "lucide-react";
import { Button, EmptyState, KeyValues, ListItem, MessageStrip, ResponsiveTable, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad } from "@/components/fiori/interactive";
import { catatanSendiri, labelAksiAudit, labelPeranAktor, labelStatus, waktuWita, type AuditOpc } from "@/lib/opc-ui";
import { ambilOpc, tulisOpc, type PeranProps } from "../Bersama";

const BATAS_TAMPIL = 500;
/** AUDIT_CORRECTION_WARNING kode lama 9575. */
const PERINGATAN_KOREKSI = "Perubahan pada audit log akan tercatat sebagai riwayat koreksi. Pastikan perubahan hanya dilakukan untuk memperbaiki kesalahan pencatatan, bukan menghapus jejak aktivitas.";

/** Baris GET /audit: koreksi membawa snapshot nilai sebelum koreksi (route audit/[id]/correction). */
type BarisAudit = AuditOpc & { previousValue?: { note?: string | null } | null };

/** "2026-09" → rentang tanggal sebulan penuh (saringan Bulan-Tahun lama 9606–9611). */
function rentangBulan(bulan: string): [string, string] {
    const [y, m] = bulan.split("-");
    const akhir = new Date(Number(y), Number(m), 0).getDate();
    return [`${y}-${m}-01`, `${y}-${m}-${String(akhir).padStart(2, "0")}`];
}
const ddmm = (ymd: string) => ymd.split("-").reverse().join("/");

export default function Audit({ ctx }: PeranProps) {
    const [cari, setCari] = useState("");
    const [q, setQ] = useState("");
    const [bulan, setBulan] = useState("");
    const [dari, setDari] = useState("");
    const [sampai, setSampai] = useState("");
    const [koreksi, setKoreksi] = useState<BarisAudit | null>(null);
    const [catatan, setCatatan] = useState("");
    const [pesan, setPesan] = useState<string | null>(null);
    // Ditunda 300 ms setelah berhenti mengetik (MonitoringSearch kode lama); server memfilter 5.000 log terbaru.
    useEffect(() => { const t = window.setTimeout(() => setQ(cari.trim()), 300); return () => window.clearTimeout(t); }, [cari]);
    const [dateFrom, dateTo] = bulan ? rentangBulan(bulan) : [dari, sampai];
    const tanpaIzin = ctx.izin("audit_read");
    const [load, muat] = useLoad(useCallback(async () => {
        const p = new URLSearchParams();
        if (q) p.set("search", q);
        if (dateFrom) p.set("dateFrom", dateFrom);
        if (dateTo) p.set("dateTo", dateTo);
        const qs = p.toString();
        return ambilOpc(`/api/off-program-control/audit${qs ? `?${qs}` : ""}`, (j) => (Array.isArray(j.audit) ? (j.audit as BarisAudit[]) : []), "Log audit belum berhasil dimuat.");
    }, [q, dateFrom, dateTo]), { pertahankan: true });

    if (tanpaIzin) return <EmptyState title="Log audit tidak tersedia untuk akun Anda" message={tanpaIzin} />;

    const semua = load.data ?? [];
    const rows = semua.slice(0, BATAS_TAMPIL);
    const adaSaringan = Boolean(q || dateFrom || dateTo);
    const hapusSaringan = () => { setCari(""); setBulan(""); setDari(""); setSampai(""); };
    // Ekspor memakai saringan yang sama dengan daftar (kode lama 9636 melewatkan saringan bulan; kini ikut).
    const csv = new URLSearchParams({ format: "csv" });
    if (q) csv.set("search", q);
    if (dateFrom) csv.set("dateFrom", dateFrom);
    if (dateTo) csv.set("dateTo", dateTo);
    const tanpaEkspor = ctx.izin("audit_export");
    const tanpaKoreksi = ctx.izin("audit_correct");

    const bukaKoreksi = (a: BarisAudit) => { setCatatan(a.note || ""); setPesan(null); setKoreksi(a); };
    async function simpanKoreksi(alasan: string) {
        if (!koreksi) return;
        await tulisOpc(`/api/off-program-control/audit/${encodeURIComponent(koreksi.id)}/correction`, {
            body: { correctionReason: alasan, note: catatan }, gagal: "Gagal menyimpan koreksi.",
        });
        setKoreksi(null);
        setPesan("Koreksi tercatat sebagai riwayat baru tanpa menghapus jejak lama.");
        muat();
    }
    // Hanya log asli yang bisa dikoreksi; baris koreksi sendiri tidak (kode lama 9813).
    const tombolKoreksi = (a: BarisAudit) => (a.parentAuditLogId ? null : (
        <Button variant="tertiary" icon={<PencilLine className="fi-icon" aria-hidden />} disabled={Boolean(tanpaKoreksi)} disabledReason={tanpaKoreksi}
            aria-label={`Koreksi log ${labelAksiAudit(a.action)} ${a.noPengajuan || ""}`.trim()} onClick={() => bukaKoreksi(a)}>Koreksi…</Button>
    ));
    const teksCatatan = (a: BarisAudit) => {
        if (!a.correctionReason) return [catatanSendiri(a), a.note].filter(Boolean).join(" · ") || "–"; // alasan setuju sendiri (BL-10, #132)
        const lama = a.previousValue?.note;
        return `Alasan koreksi: ${a.correctionReason}${a.note ? ` · ${a.note}` : ""}${lama && lama !== a.note ? ` (sebelumnya: ${lama})` : ""}`;
    };
    const kolom: Column<BarisAudit>[] = [
        { key: "waktu", header: "Waktu", cell: (a) => <span className="fi-tnum">{waktuWita(a.createdAt)}</span> },
        { key: "no", header: "No pengajuan", cell: (a) => <span className="fi-mono">{a.noPengajuan || "–"}</span> },
        { key: "aksi", header: "Aksi", cell: (a) => <>{labelAksiAudit(a.action)}{a.parentAuditLogId ? <> <StatusBadge tone="warn">Koreksi</StatusBadge></> : null}</> },
        { key: "status", header: "Status", secondary: true, cell: (a) => (a.fromStatus || a.toStatus ? `${labelStatus(a.fromStatus)} → ${labelStatus(a.toStatus)}` : "–") },
        { key: "oleh", header: "Oleh", cell: (a) => `${a.actorName || "Sistem"}${a.actorRole ? ` (${labelPeranAktor(a.actorRole)})` : ""}` },
        { key: "catatan", header: "Catatan", secondary: true, cell: teksCatatan },
        { key: "buka", header: "Batch", cell: (a) => <Button variant="tertiary" onClick={() => ctx.bukaBatch(a.batchId)}>Buka batch</Button> },
        { key: "koreksi", header: "Koreksi", cell: (a) => tombolKoreksi(a) ?? "–" },
    ];

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <MessageStrip tone="info" title="Koreksi tidak menghapus jejak.">
                Klaim dan admin dapat membaca, mengekspor, dan mengoreksi log ini; setiap koreksi tercatat sebagai riwayat baru yang menunjuk log asal.
            </MessageStrip>
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan log" activeCount={[q, dateFrom || dateTo].filter(Boolean).length} onReset={hapusSaringan}
                    actions={tanpaEkspor
                        ? <Button icon={<Download className="fi-icon" aria-hidden />} disabled disabledReason={tanpaEkspor}>Ekspor CSV</Button>
                        : <a className="fi-btn fi-btn--secondary" href={`/api/off-program-control/audit?${csv}`} target="_blank" rel="noopener noreferrer">
                            <Download className="fi-icon" aria-hidden />Ekspor CSV
                        </a>}
                    search={<FormField label="Cari">{(a) => <input {...a} className="fi-input" type="search" placeholder="Nomor, principal, catatan, pengguna" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={<>
                        <FormField label="Bulan">{(a) => <input {...a} className="fi-input" type="month" value={bulan} onChange={(e) => { setBulan(e.target.value); setDari(""); setSampai(""); }} />}</FormField>
                        <FormField label="Dari tanggal">{(a) => <input {...a} className="fi-input" type="date" value={dari} max={sampai || undefined} onChange={(e) => { setDari(e.target.value); setBulan(""); }} />}</FormField>
                        <FormField label="Sampai tanggal">{(a) => <input {...a} className="fi-input" type="date" value={sampai} min={dari || undefined} onChange={(e) => { setSampai(e.target.value); setBulan(""); }} />}</FormField>
                    </>}
                    chips={[
                        ...(q ? [{ label: `Cari: ${q}`, onRemove: () => setCari("") }] : []),
                        ...(bulan ? [{ label: `Bulan: ${ddmm(bulan)}`, onRemove: () => setBulan("") }] : []),
                        ...(!bulan && (dari || sampai) ? [{ label: `Tanggal: ${dari ? ddmm(dari) : "awal"} – ${sampai ? ddmm(sampai) : "akhir"}`, onRemove: () => { setDari(""); setSampai(""); } }] : []),
                    ]} />
                <ResponsiveTable title="Log audit OFF Program Control" count={semua.length} columns={kolom} rows={rows} rowKey={(a) => a.id}
                    status={load.status} error={load.error} onRetry={muat}
                    empty={adaSaringan ? { title: "Tidak ada log yang cocok dengan saringan", action: <Button onClick={hapusSaringan}>Hapus saringan</Button> } : { title: "Belum ada log audit" }}
                    mobileItem={(a) => (
                        <div style={{ display: "grid" }}>
                            <ListItem doc={a.noPengajuan || "–"} title={labelAksiAudit(a.action)} meta={`${waktuWita(a.createdAt)} · ${a.actorName || "Sistem"}`}
                                badge={a.parentAuditLogId ? <StatusBadge tone="warn">Koreksi</StatusBadge> : undefined} onClick={() => ctx.bukaBatch(a.batchId)} />
                            {!a.parentAuditLogId && <div style={{ padding: "0 8px 6px" }}>{tombolKoreksi(a)}</div>}
                        </div>
                    )} />
            </div>
            {semua.length > BATAS_TAMPIL && <p className="fi-small fi-subtle">Ditampilkan {BATAS_TAMPIL} log terbaru dari {semua.length}; persempit dengan cari atau tanggal.</p>}
            <VariantNote bl="BL-13">Server menyaring 5.000 log terbaru; log yang lebih lama tidak terjangkau. Usulan: saring dan paginasi di database.</VariantNote>
            <VariantNote bl="BL-33">Log mencatat aksi dan perubahan status; nilai item atau batch sebelum → sesudah belum disimpan (hanya catatan yang dikoreksi). Usulan: riwayat nilai lama → baru bersama.</VariantNote>

            <ConfirmDialog open={koreksi !== null} onClose={() => setKoreksi(null)} tag="Koreksi audit"
                title={`Koreksi log ${koreksi ? labelAksiAudit(koreksi.action) : ""}${koreksi?.noPengajuan ? ` pada ${koreksi.noPengajuan}` : ""}?`}
                description={<MessageStrip tone="warn" title="Peringatan:">{PERINGATAN_KOREKSI}</MessageStrip>}
                reason={{ label: "Alasan koreksi", placeholder: "Jelaskan kesalahan pencatatan yang diperbaiki…" }}
                confirmLabel="Simpan koreksi" onConfirm={simpanKoreksi}>
                {koreksi && (
                    <>
                        <KeyValues items={[
                            ["Aksi asal", labelAksiAudit(koreksi.action)],
                            ["No pengajuan", <span key="n" className="fi-mono">{koreksi.noPengajuan || "–"}</span>],
                            ["Waktu", waktuWita(koreksi.createdAt)],
                            ["Oleh", `${koreksi.actorName || "Sistem"}${koreksi.actorRole ? ` (${labelPeranAktor(koreksi.actorRole)})` : ""}`],
                            ["Catatan saat ini", koreksi.note || "–"],
                        ]} />
                        <FormField label="Catatan baru (opsional)" help="Terisi catatan saat ini. Bila dikosongkan, riwayat koreksi tercatat tanpa catatan.">
                            {(a) => <textarea {...a} className="fi-input" rows={2} value={catatan} onChange={(e) => setCatatan(e.target.value)} />}
                        </FormField>
                    </>
                )}
            </ConfirmDialog>
        </div>
    );
}
