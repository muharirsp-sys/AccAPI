/*
 * Tujuan: Faktur Penjualan (Fiori S6d, it06 #16–#21): dua kolom — kiri daftar faktur dari cache (cari nomor/pelanggan, Hanya nomor INV,
 *   halaman), kanan Object Page faktur terpilih (`?id=`). Kepala faktur dari baris cache tampil segera; hanya Barang + Ringkasan menunggu
 *   Accurate. Ponsel satu kolom + Kembali. Halaman ini hanya membaca; faktur dibuat saat Kirim di Antrean Faktur.
 * Caller: app/(dashboard)/faktur/page.tsx (permKeys dari server). Tautan masuk: Order Masuk `?q=<nomor faktur>` (isi awal pencarian),
 *   Realisasi Summary `?invoiceId=&databaseId=` (detail langsung, kepala dari detail).
 * Dependensi: GET /api/faktur (daftar cache), GET /api/faktur/[id] (detail live Accurate, opsional `?databaseId=`); components/fiori/*;
 *   lib/promo-ui (rupiah); form-kontrol/lapangan (ambilJson).
 * Main Functions: FakturPenjualan, ObjekFaktur, baca, sebab.
 * Side Effects: HTTP baca saja; window.history.replaceState untuk `?id=`/`?q=` (Next ikut memperbarui useSearchParams tanpa memuat ulang
 *   rute server). Logic BL-22/35/36 belum ada di server → varian berlabel.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, ChevronLeft, ChevronRight, Send } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, FlexibleColumnLayout, KeyValues, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable,
    Section, Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { salesFaktur, type FakturDetail, type FakturItem } from "@/lib/accurate-invoice";
import { rupiah } from "@/lib/promo-ui";
import { ambilJson, type Jawaban } from "../form-kontrol/lapangan";

type Baris = {
    id: number; number: string | null; transDate: string | null; customerNo: string | null; customerName: string | null;
    totalAmount: number | null; outstanding: number | null; status: string | null; dueDate: string | null; age: number | null;
    lastUpdateAt: string | null; createdAt: string | null;
};
type Daftar = { rows: Baris[]; hasMore: boolean; pageSize: number };
type Pilihan = { id: number; databaseId?: string };
type BarisItem = FakturItem & { urut: number };

const dash = (v: string | null | undefined) => (v && v.trim() ? v.trim() : "—");
const angka = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const jamWita = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" });
const waktuWita = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? `${jamWita.format(d)} WITA` : "—";
};
/** Sama dengan validasi tautan realisasi lama: bilangan bulat positif yang aman. */
const idSah = (v: string | null) => (v && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);
const PESAN_ANTREAN = "Akun Anda tidak berhak membuka Antrean Faktur.";

/** Sales faktur: kepala, atau dari baris bila kepala kosong (faktur Antrean Faktur menyimpan sales per baris). */
function teksSales(d: FakturDetail): string {
    const s = salesFaktur(d);
    return s.sumber === "kepala" ? s.teks : s.sumber === "baris" ? `${s.teks} (per baris; tidak tercatat di kepala faktur)` : "— (tidak tercatat di kepala maupun baris faktur)";
}

/** Kalimat galat baca — tanpa kode status mentah dan tanpa HTML halaman galat proxy. Pesan server (mis. penolakan Accurate) tampil apa adanya. */
function sebab(j: Jawaban, umum: string): string {
    if (j.status === 0) return "Server tidak tersambung. Periksa jaringan, lalu coba lagi.";
    if (j.status === 401) return "Sesi login berakhir; masuk ulang lalu coba lagi.";
    if (j.status === 403) return "Akun Anda tidak berhak melihat faktur penjualan.";
    const pesan = typeof j.data?.error === "string" ? j.data.error.trim() : "";
    if (pesan) return pesan;
    return j.data === null || j.status >= 500 ? "Server tidak memberi jawaban yang terbaca. Coba lagi sebentar lagi." : umum;
}

async function baca<T>(url: string, umum: string, pilih: (data: Record<string, unknown>) => T): Promise<Load<T>> {
    const j = await ambilJson(url);
    if (j.status >= 200 && j.status < 300 && j.data?.ok === true) return { status: "siap", data: pilih(j.data) };
    return { status: "galat", error: sebab(j, umum) };
}

