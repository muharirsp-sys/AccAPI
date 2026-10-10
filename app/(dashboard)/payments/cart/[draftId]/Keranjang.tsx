/*
 * Tujuan: Wizard keranjang pengajuan (Fiori S6a, it08): langkah 2 Tinjau (rute, nomor SPPD berikutnya, tanggal bayar Finance WITA,
 *   potongan/jenis/keterangan per principal, rekening tiap principal dicek SEBELUM Ajukan) dan langkah 3 Diajukan (berkas + alur dokumen).
 *   Pengganti cart/[draftId]/page.tsx lama (toast, parseIdr longgar, tanggal UTC).
 * Caller: app/(dashboard)/payments/cart/[draftId]/page.tsx (props draftId, permKeys).
 * Dependensi: ../../bersama (baca, tulis, unduhUrl), components/fiori/*, lib/payments-ui, lib/promo-ui, next/link.
 * Main Functions: Keranjang (default), ajukan.
 * Side Effects: GET /payments/cart-info, /api/bank-data/lookup per principal (rute Bank Panin, izin sppd.view), /payments/sppd/settings
 *   (nomor berikutnya); POST /payments/cart/submit (payments.edit) — menerbitkan nomor SPPD, berkas invoice/SPPD, status Belum Transfer.
 *
 * Kenapa dikunci setelah jawaban tidak pasti: cart/submit bisa >180 dtk (membuat Excel + DOCX). Putus/timeout/≥502 = mungkin sudah
 * diajukan. Halaman memuat ulang draf: 404 = draf sudah terpakai (pengajuan dibuat; JANGAN ajukan lagi); masih ada = server menolak
 * pengajuan ganda (AM-013), jadi tombol dibuka lagi setelah draf terbaca ulang.
 */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Send } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { angka, hariIniWita, izinPembayaran, tanggalTampil } from "@/lib/payments-ui";
import { rupiah } from "@/lib/promo-ui";
import { BELUM_PASTI, baca, tulis, unduhUrl } from "../../bersama";

type Item = {
    no?: number | string; group_key: string; principle: string; tipe_pengajuan: string; total: number; invoice_concat?: string;
    potongan?: number; nilai_pembayaran?: number; jenis_pembayaran?: string; keterangan?: string;
};
type Cart = { items: Item[]; method: string; method_label: string; target_payment_date: string };
type Isi = { potongan: string; jenis: string; keterangan: string };
type Rekening = { status: string; data: { principle: string; bank: string; rekening: string; penerima: string; has_rekening: boolean } | null };
type Berkas = { label: string; url: string };

const JENIS = [["TRF", "TRF — transfer"], ["DF", "DF — Distributor Financing (DIFI)"], ["VA", "VA — virtual account"]] as const;
const isiAwal = (it: Item): Isi => ({ potongan: it.potongan ? String(it.potongan) : "", jenis: it.jenis_pembayaran ?? "", keterangan: it.keterangan ?? "" });

function galatPotongan(v: string, total: number): string | undefined {
    const n = angka(v);
    if (Number.isNaN(n)) return `“${v}” bukan angka rupiah.`;
    if (n < 0) return "Potongan tidak boleh minus.";
    if (n > total) return "Potongan melebihi nilai invoice.";
    return undefined;
}

