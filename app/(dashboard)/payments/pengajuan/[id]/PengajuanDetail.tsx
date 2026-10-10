/*
 * Tujuan: Object Page satu pengajuan (Fiori S6a, it08, BL-50): nomor SPPD, rute, tanggal bayar Finance, status per baris Finance
 *   (transfer/posting/kunci), berkas yang benar-benar ada di server, alur dokumen (BL-35), dan ringkasan keranjang. Baca-saja; aksi
 *   transfer/posting/Ajukan Ulang tetap di halaman Finance.
 * Caller: app/(dashboard)/payments/pengajuan/[id]/page.tsx (props id, permKeys).
 * Dependensi: ../../bersama (baca, unduhUrl), ../Pengajuan (RingkasPengajuan, STATUS_PENGAJUAN, jamTampil), components/fiori/*,
 *   lib/payments-ui, lib/promo-ui (rupiah).
 * Main Functions: PengajuanDetail (default).
 * Side Effects: GET /payments/submissions/{id} (payments.view; dokumen SPPD hanya tercantum dengan sppd.download).
 */
"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Lock } from "lucide-react";
import {
    AnchorBar, EmptyState, ErrorState, KeyValues, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section, Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { useLoad } from "@/components/fiori/interactive";
import { izinPembayaran, namaAkun, statusFinance, tanggalTampil } from "@/lib/payments-ui";
import { rupiah } from "@/lib/promo-ui";
import { baca, unduhUrl } from "../../bersama";
import { STATUS_PENGAJUAN, jamTampil, type RingkasPengajuan } from "../Pengajuan";

type BarisFinance = {
    record_id: string; no_lpb: string; tipe_pengajuan: string; principle: string; invoice_no: string; nilai_invoice: number; potongan: number;
    nilai_pembayaran: number; jenis_pembayaran: string; status_pembayaran: string; transfer_date: string; accurate_post_status: string;
    accurate_purchase_payment_number: string; locked_reason: string;
};
type ItemKeranjang = { principle?: string; tipe_pengajuan?: string; jenis_pembayaran?: string; potongan?: number; nilai_pembayaran?: number; total_invoice?: number; keterangan?: string };
type Detail = RingkasPengajuan & { files: Array<{ label: string; name: string; url: string }>; records: BarisFinance[]; cart_items: Record<string, ItemKeranjang> };

const nama = (r: BarisFinance) => r.no_lpb || r.record_id;

export default function PengajuanDetail({ id, permKeys }: { id: string; permKeys: string[] }) {
    const izin = izinPembayaran(permKeys);
    const [load, muat] = useLoad(useCallback(() => baca(`/payments/submissions/${encodeURIComponent(id)}`, (d) => (d.data && typeof d.data === "object" && Array.isArray((d.data as Detail).records) ? d.data as Detail : undefined), { nihil404: true }), [id]));
    const kembali = <Link className="fi-btn fi-btn--secondary" href="/payments/pengajuan"><ArrowLeft className="fi-icon" aria-hidden />Pengajuan & SPPD</Link>;
    const jejak = [{ label: "Pengajuan & SPPD", href: "/payments/pengajuan" }, { label: "Pengajuan" }];

    if (load.status === "galat" && load.data === undefined) {
        return <div className="fi-page"><ObjectPageHeader breadcrumbs={jejak} title={`Pengajuan ${id}`} /><ErrorState title="Pengajuan gagal dimuat" message={load.error} onRetry={muat} /></div>;
    }
    if (load.data === undefined) {
        return <div className="fi-page"><ObjectPageHeader breadcrumbs={jejak} title={`Pengajuan ${id}`} /><Skeleton rows={4} label="Memuat pengajuan" /><Skeleton rows={3} /></div>;
    }
    if (load.data === null) {
        return (
            <div className="fi-page">
                <ObjectPageHeader breadcrumbs={jejak} title={`Pengajuan ${id}`} />
                <EmptyState title="Pengajuan tidak ditemukan" message="Nomor pengajuan ini tidak ada. Kembali ke daftar Pengajuan & SPPD dan cari dengan nomor SPPD atau principal." action={kembali} />
            </div>
        );
    }

    const d = load.data;
    const posted = d.posting.posted ?? 0;
    const dikembalikan = d.transfer["Ajukan Ulang"] ?? 0;
    const kolom: Column<BarisFinance>[] = [
        { key: "rekaman", header: "Rekaman", cell: (r) => <span className="grid"><span className="fi-mono">{nama(r)}</span><span className="fi-small fi-subtle">{r.tipe_pengajuan}</span></span> },
        { key: "principal", header: "Principal", cell: (r) => r.principle || "—" },
        { key: "invoice", header: "Invoice", secondary: true, cell: (r) => r.invoice_no || "—" },
        { key: "bayar", header: "Nilai bayar", align: "end", cell: (r) => <span className="grid justify-items-end"><span className="fi-tnum">{rupiah(r.nilai_pembayaran)}</span>{r.potongan > 0 && <span className="fi-small fi-subtle fi-tnum">potongan {rupiah(r.potongan)}</span>}</span> },
        { key: "status", header: "Status di Finance", cell: (r) => {
            const st = statusFinance(r.status_pembayaran, r.accurate_post_status);
            return (
                <span className="grid gap-1 justify-items-start">
                    <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                    {r.transfer_date && <span className="fi-small fi-subtle">transfer {tanggalTampil(r.transfer_date)}</span>}
                    {r.locked_reason && <span className="fi-small fi-subtle"><Lock className="fi-icon" aria-hidden /> {r.locked_reason}</span>}
                </span>
            );
        } },
        { key: "pp", header: "Purchase Payment", cell: (r) => <span className="fi-mono">{r.accurate_purchase_payment_number || "—"}</span> },
    ];
    const keranjang = Object.entries(d.cart_items ?? {});
    const berkasHilang = Math.max(0, d.file_count - d.files.length);

    return (
        <div className="fi-page">
            <ObjectPageHeader breadcrumbs={jejak} title={<span className="fi-mono">{d.sppd_no || `Pengajuan ${d.id}`}</span>}
                status={<StatusBadge tone={STATUS_PENGAJUAN[d.status] ?? "neu"}>{d.status_label}</StatusBadge>}
                attributes={[
                    { label: "Pengajuan", value: <span className="fi-mono">{d.id}</span> },
                    { label: "Rute", value: d.route_label || "—" },
                    { label: "Tanggal bayar Finance", value: tanggalTampil(d.target_payment_date) },
                    { label: "Nilai bayar", value: rupiah(d.total_pembayaran) },
                    { label: "Diajukan (WITA)", value: `${namaAkun(d.created_by) || "—"} · ${jamTampil(d.created_at_wita)}` },
                ]} />
            <AnchorBar anchors={[{ id: "baris", label: "Baris Finance" }, { id: "berkas", label: "Berkas" }, { id: "alur", label: "Alur dokumen" }, { id: "keranjang", label: "Keranjang" }, { id: "riwayat", label: "Riwayat" }]} />
            {load.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang.">{load.error} Yang tampil adalah hasil sebelumnya.</MessageStrip>}
            {d.status === "terposting" && <MessageStrip tone="pos" title="Semua baris terposting.">Pengajuan selesai; rekamannya terkunci.</MessageStrip>}
            {d.status === "tidak_pasti" && <MessageStrip tone="warn" title="Ada posting Accurate yang TIDAK PASTI.">Finance menyelesaikannya di halaman Finance sebelum baris itu bisa dikembalikan atau diposting ulang.</MessageStrip>}
            {dikembalikan > 0 && <MessageStrip tone="warn" title={`${dikembalikan} rekaman dikembalikan Finance (Ajukan Ulang).`}>Rekaman itu bisa diubah lagi di Rekaman pembayaran dan diajukan di keranjang baru (SPPD baru untuk rute Panin).</MessageStrip>}

            <Section id="baris" title="Baris Finance" subtitle={`${d.record_count} rekaman → Finance → Purchase Payment (${posted} terposting)`}>
                <ResponsiveTable<BarisFinance> title="Baris Finance" columns={kolom} rows={d.records} rowKey={(r) => r.record_id}
                    empty={{ title: "Tanpa rekaman", message: "Rekaman pengajuan ini sudah tidak ada di Pembayaran (dihapus atau data lama)." }}
                    mobileItem={(r) => {
                        const st = statusFinance(r.status_pembayaran, r.accurate_post_status);
                        return <ListItem doc={nama(r)} amount={rupiah(r.nilai_pembayaran)} title={`${r.principle} · ${r.tipe_pengajuan}`}
                            meta={r.accurate_purchase_payment_number || r.locked_reason || r.invoice_no} badge={<StatusBadge tone={st.tone}>{st.label}</StatusBadge>} />;
                    }} />
                <p className="fi-small fi-subtle" style={{ padding: "8px 16px 12px" }}>
                    Transfer, posting Purchase Payment, dan Ajukan Ulang dilakukan di <Link href="/finance">halaman Finance</Link>. Server menolak Ajukan Ulang
                    bila Purchase Payment sudah terposting atau posting masih tidak pasti (BL-49).
                </p>
            </Section>

            <Section id="berkas" title="Berkas" subtitle={d.method === "BANK_PANIN" ? "SPPD Bank Panin dan invoice per principal" : "invoice per principal"}>
                <div className="fi-sect-in">
                    {d.files.length === 0
                        ? <p className="fi-small fi-subtle">Tidak ada berkas tersimpan untuk pengajuan ini{d.file_count === 0 ? " (mis. hasil restore backup atau data lama)" : ""}.</p>
                        : <ul className="fi-docs" aria-label="Berkas pengajuan">{d.files.map((f) => (
                            <li key={f.name} className="fi-doc"><b><FileText className="fi-icon" aria-hidden /> {f.label}</b>
                                <a href={unduhUrl(f.url)} target="_blank" rel="noopener noreferrer">Unduh</a></li>
                        ))}</ul>}
                    {berkasHilang > 0 && <MessageStrip tone="warn" title={`${berkasHilang} berkas tercatat tetapi tidak ada lagi di server.`} />}
                    {d.method === "BANK_PANIN" && izin.unduhSppd && <p className="fi-small fi-subtle">Dokumen SPPD tidak tercantum: {izin.unduhSppd}</p>}
                </div>
            </Section>

            <Section id="alur" title="Alur dokumen" subtitle="BL-35">
                <div className="fi-dflow">
                    <Link className="fi-dnode" href="/payments"><b>{d.record_count} rekaman</b><span>Pembayaran</span></Link>
                    <span aria-hidden>→</span>
                    <span className="fi-dnode"><b className="fi-mono">{d.sppd_no || d.id}</b><span>pengajuan {d.id}</span></span>
                    <span aria-hidden>→</span>
                    <Link className="fi-dnode" href="/finance"><b>Finance</b><span>{tanggalTampil(d.target_payment_date)} · {d.record_count} baris</span></Link>
                    <span aria-hidden>→</span>
                    <span className="fi-dnode" data-off={posted === 0 ? "true" : undefined}><b>Purchase Payment</b><span>{posted ? `${posted} terposting` : "belum"}</span></span>
                </div>
            </Section>

            <Section id="keranjang" title="Keranjang saat diajukan" subtitle="potongan, jenis, dan keterangan per principal">
                <div className="fi-sect-in">
                    {keranjang.length === 0 ? <p className="fi-small fi-subtle">Ringkasan keranjang tidak tersimpan (data lama).</p>
                        : keranjang.map(([k, it]) => (
                            <KeyValues key={k} items={[
                                ["Principal", `${it.principle ?? k.split("||")[0]} · ${it.tipe_pengajuan ?? ""}`],
                                ["Jenis · potongan", `${it.jenis_pembayaran || "—"} · ${rupiah(Number(it.potongan ?? 0))}`],
                                ["Nilai bayar", rupiah(Number(it.nilai_pembayaran ?? 0))],
                                ["Keterangan", it.keterangan || "—"],
                            ]} />
                        ))}
                </div>
            </Section>

            <Section id="riwayat" title="Riwayat">
                <div className="fi-sect-in">
                    <VariantNote bl="BL-33">Riwayat bersama (siapa mengubah apa, nilai lama → baru) belum disimpan server. Yang tersedia: pengaju dan jam di kepala halaman,
                        tanggal transfer dan nomor Purchase Payment per baris di atas.</VariantNote>
                </div>
            </Section>
            <div>{kembali}</div>
        </div>
    );
}
