/*
 * Tujuan: "Laporan harian" salesman (Fiori S5, it05): lima angka otomatis dari Form AO (WITA) + tindak lanjut, dikirim ke SPV lewat
 *   dialog; status dibaca SPV. Tanggal = Hari ini atau Kemarin (laporan yang terlewat), tanpa pemilih tanggal bebas. Galat muat ≠ nol.
 * Caller: form-kontrol/page.tsx (shell tab, default export `({ scope })`).
 * Dependensi: GET/POST /api/form-kontrol/reports; ../shared (Scope, jamWita, useIzinFk); ../lapangan (bacaFk, kirimFk, useHariBeku,
 *   kemarinDari); components/fiori/*; lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: TabLaporan, keLaporan.
 * Side Effects: HTTP GET laporan hari ini + kemarin; POST laporan {salesCode, date, tindakLanjut} (payload sama dengan kode lama) lalu
 *   muat ulang.
 *
 * Server menghitung ulang kelima angka saat laporan dikirim; sebelum dikirim GET mengembalikan angka LIVE (baris sintetis,
 * submittedAt null). Laporan yang sudah terkirim tidak dikirim ulang dari layar ini (sama dengan tombol "Sudah Disubmit" lama).
 * "Hari ini" dibekukan saat layar dibuka: lewat 00.00 tindak lanjut yang sedang diketik tidak hilang (strip menawarkan hari baru).
 */
"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { CalendarDays, Send } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { type Scope, jamWita, useIzinFk } from "../shared";
import { bacaFk, kemarinDari, kirimFk, useHariBeku } from "../lapangan";

type Laporan = {
    totalJks: number; order: number; aktif: number; notOrder: number; notVisited: number;
    tindakLanjut: string; submittedAt: string | null; spvAck: boolean; spvAckAt: string | null;
};
/** `kemarin` = "galat" bila laporan kemarin tidak terbaca (laporan hari ini tetap bisa dikirim). */
type Data = { hari: Laporan | null; kemarin: Laporan | null | "galat" };
type Pilih = "hari" | "kemarin";

const angka = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

function keLaporan(d: Record<string, unknown>): Laporan | null {
    const row = (Array.isArray(d.rows) ? d.rows[0] : null) as Record<string, unknown> | null;
    if (!row) return null;
    return {
        totalJks: angka(row.totalTokoJks), order: angka(row.totalOrder), aktif: angka(row.totalActive),
        notOrder: angka(row.totalNotOrder), notVisited: angka(row.totalNotVisited),
        tindakLanjut: (row.tindakLanjut as string) ?? "",
        submittedAt: (row.submittedAt as string) ?? null,
        spvAck: Boolean(row.spvAck), spvAckAt: (row.spvAckAt as string) ?? null,
    };
}

