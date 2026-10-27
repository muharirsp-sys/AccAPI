/*
 * Tujuan: Modul peran Sales Manager OFF Program Control (Fiori S4d, tab `sales`, layar it03 `sm`): antrean "Menunggu Anda"
 *   (isSmActionableBatch) + Semua (hasPassedSalesManager), ringkasan angka SM (label-nilai) + pengingat kelengkapan belum lengkap, dan Object Page
 *   batch dengan tinjauan SM: catatan untuk SPV (draf), kelengkapan awal dari SPV, Setujui & teruskan ke Klaim (dialog `smok`) dan
 *   Kembalikan ke SPV (dialog `kembali`, alasan wajib), notifikasi OM hasil persetujuan, dan pengajuan pengembalian selisih.
 * Caller: OpcApp.tsx (MODUL.sales).
 * Dependensi: opc/Bersama (KerjaPeran, tulisOpc, tanganiTulis, kontrak), opc/ObjectPageBatch (slot), opc/peran/SmRefund, components/fiori,
 *   lib/opc-ui (TAMPILAN, PREDIKAT), lib/off-program-control/problematic (SLA_DAYS), lib/promo-ui (rupiah), lib/tampil (KOSONG).
 * Main Functions: Sm, DetailSm, RingkasanSm, KelengkapanAwal.
 * Side Effects: POST /api/off-program-control/batches/[id]/sm-approve {note} dan /sm-return {note} (payload sama dengan approveBatch dan
 *   returnToSupervisor kode lama); POST /refund lewat SmRefund. Setelah berhasil: muat ulang daftar dan detail; hasil tidak pasti:
 *   strip bertahan + muat ulang (laporTidakPasti).
 */
