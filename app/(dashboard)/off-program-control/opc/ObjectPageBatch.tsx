/*
 * Tujuan: Object Page batch OPC (kolom kedua FCL, Fiori S4d): header (nomor, principal, periode, total, badge tahap, Flow 7 tahap,
 *   tanda lewat SLA), AnchorBar, dan bagian BACA bersama (Item, Validasi klaim, Pembayaran dan refund, Riwayat dengan alasan setuju
 *   sendiri + enam sumbu status, Alur dokumen), strip hasil tidak pasti dari KolomDetail, plus slot modul peran (bagian, gantiItem,
 *   strip, aksi, pesanFooter, draf).
 * Caller: opc/Bersama.tsx (DetailBacaSaja) dan komponen Detail di opc/peran/*.tsx. Cara pakai: header opc/Bersama.tsx.
 * Dependensi: components/fiori/core, lib/opc-ui, lib/promo-ui (rupiah), lib/claim-workflow-ui (statusKlaim), lib/tampil (KOSONG), next/link.
 * Main Functions: ObjectPageBatch, BagianTambahan.
 * Side Effects: Tidak ada; muat ulang lewat callback `muatUlang`.
 */
"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section,
    Skeleton, StatusBadge, type Column,
} from "@/components/fiori/core";
import { statusKlaim } from "@/lib/claim-workflow-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import {
    alurBatch, catatanSendiri, infoTahap, jumlahItem, kelengkapanItem, labelAksiAudit, labelPeranAktor, labelStatus, pdfBoleh, periodeBatch, tahapBatch, tanggalOpc, totalBatch,
    waktuWita, type AuditOpc, type BatchOpc, type ItemOpc, type PembayaranOpc, type RefundOpc,
} from "@/lib/opc-ui";
import type { DetailProps } from "./Bersama";

export type BagianTambahan = { id: string; label: string; isi: ReactNode; letak?: "awal" | "setelahItem" | "akhir" };

export type ObjectPageBatchProps = DetailProps & {
    bagian?: BagianTambahan[];
    /** Pengganti isi bagian Item (mode ubah SPV). */
    gantiItem?: ReactNode;
    /** Pesan khusus peran di bawah header. */
    strip?: ReactNode;
    /** Isi FooterToolbar; tanpa ini tidak ada footer. */
    aksi?: ReactNode;
    pesanFooter?: ReactNode;
    draf?: boolean;
};