function Status({ value }: { value: string | null | undefined }) {
    const v = value?.trim();
    return v === "Lunas" ? <StatusBadge tone="pos">Lunas</StatusBadge> : <StatusBadge tone="neu">{v || "Status belum terbaca"}</StatusBadge>;
}

/** Faktur dibuat dan dibuang di Antrean Faktur; tanpa izin `order.view` tombolnya nonaktif beralasan. */
function TautanAntrean({ boleh, children = "Antrean Faktur" }: { boleh: boolean; children?: ReactNode }) {
    const ikon = <Send className="fi-icon" aria-hidden />;
    return boleh
        ? <Link className="fi-btn fi-btn--secondary" href="/antrean-faktur">{ikon}{children}</Link>
        : <Button icon={ikon} disabled disabledReason={PESAN_ANTREAN}>{children}</Button>;
}

const KOLOM_BARANG: Column<BarisItem>[] = [
    { key: "itemNo", header: "Kode", cell: (i) => <span className="fi-mono">{dash(i.itemNo)}</span> },
    { key: "itemName", header: "Nama barang", cell: (i) => dash(i.itemName) },
    { key: "quantity", header: "Qty", align: "end", cell: (i) => <span className="fi-tnum">{angka.format(i.quantity)} {i.unit}</span> },
    { key: "unitPrice", header: "Harga", align: "end", cell: (i) => <span className="fi-tnum">{rupiah(i.unitPrice)}</span> },
    { key: "discount", header: "Diskon", align: "end", cell: (i) => <span className="fi-tnum">{i.discount ? rupiah(i.discount) : "—"}</span> },
    { key: "total", header: "Total", align: "end", cell: (i) => <span className="fi-tnum">{rupiah(i.total)}</span> },
];

