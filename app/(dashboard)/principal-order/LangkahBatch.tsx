/*
 * Tujuan: Langkah 2–4 wizard Order Principal untuk satu batch (`?batch=<id>`): 2 Validasi (KPI, Ditahan utuh paling atas, gerbang order
 *   ganda lewat dialog gandaP, baris dengan Harga laporan / Harga Accurate / Selisih), 3 Calon faktur (pratinjau antre, dialog antreN),
 *   4 Diantrekan (hasil antre, status antrean batch, alur dokumen sederhana). Juga kepala halaman (`Kepala`) yang dipakai langkah 1.
 * Caller: OrderPrincipal.tsx.
 * Dependensi: GET /api/principal-order?id=, POST /api/principal-order/validate (+prices=1), GET/POST/DELETE /api/principal-order/dupe-ack,
 *   GET/POST /api/principal-order/queue; components/fiori/{core,interactive}; lib/order-duplicate (isDuplicateFinding); lib/promo-ui (rupiah);
 *   ./bersama.
 * Main Functions: LangkahBatch, Kepala.
 * Side Effects: HTTP baca/tulis DB lokal (validasi, konfirmasi order ganda, baris invoice_outbox). TIDAK ada tulis ke Accurate di sini:
 *   faktur dibuat saat Kirim di Antrean Faktur. Logic BL-21/23/35/44/45 tidak ditulis (VariantNote).
 */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Pencil, Plug, Receipt, RefreshCw, Send, ShieldCheck, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge,
    VariantNote, type Column, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { isDuplicateFinding } from "@/lib/order-duplicate";
import { rupiah } from "@/lib/promo-ui";
import {
    ALASAN_IZIN, DitolakDenganDaftar, PESAN_TIDAK_PASTI, TidakPasti, angka, baca, ditahanUtuh, labelAntrean, soDariKunci, tanggalSo, tulis,
    waktuWita, type Ack, type BarisAntrean, type Batch, type CalonFaktur, type HasilAntre, type Line, type Rencana, type StatusAntrean,
} from "./bersama";

const LANGKAH = ["Unggah", "Validasi", "Calon faktur", "Diantrekan"];
export type Pesan = { tone: "pos" | "warn" | "neg" | "info"; title: string; body?: ReactNode };

/** Kepala halaman + langkah wizard. `langkah` 0..3. */
export function Kepala({ langkah, batch, status, aksi, draf }: { langkah: number; batch?: Batch | null; status?: ReactNode; aksi?: ReactNode; draf?: string }) {
    const steps: FlowStep[] = LANGKAH.map((label, i) => ({ label, state: i < langkah ? "done" : i === langkah ? "current" : "todo" }));
    return (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman">
                <ol className="fi-crumb">
                    <li><span>Penjualan</span></li>
                    {batch
                        ? <><li><Link href="/principal-order">Order Principal</Link></li><li><span aria-current="page">{batch.fileName}</span></li></>
                        : <li><span aria-current="page">Order Principal</span></li>}
                </ol>
            </nav>
            <div className="fi-page-bar">
                <h1>Order Principal</h1>
                {status}
                {draf && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />{draf}</span>}
                <span className="fi-spacer" />
                {aksi}
            </div>
            <p>
                {batch
                    ? <><b className="fi-mono">{batch.fileName}</b> · {batch.principal} · {batch.branch || "cabang tidak terbaca"} · periode {tanggalSo(batch.period) || "tidak terbaca"} · diunggah {waktuWita(batch.uploadedAt)}{batch.uploadedBy ? ` oleh ${batch.uploadedBy}` : ""}</>
                    : "Unggah laporan integrasi dari sistem principal (Order Detail), validasi, siapkan calon faktur, lalu antrekan. Satuan, harga, dan posisi diskon dinormalkan mengikuti aturan yang selama ini dipakai."}
            </p>
            <Flow steps={steps} label="Langkah Order Principal" />
        </header>
    );
}

type Props = {
    batchId: string; bolehBuat: boolean; bolehUbah: boolean;
    pesan: Pesan | null; tutupPesan: () => void;
    /** Buka dialog hapus milik halaman (dialog membaca status antrean batch itu sendiri). */
    onHapus: (batch: Batch) => void;
    /** Daftar batch di langkah 1 perlu dimuat ulang (hitungan validasi berubah). */
    onBerubah: () => void;
};
type Dialog = { jenis: "ganda"; soNo: string; finding: string } | { jenis: "antre" } | null;

const pesanDari = (e: unknown, umum: string) => (e instanceof Error && e.message ? e.message : umum);
const selisihOf = (l: Line) => (l.expectedPrice == null ? null : Number(l.price) - Number(l.expectedPrice));

function BadgeBaris({ line }: { line: Line }) {
    if (line.status === "ok") return <StatusBadge tone="pos">Cocok</StatusBadge>;
    if (line.status === "review") return <StatusBadge tone="warn">Ditinjau</StatusBadge>;
    return <StatusBadge tone="neu">Belum divalidasi</StatusBadge>;
}

