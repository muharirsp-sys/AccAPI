/*
 * Tujuan: Worklist Antrean Faktur (Fiori S6c, it02): faktur yang menunggu dikirim ke Accurate, sedang dikirim, tidak pasti, ditolak,
 *   dan terposting — kartu status = saringan, umur sejak masuk antrean (lewat 2 jam = laporan OM), Kirim lewat dialog berisi
 *   pratinjau server (BL-39), hasil per baris dari jawaban Kirim, tindakan per baris (Selesaikan/Antre ulang/Buang/Riwayat) mengikuti
 *   izin, verifikasi balik dan batch belum diantrekan dimuat terpisah. Galat tidak pernah tampil sebagai kosong.
 * Caller: app/(dashboard)/antrean-faktur/page.tsx (permKeys dari server).
 * Dependensi: GET /api/invoice-outbox; ./Dialog (semua aksi tulis), ./VerifikasiBalik, ./bersama; components/fiori/*;
 *   lib/rekapan-nota/ui (ambil, jamWita, tanggalPendek).
 * Main Functions: AntreanFaktur.
 * Side Effects: HTTP baca; aksi tulis hanya lewat dialog di ./Dialog.
 *
 * Laporan OM bukan halaman terpisah: kartu "Lewat 2 jam" pada layar ini adalah laporannya — daftar yang sama, isian yang sama
 * (faktur, sales, jenis masalah, umurnya), dan tidak ada angka kedua yang bisa berbeda dari layar admin.
 * Umur dihitung sejak masuk antrean (server), bukan sejak percobaan terakhir: Antre ulang tidak menyetel ulang jam eskalasi.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { History, RefreshCw, Send, Trash2 } from "lucide-react";
import {
    Button, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, type Column, type Tone,
} from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil, jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import {
    SAPU_MENIT, STATUS, hariIniWita, kalimatAccurate, nomorSo, principalDari, usia,
    type Antrean, type Batch, type Row, type State,
} from "./bersama";
import { AntreUlangDialog, BuangDialog, KirimDialog, RiwayatDialog, SelesaikanDialog, type HasilAksi, type HasilKirim, type OrderPratinjau } from "./Dialog";
import VerifikasiBalik, { muatVerifikasi } from "./VerifikasiBalik";

type Saring = "menggantung" | State | "lewat";
type DialogAktif = { jenis: "kirim" } | { jenis: "selesai" | "antreUlang" | "buang" | "riwayat"; row: Row } | null;
type Kiriman = { hasil: HasilKirim; urutan: OrderPratinjau[]; tanggal: string; jam: string };

const MAKS_KIRIM = 50;

function kueri(saring: Saring) {
    if (saring === "menggantung") return "";
    return saring === "lewat" ? "?overdue=1" : `?state=${saring}`;
}

/** Hasil satu order dari jawaban Kirim → badge + kalimat. */
function hasilOrder(k: Kiriman, orderId: string): { tone: Tone; label: string; teks: string } {
    const r = k.hasil.results.find((x) => x.orderId === orderId);
    // Tidak ada di hasil: berhenti setelah tidak pasti (tetap antre), atau sudah tidak Antre saat Kirim (dibuang/diambil proses lain).
    if (!r) return { tone: "neu", label: "Tidak dikirim", teks: k.hasil.unknown
        ? "Pengiriman berhenti setelah hasil tidak pasti; tetap antre."
        : "Baris tidak lagi Antre saat Kirim — muat ulang." };
    if (r.state === "posted") {
        const v = k.hasil.verified.find((x) => x.orderId === orderId);
        const no = r.number || r.accurateId || "";
        if (v?.status === "cocok") return { tone: "pos", label: "Terposting", teks: `${no} · cocok per baris dengan yang dikirim.` };
        if (v?.status === "selisih") return { tone: "neg", label: "Terposting, berselisih", teks: `${no} · isinya berbeda dengan yang dikirim — lihat Verifikasi balik.` };
        return { tone: "warn", label: "Terposting, belum terbaca", teks: `${no} · ${v?.reason || "belum bisa dibaca balik dari Accurate"}.` };
    }
    if (r.state === "rejected") return { tone: "neg", label: "Ditolak", teks: kalimatAccurate(r.error ?? "") || "Accurate menolak." };
    if (r.state === "unknown") return { tone: "warn", label: "Tidak pasti", teks: `${kalimatAccurate(r.error ?? "")} Jangan kirim ulang; selesaikan dari baris di antrean.`.trim() };
    if (r.state === "dilewati") return { tone: "neu", label: "Dilewati", teks: r.error || "berubah sejak pratinjau — muat ulang." };
    return { tone: "neu", label: r.state, teks: r.error ?? "" };
}