export default function FakturPenjualan({ permKeys }: { permKeys: string[] }) {
    const bolehAntrean = useMemo(() => new Set(permKeys).has("order.view"), [permKeys]);
    const sp = useSearchParams();
    // Tautan Order Masuk `?q=<nomor faktur>` langsung menyaring daftar, tanpa menunggu debounce.
    const [cari, setCari] = useState(() => sp.get("q") ?? "");
    const [query, setQuery] = useState(() => (sp.get("q") ?? "").trim());
    const [invOnly, setInvOnly] = useState(true);
    const [page, setPage] = useState(1);
    const [klik, setKlik] = useState<Baris | null>(null);

    // Debounce ketikan — tanpa ini tiap huruf memicu ILIKE ke ~179k baris. Halaman kembali ke 1 hanya bila kata kuncinya berubah.
    useEffect(() => {
        const v = cari.trim();
        if (v === query) return;
        const t = setTimeout(() => { setQuery(v); setPage(1); }, 350);
        return () => clearTimeout(t);
    }, [cari, query]);

    const params = new URLSearchParams({ page: String(page) });
    if (query) params.set("q", query);
    if (!invOnly) params.set("all", "1");
    const url = `/api/faktur?${params}`;
    const [daftar, muat] = useLoad(useCallback(() => baca<Daftar>(url, "Gagal memuat daftar faktur.", (d) => ({
        rows: Array.isArray(d.rows) ? (d.rows as Baris[]) : [], hasMore: d.hasMore === true, pageSize: Number(d.pageSize) || 50,
    })), [url]), { pertahankan: true });

    const realisasiId = idSah(sp.get("invoiceId"));
    const databaseId = sp.get("databaseId") ?? "";
    const idUrl = idSah(sp.get("id"));
    const pilihan: Pilihan | null = realisasiId && databaseId ? { id: realisasiId, databaseId } : idUrl ? { id: idUrl } : null;
    const rows = daftar.data?.rows ?? [];
    // Tautan realisasi membawa database-nya sendiri dan server baru memastikan database sesi sama saat detail dibaca; sampai itu, baris
    // cache ber-id sama belum tentu faktur yang sama — kepalanya dari detail.
    const barisCache = pilihan && !pilihan.databaseId ? rows.find((r) => r.id === pilihan.id) ?? (klik?.id === pilihan.id ? klik : null) : null;

    function pindah(id: number | null, baris?: Baris) {
        const p = new URLSearchParams();
        if (query) p.set("q", query);
        if (id) p.set("id", String(id));
        setKlik(baris ?? null);
        const qs = p.toString();
        window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    }

    const memuat = daftar.status === "memuat";
    const awal = (page - 1) * (daftar.data?.pageSize ?? 50);
    const isiDaftar = memuat && rows.length === 0 ? <Skeleton rows={6} label="Memuat daftar faktur" />
        : daftar.status === "galat" && rows.length === 0 ? <ErrorState title="Daftar faktur gagal dimuat" message={`${daftar.error} Ini bukan daftar kosong.`} onRetry={muat} />
        : rows.length === 0 ? (query
            ? <EmptyState title={`Tidak ada faktur yang cocok dengan “${query}”.`}
                message={invOnly ? "Coba kata kunci lain, atau matikan “Hanya nomor INV” untuk memunculkan retur." : "Coba sebagian nomor (mis. KN01412) atau nama pelanggan."} />
            : <EmptyState title="Belum ada faktur di cache." message="Faktur akan muncul otomatis begitu Accurate mengirim webhook atau sync berjalan." />)
        : (
            <ul className={`fi-list${memuat ? " fi-busy" : ""}`} style={{ display: "block" }} aria-label="Faktur">
                {rows.map((r) => (
                    <li key={r.id}>
                        <ListItem doc={dash(r.number)} amount={rupiah(r.totalAmount ?? 0)} title={dash(r.customerName)} meta={dash(r.transDate)}
                            badge={<Status value={r.status} />} current={pilihan?.id === r.id && !pilihan.databaseId} onClick={() => pindah(r.id, r)} />
                    </li>
                ))}
            </ul>
        );

    const kolomDaftar = (
        <>
            <div className="fi-sect-in">
                <FormField label="Cari faktur">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Cari nomor faktur atau nama pelanggan" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>
                {/* Retur (RJN) masuk lewat kanal webhook yang sama dan biasanya bukan yang dicari — bawaan hanya INV, sama dengan server. */}
                <label className="fi-check"><input type="checkbox" checked={invOnly} onChange={(e) => { setInvOnly(e.target.checked); setPage(1); }} />Hanya nomor INV</label>
            </div>
            <div className="flex items-baseline justify-between gap-2 px-4 pb-2">
                <h2 className="fi-title-3">Faktur</h2>
                <span className="fi-small fi-subtle fi-tnum">Halaman {page}{rows.length ? ` · ${awal + 1}–${awal + rows.length}` : ""}{memuat && daftar.data ? " · memperbarui…" : ""}</span>
            </div>
            {isiDaftar}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Button icon={<ChevronLeft className="fi-icon" aria-hidden />} disabled={page === 1 || memuat}
                    disabledReason={page === 1 ? "Sudah di halaman pertama" : "Daftar sedang dimuat"} onClick={() => setPage((p) => Math.max(1, p - 1))}>Sebelumnya</Button>
                <Button disabled={!daftar.data?.hasMore || memuat} disabledReason={memuat ? "Daftar sedang dimuat" : "Tidak ada halaman berikutnya"}
                    onClick={() => setPage((p) => p + 1)}>Berikutnya<ChevronRight className="fi-icon" aria-hidden /></Button>
            </div>
            <div className="fi-sect-in">
                <VariantNote bl="BL-36">Hari ini daftar hanya bisa dicari menurut nomor atau pelanggan dan dibatasi ke nomor INV. Usulan: saringan periode, status (termasuk Dihapus di Accurate), dan asal faktur, tersimpan per pengguna.</VariantNote>
            </div>
        </>
    );

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Penjualan</span></li><li><span aria-current="page">Faktur Penjualan</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Faktur Penjualan</h1>
                    <span className="fi-spacer" />
                    <TautanAntrean boleh={bolehAntrean} />
                </div>
                <p>Daftar dari cache faktur Accurate (sync berkala dan webhook). Barang dan ringkasan diambil langsung dari Accurate saat faktur dibuka. Faktur dibuat saat Kirim di Antrean Faktur; halaman ini hanya membaca.</p>
            </header>
            {daftar.status === "galat" && rows.length > 0 && (
                <MessageStrip tone="neg" title="Gagal memuat ulang daftar faktur.">
                    {daftar.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button>
                </MessageStrip>
            )}
            <FlexibleColumnLayout list={kolomDaftar} detailOpen={Boolean(pilihan)} onBack={() => pindah(null)} listLabel="Daftar faktur" detailLabel="Detail faktur"
                detail={pilihan
                    ? <ObjekFaktur key={`${pilihan.id}:${pilihan.databaseId ?? ""}`} pilihan={pilihan} baris={barisCache} bolehAntrean={bolehAntrean} />
                    : <EmptyState title="Pilih faktur di daftar" message="Barang, ringkasan, dan alur dokumennya tampil di sini; barang diambil langsung dari Accurate." />} />
        </div>
    );
}

