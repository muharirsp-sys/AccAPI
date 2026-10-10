/*
 * Tujuan: Layar Finance Fiori (S6b, it02 bagian Finance; ZONA AGENTS §3 TULIS ACCURATE + UANG): worklist pengajuan per tanggal bayar
 *   (WITA) + panel detail per pengajuan, status transfer terpisah dari status posting, tujuan pemasok/rekening dari master Accurate,
 *   dialog `pp` (Transfer & posting), `selesaipp` (Selesaikan posting tidak pasti, hanya Finance), dan dialog status transfer.
 * Caller: app/(dashboard)/finance/page.tsx.
 * Dependensi: ./posting (HTTP + orkestrasi tulis), lib/finance-ui (izin & keputusan murni), components/fiori/*, lib/promo-ui,
 *   lib/rekapan-nota/ui (tanggalPanjang), lib/fuzzySearch, lucide-react.
 * Main Functions: Finance (default), Detail, DialogSelesai.
 * Side Effects: Lewat ./posting: FastAPI /payments/finance/*, command /api/finance/purchase-payment (kirim purchase-payment ke
 *   Accurate), /resolve, /attempts, /api/proxy GET list.do; window.open ekspor Excel; beforeunload saat ada draf.
 */
"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, RefreshCw, RotateCcw, Save, Send, ShieldCheck, Undo2 } from "lucide-react";
import {
    Button, EmptyState, ErrorState, FlexibleColumnLayout, FooterToolbar, KeyValues, ListItem, MessageStrip, ObjectPageHeader, Section, Skeleton,
    StatusBadge, type Tone,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import {
    LABEL_POSTING, alasanFaktur, alasanTidakAda, catatanPosting, izinFinance, kodeTampil, kunciBaris, statusPosting, statusTransfer,
    type AttemptFinance, type StatusPosting,
} from "@/lib/finance-ui";
import { rupiah, tgl } from "@/lib/promo-ui";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import {
    SeparuhJalan, TidakPasti, bacaSesi, muatFinance, muatMaster, postingPurchasePayment, recordKey, selesaikanTidakPasti, simpanTujuan, ubahStatusTransfer, urlBerkas,
    type DataFinance, type FinanceMapping, type FinanceRecord, type MasterAccurate, type SesiAccurate,
} from "./posting";

type Saring = "semua" | "belum" | "tidak_pasti" | "terposting";
type Hasil = { tone: Exclude<Tone, "neu">; judul: string; isi?: string };
type Dialog = { jenis: "pp" | "selesai" | "belum" | "ulang"; key: string; /** Date.now() saat dibuka (umur attempt). */ pada: number } | null;
type Baris = { r: FinanceRecord; key: string; attempt: AttemptFinance | null; posting: StatusPosting };

const KOSONG_MAP: FinanceMapping = {};
const orang = (id?: string | null) => String(id || "").split("|").pop() || "";
/** Salinan objek tanpa satu kunci (draf per pengajuan). */
function tanpa<T>(obj: Record<string, T>, key: string): Record<string, T> {
    const next = { ...obj };
    delete next[key];
    return next;
}

export default function Finance({ permKeys, hariIni }: { permKeys: string[]; hariIni: string }) {
    const izin = useMemo(() => izinFinance(new Set(permKeys)), [permKeys]);
    const [tanggal, setTanggal] = useState(hariIni);
    const [load, muatUlang] = useLoad(useCallback(() => muatFinance(tanggal), [tanggal]));
    const [pilihKey, setPilihKey] = useState<string | null>(null);
    const [pernahPilih, setPernahPilih] = useState(false);
    const [saring, setSaring] = useState<Saring>("semua");
    const [cari, setCari] = useState("");
    const [drafTujuan, setDrafTujuan] = useState<Record<string, FinanceMapping>>({});
    const [drafTanggal, setDrafTanggal] = useState<Record<string, string>>({});
    const [bukti, setBukti] = useState<Record<string, File | null>>({});
    const [kunciLokal, setKunciLokal] = useState<ReadonlySet<string>>(new Set());
    const [hasil, setHasil] = useState<Hasil | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [menyimpan, setMenyimpan] = useState<string | null>(null);
    const [galatTujuan, setGalatTujuan] = useState<{ key: string; pesan: string } | null>(null);
    // Klik ganda / dua dialog untuk pengajuan yang sama: ref sinkron menahan kiriman kedua sejak awal (review #3 kode lama).
    const postingRef = useRef(new Set<string>());

    const data = load.data;
    const sesi = data?.sesi ?? null;
    const masterAktif = pernahPilih && Boolean(sesi?.tersambung) && !izin.tujuan;
    // Ganti database Accurate = master lain: kuncinya ikut id database sesi.
    const kunciMaster = masterAktif ? sesi?.id || "ya" : "";
    const [master, muatUlangMaster] = useLoad(useCallback(async (): Promise<Load<MasterAccurate>> => (kunciMaster ? muatMaster() : { status: "memuat" }), [kunciMaster]));

    const baris: Baris[] = useMemo(() => (data?.rows ?? []).map((r) => {
        const key = recordKey(r);
        const attempt = data?.attempts.get(key) ?? null;
        return { r, key, attempt, posting: statusPosting(r, attempt, { key, dbId: data?.sesi?.id ?? "", terbaca: !data?.attemptsGalat }) };
    }), [data]);

    // Tulis terkunci saat sumber memuat ulang, gagal dimuat ulang, atau status posting server tidak terbaca.
    const sumber = load.status === "memuat" && data ? "Data sedang dimuat ulang; tunggu sebentar."
        : load.status === "galat" && data ? "Data gagal dimuat ulang; yang tampil hasil sebelumnya. Muat ulang dulu."
        : data?.attemptsGalat ? "Status posting dari server tidak terbaca; muat ulang dulu."
        : undefined;

    const tujuanDari = (b: Baris) => drafTujuan[b.key] ?? b.r.mapping ?? KOSONG_MAP;
    const tujuanBerubah = (b: Baris) => {
        const d = drafTujuan[b.key];
        const m = b.r.mapping ?? KOSONG_MAP;
        return Boolean(d) && ((d!.vendorNo || "") !== (m.vendorNo || "") || (d!.bankNo || "") !== (m.bankNo || ""));
    };
    const tanggalTransfer = (b: Baris) => drafTanggal[b.key] ?? (b.r.transfer_date || b.r.submitted_date || data?.date || "");
    const drafBaris = (b: Baris) => tujuanBerubah(b) || Boolean(bukti[b.key]);
    const adaDraf = baris.some(drafBaris);
    useUnsavedGuard(adaDraf);

    const hitung = useMemo(() => {
        const belum = baris.filter((b) => statusTransfer(b.r.status_pembayaran).label === "Belum transfer");
        const tp = baris.filter((b) => kodeTampil(b.posting.kode, kunciLokal.has(b.key)) === "tidak_pasti");
        const ok = baris.filter((b) => b.posting.kode === "terposting");
        const jumlah = (xs: Baris[]) => xs.reduce((t, b) => t + Number(b.r.total_nilai || 0), 0);
        return { belum, tp, ok, nBelum: jumlah(belum), nOk: jumlah(ok) };
    }, [baris, kunciLokal]);

    const tampil = useMemo(() => {
        const q = cari.trim();
        const pool = saring === "belum" ? hitung.belum : saring === "tidak_pasti" ? hitung.tp : saring === "terposting" ? hitung.ok : baris;
        return q ? pool.filter((b) => fuzzyMatch(b.r.principle, q) || fuzzyMatch(b.r.draft_label, q) || fuzzyMatch(b.r.invoice_concat, q) || fuzzyMatch(b.r.sppd_no || "", q)) : pool;
    }, [baris, hitung, saring, cari]);

    const terpilih = baris.find((b) => b.key === pilihKey) ?? null;
    const dialogBaris = dialog ? baris.find((b) => b.key === dialog.key) ?? null : null;

    const pilih = (key: string | null) => { setPilihKey(key); if (key) setPernahPilih(true); };
    const kunciBarisIni = (b: Baris) => kunciBaris({ posting: b.posting, izin, sumber, kunciLokal: kunciLokal.has(b.key) });

    /** Alasan Transfer & posting nonaktif (keadaan baris dulu, lalu kelengkapan isian). */
    const alasanPosting = (b: Baris): string | undefined => {
        const k = kunciBarisIni(b).posting;
        if (k) return k;
        if (!sesi) return data?.sesiGalat || "Sesi Accurate tidak terbaca; muat ulang.";
        if (!sesi.tersambung) return "Login dan buka database Accurate dulu.";
        const faktur = alasanFaktur(b.r.detail_invoices);
        if (faktur) return faktur;
        if (!(Number(b.r.total_nilai) > 0)) return "Nilai dibayar 0; tidak ada yang bisa diposting.";
        const t = tujuanDari(b);
        if (!t.vendorNo || !t.bankNo) return "Pilih pemasok dan rekening bank Accurate dulu.";
        if (master.status === "galat") return "Daftar pemasok/rekening Accurate belum terbaca; muat ulang daftar.";
        if (!master.data) return "Memuat daftar pemasok/rekening Accurate…";
        if (!master.data.terpotong && (!master.data.pemasok.some((o) => o.no === t.vendorNo) || !master.data.rekening.some((o) => o.no === t.bankNo))) {
            return "Pemasok atau rekening tersimpan tidak ada di master Accurate database ini; pilih ulang.";
        }
        if (!tanggalTransfer(b)) return "Isi tanggal transfer.";
        if (!b.r.transfer_proof?.proof_id && !bukti[b.key]) return "Unggah bukti transfer.";
        return undefined;
    };

    const kunciLepas = (key: string) => setKunciLokal((s) => { const n = new Set(s); n.delete(key); return n; });
    const bersihkanDraf = (key: string) => {
        setDrafTujuan((s) => tanpa(s, key));
        setDrafTanggal((s) => tanpa(s, key));
        setBukti((s) => tanpa(s, key));
    };

    /** `tujuanDb` = database yang ditampilkan dialog posting (BL-03) dari bacaan SEGAR (dikirim sebagai expectedDatabaseId). */
    async function jalankanPosting(tujuanDb: SesiAccurate) {
        const b = dialogBaris;
        if (!b || !data) throw new Error("Pengajuan tidak ada lagi di daftar; muat ulang.");
        if (postingRef.current.has(b.key)) return;
        postingRef.current.add(b.key);
        try {
            const total = rupiah(b.r.total_nilai);
            const h = await postingPurchasePayment({
                record: b.r, mapping: tujuanDari(b), transferDate: tanggalTransfer(b), proofFile: bukti[b.key] ?? null, date: data.date,
                kunciLokal: () => setKunciLokal((s) => new Set(s).add(b.key)), expectedDatabaseId: tujuanDb.id,
            });
            // Belum ada yang ditulis ke mana pun: dialog tetap terbuka dengan pesannya.
            if (h.jenis === "tidak_terkirim" && !h.tercatat) throw new Error(`${h.pesan} Tidak ada yang dikirim ke Accurate.`);
            setDialog(null);
            if (h.jenis === "terposting") {
                bersihkanDraf(b.key);
                setHasil({ tone: "pos", judul: `Terposting ${h.nomor} · ${total} · ${tujuanDb.alias || `ID ${tujuanDb.id}`}`, isi: h.catatan ? "Hasil posting sebelumnya dicatat; tidak ada kiriman baru ke Accurate." : `${b.r.draft_label} · ${b.r.principle}. Status transfer dan posting dimuat ulang.` });
            } else if (h.jenis === "sedang") {
                setHasil({ tone: "info", judul: `${b.r.draft_label} sedang diposting dari sesi atau tab lain.`, isi: `${h.pesan} Status dimuat ulang; jangan posting lagi dari sini.` });
            } else if (h.jenis === "tidak_pasti" && h.nomor) {
                // Accurate sudah menjawab nomor PP, tetapi catatan Finance tidak tersimpan: setelah muat ulang, "Catat hasil posting".
                setHasil({ tone: "warn", judul: `Hasilnya belum pasti — ${b.r.draft_label} dikunci.`, isi: `Accurate menjawab Purchase Payment ${h.nomor}, tetapi catatan Finance belum tersimpan (${h.pesan}). Jangan posting ulang: setelah dimuat ulang, tekan Catat hasil posting.` });
            } else if (h.jenis === "tidak_pasti") {
                setHasil({ tone: "warn", judul: `Hasilnya belum pasti — ${b.r.draft_label} dikunci.`, isi: `${h.pesan} Jangan posting ulang: Finance memeriksa Purchase Payment di Accurate lalu menyelesaikannya.` });
            } else if (h.jenis === "gagal") {
                // C11: Accurate tidak pernah "menolak" di sini — `gagal` = koneksi ke Accurate tak pernah terbentuk (not_sent).
                setHasil({ tone: "neg", judul: `Posting ${b.r.draft_label} tidak sampai ke Accurate.`, isi: `${h.pesan} Tidak ada yang tersimpan di Accurate; boleh diposting ulang setelah diperbaiki.` });
            } else {
                setHasil({ tone: "neg", judul: `Tidak ada yang dikirim ke Accurate untuk ${b.r.draft_label}.`, isi: `${h.pesan} Status tercatat Posting gagal; boleh diposting ulang setelah diperbaiki.` });
            }
            muatUlang();
        } finally {
            postingRef.current.delete(b.key);
        }
    }

    async function jalankanStatus(status: "Belum Transfer" | "Ajukan Ulang") {
        const b = dialogBaris;
        if (!b || !data) throw new Error("Pengajuan tidak ada lagi di daftar; muat ulang.");
        try {
            await ubahStatusTransfer(b.r, data.date, status);
        } catch (e) {
            if (!(e instanceof TidakPasti)) throw e;
            setDialog(null);
            setHasil({ tone: "warn", judul: "Hasil ubah status belum pasti.", isi: `${e.message} Data dimuat ulang — periksa statusnya sebelum mengulang.` });
            muatUlang();
            return;
        }
        setDialog(null);
        setHasil({ tone: "pos", judul: status === "Belum Transfer" ? `${b.r.draft_label} ditandai belum transfer.` : `${b.r.draft_label} dikembalikan ke Pembayaran.` });
        muatUlang();
    }

    async function jalankanSelesai(p: { ada: boolean; nomor: string; sumber: string; alasan: string }) {
        const b = dialogBaris;
        if (!b || !data) throw new Error("Pengajuan tidak ada lagi di daftar; muat ulang.");
        let nomor: string;
        try {
            nomor = await selesaikanTidakPasti({ record: b.r, date: data.date, ...p });
        } catch (e) {
            if (e instanceof SeparuhJalan) {
                setDialog(null);
                setHasil({ tone: "warn", judul: "Penyelesaian baru tercatat sebagian.", isi: `${e.message} Tutup pesan ini lalu periksa status pengajuan setelah dimuat ulang; pengajuan tetap dikunci.` });
                muatUlang();
                return;
            }
            if (!(e instanceof TidakPasti)) throw e;
            setDialog(null);
            setHasil({ tone: "warn", judul: "Hasil penyelesaian belum pasti.", isi: `${e.message} Data dimuat ulang — periksa statusnya sebelum mengulang.` });
            muatUlang();
            return;
        }
        kunciLepas(b.key);
        setDialog(null);
        setHasil(nomor
            ? { tone: "pos", judul: `${b.r.draft_label} ditandai terposting ${nomor} (diperiksa manual).` }
            : { tone: "pos", judul: `${b.r.draft_label} ditandai tidak ada di Accurate.`, isi: "Pengajuan boleh diposting ulang." });
        muatUlang();
    }

    async function simpanTujuanBaris(b: Baris) {
        setMenyimpan(b.key);
        setGalatTujuan(null);
        try {
            await simpanTujuan(b.r, tujuanDari(b));
            setDrafTujuan((s) => tanpa(s, b.key));
            setHasil({ tone: "pos", judul: `Tujuan ${b.r.principle} tersimpan.`, isi: "Berlaku untuk pengajuan principal ini berikutnya." });
            muatUlang();
        } catch (e) {
            const tidakPasti = e instanceof TidakPasti;
            setGalatTujuan({ key: b.key, pesan: tidakPasti ? `${e.message} Hasil simpan belum pasti; data dimuat ulang.` : e instanceof Error ? e.message : "Tujuan gagal disimpan." });
            if (tidakPasti) muatUlang();
        } finally {
            setMenyimpan(null);
        }
    }

    const memuatAwal = load.status === "memuat" && !data;
    const kosongHari = data && data.rows.length === 0;

    const daftar = (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }}>
            <header>
                <h2>Pengajuan</h2>
                <span>{data ? `${tampil.length}${tampil.length !== baris.length ? ` dari ${baris.length}` : ""}` : ""}{load.status === "memuat" && data ? " · memperbarui…" : ""}</span>
            </header>
            <div className="fi-sect-in">
                <FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Principal, draf, faktur, SPPD" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>
            </div>
            {memuatAwal ? <div className="fi-sect-in"><Skeleton rows={6} label="Memuat pengajuan" /></div>
                : load.status === "galat" && !data ? <ErrorState title="Server Pembayaran tidak menjawab" message={`${load.error ?? ""} Data di Accurate tidak berubah.`} onRetry={muatUlang} />
                : kosongHari ? <EmptyState title={`Tidak ada pengajuan untuk ${tanggalPanjang(data.date)}`} message="Pengajuan muncul di sini setelah diajukan dari Pembayaran / SPPD dengan tanggal bayar ini. Ganti tanggal untuk melihat hari lain." />
                : tampil.length === 0 ? <EmptyState title="Tidak ada pengajuan yang sesuai saringan" message="Ubah kata kunci atau pilih kartu Semua." />
                : (
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Daftar pengajuan">
                        {tampil.map((b) => {
                            const pt = LABEL_POSTING[kodeTampil(b.posting.kode, kunciLokal.has(b.key))];
                            const t = tujuanDari(b);
                            return (
                                <li key={b.key} className="fi-wl-row">
                                    <ListItem current={pilihKey === b.key} onClick={() => pilih(b.key)}
                                        doc={b.r.draft_label} amount={<span className="fi-tnum">{rupiah(b.r.total_nilai)}</span>}
                                        title={`${b.r.principle} · ${b.r.tipe_pengajuan} · ${b.r.sppd_no || "tanpa SPPD"} · ${b.r.detail_invoices?.length ?? 0} faktur`}
                                        meta={`${statusTransfer(b.r.status_pembayaran, b.r.transfer_date).label}${t.vendorNo && t.bankNo ? "" : " · tujuan belum dipetakan"}${drafBaris(b) ? " · draf" : ""}`}
                                        badge={<StatusBadge tone={pt.tone} busy={b.posting.kode === "sedang"}>{pt.label}{b.posting.nomor ? ` ${b.posting.nomor}` : ""}</StatusBadge>} />
                                </li>
                            );
                        })}
                    </ul>
                )}
            {data && <div className="fi-sect-in"><p className="fi-small fi-subtle">Total tanggal ini <b className="fi-tnum">{rupiah(data.total)}</b> · status transfer dan status posting dipisah.</p></div>}
        </div>
    );

    const detail = !terpilih || !data ? (
        <EmptyState title="Pilih pengajuan di daftar" message="Ringkasan, tujuan di Accurate, transfer, dan posting tampil di sini." />
    ) : (
        <Detail key={terpilih.key} b={terpilih} data={data} kunci={kunciBarisIni(terpilih)} alasanPosting={alasanPosting(terpilih)} kunciLokal={kunciLokal.has(terpilih.key)}
            tujuan={tujuanDari(terpilih)} tujuanBerubah={tujuanBerubah(terpilih)} tanggalTransfer={tanggalTransfer(terpilih)} bukti={bukti[terpilih.key] ?? null}
            master={master} masterAktif={masterAktif} izin={izin} menyimpan={menyimpan === terpilih.key} galatTujuan={galatTujuan?.key === terpilih.key ? galatTujuan.pesan : undefined}
            onTujuan={(t) => setDrafTujuan((s) => ({ ...s, [terpilih.key]: { ...tujuanDari(terpilih), ...t } }))}
            onTanggal={(v) => setDrafTanggal((s) => ({ ...s, [terpilih.key]: v }))}
            onBukti={(f) => setBukti((s) => ({ ...s, [terpilih.key]: f }))}
            onSimpanTujuan={() => void simpanTujuanBaris(terpilih)} onMuatMaster={muatUlangMaster}
            onDialog={(jenis) => setDialog({ jenis, key: terpilih.key, pada: Date.now() })} />
    );

    const kartu: Array<{ k: Saring; label: string; n: number | null; kecil?: string; tone?: Tone }> = [
        { k: "semua", label: "Semua pengajuan", n: data ? baris.length : null, kecil: data ? rupiah(data.total) : undefined },
        { k: "belum", label: "Belum transfer", n: data ? hitung.belum.length : null, kecil: data ? rupiah(hitung.nBelum) : undefined },
        { k: "tidak_pasti", label: "Posting tidak pasti", n: data ? hitung.tp.length : null, kecil: "diselesaikan Finance", tone: hitung.tp.length ? "warn" : undefined },
        { k: "terposting", label: "Terposting", n: data ? hitung.ok.length : null, kecil: data ? rupiah(hitung.nOk) : undefined },
    ];

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">Finance</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Transfer &amp; posting</h1>
                    {sesi?.tersambung
                        ? <StatusBadge tone="info">Database Accurate: {sesi.alias || `ID ${sesi.id}`}</StatusBadge>
                        : data ? <StatusBadge tone="warn">{sesi ? "Belum terhubung ke database Accurate" : "Sesi Accurate tidak terbaca"}</StatusBadge> : null}
                    <span className="fi-spacer" />
                    <label className="fi-small" htmlFor="fin-tanggal">Tanggal bayar (WITA)</label>
                    <input id="fin-tanggal" className="fi-input" type="date" value={tanggal} onChange={(e) => { if (e.target.value) setTanggal(e.target.value); }} />
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && Boolean(data)} onClick={muatUlang}>Muat ulang</Button>
                    <Button icon={<Download className="fi-icon" aria-hidden />} disabled={Boolean(izin.ekspor)} disabledReason={izin.ekspor}
                        onClick={() => window.open(urlBerkas(`/payments/finance/export?from=${encodeURIComponent(data?.date || tanggal)}&to=${encodeURIComponent(data?.date || tanggal)}`), "_blank")}>Ekspor Excel</Button>
                </div>
                <p>Pengajuan pembayaran ke principal per tanggal bayar. Transfer ditandai di sini dan Purchase Payment diposting ke Accurate dalam satu langkah lewat server (dicatat per percobaan; posting ganda ditolak).</p>
                {izin.ekspor && <p className="fi-small fi-why">{izin.ekspor}</p>}
            </header>

            {hasil && <MessageStrip tone={hasil.tone} title={hasil.judul} onClose={() => setHasil(null)}>{hasil.isi}</MessageStrip>}
            {load.status === "galat" && data && <MessageStrip tone="neg" title="Gagal memuat ulang pengajuan.">{load.error} Yang tampil hasil sebelumnya; aksi tulis dikunci. <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button></MessageStrip>}
            {data?.attemptsGalat && <MessageStrip tone="warn" title="Status posting dari server tidak terbaca.">{data.attemptsGalat} Posting dan penyelesaian dikunci sampai statusnya terbaca. <Button variant="tertiary" onClick={muatUlang}>Muat ulang</Button></MessageStrip>}

            {memuatAwal ? <div className="fi-panel"><Skeleton rows={2} label="Memuat ringkasan" /></div> : load.status === "galat" && !data ? null : (
                <div className="fi-kcards" role="group" aria-label="Saring menurut status">
                    {kartu.map((k) => (
                        <button key={k.k} type="button" className="fi-kc" aria-pressed={saring === k.k} data-tone={k.tone} onClick={() => setSaring(k.k)}>
                            <span>{k.label}</span><b>{k.n ?? "–"}</b>{k.kecil && <small>{k.kecil}</small>}
                        </button>
                    ))}
                </div>
            )}

            <FlexibleColumnLayout list={daftar} detail={detail} detailOpen={Boolean(terpilih)} onBack={() => pilih(null)} listLabel="Daftar pengajuan" detailLabel="Detail pengajuan" />

            {dialogBaris && (
                <>
                    <DialogPosting open={dialog?.jenis === "pp"} onClose={() => setDialog(null)} b={dialogBaris} dbDimuat={sesi?.id ?? ""}
                        tujuan={tujuanDari(dialogBaris)} tanggalTransfer={tanggalTransfer(dialogBaris)} bukti={bukti[dialogBaris.key] ?? null}
                        blokir={alasanPosting(dialogBaris)} onConfirm={jalankanPosting} />
                    <ConfirmDialog open={dialog?.jenis === "belum" || dialog?.jenis === "ulang"} onClose={() => setDialog(null)} tag="Status transfer"
                        title={dialog?.jenis === "ulang" ? `Kembalikan ${dialogBaris.r.draft_label} ke Pembayaran?` : `Tandai ${dialogBaris.r.draft_label} belum transfer?`}
                        confirmLabel={dialog?.jenis === "ulang" ? "Kembalikan ke Pembayaran" : "Tandai belum transfer"}
                        confirmDisabled={kunciBarisIni(dialogBaris).status}
                        facts={[
                            ["Pengajuan", `${dialogBaris.r.draft_label} · ${dialogBaris.r.principle} · ${rupiah(dialogBaris.r.total_nilai)}`],
                            ["Status sekarang", statusTransfer(dialogBaris.r.status_pembayaran, dialogBaris.r.transfer_date).label],
                            ["Akibat", dialog?.jenis === "ulang"
                                ? "Rekaman pengajuan ini terbuka lagi di Pembayaran untuk diubah lalu diajukan ulang; Finance tidak memprosesnya sampai diajukan lagi."
                                : "Status transfer kembali Belum transfer. Tidak ada yang dikirim ke Accurate."],
                        ]}
                        onConfirm={() => jalankanStatus(dialog?.jenis === "ulang" ? "Ajukan Ulang" : "Belum Transfer")}>
                        {kunciBarisIni(dialogBaris).status && <p className="fi-small fi-why">{kunciBarisIni(dialogBaris).status}</p>}
                    </ConfirmDialog>
                    <DialogSelesai open={dialog?.jenis === "selesai"} onClose={() => setDialog(null)} b={dialogBaris} data={data!} dibuka={dialog?.pada ?? 0}
                        blokir={kunciBarisIni(dialogBaris).selesaikan} onConfirm={jalankanSelesai} />
                </>
            )}
        </div>
    );
}

