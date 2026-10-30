/*
 * Tujuan: Fondasi bersama OFF Program Control (Fiori S4d): konteks peran, hook data (daftar batch + polling, detail batch),
 *   worklist kolom pertama (Antrean) dengan saringan, KerjaPeran = FlexibleColumnLayout antrean ↔ Object Page batch, dan helper tulis.
 * Caller: OpcApp.tsx, opc/peran/*.tsx, opc/ObjectPageBatch.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/opc-ui, lib/off-program-control/{problematic,dev-fixtures,access},
 *   lib/promo-ui (rupiah), lib/claim-workflow-ui (pesanGalat), lib/tampil (sebabHttp).
 * Main Functions: useDaftarBatch, useDetailBatch, KerjaPeran, Antrean, TautanBatch, ambilOpc, tulisOpc, kirimTulis, pesanTidakPasti, tanganiTulis.
 * Side Effects: GET /api/off-program-control/batches (polling 45 dtk + fokus tab), GET /batches/[id], /batches/[id]/refund,
 *   /batches/[id]/audit. Tidak ada tulis di berkas ini; tulisOpc dipanggil modul peran.
 *
 * Cara menulis modul peran: `opc/peran/<Nama>.tsx` merender `<KerjaPeran tampilan Detail atas kolomKedua />`, dan Detail-nya merender
 * `<ObjectPageBatch {...props} bagian strip aksi pesanFooter draf />`. Aksi tulis lewat ConfirmDialog yang memanggil
 * `tulisOpc(...).catch(tanganiTulis(props.laporTidakPasti, tutupDialog))` lalu `props.selesai(pesan)`: hasil TIDAK PASTI menutup dialog,
 * memuat ulang, dan meninggalkan strip peringatan (owner 27 Okt, audit No 22). Navigasi lewat `ctx` supaya penjaga draf berlaku;
 * baris batch memakai `ctx.hrefBatch` (tautan nyata `?batch=`) + `ctx.bukaBatch` (klik biasa).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button, EmptyState, ErrorState, FlexibleColumnLayout, ListItem, MessageStrip, Skeleton, StatusBadge, VariantNote, klikBiasa } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import type { OffAction, OffRole, OffTab } from "@/lib/off-program-control/access";
import { createOffDevBatches, isOffDevBatchId } from "@/lib/off-program-control/dev-fixtures";
import { detectProblematicBatches, getProblemsForRole, type ProblematicBatch } from "@/lib/off-program-control/problematic";
import { pesanGalat } from "@/lib/claim-workflow-ui";
import { rupiah } from "@/lib/promo-ui";
import { sebabHttp } from "@/lib/tampil";
import {
    BATAS_DAFTAR, JENIS_TANGGAL, OPSI_TAHAP, SARINGAN_KOSONG, infoTahap, jumlahItem, jumlahSaringan, opsiPrincipal, periodeBatch, saringBatch, totalBatch,
    type AuditOpc, type BatchOpc, type ItemOpc, type JenisTanggal, type PembayaranOpc, type RefundOpc, type RingkasanBayar, type RingkasanRefund,
    type Saringan, type TahapKey, type Tampilan,
} from "@/lib/opc-ui";
// ObjectPageBatch hanya mengimpor TIPE dari berkas ini (terhapus saat kompilasi), jadi tidak ada impor melingkar saat runtime.
import { ObjectPageBatch } from "./ObjectPageBatch";

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
    /** URL tujuan bukaBatch (tautan nyata baris batch: bisa dibuka di tab baru, audit No 136). */
    hrefBatch: (id: string) => string;
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
    /** Hasil tulis tidak pasti: strip peringatan bertahan di Object Page + muat ulang daftar dan detail (pola Keuangan). */
    laporTidakPasti: (pesan: string) => void;
    /** Pesan hasil tidak pasti yang sedang tampil (dirender ObjectPageBatch) dan penutupnya. */
    tidakPasti?: string | null;
    tutupTidakPasti?: () => void;
};

