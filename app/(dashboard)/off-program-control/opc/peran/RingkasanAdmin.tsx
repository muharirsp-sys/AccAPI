/*
 * Tujuan: Kesehatan proses OFF Program Control untuk admin di Ringkasan (Fiori S4d), port AdminHealthPanel kode lama: angka ringkas
 *   (pengajuan aktif, antrean terpanjang, lewat batas klaim + tertahan 7+ hari) sebagai daftar label-nilai, Butuh perhatian (hitungan per
 *   kelompok + tabel "Perlu ditinjau admin"), Antrean per divisi (buildAdminQueueStats kode lama, membuka antrean divisi itu), dan
 *   Aktivitas terakhir.
 * Caller: opc/peran/Ringkasan.tsx (IkhtisarTahap, hanya peran admin dan manager).
 * Dependensi: opc/Bersama (kontrak), opc/peran/RingkasanPeriode (computeClaimComparison), components/fiori/core, lib/opc-ui, lib/promo-ui,
 *   lib/tampil (KOSONG).
 * Main Functions: hitungAdmin, AngkaAdmin, ButuhPerhatian, BagianAdmin.
 * Side Effects: Tidak ada; navigasi lewat ctx (ubahUrl ke tab divisi, bukaBatch).
 */
"use client";

import { KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, Tile, type Column, type Tone } from "@/components/fiori/core";
import type { OffTab } from "@/lib/off-program-control/access";
import { PREDIKAT, infoTahap, waktuWita, type BatchOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { TautanBatch, type PeranProps } from "../Bersama";
import { computeClaimComparison } from "./RingkasanPeriode";

// Predikat kode lama yang belum ada di PREDIKAT (salinan apa adanya).

/** isFinalClaimActionableBatch: sudah dibayar, verifikasi final belum selesai. */
const sudahBayarBelumFinal = (b: BatchOpc) => b.status === "Paid" && b.financeStatus === "Paid" && b.finalStatus !== "Completed";
/** isCompletedOrCancelledBatch. */
const selesaiAtauBatal = (b: BatchOpc) => b.status === "Completed" || b.finalStatus === "Completed" || b.finalStatus === "Fully Refunded"
    || b.status === "Cancelled" || b.omStatus === "Cancelled";
/** isReturnedOrCorrectionBatch. */
const dikembalikanAtauKoreksi = (b: BatchOpc) => b.status === "Returned by SM" || b.status === "Returned by Claim" || b.smStatus === "Returned"
    || b.claimStatus === "Returned" || b.financeStatus === "Need Correction";
/** batchTimestamp. */
function waktuBatch(b: BatchOpc) {
    const t = Date.parse(b.updatedAt || b.createdAt || b.claimSubmittedDate || b.paymentDate || "");
    return Number.isFinite(t) ? t : 0;
}
/** batchAgeDays: hari kalender sejak pembaruan terakhir. */
function umurHari(b: BatchOpc) {
    const t = waktuBatch(b);
    return t ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : 0;
}
/** isOverdueBatch: batas klaim lewat dan batch belum selesai/batal. */
function lewatBatasKlaim(b: BatchOpc) {
    if (!b.claimDeadline || selesaiAtauBatal(b)) return false;
    const d = Date.parse(b.claimDeadline);
    return Number.isFinite(d) && d < Date.now();
}

/** buildAdminQueueStats: antrean per divisi (predikat aksi kode lama) + tab tujuan. */
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

/** Angka utama (Admin Overview kode lama) sebagai daftar label-nilai; angka inti halaman ini ada di ubin per tahap. */
export function AngkaAdmin({ h }: { h: HitungAdmin }) {
    const nilai = (n: number, ket: string) => <span className="fi-tnum">{n}<span className="fi-sub">{ket}</span></span>;
    return (
        <Section title="Kesehatan proses">
            <div className="fi-sect-in" role="group" aria-label="Kesehatan proses" style={{ maxWidth: "36rem" }}>
                <KeyValues items={[
                    ["Pengajuan aktif", nilai(h.aktif.length, "belum selesai atau dibatalkan")],
                    ["Antrean terpanjang", nilai(h.bottleneck?.n || 0, h.bottleneck?.n ? `menunggu ${h.bottleneck.label}` : "Tidak ada")],
                    ["Lewat batas klaim", h.lewat.length
                        ? <span className="fi-tnum"><StatusBadge tone="neg">{h.lewat.length}</StatusBadge><span className="fi-sub">{h.tertahan.length} tertahan 7+ hari</span></span>
                        : nilai(0, `${h.tertahan.length} tertahan 7+ hari`)],
                ]} />
            </div>
        </Section>
    );
}

type Masalah = { b: BatchOpc; ket: string };

/**
 * Butuh perhatian (attentionItems kode lama, tanpa butir "Data gagal dimuat": galat punya keadaan sendiri) digabung dengan tabel
 * "Perlu ditinjau admin" (problemBatches kode lama: gabungan unik, terbaru dulu, enam teratas). Nama berbeda dari lonceng Lewat SLA.
 */
export function ButuhPerhatian({ ctx, h }: PeranProps & { h: HitungAdmin }) {
    const perhatian: Array<{ judul: string; ket: string; n: number; tone: Tone }> = [
        ...(h.lewat.length ? [{ judul: "Lewat batas klaim", ket: "Deadline klaim sudah lewat.", n: h.lewat.length, tone: "neg" as const }] : []),
        ...(h.tertahan.length ? [{ judul: "Terlalu lama diproses", ket: "Aktif dan tidak berubah 7 hari atau lebih.", n: h.tertahan.length, tone: "warn" as const }] : []),
        ...(h.bayarBelumFinal.length ? [{ judul: "Sudah dibayar, belum final", ket: "Menunggu verifikasi final Klaim.", n: h.bayarBelumFinal.length, tone: "info" as const }] : []),
        ...(h.banding.submittedCount > 0 && !h.banding.isMatched
            ? [{ judul: "Pengajuan dan klaim belum sesuai", ket: `Selisih ${rupiah(Math.abs(h.banding.difference))} dari ${h.banding.submittedCount} pengajuan.`, n: h.banding.submittedCount, tone: "warn" as const }] : []),
        ...(h.bottleneck && h.bottleneck.n > 0 ? [{ judul: "Antrean terpanjang", ket: h.bottleneck.label, n: h.bottleneck.n, tone: "info" as const }] : []),
    ];
    // Urutan dan batas kode lama (problemBatches): gabungan unik, terbaru dulu, enam teratas; jumlah penuh disebut di subjudul.
    const peta = new Map<string, Masalah>();
    const tambah = (rows: BatchOpc[], ket: (b: BatchOpc) => string) => { for (const b of rows) if (!peta.has(b.id)) peta.set(b.id, { b, ket: ket(b) }); };
    tambah(h.lewat, () => "Lewat batas klaim");
    tambah(h.tertahan, (b) => `Tertahan ${umurHari(b)} hari`);
    tambah(h.bayarBelumFinal, () => "Dibayar, belum final");
    tambah(h.kembali, (b) => (b.financeStatus === "Need Correction" ? "Perlu koreksi bayar" : "Dikembalikan"));
    const bermasalah = [...peta.values()].sort((a, b) => waktuBatch(b.b) - waktuBatch(a.b)).slice(0, 6);
    const kolomMasalah: Column<Masalah>[] = [
        { key: "no", header: "No pengajuan", cell: ({ b }) => <><span className="fi-mono">{b.noPengajuan}</span><span className="fi-sub">{b.supervisorName || KOSONG}</span></> },
        { key: "principal", header: "Principal", secondary: true, cell: ({ b }) => b.principleName || KOSONG },
        { key: "noklaim", header: "No klaim", secondary: true, cell: ({ b }) => (b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : KOSONG) },
        { key: "tahap", header: "Tahap", cell: ({ b }) => { const i = infoTahap(b); return <StatusBadge tone={i.tone}>{i.label}</StatusBadge>; } },
        { key: "ket", header: "Keterangan", cell: (m) => m.ket },
        { key: "buka", header: "Batch", cell: ({ b }) => <TautanBatch ctx={ctx} id={b.id} label={`Buka ${b.noPengajuan}`}>Buka</TautanBatch> },
    ];
    return (
        <Section title="Butuh perhatian" subtitle={`${perhatian.length} hal`}>
            {perhatian.length === 0
                ? <div className="fi-sect-in"><MessageStrip tone="pos" title="Tidak ada masalah prioritas">pada data yang sedang dimuat.</MessageStrip></div>
                : (
                    <ul className="fi-hist" aria-label="Butuh perhatian">
                        {perhatian.map((p) => (
                            <li key={p.judul}>
                                <span><StatusBadge tone={p.tone}>{p.n}</StatusBadge></span>
                                <span><b>{p.judul}</b> · {p.ket}</span>
                            </li>
                        ))}
                    </ul>
                )}
            <div className="fi-sect-in" style={{ paddingBottom: 0 }}>
                <h3 className="fi-caption">
                    Perlu ditinjau admin{peta.size > bermasalah.length ? `: ${bermasalah.length} teratas dari ${peta.size}` : ""}
                </h3>
                <p className="fi-small fi-subtle">Lewat batas klaim, tertahan 7+ hari, dibayar belum final, atau dikembalikan; terbaru dulu.</p>
            </div>
            <ResponsiveTable title="Perlu ditinjau admin" count={bermasalah.length} columns={kolomMasalah} rows={bermasalah} rowKey={(m) => m.b.id}
                empty={{ title: "Tidak ada pengajuan yang perlu ditinjau" }}
                mobileItem={(m) => { const i = infoTahap(m.b); return <ListItem doc={m.b.noPengajuan} title={m.b.principleName} meta={m.ket} badge={<StatusBadge tone={i.tone}>{i.label}</StatusBadge>} href={ctx.hrefBatch(m.b.id)} onClick={() => ctx.bukaBatch(m.b.id)} />; }} />
        </Section>
    );
}

/** Antrean per divisi dan Aktivitas terakhir (di bawah antrean per tahap). */
export function BagianAdmin({ ctx, daftar, h }: PeranProps & { h: HitungAdmin }) {
    const terakhir = [...daftar.batches].sort((a, b) => waktuBatch(b) - waktuBatch(a)).slice(0, 5);
    const bukaDivisi = (d: (typeof DIVISI)[number]) => ctx.ubahUrl({ tab: d.tab, view: null, batch: null, claimView: d.claimView ?? null });
    return (
        <>
            <Section title="Antrean per divisi" subtitle="aksi yang menunggu tiap divisi; ubin membuka antreannya">
                <div className="fi-sect-in">
                    <div className="fi-tiles" role="group" aria-label="Antrean per divisi">
                        {h.divisi.map((d) => <Tile key={d.key} title={d.label} subtitle={d.desc} value={d.n} onClick={() => bukaDivisi(d)} footer="Buka antrean" />)}
                    </div>
                </div>
            </Section>
            <Section title="Aktivitas terakhir" subtitle="5 batch yang terakhir berubah">
                <ul className="fi-list" style={{ display: "block" }} aria-label="Aktivitas terakhir">
                    {terakhir.map((b) => {
                        const i = infoTahap(b);
                        return (
                            <li key={b.id}>
                                <ListItem doc={b.noPengajuan} title={b.principleName} meta={waktuWita(b.updatedAt || b.createdAt)}
                                    badge={<StatusBadge tone={i.tone}>{i.label}</StatusBadge>} href={ctx.hrefBatch(b.id)} onClick={() => ctx.bukaBatch(b.id)} />
                            </li>
                        );
                    })}
                </ul>
            </Section>
        </>
    );
}
