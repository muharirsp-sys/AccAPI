/*
 * Tujuan: Wizard Pelunasan (Fiori S6e-2b, it02 #16–19): 1 Jenis (Pembayaran pembelian nonaktif, D-06) → 2 Unggah (Format Pelunasan Internal,
 *   berkas lain = kosong beralasan) → 3 Akun (rekening Tunai/Trf/BG, Pot.1–3, penomoran Otomatis; BG/potongan wajib bila berkas memuatnya)
 *   → 4 Tinjau → 5 Hasil (LangkahKirim). Kepala menampilkan database Accurate aktif + tautan halaman Sesi Accurate (S7-sesi: masuk & pilih database tanpa Konsol).
 *   Langkah Jenis juga memuat daftar Perlu tindakan (Tidak pasti + Gagal dari kiriman sebelumnya, BL-41) dengan Selesaikan untuk Finance.
 * Caller: app/(dashboard)/pelunasan/page.tsx.
 * Dependensi: lib/pelunasan (deteksi/parse, pratinjau ganda, tanggal WITA), lib/pelunasan-wizard, lib/apiFetcher (GET Accurate lewat proxy),
 *   ./bersama (sesi, pratinjau lock), ./LangkahKirim, ./Selesaikan (DaftarTindakan), components/fiori.
 * Main Functions: Pelunasan.
 * Side Effects: membaca berkas di peramban; GET Accurate (faktur, retur, riwayat) + pratinjau lock (baca-saja). Tulis hanya di LangkahKirim.
 */
