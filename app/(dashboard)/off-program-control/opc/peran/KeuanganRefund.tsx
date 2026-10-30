/*
 * Tujuan: Bagian pengembalian selisih di Object Page Keuangan OPC (Fiori S4d, ZONA UANG): "Verifikasi pengembalian" (daftar yang
 *   diajukan dan masih menunggu verifikasi; Verifikasi lewat ConfirmDialog, Tolak lewat dialog dengan alasan WAJIB; Batal benar-benar
 *   batal, padahal prompt kode lama tetap menolak walau Batal) dan "Ajukan pengembalian" (RefundPanel lama di tab Keuangan juga memuat
 *   form ajukan: canSubmitRefund = submit_refund || finance_payment; komponen AjukanRefund dari SmRefund.tsx).
 * Caller: opc/peran/Keuangan.tsx (bagianRefund, bagianAjukan → BagianTambahan di ObjectPageBatch).
 * Dependensi: components/fiori/{core,interactive}, opc/Bersama (DetailProps, tulisOpc, pesanTidakPasti), opc/peran/SmRefund (AjukanRefund),
 *   lib/opc-ui, lib/promo-ui, lib/tampil (KOSONG).
 * Main Functions: bagianRefund, VerifikasiRefund, bagianAjukan.
 * Side Effects: PATCH /api/off-program-control/batches/[id]/refund { refundId, action: "verify" | "reject", note } lewat tulisOpc; payload
 *   sama dengan verifyRefund kode lama (verify mengirim note ""). Server mengubah status refund, menghitung ulang refundStatus batch,
 *   dan menutup batch (Completed) bila seluruh selisih sudah kembali. POST /refund lewat AjukanRefund (payload submitRefund lama).
 *   Jawaban tidak pasti (putus, ≥ 502, bukan JSON) dilaporkan lewat laporTidakPasti, bukan sebagai gagal.
 */
"use client";