type DetailProps = {
    b: Baris; data: DataFinance; kunci: ReturnType<typeof kunciBaris>; alasanPosting?: string; kunciLokal: boolean;
    tujuan: FinanceMapping; tujuanBerubah: boolean; tanggalTransfer: string; bukti: File | null;
    master: Load<MasterAccurate>; masterAktif: boolean; izin: ReturnType<typeof izinFinance>; menyimpan: boolean; galatTujuan?: string;
    onTujuan: (t: FinanceMapping) => void; onTanggal: (v: string) => void; onBukti: (f: File | null) => void;
    onSimpanTujuan: () => void; onMuatMaster: () => void; onDialog: (jenis: "pp" | "selesai" | "belum" | "ulang") => void;
};

/** Panel detail satu pengajuan (Object Page ringkas): ringkasan, tagihan, tujuan, transfer, posting, aksi. */
function Detail(p: DetailProps) {
    const { b, data, kunci } = p;
    const r = b.r;
    const kode = kodeTampil(b.posting.kode, p.kunciLokal);
    const tr = statusTransfer(r.status_pembayaran, r.transfer_date);
    const pt = LABEL_POSTING[kode];
    const a = b.attempt;
    const sesi = data.sesi;
    const db = (id: string) => (id && sesi?.id === id ? sesi.alias || `ID ${id}` : id ? `ID ${id}` : "–");
    const tujuanTerkunci = kunci.tujuan;
    const alasanSimpan = tujuanTerkunci ?? (!p.tujuanBerubah ? "belum ada perubahan tujuan." : !p.tujuan.vendorNo || !p.tujuan.bankNo ? "pilih pemasok dan rekening dulu." : undefined);
    const postingTerkunci = Boolean(kunci.posting) && !(kode === "terposting" && b.posting.catatanTertinggal);
    const catatan = catatanPosting(kode, r.accurate_post_error || a?.message || "", r.accurate_post_status_raw || "");
    const sudahBelum = statusTransfer(r.status_pembayaran).label === "Belum transfer";
    const opsi = (daftar: Array<{ no: string; nama: string }>, nilai?: string, nama?: string) => {
        const ada = !nilai || daftar.some((o) => o.no === nilai);
        return (
            <>
                <option value="">Pilih dari Accurate…</option>
                {!ada && <option value={nilai}>{`${nilai} · ${nama || ""} (tidak ada di master Accurate)`}</option>}
                {daftar.map((o) => <option key={o.no} value={o.no}>{`${o.no} · ${o.nama}`}</option>)}
            </>
        );
    };

    const alasanLain = [
        kunci.status && `Kembalikan / tandai belum transfer: ${kunci.status}`,
        !kunci.status && sudahBelum && "Tandai belum transfer: status sudah Belum transfer.",
        kode === "tidak_pasti" && kunci.selesaikan && `Selesaikan: ${kunci.selesaikan}`,
    ].filter(Boolean) as string[];
    const label = b.posting.catatanTertinggal ? "Catat hasil posting…" : "Transfer & posting…";

    let tujuanIsi: ReactNode;
    if (p.izin.tujuan || !sesi?.tersambung || !p.masterAktif) {
        tujuanIsi = (
            <>
                <KeyValues items={[["Pemasok", p.tujuan.vendorNo ? `${p.tujuan.vendorNo} · ${p.tujuan.vendorName || ""}` : "Belum dipetakan"], ["Rekening bank", p.tujuan.bankNo ? `${p.tujuan.bankNo} · ${p.tujuan.bankName || ""}` : "Belum dipetakan"]]} />
                <p className="fi-small fi-why">{p.izin.tujuan ?? (!sesi?.tersambung ? "Pilihan pemasok dan rekening butuh database Accurate yang terbuka." : "")}</p>
            </>
        );
    } else if (p.master.status === "galat" && !p.master.data) {
        tujuanIsi = <ErrorState title="Daftar pemasok/rekening Accurate gagal dimuat" message={`${p.master.error ?? ""} Tujuan tersimpan: ${p.tujuan.vendorNo || "–"} / ${p.tujuan.bankNo || "–"}.`} onRetry={p.onMuatMaster} />;
    } else if (!p.master.data) {
        tujuanIsi = <Skeleton rows={2} label="Memuat daftar pemasok dan rekening Accurate" />;
    } else {
        const m = p.master.data;
        const vendorAsing = Boolean(p.tujuan.vendorNo) && !m.pemasok.some((o) => o.no === p.tujuan.vendorNo);
        const bankAsing = Boolean(p.tujuan.bankNo) && !m.rekening.some((o) => o.no === p.tujuan.bankNo);
        tujuanIsi = (
            <>
                <FormField label="Pemasok" required error={vendorAsing && !m.terpotong ? "Pemasok ini tidak ada di master Accurate database ini." : undefined}
                    help={`Berlaku untuk semua pengajuan ${r.principle}.`}>
                    {(a11y) => <select {...a11y} className="fi-input" value={p.tujuan.vendorNo || ""} disabled={Boolean(tujuanTerkunci)}
                        onChange={(e) => p.onTujuan({ vendorNo: e.target.value, vendorName: m.pemasok.find((o) => o.no === e.target.value)?.nama || "" })}>
                        {opsi(m.pemasok, p.tujuan.vendorNo, p.tujuan.vendorName)}</select>}
                </FormField>
                <FormField label="Rekening bank" required error={bankAsing && !m.terpotong ? "Rekening ini tidak ada di master Kas/Bank Accurate." : !p.tujuan.bankNo ? "Rekening wajib sebelum posting." : undefined}>
                    {(a11y) => <select {...a11y} className="fi-input" value={p.tujuan.bankNo || ""} disabled={Boolean(tujuanTerkunci)}
                        onChange={(e) => p.onTujuan({ bankNo: e.target.value, bankName: m.rekening.find((o) => o.no === e.target.value)?.nama || "" })}>
                        {opsi(m.rekening, p.tujuan.bankNo, p.tujuan.bankName)}</select>}
                </FormField>
                {m.terpotong && <p className="fi-small fi-subtle">Daftar Accurate dipotong pada 10.000 baris; pilihan di luar daftar tidak diperiksa.</p>}
                {p.galatTujuan && <MessageStrip tone="neg" title={p.galatTujuan} />}
                <div className="fi-btnrow">
                    <Button icon={<Save className="fi-icon" aria-hidden />} busy={p.menyimpan} disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={p.onSimpanTujuan}>Simpan tujuan</Button>
                    <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={p.onMuatMaster}>Muat ulang daftar</Button>
                </div>
                {alasanSimpan && !p.menyimpan && <p className="fi-small fi-why">Simpan tujuan: {alasanSimpan}</p>}
            </>
        );
    }

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <ObjectPageHeader title={`${r.draft_label} · ${r.principle}`} draft={p.tujuanBerubah}
                status={<><StatusBadge tone={tr.tone}>{tr.label}</StatusBadge> <StatusBadge tone={pt.tone} busy={kode === "sedang"}>{pt.label}{b.posting.nomor ? ` ${b.posting.nomor}` : ""}</StatusBadge></>}
                attributes={[
                    { label: "SPPD", value: r.sppd_no || "–" },
                    { label: "Jenis", value: `${r.tipe_pengajuan}${r.payment_method ? ` · ${r.payment_method}` : ""}` },
                    { label: "Tanggal bayar", value: tgl(r.submitted_date) },
                ]} />

            {kode === "tidak_pasti" && (
                <MessageStrip tone="warn" title="Posting tidak pasti — pengajuan dikunci.">
                    {catatan || "Hasil posting terakhir belum pasti."} Jangan posting ulang sebelum Finance memeriksa Purchase Payment di Accurate.
                </MessageStrip>
            )}
            {kode === "sedang" && <MessageStrip tone="info" title="Sedang diposting dari sesi atau tab lain.">{a ? `Dimulai ${a.createdAtWita} WITA oleh ${a.actorName || "pengguna lain"}.` : ""} Muat ulang beberapa saat lagi.</MessageStrip>}
            {kode === "gagal" && catatan && <MessageStrip tone="neg" title={catatan} />}
            {kode === "tak_terbaca" && <MessageStrip tone="warn" title="Status posting tidak terbaca.">Belum diketahui apakah pengajuan ini sudah diposting; posting dan ubah status dikunci sampai dimuat ulang.</MessageStrip>}

            <Section title="Ringkasan">
                <div className="fi-sect-in">
                    <KeyValues items={[
                        ["Total faktur", <span key="f" className="fi-tnum">{rupiah(r.total_invoice)}</span>],
                        ["Potongan", <span key="p" className="fi-tnum">{rupiah(r.total_potongan)}</span>],
                        ["Dibayar", <b key="d" className="fi-tnum">{rupiah(r.total_nilai)}</b>],
                        ...(r.keterangan ? [["Keterangan", r.keterangan] as [string, ReactNode]] : []),
                    ]} />
                </div>
            </Section>

            <Section title="Tagihan" subtitle={`${r.detail_invoices?.length ?? 0} faktur`}>
                <div className="fi-sect-in">
                    {alasanFaktur(r.detail_invoices) && <MessageStrip tone="warn" title={alasanFaktur(r.detail_invoices)!} />}
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Faktur dibayar">
                        {(r.detail_invoices || []).map((d, i) => (
                            <li key={`${d.record_id}-${i}`} className="fi-li" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span className="fi-mono">{d.invoiceNo || "(kosong)"}</span><b className="fi-tnum">{rupiah(d.paymentAmount)}</b>
                            </li>
                        ))}
                    </ul>
                </div>
            </Section>

            <Section title="Tujuan di Accurate" subtitle={sesi?.tersambung ? `Database ${sesi.alias || `ID ${sesi.id}`}` : undefined}>
                <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>{tujuanIsi}</div>
            </Section>

            <Section title="Transfer">
                <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>
                    <FormField label="Tanggal transfer" required>
                        {(a11y) => <input {...a11y} className="fi-input" type="date" value={p.tanggalTransfer} disabled={postingTerkunci} onChange={(e) => p.onTanggal(e.target.value)} />}
                    </FormField>
                    {r.transfer_proof?.proof_id ? (
                        <KeyValues items={[["Bukti tersimpan", r.transfer_proof.url
                            ? <a key="b" href={urlBerkas(r.transfer_proof.url)} target="_blank" rel="noreferrer">{r.transfer_proof.original_filename || r.transfer_proof.stored_filename}</a>
                            : r.transfer_proof.original_filename || r.transfer_proof.stored_filename || "ada"]]} />
                    ) : (
                        <FormField label="Bukti transfer" required help="PDF, JPG, atau PNG. Diunggah saat Transfer & posting.">
                            {(a11y) => <input {...a11y} className="fi-input" type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={postingTerkunci}
                                onChange={(e) => p.onBukti(e.target.files?.[0] ?? null)} />}
                        </FormField>
                    )}
                </div>
            </Section>

            {(kode !== "belum" || r.accurate_post_resolution) && (
                <Section title="Posting">
                    <div className="fi-sect-in">
                        <KeyValues items={[
                            ...(b.posting.nomor ? [["Purchase Payment", <span key="n" className="fi-mono">{b.posting.nomor}</span>] as [string, ReactNode]] : []),
                            ...(kode === "terposting" ? [
                                ["Oleh", (b.posting.catatanTertinggal ? a?.actorName : orang(r.accurate_posted_by)) || a?.actorName || "–"],
                                ["Kapan", b.posting.catatanTertinggal ? `${a?.updatedAtWita ?? ""} WITA` : r.accurate_posted_at ? `${r.accurate_posted_at} WITA` : "–"],
                            ] as Array<[string, ReactNode]> : []),
                            ...(a ? [["Percobaan terakhir", `${a.createdAtWita} WITA · ${a.actorName || "–"} · database ${db(a.targetDbId)}`] as [string, ReactNode]] : []),
                            ...(b.posting.catatanTertinggal ? [["Catatan Finance", "Belum mencatat hasil ini; tekan Catat hasil posting (tidak mengirim ulang)."] as [string, ReactNode]] : []),
                            ...(r.accurate_post_resolution ? [["Diselesaikan", `${orang(r.accurate_post_resolution.by)} · ${r.accurate_post_resolution.at ?? ""} WITA · ${r.accurate_post_resolution.note ?? ""}`] as [string, ReactNode]] : []),
                        ]} />
                    </div>
                </Section>
            )}

            {alasanLain.length > 0 && <ul className="fi-small fi-subtle" aria-label="Alasan aksi nonaktif">{alasanLain.map((x) => <li key={x}>{x}</li>)}</ul>}
            <FooterToolbar message={p.alasanPosting ? <span className="fi-why">{p.alasanPosting}</span> : p.tujuanBerubah ? "Tujuan belum disimpan; ikut tersimpan saat posting." : undefined}>
                <Button variant="tertiary" icon={<Undo2 className="fi-icon" aria-hidden />} disabled={Boolean(kunci.status) || sudahBelum}
                    disabledReason={kunci.status ?? "Status sudah Belum transfer"} onClick={() => p.onDialog("belum")}>Tandai belum transfer</Button>
                <Button icon={<RotateCcw className="fi-icon" aria-hidden />} disabled={Boolean(kunci.status)} disabledReason={kunci.status} onClick={() => p.onDialog("ulang")}>Kembalikan ke Pembayaran</Button>
                {kode === "tidak_pasti" && (
                    <Button icon={<ShieldCheck className="fi-icon" aria-hidden />} disabled={Boolean(kunci.selesaikan)} disabledReason={kunci.selesaikan} onClick={() => p.onDialog("selesai")}>Selesaikan…</Button>
                )}
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(p.alasanPosting)} disabledReason={p.alasanPosting} onClick={() => p.onDialog("pp")}>{label}</Button>
            </FooterToolbar>
        </div>
    );
}