// Jejak halaman cukup satu (kepala halaman OPC); Object Page di kolom kedua tidak mengulangnya dan judulnya h2 (halaman punya h1, No 141).
// Batasan sistem di bagian baca tampil sebagai keterangan biasa; catatan varian (Admin) satu per layar milik modul peran (No 80).
export function ObjectPageBatch(props: ObjectPageBatchProps) {
    const { ringkas, detail, muatUlang, masalah, bagian = [], gantiItem, strip, aksi, pesanFooter, draf, tidakPasti, tutupTidakPasti } = props;
    // Hasil tulis tidak pasti (KolomDetail): bertahan walau dialog ditutup dan detail dimuat ulang.
    const stripTidakPasti = tidakPasti
        ? <MessageStrip tone="warn" title="Hasil aksi terakhir belum pasti." onClose={tutupTidakPasti}>{tidakPasti}</MessageStrip>
        : null;
    if (!detail.data) {
        return (
            <div style={{ display: "grid", gap: 12 }}>
                <ObjectPageHeader headingLevel={2} title={ringkas?.noPengajuan ? <span className="fi-mono">{ringkas.noPengajuan}</span> : "Batch"}
                    status={ringkas ? <StatusBadge tone={infoTahap(ringkas).tone}>{infoTahap(ringkas).label}</StatusBadge> : undefined} />
                {stripTidakPasti && <div style={{ padding: "0 12px" }}>{stripTidakPasti}</div>}
                {detail.status === "galat"
                    ? <ErrorState title="Detail batch gagal dimuat" message={detail.error} onRetry={muatUlang} />
                    : <div style={{ padding: "0 16px" }}><Skeleton rows={6} label="Memuat detail batch" /></div>}
            </div>
        );
    }

    const { items, payments, paymentSummary, refund, audit, uji } = detail.data;
    const b: BatchOpc = detail.data.batch;
    const terlambat = masalah.length > 0;
    const info = infoTahap(b, terlambat);
    const total = Number(detail.data.summary?.totalNominal ?? totalBatch(b));
    const nItem = items.length || jumlahItem(b);
    const tahap = tahapBatch(b);
    const catatanKembali = b.claimNote || b.smNote || b.returnNote;
    const di = (letak: NonNullable<BagianTambahan["letak"]>) => bagian.filter((x) => (x.letak ?? "setelahItem") === letak);
    const anchors = [
        ...di("awal"),
        { id: "opc-item", label: "Item" },
        ...di("setelahItem"),
        { id: "opc-validasi", label: "Validasi klaim" },
        { id: "opc-bayar", label: "Pembayaran" },
        { id: "opc-riwayat", label: "Riwayat" },
        { id: "opc-alur", label: "Alur dokumen" },
        ...di("akhir"),
    ].map(({ id, label }) => ({ id, label }));
    const tampilBagian = (xs: BagianTambahan[]) => xs.map((x) => <Section key={x.id} id={x.id} title={x.label}>{x.isi}</Section>);

    return (
        <div className={detail.status === "memuat" ? "fi-busy" : undefined} style={{ display: "grid", gap: 12 }} aria-busy={detail.status === "memuat" || undefined}>
            <ObjectPageHeader
                headingLevel={2}
                title={<span className="fi-mono">{b.noPengajuan}</span>}
                status={<StatusBadge tone={info.tone}>{info.label}</StatusBadge>}
                draft={draf}
                attributes={[
                    { label: "Principal", value: <>{b.principleName} <span className="fi-mono">({b.principleCode})</span></> },
                    { label: "Periode", value: periodeBatch(b) },
                    { label: "Total", value: <span className="fi-tnum">{rupiah(total)}</span> },
                    { label: "Item", value: <span className="fi-tnum">{nItem}</span> },
                    { label: b.createdByRole === "claim" ? "Dibuat Klaim" : "SPV", value: b.supervisorName || KOSONG },
                    { label: "Pemilik tahap", value: info.pemilik ?? KOSONG },
                    { label: "Diperbarui", value: waktuWita(b.updatedAt) },
                ]}
                flow={
                    <>
                        <Flow steps={alurBatch(b, terlambat)} label="Tahap batch" />
                        {terlambat && (
                            <MessageStrip tone="warn" title={`Lewat SLA: ${masalah[0].title}.`}>
                                {masalah[0].message}{masalah.length > 1 ? ` Ada ${masalah.length - 1} peringatan lain untuk batch ini.` : ""}
                            </MessageStrip>
                        )}
                    </>
                }
            />
            <AnchorBar anchors={anchors} />
            <div style={{ display: "grid", gap: 12, padding: "0 12px 12px" }}>
                {detail.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang detail.">
                        {detail.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button>
                    </MessageStrip>
                )}
                {uji && <MessageStrip tone="info" title="Data uji (mock).">Item, pembayaran, dan riwayat tidak dimuat dari server untuk batch sintetis.</MessageStrip>}
                {tahap === "dikembalikan" && (
                    <MessageStrip tone="neg" title={`${info.label}:`}>{catatanKembali || "Tanpa catatan pengembalian."}</MessageStrip>
                )}
                {tahap === "dibatalkan" && <MessageStrip tone="neg" title="Dibatalkan:">{b.cancelNote || b.omNote || "Tanpa catatan pembatalan."}</MessageStrip>}
                {stripTidakPasti}
                {strip}
                {tampilBagian(di("awal"))}
                <Section id="opc-item" title="Item" subtitle={`${nItem} item · ${rupiah(total)}`}>
                    {gantiItem ?? <TabelItem items={items} uji={uji} />}
                </Section>
                {tampilBagian(di("setelahItem"))}
                <Section id="opc-validasi" title="Validasi klaim" subtitle="diisi Klaim setelah SM menyetujui">
                    <div className="fi-sect-in">
                        <KeyValues items={[
                            ["Diajukan ke principal", tanggalOpc(b.claimSubmittedDate)],
                            ["Deadline klaim", tanggalOpc(b.claimDeadline)],
                            ["No Claim", b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : "Belum ada"],
                            ["Kelengkapan berkas", b.completenessStatus || "Belum tercatat"],
                            ["Catatan SM", b.smNote || KOSONG],
                            ["Catatan Klaim", b.claimNote || KOSONG],
                            ["Catatan OM", b.omNote || KOSONG],
                            ["Catatan verifikasi final", b.finalClaimNote || KOSONG],
                        ]} />
                        {/* BL-11: perilaku hari ini, keterangan biasa (satu catatan varian per layar, audit No 80). */}
                        <p className="fi-small fi-subtle">Kelengkapan yang dipilih Klaim saat menyetujui belum tersimpan di batch, jadi di sini tampil &quot;Belum tercatat&quot;.</p>
                    </div>
                </Section>
                <Section id="opc-bayar" title="Pembayaran dan refund">
                    <BagianBayar total={total} payments={payments} totalPaid={paymentSummary?.totalPaid ?? Number(b.paidAmount ?? 0)}
                        sisa={paymentSummary?.remainingAmount ?? Math.max(0, total - Number(b.paidAmount ?? 0))} refund={refund} muatUlang={muatUlang} />
                </Section>
                <Section id="opc-riwayat" title="Riwayat" subtitle="log aksi batch">
                    <BagianRiwayat audit={audit} b={b} muatUlang={muatUlang} />
                </Section>
                <Section id="opc-alur" title="Alur dokumen">
                    <div className="fi-dflow">
                        <span className="fi-dnode"><b className="fi-mono">{b.noPengajuan}</b><span>OFF Program Control · {info.label}</span></span>
                        <ChevronRight className="fi-icon" aria-hidden />
                        {(b.claimWorkflowId ?? ringkas?.claimWorkflowId)
                            ? <Link className="fi-dnode" href={`/claim-workflow/${encodeURIComponent(String(b.claimWorkflowId ?? ringkas?.claimWorkflowId))}`}>
                                <b>Claim Workflow</b><span>{statusKlaim(b.claimWorkflowStatus ?? ringkas?.claimWorkflowStatus).label}</span>
                            </Link>
                            : <span className="fi-dnode" data-off="true"><b>Claim Workflow</b><span>{["bayar", "final", "selesai"].includes(tahap) ? "belum dibuat" : "dibuat setelah OM menyetujui"}</span></span>}
                        <ChevronRight className="fi-icon" aria-hidden />
                        <span className="fi-dnode" data-off={payments.length ? undefined : "true"}>
                            <b>Pembayaran Keuangan</b><span>{payments.length ? `${payments.length} kali · ${rupiah(paymentSummary?.totalPaid ?? 0)}` : "belum ada"}</span>
                        </span>
                        {pdfBoleh(b, props.ctx.peran, props.ctx.tab) && (
                            <>
                                <ChevronRight className="fi-icon" aria-hidden />
                                <a className="fi-dnode" href={b.pdfUrl ?? undefined} target="_blank" rel="noreferrer"><b>PDF surat pengajuan</b><span>buka di tab baru</span></a>
                            </>
                        )}
                    </div>
                    <div className="fi-sect-in" style={{ paddingTop: 0 }}>
                        {/* BL-35 */}
                        <p className="fi-small fi-subtle">Tautan ke Claim Workflow muncul setelah klaimnya dibuat. Pembayaran belum bisa ditelusuri balik ke batch ini.</p>
                    </div>
                </Section>
                {tampilBagian(di("akhir"))}
            </div>
            {aksi && <FooterToolbar message={pesanFooter}>{aksi}</FooterToolbar>}
        </div>
    );
}

