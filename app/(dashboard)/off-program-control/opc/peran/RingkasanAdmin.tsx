/*
 * Tujuan: Kesehatan proses OFF Program Control untuk admin di Ringkasan (Fiori S4d) — port AdminHealthPanel old-opc.tsx 2363–2667:
 *   angka utama (pengajuan aktif, bottleneck terbesar, lewat batas klaim + tertahan 7+ hari), Butuh perhatian, Antrean per divisi
 *   (buildAdminQueueStats 848–893, kini membuka antrean divisi itu), Pengajuan bermasalah, dan Aktivitas terakhir.
 * Caller: opc/peran/Ringkasan.tsx (IkhtisarTahap, hanya peran admin).
 * Dependensi: opc/Bersama (kontrak), opc/peran/RingkasanPeriode (computeClaimComparison), components/fiori/core, lib/opc-ui, lib/promo-ui.
 * Main Functions: hitungAdmin, AngkaAdmin, ButuhPerhatian, BagianAdmin.
 * Side Effects: Tidak ada; navigasi lewat ctx (ubahUrl ke tab divisi, bukaBatch).
 */
"use client";

import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, Tile, type Column, type Tone } from "@/components/fiori/core";
import type { OffTab } from "@/lib/off-program-control/access";
import { PREDIKAT, infoTahap, waktuWita, type BatchOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import type { PeranProps } from "../Bersama";
import { computeClaimComparison } from "./RingkasanPeriode";

// ── Predikat lama yang belum ada di PREDIKAT (salinan apa adanya, nomor baris old-opc.tsx) ──────────────

/** isFinalClaimActionableBatch 795: sudah dibayar, verifikasi final belum selesai. */
const sudahBayarBelumFinal = (b: BatchOpc) => b.status === "Paid" && b.financeStatus === "Paid" && b.finalStatus !== "Completed";
/** isCompletedOrCancelledBatch 804. */
const selesaiAtauBatal = (b: BatchOpc) => b.status === "Completed" || b.finalStatus === "Completed" || b.finalStatus === "Fully Refunded"
    || b.status === "Cancelled" || b.omStatus === "Cancelled";
/** isReturnedOrCorrectionBatch 814. */
const dikembalikanAtauKoreksi = (b: BatchOpc) => b.status === "Returned by SM" || b.status === "Returned by Claim" || b.smStatus === "Returned"
    || b.claimStatus === "Returned" || b.financeStatus === "Need Correction";
/** batchTimestamp 824. */
function waktuBatch(b: BatchOpc) {
    const t = Date.parse(b.updatedAt || b.createdAt || b.claimSubmittedDate || b.paymentDate || "");
    return Number.isFinite(t) ? t : 0;
}
/** batchAgeDays 835: hari kalender sejak pembaruan terakhir. */
function umurHari(b: BatchOpc) {
    const t = waktuBatch(b);
    return t ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : 0;
}
/** isOverdueBatch 841: batas klaim lewat dan batch belum selesai/batal. */
function lewatBatasKlaim(b: BatchOpc) {
    if (!b.claimDeadline || selesaiAtauBatal(b)) return false;
    const d = Date.parse(b.claimDeadline);
    return Number.isFinite(d) && d < Date.now();
}

/** buildAdminQueueStats 848: antrean per divisi (predikat aksi kode lama) + tab tujuan. */
const DIVISI: Array<{ key: string; label: string; desc: string; antrean: (b: BatchOpc) => boolean; tab: OffTab; claimView?: string }> = [
    { key: "supervisor", label: "Supervisor", desc: "Pengajuan belum selesai atau perlu diperbaiki.", antrean: PREDIKAT.spvBisaUbah, tab: "supervisor" },
    { key: "sales", label: "Sales Manager", desc: "Menunggu diperiksa Sales Manager.", antrean: PREDIKAT.smAntrean, tab: "sales" },
    { key: "claim", label: "Klaim", desc: "Menunggu validasi klaim.", antrean: PREDIKAT.klaimAntrean, tab: "claim" },
    { key: "om", label: "Operational Manager", desc: "Menunggu persetujuan Operational Manager.", antrean: PREDIKAT.omAntrean, tab: "om" },
    { key: "finance", label: "Keuangan", desc: "Menunggu pembayaran.", antrean: PREDIKAT.keuanganBisaBayar, tab: "finance" },
    { key: "final", label: "Final Klaim", desc: "Sudah dibayar, menunggu konfirmasi dokumen akhir.", antrean: sudahBayarBelumFinal, tab: "claim", claimView: "after-finance" },
];

export type HitungAdmin = ReturnType<typeof hitungAdmin>;

/** Satu kali hitung untuk semua bagian admin (200 batch terbaru yang dimuat, sama dengan kode lama). */
export function hitungAdmin(batches: BatchOpc[]) {
    const divisi = DIVISI.map((d) => ({ ...d, n: batches.filter(d.antrean).length }));
    const bottleneck = [...divisi].sort((a, b) => b.n - a.n)[0];
    const aktif = batches.filter((b) => !selesaiAtauBatal(b));
    const lewat = batches.filter(lewatBatasKlaim);
    const tertahan = aktif.filter((b) => umurHari(b) >= 7);
    const bayarBelumFinal = batches.filter(sudahBayarBelumFinal);
    const kembali = batches.filter(dikembalikanAtauKoreksi);
    return { divisi, bottleneck, aktif, lewat, tertahan, bayarBelumFinal, kembali, banding: computeClaimComparison(batches) };
}

/** Angka utama (Admin Overview lama). */
export function AngkaAdmin({ h }: { h: HitungAdmin }) {
    return (
        <div className="fi-kcards" role="group" aria-label="Kesehatan proses">
            <div className="fi-kc"><span>Pengajuan aktif</span><b>{h.aktif.length}</b><small>belum selesai atau dibatalkan</small></div>
            <div className="fi-kc"><span>Bottleneck terbesar</span><b>{h.bottleneck?.n || 0}</b><small>{h.bottleneck?.n ? `menunggu ${h.bottleneck.label}` : "Tidak ada"}</small></div>
            <div className="fi-kc" data-tone={h.lewat.length ? "neg" : undefined}><span>Lewat batas klaim</span><b>{h.lewat.length}</b><small>{h.tertahan.length} tertahan 7+ hari</small></div>
        </div>
    );
}

/** Butuh perhatian (attentionItems lama, tanpa butir "Data gagal dimuat": galat kini punya keadaan sendiri). */
export function ButuhPerhatian({ h }: { h: HitungAdmin }) {
    const perhatian: Array<{ judul: string; ket: string; n: number; tone: Tone }> = [
        ...(h.lewat.length ? [{ judul: "Lewat batas klaim", ket: "Deadline klaim sudah lewat.", n: h.lewat.length, tone: "neg" as const }] : []),
        ...(h.tertahan.length ? [{ judul: "Terlalu lama diproses", ket: "Aktif dan tidak berubah 7 hari atau lebih.", n: h.tertahan.length, tone: "warn" as const }] : []),
        ...(h.bayarBelumFinal.length ? [{ judul: "Sudah dibayar, belum final", ket: "Menunggu verifikasi final Klaim.", n: h.bayarBelumFinal.length, tone: "info" as const }] : []),
        ...(h.banding.submittedCount > 0 && !h.banding.isMatched
            ? [{ judul: "Pengajuan dan klaim belum sesuai", ket: `Selisih ${rupiah(Math.abs(h.banding.difference))} dari ${h.banding.submittedCount} pengajuan.`, n: h.banding.submittedCount, tone: "warn" as const }] : []),
        ...(h.bottleneck && h.bottleneck.n > 0 ? [{ judul: "Bottleneck terbesar", ket: h.bottleneck.label, n: h.bottleneck.n, tone: "info" as const }] : []),
    ];
    return (
        <Section title="Butuh perhatian" subtitle={`${perhatian.length} hal`}>
            {perhatian.length === 0
                ? <div className="fi-sect-in"><MessageStrip tone="pos" title="Tidak ada masalah prioritas">pada data yang sedang dimuat.</MessageStrip></div>
                : (
                    <ul className="fi-hist" aria-label="Butuh perhatian">
                        {perhatian.map((p) => (
                            <li key={p.judul}>
                                <time><StatusBadge tone={p.tone}>{p.n}</StatusBadge></time>
                                <span><b>{p.judul}</b> · {p.ket}</span>
                            </li>
                        ))}
                    </ul>
                )}
        </Section>
    );
}

type Masalah = { b: BatchOpc; ket: string };

/** Antrean per divisi, Pengajuan bermasalah, Aktivitas terakhir (di bawah antrean per tahap). */
export function BagianAdmin({ ctx, daftar, h }: PeranProps & { h: HitungAdmin }) {
    // Urutan dan batas kode lama (problemBatches 2383): gabungan unik, terbaru dulu, enam teratas.
    const peta = new Map<string, Masalah>();
    const tambah = (rows: BatchOpc[], ket: (b: BatchOpc) => string) => { for (const b of rows) if (!peta.has(b.id)) peta.set(b.id, { b, ket: ket(b) }); };
    tambah(h.lewat, () => "Lewat batas klaim");
    tambah(h.tertahan, (b) => `Tertahan ${umurHari(b)} hari`);
    tambah(h.bayarBelumFinal, () => "Dibayar, belum final");
    tambah(h.kembali, (b) => (b.financeStatus === "Need Correction" ? "Perlu koreksi bayar" : "Dikembalikan"));
    const bermasalah = [...peta.values()].sort((a, b) => waktuBatch(b.b) - waktuBatch(a.b)).slice(0, 6);
    const terakhir = [...daftar.batches].sort((a, b) => waktuBatch(b) - waktuBatch(a)).slice(0, 5);

    const bukaDivisi = (d: (typeof DIVISI)[number]) => ctx.ubahUrl({ tab: d.tab, view: null, batch: null, claimView: d.claimView ?? null });
    const kolomMasalah: Column<Masalah>[] = [
        { key: "no", header: "No pengajuan", cell: ({ b }) => <><span className="fi-mono">{b.noPengajuan}</span><span className="fi-sub">{b.supervisorName || "–"}</span></> },
        { key: "principal", header: "Principal", secondary: true, cell: ({ b }) => b.principleName || "–" },
        { key: "noklaim", header: "No klaim", secondary: true, cell: ({ b }) => (b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : "–") },
        { key: "tahap", header: "Tahap", cell: ({ b }) => { const i = infoTahap(b); return <StatusBadge tone={i.tone}>{i.label}</StatusBadge>; } },
        { key: "ket", header: "Keterangan", cell: (m) => m.ket },
        { key: "buka", header: "Batch", cell: ({ b }) => <Button variant="tertiary" onClick={() => ctx.bukaBatch(b.id)}>Buka</Button> },
    ];
    return (
        <>
            <Section title="Antrean per divisi" subtitle="aksi yang menunggu tiap divisi; ubin membuka antreannya">
                <div className="fi-sect-in">
                    <div className="fi-tiles" role="group" aria-label="Antrean per divisi">
                        {h.divisi.map((d) => <Tile key={d.key} title={d.label} subtitle={d.desc} value={d.n} onClick={() => bukaDivisi(d)} footer="Buka antrean" />)}
                    </div>
                </div>
            </Section>
            <Section title="Pengajuan bermasalah" subtitle="lewat batas klaim, tertahan 7+ hari, dibayar belum final, dikembalikan">
                <ResponsiveTable title="Pengajuan bermasalah" count={bermasalah.length} columns={kolomMasalah} rows={bermasalah} rowKey={(m) => m.b.id}
                    empty={{ title: "Tidak ada pengajuan bermasalah" }}
                    mobileItem={(m) => { const i = infoTahap(m.b); return <ListItem doc={m.b.noPengajuan} title={m.b.principleName} meta={m.ket} badge={<StatusBadge tone={i.tone}>{i.label}</StatusBadge>} onClick={() => ctx.bukaBatch(m.b.id)} />; }} />
            </Section>
            <Section title="Aktivitas terakhir" subtitle="5 batch yang terakhir berubah">
                <ul className="fi-list" style={{ display: "block" }} aria-label="Aktivitas terakhir">
                    {terakhir.map((b) => {
                        const i = infoTahap(b);
                        return (
                            <li key={b.id}>
                                <ListItem doc={b.noPengajuan} title={b.principleName} meta={waktuWita(b.updatedAt || b.createdAt)}
                                    badge={<StatusBadge tone={i.tone}>{i.label}</StatusBadge>} onClick={() => ctx.bukaBatch(b.id)} />
                            </li>
                        );
                    })}
                </ul>
            </Section>
        </>
    );
}
