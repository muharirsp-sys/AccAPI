/*
 * Tujuan: Wizard Order Principal (Fiori S6d, it06 #9–#15): 1 Unggah (pilihan principal, pratinjau → ringkasan → Simpan batch, berkas sama →
 *   dialog Ganti batch lama) + Batch terakhir (Buka, Hapus…); batch terpilih di URL `?batch=<id>` membuka langkah 2–4 (LangkahBatch).
 * Caller: app/(dashboard)/principal-order/page.tsx.
 * Dependensi: GET/POST/DELETE /api/principal-order, GET /api/principal-order/queue (cek antrean sebelum hapus/ganti);
 *   components/fiori/{core,interactive}; ./LangkahBatch; ./bersama.
 * Main Functions: OrderPrincipal.
 * Side Effects: router.replace (`?batch=`); HTTP unggah (pratinjau tidak menulis; simpan/ganti menulis batch), hapus batch.
 *   BL-21: server menolak hapus/ganti (409) bila ada SO batch di Antrean Faktur dan Ganti butuh izin ubah order; layar memeriksa juga
 *   (saat dialog dibuka dan lagi tepat sebelum menulis). Alasan hapus yang tercatat dan BL-44 belum ada di server → VariantNote.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileSpreadsheet, FolderOpen, Replace, Search, Trash2, TriangleAlert, Upload } from "lucide-react";
import {
    Button, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import LangkahBatch, { Kepala, type Pesan } from "./LangkahBatch";
import {
    ALASAN_IZIN, PESAN_TIDAK_PASTI, PRINCIPAL_DIDUKUNG, TidakPasti, angka, baca, ditahanUtuh, tanggalSo, tulis, waktuWita,
    type BarisAntrean, type Batch, type Pratinjau,
} from "./bersama";

type Dialog = { jenis: "hapus"; batch: Batch } | { jenis: "ganti" } | null;

const pesanDari = (e: unknown, umum: string) => (e instanceof Error && e.message ? e.message : umum);

/** Akibat "belum termapping" per jenis kode (dibawa dari halaman lama). */
const AKIBAT_BELUM_TERMAPPING = [
    ["Produk", "unmappedProducts", "SO-nya ditahan utuh sekarang; unggah ulang sesudah mapping dilengkapi."],
    ["Pelanggan", "unmappedCustomers", "SO-nya tertahan di Validasi; cukup Validasi ulang sesudah dilengkapi."],
    ["Salesman", "unmappedSalesmen", "SO-nya tertahan di Validasi; cukup Validasi ulang sesudah dilengkapi."],
] as const;

