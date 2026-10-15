/*
 * Tujuan: Layar Kasir ↔ Incaso (Fiori K2b, BL-59, it11): per ORANG per hari, setoran Kasir (Tunai/Transfer/Giro) dibandingkan pelunasan
 *   Incaso dari cache Accurate (K1b). Kepala (tanggal WITA, status hari, status baca, Segarkan / Baca penuh / Buka kembali), KPI, daftar orang
 *   + uang tak teralokasi + non-kas (kolom 1 FCL), rincian orang (kolom 2), kaki "Setoran…" / "Tutup hari…".
 *   Aturan: angka Incaso null = "belum terbaca" (BUKAN 0); tulis terkunci beralasan TERLIHAT (terkunci / memuat / galat / usang / tanpa izin /
 *   tidak pasti belum diperiksa); Tutup -> bila belum segar, segarkan berulang (jeda ≥ 6 dtk, maks 20×, Batal) -> muat ulang -> dialog
 *   hanya bila penghalang kosong; jawaban TIDAK PASTI -> muat ulang + bandingkan, TANPA ulang otomatis; lewat kunciBerikutnya -> muat ulang.
 * Caller: app/(dashboard)/kasir/page.tsx.
 * Dependensi: GET /api/kasir, POST /api/kasir/segarkan (kontrak docs/handover/KASIR-KONTRAK.md §7–§8), ./bersama, ./DialogKasir, components/fiori.
 * Main Functions: Kasir (default), DetailOrang.
 * Side Effects: fetch (baca + segarkan baca-saja); tulis lewat DialogKasir; timer kunci 20.00 & jeda segarkan.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HandCoins, LockKeyholeOpen, Lock, RefreshCw, RotateCcw } from "lucide-react";
import {
    Button, EmptyState, ErrorState, FlexibleColumnLayout, FooterToolbar, KeyValues, ListItem, MessageStrip, Section, Skeleton, StatusBadge, type Tone,
} from "@/components/fiori/core";
import { FormField, useLoad, type Load } from "@/components/fiori/interactive";
import {
    ALASAN, bacaHari, bacaRincian, bulatAtas100, jamWita, LABEL_STATUS, LABEL_TINDAK, labelEmber, labelMetode, namaTampil, rp, rpSen, segarkan, senDari,
    tanggalPanjang, waktuWita, type BarisOrang, type Hari, type Metode, type Rincian, type StatusBaca,
} from "./bersama";
import { DialogBuka, DialogHapus, DialogJelaskan, DialogSetoran, DialogTutup, type Kabar, type TargetJelaskan } from "./DialogKasir";

/** Segarkan berulang (§7 catatan K2): jeda ≥ 6 dtk antarpanggilan + batas ulang. */
export const JEDA_SEGARKAN_MS = 6_000;
export const MAKS_SEGARKAN = 20;

type Dialog = { jenis: "setoran"; orang: string | null } | { jenis: "jelaskan"; target: TargetJelaskan } | { jenis: "tutup" } | { jenis: "buka" } | { jenis: "hapus" };
type Ragu = { aksi: string; status: "memeriksa" | "selesai" | "gagal"; teks?: string; periksa: (h: Hari) => string };
type Proses = { tujuan: "segarkan" | "tutup"; percobaan: number; teks: string };
type Pesan = { tone: "neg" | "warn" | "info"; teks: string };

const SEBAB_BACA: Record<string, string> = {
    sesi_sinkron: "sesi Accurate akun sinkron kedaluwarsa", hak_akses: "akun sinkron tidak berhak", batas_laju: "Accurate membatasi laju",
    accurate_5xx: "Accurate sedang galat", jaringan: "jaringan ke Accurate putus", tidak_pasti: "jawaban Accurate tidak pasti",
    ditolak: "ada pelunasan ditolak", bentuk: "ada pelunasan berbentuk tak dikenal", nominal: "ada nominal tidak sah", terpotong: "daftar Accurate terpotong",
    hapus_massal: "penghapusan menunggu konfirmasi OM/Admin",
};
const DITOLAK_PEMBACA = new Set(["ditolak", "bentuk", "nominal"]);

function statusBaca(b: StatusBaca | null): { tone: Tone; teks: string } {
    if (!b) return { tone: "neg", teks: "Sesi Accurate akun sinkron belum tersedia" };
    const n = b.jumlahDaftar !== null && b.sisaDetail !== null ? `${b.jumlahDaftar - b.sisaDetail}/${b.jumlahDaftar}` : "";
    const tunda = b.penuhTertundaPada ? ` · baca penuh tertunda sejak ${waktuWita(b.penuhTertundaPada)}` : "";
    const dasar: { tone: Tone; teks: string } = b.status === "lengkap" ? { tone: "pos", teks: `Lengkap ${jamWita(b.lengkapPada)} WITA${b.akun ? ` · akun sinkron ${b.akun}` : ""}` }
        : b.status === "sebagian" ? { tone: "info", teks: `Membaca ${n || "sebagian"}` }
        : b.status === "berjalan" ? (b.aktif ? { tone: "info", teks: "Sedang dibaca" } : { tone: "warn", teks: "Pembaca terhenti — tekan Segarkan" })
        : b.status === "gagal" ? { tone: "neg", teks: `Gagal dibaca: ${SEBAB_BACA[b.sebab ?? ""] ?? b.sebab ?? "galat"}${b.pesan ? ` — ${b.pesan}` : ""}` }
        : { tone: "warn", teks: "Belum dibaca — tekan Segarkan" };
    return { ...dasar, teks: dasar.teks + tunda };
}

