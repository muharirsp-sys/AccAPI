/*
 * Tujuan: Langkah 4 Tinjau dan 5 Hasil wizard Pelunasan (Fiori S6e-2b, it02 #17–19). Tinjau: KPI Dibaca / Siap kirim / Potensi ganda /
 *   Retur manual / Dilewati, izin baris ganda/mirip (hanya Finance, dialog alasan ≥ 15, tercatat per baris di server saat kunci), dialog
 *   Kirim (database, jenis, baris & paket, nilai, ditahan, retur manual), kunci tulis saat sesi/database tidak cocok; galat lock dipetakan
 *   menurut `GalatKirim.code`. Hasil: per baris (dengan paket) Terposting / Gagal / Tidak pasti / Ditahan / Dilewati, Excel atas permintaan,
 *   Selesaikan (./Selesaikan: pencarian server dulu, lalu keputusan tercatat) memperbarui baris.
 * Caller: Pelunasan.tsx.
 * Dependensi: lib/pelunasan/kirim (orkestrasi lock → paket 100 → laporan → complete, S6e-2a), lib/pelunasan/pratinjau-ganda (petunjuk riwayat),
 *   lib/pelunasan-wizard, ./bersama, ./Selesaikan, components/fiori. Kontrak: docs/handover/S6e2-KONTRAK-API.md.
 * Main Functions: LangkahTinjau, LangkahHasil.
 * Side Effects: Kirim = TULIS sales-receipt ke Accurate lewat /api/proxy (zona AGENTS §3); Selesaikan (lihat ./Selesaikan); unduh Excel.
 */
"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Download, ExternalLink, Search, Send, ShieldCheck, ShieldOff } from "lucide-react";
import { Button, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, type Load } from "@/components/fiori/interactive";
import { accurateFetch } from "@/lib/apiFetcher";
import { GalatKirim, kirimPelunasan, type BarisHasil } from "@/lib/pelunasan/kirim";
import { pratinjauRiwayatAccurate, type DuplicateReviewEntry } from "@/lib/pelunasan/pratinjau-ganda";
import type { Bebas } from "@/lib/pelunasan/sel";
import { buildSalesReceiptIdempotencyPayload } from "@/lib/sales-receipt-fingerprint";
import { memuatPlaceholderAkun } from "@/lib/sales-receipt-upload";
import { rupiah } from "@/lib/promo-ui";
import {
    KODE_DISELESAIKAN, LABEL_ALASAN, LABEL_DILEWATI, LABEL_HASIL, barisLaporanHasil, butuhTakeover, fakturDari, hitungHasil, nilaiUang, nomorTerposting, paketDari, rencanaKirim,
    terapkanPenyelesaian, type Penyelesaian,
} from "@/lib/pelunasan-wizard";
import { waktuWita } from "@/app/(dashboard)/principal-order/bersama";
import { ALASAN, bacaSesi, namaDatabase, postJson, tanggalTampil, unduhExcel, type Sesi } from "./bersama";
import { SelesaikanDialog } from "./Selesaikan";

export type Tinjauan = {
    payload: Bebas[]; manualRows: Bebas[]; review: DuplicateReviewEntry[]; peringatan: string[];
    dibaca: number; dilewati: Array<{ row: number; reason: string }>;
    /** Database yang dipakai pratinjau = database yang ditampilkan di dialog dan dikirim sebagai expectedDatabaseId. */
    databaseId: string; databaseAlias: string | null; tanggal: string; namaBerkas: string;
    /** Penanda pratinjau (Date.now()): pratinjau ulang = pilihan izin lama dibuang. */
    dibuat: number;
};
export type Hasil = { rows: BarisHasil[]; kirim: Bebas[]; ditahan: DuplicateReviewEntry[]; selesai: string; paket: number; terputus?: boolean };
type Izin = { kirim: boolean; izinkan: boolean; selesaikan: boolean };

const UKURAN_PAKET = 100;
/** Kode penolakan proxy yang berarti sesi/izin/database bermasalah: sesi dibaca ulang setelah kirim. */
const KODE_SESI = new Set(["database_changed", "ACCURATE_SESSION_INCOMPLETE", "DATABASE_REQUIRED", "PERMISSION_REQUIRED"]);
const PESAN_TERPUTUS = "Kiriman terputus tanpa hasil per baris dari aplikasi — hasilnya belum pasti. Jangan unggah ulang; Finance mencocokkan di Accurate lalu menyelesaikannya.";

const outlet = (row: Bebas) => String(row.customerNo ?? "");
const faktur = (row: Bebas) => { const f = fakturDari(row); return f.length > 1 ? `${f[0]} +${f.length - 1}` : f[0] ?? "—"; };
const METODE: Record<string, string> = { CASH_OTHER: "Tunai", BANK_TRANSFER: "Transfer", BANK_CHEQUE: "BG", OTHERS: "Retur/potongan" };
const metode = (row: Bebas) => METODE[String(row.paymentMethod)] ?? String(row.paymentMethod ?? "");

