/*
 * Tujuan: Pantau Pengajuan Promo (owner 3 Nov 2026): salesman melihat lewat ponsel progres pengajuan OPC principal yang ia tangani — tahap
 *   (alur 7 tahap), sudah dibayar sebagian/lunas, toko dan programnya, serta bukti bayar (PDF di tab baru). Baca saja, tanpa aksi tulis.
 * Caller: app/(dashboard)/off-program-control/pantau/page.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/opc-ui (ALUR_TAHAP, periodeBatch, tanggalOpc), lib/off-program-control/helpers
 *   (formatPeriodForPrint), lib/promo-ui (rupiah), lib/tampil.
 * Main Functions: Pantau, KartuPengajuan, Pembayaran, DaftarItem.
 * Side Effects: GET /api/off-program-control/pantau (saat dibuka dan "Muat ulang"). Tidak menulis apa pun.
 */
"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, Flow, KeyValues, ListItem, MessageStrip, Skeleton, StatusBadge, type FlowStep, type Tone } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { formatPeriodForPrint } from "@/lib/off-program-control/helpers";
import { ALUR_TAHAP, periodeBatch, tanggalOpc } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG, sebabHttp, tanggalWita } from "@/lib/tampil";

// Bentuk respons GET /api/off-program-control/pantau.
type ItemPantau = {
    no: number; noSurat: string | null; namaProgram: string; periode: string | null; toko: string | null; nominal: number; caraBayar: string;
    beban: "CL" | "DM"; dibayar: boolean; dibayarPada: string | null; pembayaranKe: number | null;
};
type BayarPantau = { no: number; tanggal: string; cara: string; jumlah: number; buktiUrl: string | null };
type PengajuanPantau = {
    noPengajuan: string; principleCode: string; principleName: string; bulan: string; tahun: string; supervisorName: string;
    diajukanPada: string | null; diperbaruiPada: string | null;
    tahap: { kunci: string; label: string; tone: Tone; pemilik: string | null; posisi: number };
    alur: FlowStep[]; total: number; totalDibayar: number; items: ItemPantau[]; payments: BayarPantau[];
};
type Cakupan = { semua: boolean; principal: Array<{ code: string; nama: string }>; takDikenal: string[]; alasan: string | null };
type DataPantau = { cakupan: Cakupan; batas: number; batches: PengajuanPantau[] };

const POTONG = "Potong Tagihan";

async function muat(): Promise<Load<DataPantau>> {
    const umum = "Daftar pengajuan belum berhasil dimuat.";
    try {
        const res = await fetch("/api/off-program-control/pantau", { credentials: "include", cache: "no-store" });
        const data = (await res.json().catch(() => null)) as (DataPantau & { ok?: boolean; error?: string }) | null;
        if (res.ok && data?.ok) return { status: "siap", data };
        if (res.status === 403) return { status: "galat", error: `${umum} Akun Anda belum punya izin Pantau Pengajuan; minta admin menambahkannya ke grup akses.` };
        return { status: "galat", error: `${umum} ${sebabHttp(res.status)}` };
    } catch {
        return { status: "galat", error: `${umum} ${sebabHttp(0)}` };
    }
}

const kecil = (s: string | null | undefined) => String(s ?? "").toLowerCase();