function PanelKiriman({ k, onClose }: { k: Kiriman; onClose: () => void }) {
    const h = k.hasil;
    const dilewati = h.results.filter((r) => r.state === "dilewati").length;
    const urut = [...k.urutan.map((o) => ({ orderId: o.orderId, so: o.soNo ?? o.orderId })),
        ...h.results.filter((r) => !k.urutan.some((o) => o.orderId === r.orderId)).map((r) => ({ orderId: r.orderId, so: r.orderId }))];
    const [tone, judul]: [Exclude<Tone, "neu">, string] = h.unknown > 0 ? ["warn", "Pengiriman berhenti: ada faktur yang hasilnya tidak pasti."]
        : h.mismatched > 0 ? ["neg", "Ada faktur terkirim yang isinya berselisih dengan yang dikirim."]
            : h.rejected > 0 ? ["warn", "Sebagian ditolak Accurate — perbaiki penyebabnya lalu Antre ulang."]
            : h.results.length === 0 ? ["warn", "Tidak ada faktur yang terkirim."]
                : h.sent > 0 && h.sent === h.verifiedOk && h.rejected === 0 && dilewati === 0 ? ["pos", "Faktur terkirim dan terverifikasi cocok per baris."]
                    : ["info", "Kiriman selesai — tidak semua terposting dan cocok; periksa hasil per baris."];
    return (
        <Section id="hasil-kiriman" title={`Hasil kiriman ${jamWita(k.jam)} WITA`}
            subtitle={`oleh ${h.sentBy || "Anda"} · tanggal faktur ${k.tanggal ? tanggalPendek(k.tanggal) : "= tanggal SO"}`}
            actions={<Button variant="tertiary" onClick={onClose}>Tutup hasil</Button>}>
            <div className="fi-sect-in">
                <MessageStrip tone={tone} title={judul}>
                    {h.sent} terposting ({h.verifiedOk} cocok per baris{h.mismatched ? `, ${h.mismatched} berselisih` : ""}{h.unchecked ? `, ${h.unchecked} belum terbaca` : ""})
                    {" "}· {h.rejected} ditolak · {h.unknown} tidak pasti{dilewati ? ` · ${dilewati} dilewati` : ""} · {h.remaining} masih antre.
                </MessageStrip>
                <ul className="fi-sect-in" style={{ padding: 0, margin: 0, listStyle: "none" }} aria-label="Hasil per faktur">
                    {urut.map((o) => {
                        const x = hasilOrder(k, o.orderId);
                        return (
                            <li key={o.orderId} className="fi-btnrow">
                                <span className="fi-mono">{o.so}</span><StatusBadge tone={x.tone}>{x.label}</StatusBadge><span className="fi-small">{x.teks}</span>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </Section>
    );
}

export default function AntreanFaktur({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehUbah = keys.has("order.edit");
    const bolehSelesai = keys.has("order.resolve_unknown");

    const [saring, setSaring] = useState<Saring>("menggantung");
    const [cari, setCari] = useState("");
    const [principal, setPrincipal] = useState("");
    const [dipilih, setDipilih] = useState<Set<string>>(new Set());
    const [tanggal, setTanggal] = useState("");
    const [hariIni] = useState(hariIniWita);
    const [dialog, setDialog] = useState<DialogAktif>(null);
    const [kiriman, setKiriman] = useState<Kiriman | null>(null);
    const [aksi, setAksi] = useState<HasilAksi | null>(null);
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);
    // Kunci setelah jawaban tidak pasti: tulis nonaktif sampai antrean TERBARU (data baru, bukan yang tampil saat itu) terbaca.
    const [kunci, setKunci] = useState<{ data: Antrean | undefined } | null>(null);

    const q = kueri(saring);
    const [list, muatUlang] = useLoad(useCallback(async (): Promise<Load<Antrean>> => {
        const r = await ambil<Antrean>(`/api/invoice-outbox${q}`, (j) => ({ ...(j as Omit<Antrean, "diambil">), diambil: Date.now() }));
        return r.status === "galat" ? { ...r, error: `Antrean gagal dimuat: ${r.error}.` } : r;
    }, [q]), { pertahankan: true });
    const [verif, muatVerif] = useLoad(muatVerifikasi);
    const muatSemua = () => { muatUlang(); muatVerif(); };

    const data = list.data;
    const terkunci = kunci !== null && (list.status !== "siap" || data === kunci.data);
    const segar = list.status === "siap" && !terkunci;
    const ringkas = data?.summary ?? {};
    const antre = ringkas.queued ?? 0;

    const principals = useMemo(() => [...new Set((data?.rows ?? []).map((r) => principalDari(r.orderId)))].sort(), [data]);
    const kata = cari.trim().toLowerCase();
    const baris = useMemo(() => (data?.rows ?? []).filter((r) =>
        (!principal || principalDari(r.orderId) === principal)
        && (!kata || [r.orderId, r.outlet, r.customerNo, r.salesman, r.accurateNumber].some((v) => v?.toLowerCase().includes(kata)))), [data, principal, kata]);
    // Hanya baris yang TERLIHAT: baris yang tersembunyi oleh Cari/principal tidak boleh ikut terkirim sebagai pilihan.
    const dipilihSah = baris.filter((r) => r.state === "queued" && dipilih.has(r.orderId)).map((r) => r.orderId);
    const nKirim = dipilihSah.length || Math.min(antre, MAKS_KIRIM);

    const alasanKirim = !bolehUbah ? "Hanya petugas berizin ubah order yang boleh mengirim faktur ke Accurate"
        : terkunci ? "Hasil tindakan terakhir belum pasti — tunggu antrean selesai dimuat ulang"
            : list.status === "galat" ? "Muat ulang dulu: antrean belum terbaru"
                : list.status === "memuat" ? "Memuat antrean…"
                    : antre === 0 ? "Tidak ada faktur antre" : "";
    const alasanTulis = !bolehUbah ? "Hanya petugas berizin ubah order yang boleh mengubah antrean" : !segar ? "Muat ulang dulu: antrean belum terbaru" : "";
    const alasanSelesai = !bolehSelesai ? "Hanya pemegang izin Selesaikan posting tidak pasti yang boleh menyelesaikan — minta IT Support menambahkannya ke grup Anda"
        : !segar ? "Muat ulang dulu: antrean belum terbaru" : "";

    // Saringan berubah = pilihan dikosongkan (yang dipilih selalu yang terlihat).
    const ganti = (s: Saring) => { setSaring(s); setDipilih(new Set()); };
    const gantiCari = (v: string) => { setCari(v); setDipilih(new Set()); };
    const gantiPrincipal = (v: string) => { setPrincipal(v); setDipilih(new Set()); };
    const tutupDialog = () => setDialog(null);
    // Satu hasil terbaru di atas: strip lama dibersihkan supaya tidak terbaca sebagai keadaan sekarang.
    const tidakPastiTerjadi = (pesan: string) => { setAksi(null); setTidakPasti(pesan); setKunci({ data }); setDialog(null); muatSemua(); };
    const aksiSelesai = (h: HasilAksi) => { setTidakPasti(null); setAksi(h); setDialog(null); muatSemua(); };

    const aksiBaris = (r: Row) => (
        <div className="fi-btnrow" style={{ gap: 4, flexWrap: "nowrap", justifyContent: "flex-end" }}>
            {r.state === "unknown" && (
                <Button aria-label={`Selesaikan SO ${nomorSo(r)}`} disabled={Boolean(alasanSelesai)} disabledReason={alasanSelesai} onClick={() => setDialog({ jenis: "selesai", row: r })}>Selesaikan…</Button>
            )}
            {r.state === "rejected" && (
                <Button variant="tertiary" aria-label={`Antre ulang SO ${nomorSo(r)}`} disabled={Boolean(alasanTulis)} disabledReason={alasanTulis} onClick={() => setDialog({ jenis: "antreUlang", row: r })}>Antre ulang…</Button>
            )}
            {(r.state === "rejected" || r.state === "queued") && (
                <Button variant="icon" aria-label={`Buang SO ${nomorSo(r)}`} icon={<Trash2 className="fi-icon" aria-hidden />}
                    disabled={Boolean(alasanTulis)} disabledReason={alasanTulis} title="Buang dari antrean (alasan wajib)" onClick={() => setDialog({ jenis: "buang", row: r })} />
            )}
            <Button variant="icon" aria-label={`Riwayat SO ${nomorSo(r)}`} title="Riwayat" icon={<History className="fi-icon" aria-hidden />} onClick={() => setDialog({ jenis: "riwayat", row: r })} />
        </div>
    );
    const macet = (r: Row) => r.state === "sending" && data !== undefined && data.diambil - Date.parse(r.updatedAt) > SAPU_MENIT * 60_000;
    const badge = (r: Row) => <StatusBadge tone={STATUS[r.state].tone} busy={r.state === "sending"}>{STATUS[r.state].label}</StatusBadge>;

    const kolom: Column<Row>[] = [
        { key: "so", header: "SO / sumber", cell: (r) => <><span className="fi-mono">{nomorSo(r)}</span><span className="fi-sub">{principalDari(r.orderId)} · {r.source}{r.accurateNumber ? ` · ${r.accurateNumber}` : ""}</span></> },
        { key: "outlet", header: "Outlet", secondary: true, cell: (r) => <>{r.outlet || "–"}<span className="fi-sub">{r.customerNo}{r.salesman ? ` · ${r.salesman}` : ""}</span></> },
        { key: "tgl", header: "Tgl SO", secondary: true, cell: (r) => <span className="fi-tnum">{tanggalPendek(r.orderDate)}</span> },
        { key: "status", header: "Status", cell: (r) => <>{badge(r)}{macet(r) && <span className="fi-sub fi-why">lebih dari {SAPU_MENIT} menit — menjadi Tidak pasti otomatis</span>}</> },
        { key: "umur", header: "Umur", cell: (r) => r.state === "posted" ? "–" : <>
            <span className={`fi-tnum${r.overdue ? " fi-why" : ""}`} style={{ whiteSpace: "nowrap" }}>{usia(r.ageMinutes)}</span>
            {r.overdue && <span className="fi-sub fi-why">lewat 2 jam</span>}
            {r.attempts > 0 && <span className="fi-sub">dicoba {r.attempts}×</span>}
        </> },
        { key: "jawaban", header: "Jawaban Accurate", secondary: true, cell: (r) => <span className="fi-small">{kalimatAccurate(r.lastError) || "–"}</span> },
        { key: "aksi", header: "Tindakan", align: "end", cell: aksiBaris },
    ];
    const kolomBatch: Column<Batch>[] = [
        { key: "berkas", header: "Berkas", cell: (b) => <>{b.fileName}<span className="fi-sub">{b.principal}</span></> },
        { key: "baris", header: "Baris", align: "end", cell: (b) => <span className="fi-tnum">{b.lineCount}</span> },
        { key: "tinjau", header: "Perlu ditinjau", align: "end", cell: (b) => <span className="fi-tnum fi-why">{b.reviewCount}</span> },
        { key: "umur", header: "Umur", cell: (b) => b.overdue ? <StatusBadge tone="warn">{usia(b.ageMinutes)} · lewat 2 jam</StatusBadge> : <span className="fi-tnum">{usia(b.ageMinutes)}</span> },
        { key: "unggah", header: "Diunggah", secondary: true, cell: (b) => `${jamWita(b.uploadedAt)}${b.uploadedBy ? ` · ${b.uploadedBy}` : ""}` },
        { key: "buka", header: "Tindakan", align: "end", cell: () => <Link className="fi-btn fi-btn--tertiary" href="/principal-order">Buka Order Principal</Link> },
    ];

    const KARTU: Array<{ key: Saring; label: string; nilai: number | undefined; tone?: Tone; kecil?: string }> = [
        { key: "menggantung", label: "Menggantung", nilai: data ? (ringkas.queued ?? 0) + (ringkas.sending ?? 0) + (ringkas.unknown ?? 0) + (ringkas.rejected ?? 0) : undefined, kecil: "belum terposting" },
        { key: "queued", label: "Antre", nilai: data ? antre : undefined, tone: "info" },
        { key: "sending", label: "Mengirim", nilai: data ? ringkas.sending ?? 0 : undefined },
        { key: "unknown", label: "Tidak pasti", nilai: data ? ringkas.unknown ?? 0 : undefined, tone: ringkas.unknown ? "warn" : undefined },
        { key: "rejected", label: "Ditolak", nilai: data ? ringkas.rejected ?? 0 : undefined, tone: ringkas.rejected ? "neg" : undefined },
        { key: "lewat", label: "Lewat 2 jam", nilai: data?.overdue, tone: data?.overdue ? "warn" : undefined, kecil: data ? `${data.overdueQueue} faktur · ${data.overdueBatches} batch` : undefined },
        { key: "posted", label: "Terposting", nilai: data ? ringkas.posted ?? 0 : undefined, kecil: "semua waktu" },
    ];
    const label = KARTU.find((k) => k.key === saring)?.label ?? "";
    const kosong = !data?.rows.length
        ? saring === "menggantung"
            ? { title: "Tidak ada faktur yang menggantung", message: "Faktur baru muncul di sini setelah batch Order Principal diantrekan atau order internal dibuat fakturnya." }
            : { title: `Tidak ada faktur ${label.toLowerCase()}`, message: "Pilih kartu lain untuk melihat status lain." }
        : { title: "Tidak ada faktur yang sesuai saringan", message: "Ubah kata kunci atau hapus saringan principal." };

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Penjualan</span></li><li><span aria-current="page">Antrean Faktur</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Antrean Faktur</h1>
                    <span className="fi-spacer" />
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={list.status === "memuat" && Boolean(data)} onClick={muatSemua}>Muat ulang</Button>
                </div>
                <p>Faktur yang menunggu dikirim ke Accurate, ditolak, atau belum pasti hasilnya. Umur dihitung sejak masuk antrean; lewat {data ? data.escalateAfterMinutes / 60 : 2} jam masuk laporan OM.</p>
            </header>

            {!bolehUbah && <MessageStrip tone="info" title="Anda hanya bisa melihat antrean.">Mengirim, antre ulang, dan buang butuh izin ubah order.</MessageStrip>}
            {!bolehSelesai && (ringkas.unknown ?? 0) > 0 && (
                <MessageStrip tone="warn" title={`${ringkas.unknown} faktur Tidak pasti menunggu penyelesaian.`}>
                    Menyelesaikannya butuh izin Selesaikan posting tidak pasti — minta IT Support menambahkannya ke grup yang berwenang.
                </MessageStrip>
            )}
            {tidakPasti && <MessageStrip tone="warn" title="Hasil tindakan terakhir belum pasti." onClose={() => setTidakPasti(null)}>{tidakPasti}</MessageStrip>}
            {aksi && (
                <MessageStrip tone={aksi.tone} title={aksi.judul} onClose={() => setAksi(null)}>
                    {aksi.isi}{aksi.riwayat && <> <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => setDialog({ jenis: "riwayat", row: aksi.riwayat! })}>Lihat riwayat</button></>}
                </MessageStrip>
            )}
            {data && data.overdue > 0 && saring !== "lewat" && (
                <MessageStrip tone="warn" title={`${data.overdue} masalah lewat 2 jam:`}>
                    {data.overdueQueue} faktur di antrean{data.overdueBatches > 0 ? ` dan ${data.overdueBatches} batch belum diantrekan (${data.reviewLinesOverdue} baris perlu ditinjau)` : ""}. Masuk laporan OM.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => ganti("lewat")}>Tampilkan saja yang lewat 2 jam</button>
                </MessageStrip>
            )}
            {kiriman && <PanelKiriman k={kiriman} onClose={() => setKiriman(null)} />}

            {!data && list.status === "memuat" ? <div className="fi-panel"><Skeleton rows={2} label="Memuat ringkasan antrean" /></div> : (
                // Tujuh kartu: dua kolom di ponsel supaya daftar tidak terdorong jauh ke bawah.
                <div className="fi-kcards" role="group" aria-label="Saring menurut status" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr))" }}>
                    {KARTU.map((k) => (
                        <button key={k.key} type="button" className="fi-kc" aria-pressed={saring === k.key} data-tone={k.tone} onClick={() => ganti(k.key)}>
                            <span>{k.label}</span>
                            <b>{k.nilai ?? "–"}</b>
                            {(k.kecil || (!data && list.status === "galat")) && <small>{!data && list.status === "galat" ? "gagal dimuat" : k.kecil}</small>}
                        </button>
                    ))}
                </div>
            )}

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={Number(Boolean(principal))} onReset={() => { gantiPrincipal(""); gantiCari(""); }}
                    search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="SO, outlet, pelanggan, sales, nomor faktur" value={cari} onChange={(e) => gantiCari(e.target.value)} />}</FormField>}
                    fields={<FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => gantiPrincipal(e.target.value)}><option value="">Semua principal</option>{principals.map((p) => <option key={p}>{p}</option>)}</select>}</FormField>}
                    chips={principal ? [{ label: `Principal: ${principal}`, onRemove: () => gantiPrincipal("") }] : []} />
            </div>

            {saring === "posted" && data && (ringkas.posted ?? 0) > data.rows.length && (
                <MessageStrip tone="info">Daftar Terposting memuat {data.rows.length} baris TERLAMA dari {ringkas.posted} (batas server). Faktur terbaru dan hasil bacanya ada di Verifikasi balik di bawah.</MessageStrip>
            )}

            <ResponsiveTable<Row> title={saring === "menggantung" ? "Antrean" : `Antrean · ${label}`} count={baris.length} columns={kolom} rows={baris} rowKey={(r) => r.orderId}
                status={list.status} error={list.error} onRetry={muatUlang} empty={kosong}
                selected={dipilih} onSelectedChange={setDipilih} selectableRow={(r) => r.state === "queued" && bolehUbah}
                rowLabel={(r) => `Pilih SO ${nomorSo(r)}`}
                actions={
                    <div className="fi-btnrow" role="group" aria-label="Kirim ke Accurate" style={{ alignItems: "flex-end" }}>
                        <FormField label="Tanggal faktur" help="kosong = tanggal SO">
                            {(a11y) => <input {...a11y} className="fi-input" type="date" max={hariIni} value={tanggal} disabled={!bolehUbah} onChange={(e) => setTanggal(e.target.value)} />}
                        </FormField>
                        {tanggal && <Button variant="tertiary" onClick={() => setTanggal("")}>Pakai tanggal SO</Button>}
                        <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(alasanKirim)} disabledReason={alasanKirim}
                            onClick={() => setDialog({ jenis: "kirim" })}>
                            {dipilihSah.length ? `Kirim ${nKirim} terpilih…` : nKirim ? `Kirim ${nKirim} faktur…` : "Kirim faktur…"}
                        </Button>
                        {alasanKirim && <p className="fi-small fi-subtle" style={{ flexBasis: "100%" }}>Kirim nonaktif: {alasanKirim}.</p>}
                    </div>
                }
                mobileItem={(r) => (
                    <div>
                        <ListItem doc={nomorSo(r)} amount={r.state === "posted" ? undefined : usia(r.ageMinutes)} title={r.outlet || r.customerNo}
                            meta={`${principalDari(r.orderId)} · ${tanggalPendek(r.orderDate)}${r.overdue ? " · lewat 2 jam" : ""}${r.lastError ? ` · ${kalimatAccurate(r.lastError)}` : ""}`}
                            badge={badge(r)} />
                        <div style={{ padding: "0 14px 10px" }}>{aksiBaris(r)}</div>
                    </div>
                )} />
            <p className="fi-small fi-subtle">
                Hanya baris Antre yang bisa dipilih; tanpa pilihan, Kirim mengambil yang antre paling lama (maks. {MAKS_KIRIM} per tekan). Tidak pasti berarti
                Accurate tidak memberi jawaban yang pasti — fakturnya mungkin sudah terbentuk, jadi baris itu tidak pernah dikirim ulang; selesaikan lewat pencarian.
                Mengirim lebih dari {SAPU_MENIT} menit otomatis menjadi Tidak pasti.
            </p>

            <VerifikasiBalik bolehUbah={bolehUbah} load={verif} muatUlang={muatVerif} />

            {data && data.pendingBatches.length > 0 && (
                <ResponsiveTable<Batch> title="Batch belum diantrekan" count={data.pendingBatches.length} columns={kolomBatch} rows={data.pendingBatches} rowKey={(b) => b.id}
                    empty={{ title: "Tidak ada batch tertahan" }}
                    mobileItem={(b) => <ListItem href="/principal-order" doc={b.fileName} amount={usia(b.ageMinutes)} title={`${b.principal} · ${b.lineCount} baris · ${b.reviewCount} perlu ditinjau`}
                        meta={`diunggah ${jamWita(b.uploadedAt)}`} badge={b.overdue ? <StatusBadge tone="warn">Lewat 2 jam</StatusBadge> : undefined} />} />
            )}

            {dialog?.jenis === "kirim" && (
                <KirimDialog dipilih={dipilihSah} tanggal={tanggal} saringanAktif={Boolean(kata || principal)} onClose={tutupDialog} onTidakPasti={tidakPastiTerjadi}
                    onTerkirim={(hasil, urutan) => {
                        setKiriman({ hasil, urutan, tanggal, jam: new Date().toISOString() });
                        setAksi(null);
                        setTidakPasti(null);
                        setDipilih(new Set());
                        setDialog(null);
                        muatSemua();
                    }} />
            )}
            {dialog?.jenis === "selesai" && (
                <SelesaikanDialog row={dialog.row} onClose={tutupDialog} onTidakPasti={tidakPastiTerjadi}
                    onSelesai={(pesan) => aksiSelesai({ tone: "pos", judul: "Faktur tidak pasti diselesaikan.", isi: pesan })} />
            )}
            {dialog?.jenis === "antreUlang" && <AntreUlangDialog row={dialog.row} onClose={tutupDialog} onSelesai={aksiSelesai} onTidakPasti={tidakPastiTerjadi} />}
            {dialog?.jenis === "buang" && <BuangDialog row={dialog.row} onClose={tutupDialog} onSelesai={aksiSelesai} onTidakPasti={tidakPastiTerjadi} />}
            {dialog?.jenis === "riwayat" && <RiwayatDialog row={dialog.row} onClose={tutupDialog} />}
        </div>
    );
}
