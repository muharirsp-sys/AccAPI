/*
 * Tujuan: Object Page satu order internal (Fiori S6d, it06): kepala + tahap (Butuh harga → Siap diantrekan → Di antrean → Difakturkan),
 *   Barang dengan harga order vs harga master, Pemeriksaan sebelum antre, Promo dibekukan, Alur dokumen, Riwayat; aksi Antrekan faktur
 *   lewat dialog (salesman wajib, C7). Bagian dimuat terpisah: galat satu bagian tidak mengganti seluruh halaman.
 * Caller: ./[id]/page.tsx (/orders/[id]); dari daftar Order Masuk dan setelah Order baru disimpan (`?baru=1`).
 * Dependensi: FastAPI GET /orders/{id}; GET /api/orders/[id]/invoice (status antrean); POST /api/orders/preview (harga master, baca saja);
 *   ./AntreFaktur; ./order-ui; components/fiori/*; lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek, jamWita).
 * Main Functions: OrderDetail, muatHargaMaster.
 * Side Effects: HTTP baca; Antrekan lewat ./AntreFaktur. Tidak ada tulis ke Accurate.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Send, TriangleAlert } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section,
    Skeleton, StatusBadge, VariantNote, type Column, type FlowStep,
} from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { AntreFaktur, type HasilAntre } from "./AntreFaktur";
import {
    BELUM_PASTI, fastapi, nextApi, nilai, nomorOrder, pesanJawaban, statusOrder, sukses, sumberOrder,
    type OrderFull, type OutboxRow, type PriceInfo, type ResultLine,
} from "./order-ui";

type Harga = { prices: PriceInfo[]; tanpaHarga: string[] };
type Baris = { key: string; code: string; unit: string; quantity: string; price: string; bonus?: string; hasil?: ResultLine; master?: PriceInfo | null };
type Cek = { tone: "pos" | "warn" | "neg" | "neu"; label: string };

const TAHAP = ["Butuh harga", "Siap diantrekan", "Di antrean", "Difakturkan"];

/** Harga master per baris order lewat pratinjau server (harga ketikan diabaikan server). 409 `missing` → ulang dari baris berharga. */
async function muatHargaMaster(o: OrderFull): Promise<Load<Harga>> {
    const badan = (lines: OrderFull["lines"]) => ({
        channel: o.channel, order_date: o.order_date, customer_no: o.customer_no,
        lines: lines.map((l) => ({ code: l.code, unit: l.unit, quantity: l.quantity })),
    });
    const j = await nextApi("/api/orders/preview", badan(o.lines));
    if (sukses(j)) return { status: "siap", data: { prices: (j.data.prices as PriceInfo[]) ?? [], tanpaHarga: [] } };
    const d = j.data ?? {};
    if (j.status === 409 && Array.isArray(d.missing)) {
        const tanpaHarga = [...new Set((d.missing as unknown[]).map(String))];
        const berharga = o.lines.filter((l) => !tanpaHarga.includes(l.code));
        if (berharga.length === 0) return { status: "siap", data: { prices: [], tanpaHarga } };
        const k = await nextApi("/api/orders/preview", badan(berharga));
        if (sukses(k)) return { status: "siap", data: { prices: (k.data.prices as PriceInfo[]) ?? [], tanpaHarga } };
        return { status: "galat", error: pesanJawaban(k, "Harga master tidak terbaca.") };
    }
    return { status: "galat", error: pesanJawaban(j, "Harga master tidak terbaca.") };
}

function cekHarga(b: Baris, harga: Load<Harga>): Cek {
    if (b.bonus) return { tone: "neu", label: "Bonus promo" };
    if (harga.status === "galat") return { tone: "neu", label: "Master tidak terbaca" };
    if (harga.status === "memuat") return { tone: "neu", label: "Memeriksa…" };
    if (!b.master) return { tone: "warn", label: "Master belum ada" };
    if (!String(b.price).trim()) return { tone: "warn", label: "Belum berharga" };
    return Math.abs(Number(b.price) - Number(b.master.price)) <= 0.005 ? { tone: "pos", label: "Sama dengan master" } : { tone: "warn", label: "Beda master" };
}

