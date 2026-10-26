/*
 * Tujuan: Satu form "Ajukan pengembalian selisih" OFF Program Control (Fiori S4d) untuk SPV, Sales Manager, dan Keuangan: port bagian
 *   submit RefundPanel kode lama ("#17 Gap b: SM dapat mengajukan refund untuk batch yang memiliki selisih"). Label, pengurai nominal,
 *   dan pesan sama untuk semua peran; hanya teks pembuka yang berbeda. Verifikasi/tolak milik Keuangan (KeuanganRefund.tsx).
 * Caller: opc/peran/Sm.tsx (DetailSm), opc/peran/KeuanganRefund.tsx (bagianAjukan), opc/peran/Spv.tsx (DetailSpv); hanya bila sisa yang
 *   harus dikembalikan > 0 (syarat kode lama `summary.remainingRefund > 0`).
 * Dependensi: components/fiori, opc/Bersama (tulisOpc, tanganiTulis, pesanTidakPasti), lib/off-program-control/helpers (parseCurrency =
 *   parseUiCurrency kode lama), lib/opc-ui (tanggalOpc, RingkasanRefund), lib/promo-ui (rupiah), lib/tampil (KOSONG).
 * Main Functions: AjukanRefund.
 * Side Effects: POST /api/off-program-control/batches/[id]/refund {refundAmount, refundMethod, refundDate, senderName, receiverBank, note}
 *   (payload sama dengan submitRefund kode lama). Melapor draf lewat onDraf; hasil tidak pasti lewat onTidakPasti.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { Button, KeyValues } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { parseCurrency } from "@/lib/off-program-control/helpers";
import { tanggalOpc, type RingkasanRefund } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { pesanTidakPasti, tanganiTulis, tulisOpc } from "../Bersama";

const CARA = ["Transfer", "Tunai", "Kompensasi Batch Lain"] as const;
const KOSONGKAN = { jumlah: "", cara: "Transfer", tanggal: "", pengirim: "", bank: "", catatan: "" };
const PUTUS = pesanTidakPasti("pengajuan pengembalian ini", "riwayat pengembalian di bagian Pembayaran");

export function AjukanRefund({ batchId, no, ringkasan, alasan, pembuka, onDraf, onSelesai, onTidakPasti }: {
    batchId: string; no: string; ringkasan: RingkasanRefund;
    /** Alasan tombol nonaktif (izin / data uji / detail usang); undefined = boleh. */
    alasan?: string;
    /** Kalimat pembuka khusus peran (mis. kewajiban SPV); rincian angka dan isian sama untuk semua peran. */
    pembuka?: ReactNode;
    onDraf: (draf: boolean) => void;
    onSelesai: (pesan: string) => void;
    onTidakPasti?: (pesan: string) => void;
}) {
    const [f, setF] = useState(KOSONGKAN);
    const [dialog, setDialog] = useState(false);
    const ubah = (u: Partial<typeof KOSONGKAN>) => setF((x) => ({ ...x, ...u }));
    const dirty = (Object.keys(KOSONGKAN) as Array<keyof typeof KOSONGKAN>).some((k) => f[k] !== KOSONGKAN[k]);
    useEffect(() => { onDraf(dirty); return () => onDraf(false); }, [dirty, onDraf]);
    const jumlah = parseCurrency(f.jumlah);
    // Syarat tombol kode lama: jumlah dan tanggal terisi; batas selisih divalidasi server (galat tampil di dialog).
    const alasanTombol = alasan ?? (!f.jumlah || !f.tanggal ? "Isi jumlah dan tanggal pengembalian dulu." : undefined);

    return (
        <div className="fi-sect-in">
            {pembuka && <p className="fi-small fi-subtle">{pembuka}</p>}
            <KeyValues items={[
                ["Dana dikeluarkan", <span key="d" className="fi-tnum">{rupiah(ringkasan.paidAmount)}</span>],
                ["Realisasi klaim", <span key="r" className="fi-tnum">{rupiah(ringkasan.verifiedAmount)}</span>],
                ["Sudah dikembalikan", <span key="k" className="fi-tnum">{rupiah(ringkasan.totalRefunded)}</span>],
                ["Menunggu verifikasi Keuangan", <span key="m" className="fi-tnum">{rupiah(ringkasan.pendingRefund)}</span>],
                ["Sisa harus dikembalikan", <b key="s" className="fi-tnum">{rupiah(ringkasan.remainingRefund)}</b>],
            ]} />
            <div className="fi-formgrid">
                <FormField label="Jumlah pengembalian" required help="Rupiah, mis. 450.000">
                    {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={f.jumlah} onChange={(e) => ubah({ jumlah: e.target.value })} />}
                </FormField>
                <FormField label="Cara pengembalian">
                    {(a) => <select {...a} className="fi-input" value={f.cara} onChange={(e) => ubah({ cara: e.target.value })}>{CARA.map((c) => <option key={c}>{c}</option>)}</select>}
                </FormField>
                <FormField label="Tanggal pengembalian" required>
                    {(a) => <input {...a} className="fi-input" type="date" value={f.tanggal} onChange={(e) => ubah({ tanggal: e.target.value })} />}
                </FormField>
                <FormField label="Nama pengirim" help="Kosong = nama Anda.">
                    {(a) => <input {...a} className="fi-input" value={f.pengirim} onChange={(e) => ubah({ pengirim: e.target.value })} />}
                </FormField>
                <FormField label="Bank penerima">
                    {(a) => <input {...a} className="fi-input" value={f.bank} onChange={(e) => ubah({ bank: e.target.value })} />}
                </FormField>
                <FormField label="Catatan">
                    {(a) => <input {...a} className="fi-input" value={f.catatan} onChange={(e) => ubah({ catatan: e.target.value })} />}
                </FormField>
            </div>
            <div className="fi-btnrow" style={{ justifyContent: "flex-end" }}>
                {dirty && <Button variant="tertiary" onClick={() => setF(KOSONGKAN)}>Kosongkan</Button>}
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(alasanTombol)} disabledReason={alasanTombol} onClick={() => setDialog(true)}>
                    Ajukan pengembalian…
                </Button>
            </div>
            {alasanTombol && <p className="fi-small fi-subtle">{alasanTombol}</p>}
            <ConfirmDialog
                open={dialog}
                onClose={() => setDialog(false)}
                tag="Pengembalian selisih"
                title={`Ajukan pengembalian ${rupiah(jumlah)} untuk ${no}?`}
                description="Pengajuan menunggu verifikasi Keuangan; sisa selisih berkurang setelah diverifikasi. Server menolak bila total pengembalian melebihi selisih."
                facts={[
                    ["Jumlah", rupiah(jumlah)],
                    ["Cara", f.cara],
                    ["Tanggal", tanggalOpc(f.tanggal)],
                    ["Pengirim", f.pengirim.trim() || "Nama Anda"],
                    ["Bank penerima", f.bank.trim() || KOSONG],
                    ["Catatan", f.catatan.trim() || KOSONG],
                    ["Sisa sebelum pengajuan", rupiah(ringkasan.remainingRefund)],
                ]}
                confirmLabel="Ajukan pengembalian"
                onConfirm={async () => {
                    await tulisOpc(`/api/off-program-control/batches/${encodeURIComponent(batchId)}/refund`, {
                        body: { refundAmount: jumlah, refundMethod: f.cara, refundDate: f.tanggal, senderName: f.pengirim, receiverBank: f.bank, note: f.catatan },
                        gagal: "Gagal mengajukan pengembalian.", putus: PUTUS,
                    }).catch(tanganiTulis(onTidakPasti));
                    setF(KOSONGKAN);
                    setDialog(false);
                    onSelesai(`Pengembalian ${rupiah(jumlah)} untuk ${no} diajukan; menunggu verifikasi Keuangan.`);
                }}
            />
        </div>
    );
}
