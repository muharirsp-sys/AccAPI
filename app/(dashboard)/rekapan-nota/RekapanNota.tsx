/*
 * Tujuan: Worklist Wave harian Rekapan Nota (Fiori S2): kartu ringkas pool/exception/outlet tanpa area, daftar wave,
 *   dialog Unggah file export dan Wave baru (pengganti panel atas + prompt browser).
 * Caller: app/(dashboard)/rekapan-nota/page.tsx.
 * Dependensi: GET /api/rekapan-nota/wave, GET /api/rekapan-nota/pool, POST /api/rekapan-nota/upload, POST /api/rekapan-nota/wave;
 *   components/fiori/{core,interactive}, lib/rekapan-nota/ui, lib/beranda (witaToday).
 * Main Functions: RekapanNota.
 * Side Effects: HTTP baca/tulis di atas. Tidak ada localStorage. Logic BL-54/55 tidak ditulis (varian berlabel).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, MapPin, Plus, Truck, Upload } from "lucide-react";
import {
    Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { witaToday } from "@/lib/beranda";
import { WAVE_STATUS, ambil, tanggalPanjang, tanggalPendek, urutanBerikutnya, type WaveStatusKode } from "@/lib/rekapan-nota/ui";

type Wave = { id: number; tanggal: string; urutan: number; nama: string; tipe: string; status: WaveStatusKode; jumlah_nota: number; exception_open: number };
type PoolRingkas = { jumlahNota: number; tanpaArea: number; disembunyikan: number; kanvasNihilOleh: string | null };
type UploadResult = { tanggal: string; jumlahNota: number; jumlahBaris: number; principal: string[]; sudahAda?: boolean; pesan?: string };

const TIPE_LABEL: Record<string, string> = { reguler: "Reguler", kanvas: "Kanvas" };
const fmtMB = (bytes: number) => `${(bytes / 1_048_576).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;

export default function RekapanNota({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehKelola = keys.has("rekapan_nota.manage");
    const [tanggal, setTanggal] = useState(witaToday);
    const [wave, muatWave] = useLoad(useCallback(() => ambil<Wave[]>(`/api/rekapan-nota/wave?tanggal=${tanggal}`, (j) => (j as { wave: Wave[] }).wave), [tanggal]));
    const [pool, muatPool] = useLoad(useCallback(() => ambil<PoolRingkas>(`/api/rekapan-nota/pool?tanggal=${tanggal}&tipe=reguler`), [tanggal]));
    const muat = () => { muatWave(); muatPool(); };
    const [dialog, setDialog] = useState<"unggah" | "waveBaru" | null>(null);
    // Draf unggah: berkas dipilih tapi belum/gagal diunggah tetap tersimpan supaya bisa dilanjutkan.
    const [berkas, setBerkas] = useState<File | null>(null);
    const [tanggalBerkas, setTanggalBerkas] = useState(tanggal);
    const [galatUnggah, setGalatUnggah] = useState<{ pesan: string; tanggalTersedia?: string[] } | null>(null);
    const [hasilUnggah, setHasilUnggah] = useState<UploadResult | null>(null);
    const [tipeBaru, setTipeBaru] = useState<"reguler" | "kanvas">("reguler");
    const [namaBaru, setNamaBaru] = useState("");


    async function unggah() {
        if (!berkas) return;
        setGalatUnggah(null); setHasilUnggah(null);
        const form = new FormData();
        form.append("file", berkas);
        form.append("tanggal", tanggalBerkas);
        const res = await fetch("/api/rekapan-nota/upload", { method: "POST", body: form });
        const payload = (await res.json().catch(() => ({}))) as UploadResult & { error?: string; tanggalTersedia?: string[] };
        setDialog(null);
        if (!res.ok) {
            // Galat tampil di halaman (daftar wave tetap terlihat); berkas tetap tersimpan sebagai draf.
            setGalatUnggah({ pesan: payload.error ?? `Unggahan ditolak (HTTP ${res.status}).`, tanggalTersedia: payload.tanggalTersedia });
            return;
        }
        setHasilUnggah(payload);
        setBerkas(null);
        if (payload.tanggal && payload.tanggal !== tanggal) setTanggal(payload.tanggal); else muat();
    }

    async function buatWave() {
        const urutan = urutanBerikutnya(wave.data ?? [], tipeBaru);
        const res = await fetch("/api/rekapan-nota/wave", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ tanggal, urutan, nama: namaBaru.trim(), tipe: tipeBaru }),
        });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Gagal membuat wave.");
        setDialog(null); setNamaBaru("");
        muat();
    }

    const daftar = wave.data ?? [];
    const exceptionTerbuka = daftar.reduce((a, w) => a + w.exception_open, 0);
    const waveException = daftar.find((w) => w.exception_open > 0);
    const kosongTotal = wave.status === "siap" && pool.status === "siap" && daftar.length === 0 && (pool.data?.jumlahNota ?? 0) === 0 && (pool.data?.disembunyikan ?? 0) === 0;
    const urutanBaru = urutanBerikutnya(daftar, tipeBaru);
    const setelah = daftar.filter((w) => w.tipe === tipeBaru).at(-1);

    const kolom: Column<Wave>[] = [
        { key: "urutan", header: "#", align: "end", cell: (w) => <span className="fi-tnum">{w.urutan}</span> },
        { key: "nama", header: "Wave", cell: (w) => <><b>{w.nama}</b><span className="fi-sub">{TIPE_LABEL[w.tipe] ?? w.tipe} · Wave #{w.id}</span></> },
        { key: "status", header: "Status", cell: (w) => <StatusBadge tone={WAVE_STATUS[w.status]?.tone ?? "neu"}>{WAVE_STATUS[w.status]?.label ?? w.status}</StatusBadge> },
        { key: "nota", header: "Nota", align: "end", cell: (w) => <span className="fi-tnum">{w.jumlah_nota}</span> },
        { key: "exception", header: "Exception", cell: (w) => w.exception_open ? <span className="fi-why">{w.exception_open} terbuka</span> : <span className="fi-small fi-subtle">—</span> },
        { key: "buka", header: "", cell: (w) => <Link className="fi-btn fi-btn--tertiary" href={`/rekapan-nota/wave/${w.id}`}>Buka<ChevronRight className="fi-icon" aria-hidden /></Link> },
    ];

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Gudang</span></li><li><span aria-current="page">Rekapan Nota</span></li></ol></nav>
                <h1>Wave {tanggalPanjang(tanggal)}</h1>
                <p>Susun nota hari ini ke wave picking, lalu cetak lembar rekapan dan TTF. Satu nota hanya bisa berada di satu wave.</p>
                <div className="fi-page-bar">
                    <FormField label="Tanggal">{(a11y) => <input {...a11y} className="fi-input" type="date" value={tanggal} onChange={(e) => { if (e.target.value) setTanggal(e.target.value); }} />}</FormField>
                    <span className="fi-spacer" />
                    <Link href="/rekapan-nota/kanvas" className="fi-btn fi-btn--secondary"><Truck className="fi-icon" aria-hidden />Nota kanvas</Link>
                    <Link href="/rekapan-nota/area" className="fi-btn fi-btn--secondary"><MapPin className="fi-icon" aria-hidden />Mapping area</Link>
                    {bolehKelola && <Button icon={<Upload className="fi-icon" aria-hidden />} onClick={() => { setTanggalBerkas(tanggal); setDialog("unggah"); }}>Unggah file export…</Button>}
                    {bolehKelola && <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setDialog("waveBaru")}>Wave baru…</Button>}
                </div>
            </header>

            {galatUnggah && (
                <MessageStrip tone="neg" title={galatUnggah.pesan} onClose={() => setGalatUnggah(null)}>
                    {galatUnggah.tanggalTersedia?.length ? <>Tanggal di file: {galatUnggah.tanggalTersedia.map(tanggalPendek).join(", ")}. Pilih tanggal yang sesuai di dialog Unggah, atau ekspor ulang dari Accurate.</> : null}
                </MessageStrip>
            )}
            {hasilUnggah && (
                <>
                    <MessageStrip tone="pos" title={hasilUnggah.sudahAda ? "File ini sudah pernah diunggah." : `${hasilUnggah.jumlahNota} nota / ${hasilUnggah.jumlahBaris} baris masuk pool ${tanggalPendek(hasilUnggah.tanggal)}.`} onClose={() => setHasilUnggah(null)}>
                        {hasilUnggah.sudahAda ? hasilUnggah.pesan : <>Principal: {hasilUnggah.principal.join(", ") || "–"}.</>}
                    </MessageStrip>
                    {!hasilUnggah.sudahAda && (
                        <VariantNote bl="BL-54">
                            Nota yang sudah ada di pool dan ikut di file ini ditulis ulang, sehingga qty ambil dan TTF-nya bisa terhitung dua kali.
                            Usulan: laporkan nota baru, sudah ada, dan berubah; nota yang berubah setelah masuk wave menjadi exception.
                        </VariantNote>
                    )}
                </>
            )}
            {berkas && !hasilUnggah && (
                <MessageStrip tone="info" title={`${berkas.name} dipilih untuk ${tanggalPendek(tanggalBerkas)}, belum diunggah.`}>
                    <Button variant="tertiary" onClick={() => setDialog("unggah")}>Lanjutkan unggah…</Button>
                </MessageStrip>
            )}

            {wave.status === "memuat" && !wave.data ? (
                <>
                    <div className="fi-kcards">{[0, 1, 2, 3].map((i) => <div key={i} className="fi-kc"><Skeleton rows={2} label="Memuat ringkasan" /></div>)}</div>
                    <div className="fi-panel"><Skeleton rows={4} label="Memuat daftar wave" /></div>
                </>
            ) : wave.status === "galat" && !wave.data ? (
                <div className="fi-panel"><ErrorState message={`Daftar wave tidak bisa dimuat (${wave.error}).`} onRetry={muat} /></div>
            ) : kosongTotal ? (
                <>
                    <div className="fi-panel">
                        <EmptyState title={`Belum ada nota ${tanggalPendek(tanggal)} di pool`}
                            message="Unggah file export Rincian Faktur Penjualan. Satu file bisa memuat beberapa hari; hanya baris tanggal ini yang masuk pool."
                            action={bolehKelola ? <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} onClick={() => { setTanggalBerkas(tanggal); setDialog("unggah"); }}>Unggah file export…</Button> : undefined} />
                    </div>
                    <VariantNote bl="BL-55">Tanggal bawaan layar ini sudah mengikuti jam Makassar; tanggal bawaan di sisi server (bila parameter tanggal kosong) masih memakai jam UTC.</VariantNote>
                </>
            ) : (
                <>
                    <div className="fi-kcards" aria-busy={wave.status === "memuat" || pool.status === "memuat" || undefined}>
                        <div className="fi-kc"><span>Pool reguler</span><b>{pool.status === "galat" ? "–" : pool.data?.jumlahNota ?? "…"}</b><small>{pool.status === "galat" ? "tidak bisa dimuat" : "nota belum masuk wave"}</small></div>
                        <Link href="/rekapan-nota/kanvas" className="fi-kc"><span>Pool kanvas</span><b>{pool.status === "galat" ? "–" : pool.data?.disembunyikan ?? "…"}</b><small>{pool.data?.kanvasNihilOleh ? `dinyatakan nihil oleh ${pool.data.kanvasNihilOleh}` : "dicetak setelah kanvaser pulang"}</small></Link>
                        {waveException
                            ? <Link href={`/rekapan-nota/wave/${waveException.id}`} className="fi-kc" data-tone="neg"><span>Exception terbuka</span><b>{exceptionTerbuka}</b><small>di Wave {waveException.nama}{daftar.filter((w) => w.exception_open > 0).length > 1 ? " dan lainnya" : ""}</small></Link>
                            : <div className="fi-kc"><span>Exception terbuka</span><b>{exceptionTerbuka}</b><small>tidak ada yang menahan konfirmasi</small></div>}
                        <Link href="/rekapan-nota/area" className="fi-kc" data-tone={pool.data?.tanpaArea ? "warn" : undefined}><span>Outlet tanpa area</span><b>{pool.status === "galat" ? "–" : pool.data?.tanpaArea ?? "…"}</b><small>di pool tanggal ini, belum dipetakan</small></Link>
                    </div>
                    <ResponsiveTable<Wave>
                        title="Wave" count={daftar.length} columns={kolom} rows={daftar} rowKey={(w) => String(w.id)}
                        status={wave.status} error={wave.error} onRetry={muat}
                        empty={{ title: "Belum ada wave untuk tanggal ini", message: "Pool sudah berisi nota. Buat wave, lalu pilih nota dari pool.", action: bolehKelola ? <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setDialog("waveBaru")}>Wave baru…</Button> : undefined }}
                        mobileItem={(w) => (
                            <ListItem href={`/rekapan-nota/wave/${w.id}`} doc={`#${w.id}`} title={`${w.urutan}. Wave ${w.nama} · ${TIPE_LABEL[w.tipe] ?? w.tipe} · ${w.jumlah_nota} nota`}
                                meta={w.exception_open ? <span className="fi-why">{w.exception_open} exception terbuka</span> : undefined}
                                badge={<StatusBadge tone={WAVE_STATUS[w.status]?.tone ?? "neu"}>{WAVE_STATUS[w.status]?.label ?? w.status}</StatusBadge>} />
                        )} />
                </>
            )}

            <ConfirmDialog open={dialog === "waveBaru"} onClose={() => setDialog(null)} title={`Wave baru ${tanggalPendek(tanggal)}`} tag="Buat" confirmLabel="Buat wave"
                confirmDisabled={namaBaru.trim() ? undefined : "Isi nama wave dulu"} onConfirm={buatWave}
                facts={[["Urutan", setelah ? `${urutanBaru}, setelah ${setelah.nama}` : String(urutanBaru)], ["Isi", tipeBaru === "kanvas" ? "Hanya nota bertanda kanvas" : "Nota reguler dari pool; nota bertanda kanvas hanya masuk wave kanvas"]]}>
                <div className="fi-segs" role="group" aria-label="Tipe wave">
                    {(["reguler", "kanvas"] as const).map((t) => <button key={t} type="button" aria-pressed={tipeBaru === t} onClick={() => setTipeBaru(t)}>{TIPE_LABEL[t]}</button>)}
                </div>
                <FormField label="Nama" required help="Misalnya Pagi, Siang, Sore.">{(a11y) => <input {...a11y} className="fi-input" value={namaBaru} onChange={(e) => setNamaBaru(e.target.value)} autoFocus />}</FormField>
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "unggah"} onClose={() => setDialog(null)} title="Unggah file export ke pool" tag="Unggah" confirmLabel="Unggah ke pool"
                confirmDisabled={berkas ? undefined : "Pilih berkas dulu"} onConfirm={unggah}
                facts={[["Yang masuk", "Hanya baris Penjualan Bruto bertanggal ini; retur dibuang"], ["File yang sama", "Tidak diunggah dua kali; pool tidak digandakan"]]}>
                <FormField label="Tanggal data" required help="Satu file bisa memuat beberapa hari; hanya baris tanggal ini yang masuk pool.">
                    {(a11y) => <input {...a11y} className="fi-input" type="date" value={tanggalBerkas} onChange={(e) => { if (e.target.value) setTanggalBerkas(e.target.value); }} />}
                </FormField>
                <FormField label="File export (.xlsx)" required>
                    {(a11y) => <input {...a11y} className="fi-input" type="file" accept=".xlsx" onChange={(e) => setBerkas(e.target.files?.[0] ?? null)} />}
                </FormField>
                {berkas && <div className="fi-dropzone"><b>{berkas.name}</b><span>Export Rincian Faktur Penjualan dari Accurate · {fmtMB(berkas.size)}</span></div>}
            </ConfirmDialog>
        </div>
    );
}
