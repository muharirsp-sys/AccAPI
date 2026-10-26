/*
 * Tujuan: Object Page satu wave (Fiori S2): status + alur, exception (Selesai / Abaikan… beralasan, BL-24), grup cetak dan kertas, isi wave dengan Lepas beralasan,
 *   pool dengan cari/saring (draf), riwayat, footer toolbar dengan dialog Rilis / Konfirmasi / Batalkan. Simpan isi per karton dan Selesai (exception)
 *   menulis master konversi / menutup exception, jadi keduanya lewat dialog ringkas (lama → baru); isian tetap inline di baris.
 * Caller: app/(dashboard)/rekapan-nota/wave/[id]/page.tsx.
 * Dependensi: GET|PATCH /api/rekapan-nota/wave/[id], POST|PATCH /api/rekapan-nota/wave/[id]/nota, PATCH /api/rekapan-nota/wave/[id]/exception,
 *   GET /api/rekapan-nota/pool;
 *   components/fiori/{core,interactive}, lib/rekapan-nota/ui, lib/tampil (KOSONG, sebabHttp, waktuWita).
 * Main Functions: WaveDetail.
 * Side Effects: HTTP baca/tulis di atas. BL-24/25 dijaga server (409 tampil di layar dan detail dimuat ulang); BL-56/57 masih varian berlabel.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Clock, ExternalLink, Lock, Printer, Send } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, Flow, FooterToolbar, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section, Skeleton,
    StatusBadge, VariantNote, type Column, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import {
    EXCEPTION_LABEL, WAVE_STATUS, ambil, formatKarton, labelEvent, menahanKonfirmasi, saringPool, tanggalPendek, usulIsiDariNama,
    type PoolFilter, type WaveStatusKode,
} from "@/lib/rekapan-nota/ui";
import { KOSONG, sebabHttp, waktuWita } from "@/lib/tampil";

type Wave = { id: number; tanggal: string; urutan: number; nama: string; tipe: string; status: WaveStatusKode };
type NotaWave = {
    no_nota: string; prioritas: string; snap_area: string | null; snap_pareto: boolean | null; snap_total_krt: number | null;
    dilepas: boolean; dilepas_alasan: string | null; dilepas_at: string | null; dilepas_oleh: string | null;
    customer: string | null; salesman: string | null; jumlah_baris: number; total_pcs: number;
};
type NotaPool = { no_nota: string; kode_cust: string; customer: string | null; salesman: string | null; area: string | null; jumlah_baris: number; total_krt: number | null; pareto: boolean | null };
type Exception = {
    id: number; jenis: string; ref_tipe: string; ref_kode: string; keterangan: string | null; status: string;
    master_saat_ini?: string | null; resolved_at?: string | null; resolved_oleh?: string | null; alasan?: string | null;
    nama_ref?: string | null;
};
type PickGroup = { id: number; kode: string; nama: string; dimensi: string };
type Riwayat = { event: string; created_at: string; payload: Record<string, unknown>; aktor: string };
type Detail = { wave: Wave; nota: NotaWave[]; exception: Exception[]; pickGroup: PickGroup[]; pickGroupTersedia: PickGroup[]; riwayat?: Riwayat[] };
type Pool = { nota: NotaPool[]; disembunyikan?: number; kanvasNihilOleh?: string | null };
type Dialog = "rilis" | "konfirmasi" | "batal" | "takeout" | "abaikan" | "isi" | "selesai" | null;
type SaringIsi = "semua" | "urgent" | "pareto" | "dilepas";

const TIPE_LABEL: Record<string, string> = { reguler: "Reguler", kanvas: "Kanvas" };
/** Jenis rujukan exception dari server dalam bahasa tugas; kode di luar daftar tidak ditampilkan mentah. */
const REF_TIPE: Record<string, string> = { item: "Barang", customer: "Outlet", principal: "Principal" };
const rujukan = (e: Pick<Exception, "ref_tipe" | "ref_kode">) => `${REF_TIPE[e.ref_tipe] ?? "Rujukan"} ${e.ref_kode}`;
const jenisLabel = (jenis: string | undefined) => EXCEPTION_LABEL[jenis ?? ""] ?? "Jenis tidak dikenal";
const sama = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Nilai master SAAT INI sebagai petunjuk (BL-24): isi per karton untuk barang, area untuk outlet. */
function petunjukMaster(e: Exception): string {
    if (e.ref_tipe === "item" && e.jenis.startsWith("KONVERSI")) return e.master_saat_ini ? `Master saat ini ${e.master_saat_ini} per karton` : "Master saat ini belum diisi";
    if (e.ref_tipe === "customer") return e.master_saat_ini ? `Area master saat ini ${e.master_saat_ini}` : "Area master saat ini belum diisi";
    return "";
}
const penutupan = (e: Exception) =>
    [`${e.status === "selesai" ? "Selesai" : "Diabaikan"}${e.resolved_at ? ` ${waktuWita(e.resolved_at)}` : ""}`, e.resolved_oleh, e.alasan].filter(Boolean).join(" · ");

async function kirimJson(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    return { ok: res.ok, status: res.status, payload };
}

