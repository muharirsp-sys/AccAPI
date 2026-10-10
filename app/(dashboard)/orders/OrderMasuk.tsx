/*
 * Tujuan: List Report Order Masuk (Fiori S6d, it06): order INTERNAL dari petugas dan tarikan Order Sales — kartu status = saringan,
 *   status sampai faktur (status order + Antrean Faktur), sumber, tarik Order Sales dan koneksi tarik otomatis. Order principal ada di
 *   Order Principal; faktur dibuat saat Kirim di Antrean Faktur.
 * Caller: ./page.tsx (/orders; guard halaman `order.view`).
 * Dependensi: FastAPI GET /orders, POST /orders/pull, GET|POST /orders/connection; GET /api/orders/invoice-status; ./order-ui;
 *   components/fiori/{core,interactive}; lib/rekapan-nota/ui (tanggalPendek, jamWita).
 * Main Functions: OrderMasuk.
 * Side Effects: HTTP; Tarik menulis order internal (FastAPI, idempoten per permintaan Order Sales); koneksi menulis setelan tarik otomatis.
 *   Tidak ada tulis ke Accurate.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Plus, Power } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import {
    BELUM_PASTI, fastapi, nextApi, nilai, nomorOrder, pesanJawaban, statusOrder, sukses, sumberOrder, tidakPasti,
    type OrderRow, type OutboxRow, type StatusKey,
} from "./order-ui";

type Daftar = { rows: OrderRow[]; scope: "mine" | "all" };
type Koneksi = {
    pending: number;
    connection: { enabled: boolean; owner: string; updated_by: string; updated_at: string; last_run_at: string; last_result: { imported: number; already_imported: number; failed: number } | null };
};
type Saring = "semua" | Exclude<StatusKey, "lain" | "belum">;
type HasilTarik = { imported: number; already: number; failed: { request_id: string; error: string }[] };

const KARTU: Array<{ key: Saring; label: string; waspada?: boolean }> = [
    { key: "semua", label: "Semua order" }, { key: "butuh", label: "Butuh harga", waspada: true }, { key: "siap", label: "Siap diantrekan" },
    { key: "antre", label: "Di antrean" }, { key: "faktur", label: "Difakturkan" }, { key: "masalah", label: "Tidak pasti / ditolak", waspada: true },
];
// Kartu yang angkanya bergantung pada status Antrean Faktur: tanpa bacaan antrean angkanya "–", bukan 0 (termasuk Siap diantrekan).
const BUTUH_ANTREAN: ReadonlySet<Saring> = new Set(["siap", "antre", "faktur", "masalah"]);
const MAKS_FASTAPI = 100;

export default function OrderMasuk({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehBuat = keys.has("order.create");
    const bolehEdit = keys.has("order.edit");
    const [scope, setScope] = useState<"mine" | "all">("mine");
    const [saring, setSaring] = useState<Saring>("semua");
    const [cari, setCari] = useState("");
    const [sumber, setSumber] = useState<"" | "sales" | "petugas">("");
    const [tarik, setTarik] = useState<{ busy: boolean; hasil?: HasilTarik; galat?: string; ragu?: boolean }>({ busy: false });
    const [dialogKoneksi, setDialogKoneksi] = useState(false);

    // Daftar per cakupan; data cakupan lain tetap tampil redup sampai jawaban baru tiba (List Report).
    const [daftar, muatDaftar] = useLoad(useCallback(async (): Promise<Load<Daftar>> => {
        const j = await fastapi("GET", `/orders?scope=${scope}`);
        if (sukses(j)) return { status: "siap", data: { rows: (j.data.orders as OrderRow[]) ?? [], scope: j.data.scope === "all" ? "all" : "mine" } };
        return { status: "galat", error: `${pesanJawaban(j, "Daftar order gagal dimuat.")} Ini bukan daftar kosong; order yang sudah tersimpan tidak hilang.` };
    }, [scope]), { pertahankan: true });

    const rows = useMemo(() => daftar.data?.rows ?? [], [daftar.data]);
    const idsKey = rows.map((o) => o.id).join(",");
    // Status Antrean Faktur untuk order yang tampil — satu permintaan (bukan satu per baris). Gagal = status "belum terbaca", bukan "belum antre".
    const [antrean, muatAntrean] = useLoad(useCallback(async (): Promise<Load<Map<string, OutboxRow>>> => {
        if (!idsKey) return { status: "siap", data: new Map() };
        const j = await nextApi(`/api/orders/invoice-status?ids=${encodeURIComponent(idsKey)}`);
        if (sukses(j)) return { status: "siap", data: new Map(((j.data.outbox as OutboxRow[]) ?? []).map((r) => [String(r.orderId), r])) };
        return { status: "galat", error: pesanJawaban(j, "Status Antrean Faktur gagal dimuat.") };
    }, [idsKey]));
    const [koneksi, muatKoneksi] = useLoad(useCallback(async (): Promise<Load<Koneksi>> => {
        const j = await fastapi("GET", "/orders/connection");
        if (sukses(j)) return { status: "siap", data: j.data as unknown as Koneksi };
        return { status: "galat", error: pesanJawaban(j, "Status koneksi Order Sales gagal dimuat.") };
    }, []));

    // Status antrean dipakai hanya bila terbaca untuk daftar INI (galat/memuat pertama = undefined → "belum terbaca").
    const peta = antrean.status === "galat" && !antrean.data ? undefined : antrean.data;
    const antreanMemuat = antrean.status === "memuat" && !antrean.data;
    const statusDari = useCallback((o: OrderRow) => statusOrder(o, peta ? peta.get(o.id) ?? null : undefined, antreanMemuat), [peta, antreanMemuat]);

    const jumlah = useMemo(() => {
        const n: Record<string, number> = { semua: rows.length };
        for (const o of rows) { const k = statusDari(o).key; n[k] = (n[k] ?? 0) + 1; }
        return n;
    }, [rows, statusDari]);

    const q = cari.trim().toLowerCase();
    const tampil = useMemo(() => rows.filter((o) =>
        (saring === "semua" || statusDari(o).key === saring)
        && (!sumber || (sumber === "sales") === Boolean(o.request_id))
        && (!q || [o.id, o.outlet, o.customer_no, o.request_id ?? "", o.owner].some((v) => v.toLowerCase().includes(q)))), [rows, saring, sumber, q, statusDari]);

    const kolom: Column<OrderRow>[] = [
        { key: "order", header: "Order", cell: (o) => <><Link className="fi-mono" href={`/orders/${o.id}`}>{nomorOrder(o.id)}</Link><span className="fi-sub">dibuat {jamWita(o.created_at)}</span></> },
        { key: "pelanggan", header: "Pelanggan", cell: (o) => <>{o.outlet}<span className="fi-sub fi-mono">{o.customer_no || "tanpa kode"}</span></> },
        { key: "sumber", header: "Sumber", secondary: true, cell: (o) => sumberOrder(o) },
        { key: "tanggal", header: "Tgl order", secondary: true, cell: (o) => tanggalPendek(o.order_date) },
        { key: "netto", header: "Netto", align: "end", cell: (o) => <span className="fi-tnum">{o.result?.pending_price ? "—" : nilai(o.result?.net)}</span> },
        { key: "status", header: "Status", cell: (o) => { const s = statusDari(o); return <StatusBadge tone={s.tone} busy={s.busy}>{s.label}</StatusBadge>; } },
        { key: "faktur", header: "Faktur / keterangan", secondary: true, cell: (o) => <Keterangan o={o} row={peta?.get(o.id)} /> },
    ];

    async function tarikSekarang() {
        if (tarik.busy) return;
        setTarik({ busy: true });
        const j = await fastapi("POST", "/orders/pull", {});
        if (tidakPasti(j)) {
            // Tarik idempoten per permintaan (request_id unik), jadi mengulang aman — tetapi hasilnya dibaca dulu, bukan ditebak.
            setTarik({ busy: false, ragu: true });
        } else if (!sukses(j)) {
            setTarik({ busy: false, galat: pesanJawaban(j, "Tarik Order Sales gagal.") });
        } else {
            setTarik({ busy: false, hasil: {
                imported: ((j.data.imported as unknown[]) ?? []).length,
                already: ((j.data.already_imported as unknown[]) ?? []).length,
                failed: (j.data.failed as HasilTarik["failed"]) ?? [],
            } });
        }
        muatDaftar();
        muatKoneksi();
    }

    async function ubahKoneksi() {
        const nyala = !koneksi.data?.connection.enabled;
        const j = await fastapi("POST", "/orders/connection", { enabled: nyala });
        if (tidakPasti(j)) { setDialogKoneksi(false); muatKoneksi(); throw new Error(BELUM_PASTI); }
        if (!sukses(j)) throw new Error(pesanJawaban(j, "Koneksi Order Sales gagal diubah."));
        setDialogKoneksi(false);
        muatKoneksi();
    }

    const kon = koneksi.data;
    const tanpaIzinTarik = !(bolehBuat && bolehEdit) ? "Hanya petugas pemegang izin buat dan ubah order yang boleh menarik Order Sales" : undefined;
    const kunciKoneksi = tanpaIzinTarik ?? (koneksi.status !== "siap" ? "Status koneksi sedang dimuat atau gagal dibaca" : undefined);
    const antreanGalat = antrean.status === "galat" && !antrean.data;
    const kosong = rows.length === 0
        ? { title: scope === "mine" ? "Belum ada order milik Anda" : "Belum ada order", message: "Order yang Anda buat dan order yang ditarik dari Order Sales muncul di sini. Buat order, atau tarik Order Sales sekarang." }
        : { title: "Tidak ada order yang sesuai saringan", message: "Ubah kata kunci, pilih kartu lain, atau hapus saringan." };

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Penjualan</span></li><li><span aria-current="page">Order Masuk</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Order Masuk</h1>
                    <span className="fi-spacer" />
                    {bolehBuat
                        ? <Link className="fi-btn fi-btn--primary" href="/orders/baru"><Plus className="fi-icon" aria-hidden />Buat order</Link>
                        : <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} disabled disabledReason="Akun Anda tidak berhak membuat order">Buat order</Button>}
                </div>
                <p>Order internal dari petugas dan dari Order Sales lapangan. Order principal ada di Order Principal; faktur dibuat saat Kirim di Antrean Faktur.</p>
            </header>

            {tarik.hasil && (
                <MessageStrip tone={tarik.hasil.failed.length ? "warn" : "pos"} title={`${tarik.hasil.imported} order baru ditarik dari Order Sales.`} onClose={() => setTarik({ busy: false })}>
                    {tarik.hasil.already > 0 && `${tarik.hasil.already} permintaan sudah pernah masuk. `}
                    {tarik.hasil.failed.length > 0 && <>{tarik.hasil.failed.length} tertahan: {tarik.hasil.failed.slice(0, 3).map((f) => `#${f.request_id.slice(0, 8)} — ${f.error}`).join("; ")}{tarik.hasil.failed.length > 3 && " …"}. Permintaan yang tertahan tetap menunggu dan ikut tarikan berikutnya.</>}
                    {tarik.hasil.imported > 0 && " Order tanpa harga berstatus Butuh harga."}
                </MessageStrip>
            )}
            {tarik.galat && <MessageStrip tone="neg" title="Tarik Order Sales gagal." onClose={() => setTarik({ busy: false })}>{tarik.galat}</MessageStrip>}
            {tarik.ragu && <MessageStrip tone="warn" title="Hasil tarik belum pasti." onClose={() => setTarik({ busy: false })}>{BELUM_PASTI} Menarik lagi aman: permintaan yang sudah masuk tidak digandakan.</MessageStrip>}

            <section className="fi-panel" aria-label="Order Sales">
                {koneksi.status === "galat" && !kon ? (
                    <MessageStrip tone="neg" title="Status koneksi Order Sales tidak terbaca.">{koneksi.error} <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatKoneksi}>Coba lagi</button></MessageStrip>
                ) : !kon ? <Skeleton rows={1} label="Memuat koneksi Order Sales" /> : (
                    <div className="flex flex-wrap items-center gap-3">
                        <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
                            <b>Order Sales</b>{" "}
                            <StatusBadge tone={kon.connection.enabled ? "pos" : "neu"}>{kon.connection.enabled ? "Tarik otomatis aktif" : "Tarik otomatis mati"}</StatusBadge>
                            <p className="fi-small fi-muted">
                                {kon.connection.enabled
                                    ? `Penjadwal menarik tiap 5 menit atas nama ${kon.connection.owner || "—"}.`
                                    : "Order lapangan hanya masuk saat ditarik manual."}
                                {` Menunggu: ${kon.pending}.`}
                                {kon.connection.last_run_at && ` Terakhir jalan ${jamWita(kon.connection.last_run_at)} WITA`}
                                {kon.connection.last_result && ` (${kon.connection.last_result.imported} masuk, ${kon.connection.last_result.failed} tertahan).`}
                            </p>
                        </div>
                        <Button icon={<Power className="fi-icon" aria-hidden />} disabled={Boolean(kunciKoneksi)} disabledReason={kunciKoneksi} onClick={() => setDialogKoneksi(true)}>
                            {kon.connection.enabled ? "Matikan tarik otomatis…" : "Nyalakan tarik otomatis…"}
                        </Button>
                        <Button icon={<Download className="fi-icon" aria-hidden />} busy={tarik.busy} disabled={Boolean(tanpaIzinTarik)} disabledReason={tanpaIzinTarik} onClick={() => void tarikSekarang()}>Tarik sekarang</Button>
                    </div>
                )}
            </section>

            {antreanGalat && (
                <MessageStrip tone="neg" title="Status Antrean Faktur gagal dimuat.">
                    {antrean.error} Angka Siap diantrekan, Di antrean, Difakturkan, dan Tidak pasti tidak tampil — ini bukan nol; order tersimpan ditandai “status antrean belum terbaca”.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatAntrean}>Coba lagi</button>
                </MessageStrip>
            )}

            {daftar.status === "memuat" && !daftar.data ? <div className="fi-panel"><Skeleton rows={2} label="Memuat ringkasan order" /></div> : (
                <div className="fi-kcards" role="group" aria-label="Saring menurut status">
                    {KARTU.map((k) => {
                        const tanpaAngka = !daftar.data || (BUTUH_ANTREAN.has(k.key) && !peta);
                        const angka = tanpaAngka ? null : jumlah[k.key] ?? 0;
                        return (
                            <button key={k.key} type="button" className="fi-kc" aria-pressed={saring === k.key} data-tone={k.waspada && (angka ?? 0) > 0 ? "warn" : undefined} onClick={() => setSaring(k.key)}>
                                <span>{k.label}</span>
                                <b>{angka ?? "–"}</b>
                                {BUTUH_ANTREAN.has(k.key) && !peta && daftar.data && <small>{antreanGalat ? "gagal dimuat" : "memuat…"}</small>}
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={Number(Boolean(sumber))} onReset={() => { setSumber(""); setCari(""); }}
                    search={<FormField label="Cari">{(a) => <input {...a} className="fi-input" type="search" placeholder="Nomor order, outlet, kode pelanggan" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={<FormField label="Sumber">{(a) => (
                        <select {...a} className="fi-input" value={sumber} onChange={(e) => setSumber(e.target.value as typeof sumber)}>
                            <option value="">Semua sumber</option><option value="sales">Order Sales</option><option value="petugas">Petugas</option>
                        </select>
                    )}</FormField>}
                    actions={
                        <div className="fi-segs" role="group" aria-label="Pemilik order">
                            <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>Milik saya</button>
                            <button type="button" aria-pressed={scope === "all"} disabled={!bolehEdit} title={!bolehEdit ? "Melihat order semua petugas butuh izin ubah order" : undefined} onClick={() => setScope("all")}>Semua</button>
                        </div>
                    }
                    chips={sumber ? [{ label: sumber === "sales" ? "Sumber: Order Sales" : "Sumber: Petugas", onRemove: () => setSumber("") }] : []} />
            </div>

            <ResponsiveTable<OrderRow> title={saring === "semua" ? "Order" : `Order · ${KARTU.find((k) => k.key === saring)?.label}`} count={tampil.length}
                columns={kolom} rows={tampil} rowKey={(o) => o.id} status={daftar.status} error={daftar.error} onRetry={muatDaftar} empty={kosong}
                mobileItem={(o) => {
                    const s = statusDari(o);
                    return <ListItem href={`/orders/${o.id}`} doc={nomorOrder(o.id)} amount={o.result?.pending_price ? "—" : nilai(o.result?.net)}
                        title={`${o.outlet} · ${o.customer_no || "tanpa kode"}`} meta={`${sumberOrder(o)} · ${tanggalPendek(o.order_date)}`}
                        badge={<StatusBadge tone={s.tone} busy={s.busy}>{s.label}</StatusBadge>} />;
                }} />
            <p className="fi-small fi-subtle">Status antrean dan nomor faktur dibaca dari Antrean Faktur. Setiap baris membuka ordernya; antre faktur dari halaman order.</p>
            {rows.length >= MAKS_FASTAPI && (
                <VariantNote bl="BL-36">Yang tampil {MAKS_FASTAPI} order terbaru; kartu dan pencarian hanya menghitung yang tampil. Usulan: saring periode/status di server dan simpan pilihan per pengguna.</VariantNote>
            )}
            <VariantNote bl="BL-18">Butuh harga belum punya jalan keluar di layar ini dan order belum bisa dibatalkan (server belum punya aksinya). Usulan: Isi harga dari master dan Batalkan beralasan dari halaman order.</VariantNote>
            <VariantNote bl="BL-20">Order yang ditahan sebagai dugaan ganda (outlet sama, barang mirip, tanggal sama) ditolak saat disimpan dan belum bisa dilepas dari layar. Usulan: kunci kode pelanggan lintas pemilik dan “Bukan order ganda” beralasan.</VariantNote>

            <ConfirmDialog open={dialogKoneksi} onClose={() => setDialogKoneksi(false)}
                title={kon?.connection.enabled ? "Matikan tarik otomatis Order Sales?" : "Nyalakan tarik otomatis Order Sales?"}
                description={kon?.connection.enabled
                    ? "Order lapangan berhenti masuk otomatis; permintaan tetap menunggu sampai ditarik manual."
                    : "Penjadwal menarik permintaan Order Sales tiap 5 menit sampai dimatikan."}
                facts={[
                    ["Atas nama", kon?.connection.enabled ? kon.connection.owner || "—" : "Anda — order hasil tarikan tercatat milik Anda"],
                    ["Menunggu sekarang", `${kon?.pending ?? 0} permintaan`],
                ]}
                confirmLabel={kon?.connection.enabled ? "Matikan" : "Nyalakan"} onConfirm={ubahKoneksi} />
        </div>
    );
}

/** Kolom Faktur / keterangan: nomor faktur menaut ke Faktur Penjualan; baris bermasalah menyebut tempat penyelesaiannya. */
function Keterangan({ o, row }: { o: OrderRow; row: OutboxRow | undefined }) {
    if (row?.state === "posted") {
        return row.accurateNumber ? <Link className="fi-mono" href={`/faktur?q=${encodeURIComponent(row.accurateNumber)}`}>{row.accurateNumber}</Link> : <span>terposting</span>;
    }
    if (row?.state === "rejected") return <span className="fi-why">{(row.lastError ?? "ditolak").slice(0, 120)} · <Link href="/antrean-faktur">Antrean Faktur</Link></span>;
    if (row?.state === "unknown") return <span className="fi-why">selesaikan di <Link href="/antrean-faktur">Antrean Faktur</Link></span>;
    if (row) return <span>menunggu Kirim di <Link href="/antrean-faktur">Antrean Faktur</Link></span>;
    if (o.result?.pending_price) return <span className="fi-subtle">{(o.result.lines ?? []).length} barang · belum berharga</span>;
    return <span className="fi-subtle">—</span>;
}