/** Daftar item berlabel; di ponsel/kolom sempit menjadi daftar (bukan grid 18 kolom). */
function TabelItem({ items, uji }: { items: ItemOpc[]; uji: boolean }) {
    const dibayar = (i: ItemOpc) => i.financePaymentStatus === "paid";
    const kolom: Column<ItemOpc>[] = [
        { key: "surat", header: "No Surat · program", cell: (i) => <><span className="fi-mono">{i.noSurat || KOSONG}</span><br />{i.namaProgram || KOSONG}</> },
        { key: "toko", header: "Toko", cell: (i) => i.toko || KOSONG },
        { key: "nominal", header: "Nominal", align: "end", cell: (i) => <span className="fi-tnum">{rupiah(i.nominal)}</span> },
        { key: "bayar", header: "Cara bayar", secondary: true, cell: (i) => i.caraBayar || KOSONG },
        { key: "no", header: "Item ke", secondary: true, cell: (i) => <span className="fi-tnum">{i.itemNo}</span> },
        { key: "tipe", header: "Tipe", secondary: true, cell: (i) => i.type || KOSONG },
        { key: "periode", header: "Periode", secondary: true, cell: (i) => i.periode || KOSONG },
        { key: "deadline", header: "Deadline", secondary: true, cell: (i) => tanggalOpc(i.deadline) },
        { key: "lengkap", header: "Kelengkapan awal", secondary: true, cell: (i) => kelengkapanItem(i) },
        { key: "status", header: "Keuangan", secondary: true, cell: (i) => (dibayar(i) ? <StatusBadge tone="pos">Dibayar</StatusBadge> : "Belum dibayar") },
    ];
    return (
        <ResponsiveTable title="Item batch" columns={kolom} rows={items} rowKey={(i) => i.id}
            empty={{ title: uji ? "Item tidak dimuat untuk data uji" : "Batch ini tidak punya item" }}
            mobileItem={(i) => (
                <ListItem doc={i.noSurat || `Item ${i.itemNo}`} amount={rupiah(i.nominal)} title={i.toko || KOSONG}
                    meta={[i.namaProgram, i.caraBayar, i.type].filter(Boolean).join(" · ")}
                    badge={dibayar(i) ? <StatusBadge tone="pos">Dibayar</StatusBadge> : undefined} />
            )} />
    );
}