export default function WaveDetail({ id, permKeys }: { id: string; permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehKelola = keys.has("rekapan_nota.manage");
    const bolehLepas = keys.has("rekapan_nota.approve_takeout");
    const bolehCetak = keys.has("rekapan_nota.print");

    const [detail, muatDetail] = useLoad(useCallback(() => ambil<Detail>(`/api/rekapan-nota/wave/${id}`), [id]));
    const poolKunci = detail.data?.wave.status === "draft" ? `${detail.data.wave.tanggal}|${detail.data.wave.tipe}` : "";
    const [pool, muatPool] = useLoad(useCallback((): Promise<Load<Pool>> => {
        if (!poolKunci) return Promise.resolve({ status: "siap", data: { nota: [] } });
        const [tanggal, tipe] = poolKunci.split("|");
        return ambil<Pool>(`/api/rekapan-nota/pool?tanggal=${tanggal}&tipe=${tipe}`);
    }, [poolKunci]));
    const muat = () => { muatDetail(); muatPool(); };
    // Grup cetak: null = mengikuti server; Set = suntingan pengguna yang belum disimpan.
    const [grupEdit, setGrupEdit] = useState<Set<number> | null>(null);
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [saring, setSaring] = useState<PoolFilter>({ cari: "", salesman: "", area: "", pareto: false });
    const [cariIsi, setCariIsi] = useState("");
    const [saringIsi, setSaringIsi] = useState<SaringIsi>("semua");
    const [dialog, setDialog] = useState<Dialog>(null);
    const [notaLepas, setNotaLepas] = useState<NotaWave | null>(null);
    const [excAbaikan, setExcAbaikan] = useState<Exception | null>(null);
    // Target dialog Simpan isi (exception + isi per karton) dan Selesai (exception).
    const [isiSimpan, setIsiSimpan] = useState<{ e: Exception; n: number } | null>(null);
    const [excSelesai, setExcSelesai] = useState<Exception | null>(null);
    const [excSibuk, setExcSibuk] = useState<number | null>(null);
    const [isiKetik, setIsiKetik] = useState<Record<number, string>>({});
    const [pesan, setPesan] = useState<string | null>(null);
    const [galat, setGalat] = useState<string | null>(null);
    const [sibuk, setSibuk] = useState<"tambah" | "urgent" | "grup" | null>(null);


    const data = detail.data;
    const wave = data?.wave;
    const draft = wave?.status === "draft";
    const terkunci = wave?.status === "confirmed" || wave?.status === "cancelled";
    const aktif = useMemo(() => data?.nota.filter((n) => !n.dilepas) ?? [], [data]);
    const dilepas = data?.nota.filter((n) => n.dilepas) ?? [];
    const exceptionOpen = data?.exception.filter((e) => e.status === "open") ?? [];
    const menahan = data?.exception.filter((e) => menahanKonfirmasi(e.jenis, e.status)) ?? [];
    const grupAwal = useMemo(() => new Set(data?.pickGroup.map((g) => g.id) ?? []), [data]);
    const grupPilih = grupEdit ?? grupAwal;
    const grupBerubah = Boolean(data) && !sama(grupPilih, grupAwal);
    useUnsavedGuard(grupBerubah);

    const poolRows = useMemo(() => pool.data?.nota ?? [], [pool]);
    const poolTersaring = useMemo(() => saringPool(poolRows, saring), [poolRows, saring]);
    const salesmanList = useMemo(() => [...new Set(poolRows.map((r) => r.salesman).filter((s): s is string => Boolean(s)))].sort(), [poolRows]);
    const areaList = useMemo(() => [...new Set(poolRows.map((r) => r.area).filter((a): a is string => Boolean(a)))].sort(), [poolRows]);
    const dipilihRows = poolRows.filter((r) => pilih.has(r.no_nota)); // pilihan lama yang sudah hilang dari pool tidak ikut
    const kartonDipilih = dipilihRows.reduce((a, r) => a + (r.total_krt ?? 0), 0);
    const saringAktif = Number(Boolean(saring.salesman)) + Number(Boolean(saring.area)) + Number(saring.pareto);

    const isiTersaring = useMemo(() => {
        const q = cariIsi.trim().toLowerCase();
        return (data?.nota ?? []).filter((n) =>
            (saringIsi === "semua" ? !n.dilepas : saringIsi === "dilepas" ? n.dilepas : saringIsi === "urgent" ? !n.dilepas && n.prioritas === "urgent" : !n.dilepas && n.snap_pareto === true)
            && (!q || n.no_nota.toLowerCase().includes(q) || (n.customer ?? "").toLowerCase().includes(q)));
    }, [data, cariIsi, saringIsi]);

    async function tambahNota(prioritas: "normal" | "urgent") {
        const noNota = dipilihRows.map((r) => r.no_nota);
        if (!noNota.length) return;
        setSibuk(prioritas === "urgent" ? "urgent" : "tambah"); setGalat(null); setPesan(null);
        try {
            const r = await kirimJson(`/api/rekapan-nota/wave/${id}/nota`, "POST", { noNota, prioritas });
            const ditolak = (r.payload.ditolak as string[] | undefined) ?? [];
            const pemilik = (r.payload.pemilik as Array<{ no_nota: string; nama: string; tanggal: string }> | undefined) ?? [];
            if (!r.ok && !ditolak.length) { setGalat(r.payload.error ?? "Nota tidak bisa ditambahkan."); return; }
            const masuk = (r.payload.masuk as string[] | undefined) ?? [];
            if (ditolak.length) {
                // Jawaban "kenapa nota ini tidak ada di rekapan sore?" — langsung di layar.
                setGalat(`${ditolak.length} nota ditolak: ${pemilik.map((p) => `${p.no_nota} sudah di Wave ${p.nama} (${tanggalPendek(p.tanggal)})`).join("; ") || ditolak.join(", ")}.`);
            }
            if (masuk.length) setPesan(`${masuk.length} nota ditambahkan${prioritas === "urgent" ? " sebagai urgent" : ""}.`);
            setPilih(new Set(ditolak)); // yang ditolak tetap terpilih supaya terlihat; yang masuk hilang dari pool
            muat();
        } finally {
            setSibuk(null);
        }
    }

    async function simpanGrup() {
        setSibuk("grup"); setGalat(null); setPesan(null);
        try {
            const r = await kirimJson(`/api/rekapan-nota/wave/${id}`, "PATCH", { aksi: "set_grup", pickGroupIds: [...grupPilih] });
            if (!r.ok) { setGalat(r.payload.error ?? "Grup cetak tidak tersimpan."); muat(); return; }
            setPesan("Grup cetak tersimpan.");
            setGrupEdit(null); muat();
        } finally {
            setSibuk(null);
        }
    }

    /** Transisi lewat dialog: galat dilempar supaya tampil di dialog (isian tidak hilang). */
    async function transisi(aksi: "release" | "confirm" | "cancel", alasan?: string) {
        const r = await kirimJson(`/api/rekapan-nota/wave/${id}`, "PATCH", { aksi, alasan: alasan || undefined });
        if (!r.ok) { muat(); throw new Error(r.payload.error ?? sebabHttp(r.status)); }
        setDialog(null); setGalat(null);
        setPesan(aksi === "release" ? `Wave ${wave?.nama} dirilis. Nota tidak bisa ditambah lagi; keluarkan lewat Lepas dengan alasan.`
            : aksi === "confirm" ? `Wave ${wave?.nama} dikonfirmasi. Isi dan grup cetak terkunci; kertas tetap bisa dicetak ulang.`
            : `Wave ${wave?.nama} dibatalkan; ${Number(r.payload.notaKembali ?? 0)} nota kembali ke pool.`);
        muat();
    }

    /** BL-24: Selesai langsung; Abaikan lewat dialog beralasan (galat dilempar ke dialog). 409 = sudah ditutup di layar lain. */
    async function tutupException(e: Exception, aksi: "selesai" | "abaikan", alasan?: string) {
        const r = await kirimJson(`/api/rekapan-nota/wave/${id}/exception`, "PATCH", { exceptionId: e.id, aksi, alasan });
        if (!r.ok) { muat(); throw new Error(r.payload.error ?? sebabHttp(r.status)); }
        setGalat(null);
        setPesan(`${EXCEPTION_LABEL[e.jenis] ?? e.jenis} ${e.ref_kode} ${aksi === "selesai" ? "ditandai selesai" : "diabaikan"}.`);
        muat();
    }
    /** Dipanggil dari dialog Simpan isi: galat dilempar supaya tampil di dialog (isian tidak hilang). */
    async function simpanIsi(e: Exception, isi: number) {
        setExcSibuk(e.id); setPesan(null); setGalat(null);
        try {
            const r = await kirimJson(`/api/rekapan-nota/wave/${id}/exception`, "PATCH", { exceptionId: e.id, aksi: "isi", isi });
            if (!r.ok) { muat(); throw new Error(r.payload.error ?? sebabHttp(r.status)); }
            setPesan(`Isi per karton ${e.ref_kode} disimpan: ${isi}. Cetak ulang lembar untuk melihat kartonnya.`);
            muat();
        } finally {
            setExcSibuk(null);
        }
    }

    async function lepas(alasan: string) {
        if (!notaLepas) return;
        const r = await kirimJson(`/api/rekapan-nota/wave/${id}/nota`, "PATCH", { aksi: "takeout", noNota: notaLepas.no_nota, alasan });
        if (!r.ok) { muat(); throw new Error(r.payload.error ?? sebabHttp(r.status)); }
        setDialog(null); setNotaLepas(null); setGalat(null);
        setPesan(`${notaLepas.no_nota} dilepas dan kembali ke pool.`);
        muat();
    }

    if (detail.status === "memuat" && !data) {
        return (
            <div className="fi-page">
                <ObjectPageHeader breadcrumbs={[{ label: "Rekapan Nota", href: "/rekapan-nota" }, { label: "Wave" }]} title="Memuat wave…" />
                <div className="fi-panel"><Skeleton rows={7} label="Memuat wave" /></div>
            </div>
        );
    }
    if (!data || !wave) {
        return (
            <div className="fi-page">
                <ObjectPageHeader breadcrumbs={[{ label: "Rekapan Nota", href: "/rekapan-nota" }, { label: "Wave" }]} title="Wave" />
                <div className="fi-panel"><ErrorState message={detail.error} onRetry={muat} /></div>
            </div>
        );
    }

    const st = WAVE_STATUS[wave.status];
    const flow: FlowStep[] = wave.status === "cancelled"
        ? [{ label: "Draf", state: "done" }, { label: "Dibatalkan", state: "stop" }, { label: "Dikonfirmasi", state: "todo" }]
        : [
            { label: "Draf", state: wave.status === "draft" ? "current" : "done" },
            { label: "Rilis", state: wave.status === "released" ? "current" : wave.status === "confirmed" ? "done" : "todo" },
            { label: "Dikonfirmasi", state: wave.status === "confirmed" ? "done" : "todo" },
        ];
    const dimensi = [...new Set(data.pickGroupTersedia.map((g) => g.dimensi))];
    const kodeLembar = data.pickGroupTersedia.filter((g) => grupPilih.has(g.id)).map((g) => g.kode).join("+") || "semua nota";
    const cetakUrl = `/rekapan-nota/wave/${id}/cetak?grup=${[...grupPilih].join(",")}`;
    const anchors = [
        ...(data.exception.length ? [{ id: "exception", label: "Exception" }] : []),
        { id: "cetak", label: "Grup cetak dan kertas" }, { id: "isi", label: "Isi wave" },
        ...(draft ? [{ id: "pool", label: "Pool" }] : []), { id: "riwayat", label: "Riwayat" },
    ];

    const bolehTutup = bolehKelola && wave.status !== "cancelled";
    const badgeStatus = (e: Exception) => e.status === "open" ? <StatusBadge tone="neg">Terbuka</StatusBadge> : e.status === "selesai" ? <StatusBadge tone="pos">Selesai</StatusBadge> : <StatusBadge tone="neu">Diabaikan</StatusBadge>;
    const aksiException = (e: Exception) => bolehTutup && e.status === "open" ? (
        <span className="fi-btnrow">
            {/* Isi per karton langsung di baris exception (owner 24 Okt 2026), usulan dari nama barang. */}
            {e.jenis === "KONVERSI_TIDAK_ADA" && (() => {
                const usul = usulIsiDariNama(e.nama_ref);
                const teks = isiKetik[e.id] ?? (usul ? String(usul) : "");
                const n = Number(teks);
                const sah = Number.isInteger(n) && n >= 1 && n <= 10000;
                return <>
                    <input className="fi-input" style={{ width: "6.5rem" }} type="number" min={1} max={10000} inputMode="numeric"
                        aria-label={`Isi per karton ${e.ref_kode}`} placeholder="Isi/karton" value={teks}
                        onChange={(ev) => setIsiKetik((s) => ({ ...s, [e.id]: ev.target.value }))} />
                    <Button variant="primary" busy={excSibuk === e.id} disabled={!sah} disabledReason="Isi bilangan bulat 1-10000"
                        onClick={() => { setIsiSimpan({ e, n }); setDialog("isi"); }} aria-label={`Simpan isi per karton ${e.ref_kode}`}>Simpan isi</Button>
                </>;
            })()}
            <Button busy={excSibuk === e.id} onClick={() => { setExcSelesai(e); setDialog("selesai"); }} aria-label={`Selesai ${e.ref_kode}`}>Selesai</Button>
            <Button variant="tertiary" disabled={excSibuk === e.id} onClick={() => { setExcAbaikan(e); setDialog("abaikan"); }} aria-label={`Abaikan ${e.ref_kode}`}>Abaikan…</Button>
        </span>
    ) : null;
    const kolomException: Column<Exception>[] = [
        { key: "jenis", header: "Jenis", cell: (e) => <b title={e.jenis}>{jenisLabel(e.jenis)}</b> },
        { key: "ref", header: "Referensi", cell: (e) => <span className="fi-mono">{rujukan(e)}</span> },
        { key: "ket", header: "Keterangan", secondary: true, cell: (e) => <span className="fi-small">{e.keterangan}{petunjukMaster(e) && <span className="fi-sub">{petunjukMaster(e)}</span>}</span> },
        { key: "konf", header: "Konfirmasi", cell: (e) => menahanKonfirmasi(e.jenis, e.status) ? <StatusBadge tone="warn"><Lock className="fi-icon" aria-hidden />Menahan</StatusBadge> : <span className="fi-small fi-subtle">Informasi</span> },
        { key: "status", header: "Status", cell: (e) => <>{badgeStatus(e)}{e.status !== "open" && <span className="fi-sub">{penutupan(e)}</span>}</> },
        ...(bolehTutup && exceptionOpen.length ? [{ key: "aksi", header: "Tindakan", cell: aksiException }] : []),
    ];
    const kolomIsi: Column<NotaWave>[] = [
        { key: "nota", header: "Nota", cell: (n) => <span className="fi-mono">{n.no_nota}</span> },
        { key: "outlet", header: "Outlet", cell: (n) => <>{n.customer ?? KOSONG}{n.dilepas && <span className="fi-sub">Dilepas {n.dilepas_at ? waktuWita(n.dilepas_at) : ""}{n.dilepas_oleh ? ` · ${n.dilepas_oleh}` : ""} · {n.dilepas_alasan}</span>}</> },
        { key: "area", header: "Area", secondary: true, cell: (n) => n.snap_area ?? <span className="fi-why">belum ada</span> },
        { key: "krt", header: "Karton", align: "end", cell: (n) => <span className="fi-tnum">{formatKarton(n.snap_total_krt)}</span> },
        { key: "pareto", header: "Pareto", secondary: true, cell: (n) => n.snap_pareto === null ? KOSONG : n.snap_pareto ? "Ya" : "Tidak" },
        { key: "prio", header: "Prioritas", cell: (n) => n.prioritas === "urgent" ? <StatusBadge tone="warn"><Clock className="fi-icon" aria-hidden />Urgent</StatusBadge> : "Normal" },
        { key: "aksi", header: bolehLepas && !terkunci ? "Tindakan" : "", cell: (n) => bolehLepas && !terkunci && !n.dilepas ? <Button variant="tertiary" onClick={() => { setNotaLepas(n); setDialog("takeout"); }}>Lepas…</Button> : null },
    ];
    const kolomPool: Column<NotaPool>[] = [
        { key: "nota", header: "Nota", cell: (p) => <span className="fi-mono">{p.no_nota}</span> },
        { key: "outlet", header: "Outlet", cell: (p) => p.customer ?? KOSONG },
        { key: "sales", header: "Salesman", secondary: true, cell: (p) => p.salesman ?? KOSONG },
        { key: "area", header: "Area", cell: (p) => p.area ?? <span className="fi-why">belum ada</span> },
        { key: "krt", header: "Karton", align: "end", cell: (p) => <span className="fi-tnum">{formatKarton(p.total_krt)}{p.pareto && <span className="fi-sub">pareto</span>}</span> },
        { key: "baris", header: "Baris", align: "end", secondary: true, cell: (p) => <span className="fi-tnum">{p.jumlah_baris}</span> },
    ];
    const togglePilih = (no: string) => setPilih((s) => { const n = new Set(s); if (n.has(no)) n.delete(no); else n.add(no); return n; });

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <ObjectPageHeader
                breadcrumbs={[{ label: "Rekapan Nota", href: "/rekapan-nota" }, { label: tanggalPendek(wave.tanggal), href: `/rekapan-nota` }, { label: `Wave ${wave.nama}` }]}
                title={`Wave ${wave.nama}`} status={<StatusBadge tone={st.tone}>{st.label}</StatusBadge>} draft={grupBerubah}
                actions={draft && bolehKelola ? <Button icon={<Send className="fi-icon" aria-hidden />} disabled={aktif.length === 0} disabledReason="Tambahkan nota dulu" onClick={() => setDialog("rilis")}>Rilis wave…</Button> : undefined}
                attributes={[
                    { label: "Tanggal", value: tanggalPendek(wave.tanggal) }, { label: "Urutan", value: `${wave.urutan} · ${TIPE_LABEL[wave.tipe] ?? wave.tipe}` },
                    { label: "Nota aktif", value: <span className="fi-tnum">{aktif.length}</span> }, { label: "Wave", value: <span className="fi-mono">#{wave.id}</span> },
                ]}
                flow={<Flow steps={flow} label="Status wave" />} />
            <AnchorBar anchors={anchors} />

            {galat && <MessageStrip tone="neg" title={galat} onClose={() => setGalat(null)}><Button variant="tertiary" onClick={muat}>Muat ulang</Button></MessageStrip>}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {detail.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang.">{detail.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}
            {draft && aktif.length === 0 && <MessageStrip tone="info" title="Wave ini belum berisi nota.">Pilih nota dari pool di bawah. Setelah dirilis, nota hanya bisa dikeluarkan lewat Lepas dengan alasan.</MessageStrip>}

            {data.exception.length > 0 && (
                <Section id="exception" title={exceptionOpen.length ? "Exception terbuka" : "Exception"}
                    subtitle={exceptionOpen.length ? `${exceptionOpen.length} terbuka · ${menahan.length} menahan konfirmasi` : `${data.exception.length} ditutup · tidak ada yang menahan konfirmasi`}>
                    <ResponsiveTable<Exception> title="Exception" columns={kolomException} rows={data.exception} rowKey={(e) => String(e.id)}
                        empty={{ title: "Tidak ada exception" }}
                        mobileItem={(e) => <ListItem doc={rujukan(e)} title={jenisLabel(e.jenis)}
                            meta={<>{e.status === "open" ? [e.keterangan, petunjukMaster(e)].filter(Boolean).join(" · ") : penutupan(e)}{aksiException(e)}</>}
                            badge={menahanKonfirmasi(e.jenis, e.status) ? <StatusBadge tone="warn">Menahan</StatusBadge> : badgeStatus(e)} />} />
                    {exceptionOpen.length > 0 && bolehTutup && (
                        <div className="fi-sect-in"><p className="fi-small fi-subtle">Selesai = sudah diperbaiki · Abaikan = diterima dengan alasan. Konfirmasi hanya ditahan exception isi per karton.</p></div>
                    )}
                </Section>
            )}

            <Section id="cetak" title="Grup cetak dan kertas" subtitle={terkunci ? "grup terkunci; kertas tetap bisa dicetak ulang" : "kertas dibuka di tab baru"}>
                <div className="fi-sect-in">
                    <div className="fi-chipgrid">
                        {dimensi.map((d) => (
                            <div key={d}>
                                <span>{d}</span>
                                <ul className="fi-chips" aria-label={`Grup ${d}`}>
                                    {data.pickGroupTersedia.filter((g) => g.dimensi === d).map((g) => (
                                        <li key={g.id}>
                                            <label className="fi-chip">
                                                <input type="checkbox" checked={grupPilih.has(g.id)} disabled={terkunci || !bolehKelola}
                                                    onChange={() => setGrupEdit(() => { const n = new Set(grupPilih); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} />
                                                {g.nama}
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                    {/* Cetak semua (owner 24 Okt 2026): unggah > pilih nota > rilis > cetak semua. Aktif sesudah Rilis supaya
                        kertas yang beredar selalu versi final; cetak per grup di bawah tetap ada untuk keperluan khusus. */}
                    {bolehCetak && (
                        <div className="fi-btnrow">
                            {draft
                                ? <Button variant="primary" disabled disabledReason="Rilis wave dulu"><Printer className="fi-icon" aria-hidden />Cetak semua</Button>
                                : <Link className="fi-btn fi-btn--primary" href={`/rekapan-nota/wave/${id}/cetak-semua`} target="_blank"><Printer className="fi-icon" aria-hidden />Cetak semua<ExternalLink className="fi-icon" aria-hidden /></Link>}
                            <span className="fi-small fi-subtle">Cetak semua = rekapan dan TTF. Satu lembar per divisi · Heinz per area (HNZ1–6) dan tanpa area (HNZ-ALL) · key account & MT GDI lembar sendiri · TTF di akhir</span>
                        </div>
                    )}
                    <p className="fi-small fi-subtle">Kode lembar <span className="fi-mono">{kodeLembar}</span> · dimensi berbeda digabung DAN, sedimensi ATAU · tanpa pilihan = semua nota di wave.</p>
                    <div className="fi-btnrow">
                        {bolehKelola && !terkunci && <Button busy={sibuk === "grup"} disabled={!grupBerubah} disabledReason="Belum ada perubahan" onClick={simpanGrup}>Simpan grup</Button>}
                        {bolehCetak && <Link className="fi-btn fi-btn--secondary" href={cetakUrl} target="_blank"><Printer className="fi-icon" aria-hidden />Lembar rekapan<ExternalLink className="fi-icon" aria-hidden /></Link>}
                        {bolehCetak && <Link className="fi-btn fi-btn--secondary" href={`/rekapan-nota/wave/${id}/ttf`} target="_blank"><Printer className="fi-icon" aria-hidden />TTF<ExternalLink className="fi-icon" aria-hidden /></Link>}
                    </div>
                    {!draft && <VariantNote bl="BL-56">Kertas belum mencatat cetak ke-berapa, jam, dan pencetaknya; tanda “Cetak ulang” dihitung dari tanggal. Usulan: kop “Cetak ke-n · jam · oleh”, TTF menulis status wave, cetak tercatat di Riwayat.</VariantNote>}
                </div>
            </Section>

            <Section id="isi" title="Isi wave" subtitle={`${aktif.length} nota aktif${dilepas.length ? ` · ${dilepas.length} dilepas` : ""}${terkunci ? " · terkunci" : ""}`}>
                <div className="fi-sect-in">
                    <div className="fi-page-bar">
                        <input className="fi-input" type="search" aria-label="Cari nota atau outlet di wave" placeholder="Cari nota atau outlet" value={cariIsi} onChange={(e) => setCariIsi(e.target.value)} />
                        <div className="fi-segs" role="group" aria-label="Saring isi wave">
                            {([["semua", `Semua ${aktif.length}`], ["urgent", `Urgent ${aktif.filter((n) => n.prioritas === "urgent").length}`], ["pareto", `Pareto ${aktif.filter((n) => n.snap_pareto).length}`], ["dilepas", `Dilepas ${dilepas.length}`]] as const)
                                .map(([k, label]) => <button key={k} type="button" aria-pressed={saringIsi === k} onClick={() => setSaringIsi(k)}>{label}</button>)}
                        </div>
                    </div>
                </div>
                <ResponsiveTable<NotaWave> title="Isi wave" columns={kolomIsi} rows={isiTersaring} rowKey={(n) => n.no_nota}
                    empty={data.nota.length === 0 ? { title: "Belum ada nota di wave ini", message: draft ? "Pilih nota dari pool di bawah." : undefined } : { title: "Tidak ada nota yang sesuai saringan", message: "Ubah kata kunci atau saringan." }}
                    mobileItem={(n) => <ListItem doc={<span className={n.dilepas ? "fi-subtle" : undefined}>{n.no_nota}</span>} amount={`${formatKarton(n.snap_total_krt)} krt`}
                        title={`${n.customer ?? KOSONG} · area ${n.snap_area ?? "belum ada"}${n.snap_pareto ? " · pareto" : ""}`}
                        meta={n.dilepas ? `Dilepas ${n.dilepas_at ? waktuWita(n.dilepas_at) : ""}${n.dilepas_oleh ? ` · ${n.dilepas_oleh}` : ""} · ${n.dilepas_alasan}` : bolehLepas && !terkunci ? <Button variant="tertiary" onClick={() => { setNotaLepas(n); setDialog("takeout"); }}>Lepas…</Button> : undefined}
                        badge={n.prioritas === "urgent" ? <StatusBadge tone="warn">Urgent</StatusBadge> : undefined} />} />
                {!draft && !terkunci && <div className="fi-sect-in"><p className="fi-small fi-subtle">Area dan pareto diambil saat nota masuk wave; perubahan master sesudahnya tidak mengubah rekapan ini.</p></div>}
            </Section>

            {draft && (
                <Section id="pool" title={`Pool nota ${TIPE_LABEL[wave.tipe]?.toLowerCase() ?? wave.tipe} ${tanggalPendek(wave.tanggal)}`}
                    subtitle={pool.data ? `${poolRows.length} nota belum masuk wave · ${wave.tipe === "kanvas" ? "hanya nota bertanda kanvas" : "nota bertanda kanvas masuk wave kanvas"}` : undefined}>
                    <div className="fi-sect-in">
                        {pool.data && wave.tipe === "reguler" && (
                            <p className="fi-small fi-subtle">
                                {pool.data.kanvasNihilOleh ? `Kanvas hari ini dinyatakan tidak ada oleh ${pool.data.kanvasNihilOleh}.`
                                    : pool.data.disembunyikan ? <>{pool.data.disembunyikan} nota bertanda kanvas tidak ikut pool ini. <Link href="/rekapan-nota/kanvas">Periksa penandaannya</Link>.</>
                                    : <>Kanvas hari ini <b>belum diperiksa</b>. <Link href="/rekapan-nota/kanvas">Periksa sekarang</Link>.</>}
                            </p>
                        )}
                        <FilterBar title="Saring pool" activeCount={saringAktif} onReset={() => setSaring({ cari: "", salesman: "", area: "", pareto: false })}
                            search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Nota atau outlet" value={saring.cari} onChange={(e) => setSaring((s) => ({ ...s, cari: e.target.value }))} />}</FormField>}
                            fields={<>
                                <FormField label="Salesman">{(a11y) => <select {...a11y} className="fi-input" value={saring.salesman} onChange={(e) => setSaring((s) => ({ ...s, salesman: e.target.value }))}><option value="">Semua salesman</option>{salesmanList.map((s) => <option key={s}>{s}</option>)}</select>}</FormField>
                                <FormField label="Area">{(a11y) => <select {...a11y} className="fi-input" value={saring.area} onChange={(e) => setSaring((s) => ({ ...s, area: e.target.value }))}><option value="">Semua area</option>{areaList.map((a) => <option key={a}>{a}</option>)}</select>}</FormField>
                                <label className="fi-check"><input type="checkbox" checked={saring.pareto} onChange={(e) => setSaring((s) => ({ ...s, pareto: e.target.checked }))} />Hanya pareto</label>
                            </>}
                            chips={[
                                ...(saring.salesman ? [{ label: `Salesman: ${saring.salesman}`, onRemove: () => setSaring((s) => ({ ...s, salesman: "" })) }] : []),
                                ...(saring.area ? [{ label: `Area: ${saring.area}`, onRemove: () => setSaring((s) => ({ ...s, area: "" })) }] : []),
                                ...(saring.pareto ? [{ label: "Hanya pareto", onRemove: () => setSaring((s) => ({ ...s, pareto: false })) }] : []),
                            ]} />
                    </div>
                    <ResponsiveTable<NotaPool> title="Pool" count={poolTersaring.length} columns={kolomPool} rows={poolTersaring} rowKey={(p) => p.no_nota}
                        status={pool.status} error={pool.error} onRetry={muat}
                        selected={bolehKelola ? pilih : undefined} onSelectedChange={bolehKelola ? setPilih : undefined}
                        empty={poolRows.length === 0 ? { title: "Pool kosong", message: "Semua nota tanggal ini sudah masuk wave, atau file export belum diunggah." } : { title: "Tidak ada nota yang sesuai saringan", message: "Pilih semua hanya memilih yang terlihat setelah disaring." }}
                        mobileItem={(p) => <ListItem
                            doc={bolehKelola ? <label className="fi-check"><input type="checkbox" aria-label={`Pilih ${p.no_nota}`} checked={pilih.has(p.no_nota)} onChange={() => togglePilih(p.no_nota)} />{p.no_nota}</label> : p.no_nota}
                            amount={`${formatKarton(p.total_krt)} krt`} title={`${p.customer ?? KOSONG} · area ${p.area ?? "belum ada"}`} meta={`${p.salesman ?? "–"} · ${p.jumlah_baris} baris`}
                            badge={p.pareto ? <StatusBadge tone="info">Pareto</StatusBadge> : undefined} />} />
                </Section>
            )}

            <Section id="riwayat" title="Riwayat" subtitle="dari catatan kejadian wave">
                {data.riwayat?.length ? (
                    <ul className="fi-hist">
                        {data.riwayat.map((r, i) => { const l = labelEvent(r.event, r.payload); return (
                            <li key={`${r.created_at}-${i}`}><time dateTime={r.created_at}>{waktuWita(r.created_at)}</time><span><b>{r.aktor}</b> · {l.apa}</span>{l.ubah && <span className="fi-chg">{l.ubah}</span>}</li>
                        ); })}
                    </ul>
                ) : <EmptyState title="Belum ada catatan" />}
            </Section>

            {bolehKelola && draft && (
                dipilihRows.length > 0
                    ? <FooterToolbar message={<span className="fi-sum"><b>{dipilihRows.length} dipilih</b> · {formatKarton(kartonDipilih)} karton</span>}>
                        <Button busy={sibuk === "urgent"} disabled={sibuk === "tambah"} onClick={() => tambahNota("urgent")}>Tambah sebagai urgent</Button>
                        <Button variant="primary" busy={sibuk === "tambah"} disabled={sibuk === "urgent"} onClick={() => tambahNota("normal")}>Tambah {dipilihRows.length} nota</Button>
                    </FooterToolbar>
                    : <FooterToolbar message={aktif.length === 0 ? "Belum ada nota" : grupBerubah ? "Grup cetak diubah, belum disimpan" : undefined}>
                        <Button variant="tertiary" onClick={() => setDialog("batal")}>Batalkan wave…</Button>
                        <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={aktif.length === 0} disabledReason="Tambahkan nota dulu" onClick={() => setDialog("rilis")}>Rilis wave…</Button>
                    </FooterToolbar>
            )}
            {bolehKelola && wave.status === "released" && (
                <FooterToolbar message={menahan.length ? `${menahan.length} exception isi per karton masih terbuka` : grupBerubah ? "Grup cetak diubah, belum disimpan" : undefined}>
                    <Button variant="tertiary" onClick={() => setDialog("batal")}>Batalkan wave…</Button>
                    <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={menahan.length > 0} disabledReason={`Tutup ${menahan.length} exception isi per karton dulu`} onClick={() => setDialog("konfirmasi")}>Konfirmasi selesai…</Button>
                </FooterToolbar>
            )}

            <ConfirmDialog open={dialog === "rilis"} onClose={() => setDialog(null)} title={`Rilis Wave ${wave.nama}?`} tag="Rilis" confirmLabel="Rilis wave" onConfirm={() => transisi("release")}
                facts={[
                    ["Nota", `${aktif.length}${aktif.filter((n) => n.prioritas === "urgent").length ? ` · ${aktif.filter((n) => n.prioritas === "urgent").length} urgent` : ""}`],
                    ["Grup cetak", grupPilih.size ? kodeLembar : "Belum dipilih: lembar memuat semua nota"],
                    ["Saat rilis", "Exception diperiksa. Rilis tetap jalan bila ada; yang ditahan adalah konfirmasi"],
                    ["Setelah rilis", "Nota tidak bisa ditambah; keluarkan lewat Lepas dengan alasan"],
                ]} />
            <ConfirmDialog open={dialog === "konfirmasi"} onClose={() => setDialog(null)} title={`Konfirmasi Wave ${wave.nama} selesai?`} tag="Konfirmasi" confirmLabel="Konfirmasi selesai" onConfirm={() => transisi("confirm")}
                facts={[
                    ["Nota", `${aktif.length} aktif${dilepas.length ? ` · ${dilepas.length} dilepas` : ""}`],
                    ["Exception", `${exceptionOpen.length} terbuka · ${menahan.length} menahan`],
                    ["Setelah konfirmasi", "Isi dan grup cetak terkunci di layar ini. Kertas tetap bisa dicetak ulang"],
                ]} />
            <ConfirmDialog open={dialog === "batal"} onClose={() => setDialog(null)} title={`Batalkan Wave ${wave.nama}?`} tag="Batalkan" tone="negative" confirmLabel="Batalkan wave"
                reason={{ label: "Alasan", placeholder: "Mis. mobil rute utara rusak; nota dipindah ke wave sore" }} onConfirm={(alasan) => transisi("cancel", alasan)}
                description={wave.status === "released" ? <MessageStrip tone="warn" title="Wave sudah dirilis:">lembar rekapan dan TTF mungkin sudah di gudang. Tarik kertasnya sebelum nota disusun ulang.</MessageStrip> : undefined}
                facts={[
                    ["Kembali ke pool", `${aktif.length} nota; bisa masuk wave lain hari ini`],
                    ["Setelah batal", "Wave tidak bisa dirilis ulang; buat wave baru"],
                ]} />
            <ConfirmDialog open={dialog === "takeout"} onClose={() => { setDialog(null); setNotaLepas(null); }} title={`Lepas ${notaLepas?.no_nota ?? ""} dari Wave ${wave.nama}?`} tag="Lepas" confirmLabel="Lepas nota"
                reason={{ label: "Alasan (minimal 5 huruf)", placeholder: "Mis. toko minta kirim besok; gudang toko penuh" }} onConfirm={lepas}
                description={wave.status === "released" ? <MessageStrip tone="warn" title="Wave sudah dirilis:">barangnya mungkin sudah diambil dari rak. Kembalikan barangnya sebelum nota dilepas.</MessageStrip> : undefined}
                facts={[
                    ["Outlet", `${notaLepas?.customer ?? KOSONG} · ${formatKarton(notaLepas?.snap_total_krt)} karton`],
                    ["Kembali ke", `Pool ${TIPE_LABEL[wave.tipe]?.toLowerCase() ?? wave.tipe} ${tanggalPendek(wave.tanggal)}`],
                    ["Izin", "Setujui lepas nota"],
                ]} />
            <ConfirmDialog open={dialog === "isi"} onClose={() => { setDialog(null); setIsiSimpan(null); }} tag="Master konversi" confirmLabel="Simpan isi" factsAlign="start"
                title={`Simpan isi ${isiSimpan?.n ?? ""} per karton untuk ${isiSimpan?.e.ref_kode ?? "barang ini"}?`}
                facts={isiSimpan ? [
                    ["Barang", `${isiSimpan.e.ref_kode}${isiSimpan.e.nama_ref ? ` · ${isiSimpan.e.nama_ref}` : ""}`],
                    ["Isi per karton", `${isiSimpan.e.master_saat_ini ?? "belum ada"} → ${isiSimpan.n}`],
                    ["Berlaku", "Master konversi barang: semua wave berikutnya dan cetak ulang lembar memakai isi ini"],
                ] : []}
                onConfirm={async () => { const d = isiSimpan!; await simpanIsi(d.e, d.n); setDialog(null); setIsiSimpan(null); }} />
            <ConfirmDialog open={dialog === "selesai"} onClose={() => { setDialog(null); setExcSelesai(null); }} tag="Selesai" confirmLabel="Tandai selesai" factsAlign="start"
                title={`Tandai exception ${jenisLabel(excSelesai?.jenis).toLowerCase()} ${excSelesai?.ref_kode ?? ""} selesai?`}
                facts={excSelesai ? [
                    ["Referensi", rujukan(excSelesai)],
                    ["Masalah", excSelesai.keterangan ?? KOSONG],
                    ["Konfirmasi wave", menahanKonfirmasi(excSelesai.jenis, excSelesai.status) ? "Tidak lagi ditahan exception ini" : "Tidak terpengaruh (exception informasi)"],
                    ["Dicatat", "Selesai, atas nama Anda dengan jam saat ini"],
                ] : []}
                onConfirm={async () => { await tutupException(excSelesai!, "selesai"); setDialog(null); setExcSelesai(null); }} />
            <ConfirmDialog open={dialog === "abaikan"} onClose={() => { setDialog(null); setExcAbaikan(null); }}
                title={`Abaikan exception ${jenisLabel(excAbaikan?.jenis).toLowerCase()}?`} tag="Abaikan" confirmLabel="Abaikan dengan alasan"
                reason={{ label: "Alasan", min: 5, placeholder: "Mis. file benar; master sedang dikoreksi tim master barang" }}
                onConfirm={async (alasan) => { if (excAbaikan) await tutupException(excAbaikan, "abaikan", alasan); setDialog(null); setExcAbaikan(null); }}
                facts={[
                    ["Referensi", excAbaikan ? rujukan(excAbaikan) : ""],
                    ["Masalah", excAbaikan?.keterangan ?? KOSONG],
                    ...(excAbaikan && petunjukMaster(excAbaikan) ? [["Petunjuk", petunjukMaster(excAbaikan)] as [string, string]] : []),
                    ["Konfirmasi", excAbaikan && menahanKonfirmasi(excAbaikan.jenis, excAbaikan.status) ? "Tidak lagi ditahan exception ini" : "Tidak terpengaruh (exception informasi)"],
                ]} />
        </div>
    );
}
