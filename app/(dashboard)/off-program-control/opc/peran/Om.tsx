/*
 * Tujuan: Modul peran Operational Manager OFF Program Control (Fiori S4d, tab `om`, layar it03 `om`): ringkasan antrean langsung
 *   (LiveQueueSummaryPanel), antrean "Menunggu Anda" (isOmActionableBatch) + Semua (semua batch, sama dengan monitoring OM lama), dan
 *   Object Page batch dengan ringkasan persetujuan (catatan Klaim/SM, total/transfer/tunai), catatan OM (draf), Setujui (dialog
 *   `omok`) dan Batalkan (dialog `batal`, terminal, alasan wajib).
 * Caller: OpcApp.tsx (MODUL.om).
 * Dependensi: opc/Bersama (KerjaPeran, tulisOpc, kontrak), opc/ObjectPageBatch (slot), components/fiori, lib/opc-ui (TAMPILAN, PREDIKAT),
 *   lib/off-program-control/problematic (SLA_DAYS), lib/promo-ui (rupiah).
 * Main Functions: Om, DetailOm, AntreanLangsung.
 * Side Effects: POST /api/off-program-control/batches/[id]/om-decision {action: "approve" | "cancel", note} (payload sama dengan decideOm
 *   lama old-opc.tsx 7473–7508). Setelah berhasil: muat ulang daftar dan detail.
 *
 * Asal fitur (old-opc.tsx): LiveQueueSummaryPanel 7228–7322, decideOm 7473–7508, Detail Persetujuan 7621–7677, Catatan dari Claim
 *   7679–7693, Data Pendukung 7695–7758, Item 7760–7849 (kerangka: bagian Item), Ringkasan Pembayaran 7851–7872 (7340–7365),
 *   Keputusan OM 7874–7922.
 */
