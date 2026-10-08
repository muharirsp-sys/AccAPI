/*
 * Tujuan: Fondasi bersama OFF Program Control (Fiori S4d): konteks peran, hook data (daftar batch + polling, detail batch),
 *   worklist kolom pertama (Antrean) dengan saringan, dan KerjaPeran = FlexibleColumnLayout antrean ↔ Object Page batch.
 * Caller: OpcApp.tsx, opc/peran/*.tsx, opc/ObjectPageBatch.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/opc-ui, lib/off-program-control/{problematic,dev-fixtures,access},
 *   lib/promo-ui (rupiah), lib/claim-workflow-ui (pesanGalat).
 * Main Functions: useDaftarBatch, useDetailBatch, KerjaPeran, Antrean, ambilOpc, tulisOpc.
 * Side Effects: GET /api/off-program-control/batches (polling 45 dtk + fokus tab), GET /batches/[id], /batches/[id]/refund,
 *   /batches/[id]/audit. Tidak ada tulis di berkas ini (tulisOpc hanya helper untuk agen peran).
 *
 * ═══ KONTRAK UNTUK AGEN PERAN (berkas ini, ObjectPageBatch.tsx, OpcApp.tsx, lib/opc-ui.ts = BERSAMA; JANGAN diubah) ═══
 *
 * 1. Modul peran = `opc/peran/<Nama>.tsx`, `export default function X(props: PeranProps)`. PeranProps = { ctx, daftar }:
 *    - ctx: OpcKonteks — peran (OffRole kode lama), perms (izin grup akses dari server; info D-17, BUKAN penentu tombol — kecuali Tutup periode, lihat alasanTutupPeriode),
 *      pengguna {id,nama}, tab, sub (claimView/view ter-normalisasi), batchId (`?batch=`), devBatchCount (`?mock=`),
 *      izin(aksi) → alasan nonaktif | undefined (= canPerformOffAction kode lama, matriks D-01 belum berubah), bukaBatch(id|null),
 *      pilihSub(kunci|null), ubahUrl({kunci: nilai|null}), setDraf(boolean).
 *      Semua navigasi lewat ctx (dijaga dialog "Tinggalkan perubahan?" bila ada draf).
 *    - daftar: DaftarOpc — load (Load<BatchOpc[]>, 200 terbaru, galat ≠ kosong), batches, muatUlang(), masalah (SLA untuk peran ini),
 *      masalahPer (Map batchId → masalah, untuk tanda baris).
 * 2. Pakai `<KerjaPeran {...props} tampilan={TAMPILAN.<tab> atau buatanmu} Detail={KomponenDetailmu} atas={…} />`.
 *    - `tampilan`: Tampilan[] dari lib/opc-ui (predikat kode lama). Boleh menambah tampilan lokal (mis. Data Selisih SPV:
 *      `{ kunci: "selisih", label: "Data selisih", antrean: PREDIKAT.selisihTerbuka, kosong: "…" }`); dipilih lewat `ctx.sub`.
 *    - `Detail`: komponen kolom kedua, dirender dengan `key = batchId` (state form otomatis ter-reset per batch). Props = DetailProps:
 *      { ctx, daftar, batchId, ringkas (baris daftar | undefined), detail: Load<DetailBatch>, muatUlang(), selesai(pesan, keterangan?), masalah }.
 *      Tanpa `Detail` = Object Page baca-saja.
 *    - `atas`: isi di atas saringan (mis. ringkasan angka peran, panel khusus peran).
 *    - `kolomKedua`: { isi, tutup } = isi kolom kedua selain batch (form batch baru SPV, form CLM Klaim); `tutup` = "Kembali ke daftar".
 *      Simpan keadaan "sedang membuat" di URL lewat `ctx.ubahUrl({ view: "baru" })` / `ctx.sub` supaya tombol Kembali peramban bekerja.
 * 3. Di dalam Detail, render `<ObjectPageBatch {...props} … />` (opc/ObjectPageBatch.tsx) dengan SLOT:
 *    - `bagian`: BagianTambahan[] = { id, label, isi, letak?: "awal" | "setelahItem" (bawaan) | "akhir" } — masuk AnchorBar.
 *    - `gantiItem`: ReactNode pengganti isi bagian Item (mode ubah SPV: daftar item + form berlabel per item).
 *    - `strip`: ReactNode di bawah header (mis. galat 409/BL-09, sukses lokal).
 *    - `aksi`: isi FooterToolbar (tombol; aksi utama `variant="primary"` di kanan, tolak `variant="negative"`).
 *    - `pesanFooter`: alasan tombol nonaktif / ringkasan pilihan; `draf`: indikator "Draf belum disimpan" di header.
 *    Data detail: `detail.data` = DetailBatch { batch (gabungan baris daftar + GET /batches/[id]), items, payments, paymentSummary,
 *    summary, refund: Load<{refunds, summary}>, audit: Load<AuditOpc[]>, uji (fixture ?mock=) }.
 * 4. Aksi tulis = `ConfirmDialog` (components/fiori/interactive): judul pertanyaan, `facts` (jumlah/nilai/periode), `reason` untuk alasan
 *    wajib (Kembalikan/Batalkan/Tolak refund), `onConfirm` = `async (alasan) => { await tulisOpc(url, { body }); tutupDialog();
 *    props.selesai("Disetujui … diteruskan ke Klaim."); }`. Galat yang dilempar tulisOpc tampil di dialog (isian tidak hilang);
 *    ConfirmDialog sudah menahan klik ganda. `selesai(pesan, keterangan?)` = strip sukses (keterangan bawaan "Batch pindah ke antrean tahap berikutnya.", null = tanpa) + muat ulang daftar & detail.
 *    Tombol mengikuti peran: `disabledReason={ctx.izin("sm_approve")}` + `disabled={Boolean(ctx.izin("sm_approve"))}`; izin granular
 *    grup akses (D-17) ditegakkan server → 403 tampil di dialog (catatan: LOCAL_AUTH_BYPASS admin tidak punya key granular OPC,
 *    jadi tanpa mock server lokal menolak tulis OPC; spec Playwright memock API). Lalu predikat
 *    aksi kode lama dari PREDIKAT (smAntrean, klaimAntrean, finalAntrean, omAntrean, keuanganBisaBayar, spvBisaUbah). BL-06: aksi
 *    untuk batch terminal disembunyikan.
 * 5. Draf: `useEffect(() => { props.ctx.setDraf(dirty); return () => props.ctx.setDraf(false); }, [dirty])` — OpcApp memasang
 *    useUnsavedGuard dan dialog sebelum pindah batch/tab. Kirim `draf={dirty}` ke ObjectPageBatch.
 * 6. Helper: ambilOpc (GET → Load), tulisOpc (POST/PATCH JSON atau FormData → data | throw Error pesan server; jawaban tidak pasti —
 *    putus, ≥ 502, bukan JSON — → throw TulisTidakPasti(PESAN_TIDAK_PASTI)), lib/opc-ui
 *    (infoTahap, alurBatch, labelStatus, tanggalOpc, waktuWita, periodeBatch, totalBatch, kelengkapanItem, izinAksi),
 *    lib/promo-ui `rupiah`. Teks Indonesia, tanpa kode status mentah; nominal `fi-tnum`, nomor `fi-mono`.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button, EmptyState, ErrorState, FlexibleColumnLayout, ListItem, MessageStrip, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import type { OffAction, OffRole, OffTab } from "@/lib/off-program-control/access";
import { createOffDevBatches, isOffDevBatchId } from "@/lib/off-program-control/dev-fixtures";
import { detectProblematicBatches, getProblemsForRole, type ProblematicBatch } from "@/lib/off-program-control/problematic";
import { pesanGalat } from "@/lib/claim-workflow-ui";
import { rupiah } from "@/lib/promo-ui";
import {
    JENIS_TANGGAL, OPSI_TAHAP, SARINGAN_KOSONG, infoTahap, jumlahItem, jumlahSaringan, opsiPrincipal, periodeBatch, saringBatch, totalBatch,
    type AuditOpc, type BatchOpc, type ItemOpc, type JenisTanggal, type PembayaranOpc, type RefundOpc, type RingkasanBayar, type RingkasanRefund,
    type Saringan, type TahapKey, type Tampilan,
} from "@/lib/opc-ui";
// ObjectPageBatch hanya mengimpor TIPE dari berkas ini (terhapus saat kompilasi), jadi tidak ada impor melingkar saat runtime.
import { ObjectPageBatch } from "./ObjectPageBatch";

// ── Tipe kontrak ────────────────────────────────────────────────────────────────────────────────────────

export type OpcKonteks = {
    peran: OffRole;
    perms: ReadonlySet<string>;
    pengguna: { id: string; nama: string };
    tab: OffTab;
    /** Sub-tampilan: claimView ter-normalisasi (after-sm | after-finance | data-claim) untuk Klaim, `view` untuk tab lain. */
    sub: string | null;
    batchId: string | null;
    devBatchCount: number;
    /** undefined = boleh; selain itu alasan (untuk disabledReason). Matriks peran OFF kode lama (canPerformOffAction). */
    izin: (aksi: OffAction) => string | undefined;
    bukaBatch: (id: string | null) => void;
    pilihSub: (kunci: string | null) => void;
    ubahUrl: (ubah: Record<string, string | null>) => void;
    setDraf: (draf: boolean) => void;
};