"use client";

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Code2, Database, ExternalLink, FileSpreadsheet, HandCoins, RefreshCw, Undo2, Wallet } from "lucide-react";
import { Button, Flow, FooterToolbar, MessageStrip, Section, Skeleton, StatusBadge, type FlowStep } from "@/components/fiori/core";
import { FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { accurateFetch } from "@/lib/apiFetcher";
import { deteksiFormatPelunasan, parsePelunasan } from "@/lib/pelunasan/parser";
import { pratinjauDuplikat } from "@/lib/pelunasan/pratinjau-ganda";
import { tanggalKemarin } from "@/lib/pelunasan/payload";
import type { Bebas } from "@/lib/pelunasan/sel";
import { AKUN_KOSONG, bersihkanHeader, isiBerkas, periksaAkun, petaDari, type Akun, type IsiBerkas } from "@/lib/pelunasan-wizard";
import { ALASAN, bacaSesi, namaDatabase, pratinjauKunci, type Sesi } from "./bersama";
import { LangkahHasil, LangkahTinjau, type Hasil, type Tinjauan } from "./LangkahKirim";
import { DaftarTindakan } from "./Selesaikan";

const LANGKAH = ["Jenis", "Unggah", "Akun", "Tinjau", "Hasil"];
type Berkas = { nama: string; sheet: string; rows: Bebas[]; isi: IsiBerkas };
type Bacaan = { status: "memuat"; nama: string } | { status: "kosong"; nama: string; sheet: string } | { status: "galat"; nama: string; pesan: string } | null;

function Kepala({ langkah, sesi, onPeriksa }: { langkah: number; sesi: Load<Sesi>; onPeriksa: () => void }) {
    const steps: FlowStep[] = LANGKAH.map((label, i) => ({ label, state: i < langkah ? "done" : i === langkah ? "current" : "todo" }));
    const s = sesi.data;
    const badge = !s && sesi.status === "memuat" ? <StatusBadge tone="neu" busy>Memeriksa sesi Accurate…</StatusBadge>
        : !s ? <StatusBadge tone="neg">Sesi Accurate tidak terbaca</StatusBadge>
            : !s.connected ? <StatusBadge tone="warn">Belum masuk ke Accurate</StatusBadge>
                : !s.databaseConnected ? <StatusBadge tone="warn">Database Accurate belum dibuka</StatusBadge>
                    : <StatusBadge tone="info">Database: {namaDatabase(s)}</StatusBadge>;
    return (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">Pelunasan penjualan</span></li></ol></nav>
            <div className="fi-page-bar">
                <h1>Pelunasan penjualan</h1>
                <span aria-live="polite">{badge}</span>
                <span className="fi-spacer" />
                <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={sesi.status === "memuat" && Boolean(s)} onClick={onPeriksa}>Periksa ulang sesi</Button>
                {/* pelunasan.kirim (gerbang halaman ini) termasuk SESI_ACCURATE_KEYS — tautan selalu boleh dibuka. */}
                <a className="fi-btn fi-btn--secondary" href="/sesi-accurate?returnTo=/pelunasan" target="_blank" rel="noopener"><ExternalLink className="fi-icon" aria-hidden />Masuk/ganti database Accurate</a>
            </div>
            <p>Unggah Format Pelunasan Internal, pilih rekening dan akun, tinjau baris ganda dan retur manual, lalu kirim ke Accurate. Login Accurate dan
                pilihan database di halaman Sesi Accurate (tab baru); kembali ke sini lalu tekan Periksa ulang sesi.</p>
            <Flow steps={steps} label="Langkah Pelunasan" />
        </header>
    );
}

/** Kartu jenis dokumen yang tidak dikerjakan di wizard ini: tautan Konsol (Admin/IT) atau nonaktif dengan alasan terlihat. */
function JenisLain({ judul, isi, alasan, href, ikon }: { judul: string; isi: string; alasan: string; href?: string; ikon: ReactNode }) {
    const badan = <><span className="fi-tile-ico" aria-hidden>{ikon}</span><span className="fi-tile-t">{judul}</span><span className="fi-tile-s">{isi}</span><span className="fi-tile-f">{alasan}</span></>;
    return href
        ? <a className="fi-tile" href={href} target="_blank" rel="noopener">{badan}</a>
        : <button type="button" className="fi-tile" disabled style={{ opacity: 0.62, cursor: "not-allowed", transform: "none" }}>{badan}</button>;
}

export default function Pelunasan({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const izin = { kirim: keys.has("pelunasan.kirim"), izinkan: keys.has("finance.override_duplicate"), selesaikan: keys.has("finance.resolve_unknown") };
    const bisaKonsol = canAccessPathWithKeys("/api-wrapper", keys);

    const [sesi, muatSesi] = useLoad(useCallback(() => bacaSesi(), []));
    const [langkah, setLangkah] = useState(0);
    const [tanggal, setTanggal] = useState(() => tanggalKemarin());
    const [bacaan, setBacaan] = useState<Bacaan>(null);
    const [berkas, setBerkas] = useState<Berkas | null>(null);
    const [akun, setAkun] = useState<Akun>(AKUN_KOSONG);
    const [tinjauan, setTinjauan] = useState<Tinjauan | null>(null);
    const [hasil, setHasil] = useState<Hasil | null>(null);
    const [menyiapkan, setMenyiapkan] = useState<string | null>(null);
    const [galatSiap, setGalatSiap] = useState<string | null>(null);
    const sedang = useRef(false);
    const urutBaca = useRef(0);
    useUnsavedGuard(Boolean(berkas) && !hasil);

    const s = sesi.data;
    const sesiSiap = sesi.status === "siap" && Boolean(s?.databaseConnected && s.databaseId);
    const kunciSesi = sesi.status === "memuat" ? "Sesi Accurate sedang diperiksa."
        : sesi.status === "galat" ? "Sesi Accurate tidak terbaca; tekan Periksa ulang sesi."
            : !sesiSiap ? "Masuk ke Accurate dan buka database dulu (halaman Sesi Accurate), lalu Periksa ulang sesi." : undefined;

    function mulaiBaru() {
        setLangkah(1); setBacaan(null); setBerkas(null); setAkun(AKUN_KOSONG); setTinjauan(null); setHasil(null); setGalatSiap(null); setTanggal(tanggalKemarin());
    }

    async function pilihBerkas(file: File | null) {
        const urut = ++urutBaca.current;
        setBerkas(null); setTinjauan(null); setGalatSiap(null);
        if (!file) { setBacaan(null); return; }
        setBacaan({ status: "memuat", nama: file.name });
        try {
            const XLSX = await import("xlsx");
            const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
            const sheet = wb.SheetNames[0] ?? "";
            const rows = bersihkanHeader(sheet ? XLSX.utils.sheet_to_json<Bebas>(wb.Sheets[sheet]) : []);
            if (urut !== urutBaca.current) return; // berkas lain dipilih selagi membaca
            if (!deteksiFormatPelunasan(rows)) { setBacaan({ status: "kosong", nama: file.name, sheet }); return; }
            setBacaan(null);
            setBerkas({ nama: file.name, sheet, rows, isi: isiBerkas(rows) });
        } catch (e) {
            if (urut === urutBaca.current) setBacaan({ status: "galat", nama: file.name, pesan: e instanceof Error ? e.message : "Berkas tidak bisa dibuka." });
        }
    }

    const galatAkun = berkas ? periksaAkun(akun, berkas.isi) : {};
    const nGalatAkun = Object.keys(galatAkun).length;

    /**
     * Langkah 3 → 4: parse dengan akun terpilih (GET Accurate) lalu pratinjau ganda (lock pratinjau + riwayat). Tidak menulis apa pun.
     * Juga dipanggil "Ulangi pratinjau" di Tinjau (tombol itu tidak dikunci sesi) — belum bisa jalan = alasan terbaca, bukan diam (2b #8).
     */
    async function siapkanTinjauan() {
        if (sedang.current) return;
        if (!berkas || !sesiSiap || !s || nGalatAkun) {
            setGalatSiap(`Pratinjau belum bisa dibuat. ${!berkas ? "Berkas belum dipilih." : nGalatAkun ? "Rekening/akun wajib belum lengkap di langkah Akun."
                : kunciSesi ?? "Sesi Accurate belum siap."} Tidak ada yang dikirim ke Accurate.`);
            return;
        }
        sedang.current = true;
        setGalatSiap(null); setMenyiapkan("Membaca faktur dan retur di Accurate…");
        const peringatan: string[] = [];
        try {
            const out = await parsePelunasan(berkas.rows, {
                trxDate: tanggal, isKeySaved: true, peta: petaDari(akun), accurateFetch,
                lapor: (jenis, pesan) => { if (jenis === "loading") setMenyiapkan(pesan); else if (jenis !== "success") peringatan.push(pesan); },
            });
            setMenyiapkan("Memeriksa baris ganda (kunci aplikasi dan riwayat Accurate)…");
            const cek = out.payload.length ? await pratinjauDuplikat(out.payload, "pelunasan", { accurateFetch, pratinjauKunci }) : null;
            // 2b #4: database bisa diganti di Sesi Accurate/Konsol (tab lain) SELAMA pratinjau — faktur, retur, dan riwayat mungkin terbaca dari
            // database lain. Sesi dibaca ulang; berbeda dari awal / tak terbaca = pratinjau dibuang dengan alasan.
            const akhir = await bacaSesi();
            if (akhir.status !== "siap" || !akhir.data?.databaseConnected || akhir.data.databaseId !== s.databaseId) {
                muatSesi();
                throw new Error(akhir.status !== "siap" || !akhir.data ? `Sesi Accurate tidak terbaca di akhir pratinjau (${akhir.error ?? "tanpa jawaban"}); pratinjau dibuang.`
                    : !akhir.data.databaseConnected ? "Sesi Accurate berakhir selama pratinjau; pratinjau dibuang."
                        : `Database Accurate berubah selama pratinjau (dari ${namaDatabase(s)} ke ${namaDatabase(akhir.data)}); pratinjau dibuang karena faktur dan riwayat bisa terbaca dari database lain. Ulangi pratinjau.`);
            }
            setTinjauan({
                payload: out.payload, manualRows: out.manualRows ?? [], review: cek?.reviewRows ?? [], peringatan,
                dibaca: out.counts.read, dilewati: out.counts.skipped,
                databaseId: s.databaseId as string, databaseAlias: s.databaseAlias, tanggal, namaBerkas: berkas.nama, dibuat: Date.now(),
            });
            setLangkah(3);
        } catch (e) {
            setGalatSiap(`${e instanceof Error ? e.message : "Pratinjau gagal."} Tidak ada yang dikirim ke Accurate.`);
        } finally {
            sedang.current = false;
            setMenyiapkan(null);
        }
    }

    const kepala = <Kepala langkah={langkah} sesi={sesi} onPeriksa={muatSesi} />;

    if (langkah === 4 && hasil && tinjauan) {
        return <div className="fi-page" style={{ paddingBottom: 0 }}>{kepala}<LangkahHasil tinjauan={tinjauan} hasil={hasil} izin={izin} onBaru={mulaiBaru} /></div>;
    }
    if (langkah === 3 && tinjauan) {
        return (
            <div className="fi-page" style={{ paddingBottom: 0 }}>
                {kepala}
                <LangkahTinjau key={tinjauan.dibuat} tinjauan={tinjauan} sesi={sesi} muatSesi={muatSesi} izin={izin}
                    menyiapkan={menyiapkan} galatSiap={galatSiap} onUlangi={() => void siapkanTinjauan()}
                    onKembali={() => { setTinjauan(null); setLangkah(2); }}
                    onHasil={(h) => { setHasil(h); setLangkah(4); }} />
            </div>
        );
    }

    if (langkah === 0) {
        return (
            <div className="fi-page" style={{ paddingBottom: 0 }}>
                {kepala}
                <Section title="Pilih jenis dokumen" subtitle="menggantikan pilihan 231 endpoint Konsol">
                    <div className="fi-sect-in">
                        <div className="fi-tiles">
                            <button type="button" className="fi-tile" onClick={() => setLangkah(1)}>
                                <span className="fi-tile-ico" aria-hidden><HandCoins className="fi-icon" /></span>
                                <span className="fi-tile-t">Pelunasan penjualan</span>
                                <span className="fi-tile-s">Format Pelunasan Internal: Tunai, Transfer, BG, potongan. Cek ganda dan retur manual.</span>
                                <span className="fi-tile-f">sales-receipt · diinput Admin Incaso</span>
                            </button>
                            <JenisLain judul="Retur pembelian" isi="Berkas retur dari principal. Belum menjadi wizard." ikon={<Undo2 className="fi-icon" />}
                                href={bisaKonsol ? "/api-wrapper" : undefined} alasan={bisaKonsol ? "Lewat Konsol AOL (tab baru)" : `Nonaktif: ${ALASAN.konsol}`} />
                            <JenisLain judul="Pembayaran pembelian" isi="Pembayaran ke principal dikunci dan dicatat per percobaan di Finance." ikon={<Wallet className="fi-icon" />}
                                alasan="Nonaktif: diposting dari Finance, tidak tersedia di sini (D-06)." />
                            <JenisLain judul="Lainnya dari templat Excel" isi="Konsol endpoint untuk Admin/IT: templat 3 sheet, kolom = nama parameter API." ikon={<Code2 className="fi-icon" />}
                                href={bisaKonsol ? "/api-wrapper" : undefined} alasan={bisaKonsol ? "Konsol AOL (tab baru)" : `Nonaktif: ${ALASAN.konsol}`} />
                        </div>
                    </div>
                </Section>
                <DaftarTindakan izinSelesaikan={izin.selesaikan} izinTakeover={izin.izinkan} sesi={s} sesiMemuat={sesi.status === "memuat"} />
            </div>
        );
    }

    if (langkah === 1) {
        const kunciLanjut = bacaan?.status === "memuat" ? "Berkas sedang dibaca."
            : bacaan?.status === "kosong" ? "Berkas tidak berisi baris pelunasan; pilih berkas lain."
                : !berkas ? "Pilih berkas Format Pelunasan dulu." : !tanggal ? "Isi tanggal transaksi dulu." : undefined;
        return (
            <div className="fi-page" style={{ paddingBottom: 0 }}>
                {kepala}
                <Section title="Berkas pelunasan" subtitle="sheet pertama dibaca; tidak ada yang dikirim di langkah ini">
                    <div className="fi-sect-in">
                        <div className="fi-formgrid">
                            <FormField label="Tanggal transaksi" required help="Bawaan: kemarin menurut WITA. Menjadi tanggal pelunasan di Accurate.">
                                {(a11y) => <input {...a11y} type="date" className="fi-input" value={tanggal} onChange={(e) => { setTanggal(e.target.value); setTinjauan(null); }} />}
                            </FormField>
                            <div className="fi-dropzone" data-ok={berkas ? "true" : undefined}>
                                <label className="fi-label" htmlFor="pelunasan-berkas">Berkas Format Pelunasan<span className="fi-req" aria-hidden>*</span></label>
                                <span>{berkas
                                    ? <><FileSpreadsheet className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> <b>{berkas.nama}</b> · sheet {berkas.sheet}</>
                                    : "Kolom Code Outlet, No. Nota, Tunai, Trf, BG, Pot.1–3 · .xlsx atau .xls"}</span>
                                <input id="pelunasan-berkas" className="fi-input" type="file" accept=".xlsx,.xls" disabled={bacaan?.status === "memuat"}
                                    onChange={(e) => void pilihBerkas(e.target.files?.[0] ?? null)} />
                            </div>
                        </div>
                    </div>
                </Section>
                {bacaan?.status === "memuat" && <><p className="fi-small" role="status">Membaca {bacaan.nama}…</p><Skeleton rows={3} label="Membaca berkas" /></>}
                {bacaan?.status === "kosong" && (
                    <MessageStrip tone="neg" title="Berkas tidak berisi baris pelunasan.">
                        Kolom Code Outlet dan No. Nota (dengan kolom Tunai/Trf/BG/potongan) tidak ditemukan di sheet pertama{bacaan.sheet ? ` (${bacaan.sheet})` : ""} {bacaan.nama}. Tidak ada yang dikirim; pilih berkas lain.
                    </MessageStrip>
                )}
                {bacaan?.status === "galat" && <MessageStrip tone="neg" title="Berkas tidak terbaca.">{bacaan.nama}: {bacaan.pesan} Pilih berkas lain.</MessageStrip>}
                {berkas && (
                    <Section title="Isi berkas" subtitle={`${berkas.nama} · sheet ${berkas.sheet}`}>
                        <div className="fi-sect-in">
                            <div className="fi-kcards" aria-label="Ringkasan berkas" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
                                <div className="fi-kc"><span>Baris dibaca</span><b>{berkas.isi.baris}</b><small>berisi Code Outlet atau No. Nota</small></div>
                                <div className="fi-kc"><span>Berisi BG</span><b>{berkas.isi.bg}</b><small>{berkas.isi.bg ? "rekening BG wajib di langkah Akun" : "rekening BG tidak dipakai"}</small></div>
                                <div className="fi-kc"><span>Berisi potongan</span><b>{berkas.isi.pot.reduce((a, b) => a + b, 0)}</b><small>Pot.1 {berkas.isi.pot[0]} · Pot.2 {berkas.isi.pot[1]} · Pot.3 {berkas.isi.pot[2]}</small></div>
                            </div>
                        </div>
                    </Section>
                )}
                <FooterToolbar message={kunciLanjut ?? `${berkas?.isi.baris ?? 0} baris dibaca`}>
                    <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} onClick={() => setLangkah(0)}>Kembali</Button>
                    <Button variant="primary" icon={<ArrowRight className="fi-icon" aria-hidden />} disabled={Boolean(kunciLanjut)} disabledReason={kunciLanjut} onClick={() => setLangkah(2)}>Lanjut ke Akun</Button>
                </FooterToolbar>
            </div>
        );
    }

    // ── Langkah 3 · Akun ─────────────────────────────────────────────────────────────────────────────────
    const isi = berkas?.isi;
    const kunciTinjau = !berkas ? "Berkas belum dipilih." : menyiapkan ? "Pratinjau sedang disiapkan."
        : nGalatAkun ? (galatAkun.bg ? "Lengkapi rekening BG" : "Lengkapi rekening dan akun yang wajib") : kunciSesi;
    const ubah = (k: keyof Akun) => (e: ChangeEvent<HTMLInputElement>) => { setAkun((a) => ({ ...a, [k]: e.target.value })); setTinjauan(null); };
    const wajibBila = (n: number, apa: string) => (n > 0 ? `Wajib: ${n} ${apa}.` : "Tidak dipakai di berkas ini.");
    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            {kepala}
            {berkas && kunciSesi && !menyiapkan && (
                <MessageStrip tone={sesi.status === "galat" ? "neg" : "warn"} title="Pratinjau butuh database Accurate yang terbuka.">
                    {kunciSesi} Pratinjau mencari faktur, retur, dan riwayat pelunasan di Accurate.
                </MessageStrip>
            )}
            {galatSiap && <MessageStrip tone="neg" title="Pratinjau gagal." onClose={() => setGalatSiap(null)}>{galatSiap}</MessageStrip>}
            <Section title="Rekening dan akun" subtitle={`dipakai untuk ${isi?.baris ?? 0} baris · ${berkas?.nama ?? ""}`}>
                <div className="fi-sect-in">
                    <div className="fi-formgrid">
                        <FormField label="Rekening Tunai" help="Kosong = 110102 (bawaan aplikasi)." error={galatAkun.tunai}>
                            {(a11y) => <input {...a11y} className="fi-input" value={akun.tunai} onChange={ubah("tunai")} placeholder="No. akun kas" />}
                        </FormField>
                        <FormField label="Rekening Transfer" required={(isi?.trfTanpaBank ?? 0) > 0} error={galatAkun.trf}
                            help={isi?.trfTanpaBank ? "Dipakai baris transfer yang Ket. Trf-nya bukan Maybank/Permata." : "Ket. Trf Maybank/Permata memakai rekening bank itu; selebihnya rekening ini."}>
                            {(a11y) => <input {...a11y} className="fi-input" value={akun.trf} onChange={ubah("trf")} placeholder="No. akun bank" />}
                        </FormField>
                        <FormField label="Rekening BG" required={(isi?.bg ?? 0) > 0} error={galatAkun.bg} help={galatAkun.bg ? undefined : wajibBila(isi?.bg ?? 0, "baris berisi BG")}>
                            {(a11y) => <input {...a11y} className="fi-input" value={akun.bg} onChange={ubah("bg")} placeholder="No. akun BG" />}
                        </FormField>
                        <FormField label="Penomoran" help="Nomor pelunasan diberi Accurate.">
                            {(a11y) => <input {...a11y} className="fi-input" value="Otomatis (AutoNumber Accurate)" readOnly />}
                        </FormField>
                        <FormField label="Akun Potongan 1" required={(isi?.pot[0] ?? 0) > 0} error={galatAkun.pot1} help={galatAkun.pot1 ? undefined : wajibBila(isi?.pot[0] ?? 0, "baris berisi Pot.1 Kwtnsi")}>
                            {(a11y) => <input {...a11y} className="fi-input" value={akun.pot1} onChange={ubah("pot1")} placeholder="No. akun GL" />}
                        </FormField>
                        <FormField label="Akun Potongan 2" required={(isi?.pot[1] ?? 0) > 0} error={galatAkun.pot2} help={galatAkun.pot2 ? undefined : wajibBila(isi?.pot[1] ?? 0, "baris berisi Pot.2 Kwtnsi")}>
                            {(a11y) => <input {...a11y} className="fi-input" value={akun.pot2} onChange={ubah("pot2")} placeholder="No. akun GL" />}
                        </FormField>
                        {(isi?.pot[2] ?? 0) > 0 && (
                            <FormField label="Akun Potongan 3" required error={galatAkun.pot3} help={galatAkun.pot3 ? undefined : wajibBila(isi?.pot[2] ?? 0, "baris berisi Pot.3 Kwtnsi")}>
                                {(a11y) => <input {...a11y} className="fi-input" value={akun.pot3} onChange={ubah("pot3")} placeholder="No. akun GL" />}
                            </FormField>
                        )}
                    </div>
                </div>
            </Section>
            {menyiapkan && <><p className="fi-small" role="status">{menyiapkan}</p><Skeleton rows={3} label="Menyiapkan pratinjau" /></>}
            <FooterToolbar message={kunciTinjau ?? `Tanggal ${tanggal.split("-").reverse().join("/")} · pratinjau tidak mengirim apa pun`}>
                <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} disabled={Boolean(menyiapkan)} onClick={() => setLangkah(1)}>Kembali</Button>
                <Button variant="primary" icon={<Database className="fi-icon" aria-hidden />} busy={Boolean(menyiapkan)} disabled={Boolean(kunciTinjau)} disabledReason={kunciTinjau}
                    onClick={() => void siapkanTinjauan()}>Lanjut ke Tinjau</Button>
            </FooterToolbar>
        </div>
    );
}