export default function TabLaporan({ scope }: { scope: Scope }) {
    const judulId = useId();
    const salesCode = scope.salesCode ?? "";
    const beku = useHariBeku();
    const kemarin = kemarinDari(beku.hari);
    const [pilih, setPilih] = useState<Pilih>("hari");
    const tanggal = pilih === "hari" ? beku.hari : kemarin;
    const [dialog, setDialog] = useState(false);
    // Tanggal yang terkirim sesi ini: menutup jeda antara POST berhasil dan muat ulang (tombol tidak boleh aktif lagi).
    const [terkirimSesi, setTerkirimSesi] = useState<Record<string, boolean>>({});
    // Ketikan per tanggal; tetap ada saat berpindah Hari ini/Kemarin atau saat hari berganti.
    const [ketikan, setKetikan] = useState<Record<string, string>>({});
    const tanpaIzin = useIzinFk("submit");

    const loader = useCallback(async (): Promise<Load<Data>> => {
        if (!salesCode) return { status: "siap", data: { hari: null, kemarin: null } };
        const url = (d: string) => `/api/form-kontrol/reports?salesCode=${encodeURIComponent(salesCode)}&date=${d}`;
        const [h, k] = await Promise.all([bacaFk(url(beku.hari), keLaporan), bacaFk(url(kemarin), keLaporan)]);
        if (h.status !== "siap") return { status: "galat", error: h.error };
        return { status: "siap", data: { hari: h.data ?? null, kemarin: k.status === "siap" ? k.data ?? null : "galat" } };
    }, [salesCode, beku.hari, kemarin]);
    const [load, muatUlang] = useLoad(loader);
    const data = load.data;
    const kemarinGalat = data?.kemarin === "galat";
    const lapKemarin = data && data.kemarin !== "galat" ? data.kemarin : null;
    const lap = pilih === "hari" ? data?.hari ?? null : lapKemarin;
    const terkirim = Boolean(lap?.submittedAt) || Boolean(terkirimSesi[tanggal]);

    const teks = ketikan[tanggal] ?? lap?.tindakLanjut ?? "";
    const draf = Object.entries(ketikan).some(([t, v]) => !terkirimSesi[t] && v !== ((t === beku.hari ? data?.hari : lapKemarin)?.tindakLanjut ?? ""));
    useUnsavedGuard(draf);
    const kemarinTertunda = Boolean(lapKemarin && !lapKemarin.submittedAt && !terkirimSesi[kemarin] && lapKemarin.totalJks > 0);

    const terkunci = !salesCode ? "Profil salesman belum terdaftar" : tanpaIzin ? tanpaIzin
        : load.status !== "siap" ? (load.status === "galat" ? "Laporan gagal dimuat; muat ulang dulu" : "Menunggu laporan dimuat")
            : !lap ? "Laporan tanggal ini tidak terbaca"
                : terkirim ? "Laporan tanggal ini sudah terkirim"
                    : !teks.trim() ? "Isi tindak lanjut dulu" : undefined;

    async function kirim() {
        const tgl = tanggal;
        await kirimFk("/api/form-kontrol/reports", { salesCode, date: tgl, tindakLanjut: teks }, { ulangAman: true });
        setDialog(false);
        setTerkirimSesi((s) => ({ ...s, [tgl]: true }));
        setKetikan((k) => { const n = { ...k }; delete n[tgl]; return n; });
        muatUlang();
    }

    let isi: ReactNode;
    if (!salesCode) {
        isi = <EmptyState title="Akun belum tertaut ke profil salesman"
            message="Laporan harian dikirim oleh salesman. SPV membaca dan menandai laporan di Dashboard SPV. Hubungi admin bila akun ini seharusnya salesman." />;
    } else if (load.status === "galat" && !data) {
        isi = <ErrorState title="Laporan gagal dimuat" message={`${load.error} Angka tidak ditampilkan agar tidak terbaca sebagai nol.`} onRetry={muatUlang} />;
    } else if (!data) {
        isi = <Skeleton rows={4} label="Memuat laporan" />;
    } else if (!lap) {
        isi = <ErrorState title="Laporan gagal dimuat"
            message={pilih === "kemarin" && kemarinGalat ? "Laporan kemarin tidak terbaca. Angka tidak ditampilkan agar tidak terbaca sebagai nol." : "Server tidak mengirim ringkasan."}
            onRetry={muatUlang} />;
    } else {
        isi = (
            <div className={load.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={load.status === "memuat" || undefined}>
                {load.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {load.error} Yang tampil adalah hasil sebelumnya.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                    </MessageStrip>
                )}
                {terkirim && (
                    <MessageStrip tone="pos" title={`Laporan harian terkirim ke SPV${lap.submittedAt ? ` ${jamWita(lap.submittedAt)}` : ""}.`}>
                        {lap.spvAck ? `Sudah dibaca SPV${lap.spvAckAt ? ` ${jamWita(lap.spvAckAt)}` : ""}.` : "Menunggu dibaca SPV."}
                    </MessageStrip>
                )}
                <div className="fi-kcards">
                    {([["Total toko JKS", lap.totalJks], ["Order", lap.order], ["Aktif", lap.aktif], ["Tidak order", lap.notOrder], ["Tidak dikunjungi", lap.notVisited]] as const).map(([l, v]) => (
                        <div key={l} className="fi-kc"><span>{l}</span><b className="fi-tnum">{v}</b></div>
                    ))}
                </div>
                <p className="fi-small fi-muted">{terkirim ? "Angka saat laporan dikirim." : "Angka terisi otomatis dan langsung dari Form AO; dihitung ulang server saat dikirim."}</p>
                <Section title="Tindak lanjut" subtitle="wajib">
                    <div className="fi-sect-in">
                        <FormField label="Tindak lanjut untuk SPV" required help="Toko yang belum order, rencana kunjungan ulang, eskalasi ke SPV, dll.">
                            {(a) => <textarea {...a} className="fi-input" rows={5} readOnly={terkirim} value={teks}
                                onChange={(e) => { const tgl = tanggal; const v = e.target.value; setKetikan((k) => ({ ...k, [tgl]: v })); }} />}
                        </FormField>
                        {draf && <p className="fi-draft" role="status">Tindak lanjut belum dikirim.</p>}
                        <div className="fi-btnrow">
                            <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(terkunci)} disabledReason={terkunci} onClick={() => setDialog(true)}>
                                {terkirim ? "Sudah terkirim" : "Kirim laporan ke SPV…"}
                            </Button>
                            {terkunci && !terkirim && <span className="fi-small fi-why">{terkunci}</span>}
                        </div>
                    </div>
                </Section>
            </div>
        );
    }

    return (
        <section aria-labelledby={judulId} className="grid gap-4">
            <div className="grid gap-1">
                <h2 id={judulId} className="fi-title-2">Laporan harian</h2>
                <p className="fi-small fi-muted flex flex-wrap items-center gap-x-2">
                    <CalendarDays className="fi-icon" aria-hidden /><span>{tanggalPanjang(tanggal)} · WITA</span>
                    {salesCode && <span>· <span className="fi-mono">{salesCode}</span>{scope.salesName ? ` ${scope.salesName}` : ""}</span>}
                </p>
            </div>
            {salesCode && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Tanggal laporan">
                    {([["hari", "Hari ini"], ["kemarin", "Kemarin"]] as const).map(([k, label]) => (
                        <Button key={k} variant={pilih === k ? "primary" : "secondary"} aria-pressed={pilih === k} onClick={() => setPilih(k)}>{label}</Button>
                    ))}
                </div>
            )}
            {beku.berganti && (
                <MessageStrip tone="warn" title="Tanggal sudah berganti.">
                    Laporan dan isian yang tampil masih untuk {tanggalPanjang(beku.hari)}; tidak ada yang dibuang.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setPilih("hari"); beku.pakaiHariBaru(); }}>Muat {tanggalPanjang(beku.hariBaru)}</button>
                </MessageStrip>
            )}
            {pilih === "hari" && kemarinTertunda && (
                <MessageStrip tone="warn" title="Laporan kemarin belum terkirim.">
                    {tanggalPanjang(kemarin)} belum dilaporkan ke SPV.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => setPilih("kemarin")}>Buka laporan kemarin</button>
                </MessageStrip>
            )}
            {isi}
            <VariantNote bl="BL-28">Tanggal laporan = hari ini atau kemarin dalam WITA menurut jam ponsel. Usulan: server yang menetapkan tanggal laporan.</VariantNote>
            {lap && (
                <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Kirim laporan harian ${pilih === "hari" ? "hari ini" : "kemarin"} ke SPV?`}
                    description="Laporan tanggal ini dikirim sekali; kelima angka dihitung ulang server dari status kunjungan terakhir."
                    facts={[
                        ["Tanggal", `${tanggalPanjang(tanggal)} · WITA`],
                        ["Total toko JKS", String(lap.totalJks)],
                        ["Order · aktif", `${lap.order} · ${lap.aktif}`],
                        ["Tidak order", String(lap.notOrder)],
                        ["Tidak dikunjungi", String(lap.notVisited)],
                        ["Tindak lanjut", teks.trim().length > 80 ? `${teks.trim().slice(0, 80)}…` : teks.trim()],
                    ]}
                    confirmLabel="Kirim laporan" onConfirm={kirim} />
            )}
        </section>
    );
}