export type DaftarOpc = {
    load: Load<BatchOpc[]>;
    batches: BatchOpc[];
    muatUlang: () => void;
    /** Masalah SLA untuk peran ini (lonceng). */
    masalah: ProblematicBatch[];
    /** Semua masalah per batch (tanda baris, header Object Page). */
    masalahPer: ReadonlyMap<string, ProblematicBatch[]>;
};

export type PeranProps = { ctx: OpcKonteks; daftar: DaftarOpc };

export type DetailBatch = {
    batch: BatchOpc;
    items: ItemOpc[];
    payments: PembayaranOpc[];
    paymentSummary?: RingkasanBayar;
    summary?: { totalRows: number; totalNominal: number; transfer?: number; tunai?: number };
    refund: Load<{ refunds: RefundOpc[]; summary: RingkasanRefund | null }>;
    audit: Load<AuditOpc[]>;
    /** Batch fixture `?mock=` (tanpa HTTP detail, sama dengan kode lama). */
    uji: boolean;
};

export type DetailProps = {
    ctx: OpcKonteks;
    daftar: DaftarOpc;
    batchId: string;
    ringkas?: BatchOpc;
    detail: Load<DetailBatch>;
    muatUlang: () => void;
    /** Setelah aksi berhasil: strip sukses + muat ulang daftar dan detail. */
    /** `keterangan` = kalimat di bawah judul strip; bawaan "Batch pindah ke antrean tahap berikutnya.", `null` = tanpa kalimat (simpan draf, kembalikan, refund). */
    selesai: (pesan: string, keterangan?: string | null) => void;
    masalah: ProblematicBatch[];
};

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────