/**
 * Dialog `pp`: menyebut database, pemasok, rekening, faktur, nilai, tanggal transfer, dan bukti SEBELUM kirim (BL-03). Database dibaca
 * SEGAR saat dialog dibuka (tinjauan A-1) — bukan dari data daftar — dan id-nya yang dikirim sebagai expectedDatabaseId; berbeda dari
 * database saat daftar dimuat (master pemasok/rekening milik database itu) = terkunci sampai dimuat ulang.
 */
function DialogPosting(p: {
    open: boolean; onClose: () => void; b: Baris; dbDimuat: string; tujuan: FinanceMapping; tanggalTransfer: string; bukti: File | null;
    blokir?: string; onConfirm: (tujuanDb: SesiAccurate) => Promise<void>;
}) {
    const r = p.b.r;
    const faktur = (r.detail_invoices || []).map((d) => d.invoiceNo);
    const catatHasil = p.b.posting.catatanTertinggal;
    const [segar] = useLoad(useCallback(async (): Promise<Load<SesiAccurate>> => {
        if (!p.open) return { status: "memuat" };
        const s = await bacaSesi();
        return s.sesi ? { status: "siap", data: s.sesi } : { status: "galat", error: s.galat };
    }, [p.open]));
    const db = segar.status === "siap" ? segar.data : undefined;
    const namaDb = db ? db.alias || `ID ${db.id}` : segar.status === "galat" ? "tidak terbaca" : "memeriksa…";
    const blokir = p.blokir
        ?? (segar.status === "memuat" ? "Memeriksa database Accurate yang terbuka…" : undefined)
        ?? (!db ? `${segar.error || "Sesi Accurate tidak terbaca."} Tutup lalu buka lagi dialog ini.` : undefined)
        ?? (!db.tersambung ? "Login dan buka database Accurate dulu." : undefined)
        ?? (db.id !== p.dbDimuat ? `Database Accurate berganti sejak daftar dimuat (sekarang ${namaDb}); pemasok dan rekening belum diperiksa di database ini. Tutup lalu muat ulang.` : undefined);
    return (
        <ConfirmDialog open={p.open} onClose={p.onClose} tag="Tulis ke Accurate" confirmDisabled={blokir} onConfirm={() => p.onConfirm(db!)}
            title={catatHasil ? "Catat hasil posting yang sudah ada?" : "Posting Purchase Payment ke Accurate?"}
            confirmLabel={catatHasil ? "Catat hasil posting" : `Posting ${rupiah(r.total_nilai)}`}
            facts={[
                ["Database", namaDb],
                ["Pemasok", `${p.tujuan.vendorNo || "–"} · ${p.tujuan.vendorName || ""}`],
                ["Rekening bank", `${p.tujuan.bankNo || "–"} · ${p.tujuan.bankName || ""}`],
                ["Faktur dibayar", `${faktur.length} · ${faktur.slice(0, 4).join(", ")}${faktur.length > 4 ? ` dan ${faktur.length - 4} lain` : ""}`],
                ["Nilai", <b key="n" className="fi-tnum">{rupiah(r.total_nilai)}</b>],
                ["Tanggal transfer", p.tanggalTransfer ? tanggalPanjang(p.tanggalTransfer) : "–"],
                ["Bukti", r.transfer_proof?.proof_id ? `${r.transfer_proof.original_filename || r.transfer_proof.stored_filename} (tersimpan)` : p.bukti?.name || "–"],
            ]}>
            {catatHasil
                ? <MessageStrip tone="info" title={`Server sudah mencatat posting ${p.b.posting.nomor}.`}>Tombol ini hanya mencatat hasilnya ke Finance; server menolak kiriman kedua.</MessageStrip>
                : <MessageStrip tone="warn" title="Purchase Payment yang terposting tidak bisa ditarik dari aplikasi ini.">Bila Accurate tidak menjawab, pengajuan dikunci sebagai Tidak pasti sampai Finance mencocokkannya.</MessageStrip>}
            {blokir && <p className="fi-small fi-why">{blokir}</p>}
        </ConfirmDialog>
    );
}