"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button, KeyValues, MessageStrip, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { SLA_DAYS } from "@/lib/off-program-control/problematic";
import { PREDIKAT, TAMPILAN, jumlahItem, labelStatus, tanggalOpc, totalBatch, type BatchOpc, type ItemOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KerjaPeran, tulisOpc, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";

const enc = encodeURIComponent;

/** normalizeUiPaymentMethod lama (363): hanya "transfer"/"tunai" yang dikenali. */
const caraBayar = (v: string | null) => {
    const x = String(v || "").trim().toLowerCase();
    return x === "transfer" ? "Transfer" : x === "tunai" ? "Tunai" : v;
};
const jumlahCara = (items: ItemOpc[], cara: "Transfer" | "Tunai") =>
    items.filter((i) => caraBayar(i.caraBayar) === cara).reduce((t, i) => t + Number(i.nominal || 0), 0);

/** Kolom kedua OM: Object Page + ringkasan persetujuan + catatan OM (draf) + keputusan bila batch menunggu OM. */
function DetailOm(props: DetailProps) {
    const { ctx, daftar, ringkas, batchId, detail } = props;
    const { setDraf } = ctx;
    const [catatan, setCatatan] = useState("");
    const [dialog, setDialog] = useState<"omok" | "batal" | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const dirty = catatan.trim() !== "";
    useEffect(() => { setDraf(dirty); return () => setDraf(false); }, [dirty, setDraf]);

    const data = detail.data;
    if (!data) return <ObjectPageBatch {...props} />;
    const b = data.batch;
    const no = b.noPengajuan;
    // BL-06 (lebih ketat = aman): aksi hanya bila baris detail DAN baris daftar terbaru (polling) masih menunggu OM.
    const bisa = PREDIKAT.omAntrean(b) && (!ringkas || PREDIKAT.omAntrean(ringkas));
    const alasanUji = data.uji ? "Batch data uji (mock) tidak bisa diproses." : undefined;
    const alasanSetuju = alasanUji ?? ctx.izin("om_approve");
    const alasanBatal = alasanUji ?? ctx.izin("om_cancel");
    const n = data.items.length || jumlahItem(b);
    // Ringkasan Pembayaran lama: ringkasan server dulu, bila nol/kosong dihitung dari item.
    const ringkasan = data.summary ?? b.summary;
    const total = Number(ringkasan?.totalNominal || data.items.reduce((t, i) => t + Number(i.nominal || 0), 0) || totalBatch(b));
    const transfer = Number(ringkasan?.transfer || jumlahCara(data.items, "Transfer"));
    const tunai = Number(ringkasan?.tunai || jumlahCara(data.items, "Tunai"));

    const bagian: BagianTambahan[] = [{
        id: "opc-om-ringkas", label: "Persetujuan OM", letak: "awal",
        isi: (
            <div className="fi-sect-in">
                {/* #9: Catatan dari submit Claim (setelah tahap SM) selalu tampil untuk OM. */}
                <MessageStrip tone="info" title="Catatan dari Klaim:">
                    {b.claimNote?.trim() || "Tidak ada catatan dari Klaim."}
                    {b.smNote?.trim() ? <><br />Catatan SM: {b.smNote}</> : null}
                </MessageStrip>
                <KeyValues items={[
                    ["Validasi Klaim", labelStatus(b.claimStatus)],
                    ["No Claim", b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : "Belum ada"],
                    ["Deadline klaim", tanggalOpc(b.claimDeadline)],
                    ["Terkunci untuk SPV", b.locked ? "Ya" : "Tidak"],
                    ["Total", <span key="t" className="fi-tnum">{rupiah(total)}</span>],
                    ["Transfer", <span key="tr" className="fi-tnum">{rupiah(transfer)}</span>],
                    ["Tunai", <span key="tu" className="fi-tnum">{rupiah(tunai)}</span>],
                ]} />
                {transfer > 0 && tunai > 0 && (
                    <MessageStrip tone="warn" title="Batch ini memakai lebih dari satu cara bayar.">Pastikan pembayaran sesuai rincian per item.</MessageStrip>
                )}
                {bisa && (
                    <>
                        <FormField label="Catatan OM" help="Wajib bila batch dibatalkan; boleh kosong saat menyetujui.">
                            {(a) => <textarea {...a} className="fi-input" rows={3} value={catatan} disabled={Boolean(alasanSetuju && alasanBatal)}
                                placeholder="Tulis alasan bila batch dibatalkan" onChange={(e) => setCatatan(e.target.value)} />}
                        </FormField>
                        {dirty && <span><StatusBadge tone="warn">Belum dikirim</StatusBadge></span>}
                        <VariantNote bl="D-01">
                            Hari ini satu izin keputusan OM di server membolehkan Setujui dan Batalkan sekaligus. Bila D-01 (matriks kewenangan) diputuskan,
                            tiap tombol mengikuti izinnya sendiri.
                        </VariantNote>
                        <VariantNote bl="BL-06">
                            Tombol keputusan hanya tampil untuk batch yang disetujui Klaim dan menunggu OM. Server hari ini memeriksa tahapnya dengan
                            aturannya sendiri; usulan: satu aturan transisi dipakai layar dan server.
                        </VariantNote>
                    </>
                )}
            </div>
        ),
    }];

    const aksi = bisa ? (
        <>
            <Button variant="negative" icon={<X className="fi-icon" aria-hidden />} disabled={Boolean(alasanBatal)} disabledReason={alasanBatal}
                onClick={() => setDialog("batal")}>Batalkan…</Button>
            <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(alasanSetuju)} disabledReason={alasanSetuju}
                onClick={() => setDialog("omok")}>Setujui…</Button>
        </>
    ) : undefined;
    const pesanFooter = !bisa ? undefined : alasanSetuju && alasanBatal ? alasanSetuju : dirty ? "Catatan OM belum dikirim." : `${n} item · ${rupiah(total)}`;
    const faktaBatch: Array<[string, string]> = [
        ["Principal", `${b.principleName} (${b.principleCode})`],
        ["Total", `${rupiah(total)} · ${n} item`],
    ];

    return (
        <>
            <ObjectPageBatch {...props} bagian={bagian} aksi={aksi} pesanFooter={pesanFooter} draf={dirty}
                strip={pesan ? <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} /> : undefined} />
            <ConfirmDialog
                open={dialog === "omok"}
                onClose={() => setDialog(null)}
                tag="Keputusan OM"
                title={`Setujui ${no}?`}
                facts={[
                    ...faktaBatch,
                    ["Validasi klaim", `${labelStatus(b.claimStatus)} · No Claim ${b.noClaim || "belum ada"} · deadline ${tanggalOpc(b.claimDeadline)}`],
                    ["Cara bayar", `Transfer ${rupiah(transfer)} · Tunai ${rupiah(tunai)}`],
                    ["Catatan OM", catatan.trim() || "Tanpa catatan"],
                    ["Langkah berikutnya", `Pembayaran oleh Keuangan, batas ${SLA_DAYS.paymentAfterDeadline} hari kerja setelah deadline klaim`],
                ]}
                confirmLabel="Setujui"
                onConfirm={async () => {
                    // Payload sama dengan decideOm("approve") lama: catatan apa adanya (boleh kosong).
                    await tulisOpc(`/api/off-program-control/batches/${enc(batchId)}/om-decision`, { body: { action: "approve", note: catatan }, gagal: "Gagal memproses keputusan OM." });
                    setCatatan("");
                    setDialog(null);
                    props.selesai(`${no} disetujui OM dan diteruskan ke Keuangan.`);
                }}
            />
            <ConfirmDialog
                open={dialog === "batal"}
                onClose={() => setDialog(null)}
                tag="Tidak bisa diulang"
                tone="negative"
                title={`Batalkan ${no}?`}
                facts={faktaBatch}
                confirmLabel="Batalkan batch"
                cancelLabel="Kembali"
                confirmDisabled={catatan.trim() ? undefined : "Isi alasan pembatalan dulu"}
                onConfirm={async () => {
                    // decideOm("cancel") lama: catatan wajib (dicek setelah trim), dikirim apa adanya; server juga menolak catatan kosong.
                    await tulisOpc(`/api/off-program-control/batches/${enc(batchId)}/om-decision`, { body: { action: "cancel", note: catatan }, gagal: "Gagal memproses keputusan OM." });
                    setCatatan("");
                    setDialog(null);
                    // Bukan props.selesai: batch tidak pindah ke tahap berikutnya, alurnya berhenti.
                    setPesan(`${no} dibatalkan. Alur batch berhenti di tahap OM.`);
                    props.muatUlang();
                    daftar.muatUlang();
                }}
            >
                <MessageStrip tone="neg" title="Pembatalan bersifat akhir.">Batch dikunci dan tidak berlanjut ke pembayaran Keuangan.</MessageStrip>
                <FormField label="Alasan pembatalan" required help="Teks yang sama dengan Catatan OM di halaman batch.">
                    {(a) => <textarea {...a} className="fi-input" rows={3} value={catatan} placeholder="Mis. program dihentikan principal; surat pencabutan terlampir."
                        onChange={(e) => setCatatan(e.target.value)} />}
                </FormField>
            </ConfirmDialog>
        </>
    );
}