/**
 * GalatKirim (lock gagal, kontrak §7) → kalimat + akibat, MENURUT `code` (teks server tidak dicocokkan). Semua `sent:false`. Jawaban lock yang
 * tidak pasti (putus, ≥ 502, lock tak terbit) = penguncian MUNGKIN tercatat → pratinjau usang (Kirim terkunci sampai diulang).
 */
function galatKunci(e: GalatKirim): { pesan: string; sesi?: boolean; basi?: string } {
    const ragu = "Server tidak memberi jawaban yang pasti saat mengunci baris — hasilnya belum pasti: kunci mungkin sudah tercatat.";
    switch (e.code) {
        case "PERMISSION_REQUIRED": return { pesan: ALASAN.kirim };
        case "OVERRIDE_PERMISSION_REQUIRED": return { pesan: `${ALASAN.izinkan} Batalkan izin baris ganda atau minta Finance yang mengirim.` };
        case "OVERRIDE_REASON_REQUIRED": return { pesan: "Alasan izin Finance minimal 15 karakter; batalkan izin lalu izinkan lagi dengan alasan." };
        case "PLACEHOLDER_AKUN": return { pesan: "Akun potongan belum lengkap; kembali ke langkah Akun dan isi akunnya." };
        case "DATABASE_REQUIRED": return { pesan: "Database Accurate pratinjau tidak terbaca; tekan Periksa ulang sesi.", sesi: true };
        case "ACCURATE_SESSION_INCOMPLETE": return { pesan: "Sesi Accurate belum lengkap; masuk lagi dan buka database lewat Konsol AOL.", sesi: true };
        case "database_changed": return { pesan: "Database Accurate sesi Anda berubah sejak pratinjau; buka lagi database pratinjau atau ulangi pratinjau.", sesi: true };
        case "KEY_IDENTITY_MISMATCH": return { pesan: "Kunci baris tidak cocok dengan pelanggan dan tanggalnya (galat aplikasi); ulangi pratinjau, bila berulang laporkan ke IT." };
        case "BLOCKED_KEYS": return { pesan: "Status ganda berubah sejak pratinjau.", basi: "Status ganda berubah sejak pratinjau; ulangi pratinjau." };
        case "NETWORK": case "LOCK_NOT_ISSUED": return { pesan: ragu, sesi: true, basi: `${ragu} Ulangi pratinjau sebelum mengirim.` };
        default:
            return e.status === 0 || e.status >= 502
                ? { pesan: ragu, sesi: true, basi: `${ragu} Ulangi pratinjau sebelum mengirim.` }
                : { pesan: e.status === 401 ? "Sesi login berakhir; masuk ulang lalu ulangi pratinjau." : e.message || "Kunci baris ditolak server." };
    }
}

function KonsolLink({ bisa }: { bisa: boolean }) {
    return bisa
        ? <a href="/api-wrapper" target="_blank" rel="noopener">Masuk ke Accurate di Konsol <ExternalLink className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /></a>
        : <span className="fi-why">{ALASAN.konsol}</span>;
}

// ── Langkah 4 · Tinjau ──────────────────────────────────────────────────────────────────────────────────