/** Dialog `selesaipp` (D-14, hanya Finance): hasil pemeriksaan, tempat memeriksa, alasan ≥ 15, kecocokan database sesi = target. */
function DialogSelesai(p: {
    open: boolean; onClose: () => void; b: Baris; data: DataFinance; blokir?: string; dibuka: number;
    onConfirm: (x: { ada: boolean; nomor: string; sumber: string; alasan: string }) => Promise<void>;
}) {
    const [hasil, setHasil] = useState<"" | "ada" | "tidak_ada">("");
    const [nomor, setNomor] = useState("");
    const [sumber, setSumber] = useState("");
    const [bukaKe, setBukaKe] = useState(0);
    // Isian dikosongkan tiap kali dialog dibuka (disesuaikan saat render, bukan di effect).
    const [terakhirBuka, setTerakhirBuka] = useState(false);
    if (p.open !== terakhirBuka) {
        setTerakhirBuka(p.open);
        if (p.open) { setHasil(""); setNomor(""); setSumber(""); setBukaKe((n) => n + 1); }
    }
    const r = p.b.r;
    const a = p.b.attempt;
    const sesi = p.data.sesi;
    // Umur attempt saat dialog dibuka (server menegakkan ambang yang sama dengan jam DB); buka ulang dialog untuk menghitung lagi.
    const detik = (p.dibuka - p.data.dimuat) / 1000;
    const tidakAda = alasanTidakAda(a, detik);
    const dbCocok = !sesi?.id ? "Buka database Accurate yang diperiksa dulu."
        : a && a.targetDbId && a.targetDbId !== sesi.id ? `Percobaan dikirim ke database lain (ID ${a.targetDbId}); sesi Anda ${sesi.alias || `ID ${sesi.id}`}. Buka database itu dulu.`
        : undefined;
    const blokir = p.blokir ?? dbCocok
        ?? (!hasil ? "Pilih hasil pemeriksaan" : undefined)
        ?? (hasil === "ada" && !nomor.trim() ? "Isi nomor Purchase Payment" : undefined)
        ?? (hasil === "tidak_ada" ? tidakAda : undefined)
        ?? (!sumber.trim() ? "Isi tempat Anda memeriksa" : undefined);
    // Alasan nonaktif TERLIHAT; yang sudah tampil sebagai strip database / bantuan "Tidak ada" tidak diulang.
    const blokirTampil = blokir && blokir !== dbCocok && blokir !== tidakAda ? blokir : undefined;
    const nama = `selesai-${bukaKe}`;
    return (
        <ConfirmDialog open={p.open} onClose={p.onClose} tag="Hanya Finance" title="Selesaikan posting tidak pasti" confirmLabel="Simpan penyelesaian"
            reason={{ label: "Alasan", min: 15, placeholder: "Apa yang Anda lihat di Accurate dan mengapa" }} confirmDisabled={blokir}
            description={`${r.draft_label} · ${r.principle} · ${rupiah(r.total_nilai)} · ${a ? `dicoba ${a.createdAtWita} WITA oleh ${a.actorName || "–"}` : "tanpa catatan percobaan di server (status lama)"}.`}
            onConfirm={(alasan) => p.onConfirm({ ada: hasil === "ada", nomor, sumber, alasan })}>
            <fieldset className="fi-field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="fi-label">Hasil pemeriksaan<span className="fi-req" aria-hidden>*</span></legend>
                <label className="fi-check"><input type="radio" name={nama} checked={hasil === "ada"} onChange={() => setHasil("ada")} /> Ada di Accurate</label>
                {hasil === "ada" && (
                    <FormField label="Nomor Purchase Payment" required>
                        {(a11y) => <input {...a11y} className="fi-input fi-mono" value={nomor} onChange={(e) => setNomor(e.target.value)} placeholder="mis. PP/2610/0030" />}
                    </FormField>
                )}
                <label className="fi-check" title={tidakAda}><input type="radio" name={nama} checked={hasil === "tidak_ada"} disabled={Boolean(tidakAda)} onChange={() => setHasil("tidak_ada")} /> Tidak ada di Accurate</label>
                <p className="fi-help">{tidakAda ?? "Pengajuan dibuka lagi untuk posting."}</p>
            </fieldset>
            <FormField label="Diperiksa di" required help="Mis. Accurate › Pembayaran Pembelian, saring tanggal dan pemasok.">
                {(a11y) => <input {...a11y} className="fi-input" value={sumber} onChange={(e) => setSumber(e.target.value)} />}
            </FormField>
            {dbCocok
                ? <MessageStrip tone="neg" title={dbCocok} />
                : <MessageStrip tone="pos" title={a ? `Sesi Accurate Anda (${sesi?.alias || `ID ${sesi?.id}`}) sama dengan database percobaan.` : `Sesi Accurate Anda: ${sesi?.alias || `ID ${sesi?.id}`}.`} />}
            {blokirTampil && <p className="fi-small fi-why">{blokirTampil}.</p>}
        </ConfirmDialog>
    );
}