export default function OrderDetail({ id, baru, permKeys }: { id: string; baru: boolean; permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehAntre = keys.has("order.edit");
    const bolehHarga = keys.has("order.create") || keys.has("websales.create");
    const [pesanBaru, setPesanBaru] = useState(baru);
    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<HasilAntre | null>(null);

    const [order, muatOrder] = useLoad(useCallback(async (): Promise<Load<OrderFull | null>> => {
        const j = await fastapi("GET", `/orders/${encodeURIComponent(id)}`);
        if (j.status === 404) return { status: "siap", data: null };
        if (sukses(j)) return { status: "siap", data: j.data.order as OrderFull };
        return { status: "galat", error: pesanJawaban(j, "Order gagal dimuat.") };
    }, [id]));
    const [antrean, muatAntrean] = useLoad(useCallback(async (): Promise<Load<OutboxRow | null>> => {
        const j = await nextApi(`/api/orders/${encodeURIComponent(id)}/invoice`);
        if (sukses(j)) return { status: "siap", data: (j.data.outbox as OutboxRow | null) ?? null };
        return { status: "galat", error: pesanJawaban(j, "Status Antrean Faktur gagal dimuat.") };
    }, [id]));
    const o = order.data ?? null;
    const kunciHarga = o && bolehHarga && o.lines.length ? JSON.stringify([o.id, o.channel, o.order_date, o.customer_no]) : "";
    const [harga, muatHarga] = useLoad(useCallback(async (): Promise<Load<Harga>> => {
        if (!o || !kunciHarga) return { status: "galat", error: bolehHarga ? "Order belum dimuat." : "Akun Anda tidak berhak membaca harga master." };
        return muatHargaMaster(o);
        // o dibaca lewat kunciHarga (isi order beku tidak berubah); objek baru tiap muat ulang tidak memicu pratinjau ulang.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kunciHarga, bolehHarga]));

    const baris = useMemo<Baris[]>(() => {
        if (!o) return [];
        const hasilBaris = o.result?.lines ?? [];
        const isi: Baris[] = o.lines.map((l, i) => ({
            key: `l${i}`, code: l.code, unit: l.unit, quantity: l.quantity, price: l.price,
            hasil: o.result?.pending_price ? undefined : hasilBaris.find((r) => r.code === l.code && r.unit === l.unit),
            master: harga.status === "siap" ? harga.data?.prices.find((p) => p.code === l.code && p.unit === l.unit.toUpperCase() && p.price != null) ?? null : undefined,
        }));
        const bonus = (o.result?.bonuses ?? []).map((b, i): Baris => ({ key: `b${i}`, code: b.code || `(${(b.eligible_codes ?? []).join(", ")})`, unit: b.unit, quantity: b.quantity, price: "0", bonus: b.program_id }));
        return [...isi, ...bonus];
    }, [o, harga]);
    const beda = harga.status === "siap" ? baris.filter((b) => cekHarga(b, harga).label === "Beda master").length : null;

    if (order.status === "memuat" && !o) {
        return <div className="fi-page"><Skeleton rows={2} label="Memuat order" /><Skeleton rows={5} label="Memuat barang" /></div>;
    }
    if (order.status === "galat" && !o) {
        return <div className="fi-page"><ErrorState title="Order gagal dimuat" message={`${order.error} Ini bukan berarti ordernya tidak ada.`} onRetry={muatOrder} /></div>;
    }
    if (!o) {
        return (
            <div className="fi-page">
                <EmptyState title="Order tidak ditemukan" message="Order ini tidak ada atau Anda tidak berhak melihatnya. Kembali ke Order Masuk untuk mencari nomornya."
                    action={<Link className="fi-btn fi-btn--secondary" href="/orders">Order Masuk</Link>} />
            </div>
        );
    }

    const outbox = antrean.status === "siap" ? antrean.data ?? null : undefined;
    const status = statusOrder(o, outbox, antrean.status === "memuat");
    // Status antrean belum terbaca (memuat/gagal) atau status order tak dikenal: tidak ada langkah yang disorot sebagai posisi order —
    // order bisa saja sudah di antrean atau sudah difakturkan. Hanya "Butuh harga" yang pasti terlewati (order berharga).
    const idx = { butuh: 0, siap: 1, antre: 2, masalah: 2, faktur: 4, belum: -1, lain: -1 }[status.key];
    const steps: FlowStep[] = TAHAP.map((label, i) => ({
        label,
        state: idx < 0 ? (i === 0 && status.key === "belum" ? "done" : "todo")
            : i < idx ? "done" : i > idx ? "todo" : status.key === "masalah" ? (outbox?.state === "rejected" ? "stop" : "late") : "current",
    }));
    const kunciAntre = !bolehAntre ? "Hanya petugas pemegang izin ubah order yang boleh mengantrekan faktur"
        : order.status === "memuat" ? "Order sedang dimuat ulang"
            : antrean.status === "memuat" ? "Status Antrean Faktur sedang dimuat"
                : antrean.status === "galat" ? "Status Antrean Faktur belum terbaca; muat ulang dulu"
                    : outbox ? `Order ini sudah di Antrean Faktur (${status.label.toLowerCase()})`
                        : status.key === "butuh" ? "Order masih Butuh harga; harga belum bisa diisi dari layar ini (usulan BL-18)"
                            : status.key !== "siap" ? "Status order ini tidak bisa diantrekan" : undefined;

    function selesai(h: HasilAntre) {
        setDialog(false);
        setHasil(h);
        muatAntrean();
    }

    const kolom: Column<Baris>[] = [
        { key: "barang", header: "Barang", cell: (b) => <><span className="fi-mono">{b.code}</span>{b.bonus && <span className="fi-sub">bonus {b.bonus}</span>}</> },
        { key: "jumlah", header: "Jumlah", cell: (b) => <span className="fi-tnum">{b.quantity} {b.unit}</span> },
        { key: "harga", header: "Harga order", align: "end", cell: (b) => <span className="fi-tnum">{b.bonus ? "—" : nilai(b.price)}</span> },
        { key: "master", header: "Harga master", align: "end", cell: (b) => <span className="fi-tnum" title={b.master ? sumber(b.master) : undefined}>{b.bonus ? "—" : b.master ? rupiah(b.master.price ?? 0) : b.master === null ? "belum ada" : "—"}</span> },
        { key: "diskon", header: "Diskon", secondary: true, cell: (b) => b.hasil ? diskon(b.hasil) : "—" },
        { key: "netto", header: "Netto", align: "end", cell: (b) => <span className="fi-tnum">{b.bonus ? rupiah(0) : nilai(b.hasil?.net)}</span> },
        { key: "cek", header: "Cek harga", cell: (b) => { const c = cekHarga(b, harga); return <StatusBadge tone={c.tone}>{c.label}</StatusBadge>; } },
    ];

    return (
        <div>
            <div className="fi-page">
                <ObjectPageHeader
                    breadcrumbs={[{ label: "Order Masuk", href: "/orders" }, { label: nomorOrder(o.id) }]}
                    title={<span className="fi-mono">{nomorOrder(o.id)}</span>}
                    status={<StatusBadge tone={status.tone} busy={status.busy}>{status.label}</StatusBadge>}
                    attributes={[
                        { label: "Pelanggan", value: `${o.outlet} · ${o.customer_no || "tanpa kode"}` },
                        { label: "Channel", value: o.channel },
                        { label: "Tanggal order", value: tanggalPendek(o.order_date) },
                        { label: "Sumber", value: sumberOrder(o) },
                        { label: "Netto", value: o.result?.pending_price ? "—" : nilai(o.result?.net) },
                    ]}
                    flow={<Flow steps={steps} label="Tahap order" />} />

                {pesanBaru && <MessageStrip tone="pos" title="Order tersimpan dengan aturan promo yang dibekukan." onClose={() => setPesanBaru(false)}>Periksa harga dan promo di bawah, lalu antrekan fakturnya.</MessageStrip>}
                {hasil?.jenis === "antre" && (
                    <MessageStrip tone="pos" title={`${nomorOrder(o.id)} masuk Antrean Faktur.`} onClose={() => setHasil(null)}>
                        Faktur dibuat saat Fakturist menekan Kirim di <Link href="/antrean-faktur">Antrean Faktur</Link>; sebelum itu barisnya bisa dibuang di sana.
                    </MessageStrip>
                )}
                {hasil?.jenis === "terposting" && <MessageStrip tone="info" title="Tidak dikirim ulang." onClose={() => setHasil(null)}>{hasil.pesan}</MessageStrip>}
                {hasil?.jenis === "ragu" && <MessageStrip tone="warn" title="Hasil antre belum pasti." onClose={() => setHasil(null)}>{BELUM_PASTI}</MessageStrip>}
                {antrean.status === "galat" && (
                    <MessageStrip tone="neg" title="Status Antrean Faktur belum terbaca.">
                        {antrean.error} Antrekan dikunci sampai statusnya terbaca. <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatAntrean}>Coba lagi</button>
                    </MessageStrip>
                )}
                {status.key === "butuh" && (
                    <MessageStrip tone="warn" title="Order ini masih Butuh harga.">
                        Order dari Order Sales tersimpan tanpa harga; harga master tampil di kolom Harga master, tetapi belum bisa disimpan ke order dari layar ini.
                    </MessageStrip>
                )}

                <Section id="barang" title="Barang" subtitle={`${o.lines.length} barang${o.result?.pending_price ? " · belum berharga" : ` · netto ${nilai(o.result?.net)}`}`}>
                    <ResponsiveTable<Baris> title="Barang order" columns={kolom} rows={baris} rowKey={(b) => b.key}
                        empty={{ title: "Order tanpa barang" }}
                        mobileItem={(b) => {
                            const c = cekHarga(b, harga);
                            return <ListItem doc={b.code} amount={b.bonus ? rupiah(0) : nilai(b.hasil?.net)}
                                title={`${b.quantity} ${b.unit} × ${b.bonus ? "bonus" : nilai(b.price)}`}
                                meta={b.bonus ? `bonus ${b.bonus}` : b.master ? `master ${rupiah(b.master.price ?? 0)}` : b.master === null ? "master belum ada" : "master —"}
                                badge={<StatusBadge tone={c.tone}>{c.label}</StatusBadge>} />;
                        }} />
                    {harga.status === "galat" && (
                        <div className="fi-sect-in">
                            <MessageStrip tone="warn" title="Harga master tidak terbaca.">
                                {harga.error} Kolom Harga master kosong; ini bukan berarti harganya sama.{" "}
                                {bolehHarga && <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatHarga}>Coba lagi</button>}
                            </MessageStrip>
                        </div>
                    )}
                </Section>

                <Section id="pemeriksaan" title="Pemeriksaan sebelum antre" subtitle="dijalankan lagi di dialog Antrekan">
                    <div className="fi-sect-in">
                        <ul className="fi-chkl">
                            <Butir ok={beda === 0} teks={beda === null ? "Harga master belum terbaca" : beda === 0 ? "Harga semua barang sama dengan master" : `${beda} barang beda dari master (belum menahan antre — usulan BL-19)`} />
                            <Butir ok={antrean.status === "siap" && !outbox} teks={antrean.status !== "siap" ? "Status antrean belum terbaca" : outbox ? `Sudah di Antrean Faktur: ${status.label}` : "Belum ada di Antrean Faktur"} />
                            <Butir ok={Boolean(o.customer_no)} teks={o.customer_no ? "Pelanggan punya kode Accurate; cabang & seri faktur diperiksa di dialog" : "Order tanpa kode pelanggan tidak bisa difakturkan"} />
                            <Butir ok teks="Salesman dipilih saat antre: satu per order, disalin ke setiap baris faktur" />
                        </ul>
                        <VariantNote bl="BL-20">Dugaan order ganda hari ini diperiksa saat order disimpan (outlet sama, barang mirip, tanggal sama). Usulan: kunci kode pelanggan lintas pemilik, diperiksa lagi saat antre.</VariantNote>
                    </div>
                </Section>

                <Section id="promo" title="Promo dibekukan" subtitle={`dibekukan ${jamWita(o.created_at)} WITA saat order disimpan`}>
                    <div className="fi-sect-in">
                        {o.result?.pending_price ? <p className="fi-small fi-muted">Aturan promo belum dibekukan: order belum berharga.</p> : (
                            <KeyValues items={[
                                ["Aturan", o.rules.length ? o.rules.map((r) => r.name || r.id).join("; ") : "Tidak ada aturan terbit saat disimpan"],
                                ["Potongan", (o.result?.applications ?? []).length ? (o.result?.applications ?? []).map((a) => `${a.program_id}: min. ${rupiah(a.minimum)} → ${rupiah(a.discount)}`).join("; ") : "—"],
                                ["Bonus", (o.result?.bonuses ?? []).length ? (o.result?.bonuses ?? []).map((b) => `${b.quantity} ${b.unit} ${b.code || "(pilih SKU)"} · ${b.program_id}`).join("; ") : "—"],
                                ["Bruto · diskon · netto", `${nilai(o.result?.gross)} · ${nilai(o.result?.discount)} · ${nilai(o.result?.net)}`],
                            ]} />
                        )}
                    </div>
                </Section>

                <Section id="alur" title="Alur dokumen">
                    <div className="fi-dflow" role="list" aria-label="Alur dokumen">
                        {o.request_id && <><span role="listitem" className="fi-dnode"><b className="fi-mono">Order Sales #{o.request_id.slice(0, 8)}</b><span>permintaan lapangan</span></span><ArrowRight className="fi-icon" aria-hidden /></>}
                        <span role="listitem" className="fi-dnode"><b className="fi-mono">{nomorOrder(o.id)}</b><span>{o.request_id ? "ditarik petugas" : `petugas · ${o.owner}`}</span></span>
                        <ArrowRight className="fi-icon" aria-hidden />
                        {outbox
                            ? <Link role="listitem" className="fi-dnode" href="/antrean-faktur"><b>Antrean Faktur</b><span>{status.label}{outbox.updatedAt ? ` · ${jamWita(outbox.updatedAt)}` : ""}</span></Link>
                            : <span role="listitem" className="fi-dnode" data-off="true"><b>Antrean Faktur</b><span>{antrean.status === "siap" ? "belum" : "belum terbaca"}</span></span>}
                        <ArrowRight className="fi-icon" aria-hidden />
                        {outbox?.state === "posted" && outbox.accurateNumber
                            ? <Link role="listitem" className="fi-dnode" href={`/faktur?q=${encodeURIComponent(outbox.accurateNumber)}`}><b className="fi-mono">{outbox.accurateNumber}</b><span>Faktur Penjualan</span></Link>
                            : <span role="listitem" className="fi-dnode" data-off="true"><b>Faktur</b><span>belum</span></span>}
                    </div>
                </Section>

                <Section id="riwayat" title="Riwayat">
                    <div className="fi-sect-in">
                        <KeyValues items={[
                            ["Dibuat", `${jamWita(o.created_at)} WITA · ${o.owner || "—"}`],
                            ["Catatan", o.note?.trim() || "—"],
                            ["Antrean", outbox ? `${status.label}${outbox.updatedAt ? ` · diperbarui ${jamWita(outbox.updatedAt)} WITA` : ""}${outbox.lastError ? ` · ${outbox.lastError.slice(0, 160)}` : ""}` : antrean.status === "siap" ? "belum diantrekan" : "belum terbaca"],
                        ]} />
                        <VariantNote bl="BL-33">Riwayat lengkap per aksi (siapa, kapan, nilai lama → baru) belum dicatat untuk order. Usulan: riwayat bersama berupa kalimat.</VariantNote>
                    </div>
                </Section>
                <VariantNote bl="BL-18">Order belum bisa dibatalkan dan Butuh harga belum bisa diisi dari master di layar ini. Usulan: Batalkan beralasan dan Isi harga dari master.</VariantNote>
            </div>
            <FooterToolbar message={kunciAntre ?? `Siap diantrekan · netto ${nilai(o.result?.net)}`}>
                {outbox && <Link className="fi-btn fi-btn--secondary" href="/antrean-faktur">Buka Antrean Faktur</Link>}
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(kunciAntre)} disabledReason={kunciAntre} onClick={() => { setHasil(null); setDialog(true); }}>Antrekan faktur…</Button>
            </FooterToolbar>
            {dialog && <AntreFaktur order={o} hargaBeda={beda} onClose={() => setDialog(false)} onSelesai={selesai} onMuatUlang={muatAntrean} />}
        </div>
    );
}

function Butir({ ok, teks }: { ok: boolean; teks: string }) {
    return <li data-ok={ok}>{ok ? <Check className="fi-icon" aria-hidden /> : <TriangleAlert className="fi-icon" aria-hidden />}<span>{teks}</span></li>;
}

const sumber = (p: PriceInfo) => p.source === "tier"
    ? [p.priceCategoryName ?? "kategori", p.branchName, p.effectiveDate ? `berlaku ${tanggalPendek(p.effectiveDate)}` : null].filter(Boolean).join(" · ")
    : "harga standar";

function diskon(r: ResultLine): string {
    const potong = Number(r.gross) - Number(r.net);
    if (!(potong > 0)) return "—";
    const rantai = (r.percents ?? []).filter(Boolean);
    return `${rantai.length ? `${rantai.join("+")}% · ` : ""}${rupiah(potong)}`;
}