/** Object Page satu faktur. Dipasang ulang (key) tiap faktur lain dibuka, jadi detail lama tidak pernah tampil di faktur baru. */
function ObjekFaktur({ pilihan, baris, bolehAntrean }: { pilihan: Pilihan; baris: Baris | null; bolehAntrean: boolean }) {
    const { id, databaseId } = pilihan;
    const [detail, muat] = useLoad(useCallback(() => baca<FakturDetail>(
        `/api/faktur/${id}${databaseId ? `?databaseId=${encodeURIComponent(databaseId)}` : ""}`,
        "Gagal memuat detail.", (d) => d.faktur as FakturDetail,
    ), [id, databaseId]));
    const d = detail.data;
    const memuat = detail.status === "memuat" && !d;
    const galat = detail.status === "galat" && !d;
    const items: BarisItem[] = (d?.items ?? []).map((it, urut) => ({ ...it, urut }));
    const nomor = baris?.number || d?.number;
    const status = baris?.status || d?.status;
    const lunas = status?.trim() === "Lunas";
    /** Nilai yang hanya ada di detail Accurate. */
    const dariDetail = (v: string | undefined) => d ? dash(v)
        : <span className="fi-subtle">{memuat ? "menunggu Accurate…" : "tidak terbaca"}</span>;

    const atribut = baris ? [
        { label: "Pelanggan", value: <>{dash(baris.customerName)} · <span className="fi-mono">{dash(baris.customerNo)}</span></> },
        { label: "Tanggal", value: dash(baris.transDate) },
        { label: "Jatuh tempo", value: dash(baris.dueDate) },
        { label: "Total", value: rupiah(baris.totalAmount ?? 0) },
        // Terisi dari primeOwing lewat cron/webhook. Faktur lama yang belum kena sync sejak 2026-08-19 masih null — tampilkan "—",
        // jangan Rp 0 yang menyesatkan sebagai lunas.
        { label: "Sisa tagihan", value: baris.outstanding === null || baris.outstanding === undefined ? "—" : rupiah(baris.outstanding) },
        { label: "Umur", value: baris.age === null || baris.age === undefined ? "—" : `${baris.age} hari` },
    ] : d ? [
        { label: "Pelanggan", value: <>{dash(d.customerName)} · <span className="fi-mono">{dash(d.customerNo)}</span></> },
        { label: "Tanggal", value: dash(d.transDate) },
        { label: "Jatuh tempo", value: dash(d.dueDate) },
        { label: "Total", value: rupiah(d.totalAmount) },
        { label: "Sisa tagihan", value: rupiah(d.owing) },
    ] : [];

    const pelunasan = lunas ? `Lunas${d?.lastPaymentDate ? ` · bayar terakhir ${d.lastPaymentDate}` : ""}`
        : d && d.paid > 0 ? `Dibayar ${rupiah(d.paid)} · sisa ${rupiah(d.owing)}`
        : d ? "belum ada pembayaran" : memuat ? "menunggu Accurate" : "belum terbaca";

    return (
        <div className="grid gap-3 pb-4">
            <ObjectPageHeader title={nomor ? <span className="fi-mono">{nomor}</span> : databaseId ? "Faktur dari laporan realisasi" : "Faktur"}
                status={baris || d ? <Status value={status} /> : undefined} attributes={atribut} />
            {!baris && memuat && <Skeleton rows={2} label="Memuat kepala faktur" />}
            <AnchorBar anchors={[{ id: "fk-barang", label: "Barang" }, { id: "fk-ringkasan", label: "Ringkasan" }, { id: "fk-alur", label: "Alur dokumen" }, { id: "fk-info", label: "Info" }]} />
            <div className="grid gap-3 px-3">
                {databaseId && <MessageStrip tone="info" title="Dibuka dari laporan realisasi.">Kepala faktur dibaca dari Accurate setelah database sesi dicocokkan dengan database laporan.</MessageStrip>}

                <Section id="fk-barang" title="Barang" subtitle={memuat ? "Mengambil detail dari Accurate…" : d ? `${items.length} barang · dari Accurate` : undefined}>
                    {galat ? (
                        <>
                            <ErrorState title="Barang dan ringkasan gagal diambil dari Accurate" message={detail.error} onRetry={muat} />
                            <div className="fi-sect-in">
                                <VariantNote bl="BL-22">Hari ini faktur yang sudah dihapus di Accurate tetap ada di daftar, dan detailnya gagal dengan pesan Accurate seperti di atas. Usulan: label Dihapus di Accurate di daftar dan di sini; faktur itu tidak dihitung di piutang, verifikasi balik, dan Rekap Promo.</VariantNote>
                            </div>
                        </>
                    ) : (
                        <ResponsiveTable title="Barang faktur" columns={KOLOM_BARANG} rows={items} rowKey={(i) => `${i.itemNo}-${i.urut}`}
                            status={memuat ? "memuat" : "siap"}
                            empty={{ title: "Accurate tidak mengembalikan baris barang untuk faktur ini." }}
                            mobileItem={(i) => <ListItem doc={dash(i.itemNo)} amount={rupiah(i.total)} title={dash(i.itemName)}
                                meta={`${angka.format(i.quantity)} ${i.unit} × ${rupiah(i.unitPrice)}${i.discount ? ` · diskon ${rupiah(i.discount)}` : ""}`} />} />
                    )}
                </Section>

                <Section id="fk-ringkasan" title="Ringkasan">
                    <div className="fi-sect-in">
                        {memuat ? <Skeleton rows={4} label="Memuat ringkasan" />
                            : d ? (
                                // Sisa tagihan di sini dari detail.do (primeOwing) saat ini; angka di kepala dari cache bisa tertinggal sampai
                                // sync atau webhook berikutnya.
                                <KeyValues items={[
                                    ["Subtotal", rupiah(d.subTotal)], ["Diskon", rupiah(d.totalDiscount)], ["Pajak", rupiah(d.tax)],
                                    ["Total", rupiah(d.totalAmount)], ["Dibayar", rupiah(d.paid)], ["Sisa tagihan", rupiah(d.owing)],
                                ]} />
                            ) : <p className="fi-small fi-subtle">Belum terbaca — detail faktur gagal diambil dari Accurate.</p>}
                    </div>
                </Section>

                <Section id="fk-alur" title="Alur dokumen">
                    <div className="fi-dflow" role="list" aria-label="Alur dokumen">
                        <span role="listitem" className="fi-dnode"><b className="fi-mono">{nomor || "Faktur"}</b><span>faktur ini</span></span>
                        <ArrowRight className="fi-icon" aria-hidden />
                        <span role="listitem" className="fi-dnode" data-off={!lunas && !(d && d.paid > 0)}><b>Pelunasan</b><span>{pelunasan}</span></span>
                    </div>
                    <div className="fi-sect-in">
                        <VariantNote bl="BL-35">Hari ini asal faktur (Order Sales, Order Masuk, atau SO Order Principal lewat Antrean Faktur) belum terbaca di layar ini. Usulan: alur menaut ke order asal dan baris antreannya lewat kunci antrean yang tersimpan di faktur, sampai pelunasannya.</VariantNote>
                        <div><TautanAntrean boleh={bolehAntrean}>Buka Antrean Faktur</TautanAntrean></div>
                    </div>
                </Section>

                <Section id="fk-info" title="Info">
                    <div className="fi-sect-in">
                        <KeyValues items={[
                            ["Cabang", dariDetail(d?.branchName)],
                            ["Sales", d ? teksSales(d) : dariDetail(undefined)],
                            ["Jatuh tempo", dash(baris?.dueDate ?? d?.dueDate)],
                            ["Termin", dariDetail(d?.paymentTerm)],
                            ["Bayar terakhir", dariDetail(d?.lastPaymentDate)],
                            ["Keterangan", dariDetail(d?.description)],
                            // Dasar urutan daftar. Hanya terisi untuk faktur yang masuk lewat webhook — list.do tidak mengirim createDate,
                            // jadi faktur lama menampilkan "—".
                            ...(baris ? [["Dibuat di Accurate", waktuWita(baris.createdAt)] as [string, ReactNode]] : []),
                            // BUKAN waktu faktur dibuat: nilainya ikut berubah saat faktur dilunasi.
                            ...(baris ? [["Perubahan terakhir", waktuWita(baris.lastUpdateAt)] as [string, ReactNode]] : []),
                        ]} />
                    </div>
                </Section>
            </div>
        </div>
    );
}