/** Respons kosong/bukan JSON → { error: teks } (parseJsonResponse kode lama). */
async function bacaJson(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: text }; }
}

/** GET endpoint OPC → Load. Gagal bila HTTP bukan 2xx ATAU `ok` bukan true (sama dengan cek kode lama). */
export async function ambilOpc<T>(url: string, pick: (json: Record<string, unknown>) => T, umum = "Data belum berhasil dimuat."): Promise<Load<T>> {
    try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        const data = await bacaJson(res);
        if (res.status === 403) return { status: "galat", error: `${umum} Akun Anda belum punya izin untuk data ini; minta admin menambahkannya ke grup akses.` };
        if (!res.ok || !data.ok) return { status: "galat", error: pesanGalat(umum, String(data.error || data.message || `HTTP ${res.status}`)) };
        return { status: "siap", data: pick(data) };
    } catch (e) {
        return { status: "galat", error: pesanGalat(umum, e instanceof Error ? e.message : String(e)) };
    }
}

/** Pesan bila jawaban server tidak pasti (aksi mungkin sudah tersimpan). */
export const PESAN_TIDAK_PASTI = "Server tidak memberi jawaban yang pasti — hasilnya belum pasti; muat ulang untuk memeriksa sebelum mengulang.";
/** Dilempar tulisOpc bila hasil tulis TIDAK PASTI (koneksi putus, status ≥ 502, badan bukan JSON). */
export class TulisTidakPasti extends Error {}