/** LiveQueueSummaryPanel lama (7228–7322): predikat disalin apa adanya (tidak semuanya sama persis dengan PREDIKAT antrean). */
const ANTREAN_LANGSUNG: Array<{ judul: string; ket: string; cocok: (b: BatchOpc) => boolean }> = [
    { judul: "Draf / dikembalikan ke SPV", ket: "Batch masih bisa diubah Supervisor.", cocok: PREDIKAT.spvAntrean },
    { judul: "Menunggu tinjauan SM", ket: "Menunggu validasi benar/salah data batch.", cocok: PREDIKAT.smAntrean },
    {
        judul: "Menunggu validasi Klaim", ket: "Klaim mengecek data dan syarat secara manual.",
        cocok: (b) => b.smStatus === "Approved by SM" && !["Approved", "Returned"].includes(b.claimStatus)
            && !["Cancelled", "Completed", "Claim Approved", "Returned by Claim"].includes(b.status),
    },
    { judul: "Menunggu persetujuan OM", ket: "Disetujui Klaim, menunggu OM.", cocok: PREDIKAT.omAntrean },
    { judul: "Menunggu pembayaran Keuangan", ket: "Sudah disetujui OM, menunggu pembayaran.", cocok: PREDIKAT.keuanganBisaBayar },
    { judul: "Menunggu verifikasi final Klaim", ket: "Sudah dibayar, verifikasi final Klaim.", cocok: (b) => b.status === "Paid" && b.financeStatus === "Paid" && b.finalStatus !== "Completed" },
    { judul: "Selesai", ket: "Alur batch sudah selesai.", cocok: (b) => b.status === "Completed" || b.finalStatus === "Completed" },
];

/** Angka per antrean dari daftar yang dimuat. Tidak tampil sebelum daftar termuat (galat ≠ nol). */
function AntreanLangsung({ daftar }: PeranProps) {
    if (!daftar.load.data) return null;
    return (
        <div className="fi-kcards" role="group" aria-label="Ringkasan antrean langsung" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
            {ANTREAN_LANGSUNG.map((a) => (
                <div key={a.judul} className="fi-kc"><span>{a.judul}</span><b>{daftar.batches.filter(a.cocok).length}</b><small>{a.ket}</small></div>
            ))}
        </div>
    );
}

export default function Om(props: PeranProps) {
    return <KerjaPeran {...props} tampilan={TAMPILAN.om} Detail={DetailOm} atas={<AntreanLangsung {...props} />} />;
}
