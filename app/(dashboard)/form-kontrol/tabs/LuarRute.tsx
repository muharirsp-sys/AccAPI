/*
 * Tujuan: Kunjungan LUAR RUTE di layar salesman (FK-MSM2, owner 12 Okt 2026): (1) TambahLuarRute di Rute hari ini — cari pelanggan cabang
 *   salesman (pemilih O2: jeda 300 ms, minimal 2 huruf, permintaan lama dibatalkan) lalu tambahkan ke kunjungan HARI INI; toko yang sudah
 *   di rute tidak bisa ditambah ganda. (2) KonfirmasiLuarRute di Laporan harian — per toko luar rute yang DIKUNJUNGI: masuk JKS (hari +
 *   minggu) / jangan masukkan JKS / biarkan "nanti" (tetap menunggu; laporan tetap bisa dikirim); peringatan bila toko ada di JKS salesman lain.
 *   (3) BatalkanLuarRute di kartu toko Rute hari ini (owner 13 Okt): kunjungan salah tambah dibatalkan (batal lunak di server).
 * Caller: ./TabAo.tsx (TambahLuarRute, BatalkanLuarRute), ./TabLaporan.tsx (KonfirmasiLuarRute).
 * Dependensi: components/order/PemilihPelanggan (GET /api/customers/search), POST/GET /api/form-kontrol/luar-rute(+/konfirmasi, /batal),
 *   lib/form-kontrol/constants (kodeJksUntuk, paritasMinggu), ../lapangan (bacaFk, kirimFk), ../shared (HARI, jamWita, useIzinFk), components/fiori/*.
 * Main Functions: TambahLuarRute, KonfirmasiLuarRute, BatalkanLuarRute, labelJadwal.
 * Side Effects: HTTP baca/tulis di atas. Server menegakkan semua aturan (pemilik, cabang, hari ini, principal, ganda); layar hanya mencegah
 *   kiriman yang pasti ditolak dan menampilkan kalimat penolakan server.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { MapPinPlus, RefreshCw, Undo2 } from "lucide-react";
import { Button, MessageStrip, Section, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { PemilihPelanggan, usePelanggan } from "@/components/order/PemilihPelanggan";
import { kodeJksUntuk, paritasMinggu } from "@/lib/form-kontrol/constants";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { HARI, jamWita, useIzinFk } from "../shared";
import { GagalKirim, bacaFk, kirimFk } from "../lapangan";

const MINGGU: [string, string][] = [["ganjil", "Minggu ganjil"], ["genap", "Minggu genap"], ["all", "Setiap minggu"]];
const labelMinggu = (m: string | null | undefined) => (m === "all" ? "setiap minggu" : m === "ganjil" ? "minggu ganjil" : m === "genap" ? "minggu genap" : "—");
export const labelJadwal = (hari: string | null | undefined, minggu: string | null | undefined) => `${hari || "hari belum diisi"} · ${labelMinggu(minggu)}`;

// ── Tambah (Rute hari ini) ─────────────────────────────────────────────────

type TambahProps = {
    salesCode: string; principle: string; tanggal: string;
    /** Kode toko yang SUDAH di rute hari ini (kode JKS pendek atau kode pelanggan lengkap). */
    ruteKode: string[];
    onDitambah: () => void;
    /** Alasan seluruh bagian terkunci (mis. tanpa izin kirim). */
    kunci?: string;
};