/**
 * Tulis ke endpoint OPC (untuk agen peran). Objek → JSON; FormData apa adanya. Respons JSON gagal (4xx/500, `ok` bukan true) →
 * throw Error(pesan server). Jawaban TIDAK PASTI — koneksi putus, status ≥ 502, atau badan bukan JSON (mis. halaman HTML
 * "504 Gateway Time-out" dari proxy) — → throw TulisTidakPasti(PESAN_TIDAK_PASTI), tidak pernah teks/HTML mentah.
 */
export async function tulisOpc(url: string, opsi: { method?: "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> | FormData; gagal?: string } = {}) {
    const isForm = typeof FormData !== "undefined" && opsi.body instanceof FormData;
    let res: Response;
    let text: string;
    try {
        res = await fetch(url, {
            method: opsi.method ?? "POST",
            credentials: "include",
            headers: opsi.body && !isForm ? { "Content-Type": "application/json" } : undefined,
            body: opsi.body ? (isForm ? (opsi.body as FormData) : JSON.stringify(opsi.body)) : undefined,
        });
        text = await res.text();
    } catch {
        throw new TulisTidakPasti(PESAN_TIDAK_PASTI);
    }
    let data: Record<string, unknown> | null;
    try {
        const j: unknown = text ? JSON.parse(text) : {};
        data = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
        data = null;
    }
    if (res.status >= 502 || data === null) throw new TulisTidakPasti(PESAN_TIDAK_PASTI);
    if (!res.ok || !data.ok) throw new Error(String(data.error || data.message || opsi.gagal || "Aksi gagal. Coba lagi."));
    return data;
}

// ── Daftar batch ────────────────────────────────────────────────────────────────────────────────────────

const INTERVAL_MS = 45_000;

/**
 * Satu daftar untuk seluruh halaman (antrean, lonceng, pencarian): GET /batches = 200 batch terbaru (BL-13), polling 45 dtk +
 * fokus/visibilitas tab seperti tab lama. SPV hanya batch buatannya (lapis kedua; server sudah memfilter, kode lama 3051).
 * `?mock=` (development) = fixture di memori, tanpa HTTP dan tanpa polling.
 */
export function useDaftarBatch({ peran, penggunaId, devBatchCount, aktif = true }: { peran: OffRole; penggunaId: string; devBatchCount: number; aktif?: boolean }): DaftarOpc {
    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<BatchOpc[]>> => {
        // Sebelum sesi/peran siap (atau tanpa akses) tidak ada permintaan.
        if (!aktif) return { status: "memuat" };
        if (devBatchCount > 0) return { status: "siap", data: createOffDevBatches(devBatchCount) as BatchOpc[] };
        const r = await ambilOpc("/api/off-program-control/batches", (j) => (Array.isArray(j.batches) ? (j.batches as BatchOpc[]) : []),
            "Data pengajuan belum berhasil dimuat.");
        if (r.status !== "siap" || !(peran === "supervisor" && penggunaId)) return r;
        return { ...r, data: r.data!.filter((b) => b.createdBy === penggunaId) };
    }, [peran, penggunaId, devBatchCount, aktif]));

    const ulangRef = useRef(muatUlang);
    useEffect(() => { ulangRef.current = muatUlang; });
    useEffect(() => {
        if (devBatchCount > 0 || !aktif) return;
        const segarkan = () => { if (document.visibilityState !== "hidden") ulangRef.current(); };
        const timer = window.setInterval(segarkan, INTERVAL_MS);
        window.addEventListener("focus", segarkan);
        document.addEventListener("visibilitychange", segarkan);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", segarkan);
            document.removeEventListener("visibilitychange", segarkan);
        };
    }, [devBatchCount, aktif]);

    const batches = useMemo(() => load.data ?? [], [load.data]);
    // BL-11: SLA dihitung di browser dari daftar yang sama (hari kerja + libur nasional, lib/off-program-control/problematic).
    const semuaMasalah = useMemo(() => detectProblematicBatches(batches.map((b) => ({
        id: b.id, noPengajuan: b.noPengajuan, principleName: b.principleName, status: b.status, smStatus: b.smStatus, claimStatus: b.claimStatus,
        omStatus: b.omStatus, financeStatus: b.financeStatus, finalStatus: b.finalStatus, locked: b.locked, claimDeadline: b.claimDeadline,
        submittedAt: b.submittedAt, smApprovedAt: b.smApprovedAt, claimReviewedAt: b.claimReviewedAt, returnedAt: b.returnedAt, paidAt: b.paidAt,
        createdAt: b.createdAt, updatedAt: b.updatedAt, refundStatus: b.refundStatus, completenessStatus: b.completenessStatus,
    }))), [batches]);
    const masalah = useMemo(() => getProblemsForRole(semuaMasalah, peran), [semuaMasalah, peran]);
    const masalahPer = useMemo(() => {
        const per = new Map<string, ProblematicBatch[]>();
        for (const m of semuaMasalah) per.set(m.batchId, [...(per.get(m.batchId) ?? []), m]);
        return per;
    }, [semuaMasalah]);
    return { load, batches, muatUlang, masalah, masalahPer };
}

