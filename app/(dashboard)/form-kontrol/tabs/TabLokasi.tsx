/*
 * Tujuan: Tab "Validasi Lokasi" (owner 14 Nov 2026; Admin/IT = form_kontrol.manage): radius check-in/check-out titik toko (fix 20 m, perlu validasi
 *   100 m). Empat bagian: ringkasan status titik; unggah berkas audit selisih titik Web-LL (sheet SANGAT BERBEDA / BERBEDA / ALAMAT KELIRU ->
 *   perlu validasi; LATITUDE/LONGITUDE BENAR terisi -> titik baru fix); pengajuan ke IT (check-in/check-out di luar radius: setujui — opsional
 *   pindah titik toko ke titik salesman — atau tolak beralasan); antrean perbaikan lokasi (toko tanpa titik fix + titik check-in salesman:
 *   tetapkan titik tengah atau satu titik check-in).
 * Caller: form-kontrol/FormKontrol.tsx (tab "lokasi").
 * Dependensi: GET/POST /api/form-kontrol/lokasi, ../shared (ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive}, lib/form-kontrol/{radius,peta},
 *   lib/tampil (KOSONG, waktuWita).
 * Main Functions: TabLokasi (default). Side Effects: HTTP; tautan Google Maps di tab baru.
 */
"use client";