"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { SLA_DAYS } from "@/lib/off-program-control/problematic";
import { PREDIKAT, TAMPILAN, jumlahItem, labelStatus, totalBatch, waktuWita, type ItemOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { KerjaPeran, tanganiTulis, tulisOpc, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";
import { AjukanRefund } from "./SmRefund";

const enc = encodeURIComponent;

/** Label tombol footer: lengkap di layar lebar, pendek di ponsel (< 640 px) supaya dua tombol muat; nama aksesibel tetap lengkap (aria-label). */
const labelPonsel = (penuh: string, pendek: string) => <><span className="hidden sm:inline">{penuh}</span><span className="sm:hidden">{pendek}</span></>;

/** Respons sm-approve: pemberitahuan tiruan untuk OM (type mock_om_email, status sent_mock — tidak dikirim lewat email). */
type Notifikasi = { to?: string; subject?: string; message?: string; status?: string };

/** Kolom kedua SM: Object Page + catatan (draf) + aksi tinjauan bila batch menunggu SM. */
function DetailSm(props: DetailProps) {
    const { ctx, daftar, batchId, ringkas, detail } = props;
    const { setDraf } = ctx;
    const [catatan, setCatatan] = useState("");
    const [dialog, setDialog] = useState<"smok" | "kembali" | null>(null);
    const [notif, setNotif] = useState<Notifikasi | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const [refundDraf, setRefundDraf] = useState(false);
    const dirty = catatan.trim() !== "" || refundDraf;
    useEffect(() => { setDraf(dirty); return () => setDraf(false); }, [dirty, setDraf]);

    const data = detail.data;
    if (!data) return <ObjectPageBatch {...props} />;
    const b = data.batch;
    const no = b.noPengajuan;
    // BL-06 (lebih ketat = aman): aksi hanya bila baris detail DAN baris daftar terbaru (polling) masih menunggu SM.
    const bisa = PREDIKAT.smAntrean(b) && (!ringkas || PREDIKAT.smAntrean(ringkas));
    const alasanUji = data.uji ? "Batch data uji (mock) tidak bisa diproses." : undefined;
    const alasanSetuju = alasanUji ?? ctx.izin("sm_approve");
    const alasanKembali = alasanUji ?? ctx.izin("sm_return");
    // Dialog yang masih terbuka sesudah hasil tidak pasti: konfirmasi terkunci selama detail dimuat ulang atau bila batch sudah pindah tahap.
    const kunciDialog = detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
        : detail.status === "galat" ? "Detail batch gagal dimuat ulang; status di layar bisa usang. Muat ulang dulu."
            : !bisa ? "Batch tidak lagi menunggu tinjauan Sales Manager." : undefined;
    const n = data.items.length || jumlahItem(b);
    const total = Number(data.summary?.totalNominal ?? totalBatch(b));
    const sisaRefund = data.refund.data?.summary?.remainingRefund ?? 0;

    const bagian: BagianTambahan[] = [];
    if (bisa) {
        bagian.push({
            id: "opc-sm-catatan", label: "Catatan untuk SPV",
            isi: (
                <div className="fi-sect-in">
                    <FormField label="Catatan Sales Manager" help="Wajib bila batch dikembalikan ke SPV; boleh kosong saat menyetujui. Saat disetujui, catatan tampil untuk Klaim dan OM sebagai Catatan SM.">
                        {(a) => <textarea {...a} className="fi-input" rows={3} value={catatan} disabled={Boolean(alasanSetuju && alasanKembali)}
                            placeholder="Tulis alasan bila batch dikembalikan" onChange={(e) => setCatatan(e.target.value)} />}
                    </FormField>
                    {catatan.trim() && <span><StatusBadge tone="warn">Belum dikirim</StatusBadge></span>}
                    <VariantNote bl="BL-06">
                        Tombol tinjauan hanya tampil untuk batch yang dikirim ke SM dan masih menunggu tinjauan. Server hari ini memeriksa tahapnya
                        dengan aturannya sendiri; usulan: satu aturan transisi dipakai layar dan server.
                    </VariantNote>
                </div>
            ),
        });
    }
    bagian.push({ id: "opc-sm-kelengkapan", label: "Kelengkapan awal dari SPV", isi: <KelengkapanAwal items={data.items} uji={data.uji} /> });
    if (sisaRefund > 0) {
        bagian.push({
            id: "opc-sm-refund", label: "Ajukan pengembalian selisih", letak: "akhir",
            isi: (
                <AjukanRefund batchId={batchId} no={no} ringkasan={data.refund.data!.summary!} alasan={alasanUji ?? ctx.izin("submit_refund")}
                    onDraf={setRefundDraf} onSelesai={(p) => { setPesan(p); props.muatUlang(); daftar.muatUlang(); }} onTidakPasti={props.laporTidakPasti} />
            ),
        });
    }

    let aksi;
    let pesanFooter;
    if (bisa) {
        pesanFooter = alasanSetuju && alasanKembali ? alasanSetuju : catatan.trim() ? "Catatan belum dikirim." : "Periksa item dan kelengkapan awal sebelum memutuskan.";
        aksi = (
            <>
                <Button variant="negative" icon={<RotateCcw className="fi-icon" aria-hidden />} disabled={Boolean(alasanKembali)} disabledReason={alasanKembali}
                    aria-label="Kembalikan ke SPV…" onClick={() => setDialog("kembali")}>{labelPonsel("Kembalikan ke SPV…", "Kembalikan…")}</Button>
                <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(alasanSetuju)} disabledReason={alasanSetuju}
                    onClick={() => setDialog("smok")}>Setujui…</Button>
            </>
        );
    } else {
        const berikut = daftar.batches.find((x) => x.id !== batchId && PREDIKAT.smAntrean(x));
        if (berikut) {
            pesanFooter = "Tidak ada aksi untuk Anda di batch ini.";
            aksi = <Button icon={<ChevronRight className="fi-icon" aria-hidden />} onClick={() => ctx.bukaBatch(berikut.id)}>Batch berikutnya</Button>;
        }
    }

    const strip = (
        <>
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {notif && (
                // Pemberitahuan tiruan (sent_mock): OM belum menerima apa pun, jadi bukan nada sukses.
                <MessageStrip tone="warn" title="Notifikasi OM belum terkirim (tiruan)." onClose={() => setNotif(null)}>
                    {[notif.subject, notif.to && `ke ${notif.to}`, notif.status === "sent_mock" ? "tiruan, tidak dikirim lewat email" : labelStatus(notif.status)].filter(Boolean).join(" · ")}.
                    {notif.message ? ` ${notif.message}` : ""}
                </MessageStrip>
            )}
        </>
    );

    const faktaBatch: Array<[string, string]> = [
        ["SPV", b.supervisorName || KOSONG],
        ["Principal", `${b.principleName} (${b.principleCode})`],
        ["Item", `${n} · ${rupiah(total)}`],
    ];

    return (
        <>
            <ObjectPageBatch {...props} bagian={bagian} strip={strip} aksi={aksi} pesanFooter={pesanFooter} draf={dirty} />
            <ConfirmDialog
                open={dialog === "smok"}
                onClose={() => setDialog(null)}
                tag="Tinjauan SM"
                title={`Setujui ${no} dan teruskan ke Klaim?`}
                description="Setelah disetujui, batch terkunci untuk SPV. Perubahan hanya lewat pengembalian oleh Klaim."
                facts={[
                    ...faktaBatch,
                    ["Catatan SM", catatan.trim() || "Tanpa catatan"],
                    ["Langkah berikutnya", `Validasi Klaim, batas ${SLA_DAYS.claimApproval} hari kerja`],
                    ["Notifikasi", "Dicatat sebagai tiruan untuk Operational Manager; tidak dikirim lewat email"],
                ]}
                confirmLabel="Setujui"
                confirmDisabled={kunciDialog}
                onConfirm={async () => {
                    // Payload sama dengan approveBatch lama: catatan apa adanya (boleh kosong).
                    const hasil = await tulisOpc(`/api/off-program-control/batches/${enc(batchId)}/sm-approve`, { body: { note: catatan }, gagal: "Gagal menyetujui batch." })
                        .catch(tanganiTulis(props.laporTidakPasti, () => setDialog(null)));
                    setNotif((hasil.notification as Notifikasi | undefined) ?? null);
                    setCatatan("");
                    setDialog(null);
                    props.selesai(`${no} disetujui dan diteruskan ke Klaim.`);
                }}
            />
            <ConfirmDialog
                open={dialog === "kembali"}
                onClose={() => setDialog(null)}
                tag="Alasan wajib"
                tone="negative"
                title={`Kembalikan ${no} ke SPV?`}
                description="Batch dibuka lagi untuk SPV pembuatnya. Alasan tampil di atas batch dan tercatat di Riwayat."
                facts={faktaBatch}
                confirmLabel="Kembalikan ke SPV"
                confirmDisabled={kunciDialog ?? (catatan.trim() ? undefined : "Isi alasan pengembalian dulu")}
                onConfirm={async () => {
                    // returnToSupervisor lama: catatan wajib, dikirim setelah trim (server juga menolak catatan kosong).
                    await tulisOpc(`/api/off-program-control/batches/${enc(batchId)}/sm-return`, { body: { note: catatan.trim() }, gagal: "Gagal mengembalikan batch ke Supervisor." })
                        .catch(tanganiTulis(props.laporTidakPasti, () => setDialog(null)));
                    setCatatan("");
                    setNotif(null);
                    setDialog(null);
                    props.selesai(`${no} dikembalikan ke SPV.`, "Batch kembali ke antrean Supervisor untuk diperbaiki.");
                }}
            >
                <FormField label="Alasan pengembalian" required help="Teks yang sama dengan Catatan untuk SPV di halaman batch.">
                    {(a) => <textarea {...a} className="fi-input" rows={3} value={catatan} placeholder="Mis. foto display belum ada; lengkapi sebelum dikirim ulang."
                        onChange={(e) => setCatatan(e.target.value)} />}
                </FormField>
            </ConfirmDialog>
        </>
    );
}

const DOK = [["kwt", "KWT"], ["skp", "SKP"], ["fp", "FP"], ["pc", "PC"], ["foto", "Foto"], ["rekap", "Rekap"], ["others", "Lainnya"]] as const;
const dokumen = (i: ItemOpc, ada: boolean) => DOK.filter(([k]) => Boolean(i[k]) === ada).map(([, l]) => l).join(", ") || KOSONG;

/** Kelengkapan awal per item dari SPV (baca-saja). Validasi kelengkapan tetap dilakukan Klaim. */
function KelengkapanAwal({ items, uji }: { items: ItemOpc[]; uji: boolean }) {
    const kolom: Column<ItemOpc>[] = [
        { key: "item", header: "No Surat · toko", cell: (i) => <><span className="fi-mono">{i.noSurat || `Item ${i.itemNo}`}</span><br />{i.toko || KOSONG}</> },
        { key: "ada", header: "Ada", cell: (i) => dokumen(i, true) },
        { key: "belum", header: "Belum ada", cell: (i) => dokumen(i, false) },
        { key: "lain", header: "Keterangan lainnya", secondary: true, cell: (i) => i.othersText || KOSONG },
    ];
    return (
        <>
            <p className="fi-sect-in fi-small fi-subtle">Informasi awal dari Supervisor. Validasi kelengkapan tetap dilakukan oleh Klaim.</p>
            <ResponsiveTable title="Kelengkapan awal per item" columns={kolom} rows={items} rowKey={(i) => i.id}
                empty={{ title: uji ? "Item tidak dimuat untuk data uji" : "Batch ini tidak punya item" }}
                mobileItem={(i) => (
                    <ListItem doc={i.noSurat || `Item ${i.itemNo}`} title={i.toko || KOSONG}
                        meta={[`Ada: ${dokumen(i, true)}`, `Belum: ${dokumen(i, false)}`, i.othersText].filter(Boolean).join(" · ")} />
                )} />
        </>
    );
}

/**
 * Angka SM (metrik kode lama) sebagai label-nilai kecil + pengingat kelengkapan belum lengkap (owner 27 Okt, audit No 104). Angka inti
 * ("Menunggu Anda") dan jumlah semua batch sudah ada di pilihan antrean, jadi tidak diulang di sini. Tidak tampil sebelum daftar termuat.
 */
function RingkasanSm({ ctx, daftar }: PeranProps) {
    if (!daftar.load.data) return null;
    const lewat = daftar.batches.filter(PREDIKAT.smPantau);
    const kurang = lewat.filter((b) => b.finalStatus === "Incomplete Documents");
    const angka: Array<[string, number]> = [
        ["Disetujui SM", lewat.filter((b) => b.smStatus === "Approved by SM").length],
        ["Dikembalikan SM", lewat.filter((b) => b.smStatus === "Returned").length],
    ];
    return (
        <>
            <div className="fi-panel" role="group" aria-label="Ringkasan Sales Manager" style={{ maxWidth: "24rem" }}>
                <KeyValues items={angka.map(([label, nilai]) => [label, <span key={label} className="fi-tnum">{nilai}</span>])} />
            </div>
            {kurang.length > 0 && (
                <section className="fi-sect" aria-label="Pengingat kelengkapan belum lengkap">
                    <header><h2>Pengingat kelengkapan belum lengkap</h2><span>{kurang.length} batch · dari verifikasi final Klaim</span></header>
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Batch dengan kelengkapan belum lengkap">
                        {kurang.map((b) => (
                            <li key={b.id}>
                                <ListItem doc={b.noPengajuan} title={b.principleName}
                                    meta={[b.finalClaimNote || "Tanpa catatan Klaim", `diperbarui ${waktuWita(b.updatedAt)}`].join(" · ")}
                                    badge={<StatusBadge tone="warn">{labelStatus(b.finalStatus)}</StatusBadge>} href={ctx.hrefBatch(b.id)} onClick={() => ctx.bukaBatch(b.id)} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </>
    );
}

export default function Sm(props: PeranProps) {
    return <KerjaPeran {...props} tampilan={TAMPILAN.sales} Detail={DetailSm} atas={<RingkasanSm {...props} />} />;
}