function BagianBayar({ total, payments, totalPaid, sisa, refund, muatUlang }: {
    total: number; payments: PembayaranOpc[]; totalPaid: number; sisa: number; refund: NonNullable<DetailProps["detail"]["data"]>["refund"]; muatUlang: () => void;
}) {
    const kolom: Column<PembayaranOpc>[] = [
        { key: "no", header: "Pembayaran", cell: (p) => <span className="fi-tnum">Ke-{p.paymentNo}</span> },
        { key: "tgl", header: "Tanggal", cell: (p) => tanggalOpc(p.paymentDate) },
        { key: "metode", header: "Cara bayar", cell: (p) => p.paymentMethod || KOSONG },
        { key: "jumlah", header: "Jumlah", align: "end", cell: (p) => <span className="fi-tnum">{rupiah(p.paidAmount)}</span> },
        { key: "bank", header: "Bank pengirim", secondary: true, cell: (p) => p.senderBank || p.paymentSenderBank || KOSONG },
        { key: "bukti", header: "Bukti", secondary: true, cell: (p) => (p.proofUrl ? <a href={p.proofUrl} target="_blank" rel="noreferrer">{p.paymentProofName || "Buka bukti"}</a> : KOSONG) },
        { key: "catatan", header: "Catatan", secondary: true, cell: (p) => p.note || KOSONG },
    ];
    const r = refund.data;
    const kolomRefund: Column<RefundOpc>[] = [
        { key: "no", header: "Pengembalian", cell: (x) => <span className="fi-tnum">Ke-{x.refundNo}</span> },
        { key: "tgl", header: "Tanggal", cell: (x) => tanggalOpc(x.refundDate) },
        { key: "jumlah", header: "Jumlah", align: "end", cell: (x) => <span className="fi-tnum">{rupiah(x.refundAmount)}</span> },
        { key: "status", header: "Status", cell: (x) => <StatusBadge tone={x.status === "Verified" ? "pos" : x.status === "Rejected" ? "neg" : "warn"}>{labelStatus(x.status)}</StatusBadge> },
        { key: "cara", header: "Cara", secondary: true, cell: (x) => x.refundMethod || KOSONG },
        { key: "pengirim", header: "Pengirim", secondary: true, cell: (x) => x.senderName || KOSONG },
        // Sama dengan RefundPanel kode lama: catatan pengajuan, bila kosong catatan verifikasi.
        { key: "catatan", header: "Catatan", secondary: true, cell: (x) => x.note || x.verificationNote || KOSONG },
    ];
    return (
        <>
            <div className="fi-sect-in">
                <KeyValues items={[["Total diajukan", rupiah(total)], ["Sudah dibayar", rupiah(totalPaid)], ["Sisa", rupiah(sisa)]]} />
            </div>
            <ResponsiveTable title="Riwayat pembayaran" columns={kolom} rows={payments} rowKey={(p) => p.id}
                empty={{ title: "Belum ada pembayaran", message: "Keuangan mencatat pembayaran setelah OM menyetujui." }}
                mobileItem={(p) => <ListItem doc={`Pembayaran ke-${p.paymentNo}`} amount={rupiah(p.paidAmount)} title={tanggalOpc(p.paymentDate)}
                    meta={[p.paymentMethod, p.senderBank || p.paymentSenderBank, p.note].filter(Boolean).join(" · ")} />} />
            <div className="fi-sect-in">
                {/* BL-07 */}
                <p className="fi-small fi-subtle">Bukti yang bisa dibuka adalah PDF ringkasan pembayaran buatan sistem; lampiran bank yang diunggah tidak disimpan.</p>
                <h3 className="fi-caption">Pengembalian selisih</h3>
                {refund.status === "memuat" && !r ? <Skeleton rows={2} label="Memuat pengembalian selisih" />
                    : refund.status === "galat" && !r ? (
                        <MessageStrip tone="neg" title="Pengembalian selisih gagal dimuat.">
                            {refund.error} Ini bukan berarti tidak ada selisih. <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button>
                        </MessageStrip>
                    ) : r && (r.summary?.overpaidAmount ?? 0) <= 0 && r.refunds.length === 0 ? (
                        <p className="fi-small fi-subtle">Tidak ada selisih yang perlu dikembalikan.</p>
                    ) : r && (
                        <KeyValues items={[
                            ["Kelebihan dana", rupiah(r.summary?.overpaidAmount ?? 0)],
                            ["Sudah dikembalikan", rupiah(r.summary?.totalRefunded ?? 0)],
                            ["Menunggu verifikasi", rupiah(r.summary?.pendingRefund ?? 0)],
                            ["Sisa harus dikembalikan", rupiah(r.summary?.remainingRefund ?? 0)],
                        ]} />
                    )}
            </div>
            {r && r.refunds.length > 0 && (
                <ResponsiveTable title="Riwayat pengembalian" columns={kolomRefund} rows={r.refunds} rowKey={(x) => x.id} empty={{ title: "Belum ada pengembalian" }}
                    mobileItem={(x) => <ListItem doc={`Pengembalian ke-${x.refundNo}`} amount={rupiah(x.refundAmount)} title={tanggalOpc(x.refundDate)}
                        meta={[x.refundMethod, x.senderName && `Pengirim ${x.senderName}`, x.note || x.verificationNote].filter(Boolean).join(" · ")}
                        badge={<StatusBadge tone={x.status === "Verified" ? "pos" : x.status === "Rejected" ? "neg" : "warn"}>{labelStatus(x.status)}</StatusBadge>} />} />
            )}
        </>
    );
}