// ── Detail batch ────────────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;
const KOSONG_LOAD = { status: "siap" as const, data: { refunds: [], summary: null } };

/** GET /batches/[id] (wajib) + /refund + /audit (galatnya per bagian, bukan seluruh halaman). Baris daftar melengkapi agregat. */
export function useDetailBatch(batchId: string, ringkas?: BatchOpc): [Load<DetailBatch>, () => void] {
    // Baris daftar hanya dipakai sebagai pelengkap (claimWorkflowId, periodDates); tidak memicu muat ulang saat polling.
    const ringkasRef = useRef(ringkas);
    useEffect(() => { ringkasRef.current = ringkas; });
    // Fixture ?mock= tidak punya detail di server: tunggu barisnya ada di daftar (dimuat ulang saat baris tiba).
    const ujiSiap = isOffDevBatchId(batchId) && Boolean(ringkas);
    return useLoad(useCallback(async (): Promise<Load<DetailBatch>> => {
        const baris = ringkasRef.current;
        if (isOffDevBatchId(batchId)) {
            if (!ujiSiap || !baris) return { status: "memuat" };
            return { status: "siap", data: { batch: baris, items: [], payments: [], paymentSummary: baris.paymentSummary, refund: KOSONG_LOAD, audit: { status: "siap", data: [] }, uji: true } };
        }
        const dasar = `/api/off-program-control/batches/${enc(batchId)}`;
        const [utama, refund, audit] = await Promise.all([
            ambilOpc(dasar, (j) => j, "Detail batch belum berhasil dimuat."),
            ambilOpc(`${dasar}/refund`, (j) => ({ refunds: Array.isArray(j.refunds) ? (j.refunds as RefundOpc[]) : [], summary: (j.summary as RingkasanRefund) ?? null }),
                "Riwayat pengembalian selisih belum berhasil dimuat."),
            ambilOpc(`${dasar}/audit`, (j) => (Array.isArray(j.audit) ? (j.audit as AuditOpc[]) : []), "Riwayat batch belum berhasil dimuat."),
        ]);
        if (utama.status !== "siap") {
            const hilang = /not found|tidak ditemukan/i.test(utama.error ?? "");
            return { status: "galat", error: hilang ? "Batch tidak ditemukan, atau bukan batch yang boleh Anda buka." : utama.error };
        }
        const j = utama.data!;
        const payments = Array.isArray(j.payments) ? (j.payments as PembayaranOpc[]) : [];
        const summary = j.summary as DetailBatch["summary"];
        const paymentSummary = j.paymentSummary as RingkasanBayar | undefined;
        return {
            status: "siap",
            data: {
                batch: { ...(baris ?? {}), ...(j.batch as BatchOpc), summary: summary ?? baris?.summary, paymentSummary, payments },
                items: Array.isArray(j.items) ? (j.items as ItemOpc[]) : [],
                payments, paymentSummary, summary, refund, audit, uji: false,
            },
        };
    }, [batchId, ujiSiap]));
}

// ── Antrean (kolom pertama) ─────────────────────────────────────────────────────────────────────────────

type Cakupan = "antrean" | "semua";

