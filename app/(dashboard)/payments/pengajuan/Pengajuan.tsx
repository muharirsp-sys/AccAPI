/*
 * Tujuan: Daftar "Pengajuan & SPPD" (Fiori S6a, it08, BL-50): pengajuan terbaru dulu dengan nomor SPPD, rute, tanggal bayar Finance,
 *   nilai, status gabungan transfer/posting, dan jumlah berkas; tiap baris membuka Object Page pengajuan. Baca-saja.
 * Caller: app/(dashboard)/payments/pengajuan/page.tsx (prop permKeys).
 * Dependensi: ../bersama (baca, RangkaPembayaran), components/fiori/*, lib/payments-ui, lib/promo-ui (rupiah).
 * Main Functions: Pengajuan (default), STATUS_PENGAJUAN, jamTampil.
 * Side Effects: GET /payments/submissions?limit&offset (payments.view).
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button, ListItem, ResponsiveTable, StatusBadge, type Column, type Tone } from "@/components/fiori/core";
import { useLoad } from "@/components/fiori/interactive";
import { namaAkun, tanggalTampil } from "@/lib/payments-ui";
import { rupiah } from "@/lib/promo-ui";
import { RangkaPembayaran, baca } from "../bersama";

export type RingkasPengajuan = {
    id: string; sppd_no: string; created_at_wita: string; created_by: string; target_payment_date: string; method: string; route_label: string;
    record_count: number; principles: string[]; total_invoice: number; total_potongan: number; total_pembayaran: number;
    transfer: Record<string, number>; posting: Record<string, number>; status: string; status_label: string; file_count: number;
};

/** Status gabungan dari server (urutan prioritas server) → nada badge. */
export const STATUS_PENGAJUAN: Record<string, Tone> = {
    kosong: "neu", tidak_pasti: "warn", terposting: "pos", dikembalikan: "warn", ditransfer: "pos", sebagian: "info", menunggu_transfer: "info",
};

/** "2026-10-09 10:00:00" (WITA dari server) → "09/10/2026 10.00". */
export function jamTampil(wita: string): string {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(wita ?? "");
    return m ? `${tanggalTampil(m[1])} ${m[2]}.${m[3]}` : wita || "—";
}

const PAGE = 50;
const judul = (r: RingkasPengajuan) => r.sppd_no || `Pengajuan ${r.id}`;

export default function Pengajuan({ permKeys }: { permKeys: string[] }) {
    const [offset, setOffset] = useState(0);
    const [load, muat] = useLoad(useCallback(() => baca(`/payments/submissions?limit=${PAGE}&offset=${offset}`, (d) => ({
        rows: Array.isArray(d.data) ? (d.data as RingkasPengajuan[]) : [], total: Number(d.total ?? 0),
    })), [offset]), { pertahankan: true });
    const rows = load.data?.rows ?? [];
    const total = load.data?.total ?? 0;

    const kolom: Column<RingkasPengajuan>[] = [
        { key: "no", header: "Pengajuan", cell: (r) => (
            <span className="grid">
                <Link className="fi-mono" href={`/payments/pengajuan/${encodeURIComponent(r.id)}`}>{judul(r)}</Link>
                {r.sppd_no && <span className="fi-small fi-subtle fi-mono">{r.id}</span>}
            </span>
        ) },
        { key: "diajukan", header: "Diajukan (WITA)", cell: (r) => <span className="grid"><span className="fi-tnum">{jamTampil(r.created_at_wita)}</span><span className="fi-small fi-subtle">{namaAkun(r.created_by) || "—"}</span></span> },
        { key: "rute", header: "Rute", secondary: true, cell: (r) => r.route_label || "—" },
        { key: "principal", header: "Principal", secondary: true, cell: (r) => (r.principles.length > 2 ? `${r.principles.slice(0, 2).join(", ")} +${r.principles.length - 2}` : r.principles.join(", ")) || "—" },
        { key: "tanggal", header: "Tanggal bayar", cell: (r) => tanggalTampil(r.target_payment_date) },
        { key: "nilai", header: "Nilai bayar", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.total_pembayaran)}</span> },
        { key: "status", header: "Status", cell: (r) => <span className="grid gap-1 justify-items-start"><StatusBadge tone={STATUS_PENGAJUAN[r.status] ?? "neu"}>{r.status_label}</StatusBadge><span className="fi-small fi-subtle">{r.record_count} rekaman · {r.file_count} berkas</span></span> },
    ];

    return (
        <RangkaPembayaran halaman="pengajuan" judul="Pengajuan & SPPD" permKeys={permKeys}
            deskripsi="Setiap pengajuan ke Finance dengan nomor SPPD, berkasnya, dan status per baris Finance. Terbaru di atas."
            aksi={<Button variant="icon" aria-label="Muat ulang" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && rows.length > 0} onClick={muat} />}>
            <ResponsiveTable<RingkasPengajuan>
                title="Pengajuan" count={total} columns={kolom} rows={rows} rowKey={(r) => r.id}
                status={load.status} error={load.error} onRetry={muat}
                actions={total > PAGE ? (
                    <div className="fi-btnrow" role="group" aria-label="Halaman tabel">
                        <span className="fi-small fi-subtle fi-tnum">{offset + 1}–{Math.min(offset + PAGE, total)} dari {total}</span>
                        <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Sebelumnya</Button>
                        <Button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Berikutnya</Button>
                    </div>
                ) : undefined}
                empty={{ title: "Belum ada pengajuan", message: "Pengajuan muncul di sini setelah keranjang diajukan ke Finance dari Rekaman pembayaran.", action: <Link className="fi-btn fi-btn--secondary" href="/payments">Rekaman pembayaran</Link> }}
                mobileItem={(r) => (
                    <ListItem doc={judul(r)} amount={rupiah(r.total_pembayaran)} title={`${r.route_label} · ${r.principles.join(", ") || "—"}`}
                        meta={`${jamTampil(r.created_at_wita)} · bayar ${tanggalTampil(r.target_payment_date)}`}
                        badge={<StatusBadge tone={STATUS_PENGAJUAN[r.status] ?? "neu"}>{r.status_label}</StatusBadge>}
                        href={`/payments/pengajuan/${encodeURIComponent(r.id)}`} />
                )}
            />
        </RangkaPembayaran>
    );
}