export function TambahLuarRute({ salesCode, principle, tanggal, ruteKode, onDitambah, kunci }: TambahProps) {
    const [buka, setBuka] = useState(false);
    const pel = usePelanggan("sales");
    const [sibuk, setSibuk] = useState(false);
    const [galat, setGalat] = useState("");
    const [sukses, setSukses] = useState("");
    const p = pel.state.jenis === "siap" ? pel.state.p : null;
    // Sama dengan server (cocokKodeRute): kode JKS "C-1" = pelanggan "C-1-CBA"; kode lengkap = dirinya.
    const sudah = p !== null && ruteKode.some((k) => kodeJksUntuk(p.customerNo).includes(k.trim().toUpperCase()));
    const alasan = kunci ?? (!p ? "Pilih pelanggan dulu" : sudah ? `${p.name} sudah ada di rute hari ini — buka dari daftar Toko di rute.` : undefined);

    async function tambah() {
        if (!p || alasan || sibuk) return;
        setSibuk(true);
        setGalat("");
        try {
            await kirimFk("/api/form-kontrol/luar-rute", { salesCode, principle, date: tanggal, customerNo: p.customerNo }, { ulangAman: true });
            setSukses(`${p.name} ditambahkan ke kunjungan hari ini.`);
            pel.lepas();
            setBuka(false);
            onDitambah();
        } catch (e) {
            setGalat(e instanceof Error ? e.message : "Gagal menambah kunjungan.");
        } finally { setSibuk(false); }
    }

    return (
        <Section title="Kunjungan luar rute" subtitle="toko di luar JKS hari ini">
            <div className="fi-sect-in">
                <p className="fi-small fi-muted">
                    Toko yang tidak ada di rute hari ini tetap boleh dikunjungi: cari nama atau kode pelanggan cabang Anda lalu tambahkan. Kunjungannya
                    sama dengan toko rute; di Laporan harian Anda memutuskan toko itu masuk JKS (hari + minggu) atau tidak.
                </p>
                {sukses && <MessageStrip tone="pos" onClose={() => setSukses("")}>{sukses}</MessageStrip>}
                {!buka ? (
                    <div className="fi-btnrow">
                        <Button icon={<MapPinPlus className="fi-icon" aria-hidden />} disabled={Boolean(kunci)} disabledReason={kunci}
                            onClick={() => { setBuka(true); setSukses(""); }}>Tambah toko luar rute</Button>
                        {kunci && <span className="fi-small fi-why">{kunci}</span>}
                    </div>
                ) : (
                    <>
                        <PemilihPelanggan state={pel.state} peran="sales" onPilih={(x) => { pel.pilih(x); setGalat(""); }} onLepas={pel.lepas} kunci={sibuk ? "Sedang menambah" : undefined} />
                        {galat && <MessageStrip tone="neg" title="Belum ditambahkan.">{galat}</MessageStrip>}
                        <div className="fi-btnrow">
                            <Button variant="primary" busy={sibuk} disabled={Boolean(alasan)} disabledReason={alasan} onClick={() => void tambah()}>Tambah ke kunjungan hari ini</Button>
                            <Button variant="tertiary" disabled={sibuk} onClick={() => { setBuka(false); pel.lepas(); setGalat(""); }}>Batal</Button>
                        </div>
                        {p && alasan && <p className="fi-small fi-why">{alasan}</p>}
                    </>
                )}
            </div>
        </Section>
    );
}

// ── Batalkan (Rute hari ini, owner 13 Okt) ─────────────────────────────────

export const PESAN_BATAL_TAK_PASTI = "Server tidak memberi jawaban yang pasti — hasil pembatalan belum pasti; muat ulang rute untuk memeriksa sebelum mengulang.";

/**
 * Tombol "Batalkan" kunjungan luar rute yang salah tambah + dialog. Pemanggil hanya menampilkannya untuk kunjungan luar rute hari ini milik
 * salesman yang belum punya check-in/status; server menegakkan semua syarat (milik sendiri, hari ini, belum ada catatan kunjungan apa pun) dan
 * kalimat penolakannya tampil di dialog. Jawaban tidak pasti → `onTakPasti` (pemanggil mengunci semua Batalkan sampai rute dimuat ulang).
 */
export function BatalkanLuarRute({ id, custName, custCode, kunci, onBatal, onTakPasti }: {
    id: string; custName: string; custCode: string; kunci?: string; onBatal: () => void; onTakPasti: () => void;
}) {
    const [buka, setBuka] = useState(false);
    return (
        <>
            <Button variant="tertiary" style={{ minHeight: 44 }} icon={<Undo2 className="fi-icon" aria-hidden />} aria-label={`Batalkan kunjungan ${custName}`}
                disabled={Boolean(kunci)} disabledReason={kunci} onClick={() => setBuka(true)}>Batalkan</Button>
            <ConfirmDialog open={buka} onClose={() => setBuka(false)} title={`Batalkan kunjungan ${custName}?`} tone="negative"
                description="Untuk toko yang salah ditambahkan: toko keluar dari kunjungan hari ini. Jejak penambahan dan pembatalan tetap tercatat; toko bisa ditambah lagi bila perlu."
                facts={[["Toko", `${custName} · ${custCode}`], ["Jenis", "Luar rute · hari ini"]]}
                confirmLabel="Batalkan kunjungan" cancelLabel="Kembali" confirmDisabled={kunci}
                onConfirm={async () => {
                    try {
                        await kirimFk("/api/form-kontrol/luar-rute/batal", { id });
                    } catch (e) {
                        if (e instanceof GagalKirim && e.tidakPasti) { onTakPasti(); throw new Error(PESAN_BATAL_TAK_PASTI); }
                        throw e;
                    }
                    setBuka(false);
                    onBatal();
                }} />
        </>
    );
}