function BagianRiwayat({ audit, b, muatUlang }: { audit: NonNullable<DetailProps["detail"]["data"]>["audit"]; b: BatchOpc; muatUlang: () => void }) {
    const rows = [...(audit.data ?? [])].reverse(); // server mengirim urut lama → baru; terbaru di atas
    const kalimat = (a: AuditOpc) => [
        a.fromStatus || a.toStatus ? `${labelStatus(a.fromStatus)} → ${labelStatus(a.toStatus)}` : "",
        a.correctionReason ? `Alasan koreksi: ${a.correctionReason}` : "",
        catatanSendiri(a), // BL-10 (#132)
        a.note || "",
    ].filter(Boolean).join(" · ");
    return (
        <>
            {audit.status === "memuat" && !audit.data ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat riwayat" /></div>
                : audit.status === "galat" && !audit.data ? (
                    <div className="fi-sect-in">
                        <MessageStrip tone="neg" title="Riwayat gagal dimuat.">{audit.error} <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button></MessageStrip>
                    </div>
                ) : rows.length === 0 ? <EmptyState title="Belum ada riwayat aksi" />
                : (
                    <ul className="fi-hist" aria-label="Riwayat aksi">
                        {rows.map((a) => (
                            <li key={a.id}>
                                <time>{waktuWita(a.createdAt)}</time>
                                <span><b>{a.actorName || "Sistem"}</b>{a.actorRole ? ` (${labelPeranAktor(a.actorRole)})` : ""} · {labelAksiAudit(a.action)}{a.parentAuditLogId ? " · koreksi" : ""}</span>
                                {kalimat(a) && <span className="fi-chg">{kalimat(a)}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            <div className="fi-sect-in">
                <h3 className="fi-caption">Status per sumbu</h3>
                <KeyValues items={([
                    ["Status utama", b.status], ["Sales Manager", b.smStatus], ["Klaim", b.claimStatus], ["Operational Manager", b.omStatus],
                    ["Keuangan", b.financeStatus], ["Verifikasi final", b.finalStatus], ["Pengembalian selisih", b.refundStatus ?? ""],
                ] as Array<[string, string]>).map(([k, v]) => [k, <Fragment key={k}>{labelStatus(v)}</Fragment>])} />
                {/* BL-33 */}
                <p className="fi-small fi-subtle">Riwayat mencatat aksi dan status, belum nilai sebelum dan sesudah tiap isian.</p>
            </div>
        </>
    );
}