import { useCallback, useState } from "react";
import { Check, MapPin, RefreshCw, Upload, X } from "lucide-react";
import { Button, EmptyState, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { LABEL_STATUS_TITIK, type StatusTitik } from "@/lib/form-kontrol/radius";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { ambilFk, tulisFk, useIzinFk, type Scope } from "../shared";

const API = "/api/form-kontrol/lokasi";
type Ringkasan = { tokoJks: number; fix: number; validasi: number; tanpaTitik: number; pengajuanMenunggu: number };
type StatusAjuan = "menunggu" | "disetujui" | "ditolak";
type Ajuan = {
    id: string; salesCode: string; custCode: string; custName: string | null; principle: string; tanggal: string; tahap: "checkin" | "checkout";
    lat: number; lng: number; akurasi: number; titikLat: number; titikLng: number; statusTitik: StatusTitik; jarakM: number; radiusM: number;
    alasan: string; status: StatusAjuan; diajukanPada: string; catatanPutusan: string | null; titikDipindah: boolean;
};
type Antrean = {
    custCode: string; custName: string; alamat: string | null; kota: string | null;
    titikSekarang: { lat: number; lng: number; status: StatusTitik } | null;
    tengah: { lat: number; lng: number; sebaranM: number; jumlah: number; salesman: number };
    checkin: { salesCode: string; tanggal: string; lat: number; lng: number; akurasi: number | null }[];
};
const peta = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
const angka = (n: number) => new Intl.NumberFormat("id-ID").format(Math.round(n));
const TAHAP = { checkin: "Check-in", checkout: "Check-out" } as const;
const TONE_AJUAN = { menunggu: "warn", disetujui: "pos", ditolak: "neg" } as const;

function Peta({ lat, lng, label, nama }: { lat: number; lng: number; label: string; nama: string }) {
    return <a className="fi-btn fi-btn--tertiary" href={peta(lat, lng)} target="_blank" rel="noopener noreferrer">
        <MapPin className="fi-icon" aria-hidden />{label}<span className="sr-only"> {nama} di Google Maps</span></a>;
}

export default function TabLokasi({ scope }: { scope: Scope }) {
    const izin = useIzinFk("manage");
    // Memutus pengajuan = Admin (IT) saja (server menolak 403 HANYA_IT); Manager / Admin Sales melihat dan mengelola titik.
    const kunciPutus = izin ?? (scope.role === "admin" ? undefined : "Hanya Admin (IT) yang memutus pengajuan lokasi.");
    const [statusAjuan, setStatusAjuan] = useState<StatusAjuan>("menunggu");
    const [ringkas, muatRingkas] = useLoad(useCallback(() => ambilFk(`${API}?bagian=ringkasan`, (j) => j.ringkasan as Ringkasan, "Ringkasan lokasi belum berhasil dimuat."), []));
    const [ajuan, muatAjuan] = useLoad(useCallback(() => ambilFk(`${API}?bagian=pengajuan&status=${statusAjuan}`, (j) => (j.rows ?? []) as Ajuan[],
        "Pengajuan lokasi belum berhasil dimuat."), [statusAjuan]));
    const [antrean, muatAntrean] = useLoad(useCallback(() => ambilFk(`${API}?bagian=antrean`, (j) => (j.rows ?? []) as Antrean[],
        "Antrean perbaikan lokasi belum berhasil dimuat."), []));
    const muatSemua = () => { muatRingkas(); muatAjuan(); muatAntrean(); };
    const [hasil, setHasil] = useState("");
    const [unggah, setUnggah] = useState(false);
    const [berkas, setBerkas] = useState<File | null>(null);
    const [setuju, setSetuju] = useState<Ajuan | null>(null);
    const [pindah, setPindah] = useState(false);
    const [tolak, setTolak] = useState<Ajuan | null>(null);
    const [tetapkan, setTetapkan] = useState<{ toko: Antrean; lat: number; lng: number; asal: string } | null>(null);

    const r = ringkas.data;
    const kolomAjuan: Column<Ajuan>[] = [
        { key: "t", header: "Toko · salesman", cell: (a) => <><b>{a.custName ?? a.custCode}</b><span className="fi-codes">{a.custCode} · {a.salesCode} · {a.principle}</span></> },
        { key: "w", header: "Kunjungan", cell: (a) => <span className="grid">{TAHAP[a.tahap]} {tanggalPanjang(a.tanggal)}<span className="fi-small fi-muted">diajukan {waktuWita(a.diajukanPada)}</span></span> },
        { key: "j", header: "Jarak dari titik toko", cell: (a) => <span className="grid"><span className="fi-tnum">{angka(a.jarakM)} m (batas {a.radiusM} m)</span>
            <span className="fi-small fi-muted">{LABEL_STATUS_TITIK[a.statusTitik]} · akurasi GPS ±{angka(a.akurasi)} m</span></span> },
        { key: "a", header: "Alasan salesman", cell: (a) => <span style={{ overflowWrap: "anywhere" }}>{a.alasan}{a.catatanPutusan && <span className="block fi-small fi-muted">IT: {a.catatanPutusan}</span>}</span> },
        { key: "p", header: "Peta", cell: (a) => <span className="flex flex-wrap gap-1"><Peta lat={a.lat} lng={a.lng} label="Titik salesman" nama={a.custName ?? a.custCode} />
            <Peta lat={a.titikLat} lng={a.titikLng} label="Titik toko" nama={a.custName ?? a.custCode} /></span> },
        { key: "k", header: "Keputusan", cell: (a) => a.status === "menunggu" ? (
            <span className="flex flex-wrap gap-1">
                <Button icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(kunciPutus)} disabledReason={kunciPutus} onClick={() => { setPindah(false); setSetuju(a); }}>Setujui…</Button>
                <Button variant="tertiary" icon={<X className="fi-icon" aria-hidden />} disabled={Boolean(kunciPutus)} disabledReason={kunciPutus} onClick={() => setTolak(a)}>Tolak…</Button>
            </span>) : <StatusBadge tone={TONE_AJUAN[a.status]}>{a.status === "disetujui" ? (a.titikDipindah ? "Disetujui · titik dipindah" : "Disetujui") : "Ditolak"}</StatusBadge> },
    ];

    return (
        <section aria-label="Validasi lokasi toko" className="grid gap-4">
            <div className="fi-page-bar">
                <h2 className="fi-title-2">Validasi Lokasi</h2>
                <span className="fi-spacer" />
                <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatSemua}>Muat ulang</Button>
                <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} disabled={Boolean(izin)} disabledReason={izin}
                    onClick={() => { setBerkas(null); setUnggah(true); }}>Unggah status titik</Button>
            </div>
            <p className="fi-small fi-muted">
                Check-in dan check-out salesman harus dekat titik toko: titik fix maks. 20 m, titik yang perlu validasi maks. 100 m. Di luar batas, salesman
                mengajukan ke IT dengan alasan dan kunjungannya tetap berlanjut. Toko tanpa titik tidak dibatasi; titik check-in salesman dikumpulkan di
                Antrean perbaikan lokasi untuk dipilih yang paling akurat.
            </p>
            {hasil && <MessageStrip tone="pos" title="Tersimpan." onClose={() => setHasil("")}>{hasil}</MessageStrip>}
            {ringkas.status === "galat" && <MessageStrip tone="neg" title="Ringkasan gagal dimuat.">{ringkas.error}</MessageStrip>}
            {r && <KeyValues items={[["Toko JKS aktif", angka(r.tokoJks)], ["Titik fix (20 m)", angka(r.fix)], ["Perlu validasi (100 m)", angka(r.validasi)],
                ["Tanpa titik", angka(r.tanpaTitik)], ["Pengajuan menunggu IT", angka(r.pengajuanMenunggu)]]} />}

            <Section title="Pengajuan lokasi ke IT" subtitle="check-in / check-out di luar batas titik toko">
                <div className="flex flex-wrap gap-2 px-4 pt-3" role="group" aria-label="Saring status pengajuan">
                    {(["menunggu", "disetujui", "ditolak"] as const).map((s) => (
                        <Button key={s} variant={statusAjuan === s ? "primary" : "secondary"} aria-pressed={statusAjuan === s} onClick={() => setStatusAjuan(s)}>
                            {s === "menunggu" ? "Menunggu" : s === "disetujui" ? "Disetujui" : "Ditolak"}
                        </Button>
                    ))}
                </div>
                <ResponsiveTable title="Pengajuan lokasi" count={ajuan.data?.length ?? 0} columns={kolomAjuan} rows={ajuan.data ?? []} rowKey={(a) => a.id}
                    status={ajuan.status} error={ajuan.error} onRetry={muatAjuan}
                    empty={{ title: "Tidak ada pengajuan", message: statusAjuan === "menunggu" ? "Semua check-in/check-out dalam batas titik toko." : "Belum ada pengajuan dengan status ini." }}
                    mobileItem={(a) => <ListItem doc={a.custCode} title={a.custName ?? a.custCode} amount={<span className="fi-tnum">{angka(a.jarakM)} m</span>}
                        meta={`${TAHAP[a.tahap]} ${tanggalPanjang(a.tanggal)} · ${a.salesCode} · batas ${a.radiusM} m · ${a.alasan}`}
                        badge={<StatusBadge tone={TONE_AJUAN[a.status]}>{a.status}</StatusBadge>} />} />
            </Section>

            <Section title="Antrean perbaikan lokasi" subtitle="toko tanpa titik fix, dengan titik check-in salesman 90 hari terakhir">
                {antrean.status === "galat" && <div className="px-4 py-3"><MessageStrip tone="neg" title="Antrean gagal dimuat.">{antrean.error}</MessageStrip></div>}
                {antrean.data?.length === 0 && <EmptyState title="Antrean kosong" message="Belum ada titik check-in untuk toko tanpa titik fix." />}
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {(antrean.data ?? []).map((t) => (
                        <li key={t.custCode} className="grid gap-2 border-t px-4 py-3" style={{ borderColor: "var(--line)" }}>
                            <div className="flex flex-wrap items-center gap-2">
                                <b>{t.custName}</b><span className="fi-codes">{t.custCode}</span>
                                <StatusBadge tone={t.titikSekarang ? "warn" : "neu"}>{t.titikSekarang ? LABEL_STATUS_TITIK[t.titikSekarang.status] : "Tanpa titik"}</StatusBadge>
                            </div>
                            <span className="fi-small fi-muted">{[t.alamat, t.kota].filter(Boolean).join(", ") || KOSONG}</span>
                            <span className="fi-small">
                                {angka(t.tengah.jumlah)} check-in dari {angka(t.tengah.salesman)} salesman · titik tengah, sebaran ±{angka(t.tengah.sebaranM)} m
                            </span>
                            <div className="flex flex-wrap gap-2">
                                <Peta lat={t.tengah.lat} lng={t.tengah.lng} label="Titik tengah" nama={t.custName} />
                                {t.titikSekarang && <Peta lat={t.titikSekarang.lat} lng={t.titikSekarang.lng} label="Titik sekarang" nama={t.custName} />}
                                <Button disabled={Boolean(izin)} disabledReason={izin}
                                    onClick={() => setTetapkan({ toko: t, lat: t.tengah.lat, lng: t.tengah.lng, asal: `titik tengah ${t.tengah.jumlah} check-in` })}>
                                    Tetapkan titik tengah…
                                </Button>
                            </div>
                            <details>
                                <summary style={{ cursor: "pointer", minHeight: 32 }} className="fi-small">Titik check-in per salesman ({t.checkin.length})</summary>
                                <ul className="grid gap-1" style={{ listStyle: "none", margin: 0, padding: "4px 0 0" }}>
                                    {t.checkin.map((c, i) => (
                                        <li key={`${c.salesCode}|${c.tanggal}|${i}`} className="flex flex-wrap items-center gap-2 fi-small">
                                            <span className="fi-mono">{c.salesCode}</span> {tanggalPanjang(c.tanggal)} · akurasi {c.akurasi === null ? KOSONG : `±${angka(c.akurasi)} m`}
                                            <Peta lat={c.lat} lng={c.lng} label="Lihat" nama={`${t.custName}, check-in ${c.salesCode}`} />
                                            <Button variant="tertiary" disabled={Boolean(izin)} disabledReason={izin}
                                                onClick={() => setTetapkan({ toko: t, lat: c.lat, lng: c.lng, asal: `check-in ${c.salesCode} ${c.tanggal}` })}>Pakai titik ini…</Button>
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        </li>
                    ))}
                </ul>
            </Section>

            <ConfirmDialog open={unggah} onClose={() => setUnggah(false)} tag="Validasi Lokasi" title="Terapkan status titik toko?"
                description="Toko di sheet 1_SANGAT_BERBEDA, 2_BERBEDA, dan 3_ALAMAT_KELIRU menjadi perlu validasi (batas 100 m). Baris yang kolom LATITUDE BENAR dan LONGITUDE BENAR-nya sudah diisi menjadi titik fix (batas 20 m) dengan titik baru itu. Toko lain tidak berubah."
                confirmLabel="Terapkan status" confirmDisabled={berkas ? undefined : "Pilih berkas dulu"}
                onConfirm={async () => {
                    const fd = new FormData();
                    fd.append("file", berkas!);
                    const d = await tulisFk(API, { body: fd, gagal: "Status titik belum tersimpan; tidak ada yang ditulis." });
                    setHasil(`${angka(Number(d.ditandaiValidasi ?? 0))} titik ditandai perlu validasi, ${angka(Number(d.ditetapkanFix ?? 0))} titik fix dari kolom BENAR; `
                        + `${angka(Number(d.tanpaTitik ?? 0))} toko di berkas belum punya titik (tetap tanpa batas).`);
                    setUnggah(false);
                    muatSemua();
                }}>
                <FormField label="Berkas selisih titik (.xlsx)" required help="Berkas audit Web-LL selisih_titik_alamat_<tanggal>.xlsx; hanya tiga sheet status yang dibaca.">{(a) => (
                    <input {...a} className="fi-input" type="file" accept=".xlsx" onChange={(e) => setBerkas(e.target.files?.[0] ?? null)} />
                )}</FormField>
            </ConfirmDialog>

            <ConfirmDialog open={setuju !== null} onClose={() => setSetuju(null)} tag="Pengajuan lokasi" title={`Setujui ${setuju ? TAHAP[setuju.tahap].toLowerCase() : ""} di luar batas?`}
                description="Kunjungan dianggap sah. Pindahkan titik toko HANYA bila sudah dipastikan (peta / foto check-in) bahwa lokasi salesman adalah toko itu: titik baru menjadi titik fix (batas 20 m)."
                facts={setuju ? [["Toko", `${setuju.custName ?? setuju.custCode} · ${setuju.custCode}`], ["Salesman", setuju.salesCode],
                    ["Jarak", `${angka(setuju.jarakM)} m dari titik toko (batas ${setuju.radiusM} m)`], ["Akurasi GPS salesman", `±${angka(setuju.akurasi)} m`]] : []}
                confirmLabel="Setujui"
                onConfirm={async () => {
                    const a = setuju!;
                    await tulisFk(API, { body: { aksi: "putuskan", id: a.id, keputusan: "disetujui", pindahTitik: pindah }, gagal: "Keputusan belum tersimpan." });
                    setHasil(`Pengajuan ${a.custName ?? a.custCode} disetujui${pindah ? "; titik toko dipindah ke lokasi salesman (fix)" : ""}.`);
                    setSetuju(null);
                    muatSemua();
                }}>
                <label className="flex items-center gap-2" style={{ minHeight: 44 }}>
                    <input type="checkbox" checked={pindah} onChange={(e) => setPindah(e.target.checked)} />
                    Pindahkan titik toko ke lokasi salesman
                </label>
            </ConfirmDialog>

            <ConfirmDialog open={tolak !== null} onClose={() => setTolak(null)} tag="Pengajuan lokasi" tone="negative"
                title={`Tolak ${tolak ? TAHAP[tolak.tahap].toLowerCase() : ""} di luar batas?`}
                description="Kunjungan ini ditandai tidak sah di Supervisor Review. Titik toko tidak berubah."
                facts={tolak ? [["Toko", `${tolak.custName ?? tolak.custCode} · ${tolak.custCode}`], ["Salesman", tolak.salesCode],
                    ["Jarak", `${angka(tolak.jarakM)} m dari titik toko (batas ${tolak.radiusM} m)`]] : []}
                reason={{ label: "Alasan penolakan (dibaca salesman dan SPV)", min: 5 }}
                confirmLabel="Tolak pengajuan"
                onConfirm={async (alasan) => {
                    const a = tolak!;
                    await tulisFk(API, { body: { aksi: "putuskan", id: a.id, keputusan: "ditolak", catatan: alasan }, gagal: "Keputusan belum tersimpan." });
                    setHasil(`Pengajuan ${a.custName ?? a.custCode} ditolak.`);
                    setTolak(null);
                    muatSemua();
                }} />

            <ConfirmDialog open={tetapkan !== null} onClose={() => setTetapkan(null)} tag="Antrean perbaikan lokasi" title="Tetapkan titik toko?"
                description="Titik ini menjadi titik fix toko: check-in dan check-out berikutnya harus dalam 20 m."
                facts={tetapkan ? [["Toko", `${tetapkan.toko.custName} · ${tetapkan.toko.custCode}`], ["Sumber", tetapkan.asal],
                    ["Titik", `${tetapkan.lat.toFixed(6)}, ${tetapkan.lng.toFixed(6)}`]] : []}
                confirmLabel="Tetapkan titik"
                onConfirm={async () => {
                    const t = tetapkan!;
                    await tulisFk(API, { body: { aksi: "tetapkan", custCode: t.toko.custCode, lat: t.lat, lng: t.lng }, gagal: "Titik toko belum tersimpan." });
                    setHasil(`Titik ${t.toko.custName} ditetapkan (fix).`);
                    setTetapkan(null);
                    muatSemua();
                }} />
        </section>
    );
}