export default function Keranjang({ draftId, permKeys }: { draftId: string; permKeys: string[] }) {
    const izin = izinPembayaran(permKeys);
    const [cart, muatCart] = useLoad(useCallback(() => baca(`/payments/cart-info?draft=${encodeURIComponent(draftId)}`, (d) => ({
        items: Array.isArray(d.items) ? (d.items as Item[]) : [], method: String(d.method ?? ""), method_label: String(d.method_label ?? ""),
        target_payment_date: String(d.target_payment_date ?? ""),
    }) as Cart, { nihil404: true }), [draftId]));
    const c = cart.data ?? undefined;
    const panin = c?.method === "BANK_PANIN";
    const principals = useMemo(() => [...new Set((c?.items ?? []).map((i) => i.principle))].sort(), [c]);
    const kunciPrincipal = principals.join("\u0000");

    // Rekening tiap principal (rute Panin): fungsi pencocokan yang sama dengan cart/submit (find_best_match), dicek sebelum Ajukan.
    const [rek, muatRek] = useLoad(useCallback(async (): Promise<Load<Record<string, Rekening>>> => {
        const daftar = kunciPrincipal ? kunciPrincipal.split("\u0000") : [];
        if (!panin || izin.lihatSppd || daftar.length === 0) return { status: "siap", data: {} };
        const hasil = await Promise.all(daftar.map((p) => baca(`/api/bank-data/lookup?principle=${encodeURIComponent(p)}`, (d) => d as unknown as Rekening)));
        const gagal = hasil.find((h) => h.status === "galat");
        if (gagal) return { status: "galat", error: gagal.error };
        return { status: "siap", data: Object.fromEntries(daftar.map((p, i) => [p, hasil[i].data as Rekening])) };
    }, [kunciPrincipal, panin, izin.lihatSppd]));
    const [nomor, muatNomor] = useLoad(useCallback(async () => (panin && !izin.lihatSppd
        ? baca("/payments/sppd/settings", (d) => ({ preview: String(d.preview_number ?? ""), terakhir: Number(d.effective_last_sequence ?? 0) }))
        : { status: "siap" as const, data: null }), [panin, izin.lihatSppd]));

    const [isi, setIsi] = useState<Record<string, Isi>>({});
    const [tanggal, setTanggal] = useState<string | null>(null);
    const nilai = (it: Item) => isi[it.group_key] ?? isiAwal(it);
    const ubah = (it: Item, p: Partial<Isi>) => setIsi((prev) => ({ ...prev, [it.group_key]: { ...nilai(it), ...p } }));
    const tgl = tanggal ?? c?.target_payment_date ?? "";
    const berubah = Object.keys(isi).length > 0 || tanggal !== null;

    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<{ id: string; files: Berkas[]; tanggal: string } | null>(null);
    // Jawaban tidak pasti: kunci sampai draf terbaca ulang (referensi data berganti).
    const [kunciPada, setKunciPada] = useState<Cart | null | undefined>(undefined);
    const tidakPasti = kunciPada !== undefined;
    const masihTerkunci = tidakPasti && (kunciPada === cart.data || cart.status !== "siap");
    useUnsavedGuard(berubah && !hasil);

    const items = c?.items ?? [];
    const baris = items.map((it) => {
        const v = nilai(it);
        const pot = angka(v.potongan);
        const galat = galatPotongan(v.potongan, it.total);
        return { it, v, galat, bayar: galat ? NaN : Math.max(it.total - pot, 0), pot: galat ? NaN : pot };
    });
    const totalInvoice = items.reduce((a, it) => a + it.total, 0);
    const totalBayar = baris.reduce((a, b) => a + (Number.isNaN(b.bayar) ? 0 : b.bayar), 0);
    const totalPotongan = baris.reduce((a, b) => a + (Number.isNaN(b.pot) ? 0 : b.pot), 0);
    const rekeningGagal = panin && !izin.lihatSppd && rek.status === "siap"
        ? principals.filter((p) => { const r = rek.data?.[p]; return !r || r.status !== "matched" || !r.data; }) : [];
    const kosongRek = panin && rek.status === "siap" ? principals.filter((p) => rek.data?.[p]?.data && !rek.data[p].data!.has_rekening) : [];

    const alasan = izin.keranjang
        ?? (cart.status !== "siap" ? (cart.status === "galat" ? "Keranjang gagal dimuat ulang; muat ulang dulu." : "Keranjang sedang dimuat.") : undefined)
        ?? (masihTerkunci ? "Hasil pengajuan sebelumnya belum pasti; tunggu keranjang dimuat ulang." : undefined)
        ?? (items.length === 0 ? "Keranjang kosong." : undefined)
        ?? (baris.some((b) => !b.v.jenis) ? "Jenis Pembayaran wajib diisi untuk semua baris." : undefined)
        ?? (baris.some((b) => b.galat) ? "Perbaiki potongan yang ditandai dulu." : undefined)
        ?? (!/^\d{4}-\d{2}-\d{2}$/.test(tgl) ? "Isi tanggal bayar Finance." : undefined)
        ?? (panin && !izin.lihatSppd && rek.status === "memuat" ? "Rekening sedang dicek." : undefined)
        ?? (panin && !izin.lihatSppd && rek.status === "galat" ? "Rekening belum bisa dicek; coba lagi sebelum mengajukan." : undefined)
        ?? (rekeningGagal.length ? `Rekening ${rekeningGagal.join(", ")} belum ditemukan di master rekening.` : undefined);

    async function ajukan() {
        const rows = baris.map(({ it, v }) => ({
            group_key: it.group_key, principle: it.principle, tipe_pengajuan: it.tipe_pengajuan, jenis_pembayaran: v.jenis,
            potongan: angka(v.potongan), nilai_pembayaran: Math.max(it.total - angka(v.potongan), 0), keterangan: v.keterangan,
        }));
        const res = await tulis("/payments/cart/submit", { draft_id: draftId, target_payment_date: tgl, items: rows });
        if (res.ok) {
            setHasil({ id: String(res.data.submission_id ?? ""), files: Array.isArray(res.data.files) ? (res.data.files as Berkas[]) : [], tanggal: tgl });
            setDialog(false);
            return;
        }
        if (res.tidakPasti) { setKunciPada(cart.data); muatCart(); }
        throw new Error(res.error);
    }

    const langkah = (n: number) => <Flow label="Langkah keranjang" steps={["Pilih", "Tinjau", "Diajukan"].map((label, i): FlowStep => ({ label, state: i < n ? "done" : i === n ? "current" : "todo" }))} />;
    const kepala = (judul: string, n: number) => (
        <ObjectPageHeader breadcrumbs={[{ label: "Pembayaran", href: "/payments" }, { label: "Keranjang" }]} title={judul} draft={berubah && !hasil}
            status={<StatusBadge tone="neu">Draf <span className="fi-mono">{draftId}</span></StatusBadge>} flow={langkah(n)}
            attributes={c ? [{ label: "Rute", value: c.method_label || c.method || "—" }, { label: "Nilai pembayaran", value: rupiah(totalBayar) }] : undefined} />
    );

    // ── Langkah 3: Diajukan ──
    if (hasil) {
        return (
            <div className="fi-page">
                {kepala("Pengajuan dibuat", 2)}
                <MessageStrip tone="pos" title={`Pengajuan ${hasil.id} dibuat.`}>
                    {items.length} principal berstatus Belum Transfer. Finance melihatnya di halaman Finance tanggal {tanggalTampil(hasil.tanggal)}.
                </MessageStrip>
                <Section title="Berkas" subtitle="tersimpan dan bisa dibuka lagi dari Pengajuan & SPPD">
                    <div className="fi-sect-in">
                        <ul className="fi-docs" aria-label="Berkas pengajuan">
                            {hasil.files.map((f) => {
                                const sppd = /\/sppd_[^/]*$/.test(f.url);
                                return (
                                    <li key={f.url} className="fi-doc">
                                        <b><FileText className="fi-icon" aria-hidden /> {f.label}</b>
                                        {sppd && izin.unduhSppd
                                            ? <span className="fi-small fi-subtle">{izin.unduhSppd}</span>
                                            : <a href={unduhUrl(f.url)} target="_blank" rel="noopener noreferrer">Unduh</a>}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </Section>
                <Section title="Alur dokumen" subtitle="BL-35">
                    <div className="fi-dflow">
                        <span className="fi-dnode"><b>{items.length} principal</b><span>Pembayaran</span></span>
                        <span aria-hidden>→</span>
                        <span className="fi-dnode"><b className="fi-mono">Draf {draftId}</b><span>keranjang</span></span>
                        <span aria-hidden>→</span>
                        <Link className="fi-dnode" href={`/payments/pengajuan/${encodeURIComponent(hasil.id)}`}><b className="fi-mono">Pengajuan {hasil.id}</b><span>{panin ? "SPPD Bank Panin" : "Non Panin"}</span></Link>
                        <span aria-hidden>→</span>
                        <span className="fi-dnode" data-off="true"><b>Finance</b><span>{tanggalTampil(hasil.tanggal)}</span></span>
                        <span aria-hidden>→</span>
                        <span className="fi-dnode" data-off="true"><b>Purchase Payment</b><span>belum</span></span>
                    </div>
                </Section>
                <FooterToolbar message="Pengajuan selesai; rekamannya terkunci sampai Finance mengembalikannya (Ajukan Ulang).">
                    <Link className="fi-btn fi-btn--secondary" href="/payments"><ArrowLeft className="fi-icon" aria-hidden />Pembayaran</Link>
                    <Link className="fi-btn fi-btn--primary" href={`/payments/pengajuan/${encodeURIComponent(hasil.id)}`}><FileText className="fi-icon" aria-hidden />Buka pengajuan</Link>
                </FooterToolbar>
            </div>
        );
    }

    // ── Memuat / Galat / Kosong ──
    let isi_: ReactNode;
    // Galat memuat ulang di atas keranjang kosong tetap galat — jangan tampil sebagai kosong.
    if (cart.status === "galat" && (cart.data === undefined || (cart.data !== null && cart.data.items.length === 0))) {
        isi_ = <ErrorState title="Keranjang gagal dimuat" message={cart.error} onRetry={muatCart} />;
    } else if (cart.data === undefined) {
        isi_ = <><Skeleton rows={3} label="Memuat keranjang" /><Skeleton rows={5} /></>;
    } else if (cart.data === null) {
        isi_ = (
            <>
                {tidakPasti && <MessageStrip tone="warn" title="Draf sudah terpakai.">Pengajuan kemungkinan sudah dibuat oleh kiriman yang jawabannya belum pasti. Jangan ajukan lagi; periksa di Pengajuan & SPPD.</MessageStrip>}
                <EmptyState title="Keranjang tidak ditemukan atau sudah diajukan"
                    message="Draf ini tidak ada lagi: sudah diajukan, atau bukan milik akun Anda. Buka Pengajuan & SPPD untuk melihat pengajuan, atau kembali ke Pembayaran untuk membuat keranjang baru."
                    action={<div className="fi-btnrow"><Link className="fi-btn fi-btn--secondary" href="/payments">Pembayaran</Link><Link className="fi-btn fi-btn--primary" href="/payments/pengajuan">Pengajuan & SPPD</Link></div>} />
            </>
        );
    } else if (items.length === 0) {
        isi_ = <EmptyState title="Keranjang ini kosong" message="Rekamannya sudah diajukan lewat pengajuan lain atau dihapus. Kembali ke Pembayaran dan pilih rekaman yang siap."
            action={<Link className="fi-btn fi-btn--secondary" href="/payments"><ArrowLeft className="fi-icon" aria-hidden />Pembayaran</Link>} />;
    } else {
        const c2 = cart.data;
        isi_ = (
            <div className={cart.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={cart.status === "memuat" || undefined}>
                {cart.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang keranjang.">{cart.error} Yang tampil adalah hasil sebelumnya; Ajukan dikunci. <Button variant="tertiary" onClick={muatCart}>Coba lagi</Button></MessageStrip>}
                {tidakPasti && <MessageStrip tone="warn" title="Hasil pengajuan sebelumnya belum pasti.">
                    {masihTerkunci ? BELUM_PASTI : "Draf masih ada saat dimuat ulang. Bila server masih memproses kiriman tadi, pengajuan kedua ditolak server (tidak ganda). Periksa Pengajuan & SPPD sebelum mengajukan lagi."}{" "}
                    <Link href="/payments/pengajuan">Pengajuan & SPPD</Link>
                </MessageStrip>}
                {rekeningGagal.length > 0 && <MessageStrip tone="neg" title={`Rekening ${rekeningGagal.join(", ")} tidak ditemukan di master rekening.`}>
                    SPPD Bank Panin butuh rekening setiap principal. Samakan nama di Format SPPD › Data rekening, atau ajukan principal itu lewat rute Non Panin (keranjang baru).{" "}
                    <Button variant="tertiary" onClick={muatRek}>Cek ulang rekening</Button>
                </MessageStrip>}
                {panin && !izin.lihatSppd && rek.status === "galat" && <MessageStrip tone="neg" title="Rekening belum bisa dicek.">{rek.error} Ajukan dikunci sampai rekening terbaca. <Button variant="tertiary" onClick={muatRek}>Coba lagi</Button></MessageStrip>}
                <Section title="Rute & tanggal">
                    <div className="fi-sect-in">
                        <KeyValues items={[
                            ["Rute", panin ? "Bank Panin — satu SPPD untuk semua principal di keranjang" : "Non Panin — tanpa SPPD; berkas invoice per principal"],
                            ...(panin ? [["Nomor SPPD bila diajukan", izin.lihatSppd ? <span key="n" className="fi-small fi-subtle">{izin.lihatSppd}</span>
                                : nomor.status === "galat" ? <span key="n" className="fi-why">Nomor belum bisa dibaca ({nomor.error}) <Button variant="tertiary" onClick={muatNomor}>Coba lagi</Button></span>
                                    : nomor.data ? <span key="n"><b className="fi-mono">{nomor.data.preview}</b> <span className="fi-small fi-subtle">perkiraan dari Format SPPD · terakhir {String(nomor.data.terakhir).padStart(3, "0")}; nomor final ditetapkan saat diajukan</span></span>
                                        : "…"] as [string, ReactNode]] : []),
                        ]} />
                        <FormField label="Tanggal bayar Finance" required help={`Finance melihat pengajuan ini di halaman Finance pada tanggal ini (Finance membuka tanggal hari ini ${tanggalTampil(hariIniWita())} WITA).`}>
                            {(a) => <input {...a} className="fi-input" style={{ maxWidth: 220 }} type="date" value={tgl} onChange={(e) => setTanggal(e.target.value === c2.target_payment_date ? null : e.target.value)} />}
                        </FormField>
                    </div>
                </Section>
                <Section title="Rincian" subtitle={`${items.length} principal · ${rupiah(totalInvoice)}`}>
                    <div className="fi-sect-in">
                        {baris.map(({ it, v, galat, bayar }) => {
                            const r = rek.data?.[it.principle];
                            return (
                                <article key={it.group_key} className="fi-panel" aria-label={`${it.principle} ${it.tipe_pengajuan}`}>
                                    <div className="fi-page-bar">
                                        <b>{it.principle}</b><span className="fi-small fi-subtle">{it.tipe_pengajuan}</span><span className="fi-spacer" />
                                        {panin && !izin.lihatSppd && (rek.status === "memuat" ? <StatusBadge tone="neu" busy>Mengecek rekening</StatusBadge>
                                            : rek.status === "galat" ? <StatusBadge tone="warn">Rekening belum dicek</StatusBadge>
                                                : r?.status === "matched" && r.data ? <StatusBadge tone={r.data.has_rekening ? "pos" : "warn"}>{r.data.has_rekening ? "Rekening cocok" : "Rekening kosong"}</StatusBadge>
                                                    : <StatusBadge tone="neg">Rekening tidak ditemukan</StatusBadge>)}
                                    </div>
                                    <span className="fi-codes">{it.invoice_concat || "—"}</span>
                                    {panin && r?.data && <span className="fi-small fi-subtle">{[r.data.bank, r.data.rekening, r.data.penerima].filter(Boolean).join(" · ")}</span>}
                                    {panin && r && r.status !== "matched" && <span className="fi-small fi-why">{r.status === "ambiguous" ? "Ambigu: lebih dari satu rekening cocok di master." : "Nama ini tidak cocok dengan master rekening."}</span>}
                                    <div className="fi-formgrid">
                                        <FormField label={`Potongan ${it.principle}`} error={galat} help={`Nilai invoice ${rupiah(it.total)} · nilai bayar ${Number.isNaN(bayar) ? "—" : rupiah(bayar)}`}>
                                            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" placeholder="0" value={v.potongan} onChange={(e) => ubah(it, { potongan: e.target.value })} />}
                                        </FormField>
                                        <FormField label={`Jenis pembayaran ${it.principle}`} required error={v.jenis ? undefined : "Wajib dipilih."}>
                                            {(a) => <select {...a} className="fi-input" value={v.jenis} onChange={(e) => ubah(it, { jenis: e.target.value })}>
                                                <option value="">Pilih…</option>{JENIS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                                            </select>}
                                        </FormField>
                                        <FormField label={`Keterangan ${it.principle}`}>
                                            {(a) => <input {...a} className="fi-input" value={v.keterangan} onChange={(e) => ubah(it, { keterangan: e.target.value })} />}
                                        </FormField>
                                    </div>
                                </article>
                            );
                        })}
                        <KeyValues items={[["Total invoice", rupiah(totalInvoice)], ["Potongan", rupiah(totalPotongan)], ["Nilai pembayaran", <b key="b">{rupiah(totalBayar)}</b>]]} />
                        {kosongRek.length > 0 && <MessageStrip tone="warn" title={`Nomor rekening ${kosongRek.join(", ")} kosong di master.`}>Server tetap menerima pengajuan; SPPD akan memuat rekening kosong untuk principal itu.</MessageStrip>}
                        {panin && izin.lihatSppd && <MessageStrip tone="info" title="Rekening tidak bisa dicek dari akun ini.">{izin.lihatSppd} Server tetap memeriksa rekening saat Ajukan.</MessageStrip>}
                    </div>
                </Section>
            </div>
        );
    }

    const siap = cart.data && items.length > 0;
    return (
        <div className="fi-page">
            {kepala("Keranjang pengajuan", 1)}
            {isi_}
            {siap && (
                <FooterToolbar message={alasan ? <span className="fi-why">{alasan}</span> : <span className="fi-sum">{rupiah(totalBayar)}{panin && nomor.data ? ` · SPPD ${nomor.data.preview}` : ""}</span>}>
                    <Link className="fi-btn fi-btn--tertiary" href="/payments"><ArrowLeft className="fi-icon" aria-hidden />Kembali</Link>
                    <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(alasan)} disabledReason={alasan} onClick={() => setDialog(true)}>Ajukan ke Finance…</Button>
                </FooterToolbar>
            )}
            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Ajukan ${items.length} principal ke Finance?`} tag={panin ? "SPPD" : "Non Panin"}
                confirmLabel="Ajukan ke Finance" confirmDisabled={alasan} onConfirm={ajukan}
                facts={[
                    ["Rute", panin ? `Bank Panin · 1 SPPD untuk ${items.length} principal` : "Non Panin · tanpa SPPD"],
                    ...(panin ? [["Nomor SPPD", nomor.data ? <span key="n" className="fi-mono">{nomor.data.preview} (perkiraan)</span> : "dibaca saat diajukan"] as [string, ReactNode]] : []),
                    ["Nilai pembayaran", <span key="v"><b>{rupiah(totalBayar)}</b> (potongan {rupiah(totalPotongan)})</span>],
                    ["Tanggal bayar Finance", `${tanggalTampil(tgl)} (WITA)`],
                    ...(panin && !izin.lihatSppd ? [["Rekening", `${principals.length - rekeningGagal.length} dari ${principals.length} cocok di master`] as [string, string]] : []),
                ]}>
                {panin && <MessageStrip tone="info" title="Nomor SPPD terpakai saat diajukan dan tidak kembali bila pengajuan dibatalkan." />}
            </ConfirmDialog>
        </div>
    );
}
