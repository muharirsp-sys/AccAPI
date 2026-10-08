/*
 * Tujuan: Modul peran Klaim OFF Program Control (Fiori S4d, tab `claim`): tiga tampilan (claimView) — Validasi setelah SM, Verifikasi
 *   final (`claimView=after|after-finance|final`, tautan Claim Workflow), Batch Claim (CLM) — dan Object Page batch dengan aksi Klaim:
 *   isi validasi + Setujui klaim (`claimok`) / setuju batch buatan sendiri (`sendiri`, BL-10) / Kembalikan (`kembali`, alasan wajib),
 *   verifikasi final + Selesaikan / Ingatkan kelengkapan, Kirim CLM ke SM, buka/buat Claim Workflow. Form CLM baru di kolom kedua (`clm=baru`).
 * Caller: OpcApp.tsx (MODUL.claim).
 * Dependensi: opc/Bersama (KerjaPeran, tulisOpc, kontrak), opc/ObjectPageBatch (slot bagian/strip/aksi/draf), opc/peran/KlaimFinal,
 *   opc/peran/KlaimClm, lib/opc-ui (PREDIKAT, TAMPILAN, tahapBatch), components/fiori/{core,interactive}, lib/promo-ui, next/navigation.
 * Main Functions: Klaim, DetailKlaim, bisaValidasi, bisaFinal, bukaAtauBuatClaimWorkflow.
 * Side Effects: POST /api/off-program-control/batches/[id]/claim-review (approve/return; payload SAMA dengan approveByClaim/returnByClaim
 *   kode lama 5573–5664), POST /batches/[id]/final-claim (complete/remind_incomplete_documents, kode lama 5665–5818), POST /batches/[id]/submit
 *   (CLM, kode lama 7048–7063), POST /api/claim-workflow/from-off-batch/[id] (kode lama 5508–5545) lalu router.push ke Claim Workflow.
 */