export default function Pantau() {
    const [load, muatUlang] = useLoad(muat);
    const [cari, setCari] = useState("");
    const [principal, setPrincipal] = useState("");
    const data = load.data;
    const kunci = cari.trim().toLowerCase();

    const opsi = useMemo(() => {
        const m = new Map<string, string>();
        for (const b of data?.batches ?? []) m.set(b.principleCode, b.principleName);
        return [...m].sort((x, y) => x[1].localeCompare(y[1], "id"));
    }, [data]);
    const tampil = useMemo(() => (data?.batches ?? []).filter((b) => (!principal || b.principleCode === principal)
        && (!kunci || kecil(b.noPengajuan).includes(kunci) || b.items.some((i) => kecil(i.toko).includes(kunci)))), [data, principal, kunci]);
    const reset = () => { setCari(""); setPrincipal(""); };
    const chips = [
        ...(kunci ? [{ label: `Cari: ${cari.trim()}`, onRemove: () => setCari("") }] : []),
        ...(principal ? [{ label: opsi.find(([c]) => c === principal)?.[1] ?? principal, onRemove: () => setPrincipal("") }] : []),
    ];

    let isi;
    if (!data) {
        isi = load.status === "galat"
            ? <div className="fi-panel"><ErrorState title="Daftar pengajuan gagal dimuat" message={load.error} onRetry={muatUlang} /></div>
            : <div className="fi-panel"><Skeleton rows={6} label="Memuat pengajuan" /></div>;
    } else {
        const { cakupan, batches, batas } = data;
        isi = (
            <>
                {load.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang.">{load.error} Yang tampil adalah hasil sebelumnya.</MessageStrip>}
                {!cakupan.alasan && (
                    <p className="fi-small">
                        {cakupan.semua ? "Anda admin, jadi pengajuan semua principal ditampilkan."
                            : `Principal Anda: ${cakupan.principal.map((p) => p.nama).join(", ")}. Diambil dari profil sales dan JKS Anda.`}
                    </p>
                )}
                {cakupan.takDikenal.length > 0 && (
                    <MessageStrip tone="warn" title="Sebagian principal belum dikenal sistem:">
                        {cakupan.takDikenal.join(", ")}. Pengajuan untuk principal ini belum bisa ditampilkan. Minta admin menambahkan ejaan ini sebagai
                        alias di Data Principal.
                    </MessageStrip>
                )}
                {cakupan.alasan ? (
                    <div className="fi-panel"><EmptyState title="Belum ada principal untuk Anda" message={cakupan.alasan} /></div>
                ) : batches.length === 0 ? (
                    <div className="fi-panel"><EmptyState title="Belum ada pengajuan" message="Belum ada pengajuan promo yang sudah diajukan untuk principal Anda." /></div>
                ) : (
                    <>
                        <FilterBar title="Pengajuan" activeCount={chips.length} chips={chips} onReset={reset}
                            search={<FormField label="Cari No pengajuan atau toko">{(a) => (
                                <input {...a} className="fi-input" type="search" value={cari} placeholder="Contoh: 001/PA/11/2026 atau TOKO A" onChange={(e) => setCari(e.target.value)} />
                            )}</FormField>}
                            fields={<FormField label="Principal">{(a) => (
                                <select {...a} className="fi-input" value={principal} onChange={(e) => setPrincipal(e.target.value)}>
                                    <option value="">Semua principal</option>
                                    {opsi.map(([code, nama]) => <option key={code} value={code}>{nama}</option>)}
                                </select>
                            )}</FormField>} />
                        <p className="fi-small fi-subtle" role="status">
                            {tampil.length} dari {batches.length} pengajuan{batches.length >= batas ? `, ${batas} terbaru` : ""}.
                        </p>
                        {tampil.length === 0
                            ? <div className="fi-panel"><EmptyState title="Tidak ada pengajuan yang cocok" message="Ubah kata pencarian atau pilih principal lain."
                                action={<Button onClick={reset}>Hapus saringan</Button>} /></div>
                            : tampil.map((b) => <KartuPengajuan key={b.noPengajuan} b={b} kunci={kunci} />)}
                    </>
                )}
            </>
        );
    }

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman">
                    <ol className="fi-crumb">
                        <li><span>Promo &amp; Klaim</span></li>
                        <li><span aria-current="page">Pantau Pengajuan</span></li>
                    </ol>
                </nav>
                <div className="fi-page-bar">
                    <h1>Pantau Pengajuan Promo</h1>
                    <span className="fi-spacer" />
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && Boolean(data)} onClick={muatUlang}>Muat ulang</Button>
                </div>
                <p>
                    Pengajuan promo untuk principal yang Anda tangani: sudah sampai tahap mana, sudah dibayar atau belum, dan bukti bayarnya.
                    Halaman ini hanya untuk melihat; tidak ada yang bisa diubah dari sini.
                </p>
            </header>
            {isi}
        </div>
    );
}

/** Ringkasan bayar satu pengajuan untuk badge. */
function ringkasBayar(b: PengajuanPantau): { label: string; tone: Tone } {
    if (b.totalDibayar <= 0) return { label: b.tahap.kunci === "dibatalkan" ? "Tidak dibayar" : "Belum dibayar", tone: "neu" };
    if (b.totalDibayar + 0.005 < b.total) return { label: "Dibayar sebagian", tone: "warn" };
    return { label: "Lunas", tone: "pos" };
}

