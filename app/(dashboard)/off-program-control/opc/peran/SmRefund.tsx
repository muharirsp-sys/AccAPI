/*
 * Tujuan: Isi bagian "Ajukan pengembalian selisih" di Object Page Sales Manager (Fiori S4d): port bagian submit RefundPanel lama
 *   (old-opc.tsx 8001–8033, form 8161–8199). "#17 Gap b: SM dapat mengajukan refund untuk batch yang memiliki selisih." Ringkasan dan
 *   riwayat pengembalian sudah tampil di bagian Pembayaran (ObjectPageBatch); verifikasi/tolak milik Keuangan.
 * Caller: opc/peran/Sm.tsx (DetailSm), hanya bila sisa yang harus dikembalikan > 0 (syarat lama `summary.remainingRefund > 0`).
 * Dependensi: components/fiori, opc/Bersama (tulisOpc), lib/off-program-control/helpers (parseCurrency = parseUiCurrency lama),
 *   lib/opc-ui (tanggalOpc, RingkasanRefund), lib/promo-ui (rupiah).
 * Main Functions: AjukanRefund.
 * Side Effects: POST /api/off-program-control/batches/[id]/refund {refundAmount, refundMethod, refundDate, senderName, receiverBank, note}
 *   (payload sama dengan submitRefund lama). Melapor draf lewat onDraf.
 */
"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { parseCurrency } from "@/lib/off-program-control/helpers";
import { tanggalOpc, type RingkasanRefund } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { tulisOpc } from "../Bersama";

const CARA = ["Transfer", "Tunai", "Kompensasi Batch Lain"] as const;
const KOSONG = { jumlah: "", cara: "Transfer", tanggal: "", pengirim: "", bank: "", catatan: "" };

export function AjukanRefund({ batchId, no, ringkasan, alasan, onDraf, onSelesai }: {
    batchId: string; no: string; ringkasan: RingkasanRefund;
    /** Alasan tombol nonaktif (izin submit_refund / data uji); undefined = boleh. */
    alasan?: string;
    onDraf: (draf: boolean) => void;
    onSelesai: (pesan: string) => void;
}) {
    const [f, setF] = useState(KOSONG);
    const [dialog, setDialog] = useState(false);
    const ubah = (u: Partial<typeof KOSONG>) => setF((x) => ({ ...x, ...u }));
    const dirty = (Object.keys(KOSONG) as Array<keyof typeof KOSONG>).some((k) => f[k] !== KOSONG[k]);
    useEffect(() => { onDraf(dirty); return () => onDraf(false); }, [dirty, onDraf]);
    const jumlah = parseCurrency(f.jumlah);
    // Syarat tombol lama: jumlah dan tanggal terisi; batas selisih divalidasi server (galat tampil di dialog).
    const alasanTombol = alasan ?? (!f.jumlah || !f.tanggal ? "Isi jumlah dan tanggal pengembalian dulu." : undefined);

    return (
        <div className="fi-sect-in">
            <p className="fi-small fi-subtle">
                Sisa yang harus dikembalikan <b className="fi-tnum">{rupiah(ringkasan.remainingRefund)}</b>
                {ringkasan.pendingRefund > 0 && <> · <span className="fi-tnum">{rupiah(ringkasan.pendingRefund)}</span> menunggu verifikasi Keuangan</>}.
            </p>
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
                {dirty && <Button variant="tertiary" onClick={() => setF(KOSONG)}>Kosongkan</Button>}
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
                    ["Bank penerima", f.bank.trim() || "–"],
                    ["Catatan", f.catatan.trim() || "–"],
                    ["Sisa sebelum pengajuan", rupiah(ringkasan.remainingRefund)],
                ]}
                confirmLabel="Ajukan pengembalian"
                onConfirm={async () => {
                    await tulisOpc(`/api/off-program-control/batches/${encodeURIComponent(batchId)}/refund`, {
                        body: { refundAmount: jumlah, refundMethod: f.cara, refundDate: f.tanggal, senderName: f.pengirim, receiverBank: f.bank, note: f.catatan },
                        gagal: "Gagal submit refund.",
                    });
                    setF(KOSONG);
                    setDialog(false);
                    onSelesai(`Pengembalian ${rupiah(jumlah)} untuk ${no} diajukan; menunggu verifikasi Keuangan.`);
                }}
            />
        </div>
    );
}