import { useState, type ReactNode } from "react";
import { Button, KeyValues, MessageStrip, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog } from "@/components/fiori/interactive";
import { PREDIKAT, tanggalOpc, type RefundOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { TulisTidakPasti, pesanTidakPasti, tulisOpc, type DetailProps } from "../Bersama";
import type { BagianTambahan } from "../ObjectPageBatch";
import { AjukanRefund } from "./SmRefund";

const enc = encodeURIComponent;
const PUTUS = pesanTidakPasti("pengembalian ini", "status pengembaliannya");

/** onSelesai: strip sukses + muat ulang, dipegang DetailKeuangan supaya tetap tampil walau bagian ini hilang (mis. selisih lunas). */
type Props = DetailProps & { onSelesai: (pesan: string) => void };

/** Form ajukan pengembalian: syarat lama `summary.remainingRefund > 0` (8161) dan izin submit_refund ATAU finance_payment (7969). */
export function bagianAjukan({ ctx, detail, onSelesai, onDraf, laporTidakPasti }: Props & { onDraf: (draf: boolean) => void }): BagianTambahan | null {
    const d = detail.data;
    const ringkasan = d?.refund.data?.summary;
    if (!d || !ringkasan || ringkasan.remainingRefund <= 0) return null;
    // `a && b`: alasan hanya bila KEDUA izin tidak ada (undefined = boleh).
    const izin = ctx.izin("submit_refund") && ctx.izin("finance_payment");
    const kunci = d.uji ? "Batch data uji (mock) tidak punya pengembalian di server."
        : detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
            : detail.status === "galat" ? "Detail batch gagal dimuat ulang; sisa selisih di layar bisa usang. Muat ulang dulu." : undefined;
    return {
        id: "opc-ajukan-refund", label: "Ajukan pengembalian",
        isi: <AjukanRefund batchId={d.batch.id} no={d.batch.noPengajuan} ringkasan={ringkasan} alasan={izin ?? kunci} onDraf={onDraf} onSelesai={onSelesai}
            onTidakPasti={laporTidakPasti} />,
    };
}

/** Bagian tampil bila ada yang perlu Keuangan lihat: pengembalian menunggu verifikasi, selisih terbuka, atau datanya gagal dimuat. */
export function bagianRefund(props: Props): BagianTambahan | null {
    const d = props.detail.data;
    if (!d) return null;
    const ada = d.refund.status === "galat" || (d.refund.data?.refunds ?? []).some((r) => r.status === "Pending") || PREDIKAT.selisihTerbuka(d.batch);
    return ada ? { id: "opc-verifikasi-refund", label: "Verifikasi pengembalian", isi: <VerifikasiRefund {...props} /> } : null;
}

export function VerifikasiRefund({ ctx, detail, muatUlang, onSelesai, laporTidakPasti }: Props) {
    const [aksi, setAksi] = useState<{ jenis: "verify" | "reject"; r: RefundOpc } | null>(null);
    const d = detail.data!;
    const b = d.batch;
    const muat = d.refund;
    const tertunda = (muat.data?.refunds ?? []).filter((r) => r.status === "Pending");
    const ringkas = muat.data?.summary;
    // Status refund yang usang tidak boleh dipakai untuk memutuskan: selama detail dimuat ulang atau gagal dimuat ulang, aksi terkunci.
    const kunci = d.uji ? "Batch data uji (mock) tidak punya pengembalian di server."
        : detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
            : detail.status === "galat" ? "Detail batch gagal dimuat ulang; status pengembalian di layar bisa usang. Muat ulang dulu."
                : muat.status !== "siap" ? "Data pengembalian gagal dimuat; muat ulang dulu."
                    : undefined;
    // Kode lama: tombol hanya untuk canPerformOffAction(peran, "finance_payment"); server juga menerima izin grup akses yang sama.
    const alasan = ctx.izin("finance_payment") ?? kunci;
    const r = aksi?.r;

    async function kirim(jenis: "verify" | "reject", note: string) {
        if (!r) return;
        try {
            await tulisOpc(`/api/off-program-control/batches/${enc(b.id)}/refund`, {
                method: "PATCH", body: { refundId: r.id, action: jenis, note }, gagal: "Gagal memproses pengembalian.", putus: PUTUS,
            });
        } catch (e) {
            // Mis. 409 "Refund sudah Verified" (diproses orang lain) atau jawaban tak pasti: muat ulang supaya daftar tidak usang.
            // Tidak pasti: dialog ditutup, strip bertahan + muat ulang daftar dan detail (No 22).
            if (e instanceof TulisTidakPasti) { setAksi(null); laporTidakPasti(e.message); }
            else muatUlang();
            throw e;
        }
        setAksi(null);
        onSelesai(jenis === "verify"
            ? `Pengembalian ke-${r.refundNo} (${rupiah(r.refundAmount)}) terverifikasi.`
            : `Pengembalian ke-${r.refundNo} (${rupiah(r.refundAmount)}) ditolak; alasan tercatat di Riwayat.`);
    }

    const faktaRefund = (x: RefundOpc): Array<[string, ReactNode]> => [
        ["Batch", <span key="b" className="fi-mono">{b.noPengajuan}</span>],
        ["Diajukan", `${x.senderName || "Pengirim tidak diisi"} · ${x.refundMethod || KOSONG} · ${tanggalOpc(x.refundDate)}`],
        ["Bank penerima", x.receiverBank || KOSONG],
        ["Jumlah", <b key="j" className="fi-tnum">{rupiah(x.refundAmount)}</b>],
    ];

    return (
        <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>
            {muat.status === "galat" ? (
                <MessageStrip tone="neg" title="Pengembalian yang menunggu verifikasi belum bisa ditampilkan.">
                    {muat.error} Verifikasi dan penolakan terkunci sampai datanya termuat. <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button>
                </MessageStrip>
            ) : tertunda.length === 0 ? (
                <p className="fi-small fi-subtle">
                    Belum ada pengembalian yang menunggu verifikasi. SPV mengajukan pengembalian dari menu Data selisih; riwayatnya ada di bagian Pembayaran.
                </p>
            ) : (
                <ul className="fi-berkas" aria-label="Pengembalian menunggu verifikasi">
                    {tertunda.map((x) => (
                        <li key={x.id}>
                            <div className="fi-berkas-head">
                                <b>Pengembalian ke-{x.refundNo}</b>
                                <span className="fi-tnum">{rupiah(x.refundAmount)}</span>
                                <StatusBadge tone="warn">Menunggu verifikasi</StatusBadge>
                            </div>
                            <KeyValues items={[
                                ["Tanggal", tanggalOpc(x.refundDate)],
                                ["Cara", x.refundMethod || KOSONG],
                                ["Pengirim", x.senderName || KOSONG],
                                ["Bank penerima", x.receiverBank || KOSONG],
                                ["Bukti", x.proofUrl ? <a key="p" href={x.proofUrl} target="_blank" rel="noreferrer">{x.proofName || "Buka bukti"}</a> : KOSONG],
                                ["Catatan", x.note || KOSONG],
                            ]} />
                            <div className="fi-btnrow">
                                <Button variant="negative" aria-label={`Tolak pengembalian ke-${x.refundNo}`} disabled={Boolean(alasan)} disabledReason={alasan}
                                    onClick={() => setAksi({ jenis: "reject", r: x })}>Tolak…</Button>
                                <Button variant="primary" aria-label={`Verifikasi pengembalian ke-${x.refundNo}`} disabled={Boolean(alasan)} disabledReason={alasan}
                                    onClick={() => setAksi({ jenis: "verify", r: x })}>Verifikasi…</Button>
                            </div>
                            {alasan && <p className="fi-small fi-why">{alasan}</p>}
                        </li>
                    ))}
                </ul>
            )}

            <ConfirmDialog
                open={aksi?.jenis === "verify"}
                onClose={() => setAksi(null)}
                title={r ? `Verifikasi pengembalian ${rupiah(r.refundAmount)}?` : ""}
                tag="Pengembalian selisih"
                confirmLabel="Verifikasi pengembalian"
                confirmDisabled={alasan}
                facts={r ? [
                    ...faktaRefund(r),
                    ["Sisa harus dikembalikan", ringkas ? rupiah(ringkas.remainingRefund) : KOSONG],
                    ["Setelah diverifikasi", "Jumlah ini dihitung sudah kembali. Bila seluruh selisih sudah kembali, batch otomatis Selesai."],
                ] : []}
                onConfirm={() => kirim("verify", "")}
            />
            <ConfirmDialog
                open={aksi?.jenis === "reject"}
                onClose={() => setAksi(null)}
                title={r ? `Tolak pengembalian ${rupiah(r.refundAmount)}?` : ""}
                tag="Alasan wajib"
                tone="negative"
                description="Batal menutup dialog tanpa mengubah apa pun."
                reason={{ label: "Alasan penolakan", placeholder: "mis. dana belum masuk di rekening operasional" }}
                confirmLabel="Tolak pengembalian"
                confirmDisabled={alasan}
                facts={r ? [
                    ...faktaRefund(r),
                    ["Setelah ditolak", "Pengembalian ini tidak dihitung; SPV perlu mengajukan ulang. Alasan tercatat di Riwayat."],
                ] : []}
                onConfirm={(alasanTolak) => kirim("reject", alasanTolak)}
            />
        </div>
    );
}