"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BellRing, Check, ExternalLink, Plus, Send, Undo2 } from "lucide-react";
import { Button, MessageStrip, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { PREDIKAT, TAMPILAN, infoTahap, jumlahItem, periodeBatch, tahapBatch, tanggalOpc, totalBatch, type BatchOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KerjaPeran, tulisOpc, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";
import { FormClm } from "./KlaimClm";
import { BagianFinal, awalFinal, kekuranganFinal, payloadSelesai, perkiraanSelisih, uangFinal, type IsianFinal } from "./KlaimFinal";

const enc = encodeURIComponent;

/**
 * Perubahan #7 (BL-06): aksi Validasi hanya untuk batch di antrean Klaim lama (isClaimQueueBatch) YANG tahapnya memang Klaim. Batch yang
 * sudah disetujui OM, dibayar, selesai, atau dibatalkan tidak lagi mendapat Kembalikan/Setujui walau sumbu statusnya tidak konsisten
 * (mis. "Cancelled by OM" tidak ada di daftar pengecualian lama). Lebih ketat dari kode lama; server belum (VariantNote).
 */
export const bisaValidasi = (b: BatchOpc) => PREDIKAT.klaimAntrean(b) && tahapBatch(b) === "klaim";
/** isFinalClaimProcessable (kode lama 5837) + bukan batch dibatalkan/dikembalikan (BL-06). */
export const bisaFinal = (b: BatchOpc) => PREDIKAT.finalAntrean(b) && tahapBatch(b) === "final";
/** "Submit ke SM" CLM hanya untuk Draf (kode lama 7099). */
const bisaKirimClm = (b: BatchOpc) => PREDIKAT.clmAntrean(b) && tahapBatch(b) === "draf";

/** Antrean "Menunggu Anda" = batch yang benar-benar punya aksi (BL-06); "Semua" tetap daftar pemantauan lama (klaimPantau/finalPantau). */
const TAMPILAN_KLAIM = TAMPILAN.claim.map((t) => (t.kunci === "after-sm" ? { ...t, antrean: bisaValidasi } : t.kunci === "after-finance" ? { ...t, antrean: bisaFinal } : t));

const KELENGKAPAN = ["Lengkap", "Kurang", "Revisi"] as const;
type IsianValidasi = { tanggal: string; deadline: string; kelengkapan: string; catatan: string };
// #12: kelengkapan direset ke "Lengkap" tiap batch dibuka (Detail dipasang ulang per batch), tanggal/catatan dari batch (kode lama 5341–5346).
const awalValidasi = (b: BatchOpc): IsianValidasi => ({ tanggal: b.claimSubmittedDate || "", deadline: b.claimDeadline || "", kelengkapan: "Lengkap", catatan: b.claimNote || "" });
const samaValidasi = (a: IsianValidasi, b: IsianValidasi) => a.tanggal === b.tanggal && a.deadline === b.deadline && a.kelengkapan === b.kelengkapan && a.catatan === b.catatan;

/** POST from-off-batch (openOrCreateClaimWorkflow kode lama 5508–5545): baru → id; 409 CLAIM_WORKFLOW_ALREADY_EXISTS → id yang ada. */
async function bukaAtauBuatClaimWorkflow(batchId: string): Promise<string> {
    const res = await fetch(`/api/claim-workflow/from-off-batch/${enc(batchId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { data = { error: text }; }
    const wf = data.workflow as { id?: string } | undefined;
    if (res.ok && data.ok && wf?.id) return wf.id;
    if (res.status === 409 && data.code === "CLAIM_WORKFLOW_ALREADY_EXISTS" && wf?.id) return wf.id;
    throw new Error(String(data.error || "Gagal membuka Claim Workflow."));
}

type Dialog = "claimok" | "sendiri" | "kembali" | "selesai" | "ingatkan" | "kirimclm" | "cw" | null;

/** Kolom kedua Klaim: form menurut keadaan batch (bukan tampilan), aksi lewat dialog, draf = isian belum dikirim. */
function DetailKlaim(props: DetailProps) {
    const { ctx, daftar, detail, ringkas, selesai, muatUlang } = props;
    const router = useRouter();
    const idKl = useId();
    const data = detail.data;
    const b = data?.batch;
    // BL-06: aksi hanya bila detail DAN baris daftar terbaru (polling) sama-sama sah — server claim-review hanya memeriksa "sudah
    // disetujui SM" (tetap benar sampai lunas), jadi detail usang tidak boleh membuka Kembalikan untuk batch yang sudah lewat Klaim.
    const sah = (p: (x: BatchOpc) => boolean) => Boolean(b) && p(b!) && (!ringkas || p(ringkas));
    const mode = sah(bisaValidasi) ? "validasi" : sah(bisaFinal) ? "final" : sah(bisaKirimClm) ? "clm" : "baca";
    // Detail berkata sah tetapi daftar terbaru tidak: detail usang → tanpa aksi + ajakan muat ulang.
    const usang = Boolean(b && ringkas) && [bisaValidasi, bisaFinal, bisaKirimClm].some((p) => p(b!) && !p(ringkas!));

    const [isian, setIsian] = useState<IsianValidasi | null>(null);
    const awal = b ? awalValidasi(b) : null;
    const nilai = isian ?? awal ?? { tanggal: "", deadline: "", kelengkapan: "Lengkap", catatan: "" };
    const ubah = (patch: Partial<IsianValidasi>) => setIsian({ ...nilai, ...patch });

    const awalF = useMemo(() => (data ? awalFinal(data) : null), [data]);
    const [isianF, setIsianF] = useState<IsianFinal | null>(null);
    const nilaiF = isianF ?? awalF;
    const ubahF = (f: (x: IsianFinal) => IsianFinal) => setIsianF((cur) => { const dasar = cur ?? awalF; return dasar ? f(dasar) : cur; });

    const drafV = mode === "validasi" && isian !== null && awal !== null && !samaValidasi(isian, awal);
    const drafF = mode === "final" && isianF !== null && JSON.stringify(isianF) !== JSON.stringify(awalF);
    const dirty = drafV || drafF;
    const { setDraf } = ctx;
    useEffect(() => { setDraf(dirty); }, [dirty, setDraf]);
    useEffect(() => () => setDraf(false), [setDraf]);

    const [dialog, setDialog] = useState<Dialog>(null);
    const [alasan, setAlasan] = useState("");
    const tutup = () => setDialog(null);

    if (!data || !b) return <ObjectPageBatch {...props} />;

    const no = b.noPengajuan;
    const dasar = `/api/off-program-control/batches/${enc(b.id)}`;
    const total = Number(data.summary?.totalNominal ?? totalBatch(b));
    const itemFakta = `${data.items.length || jumlahItem(b)} item · ${rupiah(total)}`;
    const tahap = tahapBatch(b);
    // BL-10 mode lunak: pembuat batch (mis. CLM buatan Klaim) boleh menyetujui sendiri setelah konfirmasi khusus.
    const sendiri = Boolean(ctx.pengguna.id) && b.createdBy === ctx.pengguna.id;
    const izinReview = ctx.izin("claim_review");
    const izinFinal = ctx.izin("claim_final");
    const izinKirim = ctx.izin("submit_batch");
    // Selama detail dimuat ulang (mis. sesudah aksi) atau gagal dimuat ulang (yang tampil = hasil sebelumnya), semua aksi status terkunci.
    const kunci = data.uji ? "Batch data uji (mock) tidak bisa diproses."
        : detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
            : detail.status === "galat" ? "Detail batch gagal dimuat ulang; status di layar bisa usang. Muat ulang dulu."
                : undefined;
    const muatSemua = () => { daftar.muatUlang(); muatUlang(); };
    const cwId = b.claimWorkflowId ?? ringkas?.claimWorkflowId ?? null;
    // Claim Workflow boleh dibuat setelah OM menyetujui (aturan route from-off-batch); batch dibatalkan tidak (BL-06).
    const cwBoleh = b.omStatus === "Approved" && tahap !== "dibatalkan";

    // ── Validasi setelah SM ──
    const alasanV = izinReview ?? kunci;
    const syaratSetuju = alasanV ?? (!nilai.tanggal ? "Isi tanggal diajukan ke principal dulu."
        : !nilai.deadline ? "Isi deadline klaim dulu."
            : nilai.kelengkapan !== "Lengkap" ? "Kelengkapan harus Lengkap untuk menyetujui; bila kurang atau perlu revisi, kembalikan batch."
                : !nilai.catatan.trim() ? "Keterangan kelengkapan wajib diisi sebelum Setujui klaim." : undefined);
    const setujui = async () => {
        await tulisOpc(`${dasar}/claim-review`, {
            gagal: "Gagal menyetujui Claim.",
            body: { action: "approve", claimSubmittedDate: nilai.tanggal, claimDeadline: nilai.deadline, completenessStatus: nilai.kelengkapan, note: nilai.catatan },
        });
        tutup();
        setIsian(null);
        selesai(`Klaim ${no} disetujui dan diteruskan ke OM.`);
    };
    const kembalikan = async () => {
        await tulisOpc(`${dasar}/claim-review`, {
            gagal: "Gagal mengembalikan dari Claim.",
            body: { action: "return", note: alasan, completenessStatus: nilai.kelengkapan },
        });
        tutup();
        setIsian(null);
        selesai(`${no} dikembalikan untuk diperbaiki.`, b.createdByRole === "claim" ? "Batch kembali ke pembuat CLM-nya (divisi Klaim)." : "Batch kembali ke SPV pembuatnya.");
    };

    // ── Verifikasi final ──
    const kurangF = mode === "final" && nilaiF ? kekuranganFinal(data, nilaiF) : [];
    const syaratSelesai = izinFinal ?? kunci ?? kurangF[0];
    const syaratIngat = izinFinal ?? kunci ?? (!nilaiF?.catatan.trim() ? "Isi catatan verifikasi final dulu." : undefined);
    const uang = uangFinal(data);
    const lebih = nilaiF ? perkiraanSelisih(uang.dibayar, nilaiF.nilaiFix) : 0;
    const selesaikan = async () => {
        const hasil = await tulisOpc(`${dasar}/final-claim`, { gagal: "Gagal menyelesaikan final Claim.", body: payloadSelesai(data, nilaiF!) });
        tutup();
        setIsianF(null);
        const sisaSelisih = Number(hasil.overpaidAmount || 0);
        selesai(sisaSelisih > 0 ? `Verifikasi final ${no} selesai; selisih ${rupiah(sisaSelisih)} perlu dikembalikan.` : `Verifikasi final ${no} selesai.`);
    };
    const ingatkan = async () => {
        await tulisOpc(`${dasar}/final-claim`, { gagal: "Gagal mengirim pengingat kelengkapan.", body: { action: "remind_incomplete_documents", note: nilaiF!.catatan } });
        tutup();
        // Isian No Claim/checklist TIDAK ikut tersimpan oleh pengingat, jadi dibiarkan (tetap draf) agar tidak hilang.
        selesai(`Pengingat kelengkapan ${no} tampil untuk Sales Manager dan Supervisor.`, "Batch tetap menunggu verifikasi final Klaim.");
    };

    // ── CLM + Claim Workflow ──
    const kirimClm = async () => {
        await tulisOpc(`${dasar}/submit`, { gagal: "Gagal submit ke SM.", body: {} });
        tutup();
        selesai(`${no} dikirim ke SM.`);
    };
    const keCw = (id: string) => router.push(`/claim-workflow/${enc(id)}?focus=no-claim`);
    const klikCw = () => { if (cwId && !dirty) keCw(cwId); else setDialog("cw"); };
    const konfirmCw = async () => {
        const id = cwId ?? (await bukaAtauBuatClaimWorkflow(b.id));
        tutup();
        keCw(id);
    };

    // Claim Workflow = navigasi ke dokumen lanjutan, bukan aksi final batch: di bawah header (footer tetap untuk Setujui/Selesaikan).
    const stripCw = cwBoleh ? (
        <MessageStrip tone="info" title="Claim Workflow:">
            {cwId ? "sudah dibuat untuk batch ini; No Claim diisi di sana. " : "belum dibuat untuk batch ini. "}
            <Button variant="tertiary" icon={<ExternalLink className="fi-icon" aria-hidden />} onClick={klikCw}>{cwId ? "Buka Claim Workflow" : "Buat Claim Workflow…"}</Button>
        </MessageStrip>
    ) : null;
    let aksi: ReactNode = null;
    let pesanFooter: ReactNode;
    if (mode === "validasi") {
        aksi = (
            <>
                <Button variant="negative" icon={<Undo2 className="fi-icon" aria-hidden />} disabled={Boolean(alasanV)} disabledReason={alasanV}
                    onClick={() => { setAlasan(nilai.catatan); setDialog("kembali"); }}>Kembalikan…</Button>
                <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(syaratSetuju)} disabledReason={syaratSetuju}
                    onClick={() => setDialog(sendiri ? "sendiri" : "claimok")}>Setujui klaim…</Button>
            </>
        );
        pesanFooter = syaratSetuju ? `Setujui nonaktif: ${syaratSetuju}` : drafV ? "Isian validasi belum dikirim." : undefined;
    } else if (mode === "final") {
        aksi = (
            <>
                <Button icon={<BellRing className="fi-icon" aria-hidden />} disabled={Boolean(syaratIngat)} disabledReason={syaratIngat} onClick={() => setDialog("ingatkan")}>Ingatkan kelengkapan…</Button>
                <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(syaratSelesai)} disabledReason={syaratSelesai} onClick={() => setDialog("selesai")}>Selesaikan…</Button>
            </>
        );
        pesanFooter = syaratSelesai ? `Selesaikan nonaktif: ${syaratSelesai}` : drafF ? "Isian verifikasi final belum dikirim." : undefined;
    } else if (mode === "clm") {
        const alasanKirim = izinKirim ?? kunci;
        aksi = <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(alasanKirim)} disabledReason={alasanKirim} onClick={() => setDialog("kirimclm")}>Kirim ke SM…</Button>;
        pesanFooter = alasanKirim ? `Kirim nonaktif: ${alasanKirim}` : "Draf CLM: kirim ke Sales Manager bila sudah lengkap.";
    }

    if (mode === "validasi" && kunci && !izinReview) pesanFooter = `Aksi terkunci: ${kunci}`;
    const terminal = ["om", "bayar", "final", "selesai", "dibatalkan"].includes(tahapBatch(usang ? ringkas! : b));
    const strip = mode === "baca" && !data.uji ? (
        <>
            {stripCw}
            {usang ? (
                <MessageStrip tone="warn" title="Status batch berubah.">
                    Daftar terbaru menunjukkan batch ini di tahap {infoTahap(ringkas!).label}; detail di layar usang, jadi aksi Klaim tidak ditampilkan.{" "}
                    <Button variant="tertiary" onClick={muatSemua}>Muat ulang</Button>
                </MessageStrip>
            ) : (
                <MessageStrip tone="info" title="Baca-saja.">
                    Batch ini di tahap {infoTahap(b).label}. Aksi Klaim hanya untuk batch yang menunggu validasi setelah SM, verifikasi final, atau draf CLM.
                </MessageStrip>
            )}
            {terminal && (
                <VariantNote bl="BL-06">Untuk batch yang sudah disetujui OM, dibayar, selesai, atau dibatalkan, Kembalikan/Setujui tidak ditampilkan. Server saat ini hanya
                    memeriksa &quot;sudah disetujui SM&quot;. Usulan: satu aturan transisi untuk UI dan server, transisi ilegal ditolak server.</VariantNote>
            )}
        </>
    ) : stripCw ?? undefined;

    const bagian: BagianTambahan[] = [];
    if (mode === "validasi") {
        bagian.push({
            id: "opc-isi-validasi", label: "Isi validasi", letak: "awal",
            isi: (
                <div className="fi-sect-in">
                    <MessageStrip tone="warn" title="Checklist Supervisor bukan persetujuan.">Klaim wajib melakukan verifikasi nyata sebelum menyetujui.</MessageStrip>
                    {/* #12: catatan Sales Manager tampil agar Klaim tahu keterangan SM. */}
                    {b.smNote && <MessageStrip tone="info" title="Catatan Sales Manager:">{b.smNote}</MessageStrip>}
                    <div className="fi-formgrid">
                        <FormField label="Tanggal diajukan ke principal" required>{(a) => (
                            <input {...a} className="fi-input" type="date" value={nilai.tanggal} onChange={(e) => ubah({ tanggal: e.target.value })} />
                        )}</FormField>
                        <FormField label="Deadline klaim" required>{(a) => (
                            <input {...a} className="fi-input" type="date" value={nilai.deadline} onChange={(e) => ubah({ deadline: e.target.value })} />
                        )}</FormField>
                    </div>
                    <div className="fi-field">
                        <span className="fi-label" id={idKl}>Kelengkapan berkas<span className="fi-req" aria-hidden>*</span></span>
                        <div role="radiogroup" aria-labelledby={idKl} className="fi-btnrow">
                            {KELENGKAPAN.map((k) => (
                                <label key={k} className="fi-check">
                                    <input type="radio" name={`${idKl}-kl`} value={k} checked={nilai.kelengkapan === k} onChange={() => ubah({ kelengkapan: k })} />{k}
                                </label>
                            ))}
                        </div>
                        {nilai.kelengkapan !== "Lengkap" && <p className="fi-help">Hanya &quot;Lengkap&quot; yang bisa disetujui; bila berkas kurang atau perlu revisi, kembalikan batch.</p>}
                    </div>
                    <FormField label="Keterangan kelengkapan" required help="Wajib diisi sebelum Setujui klaim. Saat mengembalikan, isian ini menjadi usulan alasan.">{(a) => (
                        <textarea {...a} className="fi-input" rows={3} value={nilai.catatan} onChange={(e) => ubah({ catatan: e.target.value })} />
                    )}</FormField>
                    <VariantNote bl="BL-06">Kembalikan/Setujui hanya tampil untuk batch yang menunggu validasi Klaim. Server saat ini hanya memeriksa &quot;sudah disetujui SM&quot;.
                        Usulan: server menolak transisi ilegal dengan aturan yang sama.</VariantNote>
                </div>
            ),
        });
    } else if (mode === "final" && nilaiF) {
        bagian.push({ id: "opc-final", label: "Verifikasi final", letak: "awal", isi: <BagianFinal data={data} isian={nilaiF} ubah={ubahF} kurang={kurangF} /> });
    } else if (nilaiF && (PREDIKAT.finalPantau(b) || tahap === "final" || tahap === "selesai")) {
        bagian.push({ id: "opc-final", label: "Verifikasi final", letak: "setelahItem", isi: <BagianFinal data={data} isian={nilaiF} /> });
    }

    const faktaSetuju: Array<[string, ReactNode]> = [
        ["Diajukan ke principal", tanggalOpc(nilai.tanggal)],
        ["Deadline klaim", tanggalOpc(nilai.deadline)],
        ["Kelengkapan", nilai.kelengkapan],
        ["Keterangan", nilai.catatan.trim() || "–"],
        ["Item", <span key="i" className="fi-tnum">{itemFakta}</span>],
        ["Langkah berikutnya", "Persetujuan Operational Manager"],
    ];
    const noteBl11 = (
        <VariantNote bl="BL-11">Kelengkapan dikirim bersama persetujuan dan tercatat di Riwayat, tetapi belum tersimpan di batch. Usulan: tersimpan di batch dan dipakai
            peringatan berkas.</VariantNote>
    );
    const pembuat = b.createdByRole === "claim" ? "pembuat CLM-nya (divisi Klaim)" : "SPV pembuatnya";

    return (
        <>
            <ObjectPageBatch {...props} bagian={bagian} strip={strip} aksi={aksi} pesanFooter={pesanFooter} draf={dirty} />
            <ConfirmDialog open={dialog === "claimok"} onClose={tutup} tag="Setujui" title={`Setujui klaim ${no}?`} confirmLabel="Setujui klaim"
                description="Batch dikunci dan diteruskan ke Operational Manager." facts={faktaSetuju} confirmDisabled={kunci} onConfirm={setujui}>
                {noteBl11}
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "sendiri"} onClose={tutup} tag="Setuju sendiri" title="Setujui batch yang Anda buat sendiri?" confirmLabel="Setujui klaim"
                description="Pembuat dan penyetuju batch ini orang yang sama."
                facts={[["Batch", <span key="b" className="fi-mono">{no}</span>], ["Dibuat oleh", `Anda${ctx.pengguna.nama ? ` (${ctx.pengguna.nama})` : ""}`], ...faktaSetuju]}
                confirmDisabled={kunci} onConfirm={setujui}>
                <MessageStrip tone="info" title="Mode lunak:">tim belum cukup untuk memisahkan pembuat dan penyetuju. Anda boleh menyetujui sendiri; persetujuan tercatat di Riwayat atas nama Anda.</MessageStrip>
                <VariantNote bl="BL-10">Endpoint validasi klaim belum punya isian alasan setuju sendiri yang disimpan, jadi dialog ini hanya konfirmasi. Usulan: alasan wajib,
                    tersimpan, dan muncul di laporan audit.</VariantNote>
                {noteBl11}
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "kembali"} onClose={tutup} tone="negative" tag="Alasan wajib" title={`Kembalikan ${no} untuk diperbaiki?`} confirmLabel="Kembalikan"
                description={`Batch dibuka lagi untuk ${pembuat}. Alasan tampil di atas batch dan tercatat di Riwayat.`}
                facts={[["Item", <span key="i" className="fi-tnum">{itemFakta}</span>], ["Kelengkapan", nilai.kelengkapan]]}
                confirmDisabled={kunci ?? (alasan.trim() ? undefined : "Isi alasan pengembalian dulu")} onConfirm={kembalikan}>
                <FormField label="Alasan pengembalian" required help="Disimpan sebagai catatan Klaim.">{(a) => (
                    <textarea {...a} className="fi-input" rows={3} value={alasan} onChange={(e) => setAlasan(e.target.value)} />
                )}</FormField>
            </ConfirmDialog>
            {/* Owner 8 Okt: verifikasi final batch buatan sendiri juga memakai konfirmasi "sendiri" (BL-10), sama seperti Setujui klaim. */}
            <ConfirmDialog open={dialog === "selesai"} onClose={tutup} tag={sendiri ? "Setuju sendiri" : "Verifikasi final"}
                title={sendiri ? `Selesaikan verifikasi final ${no} yang Anda buat sendiri?` : `Selesaikan verifikasi final ${no}?`} confirmLabel="Selesaikan"
                description={sendiri ? "Pembuat batch dan pemeriksa final orang yang sama. No Claim dan checklist final per item disimpan bersama hasil verifikasi."
                    : "No Claim dan checklist final per item disimpan bersama hasil verifikasi."}
                facts={[
                    ...(sendiri ? [["Dibuat oleh", `Anda${ctx.pengguna.nama ? ` (${ctx.pengguna.nama})` : ""}`] as [string, ReactNode]] : []),
                    ["Dibayar Keuangan", <span key="d" className="fi-tnum">{rupiah(uang.dibayar)}</span>],
                    ["Nilai fix", nilaiF?.nilaiFix.trim() ? <span key="f" className="fi-tnum">{rupiah(Number(nilaiF.nilaiFix.replace(/[^\d.]/g, "")) || uang.dibayar)}</span> : "Sama dengan dibayar"],
                    ["No Claim", `${data.items.filter((i) => i.noSurat).length} No Surat terisi`],
                    ["Akibat", lebih > 0 ? `Selisih ${rupiah(lebih)} masuk Data Selisih; batch menunggu pengembalian selisih.` : "Batch selesai."],
                ]}
                confirmDisabled={kunci} onConfirm={selesaikan}>
                {sendiri && <>
                    <MessageStrip tone="info" title="Mode lunak:">Anda boleh menyelesaikan verifikasi final batch buatan sendiri; hasilnya tercatat di Riwayat atas nama Anda.</MessageStrip>
                    <VariantNote bl="BL-10">Endpoint verifikasi final belum menyimpan alasan setuju sendiri, jadi dialog ini hanya konfirmasi. Owner 8 Okt: alasan
                        wajib dan tersimpan — menunggu perubahan API lewat AM.</VariantNote>
                </>}
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "ingatkan"} onClose={tutup} tag="Pengingat" title={`Kirim pengingat kelengkapan ${no}?`} confirmLabel="Kirim pengingat"
                description="Pengingat tampil di web untuk Sales Manager dan Supervisor; batch tetap menunggu verifikasi final Klaim. No Claim dan checklist yang sudah diisi belum ikut tersimpan."
                facts={[["Catatan", nilaiF?.catatan || "–"], ["Status setelahnya", "Berkas belum lengkap"]]}
                confirmDisabled={kunci} onConfirm={ingatkan} />
            <ConfirmDialog open={dialog === "kirimclm"} onClose={tutup} tag="Kirim" title={`Kirim ${no} ke SM?`} confirmLabel="Kirim ke SM"
                description="PDF surat pengajuan dibuat dan batch masuk antrean Sales Manager."
                facts={[["Principal", b.principleName], ["Periode", periodeBatch(b)], ["Item", <span key="i" className="fi-tnum">{itemFakta}</span>], ["Penerima", "Sales Manager"]]}
                confirmDisabled={kunci} onConfirm={kirimClm} />
            <ConfirmDialog open={dialog === "cw"} onClose={tutup} tag="Claim Workflow" title={cwId ? "Buka Claim Workflow?" : `Buat Claim Workflow untuk ${no}?`}
                confirmLabel={cwId ? "Buka Claim Workflow" : "Buat dan buka"}
                description={cwId ? undefined : "Claim Workflow dibuat dari item batch ini (satu berkas per item) lalu dibuka. Bila sudah ada, yang lama dibuka."}
                facts={[
                    ...(cwId ? [] : [["Nomor", <span key="n" className="fi-mono">CLM/{no}</span>], ["Item", itemFakta], ["Syarat", "Sudah disetujui OM"]] as Array<[string, ReactNode]>),
                    ...(dirty ? [["Isian belum dikirim", "akan hilang saat pindah ke Claim Workflow"]] as Array<[string, ReactNode]> : []),
                ]}
                onConfirm={konfirmCw} />
        </>
    );
}

export default function Klaim(props: PeranProps) {
    const { ctx, daftar } = props;
    const sp = useSearchParams();
    const izinBuat = ctx.izin("create_batch");
    const dataClaim = ctx.sub === "data-claim";
    // Form CLM baru = kunci URL `clm=baru` (claimView dipakai tampilan); batch yang dibuka (`?batch=`) didahulukan.
    const buatClm = dataClaim && sp.get("clm") === "baru" && !ctx.batchId;
    const tutupClm = () => ctx.ubahUrl({ clm: null });
    const atas = dataClaim ? (
        <div className="fi-panel">
            <div className="fi-btnrow">
                <p className="fi-small" style={{ flex: "1 1 18rem" }}>
                    Batch CLM dibuat divisi Klaim dari data direksi (nomor <span className="fi-mono">xxx/CLM/KODE/MM/YYYY</span>). Draf dikirim ke SM dari halaman batchnya.
                </p>
                <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(izinBuat)} disabledReason={izinBuat}
                    onClick={() => ctx.ubahUrl({ clm: "baru", batch: null })}>Buat batch CLM</Button>
            </div>
        </div>
    ) : undefined;
    return (
        <KerjaPeran {...props} tampilan={TAMPILAN_KLAIM} Detail={DetailKlaim} atas={atas}
            kolomKedua={buatClm ? { isi: <FormClm ctx={ctx} daftar={daftar} tutup={tutupClm} />, tutup: tutupClm } : undefined} />
    );
}