export function LangkahTinjau({ tinjauan: t, sesi, muatSesi, izin, bisaKonsol, menyiapkan, galatSiap, onUlangi, onKembali, onHasil }: {
    tinjauan: Tinjauan; sesi: Load<Sesi>; muatSesi: () => void; izin: Izin; bisaKonsol: boolean;
    menyiapkan: string | null; galatSiap: string | null; onUlangi: () => void; onKembali: () => void; onHasil: (h: Hasil) => void;
}) {
    const [diizinkan, setDiizinkan] = useState<Set<string>>(new Set());
    const [alasanIzin, setAlasanIzin] = useState("");
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<"izinkan" | "kirim" | null>(null);
    const [progres, setProgres] = useState<string | null>(null);
    const [basi, setBasi] = useState<string | null>(null);

    const rencana = useMemo(() => rencanaKirim(t.payload, t.review, diizinkan), [t, diizinkan]);
    const ganda = t.review.filter((r) => !r.recommended);
    const nKirim = rencana.kirim.length;
    const nPaket = Math.ceil(nKirim / UKURAN_PAKET);
    const uang = nilaiUang(rencana.kirim);
    const placeholder = memuatPlaceholderAkun(rencana.kirim);

    const s = sesi.data;
    const dbBerubah = Boolean(s?.databaseConnected && s.databaseId && s.databaseId !== t.databaseId);
    const sesiBerakhir = sesi.status === "siap" && Boolean(s && !s.databaseConnected);
    const kunciKirim = !izin.kirim ? ALASAN.kirim
        : menyiapkan ? "Pratinjau sedang disiapkan ulang."
            : basi ? basi
                : sesi.status === "memuat" ? "Sesi Accurate sedang diperiksa."
                    : sesi.status === "galat" ? "Sesi Accurate tidak terbaca; Periksa ulang sesi dulu."
                        : sesiBerakhir ? "Masuk ke Accurate dan buka database dulu."
                            : dbBerubah ? "Database Accurate berubah sejak pratinjau; ulangi pratinjau."
                                : placeholder ? "Akun potongan belum lengkap; kembali ke langkah Akun."
                                    : nKirim === 0 ? "Tidak ada baris yang siap kirim." : undefined;
    const kunciIzinkan = !izin.izinkan ? ALASAN.izinkan : pilih.size === 0 ? "Centang baris yang akan diizinkan dulu." : undefined;
    const dipilihTakeover = ganda.filter((r) => pilih.has(r.reviewId) && butuhTakeover(r));

    async function kirim() {
        // Database dibaca ULANG tepat sebelum kirim: yang dikirim = yang ditampilkan di dialog (server juga menolak 409 database_changed).
        const cek = await bacaSesi();
        if (cek.status !== "siap" || !cek.data) { muatSesi(); throw new Error(`${cek.error ?? "Sesi Accurate tidak terbaca."} Tidak ada yang dikirim.`); }
        if (!cek.data.databaseConnected) { muatSesi(); throw new Error("Sesi Accurate Anda berakhir; masuk lagi lewat Konsol. Tidak ada yang dikirim."); }
        if (cek.data.databaseId !== t.databaseId) {
            muatSesi();
            throw new Error(`Database Accurate berubah sejak pratinjau (kini ${namaDatabase(cek.data)}). Tidak ada yang dikirim; ulangi pratinjau.`);
        }
        let terkirim = false;
        try {
            const out = await kirimPelunasan(rencana.kirim, {
                postJson, expectedDatabaseId: t.databaseId, ukuranPaket: UKURAN_PAKET,
                override: rencana.perluAlasan ? { ...rencana.override, overrideReason: alasanIzin } : undefined,
                cariRiwayat: (rows) => pratinjauRiwayatAccurate(rows, accurateFetch),
                lapor: (p) => {
                    if (p.tahap === "paket") terkirim = true;
                    setProgres(p.tahap === "lock" ? "Mengunci baris…" : `Mengirim paket ${p.paket} dari ${p.totalPaket} (baris ${p.dari}–${p.sampai})…`);
                },
            });
            if (out.rows.some((r) => r.code && KODE_SESI.has(r.code))) muatSesi();
            onHasil({ rows: out.rows, kirim: rencana.kirim, ditahan: rencana.ditahan, selesai: new Date().toISOString(), paket: nPaket });
        } catch (e) {
            // Kontrak lib: melempar hanya SEBELUM paket pertama (GalatKirim, sent:false) = tidak ada yang dikirim. Bila tetap melempar sesudahnya,
            // hasil tidak bisa dipastikan: semua baris Tidak pasti (dikunci server; diselesaikan Finance), sesi dibaca ulang.
            if (terkirim) {
                muatSesi();
                onHasil({ rows: rencana.kirim.map((_, index) => ({ index, paket: Math.floor(index / UKURAN_PAKET) + 1, outcome: "tidak_pasti", message: PESAN_TERPUTUS })),
                    kirim: rencana.kirim, ditahan: rencana.ditahan, selesai: new Date().toISOString(), paket: nPaket, terputus: true });
                return;
            }
            // Galat lain sebelum paket pertama (bukan dari server): proxy belum dipanggil, tetapi kunci mungkin sudah tercatat.
            const g = e instanceof GalatKirim ? galatKunci(e)
                : { pesan: `${e instanceof Error && e.message ? e.message : "Kiriman berhenti sebelum paket pertama."}`, sesi: true, basi: "Kiriman berhenti sebelum paket pertama; ulangi pratinjau." };
            if (g.sesi) muatSesi();
            if (g.basi) setBasi(g.basi);
            throw new Error(`${g.pesan} Tidak ada yang dikirim ke Accurate.`);
        } finally {
            setProgres(null);
        }
    }

    const kolomGanda: Column<DuplicateReviewEntry>[] = [
        { key: "outlet", header: "Outlet / faktur", cell: (r) => <><b className="fi-mono">{r.invoiceNo || "—"}</b><span className="fi-codes">{r.customerNo}</span></> },
        { key: "nilai", header: "Nilai", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.amount)}</span> },
        { key: "alasan", header: "Alasan", secondary: true, cell: (r) => <span className="fi-small">{r.reasons.map((x) => LABEL_ALASAN[x]).join("; ")}{r.matchedReceiptNumbers.length ? ` · ${r.matchedReceiptNumbers.join(", ")}` : ""}</span> },
        { key: "status", header: "Status", cell: (r) => (diizinkan.has(r.reviewId) ? <StatusBadge tone="info">Diizinkan Finance</StatusBadge> : <StatusBadge tone="warn">Ditahan</StatusBadge>) },
    ];
    const kolomKirim: Column<{ i: number; row: Bebas }>[] = [
        { key: "outlet", header: "Outlet / faktur", cell: ({ row }) => <><b className="fi-mono">{faktur(row)}</b><span className="fi-codes">{outlet(row)}</span></> },
        { key: "metode", header: "Metode", secondary: true, cell: ({ row }) => metode(row) },
        { key: "uang", header: "Uang diterima", align: "end", cell: ({ row }) => <span className="fi-tnum">{rupiah(Number(row.chequeAmount) || 0)}</span> },
    ];
    const barisKirim = rencana.kirim.map((row, i) => ({ i, row }));

    const facts: Array<[string, ReactNode]> = [
        ["Database", <span key="db">{namaDatabase(t)}{s?.databaseId === t.databaseId ? " · sama dengan sesi Anda" : ""}</span>],
        ["Jenis", "Pelunasan penjualan (sales-receipt)"],
        ["Tanggal transaksi", tanggalTampil(t.tanggal)],
        ["Baris", `${nKirim} dalam ${nPaket} paket (maks. ${UKURAN_PAKET} per paket)`],
        ["Uang diterima", <b key="nilai">{rupiah(uang)}</b>],
        ["Ditahan", rencana.ditahan.length ? `${rencana.ditahan.length} potensi ganda (tidak dikirim)` : "tidak ada"],
        ...(rencana.izin.length ? [["Diizinkan Finance", `${rencana.izin.length} baris${rencana.takeover.length ? ` (${rencana.takeover.length} kirim ulang terkendali)` : ""} · alasan: ${alasanIzin}`] as [string, ReactNode]] : []),
        ["Dipisah", t.manualRows.length ? `${t.manualRows.length} retur manual (Excel, tidak dikirim)` : "tidak ada retur manual"],
    ];

    return (
        <>
            {(sesi.status === "galat" || sesiBerakhir) && (
                <MessageStrip tone="neg" title="Sesi Accurate Anda berakhir.">
                    Masuk lagi dan buka database {namaDatabase(t)} untuk mengirim. Pratinjau dan pilihan Anda tetap di halaman ini. <KonsolLink bisa={bisaKonsol} />
                </MessageStrip>
            )}
            {dbBerubah && s && (
                <MessageStrip tone="warn" title="Database Accurate berubah sejak pratinjau.">
                    Pratinjau dibuat untuk {namaDatabase(t)}; sesi Anda kini {namaDatabase(s)}. Kirim dikunci sampai pratinjau diulang untuk database ini.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" disabled={Boolean(menyiapkan)} onClick={onUlangi}>Ulangi pratinjau</button>
                </MessageStrip>
            )}
            {basi && (
                <MessageStrip tone="warn" title="Pratinjau usang.">
                    {basi} <button type="button" className="fi-btn fi-btn--tertiary" disabled={Boolean(menyiapkan)} onClick={onUlangi}>Ulangi pratinjau</button>
                </MessageStrip>
            )}
            {galatSiap && <MessageStrip tone="neg" title="Pratinjau ulang gagal.">{galatSiap} Pratinjau sebelumnya tetap tampil; Kirim tetap terkunci bila database berubah.</MessageStrip>}
            {menyiapkan && <p className="fi-small" role="status">{menyiapkan}</p>}
            {t.peringatan.map((p) => <MessageStrip key={p} tone="warn" title="Catatan saat membaca Accurate.">{p}</MessageStrip>)}
            {placeholder && <MessageStrip tone="neg" title="Akun potongan belum lengkap.">Ada baris dengan potongan tanpa akun. Kembali ke langkah Akun dan isi akunnya; tidak ada yang dikirim.</MessageStrip>}

            <div className="fi-kcards" aria-label="Ringkasan tinjauan" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
                <div className="fi-kc"><span>Dibaca</span><b>{t.dibaca}</b><small>baris berkas</small></div>
                <div className="fi-kc" data-tone="pos"><span>Siap kirim</span><b>{nKirim}</b><small>{rupiah(uang)}</small></div>
                <div className="fi-kc" data-tone={rencana.ditahan.length ? "warn" : undefined}><span>Potensi ganda</span><b>{ganda.length}</b><small>{rencana.ditahan.length} ditahan{rencana.izin.length ? ` · ${rencana.izin.length} diizinkan` : ""}</small></div>
                <div className="fi-kc"><span>Retur manual</span><b>{t.manualRows.length}</b><small>dipisah ke Excel</small></div>
                <div className="fi-kc" data-tone={t.dilewati.length ? "warn" : undefined}><span>Dilewati</span><b>{t.dilewati.length}</b><small>saat dibaca</small></div>
            </div>

            {ganda.length > 0 && (
                <Section title="Potensi ganda" subtitle="kunci aplikasi dan kemiripan riwayat Accurate">
                    <div className="fi-sect-in">
                        {rencana.ditahan.length > 0 && (
                            <MessageStrip tone="warn" title={`${rencana.ditahan.length} baris mirip pelunasan yang sudah ada.`}>
                                Baris ini tidak ikut terkirim kecuali Finance mengizinkan dengan alasan. Server tetap menahan baris yang mirip riwayat Accurate saat dikirim.
                            </MessageStrip>
                        )}
                        <ResponsiveTable<DuplicateReviewEntry> title="Potensi ganda" count={ganda.length} columns={kolomGanda} rows={ganda} rowKey={(r) => r.reviewId}
                            selected={izin.izinkan ? pilih : undefined} onSelectedChange={izin.izinkan ? setPilih : undefined}
                            rowLabel={(r) => `Pilih ${r.invoiceNo || r.customerNo}`}
                            empty={{ title: "Tidak ada baris ganda" }}
                            actions={<span className="fi-btnrow">
                                {diizinkan.size > 0 && <Button variant="tertiary" icon={<ShieldOff className="fi-icon" aria-hidden />} onClick={() => { setDiizinkan(new Set()); setAlasanIzin(""); }}>Batalkan izin</Button>}
                                <Button icon={<ShieldCheck className="fi-icon" aria-hidden />} disabled={Boolean(kunciIzinkan)} disabledReason={kunciIzinkan} onClick={() => setDialog("izinkan")}>Izinkan yang dicentang…</Button>
                            </span>}
                            mobileItem={(r) => <ListItem doc={r.invoiceNo || "—"} amount={rupiah(r.amount)} title={r.customerNo} meta={r.reasons.map((x) => LABEL_ALASAN[x]).join("; ")}
                                badge={diizinkan.has(r.reviewId) ? <StatusBadge tone="info">Diizinkan</StatusBadge> : <StatusBadge tone="warn">Ditahan</StatusBadge>} />} />
                        {ganda.some(butuhTakeover) && (
                            <p className="fi-small">Baris berstatus kiriman sebelumnya belum pasti yang ternyata cicilan BELUM terkirim: centang lalu Izinkan yang dicentang…
                                = kirim ulang terkendali (takeover Finance, tercatat dengan alasan). Periksa di Accurate dulu; bila sudah terposting, selesaikan baris lamanya.</p>
                        )}
                        {!izin.izinkan && <p className="fi-small fi-why">Izinkan nonaktif: {ALASAN.izinkan}</p>}
                    </div>
                </Section>
            )}

            {t.dilewati.length > 0 && (
                <Section title="Dilewati saat dibaca" subtitle="tidak dikirim">
                    <ul className="fi-sect-in fi-small" style={{ listStyle: "disc", paddingLeft: "2rem" }}>
                        {t.dilewati.slice(0, 20).map((d) => <li key={`${d.row}-${d.reason}`}>Baris {d.row}: {LABEL_DILEWATI[d.reason] ?? d.reason}</li>)}
                        {t.dilewati.length > 20 && <li>… dan {t.dilewati.length - 20} baris lain</li>}
                    </ul>
                </Section>
            )}

            <Section title="Siap kirim" subtitle={`${namaDatabase(t)} · tanggal ${tanggalTampil(t.tanggal)} · ${t.namaBerkas}`}>
                <ResponsiveTable<{ i: number; row: Bebas }> title="Siap kirim" count={nKirim} columns={kolomKirim} rows={barisKirim} rowKey={({ i }) => String(i)}
                    empty={{ title: "Tidak ada pelunasan yang bisa dikirim", message: "Semua baris dilewati, ditahan sebagai potensi ganda, atau dipisah ke retur manual." }}
                    mobileItem={({ row }) => <ListItem doc={faktur(row)} amount={rupiah(Number(row.chequeAmount) || 0)} title={outlet(row)} meta={metode(row)} />} />
            </Section>

            <FooterToolbar message={kunciKirim ?? `${nKirim} baris · ${nPaket} paket · ${rupiah(uang)}`}>
                <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} disabled={Boolean(menyiapkan)} onClick={onKembali}>Kembali</Button>
                {t.manualRows.length > 0 && (
                    <Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => void unduhExcel(t.manualRows, "Retur Manual", "Retur_PotLain_Manual")}>
                        {t.manualRows.length} retur manual (Excel)
                    </Button>
                )}
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(kunciKirim)} disabledReason={kunciKirim} onClick={() => setDialog("kirim")}>
                    Kirim {nKirim} pelunasan…
                </Button>
            </FooterToolbar>

            <ConfirmDialog open={dialog === "izinkan"} onClose={() => setDialog(null)} tag="Hanya Finance"
                title={dipilihTakeover.length === pilih.size && pilih.size > 0 ? `Kirim ulang terkendali ${pilih.size} baris?` : `Izinkan ${pilih.size} baris yang mirip pelunasan lain?`}
                description={`Baris yang diizinkan ikut dikirim. Izin tercatat per baris di server saat baris dikunci (siapa, alasan, status sebelumnya); satu izin berlaku untuk satu kiriman.${diizinkan.size ? ` Izin sebelumnya (${diizinkan.size} baris) tetap berlaku; alasan ini ditambahkan ke alasannya.` : ""}`}
                facts={ganda.filter((r) => pilih.has(r.reviewId)).slice(0, 8).map((r) => [
                    `${r.invoiceNo || "—"} · ${r.customerNo}`,
                    `${rupiah(r.amount)} · ${r.reasons.map((x) => LABEL_ALASAN[x]).join("; ")}${r.matchedReceiptNumbers.length ? ` · ${r.matchedReceiptNumbers.join(", ")}` : ""}`,
                ] as [string, ReactNode])}
                reason={{ label: "Alasan mengizinkan", min: 15, placeholder: "mis. pelunasan kedua untuk cicilan; dikonfirmasi dengan outlet" }}
                confirmLabel={`Izinkan ${pilih.size} baris`} confirmDisabled={kunciIzinkan} alasanTerlihat
                // 2b #6: Izinkan kedua MENAMBAH (dulu menimpa izin pertama tanpa kabar); satu overrideReason per kiriman = alasan digabung.
                onConfirm={(alasan) => {
                    setDiizinkan((d) => new Set([...d, ...pilih]));
                    setAlasanIzin((a) => (a ? `${a}; ${alasan}` : alasan));
                    setPilih(new Set()); setDialog(null);
                }}>
                {dipilihTakeover.length > 0 && (
                    <MessageStrip tone="warn" title={`Kirim ulang terkendali (takeover) untuk ${dipilihTakeover.length} baris yang kiriman sebelumnya belum pasti atau sudah tercatat.`}>
                        Pakai hanya bila Anda sudah memeriksa di Accurate bahwa baris itu (mis. cicilan lain) BELUM terposting. Bila ternyata sudah, kiriman ini
                        membuat pelunasan ganda. Izin tercatat atas nama Anda; server tetap menahan baris yang mirip riwayat Accurate kecuali ikut diizinkan di sini.
                    </MessageStrip>
                )}
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "kirim"} onClose={() => setDialog(null)} tag="Pelunasan · Kirim"
                title={`Kirim ${nKirim} pelunasan ke Accurate?`} facts={facts}
                confirmLabel={`Kirim ${nKirim} pelunasan`} confirmDisabled={kunciKirim} alasanTerlihat onConfirm={kirim}>
                <MessageStrip tone="warn" title="Setiap baris dikunci sebelum dikirim.">
                    Pelunasan yang terposting tidak bisa ditarik dari aplikasi ini. Baris yang hasilnya tidak pasti hanya bisa diselesaikan Finance.
                </MessageStrip>
                {progres && <p className="fi-small" role="status">{progres}</p>}
            </ConfirmDialog>
        </>
    );
}