function statusHari(h: Hari): { tone: Tone; teks: string } {
    const ev = h.hari.event;
    if (h.hari.terkunci) {
        const tutup = [...ev].reverse().find((e) => e.jenis === "tutup");
        return h.hari.sebab === "tutup" && tutup ? { tone: "pos", teks: `Ditutup ${jamWita(tutup.pada)} WITA oleh ${tutup.oleh}` } : { tone: "neu", teks: "Terkunci otomatis 20.00 WITA" };
    }
    const akhir = ev.at(-1);
    if (akhir?.jenis === "buka") return { tone: "warn", teks: `Dibuka kembali oleh ${akhir.oleh}: ${akhir.alasan ?? ""} · terkunci lagi ${waktuWita(h.hari.kunciBerikutnya)} WITA` };
    return { tone: "info", teks: `Terbuka sampai ${jamWita(h.hari.kunciBerikutnya) || "20.00"} WITA` };
}

const badgeOrang = (b: BarisOrang) => b.status === null ? <StatusBadge tone="neu">Incaso belum terbaca</StatusBadge>
    : b.status !== "klop" && b.dijelaskan ? <StatusBadge tone="info">Dijelaskan</StatusBadge>
        : <StatusBadge tone={LABEL_STATUS[b.status].tone}>{LABEL_STATUS[b.status].label}</StatusBadge>;