// ── Konfirmasi (Laporan harian) ────────────────────────────────────────────

type JksTerkait = { salesCode: string; salesName: string; custCode: string; hariKunjungan: string | null; mingguPattern: string };
type BarisLuar = {
    id: string; tanggal: string; custCode: string; custName: string; principle: string;
    konfirmasi: "menunggu" | "jks" | "tidak" | "sudah_jks"; hari: string | null; mingguPattern: string | null;
    dikonfirmasiOlehNama: string | null; dikonfirmasiPada: string | null;
    status: string | null; noOrderReasonCode: string | null; checkinAt: string | null; checkoutAt: string | null;
    jksSaya: JksTerkait[]; jksLain: JksTerkait[];
};

const hasil = (s: string | null) => (s === "ordered" || s === "active" ? "order" : s === "not_order" ? "tidak order" : "belum ada status");

/**
 * Toko luar rute yang sudah DIKUNJUNGI (check-in) pada `tanggal` + yang masih menunggu dari hari sebelumnya. `onMenunggu` = jumlah yang belum
 * diputuskan (untuk dialog kirim laporan; tidak menahan kiriman).
 */
export function KonfirmasiLuarRute({ salesCode, tanggal, onMenunggu }: { salesCode: string; tanggal: string; onMenunggu: (n: number) => void }) {
    const tanpaIzin = useIzinFk("submit");
    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<BarisLuar[]>> =>
        bacaFk(`/api/form-kontrol/luar-rute?${new URLSearchParams({ salesCode, date: tanggal })}`, (d) => (Array.isArray(d.rows) ? d.rows : []) as BarisLuar[]),
    [salesCode, tanggal]));
    // Keputusan yang tersimpan sesi ini (menutup jeda sampai muat ulang selesai) dan pilihan hari/minggu per toko.
    const [putus, setPutus] = useState<Record<string, Pick<BarisLuar, "konfirmasi" | "hari" | "mingguPattern">>>({});
    const [pilih, setPilih] = useState<Record<string, { hari: string; minggu: string }>>({});
    const [sibuk, setSibuk] = useState("");
    const [galat, setGalat] = useState<Record<string, string>>({});

    const rows = (load.data ?? []).filter((r) => r.checkinAt).map((r) => ({ ...r, ...(putus[r.id] ?? {}) }));
    const menunggu = rows.filter((r) => r.konfirmasi === "menunggu").length;
    // Paritas minggu laporan = hitungan rute (acuan owner 12 Okt 2026 = genap, selang-seling), supaya pilihan ganjil/genap tidak ditebak.
    const mingguIni = paritasMinggu(tanggal);
    useEffect(() => { onMenunggu(menunggu); }, [menunggu, onMenunggu]);

    async function putuskan(r: BarisLuar, isi: { keputusan: "jks"; hari: string; mingguPattern: string } | { keputusan: "tidak" }) {
        setSibuk(r.id);
        setGalat((g) => ({ ...g, [r.id]: "" }));
        try {
            await kirimFk("/api/form-kontrol/luar-rute/konfirmasi", { id: r.id, salesCode, ...isi });
            setPutus((x) => ({ ...x, [r.id]: isi.keputusan === "jks"
                ? { konfirmasi: "jks", hari: isi.hari, mingguPattern: isi.mingguPattern } : { konfirmasi: "tidak", hari: null, mingguPattern: null } }));
            muatUlang();
        } catch (e) {
            setGalat((g) => ({ ...g, [r.id]: e instanceof Error ? e.message : "Keputusan belum tersimpan." }));
        } finally { setSibuk(""); }
    }

    if (load.status === "galat" && !load.data) {
        return (
            <Section title="Toko luar rute" subtitle="belum terbaca">
                <div className="fi-sect-in">
                    <MessageStrip tone="neg" title="Daftar toko luar rute gagal dimuat.">
                        {load.error} Laporan tetap bisa dikirim; keputusan JKS bisa dibuat nanti.{" "}
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                    </MessageStrip>
                </div>
            </Section>
        );
    }
    if (rows.length === 0) return null;
    return (
        <Section title="Toko luar rute" subtitle={menunggu ? `${menunggu} menunggu keputusan` : "semua sudah diputuskan"}>
            <div className="fi-sect-in">
                <p className="fi-small fi-muted">
                    Putuskan per toko: masukkan ke JKS Anda (hari + minggu) atau tidak. Boleh dibiarkan untuk nanti — tetap menunggu dan laporan tetap bisa dikirim.
                </p>
                {tanpaIzin && <p className="fi-small fi-why">{tanpaIzin}</p>}
                <ul aria-label="Toko luar rute" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
                    {rows.map((r) => {
                        const pl = pilih[r.id] ?? { hari: "", minggu: "" };
                        const kurang = tanpaIzin ?? (!pl.hari ? "Pilih hari" : !pl.minggu ? "Pilih minggu" : undefined);
                        const ubah = (k: "hari" | "minggu", v: string) => setPilih((x) => ({ ...x, [r.id]: { ...pl, [k]: v } }));
                        return (
                            <li key={r.id} className="fi-panel" style={{ minWidth: 0 }}>
                                <div className="grid gap-1" style={{ minWidth: 0 }}>
                                    <b style={{ overflowWrap: "anywhere" }}>{r.custName}</b>
                                    <span className="fi-small fi-muted">
                                        <span className="fi-mono">{r.custCode}</span>
                                        {r.tanggal !== tanggal ? ` · Kunjungan ${tanggalPendek(r.tanggal)}` : ""} · {hasil(r.status)} · {jamWita(r.checkinAt)}–{jamWita(r.checkoutAt)} WITA
                                    </span>
                                </div>
                                {r.jksLain.length > 0 && r.konfirmasi === "menunggu" && (
                                    <MessageStrip tone="warn" title="Sudah di JKS salesman lain:">
                                        {r.jksLain.map((j) => `${j.salesCode} ${j.salesName} (${labelJadwal(j.hariKunjungan, j.mingguPattern)})`).join("; ")}. Bila dimasukkan, toko ini
                                        juga ada di JKS Anda — pastikan dengan SPV.
                                    </MessageStrip>
                                )}
                                {r.konfirmasi === "jks" && <div><StatusBadge tone="pos">Masuk JKS: {labelJadwal(r.hari, r.mingguPattern)}</StatusBadge></div>}
                                {r.konfirmasi === "tidak" && <div><StatusBadge tone="neu">Tidak dimasukkan JKS</StatusBadge></div>}
                                {r.konfirmasi === "sudah_jks" && (
                                    <div><StatusBadge tone="info">Sudah di JKS Anda{r.jksSaya[0] ? `: ${labelJadwal(r.jksSaya[0].hariKunjungan, r.jksSaya[0].mingguPattern)}` : ""}</StatusBadge></div>
                                )}
                                {r.konfirmasi === "menunggu" && (
                                    <>
                                        <div className="fi-formgrid">
                                            <FormField label="Hari">
                                                {(a) => (
                                                    <select {...a} className="fi-input" value={pl.hari} disabled={sibuk === r.id} onChange={(e) => ubah("hari", e.target.value)}>
                                                        <option value="">Pilih hari</option>
                                                        {HARI.map((h) => <option key={h} value={h}>{h}</option>)}
                                                    </select>
                                                )}
                                            </FormField>
                                            <FormField label="Minggu">
                                                {(a) => (
                                                    <select {...a} className="fi-input" value={pl.minggu} disabled={sibuk === r.id} onChange={(e) => ubah("minggu", e.target.value)}>
                                                        <option value="">Pilih minggu</option>
                                                        {MINGGU.map(([v, l]) => <option key={v} value={v}>{l}{v === mingguIni ? " (minggu ini)" : ""}</option>)}
                                                    </select>
                                                )}
                                            </FormField>
                                        </div>
                                        {galat[r.id] && <MessageStrip tone="neg" title="Keputusan belum tersimpan.">{galat[r.id]}</MessageStrip>}
                                        <div className="fi-btnrow">
                                            <Button variant="primary" busy={sibuk === r.id} disabled={Boolean(kurang) || Boolean(sibuk)} disabledReason={kurang}
                                                onClick={() => void putuskan(r, { keputusan: "jks", hari: pl.hari, mingguPattern: pl.minggu })}>Masukkan ke JKS</Button>
                                            <Button variant="secondary" disabled={Boolean(tanpaIzin) || Boolean(sibuk)} disabledReason={tanpaIzin}
                                                onClick={() => void putuskan(r, { keputusan: "tidak" })}>Jangan masukkan JKS</Button>
                                        </div>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
        </Section>
    );
}