/** Worklist: kepala (judul + jumlah), pilihan "Menunggu Anda | Semua", enam keadaan, baris ListItem dengan tanda lewat SLA. */
export function Antrean({ ctx, daftar, tampilan, rows, dasar, cakupan, setCakupan, nAntrean, nPantau, adaSaringan, hapusSaringan }: {
    ctx: OpcKonteks; daftar: DaftarOpc; tampilan: Tampilan; rows: BatchOpc[]; dasar: BatchOpc[]; cakupan: Cakupan; setCakupan: (c: Cakupan) => void;
    nAntrean: number; nPantau: number; adaSaringan: boolean; hapusSaringan: () => void;
}) {
    const { load } = daftar;
    const memuatAwal = load.status === "memuat" && !load.data;
    let isi: ReactNode;
    if (memuatAwal) isi = <div className="fi-sect-in"><Skeleton rows={6} label="Memuat antrean" /></div>;
    else if (load.status === "galat" && !load.data) isi = <ErrorState title="Antrean gagal dimuat" message={`${load.error ?? ""} Ini bukan daftar kosong.`} onRetry={daftar.muatUlang} />;
    else if (dasar.length === 0) {
        isi = (
            <EmptyState
                title={cakupan === "antrean" ? tampilan.kosong : "Belum ada pengajuan di tampilan ini."}
                message="Batch baru muncul di sini saat tahapnya sampai ke Anda."
                action={cakupan === "antrean" && tampilan.pantau && nPantau > 0 ? <Button onClick={() => setCakupan("semua")}>Lihat semua ({nPantau})</Button> : undefined}
            />
        );
    } else if (rows.length === 0) {
        isi = <EmptyState title="Tidak ada batch yang cocok dengan saringan" message={adaSaringan ? "Ubah atau hapus saringan untuk melihat batch lain." : undefined}
            action={adaSaringan ? <Button onClick={hapusSaringan}>Hapus saringan</Button> : undefined} />;
    } else {
        isi = (
            <ul className="fi-list" style={{ display: "block" }} aria-label={`Antrean ${tampilan.label}`}>
                {rows.map((b) => {
                    const masalah = daftar.masalahPer.get(b.id) ?? [];
                    const info = infoTahap(b, masalah.length > 0);
                    const n = jumlahItem(b);
                    return (
                        <li key={b.id} className="fi-wl-row">
                            <ListItem doc={b.noPengajuan} amount={rupiah(totalBatch(b))} title={b.principleName}
                                meta={[b.supervisorName && `SPV ${b.supervisorName}`, n ? `${n} item` : "", periodeBatch(b), masalah.length ? `Lewat SLA: ${masalah[0].title}` : ""].filter(Boolean).join(" · ")}
                                badge={<StatusBadge tone={info.tone}>{info.label}</StatusBadge>}
                                current={ctx.batchId === b.id} onClick={() => ctx.bukaBatch(b.id)} />
                        </li>
                    );
                })}
            </ul>
        );
    }
    return (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }} aria-busy={(load.status === "memuat" && Boolean(load.data)) || undefined}>
            <header>
                <h2>{tampilan.label}</h2>
                <span>{memuatAwal ? "" : `${rows.length} batch`}{load.status === "memuat" && load.data ? " · memperbarui…" : ""}</span>
            </header>
            {tampilan.pantau && (
                <div className="fi-sect-in" style={{ paddingBottom: 0 }}>
                    <div className="fi-segs" role="group" aria-label="Cakupan antrean">
                        <button type="button" aria-pressed={cakupan === "antrean"} onClick={() => setCakupan("antrean")}>Menunggu Anda ({nAntrean})</button>
                        <button type="button" aria-pressed={cakupan === "semua"} onClick={() => setCakupan("semua")}>Semua ({nPantau})</button>
                    </div>
                </div>
            )}
            {isi}
        </div>
    );
}

// ── KerjaPeran: saringan + FCL ──────────────────────────────────────────────────────────────────────────

type KerjaProps = PeranProps & {
    tampilan: Tampilan[];
    Detail?: ComponentType<DetailProps>;
    atas?: ReactNode;
    saringanAwal?: Partial<Saringan>;
    /** Isi kolom kedua selain batch (mis. form batch baru SPV / CLM Klaim); `tutup` dipanggil tombol "Kembali ke daftar". */
    kolomKedua?: { isi: ReactNode; tutup: () => void };
};

/** Worklist peran di kolom pertama + batch terbuka (`?batch=`) di kolom kedua. Di ponsel satu kolom dengan "Kembali ke daftar". */
type PesanSukses = { judul: string; keterangan?: string };