/** Badan respons → objek JSON; kosong = {}; bukan JSON (mis. halaman HTML proxy) = null, supaya tidak pernah tampil mentah. */
async function bacaJson(res: Response): Promise<Record<string, unknown> | null> {
    const text = await res.text();
    if (!text) return {};
    try {
        const j: unknown = JSON.parse(text);
        return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** GET endpoint OPC → Load. Gagal bila HTTP bukan 2xx ATAU `ok` bukan true (sama dengan cek kode lama); sebab tanpa kode HTTP mentah. */
export async function ambilOpc<T>(url: string, pick: (json: Record<string, unknown>) => T, umum = "Data belum berhasil dimuat."): Promise<Load<T>> {
    try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        const data = await bacaJson(res);
        if (res.status === 403) return { status: "galat", error: `${umum} Akun Anda belum punya izin untuk data ini; minta admin menambahkannya ke grup akses.` };
        if (!res.ok || !data?.ok) {
            const dariServer = data ? String(data.error || data.message || "") : "";
            return { status: "galat", error: dariServer ? pesanGalat(umum, dariServer) : `${umum} ${sebabHttp(res.status)}` };
        }
        return { status: "siap", data: pick(data) };
    } catch {
        return { status: "galat", error: `${umum} ${sebabHttp(0)}` };
    }
}

/** Satu redaksi untuk jawaban server yang tidak pasti: `apa` = yang mungkin sudah tersimpan, `periksa` = tempat memastikannya. */
export const pesanTidakPasti = (apa = "aksi ini", periksa = "Riwayat batch") =>
    `Server tidak memberi jawaban yang pasti, jadi ${apa} mungkin sudah tersimpan atau belum. Periksa ${periksa} sebelum mencoba lagi.`;
export const PESAN_TIDAK_PASTI = pesanTidakPasti();
/** Dilempar tulisOpc bila hasil tulis TIDAK PASTI (koneksi putus, status ≥ 502, badan bukan JSON). */
export class TulisTidakPasti extends Error {}

/**
 * Satu-satunya helper tulis OPC. Objek → JSON; FormData apa adanya. Respons JSON gagal (4xx/500, `ok` bukan true) → throw Error(pesan
 * server). Jawaban TIDAK PASTI (koneksi putus, status ≥ 502, atau badan bukan JSON seperti halaman HTML "504 Gateway Time-out" dari
 * proxy) → throw TulisTidakPasti(`putus` atau PESAN_TIDAK_PASTI), tidak pernah teks/HTML mentah.
 */
export async function tulisOpc(url: string, opsi: { method?: "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> | FormData; gagal?: string; putus?: string } = {}) {
    const isForm = typeof FormData !== "undefined" && opsi.body instanceof FormData;
    const { res, data } = await kirimTulis(() => fetch(url, {
        method: opsi.method ?? "POST",
        credentials: "include",
        headers: opsi.body && !isForm ? { "Content-Type": "application/json" } : undefined,
        body: opsi.body ? (isForm ? (opsi.body as FormData) : JSON.stringify(opsi.body)) : undefined,
    }), opsi.putus);
    if (!res.ok || !data.ok) throw new Error(String(data.error || data.message || opsi.gagal || "Aksi gagal. Coba lagi."));
    return data;
}

/**
 * Jalankan `kirim` lalu klasifikasikan jawabannya: koneksi putus, status ≥ 502, atau badan bukan JSON → TulisTidakPasti(putus).
 * Dipakai tulisOpc dan pemanggil yang harus memakai fetch sendiri (header/badan lain, atau butuh `code` dari jawaban gagal).
 */
export async function kirimTulis(kirim: () => Promise<Response>, putus: string = PESAN_TIDAK_PASTI): Promise<{ res: Response; data: Record<string, unknown> }> {
    let res: Response;
    let text: string;
    try {
        res = await kirim();
        text = await res.text();
    } catch {
        throw new TulisTidakPasti(putus);
    }
    let data: Record<string, unknown> | null;
    try {
        const j: unknown = text ? JSON.parse(text) : {};
        data = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
        data = null;
    }
    if (res.status >= 502 || data === null) throw new TulisTidakPasti(putus);
    return { res, data };
}

/**
 * `.catch` untuk tulisOpc di onConfirm. Hasil TIDAK PASTI: dialog ditutup (`tutup`) supaya tidak bisa diklik ulang selagi status
 * belum jelas, lalu dilaporkan (strip bertahan + muat ulang). Galat tetap dilempar: alur sukses berhenti; galat biasa (4xx/500) tampil
 * di dialog yang masih terbuka.
 */
export const tanganiTulis = (lapor?: (pesan: string) => void, tutup?: () => void) => (e: unknown): never => {
    if (e instanceof TulisTidakPasti) { tutup?.(); lapor?.(e.message); }
    throw e;
};

const INTERVAL_MS = 45_000;

/**
 * Satu daftar untuk seluruh halaman (antrean, lonceng, pencarian): GET /batches = 200 batch terbaru (BL-13), polling 45 dtk +
 * fokus/visibilitas tab seperti tab lama. SPV hanya batch buatannya (lapis kedua; server sudah memfilter, kode lama).
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

/** Tombol "Buka" batch di tabel/daftar baca sebagai tautan nyata `?batch=` (tab baru bisa); klik biasa lewat ctx.bukaBatch (penjaga draf). No 136. */
export function TautanBatch({ ctx, id, label, children }: { ctx: OpcKonteks; id: string; label: string; children: ReactNode }) {
    return (
        <a className="fi-btn fi-btn--tertiary" href={ctx.hrefBatch(id)} aria-label={label}
            onClick={(e) => { if (!klikBiasa(e)) return; e.preventDefault(); ctx.bukaBatch(id); }}>{children}</a>
    );
}

type Cakupan = "antrean" | "semua";

/** Worklist: kepala (judul + jumlah), pilihan "Menunggu Anda | Semua", enam keadaan, baris ListItem dengan tanda lewat SLA. */
export function Antrean({ ctx, daftar, tampilan, rows, dasar, cakupan, setCakupan, nAntrean, nPantau, adaSaringan, hapusSaringan }: {
    ctx: OpcKonteks; daftar: DaftarOpc; tampilan: Tampilan; rows: BatchOpc[]; dasar: BatchOpc[]; cakupan: Cakupan; setCakupan: (c: Cakupan) => void;
    nAntrean: number; nPantau: number; adaSaringan: boolean; hapusSaringan: () => void;
}) {
    const { load } = daftar;
    const memuatAwal = load.status === "memuat" && !load.data;
    // Hitungan hanya dari daftar yang benar-benar termuat: saat memuat/galat, array kosong bukan "0 batch".
    const n = (x: number) => (load.data ? ` (${x})` : "");
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
                                current={ctx.batchId === b.id} href={ctx.hrefBatch(b.id)} onClick={() => ctx.bukaBatch(b.id)} />
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
                <span>
                    {load.data ? `${rows.length} batch${daftar.batches.length >= BATAS_DAFTAR ? ` · dari ${BATAS_DAFTAR} terbaru` : ""}` : ""}
                    {load.status === "memuat" && load.data ? " · memperbarui…" : ""}
                </span>
            </header>
            {tampilan.pantau && (
                <div className="fi-sect-in" style={{ paddingBottom: 0 }}>
                    <div className="fi-segs" role="group" aria-label="Cakupan antrean">
                        <button type="button" aria-pressed={cakupan === "antrean"} onClick={() => setCakupan("antrean")}>Menunggu Anda{n(nAntrean)}</button>
                        <button type="button" aria-pressed={cakupan === "semua"} onClick={() => setCakupan("semua")}>Semua{n(nPantau)}</button>
                    </div>
                </div>
            )}
            {isi}
        </div>
    );
}

type KerjaProps = PeranProps & {
    tampilan: Tampilan[];
    Detail?: ComponentType<DetailProps>;
    atas?: ReactNode;
    saringanAwal?: Partial<Saringan>;
    /** Isi kolom kedua selain batch (mis. form batch baru SPV / CLM Klaim); `tutup` dipanggil tombol "Kembali ke daftar". */
    kolomKedua?: { isi: ReactNode; tutup: () => void };
};

type PesanSukses = { judul: string; keterangan?: string };

/** Worklist peran di kolom pertama + batch terbuka (`?batch=`) di kolom kedua. Di ponsel satu kolom dengan "Kembali ke daftar". */
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
    const detailOpen = Boolean(kolomKedua || ctx.batchId);
    // < 1024 px (satu kolom): isi di atas daftar disembunyikan saat detail terbuka, detail digulir ke atas layar dan fokus pindah ke
    // judulnya (owner 27 Okt, audit No 111); gulir halus hanya bila pengguna tidak meminta gerak berkurang.
    const atasPonsel = detailOpen ? "max-lg:hidden" : "";
    const panelRef = useRef<HTMLDivElement>(null);
    const kunciDetail = kolomKedua ? "kolom-kedua" : ctx.batchId;
    useEffect(() => {
        if (!kunciDetail || !window.matchMedia("(max-width: 1023px)").matches) return;
        const halus = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        panelRef.current?.scrollIntoView({ block: "start", behavior: halus ? "smooth" : "auto" });
        panelRef.current?.querySelector<HTMLElement>(".fi-fcl-detail .fi-oph-title > :is(h1, h2)")?.focus({ preventScroll: true });
    }, [kunciDetail]);

    return (
        <div style={{ display: "grid", gap: 12 }}>
            {tampilan.length > 1 && (
                <div className={`fi-segs ${atasPonsel}`} role="group" aria-label="Tampilan antrean">
                    {tampilan.map((t) => (
                        <button key={t.kunci} type="button" aria-pressed={t.kunci === aktif.kunci} onClick={() => ctx.pilihSub(t.kunci)}>
                            {t.label}{daftar.load.data ? ` (${semua.filter(t.antrean).length})` : ""}
                        </button>
                    ))}
                </div>
            )}
            {atas && <div className={`contents ${atasPonsel}`}>{atas}</div>}
            {pesan && <MessageStrip tone="pos" title={pesan.judul} onClose={() => setPesan(null)}>{pesan.keterangan}</MessageStrip>}
            {daftar.load.status === "galat" && daftar.load.data && (
                <MessageStrip tone="neg" title="Gagal memuat ulang antrean.">
                    {daftar.load.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={daftar.muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            <div ref={panelRef} className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <div className="fi-fcl-atas">
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
                </div>
                <FlexibleColumnLayout
                    listLabel="Antrean" detailLabel="Batch terbuka"
                    detailOpen={detailOpen} onBack={kolomKedua ? kolomKedua.tutup : () => ctx.bukaBatch(null)}
                    list={<Antrean ctx={ctx} daftar={daftar} tampilan={aktif} rows={rows} dasar={dasar} cakupan={cakupan} setCakupan={setCakupan}
                        nAntrean={dasarAntrean.length} nPantau={dasarPantau.length} adaSaringan={nSaringan > 0} hapusSaringan={hapus} />}
                    detail={kolomKedua ? kolomKedua.isi : ctx.batchId
                        ? <KolomDetail key={ctx.batchId} ctx={ctx} daftar={daftar} batchId={ctx.batchId} ringkas={ringkas} Detail={Detail} setPesan={setPesan} />
                        : <EmptyState title="Belum ada batch terbuka" message="Pilih batch dari antrean. Batch juga bisa dibuka dari lonceng Lewat SLA atau pencarian pengajuan (tekan /)." />}
                />
            </div>
            {/* Satu catatan varian per layar (audit No 80): saat batch terbuka, catatan milik Object Page/peran yang tampil. */}
            {!detailOpen && (
                <VariantNote bl="BL-11, BL-13">
                    Antrean, saringan, dan tanda lewat SLA dihitung di browser dari 200 batch terbaru; batch yang lebih lama tidak terjangkau. Usulan:
                    saring, paginasi, dan hitung SLA di server, lalu dipakai juga oleh Kotak Tugas (BL-34).
                </VariantNote>
            )}
        </div>
    );
}

/** Kolom kedua: memuat detail untuk satu batch (dipasang ulang per batch lewat `key`) lalu merender Detail peran. */
function KolomDetail({ ctx, daftar, batchId, ringkas, Detail, setPesan }: {
    ctx: OpcKonteks; daftar: DaftarOpc; batchId: string; ringkas?: BatchOpc; Detail: ComponentType<DetailProps>; setPesan: (p: PesanSukses | null) => void;
}) {
    const [detail, muatUlang] = useDetailBatch(batchId, ringkas);
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);
    const selesai = (judul: string, keterangan: string | null = "Batch pindah ke antrean tahap berikutnya.") => {
        setPesan({ judul, keterangan: keterangan ?? undefined }); daftar.muatUlang(); muatUlang();
    };
    const laporTidakPasti = (pesan: string) => { setTidakPasti(pesan); daftar.muatUlang(); muatUlang(); };
    return <Detail ctx={ctx} daftar={daftar} batchId={batchId} ringkas={ringkas} detail={detail} muatUlang={muatUlang} selesai={selesai}
        masalah={daftar.masalahPer.get(batchId) ?? []} laporTidakPasti={laporTidakPasti} tidakPasti={tidakPasti} tutupTidakPasti={() => setTidakPasti(null)} />;
}

/** Object Page tanpa aksi (bawaan; modul peran menggantinya lewat prop `Detail`). */
function DetailBacaSaja(props: DetailProps) {
    return <ObjectPageBatch {...props} />;
}