// ── Langkah 5 · Hasil ───────────────────────────────────────────────────────────────────────────────────

type BarisTampil = { i: number; row: Bebas; h: BarisHasil | undefined; key: string };
const perluSelesai = (h: BarisHasil | undefined) => !h || h.outcome === "tidak_pasti";
const daftarPaket = (p: number[]) => (p.length === 1 ? `paket ${p[0]}` : `paket ${p.join(", ")}`);

export function LangkahHasil({ tinjauan: t, hasil, izin, onBaru }: { tinjauan: Tinjauan; hasil: Hasil; izin: Izin; onBaru: () => void }) {
    const [selesaikan, setSelesaikan] = useState<BarisTampil | null>(null);
    /** Keputusan server per kunci idempotensi (Selesaikan, atau status yang terbaca saat pencarian). */
    const [selesai, setSelesai] = useState<ReadonlyMap<string, Penyelesaian>>(new Map());
    const [pesan, setPesan] = useState<string | null>(null);
    const per = useMemo(() => new Map(hasil.rows.filter(Boolean).map((r) => [r.index, r])), [hasil.rows]);
    const baris: BarisTampil[] = hasil.kirim.map((row, i) => {
        const key = buildSalesReceiptIdempotencyPayload(row).key;
        return { i, row, key, h: terapkanPenyelesaian(per.get(i), i, selesai.get(key)) };
    });
    const efektif = baris.flatMap((b) => (b.h ? [b.h] : []));
    const n = hitungHasil(efektif);
    const nRagu = baris.filter((b) => perluSelesai(b.h)).length;
    const urut = [...baris].sort((a, b) => Number(a.h?.outcome === "terposting") - Number(b.h?.outcome === "terposting") || a.i - b.i);
    const uangPosting = nilaiUang(baris.filter((b) => b.h?.outcome === "terposting").map((b) => b.row));
    // Gagal berkode = ditolak SEBELUM diteruskan (4xx sent:false, lib kirim.ts). Tidak pasti berkode (mis. 409 database_changed tanpa
    // sent:false) dijelaskan sebabnya, tetapi TIDAK pernah dianggap tidak terkirim.
    const ditolakSesi = hasil.rows.filter((r) => r?.outcome === "gagal" && r.code && KODE_SESI.has(r.code));
    const kodeSesi = ditolakSesi[0]?.code;
    const raguDb = efektif.filter((r) => r.outcome === "tidak_pasti" && r.code === "database_changed");
    const paketRagu = paketDari(efektif, "tidak_pasti");

    const tombol = (b: BarisTampil) => perluSelesai(b.h)
        ? <Button variant="tertiary" icon={<Search className="fi-icon" aria-hidden />} aria-label={`Selesaikan ${faktur(b.row)}…`} disabled={!izin.selesaikan}
            disabledReason={ALASAN.selesaikan} onClick={() => { setPesan(null); setSelesaikan(b); }}>Selesaikan…</Button>
        : null;
    const kolom: Column<BarisTampil>[] = [
        { key: "outlet", header: "Outlet / faktur", cell: (b) => <><b className="fi-mono">{faktur(b.row)}</b><span className="fi-codes">{outlet(b.row)} · {metode(b.row)}</span></> },
        { key: "uang", header: "Uang", align: "end", secondary: true, cell: (b) => <span className="fi-tnum">{rupiah(Number(b.row.chequeAmount) || 0)}</span> },
        { key: "hasil", header: "Hasil", cell: (b) => <BadgeHasil h={b.h} /> },
        { key: "ket", header: "Keterangan", secondary: true, cell: (b) => <span className="fi-small">{keterangan(b.h)}</span> },
        { key: "aksi", header: "Tindakan", cell: tombol },
    ];

    return (
        <>
            {pesan && <MessageStrip tone="pos" title="Status baris diperbarui." onClose={() => setPesan(null)}>{pesan}</MessageStrip>}
            {hasil.terputus && <MessageStrip tone="warn" title="Hasil kiriman belum pasti.">{PESAN_TERPUTUS}</MessageStrip>}
            {kodeSesi === "database_changed" && (
                <MessageStrip tone="warn" title="Database Accurate berubah saat mengirim.">
                    Sesi Anda tidak lagi membuka {namaDatabase(t)} (database pratinjau dan kunci baris). Server menolak {daftarPaket(paketDari(ditolakSesi, "gagal"))} sebelum
                    meneruskannya: {ditolakSesi.length} baris Gagal, tidak terkirim, boleh diulang. Buka lagi database itu (Periksa ulang sesi), lalu mulai pelunasan baru untuk baris yang gagal.
                </MessageStrip>
            )}
            {raguDb.length > 0 && (
                <MessageStrip tone="warn" title="Database Accurate berubah saat mengirim — hasilnya belum pasti.">
                    Server menjawab database berubah untuk {daftarPaket(paketDari(raguDb, "tidak_pasti"))} tanpa menjamin tidak ada yang diteruskan: {raguDb.length} baris
                    tetap Tidak pasti. Jangan unggah ulang; Finance mencocokkan di Accurate ({namaDatabase(t)}) lalu menyelesaikannya.
                </MessageStrip>
            )}
            {kodeSesi && kodeSesi !== "database_changed" && (
                <MessageStrip tone="warn" title="Server menolak sebelum mengirim.">
                    {kodeSesi === "PERMISSION_REQUIRED" ? ALASAN.kirim : "Sesi Accurate belum lengkap; masuk lagi lewat Konsol."} Baris yang ditolak tidak terkirim (Gagal, boleh diulang).
                </MessageStrip>
            )}
            {n.tidak_pasti > 0 && (
                <MessageStrip tone="warn" title={`${n.tidak_pasti} baris tidak pasti${paketRagu.length ? ` (${daftarPaket(paketRagu)})` : ""}.`}>
                    Baris dikunci; jangan unggah ulang. Finance mencocokkan di Accurate lalu menyelesaikannya.
                </MessageStrip>
            )}

            <div className="fi-kcards" aria-label="Ringkasan hasil" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
                <div className="fi-kc" data-tone="pos"><span>Terposting</span><b>{n.terposting}</b><small>{rupiah(uangPosting)}</small></div>
                <div className="fi-kc" data-tone={n.gagal ? "neg" : undefined}><span>Gagal</span><b>{n.gagal}</b><small>tidak terkirim · boleh diulang</small></div>
                <div className="fi-kc" data-tone={n.tidak_pasti ? "warn" : undefined}><span>Tidak pasti</span><b>{n.tidak_pasti}</b><small>diselesaikan Finance</small></div>
                <div className="fi-kc" data-tone={n.ditahan ? "warn" : undefined}><span>Ditahan</span><b>{n.ditahan}</b><small>mirip riwayat · menunggu Finance</small></div>
                <div className="fi-kc"><span>Dilewati</span><b>{hasil.ditahan.length + t.dilewati.length}</b><small>{hasil.ditahan.length} ganda · {t.dilewati.length} saat dibaca · {t.manualRows.length} retur manual</small></div>
            </div>

            <Section title="Hasil per baris" subtitle="yang perlu perhatian di atas">
                <ResponsiveTable<BarisTampil> title="Hasil per baris" count={urut.length} columns={kolom} rows={urut} rowKey={(b) => String(b.i)}
                    empty={{ title: "Tidak ada baris yang dikirim" }}
                    mobileItem={(b) => <ListItem doc={faktur(b.row)} amount={rupiah(Number(b.row.chequeAmount) || 0)} title={`${outlet(b.row)} · ${keterangan(b.h)}`} badge={<BadgeHasil h={b.h} />}
                        meta={tombol(b) ?? undefined} />} />
                {!izin.selesaikan && nRagu > 0 && <p className="fi-small fi-why" style={{ padding: "8px 16px" }}>Selesaikan nonaktif: {ALASAN.selesaikan}</p>}
            </Section>

            <FooterToolbar message={`Selesai ${waktuWita(hasil.selesai)} WITA · ${hasil.paket} paket · ${namaDatabase(t)}`}>
                <Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => void unduhExcel([
                    ...barisLaporanHasil(hasil.kirim, efektif, hasil.ditahan),
                    ...t.dilewati.map((d) => ({ "Code Outlet": "", "Faktur": `baris berkas ${d.row}`, "Metode": "", "Uang diterima": 0, "Paket": "", "Hasil": "Dilewati saat dibaca", "Nomor Accurate": "", "Nomor mirip": "", "Keterangan": LABEL_DILEWATI[d.reason] ?? d.reason })),
                ], "Hasil Pelunasan", "Hasil_Pelunasan")}>Laporan per baris (Excel)</Button>
                <Button variant="primary" onClick={onBaru}>Pelunasan baru</Button>
            </FooterToolbar>

            {selesaikan && (
                <SelesaikanDialog kunci={selesaikan.key} lockDb={{ id: t.databaseId, label: namaDatabase(t) }} izinTakeover={izin.izinkan}
                    ringkas={<><span className="fi-mono">{faktur(selesaikan.row)}</span> · {outlet(selesaikan.row)} · {rupiah(Number(selesaikan.row.chequeAmount) || 0)} · paket {selesaikan.h?.paket ?? "—"} · {keterangan(selesaikan.h)}</>}
                    onClose={(p) => {
                        if (p) {
                            setSelesai((m) => new Map(m).set(selesaikan.key, p));
                            setPesan(`${faktur(selesaikan.row)} · ${outlet(selesaikan.row)}: ${p.pesan}`);
                        }
                        setSelesaikan(null);
                    }} />
            )}
        </>
    );
}

function BadgeHasil({ h }: { h: BarisHasil | undefined }) {
    const l = LABEL_HASIL[h?.outcome ?? "tidak_pasti"];
    return <StatusBadge tone={l.tone}>{l.label}</StatusBadge>;
}
const keterangan = (h: BarisHasil | undefined) => !h ? "Tanpa hasil dari server; cek Accurate sebelum mengulang."
    : h.code === KODE_DISELESAIKAN ? h.message
        // Nomor = item jawaban Accurate (bukan receiptNumbers: untuk baris lain itu nomor MIRIP).
        : h.outcome === "terposting" ? `Terposting${nomorTerposting(h).length ? ` · ${nomorTerposting(h).join(", ")}` : ""} · paket ${h.paket}` : `Paket ${h.paket}: ${h.message}`;