function KartuPengajuan({ b, kunci }: { b: PengajuanPantau; kunci: string }) {
    const batal = b.tahap.kunci === "dibatalkan";
    const selesai = b.tahap.kunci === "selesai";
    const dari = ALUR_TAHAP.length;
    const ke = b.tahap.posisi + 1;
    const teksTahap = batal ? "Pengajuan dibatalkan dan tidak dilanjutkan."
        : selesai ? `Selesai, tahap ${dari} dari ${dari}.` : `Tahap ${ke} dari ${dari}: ${b.tahap.label.toLowerCase()}.`;
    const bayar = ringkasBayar(b);
    const cocokToko = kunci ? b.items.filter((i) => kecil(i.toko).includes(kunci)).length : 0;
    return (
        <article className="fi-panel">
            <div className="fi-btnrow">
                <h2 className="fi-title-3"><span className="fi-mono">{b.noPengajuan}</span></h2>
                <StatusBadge tone={b.tahap.tone} wrap>{b.tahap.label}</StatusBadge>
                {/* Di tahap Bayar label tahap sudah menyebut status bayar ("Dibayar sebagian"); jangan dua lencana sama. */}
                {bayar.label !== b.tahap.label && <StatusBadge tone={bayar.tone} wrap>{bayar.label}</StatusBadge>}
            </div>
            <KeyValues items={[
                ["Principal", b.principleName],
                ["Periode", periodeBatch(b)],
                ["Diajukan", b.diajukanPada ? tanggalWita(b.diajukanPada) : "Sudah diajukan"],
                ["Diajukan oleh", b.supervisorName || KOSONG],
                ["Total pengajuan", rupiah(b.total)],
                ["Sudah dibayar", b.totalDibayar > 0 ? `${rupiah(b.totalDibayar)} dari ${rupiah(b.total)}` : rupiah(0)],
            ]} />
            <div style={{ display: "grid", gap: 4 }}>
                <progress className="fi-progress" max={dari} value={batal ? 0 : ke} aria-label={teksTahap} />
                <span className="fi-small">{teksTahap}</span>
                {!batal && !selesai && b.tahap.pemilik && <span className="fi-small fi-subtle">Sedang diproses: {b.tahap.pemilik}.</span>}
            </div>
            <Flow steps={b.alur} label={`Tahap pengajuan ${b.noPengajuan}`} />
            <Pembayaran b={b} />
            <details className="fi-misi" open={cocokToko > 0}>
                <summary>Toko dan program ({b.items.length} item){cocokToko ? `, ${cocokToko} cocok dengan pencarian` : ""}</summary>
                <DaftarItem items={b.items} />
            </details>
        </article>
    );
}

function Pembayaran({ b }: { b: PengajuanPantau }) {
    if (!b.payments.length) {
        const teks = b.tahap.kunci === "dibatalkan" ? "Tidak ada pembayaran karena pengajuan dibatalkan."
            : b.tahap.posisi < 4 ? "Belum dibayar. Pembayaran dicatat setelah pengajuan disetujui Operational Manager."
            : "Belum ada pembayaran yang tercatat.";
        return <p className="fi-small fi-subtle">{teks}</p>;
    }
    return (
        <div style={{ display: "grid", gap: 4 }}>
            <h3 className="fi-small"><b>Pembayaran</b></h3>
            <ul className="fi-list" style={{ display: "block" }} aria-label={`Pembayaran ${b.noPengajuan}`}>
                {b.payments.map((p) => (
                    <li key={p.no}>
                        <ListItem doc={`Pembayaran ke-${p.no}`} amount={rupiah(p.jumlah)} title={`${tanggalOpc(p.tanggal)} · ${p.cara}`}
                            meta={p.cara === POTONG ? "Tidak ditransfer: nilainya dipotong dari tagihan toko. Nomor fakturnya tertulis di bukti." : undefined}
                            badge={p.buktiUrl
                                ? <a href={p.buktiUrl} target="_blank" rel="noopener noreferrer">Lihat bukti</a>
                                : <span>Bukti belum ada</span>} />
                    </li>
                ))}
            </ul>
        </div>
    );
}

function statusItem(i: ItemPantau) {
    if (!i.dibayar) return <StatusBadge tone="neu">Belum dibayar</StatusBadge>;
    const tgl = i.dibayarPada ? ` ${tanggalWita(i.dibayarPada)}` : "";
    return <StatusBadge tone="pos" wrap>{i.caraBayar === POTONG ? `Dipotong dari tagihan toko${tgl}` : `Dibayar${tgl}`}</StatusBadge>;
}

function DaftarItem({ items }: { items: ItemPantau[] }) {
    if (!items.length) return <p className="fi-small fi-subtle">Pengajuan ini tidak punya item.</p>;
    return (
        <ul className="fi-list" style={{ display: "block" }} aria-label="Toko dan program">
            {items.map((i) => (
                <li key={i.no}>
                    <ListItem doc={i.noSurat || `Item ${i.no}`} amount={rupiah(i.nominal)} title={i.toko || KOSONG}
                        meta={[i.namaProgram, i.periode ? formatPeriodForPrint(i.periode) : "", i.caraBayar, i.beban === "DM" ? "beban distributor" : "",
                            i.pembayaranKe ? `pembayaran ke-${i.pembayaranKe}` : ""].filter(Boolean).join(" · ")}
                        badge={statusItem(i)} />
                </li>
            ))}
        </ul>
    );
}
