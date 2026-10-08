/*
 * Tujuan: Object Page satu klaim (Fiori S4b): semua bagian terlihat dengan anchor bar (Item, No Claim & dokumen, Pembayaran, Penutupan,
 *   Riwayat, Alur dokumen), satu aksi utama per tahap di footer, dialog yang menyebut akibatnya (pengganti confirm/prompt/klik langsung),
 *   pembaruan di tempat (data lama tetap tampil saat memuat ulang; draf baris lain tidak hilang), konflik versi item dengan muat ulang baris.
 * Caller: app/(dashboard)/claim-workflow/[id]/page.tsx.
 * Dependensi: GET /api/claim-workflow/[id], GET .../audit, POST .../status, POST .../documents/generate-all, PATCH .../items/[itemId],
 *   PATCH .../submissions/[sid], POST .../submissions/[sid]/items, POST .../payments | .../submissions/[sid]/payments,
 *   POST .../payments/[pid]/void | .../submissions/[sid]/payments/[pid]/void, POST .../close | .../submissions/[sid]/close,
 *   GET PDF .../{claim-letter,summary,receipt} dan .../submissions/[sid]/{...}; lib/claim-workflow-ui, lib/claim-workflow/no-claim-rules.
 * Main Functions: ClaimDetail.
 * Side Effects: HTTP baca/tulis di atas (uang: pembayaran klaim). Logic BL-07/08/14/15/33/35/42 tidak ditulis: perilaku hari ini + varian berlabel.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, CircleCheck, Clock, ExternalLink, FileText, Lock, Pencil, RefreshCw, RotateCcw, Send, Wallet } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section,
    Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { ambil, jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { rupiah } from "@/lib/promo-ui";
import { witaToday } from "@/lib/beranda";
import { claimWorkflowStatuses as S, isLegacyPekaStatus } from "@/lib/claim-workflow/constants";
import { buildNoClaimFromRule, getNoClaimRuleVariants, resolveNoClaimRule } from "@/lib/claim-workflow/no-claim-rules";
import {
    DOKUMEN, alurKlaim, hitungBaris, kalimatAudit, pesanGalat, polaTerbaca, statusKlaim, syaratTutup, tahapKlaim, tanggalWita, umurHari,
} from "@/lib/claim-workflow-ui";

import {
    AlurDokumen, FormItemPonsel, aktif, isiItem, judulBerkas, kirimJson, persenTeks, tanpa,
    type AuditRow, type Bagian, type DetailResult, type Dlg, type DrafItem, type DrafNc, type Fakta, type Jawab, type Payment, type Submission, type WorkflowItem,
} from "./klaim";

export default function ClaimDetail({ id, permKeys, focus }: { id: string; permKeys: string[]; focus?: string }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const [detail, muatDetail] = useLoad(useCallback(async (): Promise<Load<DetailResult>> => {
        const r = await ambil<DetailResult>(`/api/claim-workflow/${id}`, (j) => {
            const d = j as DetailResult | null;
            if (!d?.ok || !d.workflow) throw new Error(d?.error || "Gagal memuat detail Claim Workflow.");
            return d;
        });
        return r.status === "galat" ? { ...r, error: pesanGalat("Gagal memuat detail Claim Workflow.", r.error) } : r;
    }, [id]));
    const bolehRiwayat = keys.has("claim_workflow.approve");
    const [audit, muatAudit] = useLoad(useCallback((): Promise<Load<AuditRow[]>> => (!bolehRiwayat ? Promise.resolve({ status: "siap", data: [] })
        : ambil<AuditRow[]>(`/api/claim-workflow/${id}/audit`, (j) => {
            const d = j as { ok?: boolean; error?: string; audit?: AuditRow[] } | null;
            if (!d?.ok) throw new Error(d?.error || "Riwayat tidak tersedia untuk peran ini.");
            return d.audit ?? [];
        })), [id, bolehRiwayat]));
    const muat = () => { muatDetail(); muatAudit(); };

    const [pesan, setPesan] = useState<{ di: Bagian; teks: string } | null>(null);
    const [galat, setGalat] = useState<{ di: Bagian; teks: string } | null>(null);
    const [dialog, setDialog] = useState<Dlg>(null);
    const [drafItem, setDrafItem] = useState<Record<string, DrafItem>>({});
    const [galatItem, setGalatItem] = useState<Record<string, string>>({});
    const [simpanItemId, setSimpanItemId] = useState("");
    const [konflik, setKonflik] = useState<{ itemId: string; at: string | null; nilai: ReturnType<typeof isiItem>; dimuat?: boolean } | null>(null);
    const [drafNc, setDrafNc] = useState<Record<string, DrafNc>>({});
    const [galatNc, setGalatNc] = useState<Record<string, string>>({});
    const [simpanNcId, setSimpanNcId] = useState("");
    const [gabung, setGabung] = useState<{ sub: Submission; target: Submission; noClaim: string } | null>(null);
    const [varian, setVarian] = useState("");
    const [buatDok, setBuatDok] = useState(false);
    const [bayar, setBayar] = useState(() => ({ paymentDate: witaToday(), paymentAmount: "", paymentType: "Transfer", paymentNote: "" }));
    const [bayarBerkas, setBayarBerkas] = useState("");
    const [galatBayar, setGalatBayar] = useState<{ tanggal?: string; nominal?: string }>({});
    const [voidPay, setVoidPay] = useState<Payment | null>(null);
    const [pindah, setPindah] = useState<{ item: WorkflowItem; target: Submission } | null>(null);
    const [tutupBerkas, setTutupBerkas] = useState("");
    const [catatanTutup, setCatatanTutup] = useState("");
    const [baruDitutup, setBaruDitutup] = useState(false);

    const d = detail.data;
    const wf = d?.workflow;
    const items = d?.items ?? [];
    const subs = d?.submissions ?? [];
    const payments = d?.payments ?? [];
    const statusEdit = wf?.status === S.draft || wf?.status === S.needRevision;
    const canManage = Boolean(d?.canEditItems) && !d?.isReadOnly;
    // Gerbang tombol = izin yang dicek rute API + bendera peran dari server (canEditItems = admin/claim), sama dengan halaman lama.
    const bolehUbahItem = canManage && statusEdit && keys.has("claim_workflow.edit");
    const bolehNoClaim = Boolean(d?.canAssignNoClaim) && statusEdit && keys.has("claim_workflow.update");
    const itemBerubah = (it: WorkflowItem) => {
        const dr = drafItem[it.id];
        if (!dr || !bolehUbahItem) return false;
        const v = isiItem(it, dr);
        return v.dpp !== String(it.dpp) || v.ppnRate !== String(it.ppnRate) || v.pphRate !== String(it.pphRate) || v.note !== (it.note || "");
    };
    const ncBerubah = (s: Submission) => { const v = drafNc[s.id]?.noClaim; return bolehNoClaim && v !== undefined && v.trim() !== (s.noClaim ?? ""); };
    const tahap = tahapKlaim(wf?.status);
    const bayarTerisi = Boolean(bayar.paymentAmount.trim() || bayar.paymentNote.trim());
    const belumSimpan = items.some(itemBerubah) || subs.some(ncBerubah);
    const adaDraf = belumSimpan || ((tahap === "dikirim" || tahap === "sebagian") && bayarTerisi) || (tahap !== "ditutup" && catatanTutup.trim() !== "");
    useUnsavedGuard(adaDraf);

    const sudahFokus = useRef(false);
    const adaData = Boolean(wf);
    useEffect(() => {
        if (focus !== "no-claim" || !adaData || sudahFokus.current) return;
        sudahFokus.current = true;
        document.getElementById("no-claim")?.scrollIntoView({ block: "start" });
    }, [focus, adaData]);

    const kepala = [{ label: "Claim Workflow", href: "/claim-workflow" }, { label: "Klaim" }];
    if (detail.status === "memuat" && !d) {
        return (
            <div className="fi-page">
                <ObjectPageHeader breadcrumbs={kepala} title="Memuat klaim…" />
                <div className="fi-panel"><Skeleton rows={8} label="Memuat klaim" /></div>
            </div>
        );
    }
    if (!d || !wf) {
        const tidakAda = /not found|HTTP 404/i.test(detail.error ?? "");
        return (
            <div className="fi-page">
                <ObjectPageHeader breadcrumbs={kepala} title="Klaim" />
                <div className="fi-panel">
                    {tidakAda
                        ? <EmptyState title="Klaim tidak ditemukan" message="Klaim ini tidak ada atau sudah dihapus. Kembali ke daftar klaim untuk mencari nomornya." action={<Link className="fi-btn fi-btn--secondary" href="/claim-workflow">Daftar klaim</Link>} />
                        : <ErrorState title="Klaim gagal dimuat" message={detail.error} onRetry={muat} />}
                </div>
            </div>
        );
    }

    const no = wf.claimWorkflowNo;
    const st = statusKlaim(wf.status);
    const banyakBerkas = Boolean(d.hasMultipleSubmissions);
    const bolehPindah = canManage && statusEdit && subs.length > 1;
    const bolehDokumen = Boolean(d.canGenerateClaimLetter || d.canGenerateSummary || d.canGenerateReceipt) && keys.has("claim_workflow.update");
    const bolehTahap = canManage && keys.has("claim_workflow.approve");
    const bolehBayar = Boolean(d.canRecordPayment) && keys.has("claim_workflow.submit");
    // Batalkan pembayaran & tutup: rute per berkas hanya mengecek peran (admin/claim), rute klaim tunggal mengecek izin (D-01 · AM-026).
    const alasanVoid = !canManage ? "Hanya peran admin atau claim yang dapat membatalkan pembayaran" : !d.canVoidPayment ? "Klaim sudah ditutup" : !banyakBerkas && !keys.has("claim_workflow.update") ? "Butuh izin ubah Claim Workflow" : "";
    const bolehTutupPeran = canManage && (banyakBerkas || keys.has("claim_workflow.approve"));
    const nomor = new Map(items.map((it, i) => [it.id, i + 1]));
    const subOf = (sid?: string | null) => subs.find((s) => s.id === sid);
    const aktifSubs = subs.filter(aktif);
    const kosongSubs = subs.length - aktifSubs.length;
    const tanpaNc = aktifSubs.filter((s) => !String(s.noClaim || "").trim());
    const noClaims = aktifSubs.map((s) => s.noClaim).filter((v): v is string => Boolean(v && v.trim()));
    const noClaimTampil = noClaims.length > 1 ? `${noClaims.length} No Claim` : noClaims[0] || wf.noClaim || "";
    const dokAda = DOKUMEN.filter((doc) => wf[doc.path]);
    const dokBerkas = subs.reduce((n, s) => n + DOKUMEN.filter((doc) => s[doc.path]).length, 0);
    const aktifBayar = payments.filter((p) => !p.voidedAt);
    const umur = umurHari(wf.submittedToPrincipalAt);

    const barisTakValid = items.some((it) => { const v = hitungBaris(isiItem(it, bolehUbahItem ? drafItem[it.id] : undefined)); return !(v.dpp > 0) || !(v.nilaiKlaim > 0); });
    const alasanDok = !statusEdit ? "Dokumen hanya dibuat saat Draf atau Perlu revisi."
        : aktifSubs.length === 0 ? "Belum ada berkas klaim aktif."
        : tanpaNc.length ? `Isi dan simpan No Claim ${tanpaNc.length} berkas dulu.`
        : belumSimpan ? "Simpan perubahan item dan No Claim dulu."
        : barisTakValid ? "Ada item dengan DPP atau nilai klaim 0."
        : aktifSubs.some((s) => !(Number(s.totalClaim || 0) > 0)) ? "Ada berkas dengan nilai klaim 0." : "";
    const alasanSiap = aktifSubs.length === 0 ? "Belum ada berkas klaim aktif."
        : tanpaNc.length ? `Isi No Claim ${tanpaNc.length} berkas dulu.`
        : belumSimpan ? "Ada perubahan belum disimpan."
        : dokAda.length < 3 ? `Buat dokumen dulu (${dokAda.length} dari 3 siap).` : "";

    // No Claim: pola principal (no-claim-rules) hanya pratinjau; isian manual tetap boleh.
    const varianList = getNoClaimRuleVariants(wf.principleCode);
    const varianAktif = varian || varianList[0]?.variantKey || "";
    const aturan = resolveNoClaimRule(wf.principleCode, varianAktif || undefined);
    const [tahunIni, bulanIni] = witaToday().split("-");
    const usulan = (nc: DrafNc) => (aturan ? buildNoClaimFromRule(aturan, { sequence: nc.urut ?? "", month: nc.bulan ?? bulanIni, year: tahunIni, variantKey: varianAktif || undefined }) : "");
    const financeLunas = d.offFinanceStatus === "Paid" && d.offPaymentSummary?.isFullyPaid !== false;

    // Pembayaran: berkas tujuan bila klaim punya lebih dari satu berkas aktif.
    const targetBayar = banyakBerkas ? aktifSubs.find((s) => s.id === bayarBerkas) ?? aktifSubs.find((s) => Number(s.remainingAmount || 0) > 0) ?? aktifSubs[0] : undefined;
    const sisaBayar = targetBayar ? Number(targetBayar.remainingAmount || 0) : Number(d.paymentSummary?.remainingAmount ?? wf.remainingAmount);
    const nominal = Number(bayar.paymentAmount);
    const sisaSesudah = Math.max(sisaBayar - (Number.isFinite(nominal) ? nominal : 0), 0);
    const lebihBayar = Number.isFinite(nominal) && nominal > sisaBayar ? `Melebihi sisa ${rupiah(sisaBayar)}` : "";

    // Penutupan: syarat mengikuti berkas (cermin rute close).
    const terbuka = aktifSubs.filter((s) => s.status !== S.closed);
    const targetTutup = terbuka.find((s) => s.id === tutupBerkas) ?? terbuka.find((s) => s.status === S.paid) ?? (subs.length === 1 ? subs[0] : terbuka[0]);
    const bayarTarget = targetTutup ? aktifBayar.filter((p) => p.claimSubmissionId === targetTutup.id) : [];
    const jumlahBayarAktif = targetTutup ? (bayarTarget.length > 0 || banyakBerkas ? bayarTarget.length : aktifBayar.length) : 0;
    const cek = targetTutup ? syaratTutup(targetTutup, jumlahBayarAktif) : [];
    const blokir = targetTutup ? cek.filter((c) => !c.ok).map((c) => c.label) : d.closeBlockers ?? ["Belum ada berkas klaim."];
    const siapTutup = bolehTutupPeran && Boolean(targetTutup) && targetTutup?.status !== S.closed && blokir.length === 0;
    const alasanTutup = !canManage ? "Hanya peran admin atau claim yang dapat menutup klaim"
        : !bolehTutupPeran ? "Butuh izin persetujuan Claim Workflow"
        : !targetTutup ? "Belum ada berkas klaim"
        : blokir.length ? `Belum memenuhi ${blokir.length} syarat penutupan`
        : !catatanTutup.trim() ? "Isi catatan penutupan" : "";

    const strip = (di: Bagian) => (
        <>
            {galat?.di === di && <MessageStrip tone="neg" title={galat.teks} onClose={() => setGalat(null)} />}
            {pesan?.di === di && <MessageStrip tone="pos" title={pesan.teks} onClose={() => setPesan(null)} />}
        </>
    );
    const tutupDialog = () => setDialog(null);
    const hasil = (di: Bagian, teks: string) => { setGalat(null); setPesan({ di, teks }); muat(); };

    async function transisi(action: "mark_ready" | "return_to_draft" | "submit_to_principal", note?: string) {
        const { res, data } = await kirimJson(`/api/claim-workflow/${id}/status`, "POST", note ? { action, note } : { action });
        if (!res.ok || !data.ok) throw new Error(data.error || "Gagal mengubah status klaim.");
        setDialog(null);
        hasil("atas", action === "mark_ready" ? `${no} ditandai siap dikirim. Item dan pajak kini terkunci.`
            : action === "return_to_draft" ? `${no} dikembalikan ke draf. Dokumen lama dihapus; buat ulang setelah perbaikan.`
            : `${no} dikirim ke principal. Umur tagihan dihitung mulai hari ini.`);
    }

    async function buatSemuaDokumen() {
        setBuatDok(true); setGalat(null); setPesan(null);
        try {
            const res = await fetch(`/api/claim-workflow/${id}/documents/generate-all`, { method: "POST" });
            const data = (await res.json().catch(() => ({}))) as Jawab;
            if (!res.ok || !data.ok) { setGalat({ di: "noclaim", teks: data.error || "Gagal membuat semua dokumen." }); return; }
            hasil("noclaim", "Surat klaim, ringkasan, dan kwitansi dibuat.");
        } catch (e) {
            setGalat({ di: "noclaim", teks: e instanceof Error ? e.message : "Gagal membuat semua dokumen." });
        } finally {
            setBuatDok(false);
        }
    }

    function ubahItem(it: WorkflowItem, patch: DrafItem) {
        setDrafItem((p) => ({ ...p, [it.id]: { ...p[it.id], ...patch } }));
        setGalatItem((p) => tanpa(p, it.id));
    }
    function batalUbah(it: WorkflowItem) { setDrafItem((p) => tanpa(p, it.id)); setGalatItem((p) => tanpa(p, it.id)); }

    async function simpanItem(it: WorkflowItem) {
        const v = isiItem(it, drafItem[it.id]);
        const dpp = Number(v.dpp), ppn = Number(v.ppnRate), pph = Number(v.pphRate);
        const salah = !Number.isFinite(dpp) || dpp < 0 ? "DPP harus angka 0 atau lebih."
            : !Number.isFinite(ppn) || ppn < 0 || ppn > 100 ? "PPN % harus angka 0–100."
            : !Number.isFinite(pph) || pph < 0 || pph > 100 ? "PPh % harus angka 0–100." : "";
        if (salah) { setGalatItem((p) => ({ ...p, [it.id]: salah })); return; }
        setSimpanItemId(it.id); setPesan(null);
        try {
            // Bentuk badan sama dengan "Edit Tax" lama: { dpp, ppnRate, pphRate, note, expectedUpdatedAt } (kunci optimistis).
            const { res, data } = await kirimJson(`/api/claim-workflow/${id}/items/${it.id}`, "PATCH", { ...v, expectedUpdatedAt: it.updatedAt });
            if (res.status === 409 && data.code === "CONFLICT") {
                setKonflik({ itemId: it.id, at: data.currentUpdatedAt ?? null, nilai: v });
                muatAudit(); // siapa yang mengubah dibaca dari riwayat terbaru
                return;
            }
            if (!res.ok || !data.ok) { setGalatItem((p) => ({ ...p, [it.id]: data.error || "Gagal menyimpan pajak item." })); return; }
            setDrafItem((p) => tanpa(p, it.id));
            setKonflik((k) => (k?.itemId === it.id ? null : k));
            hasil("item", `Pajak item ${nomor.get(it.id)} tersimpan; total klaim dihitung ulang.`);
        } catch (e) {
            setGalatItem((p) => ({ ...p, [it.id]: e instanceof Error ? e.message : "Gagal menyimpan pajak item." }));
        } finally {
            setSimpanItemId("");
        }
    }
    function muatUlangBaris(itemId: string) {
        setDrafItem((p) => tanpa(p, itemId));
        setKonflik((k) => (k ? { ...k, dimuat: true } : k));
        muat();
    }
    const siapaUbah = (itemId: string) => [...(audit.data ?? [])].reverse()
        .find((a) => a.action === "update_item_tax" && (a.metadata as { itemId?: string } | null)?.itemId === itemId);

    async function kirimNoClaim(sub: Submission, noClaim: string, dariDialog: boolean) {
        const adaDok = DOKUMEN.some((doc) => sub[doc.path]);
        const { res, data } = await kirimJson(`/api/claim-workflow/${id}/submissions/${sub.id}`, "PATCH", { noClaim });
        if (!res.ok || !data.ok) {
            const teks = data.error || "Gagal menyimpan No Claim.";
            if (dariDialog) throw new Error(teks);
            setGalatNc((p) => ({ ...p, [sub.id]: teks }));
            return;
        }
        setDrafNc((p) => tanpa(p, sub.id));
        setDialog(null); setGabung(null);
        hasil("noclaim", dariDialog ? `Berkas digabung ke No Claim ${noClaim}. Dokumen klaim dihapus; buat ulang.`
            : `No Claim ${noClaim} tersimpan.${adaDok ? " Dokumen lama berkas ini dihapus; buat ulang." : ""}`);
    }
    async function simpanNoClaim(sub: Submission) {
        const v = (drafNc[sub.id]?.noClaim ?? "").trim();
        if (!v) { setGalatNc((p) => ({ ...p, [sub.id]: "No Claim wajib diisi." })); return; }
        // BL-15 (layar saja): No Claim yang sama di klaim ini membuat server menggabungkan berkas — minta konfirmasi dulu.
        const target = subs.find((o) => o.id !== sub.id && (o.noClaim ?? "") === v);
        if (target) { setGabung({ sub, target, noClaim: v }); setDialog("gabung"); return; }
        setSimpanNcId(sub.id); setPesan(null);
        try { await kirimNoClaim(sub, v, false); }
        catch (e) { setGalatNc((p) => ({ ...p, [sub.id]: e instanceof Error ? e.message : "Gagal menyimpan No Claim." })); }
        finally { setSimpanNcId(""); }
    }
    function pakaiUsulan(sub: Submission) {
        const u = usulan(drafNc[sub.id] ?? {});
        if (!u) { setGalatNc((p) => ({ ...p, [sub.id]: "Isi No. urut dan bulan 01–12 dulu." })); return; }
        setDrafNc((p) => ({ ...p, [sub.id]: { ...p[sub.id], noClaim: u } }));
        setGalatNc((p) => tanpa(p, sub.id));
    }

    async function pindahItem() {
        if (!pindah) return;
        const { res, data } = await kirimJson(`/api/claim-workflow/${id}/submissions/${pindah.target.id}/items`, "POST", { itemIds: [pindah.item.id] });
        if (!res.ok || !data.ok) throw new Error(data.error || "Gagal memindahkan item.");
        setDialog(null); setPindah(null);
        hasil("item", `Item ${nomor.get(pindah.item.id)} dipindah ke berkas ${pindah.target.noClaim || judulBerkas(pindah.target)}; total kedua berkas dihitung ulang.`);
    }

    function bukaBayar() {
        const salah: { tanggal?: string; nominal?: string } = {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bayar.paymentDate)) salah.tanggal = "Tanggal diterima wajib diisi.";
        if (!Number.isFinite(nominal) || nominal <= 0) salah.nominal = "Nominal harus lebih dari 0.";
        else if (lebihBayar) salah.nominal = `${lebihBayar}; server menolak kelebihan bayar.`;
        setGalatBayar(salah);
        if (salah.tanggal || salah.nominal || (banyakBerkas && !targetBayar)) {
            document.getElementById("form-bayar")?.scrollIntoView({ block: "center" });
            return;
        }
        setDialog("bayar");
    }
    async function catatBayar() {
        const url = banyakBerkas && targetBayar ? `/api/claim-workflow/${id}/submissions/${targetBayar.id}/payments` : `/api/claim-workflow/${id}/payments`;
        const { res, data } = await kirimJson(url, "POST", {
            paymentDate: bayar.paymentDate,
            paymentAmount: nominal,
            paymentType: bayar.paymentType.trim() || null,
            paymentNote: bayar.paymentNote.trim() || null,
        });
        if (!res.ok || !data.ok) throw new Error(data.error || "Gagal mencatat pembayaran.");
        setDialog(null);
        setBayar((b) => ({ paymentDate: witaToday(), paymentAmount: "", paymentType: b.paymentType, paymentNote: "" }));
        setBayarBerkas(""); // bawaan pindah ke berkas berikutnya yang masih bersisa
        hasil("bayar", `Pembayaran ${rupiah(nominal)} tercatat.${data.statusChanged ? ` Status klaim: ${statusKlaim(data.workflow?.status).label}.` : ""}`);
    }
    async function batalkanBayar(alasan: string) {
        if (!voidPay) return;
        const sid = voidPay.claimSubmissionId || targetBayar?.id;
        if (banyakBerkas && !sid) throw new Error("Berkas pembayaran ini tidak diketahui.");
        const url = banyakBerkas ? `/api/claim-workflow/${id}/submissions/${sid}/payments/${voidPay.id}/void` : `/api/claim-workflow/${id}/payments/${voidPay.id}/void`;
        const { res, data } = await kirimJson(url, "POST", { reason: alasan });
        if (!res.ok || !data.ok) throw new Error(data.error || "Gagal membatalkan pembayaran.");
        setDialog(null); setVoidPay(null);
        hasil("bayar", `Pembayaran ${rupiah(voidPay.paymentAmount)} dibatalkan.${data.statusChanged ? ` Status klaim: ${statusKlaim(data.workflow?.status).label}.` : ""}`);
    }
    async function tutupKlaim() {
        if (!targetTutup) return;
        const url = banyakBerkas ? `/api/claim-workflow/${id}/submissions/${targetTutup.id}/close` : `/api/claim-workflow/${id}/close`;
        const { res, data } = await kirimJson(url, "POST", { note: catatanTutup.trim() });
        if (!res.ok || !data.ok) throw new Error(data.error || "Gagal menutup klaim.");
        setDialog(null); setCatatanTutup(""); setTutupBerkas(""); setBaruDitutup(true);
        hasil("atas", `${banyakBerkas ? `Berkas ${targetTutup.noClaim || judulBerkas(targetTutup)}` : no} ditutup. Isian berkas itu kini terkunci.`);
    }

    // Akibat batal bayar: sisa dan status sesudahnya (berkas bila klaim punya beberapa berkas).
    const dasarVoid = voidPay && banyakBerkas ? subOf(voidPay.claimSubmissionId) : undefined;
    const dibayarKini = dasarVoid ? Number(dasarVoid.totalPaid || 0) : Number(d.paymentSummary?.totalPaid ?? wf.totalPaid);
    const sisaKini = dasarVoid ? Number(dasarVoid.remainingAmount || 0) : Number(d.paymentSummary?.remainingAmount ?? wf.remainingAmount);
    const akibatVoid = voidPay ? `Sisa menjadi ${rupiah(sisaKini + Number(voidPay.paymentAmount || 0))}; status menjadi ${dibayarKini - Number(voidPay.paymentAmount || 0) > 0 ? "Dibayar sebagian" : "Dikirim"}` : "";

    const kolomItem: Column<WorkflowItem>[] = [
        {
            key: "surat", header: "No Surat · program", cell: (it) => {
                const v = isiItem(it, drafItem[it.id]);
                const ubah = itemBerubah(it) ? [
                    v.dpp !== String(it.dpp) ? `DPP ${rupiah(it.dpp)} → ${rupiah(Number(v.dpp) || 0)}` : "",
                    v.ppnRate !== String(it.ppnRate) ? `PPN ${persenTeks(it.ppnRate)} → ${persenTeks(v.ppnRate)}` : "",
                    v.pphRate !== String(it.pphRate) ? `PPh ${persenTeks(it.pphRate)} → ${persenTeks(v.pphRate)}` : "",
                    v.note !== (it.note || "") ? "catatan" : "",
                ].filter(Boolean).join(" · ") : "";
                return (
                    <>
                        <span className="fi-mono">{it.noSurat || "–"}</span>
                        <span className="fi-sub">{[it.jenisPromosi, it.periode].filter(Boolean).join(" · ") || "–"}</span>
                        {ubah && <span className="fi-sub fi-why">Belum disimpan: {ubah}</span>}
                        {galatItem[it.id] && <span className="fi-msg" role="alert">{galatItem[it.id]}</span>}
                    </>
                );
            },
        },
        { key: "toko", header: "Toko", cell: (it) => it.outlet || "–" },
        {
            key: "dpp", header: "DPP", align: "end", cell: (it) => drafItem[it.id] && bolehUbahItem
                ? <input aria-label={`DPP item ${nomor.get(it.id)}`} className="fi-input fi-cellin" type="number" min="0" step="any" value={isiItem(it, drafItem[it.id]).dpp} onChange={(e) => ubahItem(it, { dpp: e.target.value })} />
                : rupiah(it.dpp),
        },
        {
            key: "ppn", header: "PPN", align: "end", cell: (it) => {
                if (!(drafItem[it.id] && bolehUbahItem)) return <>{rupiah(it.ppnAmount)}<span className="fi-sub">{persenTeks(it.ppnRate)}</span></>;
                const v = isiItem(it, drafItem[it.id]);
                return <><input aria-label={`PPN % item ${nomor.get(it.id)}`} className="fi-input fi-cellin fi-cellin--s" type="number" min="0" max="100" step="any" value={v.ppnRate} onChange={(e) => ubahItem(it, { ppnRate: e.target.value })} /><span className="fi-sub">{rupiah(hitungBaris(v).ppnAmount)}</span></>;
            },
        },
        {
            key: "pph", header: "PPh", align: "end", cell: (it) => {
                if (!(drafItem[it.id] && bolehUbahItem)) return <>{rupiah(it.pphAmount)}<span className="fi-sub">{persenTeks(it.pphRate)}</span></>;
                const v = isiItem(it, drafItem[it.id]);
                return <><input aria-label={`PPh % item ${nomor.get(it.id)}`} className="fi-input fi-cellin fi-cellin--s" type="number" min="0" max="100" step="any" value={v.pphRate} onChange={(e) => ubahItem(it, { pphRate: e.target.value })} /><span className="fi-sub">{rupiah(hitungBaris(v).pphAmount)}</span></>;
            },
        },
        { key: "nilai", header: "Nilai klaim", align: "end", cell: (it) => <b>{rupiah(drafItem[it.id] && bolehUbahItem ? hitungBaris(isiItem(it, drafItem[it.id])).nilaiKlaim : it.nilaiKlaim)}</b> },
        {
            key: "berkas", header: "Berkas · No Claim", secondary: true, cell: (it) => bolehPindah
                ? (
                    <select aria-label={`Berkas item ${nomor.get(it.id)}`} className="fi-input" value={it.claimSubmissionId ?? ""} onChange={(e) => {
                        const t = subOf(e.target.value);
                        if (t && t.id !== it.claimSubmissionId) { setPindah({ item: it, target: t }); setDialog("pindah"); }
                    }}>
                        {!it.claimSubmissionId && <option value="">Pilih berkas</option>}
                        {subs.map((s) => <option key={s.id} value={s.id}>{s.noClaim ? `${s.noClaim} · ` : ""}{judulBerkas(s)}</option>)}
                    </select>
                )
                : <span className={subOf(it.claimSubmissionId)?.noClaim ? "fi-mono" : undefined}>{subOf(it.claimSubmissionId)?.noClaim || (subOf(it.claimSubmissionId) ? judulBerkas(subOf(it.claimSubmissionId)!) : "–")}</span>,
        },
        ...(bolehUbahItem ? [{
            key: "aksi", header: "Tindakan", cell: (it: WorkflowItem) => drafItem[it.id]
                ? (
                    <div style={{ display: "grid", gap: 6, minWidth: "12rem" }}>
                        <input aria-label={`Catatan item ${nomor.get(it.id)}`} className="fi-input" placeholder="Catatan" value={isiItem(it, drafItem[it.id]).note} onChange={(e) => ubahItem(it, { note: e.target.value })} />
                        <div className="fi-btnrow">
                            <Button variant="primary" busy={simpanItemId === it.id} disabled={!itemBerubah(it) || (simpanItemId !== "" && simpanItemId !== it.id)} disabledReason="Belum ada perubahan" onClick={() => simpanItem(it)}>Simpan</Button>
                            <Button variant="tertiary" onClick={() => batalUbah(it)}>Batal</Button>
                        </div>
                    </div>
                )
                : <Button variant="icon" aria-label={`Ubah pajak item ${nomor.get(it.id)}`} icon={<Pencil className="fi-icon" aria-hidden />} onClick={() => ubahItem(it, {})} />,
        } satisfies Column<WorkflowItem>] : []),
    ];
    const itemPonsel = (it: WorkflowItem) => {
        if (!(drafItem[it.id] && bolehUbahItem)) {
            return <ListItem doc={it.noSurat || "–"} amount={rupiah(it.nilaiKlaim)} title={it.outlet || it.jenisPromosi || "Item"}
                meta={`DPP ${rupiah(it.dpp)} · PPN ${persenTeks(it.ppnRate)} · PPh ${persenTeks(it.pphRate)}`}
                badge={bolehUbahItem ? <Button variant="tertiary" icon={<Pencil className="fi-icon" aria-hidden />} onClick={() => ubahItem(it, {})}>Ubah</Button> : undefined} />;
        }
        return <FormItemPonsel it={it} v={isiItem(it, drafItem[it.id])} galat={galatItem[it.id]} busy={simpanItemId === it.id} berubah={itemBerubah(it)}
            onChange={(patch) => ubahItem(it, patch)} onSave={() => simpanItem(it)} onCancel={() => batalUbah(it)} />;
    };

    const kolomBayar: Column<Payment>[] = [
        { key: "tgl", header: "Tanggal diterima", cell: (p) => tanggalPendek(p.paymentDate) },
        { key: "nominal", header: "Nominal", align: "end", cell: (p) => p.voidedAt ? <s>{rupiah(p.paymentAmount)}</s> : <b>{rupiah(p.paymentAmount)}</b> },
        { key: "cara", header: "Cara bayar principal", cell: (p) => p.paymentType || "–" },
        ...(banyakBerkas ? [{ key: "berkas", header: "Berkas", secondary: true, cell: (p: Payment) => <span className="fi-mono">{subOf(p.claimSubmissionId)?.noClaim || "–"}</span> } satisfies Column<Payment>] : []),
        { key: "catatan", header: "Catatan", secondary: true, cell: (p) => <>{p.paymentNote || "–"}{p.voidedAt && p.voidReason && <span className="fi-sub">Alasan batal: {p.voidReason}</span>}</> },
        { key: "status", header: "Status", cell: (p) => p.voidedAt ? <StatusBadge tone="neg">Dibatalkan</StatusBadge> : <StatusBadge tone="pos">Aktif</StatusBadge> },
        {
            key: "aksi", header: "Tindakan", cell: (p) => !p.voidedAt && wf.status !== S.closed
                ? <Button variant="tertiary" disabled={Boolean(alasanVoid)} disabledReason={alasanVoid} onClick={() => { setVoidPay(p); setDialog("void"); }}>Batalkan…</Button>
                : null,
        },
    ];

    const anchors = [
        { id: "item", label: "Item" }, { id: "no-claim", label: "No Claim & dokumen" }, { id: "pembayaran", label: "Pembayaran" },
        { id: "penutupan", label: "Penutupan" }, { id: "riwayat", label: "Riwayat" }, { id: "alur", label: "Alur dokumen" },
    ];
    const daftarHref = baruDitutup ? `/claim-workflow?ditutup=${encodeURIComponent(no)}` : "/claim-workflow";

    let footer: ReactNode = null;
    if (tahap === "draf") {
        footer = (
            <FooterToolbar message={!bolehTahap ? "Hanya peran admin atau claim dengan izin persetujuan klaim yang dapat menandai siap dikirim." : alasanSiap || "No Claim dan tiga dokumen lengkap."}>
                {bolehTahap && <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(alasanSiap)} disabledReason={alasanSiap} onClick={() => setDialog("siap")}>Tandai siap dikirim…</Button>}
            </FooterToolbar>
        );
    } else if (tahap === "siap") {
        footer = (
            <FooterToolbar message={bolehTahap ? "Periksa dokumen sebelum dikirim; setelah dikirim item terkunci." : "Hanya peran admin atau claim dengan izin persetujuan klaim yang dapat mengirim."}>
                {bolehTahap && <Button variant="negative" icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={() => setDialog("draf")}>Kembalikan ke draf…</Button>}
                {bolehTahap && <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} onClick={() => setDialog("kirim")}>Kirim ke principal…</Button>}
            </FooterToolbar>
        );
    } else if (tahap === "dikirim" || tahap === "sebagian") {
        footer = (
            <FooterToolbar message={`${umur != null ? `Dikirim ${umur} hari lalu · ` : ""}sisa ${rupiah(wf.remainingAmount)}${bayarTerisi ? " · pembayaran belum dicatat" : ""}`}>
                {bolehBayar && <Button variant="primary" icon={<Wallet className="fi-icon" aria-hidden />} onClick={bukaBayar}>Catat pembayaran…</Button>}
            </FooterToolbar>
        );
    } else if (tahap === "lunas") {
        footer = (
            <FooterToolbar message={alasanTutup || "Semua syarat terpenuhi; catatan penutupan belum disimpan."}>
                <Button variant="primary" icon={<Lock className="fi-icon" aria-hidden />} disabled={Boolean(alasanTutup)} disabledReason={alasanTutup} onClick={() => setDialog("tutup")}>{banyakBerkas ? "Tutup berkas…" : "Tutup klaim…"}</Button>
            </FooterToolbar>
        );
    } else {
        footer = (
            <FooterToolbar message={tahap === "ditutup" ? "Klaim ditutup. Tidak ada aksi lagi." : tahap === "batal" ? "Klaim dibatalkan." : undefined}>
                <Link className="fi-btn fi-btn--secondary" href={daftarHref}>Daftar klaim</Link>
            </FooterToolbar>
        );
    }

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <ObjectPageHeader breadcrumbs={kepala} title={no} status={<StatusBadge tone={st.tone}>{st.label}</StatusBadge>} draft={adaDraf}
                actions={<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={detail.status === "memuat"} onClick={muat}>Muat ulang</Button>}
                attributes={[
                    { label: "Principal", value: wf.principleName },
                    { label: "No Claim", value: noClaimTampil ? <span className="fi-mono">{noClaimTampil}</span> : "Belum ada" },
                    { label: "Total klaim", value: rupiah(wf.totalClaim) },
                    { label: "Dibayar", value: rupiah(wf.totalPaid) },
                    { label: "Sisa", value: rupiah(wf.remainingAmount) },
                    ...(wf.submittedToPrincipalAt ? [{ label: "Dikirim ke principal", value: `${tanggalWita(wf.submittedToPrincipalAt)}${umur != null && tahap !== "ditutup" ? ` · ${umur} hari` : ""}` }] : []),
                    { label: "OFF", value: wf.offNoPengajuan || "–" },
                ]}
                flow={<Flow steps={alurKlaim(wf.status)} label="Tahap klaim" />} />
            <AnchorBar anchors={anchors} />

            {strip("atas")}
            {detail.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang.">{detail.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}
            {isLegacyPekaStatus(wf.status) && <MessageStrip tone="info" title="Status lama dari alur PEKA.">Alur PEKA (EC/CN) sudah tidak dipakai; klaim ini ditampilkan sebagai Dikirim. Pembayaran untuk status lama ini belum bisa dicatat dari layar ini.</MessageStrip>}
            {(tahap === "dikirim" || tahap === "sebagian") && (
                <VariantNote bl="BL-14">Setelah dikirim ke principal belum ada jalan Minta revisi atau Batalkan klaim. Usulan: keduanya lewat dialog beralasan; batal hanya bila belum ada pembayaran aktif.</VariantNote>
            )}

            <Section id="item" title="Item klaim" subtitle={`${items.length} item · DPP ${rupiah(wf.totalDpp)} · PPN ${rupiah(wf.totalPpn)} · PPh ${rupiah(wf.totalPph)}`}>
                <div className="fi-sect-in">
                    {strip("item")}
                    {konflik && (() => {
                        const it = items.find((x) => x.id === konflik.itemId);
                        const n = nomor.get(konflik.itemId) ?? "";
                        if (konflik.dimuat) {
                            return <MessageStrip tone="info" title={`Item ${n} dimuat ulang dengan versi terbaru.`} onClose={() => setKonflik(null)}>Nilai Anda tadi: DPP {rupiah(Number(konflik.nilai.dpp) || 0)}, PPN {persenTeks(konflik.nilai.ppnRate)}, PPh {persenTeks(konflik.nilai.pphRate)}. Ubah lagi bila masih perlu.</MessageStrip>;
                        }
                        const jejak = siapaUbah(konflik.itemId);
                        const kapan = konflik.at ?? jejak?.createdAt ?? null;
                        return (
                            <MessageStrip tone="neg" title={`Item ${n}${it?.outlet ? ` (${it.outlet})` : ""} diubah ${jejak?.actorName || "pengguna lain"}${kapan ? ` pada ${jamWita(kapan)}` : ""} sejak Anda membuka halaman ini.`}>
                                Perubahan Anda belum disimpan; baris lain tetap seperti yang Anda lihat.{" "}
                                <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={() => muatUlangBaris(konflik.itemId)}>Muat ulang baris itu</Button>
                            </MessageStrip>
                        );
                    })()}
                    <p className="fi-small fi-subtle">Nilai klaim = DPP + PPN − PPh; PPN dan PPh dibulatkan ke rupiah seperti saat disimpan. {bolehUbahItem ? "Ubah pajak per baris lalu Simpan." : statusEdit ? "" : "Item dan pajak terkunci di tahap ini."}</p>
                </div>
                <ResponsiveTable<WorkflowItem> title="Item klaim" columns={kolomItem} rows={items} rowKey={(it) => it.id} mobileItem={itemPonsel}
                    empty={{ title: "Belum ada item klaim", message: "Item berasal dari OFF Program Control." }} />
            </Section>

            <Section id="no-claim" title="No Claim & dokumen" subtitle={`${aktifSubs.length} berkas aktif · ${dokAda.length} dari 3 dokumen`}>
                <div className="fi-sect-in">
                    {strip("noclaim")}
                    {statusEdit && !financeLunas && d.noClaimGateReason && <MessageStrip tone="warn" title="No Claim belum bisa disimpan.">{d.noClaimGateReason}</MessageStrip>}
                    {statusEdit && !d.canAssignNoClaim && <MessageStrip tone="info" title="Hanya peran admin atau claim yang dapat mengisi No Claim." />}
                    {focus === "no-claim" && d.canGenerateNoClaim && <MessageStrip tone="info" title="Finance OFF sudah lunas.">Isi No Claim pada berkas di bawah, simpan, lalu buat dokumen.</MessageStrip>}
                    <p className="fi-small fi-subtle">
                        Satu berkas klaim = satu No Claim ke principal; dokumen, pembayaran, dan penutupan mengikuti berkas.
                        {kosongSubs ? ` ${kosongSubs} berkas kosong diabaikan.` : ""}{!statusEdit ? " No Claim hanya bisa diubah saat Draf atau Perlu revisi." : ""}
                    </p>
                    {bolehNoClaim && (aturan ? (
                        <div className="fi-page-bar">
                            {varianList.length > 0 && (
                                <select className="fi-input" aria-label="Varian pola No Claim" value={varianAktif} onChange={(e) => setVarian(e.target.value)}>
                                    {varianList.map((v) => <option key={v.variantKey} value={v.variantKey}>{v.label}</option>)}
                                </select>
                            )}
                            <span className="fi-small fi-subtle">Pola {aturan.label}: <span className="fi-mono">{polaTerbaca(aturan.pattern)}</span> · tahun {tahunIni}</span>
                        </div>
                    ) : <p className="fi-small fi-subtle">Belum ada pola No Claim untuk principal ini; isi No Claim manual.</p>)}
                </div>
                {subs.length === 0 ? <EmptyState title="Belum ada berkas klaim" message="Berkas dibuat saat klaim dibuat dari OFF Program Control." /> : (
                    <ul className="fi-berkas" aria-label="Berkas klaim">
                        {subs.map((s, i) => {
                            const nc = drafNc[s.id] ?? {};
                            const u = usulan(nc);
                            const adaDokBerkas = DOKUMEN.some((doc) => s[doc.path]);
                            const itemCount = s.itemCount ?? items.filter((it) => it.claimSubmissionId === s.id).length;
                            return (
                                <li key={s.id}>
                                    <div className="fi-berkas-head">
                                        <b className={s.noClaim ? "fi-mono" : undefined}>{s.noClaim || "Belum ada No Claim"}</b>
                                        <span>{judulBerkas(s)} · {itemCount} item · {rupiah(s.totalClaim)}{aktif(s) ? "" : " · kosong, diabaikan"}</span>
                                        <StatusBadge tone={statusKlaim(s.status).tone}>{statusKlaim(s.status).label}</StatusBadge>
                                        {ncBerubah(s) && <StatusBadge tone="warn">Belum disimpan</StatusBadge>}
                                    </div>
                                    {bolehNoClaim && aktif(s) && (
                                        <div className="fi-noclaim">
                                            <FormField label={`No Claim berkas ${i + 1} · ${judulBerkas(s)}`} error={galatNc[s.id]}
                                                help={[u ? `Usulan: ${u}` : "", adaDokBerkas ? "Mengganti No Claim menghapus dokumen berkas ini." : ""].filter(Boolean).join(" · ") || undefined}>
                                                {(a) => <input {...a} className="fi-input fi-mono" value={nc.noClaim ?? s.noClaim ?? ""} placeholder={u || "mis. 01/SUPER-KN/10/2026"}
                                                    onChange={(e) => { const val = e.target.value; setDrafNc((p) => ({ ...p, [s.id]: { ...p[s.id], noClaim: val } })); setGalatNc((p) => tanpa(p, s.id)); }} />}
                                            </FormField>
                                            <FormField label="No. urut">{(a) => <input {...a} className="fi-input" inputMode="numeric" placeholder="01" value={nc.urut ?? ""} onChange={(e) => { const val = e.target.value; setDrafNc((p) => ({ ...p, [s.id]: { ...p[s.id], urut: val } })); }} />}</FormField>
                                            <FormField label="Bulan">{(a) => <input {...a} className="fi-input" inputMode="numeric" maxLength={2} placeholder={bulanIni} value={nc.bulan ?? bulanIni} onChange={(e) => { const val = e.target.value; setDrafNc((p) => ({ ...p, [s.id]: { ...p[s.id], bulan: val } })); }} />}</FormField>
                                            <Button disabled={!aturan} disabledReason="Belum ada pola No Claim untuk principal ini" onClick={() => pakaiUsulan(s)}>Pakai usulan</Button>
                                            <Button variant="primary" busy={simpanNcId === s.id} disabled={!ncBerubah(s)} disabledReason="Belum ada perubahan" onClick={() => simpanNoClaim(s)}>Simpan No Claim</Button>
                                        </div>
                                    )}
                                    <p className="fi-small fi-subtle">
                                        Dokumen berkas:{" "}
                                        {DOKUMEN.map((doc, i) => (
                                            <span key={doc.key}>{i > 0 ? " · " : ""}{s[doc.path]
                                                ? <a href={`/api/claim-workflow/${id}/submissions/${s.id}/${doc.key}`} target="_blank" rel="noreferrer">{doc.label}</a>
                                                : `${doc.label} belum`}</span>
                                        ))}
                                        {" "}· dibayar {rupiah(s.totalPaid)} · sisa {rupiah(s.remainingAmount)}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div className="fi-sect-in">
                    <div className="fi-docs" role="list" aria-label="Dokumen klaim">
                        {DOKUMEN.map((doc) => (
                            <div key={doc.key} className="fi-doc" role="listitem">
                                <b>{doc.label}</b>
                                {wf[doc.path]
                                    ? <>
                                        <span><StatusBadge tone="pos">Dibuat</StatusBadge> {wf[doc.at] ? jamWita(wf[doc.at]!) : ""}</span>
                                        <a href={`/api/claim-workflow/${id}/${doc.key}`} target="_blank" rel="noreferrer">Lihat PDF <ExternalLink className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px", width: 14, height: 14 }} /></a>
                                    </>
                                    : <span className="fi-subtle">Belum dibuat{tanpaNc.length ? " · perlu No Claim" : ""}</span>}
                            </div>
                        ))}
                    </div>
                    {bolehDokumen && (
                        <div className="fi-btnrow">
                            <Button icon={<FileText className="fi-icon" aria-hidden />} busy={buatDok} disabled={Boolean(alasanDok)} disabledReason={alasanDok} onClick={buatSemuaDokumen}>Buat semua dokumen</Button>
                            {alasanDok && <span className="fi-small fi-subtle">{alasanDok}</span>}
                        </div>
                    )}
                    <VariantNote bl="BL-15">Keunikan No Claim antar klaim hari ini dicek aplikasi saat menyimpan; No Claim yang sama di klaim ini menggabungkan berkas (layar ini meminta konfirmasi dulu). Usulan: indeks unik di database.</VariantNote>
                </div>
            </Section>

            <Section id="pembayaran" title="Pembayaran dari principal" subtitle={`${aktifBayar.length ? `${aktifBayar.length} pembayaran aktif` : "belum ada pembayaran"} · sisa ${rupiah(d.paymentSummary?.remainingAmount ?? wf.remainingAmount)}`}>
                <div className="fi-sect-in">
                    {strip("bayar")}
                    {d.paymentSummary && (
                        <div style={{ maxWidth: "30rem" }}>
                            <KeyValues items={[
                                ["Total klaim", rupiah(d.paymentSummary.totalClaim)], ["Dibayar", rupiah(d.paymentSummary.totalPaid)], ["Sisa", rupiah(d.paymentSummary.remainingAmount)],
                                ["Status pembayaran", statusKlaim(d.paymentSummary.paymentStatus).label],
                                ["Pembayaran", `${d.paymentSummary.activePaymentCount} aktif · ${d.paymentSummary.voidedPaymentCount} dibatalkan`],
                            ]} />
                        </div>
                    )}
                </div>
                <ResponsiveTable<Payment> title="Riwayat pembayaran" columns={kolomBayar} rows={payments} rowKey={(p) => p.id}
                    empty={{ title: "Belum ada pembayaran tercatat", message: tahap === "dikirim" ? "Catat pembayaran saat dana dari principal diterima." : undefined }}
                    mobileItem={(p) => <ListItem doc={tanggalPendek(p.paymentDate)} amount={p.voidedAt ? <s>{rupiah(p.paymentAmount)}</s> : rupiah(p.paymentAmount)} title={p.paymentType || "–"}
                        meta={<>{p.paymentNote || (p.voidReason ? `Alasan batal: ${p.voidReason}` : "")}{!p.voidedAt && wf.status !== S.closed && <Button variant="tertiary" disabled={Boolean(alasanVoid)} disabledReason={alasanVoid} onClick={() => { setVoidPay(p); setDialog("void"); }}>Batalkan…</Button>}</>}
                        badge={p.voidedAt ? <StatusBadge tone="neg">Dibatalkan</StatusBadge> : <StatusBadge tone="pos">Aktif</StatusBadge>} />} />
                <div className="fi-sect-in">
                    {bolehBayar ? (
                        <>
                            <h3 className="fi-title-3">Catat pembayaran</h3>
                            <div className="fi-formgrid" id="form-bayar">
                                {banyakBerkas && (
                                    <FormField label="Berkas" required>{(a) => (
                                        <select {...a} className="fi-input" value={targetBayar?.id ?? ""} onChange={(e) => setBayarBerkas(e.target.value)}>
                                            {aktifSubs.map((s) => <option key={s.id} value={s.id}>{s.noClaim || judulBerkas(s)} · sisa {rupiah(s.remainingAmount)}</option>)}
                                        </select>
                                    )}</FormField>
                                )}
                                <FormField label="Tanggal diterima" required error={galatBayar.tanggal}>{(a) => <input {...a} className="fi-input" type="date" value={bayar.paymentDate} onChange={(e) => { const val = e.target.value; setBayar((b) => ({ ...b, paymentDate: val })); }} />}</FormField>
                                <FormField label="Nominal" required error={galatBayar.nominal} help={`Sisa ${rupiah(sisaBayar)}`}>{(a) => <input {...a} className="fi-input" type="number" min="0" step="any" inputMode="decimal" placeholder={String(sisaBayar)} value={bayar.paymentAmount} onChange={(e) => { const val = e.target.value; setBayar((b) => ({ ...b, paymentAmount: val })); }} />}</FormField>
                                <FormField label="Cara bayar principal" help="Mis. Transfer, Tunai, Giro.">{(a) => <><input {...a} className="fi-input" list="cw-cara-bayar" value={bayar.paymentType} onChange={(e) => { const val = e.target.value; setBayar((b) => ({ ...b, paymentType: val })); }} /><datalist id="cw-cara-bayar"><option value="Transfer" /><option value="Tunai" /><option value="Giro" /></datalist></>}</FormField>
                                <FormField label="Catatan">{(a) => <input {...a} className="fi-input" value={bayar.paymentNote} onChange={(e) => { const val = e.target.value; setBayar((b) => ({ ...b, paymentNote: val })); }} />}</FormField>
                            </div>
                            <div className="fi-btnrow">
                                <Button icon={<Wallet className="fi-icon" aria-hidden />} onClick={bukaBayar}>Catat pembayaran…</Button>
                                {bayarTerisi && <StatusBadge tone="warn">Belum dicatat</StatusBadge>}
                            </div>
                            <VariantNote bl="BL-08">Server belum mengunci klaim saat mencatat; dua pembayaran yang dicatat bersamaan bisa membuat total melebihi nilai klaim. Usulan (AM-022): pencatatan kedua ditolak dengan sisa terbaru.</VariantNote>
                        </>
                    ) : (
                        <p className="fi-small fi-subtle">
                            {wf.status === S.paid ? "Klaim sudah lunas."
                                : wf.status === S.closed ? "Klaim sudah ditutup."
                                : tahap === "dikirim" || tahap === "sebagian" ? (d.canRecordPayment ? "Butuh izin mencatat pembayaran klaim." : "Hanya peran admin atau claim yang dapat mencatat pembayaran.")
                                : "Pembayaran bisa dicatat setelah klaim dikirim ke principal."}
                        </p>
                    )}
                    <VariantNote bl="BL-07">Bukti bayar principal belum bisa dilampirkan; hari ini pembayaran tercatat tanpa berkas bukti. Usulan: bukti wajib diunggah dan bisa dibuka dari riwayat pembayaran.</VariantNote>
                </div>
            </Section>

            <Section id="penutupan" title="Penutupan" subtitle={wf.status === S.closed ? "klaim ditutup" : targetTutup ? `${cek.filter((c) => c.ok).length} dari ${cek.length} syarat` : "belum ada berkas"}>
                <div className="fi-sect-in">
                    {strip("tutup")}
                    {wf.status === S.closed ? (
                        <div style={{ maxWidth: "30rem" }}>
                            <KeyValues items={[["Ditutup", `${wf.closedAt ? jamWita(wf.closedAt) : "–"}${wf.closedBy ? ` · ${wf.closedBy}` : ""}`], ["Catatan", wf.closeNote || "–"]]} />
                        </div>
                    ) : (
                        <>
                            {banyakBerkas && terbuka.length > 0 && (
                                <FormField label="Berkas yang ditutup">{(a) => (
                                    <select {...a} className="fi-input" value={targetTutup?.id ?? ""} onChange={(e) => setTutupBerkas(e.target.value)}>
                                        {terbuka.map((s) => <option key={s.id} value={s.id}>{s.noClaim || judulBerkas(s)} · {statusKlaim(s.status).label}</option>)}
                                    </select>
                                )}</FormField>
                            )}
                            {targetTutup ? (
                                <ul className="fi-chkl" aria-label="Syarat penutupan">
                                    {cek.map((c) => (
                                        <li key={c.label} data-ok={c.ok}>
                                            {c.ok ? <CircleCheck className="fi-icon" aria-hidden /> : <Clock className="fi-icon" aria-hidden />}
                                            {c.label}<span className="sr-only">{c.ok ? " (terpenuhi)" : " (belum)"}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : <MessageStrip tone="warn" title="Belum bisa ditutup:">{blokir.join(" ")}</MessageStrip>}
                            <FormField label="Catatan penutupan" required help="Mis. lunas dua termin, bukti transfer lengkap.">
                                {(a) => <textarea {...a} className="fi-input" rows={3} disabled={!siapTutup} value={catatanTutup} onChange={(e) => setCatatanTutup(e.target.value)} />}
                            </FormField>
                            {banyakBerkas && tahap !== "lunas" && (
                                <div className="fi-btnrow">
                                    <Button icon={<Lock className="fi-icon" aria-hidden />} disabled={Boolean(alasanTutup)} disabledReason={alasanTutup} onClick={() => setDialog("tutup")}>Tutup berkas…</Button>
                                    {alasanTutup && <span className="fi-small fi-subtle">{alasanTutup}</span>}
                                </div>
                            )}
                            {tahap === "sebagian" && <VariantNote bl="BL-42">Klaim yang dibayar kurang oleh principal tidak bisa ditutup dan tertahan di Dibayar sebagian. Usulan: catat selisih principal (dipotong, ditolak, kompensasi) dengan alasan dan bukti.</VariantNote>}
                        </>
                    )}
                </div>
            </Section>

            <Section id="riwayat" title="Riwayat" subtitle="terbaru di atas">
                {!bolehRiwayat || (audit.status === "galat" && !audit.data && /403|forbidden|izin|akses|permission/i.test(audit.error ?? ""))
                    ? <div className="fi-sect-in"><p className="fi-small fi-subtle">Riwayat hanya untuk pemegang izin persetujuan Claim Workflow.</p></div>
                    : audit.status === "memuat" && !audit.data ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat riwayat" /></div>
                    : audit.status === "galat" && !audit.data ? (
                        <div className="fi-sect-in"><MessageStrip tone="warn" title="Riwayat tidak dapat ditampilkan.">{audit.error} <Button variant="tertiary" onClick={muatAudit}>Coba lagi</Button></MessageStrip></div>
                    ) : audit.data?.length ? (
                        <ul className="fi-hist">
                            {[...audit.data].reverse().map((a) => {
                                const k = kalimatAudit(a);
                                return <li key={a.id}><time dateTime={a.createdAt}>{jamWita(a.createdAt)}</time><span><b>{a.actorName || "Sistem"}</b> · {k.apa}</span>{k.ubah && <span className="fi-chg">{k.ubah}</span>}</li>;
                            })}
                        </ul>
                    ) : <EmptyState title="Belum ada riwayat" />}
                <div className="fi-sect-in">
                    <VariantNote bl="BL-33">Riwayat hari ini mencatat aksi dan catatannya, belum nilai lama → baru untuk setiap isian. Usulan: riwayat perubahan bersama yang menyimpan nilai sebelum dan sesudah.</VariantNote>
                </div>
            </Section>

            <Section id="alur" title="Alur dokumen" subtitle="dari OFF Program Control sampai pembayaran">
                <AlurDokumen off={wf.offNoPengajuan} no={no} noClaims={noClaims} jumlahBayar={aktifBayar.length} dibayar={wf.totalPaid} />
                <div className="fi-sect-in">
                    <VariantNote bl="BL-35">Alur hari ini hanya ditelusuri dari klaim ke belakang; OFF Program Control belum menautkan balik ke klaim ini. Usulan: tautan dua arah OFF ↔ klaim ↔ pembayaran.</VariantNote>
                </div>
            </Section>

            {footer}

            <ConfirmDialog open={dialog === "siap"} onClose={tutupDialog} title={`Tandai ${no} siap dikirim?`} tag="Tahap" confirmLabel="Tandai siap dikirim"
                description="Setelah ditandai, item dan pajak tidak bisa diubah kecuali dikembalikan ke draf." onConfirm={() => transisi("mark_ready")}
                facts={[["No Claim", noClaims.join(", ") || "–"], ["Item", `${items.length} · ${rupiah(wf.totalClaim)}`], ["Dokumen", "Surat klaim, Ringkasan, Kwitansi"]]} />
            <ConfirmDialog open={dialog === "draf"} onClose={tutupDialog} title="Kembalikan ke draf?" tag="Alasan wajib" tone="negative" confirmLabel="Kembalikan ke draf"
                reason={{ label: "Alasan", placeholder: "Mis. PPN item 3 salah tarif; principal minta dipisah." }} onConfirm={(alasan) => transisi("return_to_draft", alasan)}
                description={dokAda.length + dokBerkas > 0
                    ? <MessageStrip tone="warn" title={`${dokAda.length + dokBerkas} dokumen PDF yang sudah dibuat akan dihapus:`}>{[...dokAda.map((doc) => doc.label), ...(dokBerkas ? [`${dokBerkas} dokumen berkas`] : [])].join(", ")}. Buat ulang setelah perbaikan.</MessageStrip>
                    : "Belum ada dokumen yang dibuat; tidak ada yang dihapus."}
                facts={[["Status", "Siap dikirim → Draf"], ["Setelah ini", "Item, pajak, dan No Claim bisa diubah lagi"]]} />
            <ConfirmDialog open={dialog === "kirim"} onClose={tutupDialog} title={`Kirim ${no} ke principal?`} tag="Tahap" confirmLabel="Kirim ke principal"
                description="Setelah dikirim, item dan pajak terkunci. Hari ini belum ada jalan revisi atau batal sesudahnya (usulan BL-14)." onConfirm={() => transisi("submit_to_principal")}
                facts={[["No Claim", noClaims.join(", ") || "–"], ["Total klaim", rupiah(wf.totalClaim)], ["Dokumen", `${dokAda.length} PDF`], ["Tanggal kirim", `${tanggalPendek(witaToday())} (umur tagihan dihitung dari sini)`]]} />
            <ConfirmDialog open={dialog === "bayar"} onClose={tutupDialog} title={`Catat pembayaran ${rupiah(Number.isFinite(nominal) ? nominal : 0)} dari ${wf.principleName}?`} tag="Pembayaran"
                confirmLabel={`Catat ${rupiah(Number.isFinite(nominal) ? nominal : 0)}`} confirmDisabled={lebihBayar || undefined} onConfirm={catatBayar}
                description={<MessageStrip tone="info">Bila orang lain mencatat pembayaran klaim ini bersamaan, hari ini keduanya bisa tersimpan (BL-08 belum). Periksa riwayat pembayaran sesudahnya.</MessageStrip>}
                facts={[
                    ["Klaim", <span key="k" className="fi-mono">{no}</span>],
                    ...(banyakBerkas && targetBayar ? [["Berkas", targetBayar.noClaim || judulBerkas(targetBayar)]] as Fakta : []),
                    ["Tanggal diterima", tanggalPendek(bayar.paymentDate)],
                    ["Cara bayar principal", bayar.paymentType.trim() || "–"],
                    ["Bukti", "Belum bisa dilampirkan (BL-07)"],
                    ["Sisa setelah ini", lebihBayar ? lebihBayar : sisaSesudah === 0 ? "Rp 0 → status Lunas" : `${rupiah(sisaSesudah)} → status Dibayar sebagian`],
                ]} />
            <ConfirmDialog open={dialog === "void"} onClose={() => { setDialog(null); setVoidPay(null); }} title={`Batalkan pembayaran ${rupiah(voidPay?.paymentAmount ?? 0)}?`} tag="Alasan wajib" tone="negative"
                confirmLabel="Batalkan pembayaran" reason={{ label: "Alasan", placeholder: "Mis. transfer salah alamat; principal menarik kembali." }} onConfirm={batalkanBayar}
                facts={voidPay ? [["Tanggal diterima", tanggalPendek(voidPay.paymentDate)], ["Cara bayar principal", voidPay.paymentType || "–"], ["Akibat", akibatVoid], ["Catatan", "Pembayaran tidak dihapus; tercatat sebagai dibatalkan"]] : []} />
            <ConfirmDialog open={dialog === "tutup"} onClose={tutupDialog} title={`Tutup ${banyakBerkas && targetTutup ? `berkas ${targetTutup.noClaim || judulBerkas(targetTutup)}` : `klaim ${no}`}?`}
                tag={`${cek.filter((c) => c.ok).length}/${cek.length} syarat`} confirmLabel={banyakBerkas ? "Tutup berkas" : "Tutup klaim"} onConfirm={tutupKlaim}
                description="Setelah ditutup, No Claim, item, dan pembayaran terkunci."
                facts={targetTutup ? [["Total klaim", rupiah(targetTutup.totalClaim)], ["Dibayar", `${rupiah(targetTutup.totalPaid)} · ${jumlahBayarAktif} pembayaran aktif`], ["Catatan", catatanTutup.trim()]] : []} />
            <ConfirmDialog open={dialog === "gabung"} onClose={() => { setDialog(null); setGabung(null); }} title={`Gabungkan ke berkas ${gabung?.noClaim ?? ""}?`} tag="BL-15" confirmLabel="Gabungkan"
                onConfirm={() => (gabung ? kirimNoClaim(gabung.sub, gabung.noClaim, true) : undefined)}
                description="Bila bukan maksud Anda, batalkan dan isi No Claim lain. Di klaim lain, No Claim yang sama selalu ditolak."
                facts={gabung ? [
                    ["No Claim yang Anda isi", <span key="n" className="fi-mono">{gabung.noClaim}</span>],
                    ["Sudah dipakai", `Berkas ${judulBerkas(gabung.target)} di klaim yang sama · ${gabung.target.itemCount ?? 0} item`],
                    ["Bila digabung", `${gabung.sub.itemCount ?? 0} item dari berkas ${judulBerkas(gabung.sub)} pindah ke berkas itu; berkas asal dihapus; surat klaim, ringkasan, dan kwitansi klaim dihapus dan perlu dibuat ulang`],
                ] : []} />
            <ConfirmDialog open={dialog === "pindah"} onClose={() => { setDialog(null); setPindah(null); }} title={`Pindahkan item ${pindah ? nomor.get(pindah.item.id) : ""} ke berkas ${pindah ? pindah.target.noClaim || judulBerkas(pindah.target) : ""}?`}
                tag="Berkas" confirmLabel="Pindahkan item" onConfirm={pindahItem}
                facts={pindah ? [
                    ["Item", `${pindah.item.noSurat || "–"} · ${pindah.item.outlet || "–"} · ${rupiah(pindah.item.nilaiKlaim)}`],
                    ["Dari", (() => { const s = subOf(pindah.item.claimSubmissionId); return s ? s.noClaim || judulBerkas(s) : "–"; })()],
                    ["Ke", pindah.target.noClaim || judulBerkas(pindah.target)],
                    ["Akibat", "Total kedua berkas dihitung ulang"],
                ] : []} />
        </div>
    );
}