const tunda = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function Kasir({ permKeys, hariIni }: { permKeys: string[]; hariIni: string }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const izin = { catat: keys.has("kasir.catat"), tutup: keys.has("kasir.tutup"), buka: keys.has("kasir.buka") };
    const [tanggal, setTanggal] = useState(hariIni);
    const [load, muatUlang] = useLoad(useCallback(() => bacaHari(tanggal), [tanggal]));
    const h = load.data;
    const [pilih, setPilih] = useState<string | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [sukses, setSukses] = useState<string | null>(null);
    const [ragu, setRagu] = useState<Ragu | null>(null);
    const [proses, setProses] = useState<Proses | null>(null);
    const [pesanBaca, setPesanBaca] = useState<Pesan | null>(null);
    /** Kunci yang terlewat menurut timer + `sekarang` server data saat itu (pulih bila GET baru menyatakan server belum sampai kunci itu). */
    const [lewat, setLewat] = useState<{ kb: string; sekarang: string } | null>(null);
    const token = useRef<{ batal: boolean } | null>(null);
    /** Naik tiap kali pemeriksaan "belum pasti" dimulai atau tanggal diganti: hasil pemeriksaan lama diabaikan. */
    const raguKe = useRef(0);
    const muatRef = useRef(muatUlang);
    useEffect(() => { muatRef.current = muatUlang; });
    useEffect(() => () => { if (token.current) token.current.batal = true; }, []);

    // Lewat kunciBerikutnya (20.00 WITA / akhir jendela buka) -> tulis dikunci dan data dimuat ulang sendiri. Jeda dihitung dari jam SERVER
    // (`sekarang` jawaban GET; efek berjalan sesaat sesudah data tiba), bukan jam peramban yang bisa miring. Tiap GET baru menjadwalkan ulang.
    const kb = h?.hari.kunciBerikutnya ?? null;
    const sekarangServer = h?.sekarang ?? null;
    useEffect(() => {
        if (!kb || !sekarangServer) return;
        const ms = Date.parse(kb) - Date.parse(sekarangServer);
        if (!Number.isFinite(ms)) return;
        const t = setTimeout(() => { setLewat({ kb, sekarang: sekarangServer }); muatRef.current(); }, Math.min(Math.max(ms, 0) + 1_000, 2_147_000_000));
        return () => clearTimeout(t);
    }, [kb, sekarangServer]);

    const gantiTanggal = (t: string) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || t > hariIni) return;
        if (token.current) token.current.batal = true;
        raguKe.current += 1;
        setTanggal(t); setPilih(null); setDialog(null); setSukses(null); setRagu(null); setProses(null); setPesanBaca(null);
    };

    async function periksaRagu(aksi: string, periksa: (x: Hari) => string) {
        const ke = ++raguKe.current;
        setRagu({ aksi, periksa, status: "memeriksa" });
        const l = await bacaHari(tanggal);
        if (ke !== raguKe.current) return; // tanggal sudah diganti: hasil ini milik tanggal lain
        muatRef.current();
        setRagu(l.status === "siap" && l.data ? { aksi, periksa, status: "selesai", teks: periksa(l.data) } : { aksi, periksa, status: "gagal", teks: l.error });
    }

    const kabar: Kabar = {
        selesai: (pesan) => { setDialog(null); setSukses(pesan); muatUlang(); },
        ragu: (aksi, periksa) => { setDialog(null); setSukses(null); void periksaRagu(aksi, periksa); },
        muatUlang,
        tutup: () => setDialog(null),
    };

    /** Segarkan (baca-saja Accurate) berulang sampai lengkap; tujuan "tutup" lalu membuka dialog Tutup hanya bila segar ∧ penghalang kosong. */
    async function bacaPelunasan(tujuan: Proses["tujuan"], opsi: { penuh?: boolean; konfirmasiHapus?: boolean } = {}) {
        if (token.current) token.current.batal = true;
        const tk = { batal: false };
        token.current = tk;
        const t = tanggal;
        setPesanBaca(null); setSukses(null);
        let pertama = opsi;
        let hasil: Pesan | null = null;
        let lengkap = false;
        let teks = "Membaca pelunasan Accurate…";
        for (let i = 1; i <= MAKS_SEGARKAN; i++) {
            setProses({ tujuan, percobaan: i, teks });
            const j = await segarkan(t, pertama);
            pertama = {};
            if (tk.batal) return;
            const st = (j.jenis === "ragu" ? null : j.data.status ?? null) as StatusBaca | null;
            const nN = st && st.jumlahDaftar !== null && st.sisaDetail !== null ? ` ${st.jumlahDaftar - st.sisaDetail}/${st.jumlahDaftar}` : "";
            if (j.jenis === "ok" && st?.status !== "sebagian") { lengkap = st?.status === "lengkap"; if (!lengkap) hasil = { tone: "warn", teks: statusBaca(st).teks }; break; }
            if (j.jenis === "ok") teks = `Membaca${nN || " sebagian"}`;
            else if (j.jenis === "tolak" && j.kode === "SEDANG_DIBACA") teks = `Sedang dibaca pembaca lain${nN}…`;
            else {
                // 502 BACA_GAGAL / 503 SESI_SINKRON / 409 HAPUS_MASSAL = jawaban PASTI dari pembaca baca-saja: berhenti, tampilkan sebabnya.
                hasil = j.jenis === "ragu"
                    ? { tone: "warn", teks: "Jawaban pembaca pelunasan belum pasti (koneksi atau server). Pembacaan ini baca-saja; tekan Segarkan lagi bila perlu." }
                    : { tone: j.kode === "HAPUS_MASSAL" ? "warn" : "neg", teks: j.pesan };
                break;
            }
            if (i === MAKS_SEGARKAN) { hasil = { tone: "warn", teks: `Pelunasan belum terbaca lengkap sesudah ${MAKS_SEGARKAN} kali membaca; coba lagi nanti.` }; break; }
            setProses({ tujuan, percobaan: i, teks });
            await tunda(JEDA_SEGARKAN_MS);
            if (tk.batal) return;
        }
        setProses(null);
        if (tujuan === "tutup" && lengkap) {
            const l = await bacaHari(t);
            muatRef.current();
            if (tk.batal) return;
            if (l.status === "siap" && l.data) {
                const p = l.data.penghalangTutup;
                if (l.data.hari.terkunci) hasil = { tone: "info", teks: statusHari(l.data).teks };
                else if (!l.data.segarUntukTutup) hasil = { tone: "warn", teks: "Pelunasan belum segar (dibaca > 15 menit lalu); tekan Tutup hari lagi." };
                else if (!p || !p.bisaDitutup) hasil = { tone: "warn", teks: `Hari belum bisa ditutup: ${(p?.alasan ?? ["angka Incaso belum lengkap."]).join(" ")}` };
                else setDialog({ jenis: "tutup" });
            } else hasil = { tone: "neg", teks: l.error ?? "Data hari gagal dimuat." };
        } else muatRef.current();
        setPesanBaca(hasil);
    }

    const batalBaca = () => { if (token.current) token.current.batal = true; setProses(null); muatUlang(); };

    // ── Kunci tulis (alasan TERLIHAT, tanpa nama kunci mentah) ─────────────────────────────────────────────
    // Usang = timer kunci berbunyi dan belum ada GET baru, ATAU GET baru pun menyatakan jam server sudah melewati kunci itu.
    const usang = Boolean(h && lewat && lewat.kb === h.hari.kunciBerikutnya && (lewat.sekarang === h.sekarang || Date.parse(h.sekarang) >= Date.parse(lewat.kb)));
    const kunciUmum = load.status === "memuat" ? (h ? "Data hari sedang dimuat ulang…" : "Data hari sedang dimuat…")
        : load.status === "galat" ? "Data hari gagal dimuat ulang; muat ulang dulu."
            : usang ? "Pukul 20.00 WITA terlewati; data dimuat ulang…"
                : ragu && ragu.status !== "selesai" ? "Hasil aksi sebelumnya belum pasti; tunggu pemeriksaan sesudah muat ulang."
                    : undefined;
    const kunciHari = !h ? undefined : h.hari.terkunci
        ? (h.hari.sebab === "tutup" ? "Hari sudah ditutup; setoran dan penjelasan terkunci. Membuka kembali hanya OM/Admin."
            : "Hari terkunci otomatis 20.00 WITA; setoran dan penjelasan terkunci. Membuka kembali hanya OM/Admin.")
        : undefined;
    const kunciSetoran = !izin.catat ? ALASAN.catat : kunciUmum ?? kunciHari;
    const kunciJelaskan = kunciSetoran ?? (!h?.baca ? "Sesi Accurate akun sinkron belum tersedia; minta admin login ulang di Sesi Accurate."
        : !h.incaso.lengkap ? "Angka Incaso belum terbaca lengkap; tekan Segarkan dulu." : undefined);
    const ditolak = h?.baca && h.baca.sebab !== "hapus_massal" ? h.baca.ditolak.filter((d) => DITOLAK_PEMBACA.has(d.sebab) || h.baca?.sebab === "ditolak") : [];
    const hapusMassal = h?.baca?.status === "gagal" && h.baca.sebab === "hapus_massal";
    const penghalang = h?.incaso.lengkap && h.penghalangTutup && !h.penghalangTutup.bisaDitutup ? h.penghalangTutup.alasan : null;
    const kunciTutup = !izin.tutup ? ALASAN.tutup : kunciUmum ?? (!h ? undefined
        : h.hari.terkunci ? (h.hari.sebab === "tutup" ? "Hari sudah ditutup." : "Hari terkunci otomatis 20.00 WITA; buka kembali dulu (OM/Admin).")
            : proses ? "Sedang membaca pelunasan Accurate…"
                : !h.baca ? "Sesi Accurate akun sinkron belum tersedia; minta admin login ulang di Sesi Accurate."
                    : hapusMassal ? "Penghapusan pelunasan dari cache menunggu konfirmasi OM/Admin."
                        : ditolak.length ? "Ada pelunasan ditolak pembaca; perbaiki di Accurate dulu — hari tak bisa ditutup."
                            : penghalang ? `${penghalang.length} hal belum dijelaskan: ${penghalang[0]}`
                                : undefined);

    function mulaiTutup() {
        if (!h) return;
        if (h.incaso.lengkap && h.segarUntukTutup && h.penghalangTutup?.bisaDitutup) setDialog({ jenis: "tutup" });
        else void bacaPelunasan("tutup");
    }

    // ── Render ─────────────────────────────────────────────────────────────────────────────────────────────
    const sh = h ? statusHari(h) : null;
    const sb = h ? statusBaca(h.baca) : null;
    const kepala = (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">Kasir ↔ Incaso</span></li></ol></nav>
            <div className="fi-page-bar">
                <h1>Kasir ↔ Incaso</h1>
                {sh && <span aria-live="polite"><StatusBadge tone={sh.tone}>{sh.teks}</StatusBadge></span>}
                <span className="fi-spacer" />
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={proses?.tujuan === "segarkan"} disabled={Boolean(proses) || !h}
                    disabledReason={proses ? "Sedang membaca pelunasan" : "Data hari belum dimuat"} onClick={() => void bacaPelunasan("segarkan")}>Segarkan</Button>
                {izin.buka && (
                    <Button variant="tertiary" icon={<RotateCcw className="fi-icon" aria-hidden />} disabled={Boolean(proses) || !h}
                        disabledReason="Sedang membaca pelunasan" onClick={() => void bacaPelunasan("segarkan", { penuh: true })}>Baca penuh</Button>
                )}
                {h?.hari.terkunci && (
                    <Button icon={<LockKeyholeOpen className="fi-icon" aria-hidden />} disabled={!izin.buka || Boolean(kunciUmum)}
                        disabledReason={!izin.buka ? ALASAN.buka : kunciUmum} onClick={() => setDialog({ jenis: "buka" })}>Buka kembali…</Button>
                )}
            </div>
            <p>Setoran yang Anda terima dibandingkan dengan pelunasan yang diinput Admin Incaso ke Accurate, per orang per tanggal. Klop = sama persis atau
                setoran = pelunasan dibulatkan ke atas ke Rp 100.</p>
            <div className="flex flex-wrap items-end gap-3">
                <FormField label="Tanggal">
                    {(a) => <input {...a} className="fi-input" type="date" max={hariIni} value={tanggal} onChange={(e) => gantiTanggal(e.target.value)} />}
                </FormField>
                <dl className="fi-attrs">
                    <div><dt>Hari</dt><dd>{tanggalPanjang(tanggal)}{h && !h.hari.hariKerja ? " (Minggu)" : ""}</dd></div>
                    <div><dt>Pelunasan Accurate</dt><dd>{sb ? <StatusBadge tone={sb.tone} busy={h?.baca?.status === "berjalan" && h.baca.aktif}>{sb.teks}</StatusBadge> : "—"}</dd></div>
                    {h?.hari.terkunci && !izin.buka && <div><dt>Buka kembali</dt><dd className="fi-small">{ALASAN.buka}</dd></div>}
                </dl>
            </div>
        </header>
    );

    if (!h) {
        return (
            <div className="fi-page">
                {kepala}
                {load.status === "galat" ? <ErrorState title="Data Kasir belum bisa ditampilkan" message={load.error} onRetry={muatUlang} />
                    : <><div className="fi-kcards">{[0, 1, 2, 3].map((i) => <div key={i} className="fi-kc"><Skeleton rows={2} label="Memuat ringkasan" /></div>)}</div>
                        <Skeleton rows={6} label="Membaca pelunasan Accurate dan setoran Kasir" /></>}
            </div>
        );
    }

    const L = h.incaso.lengkap;
    const belum = <small>belum terbaca · bukan nol</small>;
    const nSelisih = h.orang.filter((o) => o.status === "selisih" && !o.dijelaskan).length;
    const nBelum = h.orang.filter((o) => o.status === "belum_setor" && !o.dijelaskan).length;
    const kpi: Array<[string, ReactNode, ReactNode, Tone?]> = [
        ["Pelunasan Incaso", L ? rp(h.total.pelunasan) : "—", L ? <small>{h.orang.reduce((a, o) => a + (o.jumlahFaktur ?? 0), 0)} faktur · {h.orang.filter((o) => o.pelunasan && senDari(o.pelunasan)).length} orang</small> : belum],
        ["Setoran Kasir", rp(h.total.setoran), <small key="s">{h.orang.filter((o) => o.setoran).length} orang mencatat setoran</small>],
        ["Selisih", L ? rp(h.total.selisih) : "—", L ? <small>{nSelisih} selisih · {nBelum} belum setor (belum dijelaskan)</small> : belum, L && senDari(h.total.selisih) ? "neg" : undefined],
        ["Klop", L ? `${h.total.klop} dari ${h.total.jumlahOrang}` : "—", L ? <small>orang</small> : belum, "pos"],
        ["Tak teralokasi", L ? `${h.total.takTeralokasiBelumDijelaskan} belum dijelaskan` : "—", L ? <small>{rp(h.total.takTeralokasi)}</small> : belum, L && h.total.takTeralokasiBelumDijelaskan ? "warn" : undefined],
        ["Non-kas", L ? rp(h.total.nonKas) : "—", L ? <small>{h.nonKas?.length ?? 0} pelunasan · info</small> : belum],
    ];

    const baris = pilih === null ? null : h.orang.find((o) => o.orang === pilih) ?? null;
    const daftar = (
        <div className="grid gap-3">
            <Section title="Orang" subtitle={`${h.orang.length} orang`}>
                {h.orang.length === 0 ? (
                    L ? <EmptyState title={`Belum ada pelunasan Incaso untuk ${tanggalPanjang(tanggal)}`} message="Baris muncul per orang begitu Admin Incaso menginput pelunasan ke Accurate. Setoran tetap bisa dicatat lebih dulu lewat Setoran…." />
                        : <EmptyState title="Belum ada setoran tercatat" message="Pelunasan Incaso belum terbaca lengkap — daftar belum bisa disimpulkan kosong. Setoran tetap bisa dicatat lewat Setoran…." />
                ) : (
                    <ul aria-label="Daftar orang" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {h.orang.map((o) => (
                            <li key={o.orang || "tanpa"}>
                                <ListItem current={pilih === o.orang} onClick={() => setPilih(o.orang)} doc={namaTampil(o)}
                                    amount={o.setoran ? rp(o.setoran.total) : "—"}
                                    title={o.pelunasan === null ? "Incaso belum terbaca" : `Incaso ${rp(o.pelunasan)} · ${o.jumlahFaktur ?? 0} faktur`}
                                    meta={`Kasir ${o.setoran ? rp(o.setoran.total) : "belum setor"} · selisih ${o.selisih === null ? "—" : rp(o.selisih)}`}
                                    badge={badgeOrang(o)} />
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
            {(h.takTeralokasi?.length ?? 0) > 0 && (
                <Section title="Uang tak teralokasi" subtitle="wajib dijelaskan sebelum Tutup">
                    <ul className="fi-berkas" aria-label="Uang tak teralokasi">
                        {h.takTeralokasi!.map((e) => {
                            const catat = h.riwayat.penjelasan.filter((p) => p.jenis === "tak_teralokasi" && p.pelunasanId === e.pelunasanId).at(-1);
                            return (
                                <li key={`${e.pelunasanId}-${e.alasan}`}>
                                    <div className="fi-berkas-head">
                                        <b className="fi-mono">{e.nomor}</b>
                                        {e.dijelaskan ? <StatusBadge tone="info">Dijelaskan</StatusBadge> : <StatusBadge tone="warn">Belum dijelaskan</StatusBadge>}
                                        <span className="fi-spacer" /><b className="fi-tnum">{rp(e.sisa)}</b>
                                    </div>
                                    <span className="fi-small">{labelEmber(e)} · {labelMetode(e.metode)} {rp(e.chequeAmount)} · faktur {rp(e.jumlahInvoicePayment)}{e.orang.length ? ` · ${e.orang.map(namaTampil).join(", ")}` : ""}</span>
                                    {catat && <span className="fi-small fi-muted">“{catat.penjelasan}” — {catat.oleh}, {waktuWita(catat.pada)}{catat.berlaku === false ? " (tidak berlaku lagi: angka berubah)" : ""}</span>}
                                    <div className="fi-btnrow">
                                        <Button disabled={Boolean(kunciJelaskan)} disabledReason={kunciJelaskan}
                                            onClick={() => setDialog({ jenis: "jelaskan", target: { jenis: "tak_teralokasi", pelunasanId: e.pelunasanId } })}>
                                            {e.dijelaskan ? "Jelaskan ulang…" : "Jelaskan…"}</Button>
                                        {kunciJelaskan && <span className="fi-small fi-why">{kunciJelaskan}</span>}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </Section>
            )}
            {(h.nonKas?.length ?? 0) > 0 && (
                <Section title="Non-kas" subtitle="retur / ayat silang — info, tidak dihitung">
                    <ul aria-label="Pelunasan non-kas" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {h.nonKas!.map((x) => <li key={x.pelunasanId}><ListItem doc={x.nomor} amount={rp(x.chequeAmount)} meta={labelMetode(x.metode)} /></li>)}
                    </ul>
                </Section>
            )}
        </div>
    );

    const detail = baris
        ? <DetailOrang key={`${tanggal}:${baris.orang}`} h={h} b={baris} tanggal={tanggal} kunciSetoran={kunciSetoran} kunciJelaskan={kunciJelaskan}
            onSetoran={() => setDialog({ jenis: "setoran", orang: baris.orang })}
            onJelaskan={() => setDialog({ jenis: "jelaskan", target: { jenis: "selisih", orang: baris.orang } })} />
        : <EmptyState title="Pilih orang di daftar" message="Pelunasan per metode, rincian faktur, riwayat revisi setoran, dan penjelasan tampil di sini." />;

    const kunciDialog = dialog?.jenis === "tutup" ? kunciTutup : dialog?.jenis === "buka" ? (!izin.buka ? ALASAN.buka : kunciUmum)
        : dialog?.jenis === "hapus" ? (!izin.buka ? ALASAN.hapus : kunciUmum) : dialog?.jenis === "jelaskan" ? kunciJelaskan : kunciSetoran;
    const umum = { hari: h, tanggal, kunci: kunciDialog, kabar };

    return (
        <div className="fi-page">
            {kepala}
            {sukses && <MessageStrip tone="pos" onClose={() => setSukses(null)}>{sukses}</MessageStrip>}
            {ragu && (
                <MessageStrip tone="warn" title={`Hasil ${ragu.aksi} belum pasti.`} onClose={ragu.status === "memeriksa" ? undefined : () => setRagu(null)}>
                    Server tidak memberi jawaban yang pasti; tidak diulang otomatis.{" "}
                    {ragu.status === "memeriksa" ? "Memuat ulang untuk memeriksa…"
                        : ragu.status === "selesai" ? <b>Pemeriksaan sesudah muat ulang: {ragu.teks}</b>
                            : <>Data belum bisa dimuat ulang untuk memeriksa ({ragu.teks}).{" "}
                                <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => void periksaRagu(ragu.aksi, ragu.periksa)}>Periksa lagi</button></>}
                </MessageStrip>
            )}
            {proses && (
                <MessageStrip tone="info" title={proses.tujuan === "tutup" ? "Menyegarkan pelunasan sebelum Tutup hari." : "Menyegarkan pelunasan."}>
                    {proses.teks} · percobaan {proses.percobaan} dari {MAKS_SEGARKAN} (jeda {JEDA_SEGARKAN_MS / 1000} detik).{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={batalBaca}>Batal</button>
                </MessageStrip>
            )}
            {pesanBaca && <MessageStrip tone={pesanBaca.tone} onClose={() => setPesanBaca(null)}>{pesanBaca.teks}</MessageStrip>}
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {load.error} Yang tampil adalah hasil sebelumnya; tulis dikunci. <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                </MessageStrip>
            )}
            {!L && (
                <MessageStrip tone={h.incaso.sebab === "SESI_SINKRON" ? "neg" : "warn"} title="Angka Incaso belum terbaca.">
                    {h.incaso.pesan} Setoran tetap bisa dicatat; hari tidak bisa ditutup sampai pelunasan terbaca lengkap.
                </MessageStrip>
            )}
            {ditolak.length > 0 && (
                <MessageStrip tone="neg" title={`${ditolak.length} pelunasan ditolak pembaca:`}>
                    {ditolak.map((d) => `${d.nomor || `id ${d.id}`} (${d.pesan || SEBAB_BACA[d.sebab] || d.sebab})`).join("; ")}. Perbaiki di Accurate; hari tak bisa ditutup sampai terbaca.
                </MessageStrip>
            )}
            {hapusMassal && (
                <MessageStrip tone="warn" title={`Pembaca menahan penghapusan ${h.baca!.ditolak.length} pelunasan dari cache:`}>
                    {h.baca!.ditolak.map((d) => d.nomor || `id ${d.id}`).join(", ")}. Hari tak bisa ditutup sampai dikonfirmasi.{" "}
                    {izin.buka
                        ? <Button variant="tertiary" disabled={Boolean(proses || kunciUmum)} disabledReason={kunciUmum ?? "Sedang membaca pelunasan"} onClick={() => setDialog({ jenis: "hapus" })}>Konfirmasi hapus…</Button>
                        : <b>{ALASAN.hapus}</b>}
                </MessageStrip>
            )}
            {h.hari.berubahSejakDitutup && (
                <MessageStrip tone="warn" title="Angka berubah sejak hari ditutup/terkunci.">Pelunasan Incaso diubah sesudahnya; hubungi OM bila hari perlu dibuka kembali.</MessageStrip>
            )}
            {/* Nilai Rupiah panjang: kartu ≥ 12rem dan huruf judul 2 (bukan huruf KPI) supaya angka tidak terpotong ke baris baru. */}
            <div className="fi-kcards" role="group" aria-label="Ringkasan hari" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 12rem), 1fr))" }}>
                {kpi.map(([label, nilai, sub, tone]) => (
                    <div key={label} className="fi-kc" data-tone={tone} role="group" aria-label={label}><span>{label}</span><b style={{ font: "var(--fs-title-2)", fontVariantNumeric: "tabular-nums" }}>{nilai}</b>{sub}</div>
                ))}
            </div>
            <FlexibleColumnLayout list={daftar} detail={detail} detailOpen={baris !== null} onBack={() => setPilih(null)} listLabel="Daftar orang dan uang" detailLabel="Rincian orang" />
            <FooterToolbar message={[kunciTutup ?? (!L ? "Angka Incaso belum terbaca — Tutup hari… akan menyegarkan pelunasan dulu"
                : `Klop ${h.total.klop} dari ${h.total.jumlahOrang} · ${h.segarUntukTutup ? "siap ditutup" : "pelunasan akan disegarkan dulu sebelum ditutup"}`),
                kunciSetoran && kunciSetoran !== kunciTutup ? `Setoran: ${kunciSetoran}` : null].filter(Boolean).join(" · ")}>
                <Button icon={<HandCoins className="fi-icon" aria-hidden />} disabled={Boolean(kunciSetoran)} disabledReason={kunciSetoran}
                    onClick={() => setDialog({ jenis: "setoran", orang: null })}>Setoran…</Button>
                <Button variant="primary" icon={<Lock className="fi-icon" aria-hidden />} disabled={Boolean(kunciTutup)} disabledReason={kunciTutup} onClick={mulaiTutup}>Tutup hari…</Button>
            </FooterToolbar>

            {dialog?.jenis === "setoran" && <DialogSetoran {...umum} orangAwal={dialog.orang} />}
            {dialog?.jenis === "jelaskan" && <DialogJelaskan {...umum} target={dialog.target} />}
            {dialog?.jenis === "tutup" && <DialogTutup {...umum} onBasi={() => { setDialog(null); void bacaPelunasan("tutup"); }} />}
            {dialog?.jenis === "buka" && <DialogBuka {...umum} />}
            {dialog?.jenis === "hapus" && <DialogHapus {...umum} onKonfirmasi={() => void bacaPelunasan("segarkan", { konfirmasiHapus: true })} />}
        </div>
    );
}

const METODE: Metode[] = ["CASH_OTHER", "BANK_TRANSFER", "BANK_CHEQUE"];
const SETOR: Record<Metode, "tunai" | "transfer" | "giro"> = { CASH_OTHER: "tunai", BANK_TRANSFER: "transfer", BANK_CHEQUE: "giro" };

function DetailOrang({ h, b, tanggal, kunciSetoran, kunciJelaskan, onSetoran, onJelaskan }: {
    h: Hari; b: BarisOrang; tanggal: string; kunciSetoran?: string; kunciJelaskan?: string; onSetoran: () => void; onJelaskan: () => void;
}) {
    const L = h.incaso.lengkap;
    const pel = senDari(b.pelunasan);
    const atas = pel === null ? null : bulatAtas100(pel);
    const revisi = h.riwayat.setoran.filter((r) => r.orang === b.orang);
    const kodeRev = [...new Set(revisi.map((r) => r.kode))];
    const jelas = h.riwayat.penjelasan.filter((p) => p.jenis === "selisih" && p.orang === b.orang);
    const t = b.setoranTerakhir;
    const perluJelas = b.status !== null && b.status !== "klop";

    return (
        <div className="grid gap-3 pb-4">
            <header className="fi-oph">
                <div className="fi-oph-title">
                    <h2 style={{ font: "var(--fs-title-1)", overflowWrap: "anywhere" }}>{namaTampil(b)}</h2>
                    {badgeOrang(b)}
                </div>
                <dl className="fi-attrs">
                    <div><dt>Pelunasan Incaso</dt><dd>{b.pelunasan === null ? "belum terbaca" : `${rp(b.pelunasan)} · ${b.jumlahFaktur ?? 0} faktur`}</dd></div>
                    <div><dt>Setoran Kasir</dt><dd>{b.setoran ? rp(b.setoran.total) : "belum setor"}</dd></div>
                    <div><dt>Selisih</dt><dd>{b.selisih === null ? "—" : rp(b.selisih)}</dd></div>
                    {b.kode.length > 1 && <div><dt>Kode digabung</dt><dd>{b.kode.join(", ")}</dd></div>}
                </dl>
            </header>
            <div className="grid gap-3 px-3">
                {(b.salesmanIdTakDikenal?.length ?? 0) > 0 && (
                    <MessageStrip tone="warn" title="Salesman faktur tak dikenal:">ID Accurate {b.salesmanIdTakDikenal!.join(", ")} belum ada di data pegawai; pelunasannya masuk Tanpa salesman.</MessageStrip>
                )}
                {b.orang === "" && (
                    <MessageStrip tone="info" title="Tanpa salesman.">Faktur yang dilunasi tidak bersalesman. Setoran tidak bisa dicatat untuk Tanpa salesman; jelaskan, atau perbaiki salesman faktur di Accurate.</MessageStrip>
                )}
                <Section title="Pelunasan vs setoran per metode">
                    <div className="fi-sect-in grid gap-2">
                        <KeyValues items={METODE.map((m) => [labelMetode(m),
                            `Incaso ${b.pelunasanPerMetode ? rp(b.pelunasanPerMetode[m] ?? "0") : "belum terbaca"} · Kasir ${b.setoran ? rp(b.setoran[SETOR[m]]) : "—"}`] as [string, ReactNode])} />
                        <p className="fi-small fi-muted">
                            {pel === null ? "Aturan klop terbaca sesudah pelunasan Incaso terbaca lengkap."
                                : `Klop bila setoran ${rpSen(pel)}${atas !== pel ? ` atau ${rpSen(atas!)} (dibulatkan ke atas ke Rp 100)` : ""}; selain itu selisih wajib dijelaskan.`}
                        </p>
                        <div className="fi-btnrow">
                            {b.orang !== "" && (
                                <Button variant="primary" icon={<HandCoins className="fi-icon" aria-hidden />} disabled={Boolean(kunciSetoran)} disabledReason={kunciSetoran} onClick={onSetoran}>
                                    {b.setoran ? "Koreksi setoran…" : "Catat setoran…"}</Button>
                            )}
                            {perluJelas && (
                                <Button disabled={Boolean(kunciJelaskan)} disabledReason={kunciJelaskan} onClick={onJelaskan}>{b.dijelaskan ? "Jelaskan ulang…" : "Jelaskan…"}</Button>
                            )}
                        </div>
                        {((b.orang !== "" && kunciSetoran) || (perluJelas && kunciJelaskan)) && (
                            <p className="fi-small fi-why">{b.orang !== "" && kunciSetoran ? kunciSetoran : kunciJelaskan}</p>
                        )}
                    </div>
                </Section>
                {t && (
                    <Section title="Setoran terakhir" subtitle={`${t.kode} revisi ${t.revisi}`}>
                        <div className="fi-sect-in">
                            <KeyValues items={[
                                ["Nomor Form Kasir", t.noFormKasir ?? "—"],
                                ["Bukti transfer", t.buktiUrl ? <a key="b" href={t.buktiUrl} target="_blank" rel="noopener noreferrer">Lihat bukti</a> : "—"],
                                ...(t.giroNomor ? [["Giro", `BG ${t.giroNomor} · jatuh tempo ${t.giroJatuhTempo ? tanggalPanjang(t.giroJatuhTempo) : "—"}`] as [string, ReactNode]] : []),
                                ["Catatan", t.catatan ?? "—"],
                                ["Dicatat", `${t.oleh} · ${waktuWita(t.pada)} WITA`],
                            ]} />
                        </div>
                    </Section>
                )}
                {/* key = waktu muat hari: rincian dimuat ulang setiap kali hari dimuat ulang (tidak meminjam rincian lama). */}
                <RincianFaktur key={h.sekarang} tanggal={tanggal} orang={b.orang} lengkap={L} />
                <Section title="Riwayat revisi setoran" subtitle={`${revisi.length} revisi`}>
                    <div className="fi-sect-in grid gap-2">
                        {revisi.length === 0 ? <p className="fi-small fi-muted">Belum ada setoran tercatat.</p> : kodeRev.map((k) => (
                            <div key={k} className="grid gap-1">
                                <b className="fi-small">Kode {k}</b>
                                <ul className="fi-berkas">
                                    {revisi.filter((r) => r.kode === k).map((r) => (
                                        <li key={r.id} className="fi-small">
                                            Revisi {r.revisi}: Tunai {rp(r.tunai)} · Transfer {rp(r.transfer)} · Giro {rp(r.giro)} · total {rp(r.total)}
                                            {r.noFormKasir ? ` · Form ${r.noFormKasir}` : ""}{r.giroNomor ? ` · BG ${r.giroNomor}` : ""}
                                            {r.buktiUrl ? <> · <a href={r.buktiUrl} target="_blank" rel="noopener noreferrer">bukti</a></> : null}
                                            {r.catatan ? ` · “${r.catatan}”` : ""} — {r.oleh}, {waktuWita(r.pada)}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </Section>
                <Section title="Penjelasan" subtitle={`${jelas.length}`}>
                    <div className="fi-sect-in grid gap-2">
                        {jelas.length === 0 ? <p className="fi-small fi-muted">Belum ada penjelasan.</p> : (
                            <ul className="fi-berkas">
                                {jelas.map((p) => p.jenis === "selisih" && (
                                    <li key={p.id} className="fi-small">
                                        “{p.penjelasan}” · {LABEL_TINDAK[p.tindakLanjut] ?? p.tindakLanjut} · pelunasan {rp(p.pelunasan)} / setoran {rp(p.setoran)} — {p.oleh}, {waktuWita(p.pada)}{" "}
                                        {p.berlaku === true ? <StatusBadge tone="pos">Berlaku</StatusBadge> : p.berlaku === false ? <StatusBadge tone="warn">Tidak berlaku lagi (angka berubah)</StatusBadge> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </Section>
            </div>
        </div>
    );
}

function RincianFaktur({ tanggal, orang, lengkap }: { tanggal: string; orang: string; lengkap: boolean }) {
    const [rinci, muatRinci] = useLoad(useCallback((): Promise<Load<Rincian>> =>
        (lengkap ? bacaRincian(tanggal, orang) : Promise.resolve({ status: "siap", data: null })), [tanggal, orang, lengkap]));
    return (
        <Section title="Rincian faktur" subtitle={lengkap ? undefined : "belum terbaca"}>
            <div className="fi-sect-in grid gap-2">
                {!lengkap ? <p className="fi-small fi-muted">Rincian faktur tampil sesudah pelunasan Incaso terbaca lengkap.</p>
                    : rinci.status === "galat" ? <ErrorState title="Rincian faktur gagal dimuat" message={rinci.error} onRetry={muatRinci} />
                        : rinci.status === "memuat" ? <Skeleton rows={3} label="Memuat rincian faktur" />
                            : !rinci.data || rinci.data.pelunasan.length === 0 ? <p className="fi-small fi-muted">Tidak ada pelunasan Incaso untuk orang ini.</p>
                                : (
                                    <ul className="fi-berkas" aria-label="Rincian faktur">
                                        {rinci.data.pelunasan.map((p) => (
                                            <li key={p.pelunasanId}>
                                                <div className="fi-berkas-head"><b className="fi-mono">{p.nomor}</b><span className="fi-small">{labelMetode(p.metode)}</span><span className="fi-spacer" /><b className="fi-tnum">{rp(p.bagian)}</b></div>
                                                {p.faktur.map((f) => <span key={f.fakturId} className="fi-small"><span className="fi-mono">{f.nomorFaktur ?? `faktur id ${f.fakturId}`}</span> · {rp(f.invoicePayment)}</span>)}
                                            </li>
                                        ))}
                                    </ul>
                                )}
            </div>
        </Section>
    );
}