export default function LangkahBatch({ batchId, bolehBuat, bolehUbah, pesan, tutupPesan, onHapus, onBerubah }: Props) {
    const enc = encodeURIComponent(batchId);
    const [isi, muatIsi] = useLoad(useCallback(() => baca(`/api/principal-order?id=${enc}`,
        (j) => ({ batch: j.batch as Batch, lines: (j.lines ?? []) as Line[] }), "Batch belum berhasil dimuat."), [enc]));
    const principal = isi.data?.batch.principal ?? "";
    const [acks, muatAcks] = useLoad(useCallback((): Promise<Load<Ack[]>> => principal
        ? baca(`/api/principal-order/dupe-ack?principal=${encodeURIComponent(principal)}`, (j) => (j.acks ?? []) as Ack[], "Konfirmasi order ganda yang tercatat belum terbaca.")
        : Promise.resolve({ status: "memuat" }), [principal]));
    const [antrean, muatAntrean] = useLoad(useCallback(() => baca(`/api/principal-order/queue?id=${enc}`,
        (j): StatusAntrean => ({ candidates: Number(j.candidates) || 0, queue: (j.queue ?? []) as BarisAntrean[] }), "Status antrean batch ini belum terbaca."), [enc]));

    const [pilihan, setLangkah] = useState<"validasi" | "calon" | "antre" | null>(null);
    const [sibuk, setSibuk] = useState<"validasi" | "harga" | "cabut" | null>(null);
    const [strip, setStrip] = useState<Pesan | null>(null);
    const [hasilValidasi, setHasilValidasi] = useState<{ okCount: number; reviewCount: number; peringatan: string[]; harga: { ok: boolean; error?: string; processed?: number; priceRows?: number } | null } | null>(null);
    const [hanyaTinjau, setHanyaTinjau] = useState<boolean | null>(null);
    const [rencana, setRencana] = useState<Rencana | null>(null);
    const [menyiapkan, setMenyiapkan] = useState(false);
    const [galatRencana, setGalatRencana] = useState<string | null>(null);
    const [rencanaBasi, setRencanaBasi] = useState(false);
    const [hasilAntre, setHasilAntre] = useState<HasilAntre | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);

    const batch = isi.data?.batch;
    const lines = useMemo(() => isi.data?.lines ?? [], [isi.data]);
    const antreRows = antrean.data?.queue ?? [];
    // Langkah bawaan: batch yang SO-nya sudah di antrean dibuka di Diantrekan; selain itu di Validasi.
    const langkah = pilihan ?? (antreRows.length > 0 ? "antre" : "validasi");
    const draf = langkah === "calon" && Boolean(rencana?.ready.length);
    useUnsavedGuard(draf);

    // SO yang ditahan gerbang order ganda. Temuannya melekat pada SETIAP baris SO itu — yang diduga ganda adalah ordernya, bukan
    // satu barisnya — jadi dikelompokkan balik ke per-SO di sini, supaya satu tombol melepas satu order, bukan satu baris dari sebuah order.
    const dupes = useMemo(() => {
        const m = new Map<string, string>();
        for (const line of lines) {
            const finding = line.findings.find(isDuplicateFinding);
            if (finding && !m.has(line.soNo)) m.set(line.soNo, finding);
        }
        return m;
    }, [lines]);
    // Konfirmasi yang sudah tercatat BERTAHAN lintas validasi, jadi kalau tidak ditampilkan ia jadi keputusan tak terlihat: SO-nya lolos
    // terus dan tidak ada yang tahu sejak kapan atau oleh siapa. Disaring ke SO milik batch yang sedang dibuka saja.
    const soDiBatch = useMemo(() => new Set(lines.map((line) => line.soNo)), [lines]);
    const acksDiBatch = (acks.data ?? []).filter((ack) => soDiBatch.has(ack.soNo));
    const { held, lain } = ditahanUtuh(batch?.issues ?? []);
    const nReview = lines.filter((line) => line.status === "review").length;
    const soReview = new Set(lines.filter((line) => line.status === "review").map((line) => line.soNo)).size;
    const tinjauSaja = hanyaTinjau ?? nReview > 0;
    const tampil = tinjauSaja ? lines.filter((line) => line.status === "review") : lines;

    // Aksi tulis terkunci selama sumber keputusannya dimuat, dimuat ulang, atau gagal dibaca.
    const kunciIsi = isi.status === "memuat" ? "Data batch sedang dimuat ulang; tunggu sampai selesai." : isi.status === "galat" ? "Data batch gagal dimuat; muat ulang dulu." : undefined;
    const kunciValidasi = !bolehBuat ? ALASAN_IZIN.buat : sibuk ? "Validasi sedang berjalan." : kunciIsi;
    const kunciLanjut = !bolehUbah ? ALASAN_IZIN.ubah : kunciIsi ?? (sibuk ? "Validasi sedang berjalan."
        : !batch?.validatedAt ? "Validasi batch ini dulu." : batch.okCount === 0 ? "Belum ada baris yang lolos validasi." : undefined);
    const kunciAck = !bolehBuat ? ALASAN_IZIN.buat : sibuk ? "Validasi sedang berjalan." : kunciIsi
        ?? (acks.status === "memuat" ? "Konfirmasi yang tercatat sedang dimuat ulang." : acks.status === "galat" ? "Konfirmasi yang tercatat belum terbaca; coba lagi dulu." : undefined);
    const kunciHapus = !bolehUbah ? ALASAN_IZIN.ubah : antrean.status === "memuat" ? "Status antrean batch ini sedang dimuat."
        : antrean.status === "galat" ? "Status antrean batch ini belum terbaca; hapus dinonaktifkan."
            : antreRows.length > 0 ? `${antreRows.length} SO batch ini ada di Antrean Faktur; batch tidak bisa dihapus (BL-21).` : undefined;
    const kunciAntre = !bolehUbah ? ALASAN_IZIN.ubah : rencanaBasi ? "Hasil antre sebelumnya belum pasti; siapkan ulang calon faktur dulu."
        : menyiapkan ? "Calon faktur sedang disiapkan." : !rencana?.ready.length ? "Tidak ada SO yang siap jadi faktur." : undefined;

    /**
     * `segarkanHarga` menyegarkan daftar harga Accurate untuk barang pada batch INI lebih dulu (`prices=1`). Dipakai setelah harga
     * diperbaiki di Accurate: cache harga jual tidak pernah masuk cron, jadi tanpa ini baris tetap tertahan dengan harga lama dan tidak
     * ada cara menjalankan sync-nya dari layar. Bertarget, jadi hitungan detik — bukan 21 menit sync penuh.
     */
    async function validasi(segarkanHarga = false): Promise<boolean> {
        setSibuk(segarkanHarga ? "harga" : "validasi");
        setStrip(null);
        setRencana(null);
        try {
            const data = await tulis(`/api/principal-order/validate?id=${enc}${segarkanHarga ? "&prices=1" : ""}`, { gagal: "Validasi gagal" });
            // Peringatan se-batch: daftar outlet yang DITUNJUK aturan tetapi kosong pada tanggal SO. Barisnya sudah tertahan sendiri,
            // tetapi tanpa kalimat ini sebabnya terbaca sebagai "aturannya hilang" dan dicari di tempat yang salah. Tampil sebagai strip
            // yang menetap sampai validasi berikutnya — ia menunjuk pekerjaan yang harus dikerjakan, bukan sekadar kabar.
            setHasilValidasi({
                okCount: Number(data.okCount) || 0, reviewCount: Number(data.reviewCount) || 0,
                peringatan: Array.isArray(data.peringatan) ? (data.peringatan as string[]) : [],
                harga: (data.priceRefresh as { ok: boolean; error?: string; processed?: number; priceRows?: number } | null) ?? null,
            });
            return true;
        } catch (e) {
            setHasilValidasi(null);
            setStrip(e instanceof TidakPasti
                ? { tone: "warn", title: "Hasil validasi belum pasti.", body: PESAN_TIDAK_PASTI }
                : { tone: "neg", title: "Validasi gagal.", body: pesanDari(e, "Validasi gagal.") });
            return false;
        } finally {
            setSibuk(null);
            muatIsi(); muatAcks(); onBerubah();
        }
    }

    /**
     * Melepas satu SO dari gerbang order ganda. Yang dikirim bukan hanya "saya menekan tombol" melainkan ALASAN yang sedang menahan SO
     * itu saat ini (`reason` = temuannya) beserta catatan pemeriksaannya (`note`, wajib di layar): yang membaca jejaknya nanti perlu tahu
     * APA yang sudah diperiksa orang tersebut, dan tanda tangan tanpa isi tidak bisa dipertanggungjawabkan.
     *
     * Batch divalidasi ulang sesudahnya. Status baris di basis data masih memuat temuan lama sampai dihitung ulang — tanpa validasi
     * ulang, tombolnya ditekan dan layarnya tidak berubah apa pun, yang akan dibaca sebagai "tombolnya rusak".
     */
    async function konfirmasiGanda(soNo: string, finding: string, note: string) {
        try {
            await tulis("/api/principal-order/dupe-ack", { body: { principal, soNo, reason: finding, note }, gagal: "Konfirmasi gagal" });
        } catch (e) {
            if (e instanceof TidakPasti) { muatAcks(); muatIsi(); }
            throw e;
        }
        setDialog(null);
        if (await validasi()) setStrip({ tone: "pos", title: `SO ${soNo} dinyatakan bukan order ganda.`, body: "Batch sudah divalidasi ulang." });
    }

    /**
     * Mencabut konfirmasi: SO-nya kembali ditahan gerbang order ganda pada validasi ulang yang langsung dijalankan. Sengaja TANPA dialog
     * "yakin?": terhadap gerbang order ganda ia mengembalikan penahanan, bukan melepaskannya, dan salah tekan diperbaiki dengan satu
     * tombol di sebelahnya. TETAPI bukan tanpa akibat: SO yang sudah antre/terposting lalu ditahan lagi berhenti jadi calon faktur —
     * karena itu status antrean batch (penjaga Hapus/Ganti, BL-21) dihitung server dari SEMUA nomor SO batch, bukan dari kandidat.
     */
    async function cabut(soNo: string) {
        setSibuk("cabut");
        setStrip(null);
        try {
            await tulis(`/api/principal-order/dupe-ack?principal=${encodeURIComponent(principal)}&soNo=${encodeURIComponent(soNo)}`, { method: "DELETE", gagal: "Gagal mencabut konfirmasi" });
        } catch (e) {
            setSibuk(null);
            if (e instanceof TidakPasti) { muatAcks(); muatIsi(); }
            setStrip(e instanceof TidakPasti ? { tone: "warn", title: "Hasil pencabutan belum pasti.", body: PESAN_TIDAK_PASTI } : { tone: "neg", title: "Konfirmasi belum dicabut.", body: pesanDari(e, "Gagal mencabut konfirmasi.") });
            return;
        }
        setSibuk(null);
        if (await validasi()) setStrip({ tone: "pos", title: `Konfirmasi SO ${soNo} dicabut.`, body: "SO-nya kembali ditahan gerbang order ganda." });
    }

    /** Pratinjau dulu: tidak ada satu pun baris antrean ditulis sebelum daftarnya dilihat (`queue: false` tidak menulis apa pun). */
    async function siapkan() {
        setLangkah("calon");
        setMenyiapkan(true);
        setGalatRencana(null);
        try {
            const data = await tulis(`/api/principal-order/queue?id=${enc}`, { body: { queue: false }, gagal: "Faktur gagal disiapkan" });
            setRencana({ batchId, ready: (data.ready ?? []) as CalonFaktur[], skipped: (data.skipped ?? []) as Rencana["skipped"] });
            setRencanaBasi(false);
        } catch (e) {
            // Alasan penolakan per SO tetap ditampilkan, bukan cuma pesan galatnya.
            setRencana(e instanceof DitolakDenganDaftar ? { batchId, ready: [], skipped: e.skipped } : null);
            setGalatRencana(e instanceof TidakPasti ? "Server tidak memberi jawaban yang pasti. Menyiapkan calon faktur tidak menulis apa pun; coba lagi." : pesanDari(e, "Faktur gagal disiapkan."));
        } finally {
            setMenyiapkan(false);
        }
    }

    async function antrekan() {
        let data: Record<string, unknown>;
        try {
            data = await tulis(`/api/principal-order/queue?id=${enc}`, { body: { queue: true }, gagal: "Gagal memasukkan ke antrean" });
        } catch (e) {
            // Tidak pasti: sebagian SO mungkin sudah masuk antrean. Calon faktur ini usang; status antrean dibaca ulang dan Antrekan
            // terkunci sampai calon faktur disiapkan ulang (SO yang sudah antre lalu tercatat "sudah ada di antrean faktur").
            if (e instanceof TidakPasti) { setRencanaBasi(true); muatAntrean(); }
            throw e;
        }
        setDialog(null);
        setHasilAntre({
            queued: Number(data.queued) || 0,
            alreadyPosted: (data.alreadyPosted ?? []) as HasilAntre["alreadyPosted"],
            skipped: (data.skipped ?? []) as HasilAntre["skipped"],
        });
        setRencana(null);
        setLangkah("antre");
        muatAntrean(); onBerubah();
    }

    const langkahKe = langkah === "validasi" ? 1 : langkah === "calon" ? 2 : 3;
    const aksiKepala = batch && langkah !== "antre" && (
        <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={Boolean(kunciHapus)} disabledReason={kunciHapus} onClick={() => onHapus(batch)}>Hapus batch…</Button>
    );
    const statusKepala = batch && (batch.validatedAt
        ? <StatusBadge tone={batch.reviewCount > 0 ? "warn" : "pos"}>{batch.okCount} cocok · {batch.reviewCount} ditinjau</StatusBadge>
        : <StatusBadge tone="neu">Belum divalidasi</StatusBadge>);
    const kepala = <Kepala langkah={langkahKe} batch={batch} status={statusKepala} aksi={aksiKepala} draf={draf ? "Calon faktur belum diantrekan" : undefined} />;
    const pesanAtas = (
        <>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.title} onClose={tutupPesan}>{pesan.body}</MessageStrip>}
            {strip && <MessageStrip tone={strip.tone} title={strip.title} onClose={() => setStrip(null)}>{strip.body}</MessageStrip>}
        </>
    );

    if (!batch) {
        return (
            <div className="fi-page">
                {kepala}
                {isi.status === "galat"
                    ? <><ErrorState title="Batch belum berhasil dimuat" message={isi.error} onRetry={muatIsi} /><div><Link href="/principal-order" className="fi-btn fi-btn--tertiary"><ArrowLeft className="fi-icon" aria-hidden />Kembali ke unggah</Link></div></>
                    : <Skeleton rows={6} label="Memuat batch" />}
            </div>
        );
    }

    // ── Langkah 2 · Validasi ────────────────────────────────────────────────────────────────────────────
    const kolomBaris: Column<Line>[] = [
        { key: "so", header: "SO · produk", cell: (l) => <><b className="fi-mono">{l.soNo}</b><span className="fi-codes">{l.productCode} · {l.productName}</span></> },
        { key: "outlet", header: "Outlet", secondary: true, cell: (l) => <><span className="fi-mono">{l.customerCode}</span> {l.customerName}</> },
        { key: "qty", header: "Qty faktur", align: "end", cell: (l) => <span className="fi-tnum">{angka(l.qty)} {l.unit}<span className="fi-codes">lap. {angka(l.reportQty)}</span></span> },
        { key: "harga", header: "Harga laporan", align: "end", cell: (l) => <span className="fi-tnum">{angka(l.price)}</span> },
        { key: "akurat", header: "Harga Accurate", align: "end", cell: (l) => <span className="fi-tnum">{l.expectedPrice == null ? "—" : angka(l.expectedPrice)}</span> },
        {
            key: "selisih", header: "Selisih", align: "end", cell: (l) => {
                const s = selisihOf(l);
                return s == null ? "—" : <span className={`fi-tnum${Math.abs(s) > 1 ? " fi-why" : ""}`}>{s > 0 ? "+" : ""}{angka(s)}</span>;
            },
        },
        {
            key: "diskon", header: "Diskon", secondary: true, cell: (l) => (
                <>
                    {l.bonus && <span className="fi-tag" data-tone="pos">Bonus </span>}
                    {l.discounts.map((d) => (
                        <span key={d.position} className="fi-tag" data-tone={d.position <= 3 ? "neu" : d.position <= 5 ? "info" : "neg"}
                            title={d.reportPosition ? `Dilaporkan principal di DISC_${d.reportPosition}; dipindah ke posisi ${d.position} sesuai tarif outlet (tanggungan distributor).` : undefined}>
                            D{d.position} {d.amount !== undefined ? rupiah(d.amount) : `${d.percent}%`}{d.reportPosition ? ` (lap. D${d.reportPosition})` : ""}{" "}
                        </span>
                    ))}
                    {!l.discounts.length && !l.bonus && "—"}
                </>
            ),
        },
        { key: "bruto", header: "Bruto", align: "end", secondary: true, cell: (l) => <span className="fi-tnum">{angka(l.reportGross)}</span> },
        {
            key: "hasil", header: "Hasil validasi", cell: (l) => l.status === "review"
                ? <ul className="fi-small" style={{ maxWidth: "28rem", paddingLeft: "1rem", listStyle: "disc" }}>{l.findings.map((f) => <li key={f}>{f}</li>)}</ul>
                : <BadgeBaris line={l} />,
        },
    ];

    const halamanValidasi = (
        <>
            {sibuk && sibuk !== "cabut" && (
                <MessageStrip tone="info" title={sibuk === "harga" ? "Menyegarkan harga Accurate lalu memvalidasi…" : "Validasi berjalan…"}>
                    Mapping, harga Accurate per pelanggan dan cabang, aturan promo per tanggal SO, dan order ganda terhadap batch lain diperiksa ulang.
                </MessageStrip>
            )}
            {hasilValidasi && (
                <MessageStrip tone={hasilValidasi.reviewCount > 0 ? "warn" : "pos"} title={`${hasilValidasi.okCount} baris cocok, ${hasilValidasi.reviewCount} perlu ditinjau.`} onClose={() => setHasilValidasi(null)}>
                    {hasilValidasi.harga && (hasilValidasi.harga.ok
                        ? `Harga disegarkan: ${hasilValidasi.harga.processed ?? 0} barang, ${hasilValidasi.harga.priceRows ?? 0} baris harga.`
                        // Harga lama tetap dipakai dan barisnya tetap tertahan; jangan diam-diam.
                        : `Harga gagal disegarkan (${hasilValidasi.harga.error ?? "tidak diketahui"}); harga lama tetap dipakai.`)}
                </MessageStrip>
            )}
            {hasilValidasi?.peringatan.map((p) => <MessageStrip key={p} tone="warn" title="Perlu dikerjakan:">{p}</MessageStrip>)}
            {antreRows.length > 0 && (
                <MessageStrip tone="info" title={`${antreRows.length} SO batch ini sudah di Antrean Faktur.`}>
                    Validasi ulang masih boleh; SO yang sudah antre dilewati saat diantrekan lagi. Hapus dan ganti batch dikunci.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => setLangkah("antre")}>Lihat status antrean</button>
                </MessageStrip>
            )}
            <div className={sibuk && sibuk !== "cabut" ? "fi-busy" : undefined} style={{ display: "grid", gap: 16 }}>
                <div className="fi-kcards" aria-label="Ringkasan validasi" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
                    <div className="fi-kc"><span>Baris</span><b>{angka(batch.lineCount)}</b><small>{soDiBatch.size} SO di batch</small></div>
                    <div className="fi-kc" data-tone={batch.validatedAt ? "pos" : undefined}><span>Cocok</span><b>{batch.validatedAt ? angka(batch.okCount) : "—"}</b><small>{batch.validatedAt ? `divalidasi ${waktuWita(batch.validatedAt)}` : "belum divalidasi"}</small></div>
                    <div className="fi-kc" data-tone={batch.reviewCount > 0 ? "warn" : undefined}><span>Ditinjau</span><b>{batch.validatedAt ? angka(batch.reviewCount) : "—"}</b><small>{soReview} SO tidak ikut jadi faktur{dupes.size ? ` · ${dupes.size} order ganda` : ""}</small></div>
                    <div className="fi-kc" data-tone={batch.skipped > 0 ? "warn" : undefined}><span>Dilewati</span><b>{angka(batch.skipped)}</b><small>baris saat dibaca{held.length ? ` · ${held.length} SO ditahan utuh` : ""}</small></div>
                </div>

                {held.length > 0 && (
                    <Section title="Ditahan utuh: produk belum termapping" subtitle="tidak masuk batch, tidak jadi faktur">
                        <div className="fi-sect-in">
                            <ul className="fi-chkl" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                                {held.map((h) => (
                                    <li key={h.so} data-ok="false">
                                        <TriangleAlert className="fi-icon" aria-hidden />
                                        <span><b className="fi-mono">SO {h.so}</b> · kode produk <span className="fi-mono">{h.kode || "—"}</span>{" "}
                                            <Link href="/principal-mapping"><Plug className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> Mapping Principal</Link>
                                            <span className="fi-codes" style={{ fontFamily: "inherit" }}>{h.teks}</span></span>
                                    </li>
                                ))}
                            </ul>
                            <p className="fi-small fi-subtle">Setelah mapping ditambah, unggah ulang berkas ini dan pilih Ganti batch lama. Itu hanya bisa selama belum ada SO batch ini di Antrean Faktur.</p>
                            <VariantNote bl="BL-44">SO yang tertahan hanya bisa dilepas lewat Ganti batch lama, dan begitu ada SO batch ini di antrean tidak ada jalan lain di layar. Usulan: tombol Tambahkan SO yang tertahan — hanya SO yang belum ada di batch ditambahkan lalu divalidasi; SO yang sudah antre tidak disentuh.</VariantNote>
                        </div>
                    </Section>
                )}

                {(dupes.size > 0 || acksDiBatch.length > 0 || acks.status === "galat") && (
                    <Section title="Gerbang order ganda" subtitle={`kemiripan ≥ 0,5 dengan SO lain ${batch.principal}`}>
                        <div className="fi-sect-in">
                            {[...dupes].map(([soNo, finding]) => (
                                <div key={soNo} className="fi-panel" style={{ boxShadow: "none", border: "1px solid var(--line)" }}>
                                    <b className="fi-mono">SO {soNo}</b>
                                    <p className="fi-small">{finding}</p>
                                    <div className="fi-btnrow">
                                        <Button icon={<ShieldCheck className="fi-icon" aria-hidden />} disabled={Boolean(kunciAck)} disabledReason={kunciAck}
                                            title="Catat bahwa SO ini sudah diperiksa manusia dan BUKAN order ganda, lalu validasi ulang batch ini"
                                            onClick={() => setDialog({ jenis: "ganda", soNo, finding })}>Bukan order ganda…</Button>
                                    </div>
                                </div>
                            ))}
                            {acks.status === "galat" && (
                                <MessageStrip tone="neg" title="Konfirmasi yang tercatat belum terbaca.">
                                    {acks.error}{" "}<button type="button" className="fi-btn fi-btn--tertiary" onClick={muatAcks}>Coba lagi</button>
                                </MessageStrip>
                            )}
                            {acksDiBatch.length > 0 && (
                                <ul className="fi-hist" aria-label="Konfirmasi bukan order ganda yang tercatat">
                                    {acksDiBatch.map((ack) => (
                                        <li key={ack.soNo}>
                                            <time>{waktuWita(ack.confirmedAt)}</time>
                                            <span><b className="fi-mono">SO {ack.soNo}</b> dikonfirmasi {ack.confirmedBy || "—"}{ack.note ? ` · ${ack.note}` : ""}{" "}
                                                <Button variant="tertiary" icon={<ShieldOff className="fi-icon" aria-hidden />} busy={sibuk === "cabut"} disabled={Boolean(kunciAck)} disabledReason={kunciAck}
                                                    aria-label={`Cabut konfirmasi SO ${ack.soNo}`} onClick={() => void cabut(ack.soNo)}>Cabut</Button>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <p className="fi-small fi-subtle">
                                Konfirmasi BERTAHAN: batch boleh divalidasi ulang berapa kali pun tanpa harus mengonfirmasi lagi. Yang tercatat bukan hanya
                                siapa menekan tombol, melainkan alasan yang sedang menahan SO itu saat ditekan. Mencabut mengembalikan penahanannya.
                            </p>
                        </div>
                    </Section>
                )}

                <Section title={tinjauSaja ? "Perlu ditinjau" : "Semua baris"} subtitle="SO yang punya satu saja baris ditinjau tidak ikut jadi faktur">
                    <ResponsiveTable<Line> title={tinjauSaja ? "Baris perlu ditinjau" : "Baris batch"} count={tampil.length} columns={kolomBaris} rows={tampil}
                        rowKey={(l) => String(l.rowNumber)} status={isi.status} error={isi.error} onRetry={muatIsi}
                        actions={
                            <div className="fi-segs" role="group" aria-label="Baris yang ditampilkan">
                                <button type="button" aria-pressed={tinjauSaja} onClick={() => setHanyaTinjau(true)}>Perlu ditinjau ({nReview})</button>
                                <button type="button" aria-pressed={!tinjauSaja} onClick={() => setHanyaTinjau(false)}>Semua baris ({lines.length})</button>
                            </div>
                        }
                        empty={!lines.length ? { title: "Batch ini tidak punya baris" }
                            : batch.validatedAt ? { title: "Tidak ada baris yang perlu ditinjau", message: `Semua ${lines.length} baris cocok.` }
                                : { title: "Batch belum divalidasi", message: "Tekan Validasi untuk memeriksa mapping, harga, promo, dan order ganda." }}
                        mobileItem={(l) => {
                            const s = selisihOf(l);
                            return <ListItem doc={l.soNo} amount={s != null && Math.abs(s) > 1 ? `selisih ${angka(s)}` : undefined} title={`${l.productCode} · ${l.productName}`}
                                meta={`${angka(l.qty)} ${l.unit} · laporan ${angka(l.price)}${l.expectedPrice != null ? ` · Accurate ${angka(l.expectedPrice)}` : ""}${l.findings.length ? ` · ${l.findings.join(" ")}` : ""}`}
                                badge={<BadgeBaris line={l} />} />;
                        }} />
                    <div className="fi-sect-in">
                        <p className="fi-small fi-subtle">
                            Harga Accurate dicari per pelanggan dan cabang pelanggan dengan tanggal awal periode batch ({tanggalSo(String(batch.period).slice(0, 10)) || "tanggal hari ini bila periode tidak terbaca"}).
                            Selisih harga sampai Rp 1 dianggap pembulatan; di atas itu baris ditahan, baik lebih tinggi maupun lebih rendah. Posisi diskon
                            menentukan siapa menanggung: D1–D3 distributor, D4–D5 klaim principal, D6–D8 tidak punya pemilik dan wajib ditinjau.
                        </p>
                        <VariantNote bl="BL-45">Berkas yang memuat lebih dari satu tanggal SO dinilai dengan harga per tanggal awal periode. Usulan: Harga Accurate dicari per tanggal SO dan kolomnya menyebut tanggal berlakunya.</VariantNote>
                        {lain.length > 0 && (
                            <details>
                                <summary className="fi-small">{lain.length} temuan saat berkas dibaca (baris dilewati)</summary>
                                <ul className="fi-small" style={{ paddingLeft: "1rem", listStyle: "disc" }}>{lain.slice(0, 50).map((t) => <li key={t}>{t}</li>)}</ul>
                                {lain.length > 50 && <p className="fi-small fi-subtle">… dan {lain.length - 50} temuan lain</p>}
                            </details>
                        )}
                    </div>
                </Section>
            </div>
            <FooterToolbar message={kunciLanjut ?? `${batch.okCount} baris cocok · ${soReview} SO tidak ikut`}>
                <Link href="/principal-order" className="fi-btn fi-btn--tertiary"><ArrowLeft className="fi-icon" aria-hidden />Unggah</Link>
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={sibuk === "harga"} disabled={Boolean(kunciValidasi)} disabledReason={kunciValidasi}
                    title="Tarik ulang daftar harga Accurate untuk barang pada batch ini, lalu validasi. Pakai setelah harga diperbaiki di Accurate."
                    onClick={() => void validasi(true)}>Segarkan harga</Button>
                <Button variant={batch.validatedAt ? "secondary" : "primary"} icon={<ShieldCheck className="fi-icon" aria-hidden />} busy={sibuk === "validasi"}
                    disabled={Boolean(kunciValidasi)} disabledReason={kunciValidasi} onClick={() => void validasi()}>{batch.validatedAt ? "Validasi ulang" : "Validasi"}</Button>
                {batch.validatedAt && (
                    <Button variant="primary" icon={<ArrowRight className="fi-icon" aria-hidden />} disabled={Boolean(kunciLanjut)} disabledReason={kunciLanjut}
                        title="Siapkan faktur dari SO yang seluruh barisnya lolos" onClick={() => void siapkan()}>Lanjut ke calon faktur</Button>
                )}
            </FooterToolbar>
        </>
    );

    // ── Langkah 3 · Calon faktur ────────────────────────────────────────────────────────────────────────
    const siap = rencana?.ready ?? [];
    const netto = siap.reduce((a, c) => a + Number(c.net || 0), 0);
    const tanpaSales = siap.filter((c) => !c.salesmanId);
    const dibuang = siap.filter((c) => c.pernahDibuang);
    const kolomCalon: Column<CalonFaktur>[] = [
        { key: "so", header: "SO", cell: (c) => <><b className="fi-mono">{c.soNo}</b>{c.pernahDibuang && <span className="fi-codes">pernah dibuang — dicari dulu di Accurate saat diantrekan</span>}</> },
        { key: "cust", header: "Pelanggan", cell: (c) => <span className="fi-mono">{c.customerNo}</span> },
        { key: "cabang", header: "Cabang", secondary: true, cell: (c) => c.branch },
        // Pratinjau harus menyebut sales yang TIDAK ketemu, bukan diam: itulah faktur yang nanti terbit tanpa sales.
        { key: "sales", header: "Sales", cell: (c) => (c.salesmanId ? <span className="fi-mono">{c.salesman}</span> : <StatusBadge tone="warn">{c.salesman || "kosong"} · tanpa sales</StatusBadge>) },
        { key: "tgl", header: "Tanggal", cell: (c) => tanggalSo(c.orderDate) },
        { key: "baris", header: "Baris", align: "end", secondary: true, cell: (c) => <span className="fi-tnum">{c.lineCount}</span> },
        { key: "bruto", header: "Bruto", align: "end", secondary: true, cell: (c) => <span className="fi-tnum">{rupiah(c.gross)}</span> },
        { key: "netto", header: "Netto", align: "end", cell: (c) => <span className="fi-tnum">{rupiah(c.net)}</span> },
    ];
    const tidakIkut = rencana?.skipped ?? [];
    const halamanCalon = (
        <>
            {menyiapkan && <Skeleton rows={5} label="Menyiapkan calon faktur" />}
            {galatRencana && <MessageStrip tone="neg" title="Calon faktur belum bisa disiapkan.">{galatRencana}</MessageStrip>}
            {rencanaBasi && <MessageStrip tone="warn" title="Hasil antre sebelumnya belum pasti.">{PESAN_TIDAK_PASTI} Siapkan ulang calon faktur: SO yang ternyata sudah antre akan tercatat di Tidak ikut.</MessageStrip>}
            {!menyiapkan && !rencana && !galatRencana && (
                <EmptyState title="Calon faktur belum disiapkan" message="Siapkan dari SO yang seluruh barisnya lolos validasi; belum ada yang ditulis ke antrean." />
            )}
            {!menyiapkan && rencana && (
                <>
                    {tanpaSales.length > 0 && (
                        <MessageStrip tone="warn" title={`${tanpaSales.length} faktur akan terbit TANPA sales`}>
                            — kodenya belum termapping, atau pegawainya tidak ada/nonaktif di Accurate. Lihat kolom Sales; lengkapi mapping salesman bila faktur ini perlu sales.
                        </MessageStrip>
                    )}
                    <Section title={`${siap.length} calon faktur`} subtitle={`1 SO = 1 faktur · tanggal faktur = tanggal SO · netto ${rupiah(netto)}`}>
                        <ResponsiveTable<CalonFaktur> title="Calon faktur" count={siap.length} columns={kolomCalon} rows={siap} rowKey={(c) => c.key}
                            empty={{ title: "Tidak ada SO yang siap jadi faktur", message: "Semua SO tertahan; lihat Tidak ikut di bawah." }}
                            mobileItem={(c) => <ListItem doc={c.soNo} amount={rupiah(c.net)} title={`${c.customerNo} · ${c.branch} · ${c.lineCount} baris`} meta={tanggalSo(c.orderDate)}
                                badge={c.salesmanId ? undefined : <StatusBadge tone="warn">Tanpa sales</StatusBadge>} />} />
                        <div className="fi-sect-in">
                            <VariantNote bl="BL-23">Limit kredit dan stok cabang belum diperiksa sebelum antre; penolakannya baru ketahuan saat Kirim di Antrean Faktur. Usulan: peringatan limit kredit dan stok (cache Accurate) di tabel ini, tidak memblokir.</VariantNote>
                        </div>
                    </Section>
                </>
            )}
            {!menyiapkan && rencana && (
                <Section title="Tidak ikut" subtitle={`${tidakIkut.length} SO`}>
                    <div className="fi-sect-in">
                        {tidakIkut.length
                            ? <ul className="fi-chkl" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>{tidakIkut.map((s) => <li key={`${s.soNo}-${s.reason}`} data-ok="false"><TriangleAlert className="fi-icon" aria-hidden /><span><b className="fi-mono">{s.soNo}</b> — {s.reason}</span></li>)}</ul>
                            : <p className="fi-small fi-subtle">Semua SO yang lolos validasi ikut jadi calon faktur.</p>}
                        {held.length > 0 && <p className="fi-small fi-subtle">Ditambah {held.length} SO yang ditahan utuh dan tidak tersimpan di batch.</p>}
                    </div>
                </Section>
            )}
            <FooterToolbar message={kunciAntre ?? <span className="fi-sum"><b>{siap.length} faktur</b> · netto {rupiah(netto)}{tanpaSales.length ? ` · ${tanpaSales.length} tanpa sales` : ""}</span>}>
                <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} onClick={() => setLangkah("validasi")}>Kembali ke validasi</Button>
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={menyiapkan} disabled={Boolean(kunciLanjut)} disabledReason={kunciLanjut} onClick={() => void siapkan()}>
                    {rencana || galatRencana ? "Siapkan ulang" : "Siapkan calon faktur"}
                </Button>
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(kunciAntre)} disabledReason={kunciAntre} onClick={() => setDialog({ jenis: "antre" })}>
                    Antrekan {siap.length} faktur…
                </Button>
            </FooterToolbar>
        </>
    );

    // ── Langkah 4 · Diantrekan ──────────────────────────────────────────────────────────────────────────
    const terkirim = antreRows.filter((r) => r.state === "posted").length;
    const kolomAntre: Column<BarisAntrean>[] = [
        { key: "so", header: "SO", cell: (r) => <b className="fi-mono">{soDariKunci(r.orderId)}</b> },
        { key: "status", header: "Status", cell: (r) => { const s = labelAntrean(r.state); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
        { key: "nomor", header: "Nomor faktur", cell: (r) => (r.number ? <span className="fi-mono">{r.number}</span> : "—") },
        { key: "galat", header: "Catatan", secondary: true, cell: (r) => <span className="fi-small">{r.error || "—"}</span> },
    ];
    const halamanAntre = (
        <>
            {hasilAntre && (
                <MessageStrip tone={hasilAntre.queued > 0 ? "pos" : "info"} title={`${hasilAntre.queued} faktur masuk Antrean Faktur.`}>
                    Faktur dibuat saat Fakturist menekan Kirim di Antrean Faktur; sebelum itu barisnya bisa dibuang di sana.{" "}
                    <Link href="/antrean-faktur">Buka Antrean Faktur</Link>
                </MessageStrip>
            )}
            {hasilAntre && hasilAntre.alreadyPosted.length > 0 && (
                <MessageStrip tone="info" title={`${hasilAntre.alreadyPosted.length} SO ternyata sudah punya faktur di Accurate.`}>
                    Ditandai terposting, tidak dikirim lagi: {hasilAntre.alreadyPosted.map((p) => p.number || soDariKunci(p.orderId)).join(", ")}.
                </MessageStrip>
            )}
            <Section title="Batch ini">
                <div className="fi-sect-in">
                    <KeyValues items={[
                        ["Lolos validasi", `${antrean.data?.candidates ?? "—"} SO bisa jadi faktur`],
                        ["Di Antrean Faktur", antrean.status === "galat" && !antrean.data ? "belum terbaca" : `${antreRows.length} SO · ${terkirim} sudah terposting`],
                        ...(hasilAntre ? [["Tidak ikut saat diantrekan", hasilAntre.skipped.length ? hasilAntre.skipped.map((s) => `${s.soNo} — ${s.reason}`).join("; ") : "tidak ada"] as [string, ReactNode]] : []),
                        ["Ditahan utuh", held.length ? `${held.length} SO, tidak tersimpan di batch` : "tidak ada"],
                        ["Validasi ulang", "Masih boleh; SO yang sudah antre dilewati saat diantrekan lagi"],
                    ]} />
                </div>
            </Section>
            <ResponsiveTable<BarisAntrean> title="Status antrean batch ini" count={antreRows.length} columns={kolomAntre} rows={antreRows} rowKey={(r) => r.orderId}
                status={antrean.status} error={antrean.error} onRetry={muatAntrean}
                actions={<Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatAntrean}>Muat ulang</Button>}
                empty={{ title: "Belum ada SO batch ini di Antrean Faktur", message: "Siapkan calon faktur lalu antrekan." }}
                mobileItem={(r) => { const s = labelAntrean(r.state); return <ListItem doc={soDariKunci(r.orderId)} title={r.number || "belum ada nomor faktur"} meta={r.error || undefined} badge={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>} />; }} />
            <Section title="Alur dokumen">
                <div className="fi-dflow" role="list" aria-label="Alur dokumen">
                    <span role="listitem" className="fi-dnode"><b className="fi-mono">{batch.fileName}</b><span>Berkas · {batch.skipped} baris dilewati</span></span>
                    <ArrowRight className="fi-icon" aria-hidden />
                    <span role="listitem" className="fi-dnode"><b>Batch {waktuWita(batch.uploadedAt).slice(0, 10)}</b><span>{soDiBatch.size} SO · {batch.lineCount} baris</span></span>
                    <ArrowRight className="fi-icon" aria-hidden />
                    <Link role="listitem" className="fi-dnode" href="/antrean-faktur" data-off={antreRows.length === 0}><b>Antrean Faktur</b><span>{antreRows.length} SO antre</span></Link>
                    <ArrowRight className="fi-icon" aria-hidden />
                    <span role="listitem" className="fi-dnode" data-off={terkirim === 0}><b>Faktur</b><span>{terkirim} terbit</span></span>
                </div>
                <div className="fi-sect-in">
                    <VariantNote bl="BL-35">Alur dibangun dari status antrean batch ini saja. Usulan: tiap simpul menaut ke dokumennya (faktur di Faktur Penjualan) dan bisa ditelusuri balik dari faktur ke batch.</VariantNote>
                </div>
            </Section>
            <FooterToolbar message={kunciHapus}>
                <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={Boolean(kunciHapus)} disabledReason={kunciHapus} onClick={() => onHapus(batch)}>Hapus batch…</Button>
                <Button icon={<ArrowLeft className="fi-icon" aria-hidden />} onClick={() => setLangkah("validasi")}>Kembali ke validasi</Button>
                <Link href="/antrean-faktur" className="fi-btn fi-btn--primary"><Receipt className="fi-icon" aria-hidden />Buka Antrean Faktur</Link>
            </FooterToolbar>
        </>
    );

    const ganda = dialog?.jenis === "ganda" ? dialog : null;
    const barisGanda = ganda ? lines.filter((l) => l.soNo === ganda.soNo) : [];
    const menungguAuto = pilihan === null && antrean.status === "memuat" && !antrean.data;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            {kepala}
            {pesanAtas}
            {menungguAuto ? <Skeleton rows={6} label="Memuat status antrean batch" /> : langkah === "validasi" ? halamanValidasi : langkah === "calon" ? halamanCalon : halamanAntre}

            <ConfirmDialog open={Boolean(ganda)} onClose={() => setDialog(null)} title={`SO ${ganda?.soNo ?? ""} bukan order ganda?`} tag="Order ganda"
                confirmLabel="Bukan order ganda" confirmDisabled={kunciAck}
                description="Tercatat per principal dan nomor SO, berlaku juga bila berkas diunggah ulang, dan bisa dicabut. Batch divalidasi ulang sesudahnya."
                facts={ganda ? [
                    ["SO ini", `${barisGanda[0]?.customerName ?? ""} · ${tanggalSo(barisGanda[0]?.soDate) || "tanggal tidak terbaca"} · ${barisGanda.length} baris`],
                    ["Temuan yang menahan", ganda.finding],
                ] : []}
                reason={{ label: "Catatan konfirmasi", placeholder: "mis. sudah dicek ke sales, dua order ini memang berbeda" }}
                onConfirm={(note) => (ganda ? konfirmasiGanda(ganda.soNo, ganda.finding, note) : undefined)} />

            <ConfirmDialog open={dialog?.jenis === "antre"} onClose={() => setDialog(null)} title={`Antrekan ${siap.length} faktur dari batch ${batch.fileName}?`} tag="Order Principal"
                confirmLabel={`Antrekan ${siap.length} faktur`} confirmDisabled={kunciAntre}
                description="Faktur belum dibuat. Fakturist mengirim dari Antrean Faktur; di sana database tujuan dan nilainya disebut lagi."
                facts={[
                    ["Principal", `${batch.principal}${batch.branch ? ` · ${batch.branch}` : ""}`],
                    ["Faktur", `${siap.length} SO = ${siap.length} faktur · tanggal faktur = tanggal SO masing-masing`],
                    ["Nilai", <>Netto {rupiah(netto)} + PPN 11% ≈ <b>{rupiah(Math.round(netto * 1.11))}</b> (estimasi; angka akhir dihitung Accurate)</>],
                    ["Tanpa sales", tanpaSales.length ? `${tanpaSales.length} faktur (${tanpaSales.map((c) => c.soNo).join(", ")})` : "tidak ada"],
                    ...(dibuang.length ? [["Pernah dibuang", `${dibuang.length} SO dicari dulu di Accurate; bila fakturnya sudah ada, ditandai terposting tanpa dikirim`] as [string, ReactNode]] : []),
                    ["Tidak ikut", tidakIkut.length ? `${tidakIkut.length} SO (lihat daftar Tidak ikut)` : "tidak ada"],
                ]}
                onConfirm={antrekan} />
        </div>
    );
}