export default function OrderPrincipal({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehBuat = keys.has("order.create");
    const bolehUbah = keys.has("order.edit");
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const batchId = sp.get("batch") ?? "";
    const buka = useCallback((id: string) => router.replace(id ? `${pathname}?batch=${encodeURIComponent(id)}` : pathname, { scroll: false }), [router, pathname]);

    // Gagal memuat TIDAK boleh tampil sebagai "Belum ada batch": batch yang menunggu akan dianggap tidak ada.
    const [daftar, muatDaftar] = useLoad(useCallback(() => baca("/api/principal-order", (j) => (j.batches ?? []) as Batch[], "Daftar batch belum berhasil dimuat."), []));
    const [berkas, setBerkas] = useState<File | null>(null);
    const [pratinjau, setPratinjau] = useState<Pratinjau | null>(null);
    const [proses, setProses] = useState<"pratinjau" | "simpan" | null>(null);
    const [pesan, setPesan] = useState<Pesan | null>(null);
    // Simpan/ganti yang jawabannya tidak pasti: batch mungkin sudah tersimpan. Simpan terkunci sampai Pratinjau ulang (membaca ulang "berkas sama").
    const [basi, setBasi] = useState(false);
    const [dialog, setDialog] = useState<Dialog>(null);
    useUnsavedGuard(Boolean(berkas) && !batchId);

    // Dialog hapus/ganti membaca status antrean batch yang bersangkutan lebih dulu (BL-21; server tetap menolak 409 di transaksinya).
    const idCek = dialog?.jenis === "hapus" ? dialog.batch.id : dialog?.jenis === "ganti" ? pratinjau?.duplicateOf?.id ?? "" : "";
    const [cek, muatCek] = useLoad(useCallback((): Promise<Load<number>> => idCek
        ? baca(`/api/principal-order/queue?id=${encodeURIComponent(idCek)}`, (j) => ((j.queue ?? []) as BarisAntrean[]).length, "Status antrean batch belum terbaca.")
        : Promise.resolve({ status: "memuat" }), [idCek]));

    function pilihBerkas(file: File | null) {
        setBerkas(file); setPratinjau(null); setBasi(false); setPesan(null);
    }

    async function kirimBerkas(apply: boolean, replace: boolean) {
        const form = new FormData();
        form.append("file", berkas as File);
        form.append("principal", PRINCIPAL_DIDUKUNG);
        form.append("apply", String(apply));
        form.append("replace", String(replace));
        return tulis("/api/principal-order", { body: form, gagal: "Unggah gagal" });
    }

    /** Pratinjau dulu (`apply=false`): tidak ada yang tersimpan sebelum ringkasannya dilihat. */
    async function pratinjauBerkas() {
        if (!berkas) return;
        setProses("pratinjau"); setPesan(null); setPratinjau(null); setBasi(false);
        try {
            setPratinjau(await kirimBerkas(false, false) as unknown as Pratinjau);
        } catch (e) {
            setPesan({ tone: "neg", title: "Pratinjau gagal.", body: e instanceof TidakPasti ? "Server tidak memberi jawaban yang pasti. Pratinjau tidak menyimpan apa pun; coba lagi." : pesanDari(e, "Unggah gagal.") });
        } finally {
            setProses(null);
        }
    }

    function tersimpan(data: Record<string, unknown>, ganti: boolean) {
        setPesan({ tone: "pos", title: `${angka(Number(data.lineCount) || 0)} baris tersimpan${ganti ? " menggantikan batch lama" : ""}.`, body: "Lanjutkan dengan Validasi." });
        setPratinjau(null); setBerkas(null); setBasi(false); setDialog(null);
        muatDaftar();
        buka(String(data.id));
    }

    async function simpanBatch() {
        setProses("simpan"); setPesan(null);
        try {
            tersimpan(await kirimBerkas(true, false), false);
        } catch (e) {
            if (e instanceof TidakPasti) {
                setBasi(true); muatDaftar();
                setPesan({ tone: "warn", title: "Hasil simpan belum pasti.", body: `${PESAN_TIDAK_PASTI} Bila batchnya muncul di Batch terakhir, buka dari sana; bila tidak, Pratinjau ulang lalu simpan.` });
            } else {
                setPesan({ tone: "neg", title: "Batch belum tersimpan.", body: pesanDari(e, "Unggah gagal.") });
            }
        } finally {
            setProses(null);
        }
    }

    /**
     * Bacaan status antrean di dialog bisa usang (dibaca saat dialog dibuka). Dibaca ULANG tepat sebelum menulis; ada SO di antrean
     * atau gagal dibaca = tidak menulis (pesan di dialog). Server tetap penjaga utama (BL-21: 409 di dalam transaksi hapus/ganti).
     */
    async function pastikanBebasAntrean(id: string, apa: "dihapus" | "diganti") {
        const r = await baca(`/api/principal-order/queue?id=${encodeURIComponent(id)}`, (j) => ((j.queue ?? []) as BarisAntrean[]).length, "Status antrean batch belum terbaca.");
        if (r.status === "galat") throw new Error(`${r.error} Batch tidak ${apa}.`);
        if ((r.data ?? 0) > 0) {
            muatCek();
            throw new Error(`${r.data} SO batch ${apa === "diganti" ? "lama" : "ini"} sudah di Antrean Faktur; batch tidak bisa ${apa} (BL-21). Buang dulu di Antrean Faktur bila memang harus diulang.`);
        }
    }

    async function gantiBatch() {
        if (pratinjau?.duplicateOf) await pastikanBebasAntrean(pratinjau.duplicateOf.id, "diganti");
        try {
            tersimpan(await kirimBerkas(true, true), true);
        } catch (e) {
            if (e instanceof TidakPasti) { setBasi(true); muatDaftar(); muatCek(); }
            throw e;
        }
    }

    async function hapusBatch(batch: Batch) {
        await pastikanBebasAntrean(batch.id, "dihapus");
        let data: Record<string, unknown>;
        try {
            data = await tulis(`/api/principal-order?id=${encodeURIComponent(batch.id)}`, { method: "DELETE", gagal: "Gagal menghapus" });
        } catch (e) {
            // Tidak pasti: daftar batch dan status antrean batch itu dibaca ulang; Hapus terkunci sampai terbaca lagi.
            if (e instanceof TidakPasti) { muatDaftar(); muatCek(); }
            throw e;
        }
        setDialog(null);
        // removed 0 = batch sudah tidak ada (dihapus orang lain, atau kiriman sebelumnya yang jawabannya tidak pasti ternyata sampai).
        setPesan(Number(data.removed) > 0
            ? { tone: "pos", title: `Batch ${batch.fileName} dihapus.` }
            : { tone: "info", title: `Batch ${batch.fileName} sudah tidak ada.`, body: "Tidak ada yang dihapus kali ini; mungkin sudah dihapus sebelumnya." });
        muatDaftar();
        if (batchId === batch.id) buka("");
    }

    const nCek = cek.data ?? 0;
    const kunciCek = (apa: string) => cek.status === "memuat" ? `Memeriksa status antrean batch ${apa}…`
        : cek.status === "galat" ? `Status antrean batch ${apa} belum terbaca; aksi dinonaktifkan.`
            : nCek > 0 ? `${nCek} SO batch ${apa} sudah di Antrean Faktur; batch tidak bisa ${apa === "lama" ? "diganti" : "dihapus"} (BL-21). Buang dulu di Antrean Faktur bila memang harus diulang.` : undefined;
    const kunciHapus = !bolehUbah ? ALASAN_IZIN.ubah : kunciCek("ini");
    const kunciGanti = !bolehUbah ? ALASAN_IZIN.ganti : basi ? "Hasil sebelumnya belum pasti; tutup, periksa Batch terakhir, lalu Pratinjau ulang." : kunciCek("lama");
    const kunciDaftar = daftar.status === "memuat" ? "Daftar batch sedang dimuat ulang." : daftar.status === "galat" ? "Daftar batch belum terbaca." : undefined;

    const dialogHapus = dialog?.jenis === "hapus" ? dialog.batch : null;
    const dup = pratinjau?.duplicateOf ?? null;
    const statusCek = cek.status === "memuat" ? "memeriksa…" : cek.status === "galat" ? "belum terbaca" : nCek > 0 ? `${nCek} SO — dikunci` : "0 SO";
    const galatCek = cek.status === "galat" && (
        <MessageStrip tone="neg" title="Status antrean belum terbaca.">
            {cek.error}{" "}<button type="button" className="fi-btn fi-btn--tertiary" onClick={muatCek}>Coba lagi</button>
        </MessageStrip>
    );
    const dialogs = (
        <>
            <ConfirmDialog open={Boolean(dialogHapus)} onClose={() => setDialog(null)} title={`Hapus batch ${dialogHapus?.fileName ?? ""}?`} tag="Hapus batch" tone="negative"
                confirmLabel="Hapus batch" confirmDisabled={kunciHapus}
                description="Batch beserta seluruh baris dan hasil validasinya dihapus. Konfirmasi bukan order ganda tetap tercatat per SO."
                facts={dialogHapus ? [
                    ["Batch", `${dialogHapus.fileName} · ${angka(dialogHapus.lineCount)} baris · periode ${tanggalSo(dialogHapus.period) || "—"}`],
                    ["Di Antrean Faktur", statusCek],
                    ["Pembanding order ganda", "SO batch ini tidak lagi dipakai sebagai pembanding batch lain"],
                ] : []}
                onConfirm={() => (dialogHapus ? hapusBatch(dialogHapus) : undefined)}>
                {galatCek}
                {kunciHapus && cek.status !== "galat" && <p className="fi-small fi-why">{kunciHapus}</p>}
                <VariantNote bl="BL-21">Server menolak penghapusan bila ada SO batch ini di Antrean Faktur, tetapi alasan penghapusan belum bisa dikirim dan belum tercatat. Usulan: penghapusan beralasan dan tercatat di riwayat.</VariantNote>
            </ConfirmDialog>
            <ConfirmDialog open={dialog?.jenis === "ganti"} onClose={() => setDialog(null)} title={`Ganti batch ${dup?.fileName ?? ""} dengan berkas ini?`} tag="Ganti batch"
                confirmLabel="Ganti batch" confirmDisabled={kunciGanti}
                description="Batch lama beserta hasil validasinya dihapus dan diganti batch baru; batch baru perlu divalidasi ulang."
                facts={dup && pratinjau ? [
                    ["Batch lama", `${dup.fileName} · diunggah ${waktuWita(dup.uploadedAt)}`],
                    ["Di Antrean Faktur", statusCek],
                    ["Berkas baru", `${pratinjau.fileName} · ${angka(pratinjau.lineCount)} baris siap disimpan`],
                    ["Konfirmasi order ganda", "tetap berlaku (dicatat per SO)"],
                ] : []}
                onConfirm={gantiBatch}>
                {galatCek}
                {kunciGanti && cek.status !== "galat" && <p className="fi-small fi-why">{kunciGanti}</p>}
                <VariantNote bl="BL-21">Server menolak penggantian bila ada SO batch lama di Antrean Faktur, tetapi penggantian belum tercatat beralasan. Usulan: penggantian beralasan dan tercatat di riwayat.</VariantNote>
            </ConfirmDialog>
        </>
    );

    if (batchId) {
        return (
            <>
                <LangkahBatch key={batchId} batchId={batchId} bolehBuat={bolehBuat} bolehUbah={bolehUbah} pesan={pesan} tutupPesan={() => setPesan(null)}
                    onHapus={(batch) => setDialog({ jenis: "hapus", batch })} onBerubah={muatDaftar} />
                {dialogs}
            </>
        );
    }

    // ── Langkah 1 · Unggah ──────────────────────────────────────────────────────────────────────────────
    const { held, lain } = ditahanUtuh(pratinjau?.issues ?? []);
    const belum = pratinjau ? AKIBAT_BELUM_TERMAPPING.filter(([, k]) => pratinjau[k].length > 0) : [];
    const kunciPratinjau = !bolehBuat ? ALASAN_IZIN.buat : proses ? "Berkas sedang diproses." : !berkas ? "Pilih berkas Order Detail dulu." : undefined;
    const kunciSimpan = !bolehBuat ? ALASAN_IZIN.buat : proses ? "Berkas sedang diproses."
        : basi ? "Hasil simpan sebelumnya belum pasti; periksa Batch terakhir, lalu Pratinjau ulang."
            : pratinjau && pratinjau.lineCount === 0 ? "Tidak ada satu pun baris yang bisa disimpan dari berkas ini." : undefined;
    // Tombol "Ganti batch lama…" di footer (berkas sama); alasannya tampil sebagai pesan footer, bukan hanya `title`.
    const kunciGantiTombol = !bolehUbah ? ALASAN_IZIN.ganti : basi ? "Hasil simpan sebelumnya belum pasti; periksa Batch terakhir, lalu Pratinjau ulang." : undefined;

    const kolomBatch: Column<Batch>[] = [
        { key: "berkas", header: "Berkas", cell: (b) => <><b className="fi-mono">{b.fileName}</b><span className="fi-codes">{b.principal}</span></> },
        { key: "periode", header: "Periode", cell: (b) => tanggalSo(b.period) || "—" },
        { key: "baris", header: "Baris", align: "end", cell: (b) => <span className="fi-tnum">{angka(b.lineCount)}</span> },
        { key: "lewat", header: "Dilewati", align: "end", secondary: true, cell: (b) => <span className="fi-tnum">{b.skipped || "—"}</span> },
        { key: "validasi", header: "Validasi", cell: (b) => <BadgeValidasi batch={b} /> },
        { key: "unggah", header: "Diunggah", secondary: true, cell: (b) => <span className="fi-small">{waktuWita(b.uploadedAt)}{b.uploadedBy ? ` · ${b.uploadedBy}` : ""}</span> },
        { key: "aksi", header: "Tindakan", cell: (b) => aksiBatch(b) },
    ];
    const aksiBatch = (batch: Batch) => {
        const kunci = !bolehUbah ? ALASAN_IZIN.ubah : kunciDaftar;
        return (
            <span className="fi-btnrow" style={{ flexWrap: "nowrap" }}>
                <Button variant="tertiary" icon={<FolderOpen className="fi-icon" aria-hidden />} aria-label={`Buka ${batch.fileName}`} onClick={() => buka(batch.id)}>Buka</Button>
                <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} aria-label={`Hapus ${batch.fileName}…`} disabled={Boolean(kunci)} disabledReason={kunci}
                    onClick={() => setDialog({ jenis: "hapus", batch })}>Hapus…</Button>
            </span>
        );
    };

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <Kepala langkah={0} draf={berkas ? "Berkas belum disimpan" : undefined} />
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.title} onClose={() => setPesan(null)}>{pesan.body}</MessageStrip>}

            <Section title="Berkas" subtitle="pratinjau dulu; tidak ada yang tersimpan sebelum ringkasannya dilihat">
                <div className="fi-sect-in">
                    <div className="fi-formgrid">
                        <FormField label="Principal" help="Hanya principal yang formatnya terbaca yang bisa dipilih; hari ini parser hanya mengenal Order Detail Kino.">
                            {(a11y) => (
                                <select {...a11y} className="fi-input" defaultValue={PRINCIPAL_DIDUKUNG} disabled={!bolehBuat}>
                                    <option value={PRINCIPAL_DIDUKUNG}>{PRINCIPAL_DIDUKUNG} · format Order Detail Kino</option>
                                    <option value="" disabled>Principal lain — format belum didukung</option>
                                </select>
                            )}
                        </FormField>
                        <div className="fi-dropzone" data-ok={berkas ? "true" : undefined}>
                            <label className="fi-label" htmlFor="order-principal-berkas">Berkas Order Detail<span className="fi-req" aria-hidden>*</span></label>
                            <span>{berkas ? <><FileSpreadsheet className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> <b>{berkas.name}</b></> : "Laporan integrasi principal · .xlsx atau .xls · maks. 20 MB"}</span>
                            <input id="order-principal-berkas" className="fi-input" type="file" accept=".xlsx,.xls" disabled={!bolehBuat || Boolean(proses)}
                                title={!bolehBuat ? ALASAN_IZIN.buat : undefined} onChange={(e) => pilihBerkas(e.target.files?.[0] ?? null)} />
                        </div>
                    </div>
                    {!bolehBuat && <p className="fi-small fi-why">{ALASAN_IZIN.buat}</p>}
                </div>
            </Section>

            {proses === "pratinjau" && <Skeleton rows={4} label="Membaca berkas" />}
            {pratinjau && (
                <Section title="Pratinjau berkas" subtitle={`${pratinjau.fileName} · ${pratinjau.branch || "cabang tidak terbaca"} · periode ${tanggalSo(pratinjau.period) || "tidak terbaca"}`}>
                    <div className="fi-sect-in">
                        <div className="fi-kcards" aria-label="Ringkasan pratinjau" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
                            <div className="fi-kc" data-tone="pos"><span>Siap disimpan</span><b>{angka(pratinjau.lineCount)}</b><small>baris</small></div>
                            <div className="fi-kc" data-tone={pratinjau.skipped ? "warn" : undefined}><span>Dilewati</span><b>{angka(pratinjau.skipped)}</b><small>baris saat dibaca</small></div>
                            <div className="fi-kc" data-tone={held.length ? "warn" : undefined}><span>Ditahan utuh</span><b>{held.length} SO</b><small>tidak disimpan, tidak jadi faktur</small></div>
                            <div className="fi-kc" data-tone={belum.length ? "warn" : undefined}><span>Belum termapping</span><b>{belum.reduce((a, [, k]) => a + pratinjau[k].length, 0)}</b><small>kode produk/pelanggan/salesman</small></div>
                        </div>
                        {dup && (
                            <MessageStrip tone="warn" title="Berkas ini sudah pernah diunggah.">
                                {dup.fileName}, {waktuWita(dup.uploadedAt)}. Simpan dinonaktifkan; pilih Ganti batch lama bila memang mau diulang.{" "}
                                <Link href={`/principal-order?batch=${encodeURIComponent(dup.id)}`}>Buka batch lama</Link>
                            </MessageStrip>
                        )}
                        {held.length > 0 && (
                            <MessageStrip tone="warn" title={`${held.length} SO ditahan utuh — tidak disimpan, tidak jadi faktur.`}>
                                <ul style={{ paddingLeft: "1rem", listStyle: "disc" }}>{held.map((h) => <li key={h.so}><span className="fi-mono">SO {h.so}</span> · kode produk <span className="fi-mono">{h.kode || "—"}</span></li>)}</ul>
                                Tambahkan mapping-nya di <Link href="/principal-mapping">Mapping Principal</Link>, lalu unggah ulang berkas ini dan pilih Ganti batch lama.
                            </MessageStrip>
                        )}
                        {belum.length > 0 && (
                            <MessageStrip tone="warn" title="Belum termapping — lengkapi di Mapping Principal.">
                                <ul style={{ paddingLeft: "1rem", listStyle: "disc" }}>
                                    {belum.map(([label, k, akibat]) => (
                                        <li key={label}><b>{label} ({pratinjau[k].length}):</b> <span className="fi-mono">{pratinjau[k].slice(0, 12).join(", ")}{pratinjau[k].length > 12 && ` … (+${pratinjau[k].length - 12})`}</span> — {akibat}</li>
                                    ))}
                                </ul>
                                <Link href="/principal-mapping">Buka Mapping Principal</Link>
                            </MessageStrip>
                        )}
                        {lain.length > 0 && (
                            <div>
                                <p className="fi-small"><TriangleAlert className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> Temuan saat dibaca</p>
                                <ul className="fi-small" style={{ paddingLeft: "1rem", listStyle: "disc" }}>
                                    {lain.slice(0, 6).map((t) => <li key={t}>{t}</li>)}
                                    {lain.length > 6 && <li>… dan {lain.length - 6} temuan lain</li>}
                                </ul>
                            </div>
                        )}
                        {(dup || held.length > 0) && (
                            <VariantNote bl="BL-44">SO yang ditahan utuh hanya bisa dilepas lewat Ganti batch lama selama belum ada SO batch itu di Antrean Faktur; sesudahnya tidak ada jalan di layar. Usulan: Tambahkan SO yang tertahan ke batch yang sama tanpa mengganti batch.</VariantNote>
                        )}
                    </div>
                </Section>
            )}

            <Section title="Batch terakhir" subtitle="50 unggahan terbaru">
                <ResponsiveTable<Batch> title="Batch terakhir" count={daftar.data?.length} columns={kolomBatch} rows={daftar.data ?? []} rowKey={(b) => b.id}
                    status={daftar.status} error={daftar.error} onRetry={muatDaftar}
                    empty={{ title: "Belum ada batch", message: "Unggah berkas Order Detail di atas." }}
                    mobileItem={(b) => <ListItem doc={b.fileName} amount={`${angka(b.lineCount)} baris`} title={`${b.principal} · periode ${tanggalSo(b.period) || "—"}`}
                        meta={aksiBatch(b)} badge={<BadgeValidasi batch={b} />} />} />
                {!bolehUbah && <p className="fi-small fi-why" style={{ padding: "8px 16px" }}>Hapus batch nonaktif: {ALASAN_IZIN.ubah}</p>}
            </Section>

            <FooterToolbar message={kunciPratinjau ?? (pratinjau ? (dup ? (kunciGantiTombol ? `Berkas sama dengan batch yang sudah ada. ${kunciGantiTombol}` : "Berkas sama dengan batch yang sudah ada") : kunciSimpan ?? `${angka(pratinjau.lineCount)} baris akan disimpan`) : "Pratinjau berkas dulu")}>
                <Button variant={pratinjau ? "secondary" : "primary"} icon={<Search className="fi-icon" aria-hidden />} busy={proses === "pratinjau"}
                    disabled={Boolean(kunciPratinjau)} disabledReason={kunciPratinjau} onClick={() => void pratinjauBerkas()}>{pratinjau ? "Pratinjau ulang" : "Pratinjau"}</Button>
                {pratinjau && !dup && (
                    <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} busy={proses === "simpan"} disabled={Boolean(kunciSimpan)} disabledReason={kunciSimpan}
                        onClick={() => void simpanBatch()}>Simpan batch</Button>
                )}
                {pratinjau && dup && (
                    <Button variant="primary" icon={<Replace className="fi-icon" aria-hidden />} disabled={Boolean(kunciGantiTombol)}
                        disabledReason={kunciGantiTombol}
                        onClick={() => setDialog({ jenis: "ganti" })}>Ganti batch lama…</Button>
                )}
            </FooterToolbar>
            {dialogs}
        </div>
    );
}

function BadgeValidasi({ batch }: { batch: Batch }) {
    return batch.validatedAt
        ? <StatusBadge tone={batch.reviewCount > 0 ? "warn" : "pos"}>{batch.okCount} cocok · {batch.reviewCount} ditinjau</StatusBadge>
        : <StatusBadge tone="neu">Belum divalidasi</StatusBadge>;
}