export function KerjaPeran({ ctx, daftar, tampilan, Detail = DetailBacaSaja, atas, saringanAwal, kolomKedua }: KerjaProps) {
    const [saringan, setSaringan] = useState<Saringan>(() => ({ ...SARINGAN_KOSONG, ...saringanAwal }));
    const [cakupan, setCakupan] = useState<Cakupan>("antrean");
    const [pesan, setPesan] = useState<PesanSukses | null>(null);
    const aktif = tampilan.find((t) => t.kunci === ctx.sub) ?? tampilan[0];
    const semua = daftar.batches;
    const dasarAntrean = useMemo(() => semua.filter(aktif.antrean), [semua, aktif]);
    const dasarPantau = useMemo(() => (aktif.pantau ? semua.filter(aktif.pantau) : dasarAntrean), [semua, aktif, dasarAntrean]);
    const dasar = cakupan === "semua" && aktif.pantau ? dasarPantau : dasarAntrean;
    const rows = useMemo(() => saringBatch(dasar, saringan), [dasar, saringan]);
    const principals = useMemo(() => opsiPrincipal(semua), [semua]);
    const ubah = (u: Partial<Saringan>) => setSaringan((s) => ({ ...s, ...u }));
    const hapus = () => setSaringan(SARINGAN_KOSONG);
    const nSaringan = jumlahSaringan(saringan);
    const ringkas = ctx.batchId ? semua.find((b) => b.id === ctx.batchId) : undefined;
    const labelPrincipal = principals.find((p) => p.value === saringan.principal)?.label ?? saringan.principal;
    const labelTahap = OPSI_TAHAP.find((o) => o.kunci === saringan.tahap)?.label ?? "";
    const labelPeriode = saringan.bulan ? `${JENIS_TANGGAL[saringan.jenisTanggal]}: ${saringan.bulan.split("-").reverse().join("/")}`
        : `${JENIS_TANGGAL[saringan.jenisTanggal]}: ${saringan.dari ? saringan.dari.split("-").reverse().join("/") : "awal"} – ${saringan.sampai ? saringan.sampai.split("-").reverse().join("/") : "akhir"}`;

    return (
        <div style={{ display: "grid", gap: 12 }}>
            {tampilan.length > 1 && (
                <div className="fi-segs" role="group" aria-label="Tampilan antrean">
                    {tampilan.map((t) => (
                        <button key={t.kunci} type="button" aria-pressed={t.kunci === aktif.kunci} onClick={() => ctx.pilihSub(t.kunci)}>
                            {t.label} ({semua.filter(t.antrean).length})
                        </button>
                    ))}
                </div>
            )}
            {atas}
            {pesan && <MessageStrip tone="pos" title={pesan.judul} onClose={() => setPesan(null)}>{pesan.keterangan}</MessageStrip>}
            {daftar.load.status === "galat" && daftar.load.data && (
                <MessageStrip tone="neg" title="Gagal memuat ulang antrean.">
                    {daftar.load.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={daftar.muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar
                    title="Saringan"
                    activeCount={nSaringan}
                    onReset={hapus}
                    search={<FormField label="Cari">{(a) => <input {...a} className="fi-input" type="search" placeholder="Nomor, principal, SPV, toko, No Claim" value={saringan.cari} onChange={(e) => ubah({ cari: e.target.value })} />}</FormField>}
                    fields={<>
                        <FormField label="Principal">{(a) => (
                            <select {...a} className="fi-input" value={saringan.principal} onChange={(e) => ubah({ principal: e.target.value })}>
                                <option value="">Semua principal</option>
                                {principals.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Tahap">{(a) => (
                            <select {...a} className="fi-input" value={saringan.tahap} onChange={(e) => ubah({ tahap: e.target.value as TahapKey | "" })}>
                                <option value="">Semua tahap</option>
                                {OPSI_TAHAP.map((o) => <option key={o.kunci} value={o.kunci}>{o.label}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Jenis tanggal">{(a) => (
                            <select {...a} className="fi-input" value={saringan.jenisTanggal} onChange={(e) => ubah({ jenisTanggal: e.target.value as JenisTanggal })}>
                                {(Object.keys(JENIS_TANGGAL) as JenisTanggal[]).map((k) => <option key={k} value={k}>{JENIS_TANGGAL[k]}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Bulan">{(a) => <input {...a} className="fi-input" type="month" value={saringan.bulan} onChange={(e) => ubah({ bulan: e.target.value, dari: "", sampai: "" })} />}</FormField>
                        <FormField label="Dari tanggal">{(a) => <input {...a} className="fi-input" type="date" value={saringan.dari} max={saringan.sampai || undefined} onChange={(e) => ubah({ dari: e.target.value, bulan: "" })} />}</FormField>
                        <FormField label="Sampai tanggal">{(a) => <input {...a} className="fi-input" type="date" value={saringan.sampai} min={saringan.dari || undefined} onChange={(e) => ubah({ sampai: e.target.value, bulan: "" })} />}</FormField>
                    </>}
                    chips={[
                        ...(saringan.cari.trim() ? [{ label: `Cari: ${saringan.cari.trim()}`, onRemove: () => ubah({ cari: "" }) }] : []),
                        ...(saringan.principal ? [{ label: `Principal: ${labelPrincipal}`, onRemove: () => ubah({ principal: "" }) }] : []),
                        ...(saringan.tahap ? [{ label: `Tahap: ${labelTahap}`, onRemove: () => ubah({ tahap: "" }) }] : []),
                        ...(saringan.bulan || saringan.dari || saringan.sampai ? [{ label: labelPeriode, onRemove: () => ubah({ bulan: "", dari: "", sampai: "" }) }] : []),
                    ]}
                />
                <FlexibleColumnLayout
                    listLabel="Antrean" detailLabel="Batch terbuka"
                    detailOpen={Boolean(kolomKedua || ctx.batchId)} onBack={kolomKedua ? kolomKedua.tutup : () => ctx.bukaBatch(null)}
                    list={<Antrean ctx={ctx} daftar={daftar} tampilan={aktif} rows={rows} dasar={dasar} cakupan={cakupan} setCakupan={setCakupan}
                        nAntrean={dasarAntrean.length} nPantau={dasarPantau.length} adaSaringan={nSaringan > 0} hapusSaringan={hapus} />}
                    detail={kolomKedua ? kolomKedua.isi : ctx.batchId
                        ? <KolomDetail key={ctx.batchId} ctx={ctx} daftar={daftar} batchId={ctx.batchId} ringkas={ringkas} Detail={Detail} setPesan={setPesan} />
                        : <EmptyState title="Belum ada batch terbuka" message="Pilih batch dari antrean. Batch juga bisa dibuka dari lonceng Pengajuan bermasalah atau pencarian (Ctrl K)." />}
                />
            </div>
            <div style={{ display: "grid", gap: 8 }}>
                <VariantNote bl="BL-13">Antrean dan saringan bekerja pada 200 batch terbaru yang dimuat ke browser; batch yang lebih lama tidak terjangkau. Usulan: saring dan paginasi di server.</VariantNote>
                <VariantNote bl="BL-11">Tanda lewat SLA dihitung di browser (hari kerja, libur nasional) dari daftar yang sama. Usulan: dihitung server dan dipakai juga oleh Kotak Tugas (BL-34).</VariantNote>
            </div>
        </div>
    );
}

/** Kolom kedua: memuat detail untuk satu batch (dipasang ulang per batch lewat `key`) lalu merender Detail peran. */
function KolomDetail({ ctx, daftar, batchId, ringkas, Detail, setPesan }: {
    ctx: OpcKonteks; daftar: DaftarOpc; batchId: string; ringkas?: BatchOpc; Detail: ComponentType<DetailProps>; setPesan: (p: PesanSukses | null) => void;
}) {
    const [detail, muatUlang] = useDetailBatch(batchId, ringkas);
    const selesai = (judul: string, keterangan: string | null = "Batch pindah ke antrean tahap berikutnya.") => {
        setPesan({ judul, keterangan: keterangan ?? undefined }); daftar.muatUlang(); muatUlang();
    };
    return <Detail ctx={ctx} daftar={daftar} batchId={batchId} ringkas={ringkas} detail={detail} muatUlang={muatUlang} selesai={selesai}
        masalah={daftar.masalahPer.get(batchId) ?? []} />;
}

/** Object Page tanpa aksi (bawaan; modul peran menggantinya lewat prop `Detail`). */
function DetailBacaSaja(props: DetailProps) {
    return <ObjectPageBatch {...props} />;
}
