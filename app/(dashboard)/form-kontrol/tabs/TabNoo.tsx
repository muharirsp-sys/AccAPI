/*
 * Tujuan: Tab "Toko Baru (NOO)" Form Kontrol (owner 13 Okt 2026), satu layar per peran (hak dari server, `row.boleh`):
 *   salesman = pengajuan saya (status, alasan tolak, kode pelanggan, "Kunjungi hari ini");
 *   SPV tim / SM pengganti / Admin = menunggu persetujuan → rincian (foto toko, koordinat + peta, bendera GPS, NIK tersamar, "Lihat KTP"
 *     tercatat) → Setujui (duplikat WAJIB centang "pemilik toko memang sama") / Tolak (alasan wajib);
 *   grup Admin (izin form_kontrol.noo_tautkan) = antrean "daftarkan di Accurate" (data siap salin) → Tautkan pelanggan hasil sync (saran
 *     nama/alamat cabang sama + cari) → terdaftar. Manager/Admin Sales melihat tanpa KTP dan tanpa aksi.
 *   Galat memuat ulang TIDAK tampil sebagai kosong/hasil baru (peninjau B T1): strip galat + data sebelumnya ditandai + aksi dikunci.
 *   Daftar: status aktif selalu lengkap; selesai (terdaftar/ditolak) terpotong 300 terbaru → `selesaiTerpotong` diberitahukan.
 * Caller: ../FormKontrol.tsx (TAB.noo).
 * Dependensi: GET/POST /api/form-kontrol/noo/**, ../shared (Scope, ambilFk, jamWita), ../lapangan (kirimFk, GagalKirim), components/fiori/*,
 *   components/ui/Dialog, lib/form-kontrol/noo-aturan (LABEL_STATUS_NOO), lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: TabNoo (default), RincianNoo, DialogKtp (selalu terpasang → fokus kembali ke "Lihat KTP"; isi KTP hanya selama terbuka).
 * Side Effects: HTTP baca/tulis di atas; clipboard (Salin). KTP lengkap hanya di memori selama dialog terbuka (dibuang saat ditutup).
 */
"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { CheckCircle2, Copy, IdCard, Link2, MapPin, RefreshCw, Search, XCircle } from "lucide-react";
import { Button, EmptyState, ErrorState, FlexibleColumnLayout, KeyValues, ListItem, MessageStrip, Section, Skeleton, StatusBadge, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import Dialog from "@/components/ui/Dialog";
import { LABEL_STATUS_NOO, type StatusNoo } from "@/lib/form-kontrol/noo-aturan";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { ambilFk, jamWita, type Scope } from "../shared";
import { GagalKirim, kirimFk } from "../lapangan";

type Boleh = { putuskan: boolean; ktp: boolean; tautkan: boolean; kunjungi: boolean };
type NooRingkas = {
    id: string; kode: string; salesCode: string; salesName: string | null; principle: string; branchName: string | null; tanggal: string;
    namaToko: string; alamat: string; status: StatusNoo; gpsFlag: string | null; duplikat: boolean; duplikatDengan: string | null; dibuatOlehNama: string | null;
    dibuatPada: string; diputuskanOlehNama: string | null; diputuskanPada: string | null; alasanTolak: string | null; customerNo: string | null;
    ditautkanOlehNama: string | null; ditautkanPada: string | null; boleh: Boleh;
};
type NooRinci = NooRingkas & {
    namaPemilik: string; noHp: string; namaKtp: string; nikTersamar: string; lat: number; lng: number; akurasi: number;
    alasanDuplikat: string | null; duplikatDikonfirmasi: boolean; fotoToko: string;
};
type Saran = { id: number; customerNo: string; name: string; alamat: string | null; skor: number | null };
type Pembanding = { kode: string; namaToko: string; status: StatusNoo; salesCode: string; alamat: string; customerNo: string | null } | null;
type Daftar = { rows: NooRingkas[]; selesaiTerpotong: boolean; batasSelesai: number };

const NADA: Record<StatusNoo, Tone> = { menunggu_spv: "warn", disetujui: "info", ditolak: "neg", terdaftar: "pos" };
const badge = (s: StatusNoo) => <StatusBadge tone={NADA[s]}>{LABEL_STATUS_NOO[s]}</StatusBadge>;

export default function TabNoo({ scope }: { scope: Scope }) {
    const salesman = Boolean(scope.salesCode);
    const [pilihId, setPilihId] = useState<string | null>(null);
    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Daftar>> =>
        ambilFk("/api/form-kontrol/noo", (j) => ({ rows: (Array.isArray(j.rows) ? j.rows : []) as NooRingkas[], selesaiTerpotong: j.selesaiTerpotong === true,
            batasSelesai: Number(j.batasSelesai) || 300 }), "Daftar toko baru gagal dimuat."), []));
    const rows = load.data?.rows ?? [];

    const kelompok: [string, string, NooRingkas[]][] = salesman
        ? [["saya", "Pengajuan saya", rows]]
        : [
            ["menunggu", "Menunggu persetujuan", rows.filter((r) => r.status === "menunggu_spv")],
            ["disetujui", "Disetujui — daftarkan di Accurate", rows.filter((r) => r.status === "disetujui")],
            ["selesai", "Terdaftar / ditolak", rows.filter((r) => r.status === "terdaftar" || r.status === "ditolak")],
        ];

    let daftar: ReactNode;
    if (load.status === "galat" && !load.data) daftar = <ErrorState title="Toko baru belum bisa ditampilkan" message={load.error} onRetry={muatUlang} />;
    else if (!load.data) daftar = <Skeleton rows={4} label="Memuat toko baru" />;
    else if (rows.length === 0) {
        daftar = <EmptyState title="Belum ada pengajuan toko baru" message={salesman
            ? "Ajukan toko yang belum ada di Accurate dari Rute hari ini → Toko baru (NOO)."
            : "Pengajuan salesman dalam cakupan Anda tampil di sini."} />;
    } else {
        daftar = (
            <div className="grid gap-4">
                {load.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang.">{load.error} Yang tampil adalah hasil sebelumnya.</MessageStrip>}
                {kelompok.map(([k, judul, isi]) => (
                    <Section key={k} title={judul} subtitle={`${isi.length} toko${k !== "menunggu" && k !== "disetujui" && load.data?.selesaiTerpotong ? ` (${load.data.batasSelesai} terbaru)` : ""}`}>
                        {k !== "menunggu" && k !== "disetujui" && load.data?.selesaiTerpotong && (
                            <p className="fi-small fi-muted" style={{ padding: "8px 16px 0" }}>
                                Hanya {load.data.batasSelesai} toko terdaftar/ditolak terbaru yang tampil; yang menunggu dan disetujui selalu tampil semua.
                            </p>
                        )}
                        {isi.length === 0 ? <p className="fi-small fi-muted" style={{ padding: "8px 16px" }}>Tidak ada.</p> : (
                            <ul aria-label={judul} style={{ listStyle: "none", padding: 0 }}>
                                {isi.map((r) => (
                                    <li key={r.id}>
                                        <ListItem onClick={() => setPilihId(r.id)} current={pilihId === r.id} doc={r.kode} title={r.namaToko}
                                            meta={[salesman ? null : `${r.salesName ?? r.salesCode}`, tanggalPendek(r.tanggal), r.duplikat ? "kemungkinan pemilik sama" : null,
                                                r.customerNo ? `pelanggan ${r.customerNo}` : null].filter(Boolean).join(" · ")}
                                            badge={badge(r.status)} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>
                ))}
            </div>
        );
    }

    return (
        <section className="grid gap-4" aria-label="Toko baru">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-1">
                    <h2 className="fi-title-2">Toko baru (NOO)</h2>
                    <p className="fi-small fi-muted">Toko yang belum ada di Accurate: SPV menyetujui → Admin mendaftarkan di Accurate dan menautkan pelanggan → order bisa dibuat.</p>
                </div>
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && Boolean(load.data)} onClick={muatUlang}>Muat ulang</Button>
            </div>
            <FlexibleColumnLayout list={daftar} detailOpen={pilihId !== null} onBack={() => setPilihId(null)} listLabel="Daftar toko baru" detailLabel="Rincian toko baru"
                detail={pilihId ? <RincianNoo key={pilihId} id={pilihId} onBerubah={muatUlang} /> : <EmptyState title="Pilih toko baru" message="Rincian dan aksi tampil di sini." />} />
        </section>
    );
}

function Salin({ nilai, label }: { nilai: string; label: string }) {
    const [ok, setOk] = useState(false);
    return (
        <span className="inline-flex flex-wrap items-center gap-2">
            <span>{nilai}</span>
            <Button variant="tertiary" icon={<Copy className="fi-icon" aria-hidden />} aria-label={`Salin ${label}`}
                onClick={() => { void navigator.clipboard?.writeText(nilai).then(() => setOk(true), () => setOk(false)); }}>{ok ? "Disalin" : "Salin"}</Button>
        </span>
    );
}

function RincianNoo({ id, onBerubah }: { id: string; onBerubah: () => void }) {
    const [cari, setCari] = useState("");
    const [ketik, setKetik] = useState("");
    // `cari` ikut disimpan bersama hasilnya: label "Hasil …" selalu milik daftar yang sedang tampil (bukan ketikan terbaru yang belum/gagal dimuat).
    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<{ row: NooRinci; pembanding: Pembanding; saran: Saran[] | null; cari: string }>> =>
        ambilFk(`/api/form-kontrol/noo/${encodeURIComponent(id)}${cari ? `?${new URLSearchParams({ cari })}` : ""}`,
            (j) => ({ row: j.row as NooRinci, pembanding: (j.pembanding ?? null) as Pembanding, saran: (j.saran ?? null) as Saran[] | null, cari }),
            "Rincian toko baru gagal dimuat."), [id, cari]), { pertahankan: true });
    const [dialog, setDialog] = useState<"setujui" | "tolak" | "tautkan" | null>(null);
    const [pemilikSama, setPemilikSama] = useState(false);
    const [pilih, setPilih] = useState<Saran | null>(null);
    const [ktpBuka, setKtpBuka] = useState(false);
    const [pesan, setPesan] = useState("");
    const [galat, setGalat] = useState("");
    const [fotoKe, setFotoKe] = useState(0);
    const [fotoGagal, setFotoGagal] = useState(false);

    if (!load.data) return load.status === "galat" ? <ErrorState title="Rincian belum bisa ditampilkan" message={load.error} onRetry={muatUlang} /> : <Skeleton rows={5} label="Memuat rincian" />;
    const { row: r, pembanding, saran } = load.data;
    const peta = `https://www.google.com/maps?q=${r.lat},${r.lng}`;
    // Peninjau B T1: data yang tampil BUKAN hasil terbaru (muat ulang gagal / sedang memuat) → aksi tulis dikunci, galat disebut terang.
    const usang = load.status === "galat";
    const kunciAksi = usang ? "Rincian gagal dimuat ulang; muat ulang dulu." : load.status === "memuat" ? "Memuat ulang rincian…" : undefined;

    async function kirim(isi: Record<string, unknown>, berhasil: string, tombol: string) {
        try {
            await kirimFk(`/api/form-kontrol/noo/${encodeURIComponent(id)}`, isi);
        } catch (e) {
            // Ditolak (mis. sudah diputuskan orang lain) atau tidak pasti → rincian & daftar dimuat ulang; dialog menampilkan kalimatnya.
            muatUlang(); onBerubah();
            throw e instanceof GagalKirim && e.tidakPasti
                ? new Error(`Jawaban server belum pasti — belum diketahui tersimpan atau belum. Rincian dimuat ulang: bila statusnya belum berubah, tekan ${tombol} lagi (aman, tidak tercatat dua kali).`)
                : e;
        }
        setDialog(null); setPesan(berhasil); setGalat(""); muatUlang(); onBerubah();
    }

    async function kunjungi() {
        setGalat(""); setPesan("");
        try {
            await kirimFk(`/api/form-kontrol/noo/${encodeURIComponent(id)}`, { aksi: "kunjungi", principle: r.principle }, { ulangAman: true });
            setPesan(`${r.namaToko} masuk kunjungan hari ini (bertanda NOO). Buka dari Rute hari ini.`);
        } catch (e) { setGalat(e instanceof Error ? e.message : "Gagal menambah kunjungan."); }
    }

    return (
        <div className="grid gap-4">
            {usang && (
                <MessageStrip tone="neg" title="Gagal memuat ulang rincian.">
                    {load.error} Yang tampil hasil sebelumnya — status dan pilihan pelanggan bisa sudah berubah; aksi dikunci sampai muat ulang berhasil.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Muat ulang</button>
                </MessageStrip>
            )}
            <div className="fi-panel grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <b className="fi-mono">{r.kode}</b>{badge(r.status)}
                    {r.duplikat && <StatusBadge tone="warn">Kemungkinan pemilik sama</StatusBadge>}
                </div>
                <h3 className="fi-title-3">{r.namaToko}</h3>
                {pesan && <MessageStrip tone="pos" onClose={() => setPesan("")}>{pesan}</MessageStrip>}
                {galat && <MessageStrip tone="neg" title="Belum berhasil.">{galat}</MessageStrip>}
                {r.status === "ditolak" && <MessageStrip tone="neg" title={`Ditolak ${r.diputuskanOlehNama ?? ""}`.trim()}>{r.alasanTolak}</MessageStrip>}
                {r.status === "terdaftar" && <MessageStrip tone="pos" title={`Terdaftar sebagai ${r.customerNo}.`}>Order dan konfirmasi JKS memakai kode pelanggan ini (Kunjungan luar rute).</MessageStrip>}
                {r.status === "disetujui" && !r.boleh.tautkan && <p className="fi-small fi-muted">Menunggu Admin mendaftarkan toko ini di Accurate lalu menautkannya.</p>}
            </div>

            {r.duplikat && (
                <MessageStrip tone="warn" title={`NIK atau No. HP sama dengan ${r.duplikatDengan ?? "pengajuan toko baru lain"}.`}>
                    {pembanding ? `${pembanding.namaToko} (${LABEL_STATUS_NOO[pembanding.status]}, ${pembanding.salesCode}${pembanding.customerNo ? `, pelanggan ${pembanding.customerNo}` : ""}) · ${pembanding.alamat}. ` : ""}
                    Alasan salesman: {r.alasanDuplikat}
                    {r.duplikatDikonfirmasi && " · Dikonfirmasi pemutus: pemilik sama."}
                </MessageStrip>
            )}

            <Section title="Toko & pemilik">
                <div className="fi-sect-in grid gap-3">
                    {fotoGagal ? (
                        <MessageStrip tone="warn" title="Foto toko gagal dimuat.">
                            Foto ada di pengajuan ini tetapi belum terbaca (sinyal atau server).{" "}
                            <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setFotoGagal(false); setFotoKe((n) => n + 1); }}>Muat ulang foto</button>
                        </MessageStrip>
                    ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={fotoKe} src={fotoKe ? `${r.fotoToko}?ulang=${fotoKe}` : r.fotoToko} alt={`Foto toko ${r.namaToko}`} onError={() => setFotoGagal(true)}
                            style={{ width: "100%", maxHeight: "14rem", objectFit: "cover", borderRadius: "var(--r-md)" }} />
                    )}
                    <KeyValues items={[
                        ["Nama toko", r.boleh.tautkan ? <Salin nilai={r.namaToko} label="nama toko" /> : r.namaToko],
                        ["Alamat", r.boleh.tautkan ? <Salin nilai={r.alamat} label="alamat" /> : r.alamat],
                        ["Pemilik", r.boleh.tautkan ? <Salin nilai={r.namaPemilik} label="nama pemilik" /> : r.namaPemilik],
                        ["No. HP pemilik", r.boleh.tautkan ? <Salin nilai={r.noHp} label="nomor HP" /> : <span className="fi-mono">{r.noHp}</span>],
                        ["Salesman", `${r.salesName ?? r.salesCode} (${r.salesCode}) · ${r.principle}`],
                        ["Cabang", r.branchName ?? "—"],
                        ["Diajukan", `${tanggalPendek(r.tanggal)} ${jamWita(r.dibuatPada)} WITA`],
                        ...(r.diputuskanPada ? [[r.status === "ditolak" ? "Ditolak" : "Disetujui", `${r.diputuskanOlehNama ?? "—"} · ${tanggalPendek(r.diputuskanPada.slice(0, 10))} ${jamWita(r.diputuskanPada)}`] as [string, ReactNode]] : []),
                        ...(r.ditautkanPada ? [["Ditautkan", `${r.ditautkanOlehNama ?? "—"} · ${r.customerNo}`] as [string, ReactNode]] : []),
                    ]} />
                </div>
            </Section>

            <Section title="Lokasi GPS">
                <div className="fi-sect-in grid gap-2">
                    <p className="fi-tnum">{r.lat.toFixed(6)}, {r.lng.toFixed(6)} · akurasi ± {Math.round(r.akurasi)} m</p>
                    {r.gpsFlag && <MessageStrip tone="warn" title="Bendera GPS:">{r.gpsFlag.split(",").map((f) => f === "akurasi_rendah" ? "akurasi rendah (> 1 km)" : f).join(", ")}</MessageStrip>}
                    <a className="fi-btn fi-btn--secondary" href={peta} target="_blank" rel="noopener noreferrer"><MapPin className="fi-icon" aria-hidden />Buka di peta</a>
                </div>
            </Section>

            <Section title="KTP pemilik" subtitle="data pribadi">
                <div className="fi-sect-in grid gap-2">
                    <KeyValues items={[["NIK", <span key="n" className="fi-mono">{r.nikTersamar}</span>], ["Nama sesuai KTP", r.namaKtp]]} />
                    {r.boleh.ktp ? (
                        <div className="fi-btnrow">
                            <Button icon={<IdCard className="fi-icon" aria-hidden />} onClick={() => setKtpBuka(true)}>Lihat KTP</Button>
                            <span className="fi-small fi-muted">Membuka KTP lengkap tercatat atas nama Anda.</span>
                        </div>
                    ) : <p className="fi-small fi-muted">KTP lengkap hanya untuk SPV/SM tim dan Admin.</p>}
                </div>
            </Section>

            {r.boleh.putuskan && (
                <Section title="Keputusan SPV">
                    <div className="fi-sect-in fi-btnrow">
                        <Button variant="primary" icon={<CheckCircle2 className="fi-icon" aria-hidden />} disabled={Boolean(kunciAksi)} disabledReason={kunciAksi}
                            onClick={() => { setPemilikSama(false); setDialog("setujui"); }}>Setujui</Button>
                        <Button icon={<XCircle className="fi-icon" aria-hidden />} disabled={Boolean(kunciAksi)} disabledReason={kunciAksi} onClick={() => setDialog("tolak")}>Tolak…</Button>
                    </div>
                </Section>
            )}

            {r.boleh.kunjungi && (
                <div className="fi-btnrow"><Button disabled={Boolean(kunciAksi)} disabledReason={kunciAksi} onClick={() => void kunjungi()}>Kunjungi hari ini</Button></div>
            )}

            {r.boleh.tautkan && (
                <Section title="Tautkan pelanggan Accurate" subtitle="sesudah Admin mendaftarkan toko di Accurate">
                    <div className="fi-sect-in grid gap-3">
                        <p className="fi-small fi-muted">
                            Daftarkan toko ini di Accurate (cabang {r.branchName ?? "NOO"}) memakai data di atas, tunggu sync pelanggan, lalu pilih pelanggannya di sini.
                        </p>
                        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setPilih(null); setCari(ketik.trim()); }}>
                            <FormField label="Cari nama atau kode pelanggan">
                                {(a) => <input {...a} className="fi-input" value={ketik} maxLength={80} onChange={(e) => setKetik(e.target.value)} />}
                            </FormField>
                            <Button type="submit" icon={<Search className="fi-icon" aria-hidden />}>Cari</Button>
                        </form>
                        {usang ? (
                            <p className="fi-small fi-why">{cari ? `Pencarian "${cari}" gagal dimuat` : "Saran pelanggan gagal dimuat"} — bukan berarti pelanggan belum ada. Muat ulang atau cari lagi.</p>
                        ) : load.status === "memuat" ? <Skeleton rows={2} label="Mencari pelanggan" /> : (<>
                        <p className="fi-small">{load.data.cari ? `Hasil "${load.data.cari}" di cabang ${r.branchName ?? ""}:` : "Saran (pelanggan baru di sync, nama/alamat mirip):"}</p>
                        {!saran?.length ? <p className="fi-small fi-muted">Belum ada pelanggan cocok. Bila baru didaftarkan, tunggu sync pelanggan lalu muat ulang, atau cari kodenya.</p> : (
                            <ul role="radiogroup" aria-label="Pelanggan untuk ditautkan" style={{ listStyle: "none", padding: 0 }} className="grid gap-2">
                                {saran.map((s) => (
                                    <li key={s.id}>
                                        <label className="flex items-start gap-2" style={{ minHeight: 44 }}>
                                            <input type="radio" name={`tautan-${id}`} checked={pilih?.id === s.id} onChange={() => setPilih(s)} style={{ width: 20, height: 20, marginTop: 2 }} />
                                            <span><b className="fi-mono">{s.customerNo}</b> {s.name}{s.alamat ? ` · ${s.alamat}` : ""}{s.skor != null ? ` · kemiripan ${Math.round(s.skor * 100)}%` : ""}</span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        )}
                        </>)}
                        <div className="fi-btnrow">
                            <Button variant="primary" icon={<Link2 className="fi-icon" aria-hidden />} disabled={!pilih || Boolean(kunciAksi)} disabledReason={kunciAksi ?? "Pilih pelanggan dulu"}
                                onClick={() => setDialog("tautkan")}>Tautkan…</Button>
                        </div>
                    </div>
                </Section>
            )}

            <ConfirmDialog open={dialog === "setujui"} onClose={() => setDialog(null)} title={`Setujui toko baru ${r.namaToko}?`}
                description="Toko masuk antrean Admin untuk didaftarkan di Accurate. Order baru bisa sesudah toko tertaut ke pelanggan Accurate."
                facts={[["Kode", r.kode], ["Salesman", `${r.salesName ?? r.salesCode}`], ["NIK", r.nikTersamar]]}
                confirmLabel="Setujui" alasanTerlihat
                confirmDisabled={r.duplikat && !pemilikSama ? "Centang konfirmasi pemilik sama dulu" : undefined}
                onConfirm={() => kirim({ aksi: "setujui", konfirmasiPemilikSama: pemilikSama }, `${r.kode} disetujui; masuk antrean Admin.`, "Setujui")}>
                {r.duplikat && (
                    <label className="flex items-start gap-2" style={{ minHeight: 44 }}>
                        <input type="checkbox" checked={pemilikSama} onChange={(e) => setPemilikSama(e.target.checked)} style={{ width: 22, height: 22, marginTop: 2 }} />
                        <span>Pemilik toko memang sama dengan {r.duplikatDengan ?? "pengajuan lain"} (NIK/No. HP sama sudah saya periksa).</span>
                    </label>
                )}
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "tolak"} onClose={() => setDialog(null)} title={`Tolak toko baru ${r.namaToko}?`} tone="negative"
                description="Salesman melihat alasan ini. Penolakan final; salesman bisa mengajukan toko baru lagi bila perlu."
                reason={{ label: "Alasan penolakan", min: 5, placeholder: "mis. lokasi tidak sesuai foto" }} confirmLabel="Tolak"
                onConfirm={(alasan) => kirim({ aksi: "tolak", alasan }, `${r.kode} ditolak.`, "Tolak")} />
            <ConfirmDialog open={dialog === "tautkan" && Boolean(pilih)} onClose={() => setDialog(null)} title={`Tautkan ${r.kode} ke ${pilih?.customerNo ?? ""}?`}
                description="Status menjadi terdaftar. Satu pelanggan Accurate hanya bisa tertaut ke satu toko baru; penautan tidak bisa dibatalkan dari layar ini."
                facts={[["Toko baru", `${r.kode} · ${r.namaToko}`], ["Pelanggan", `${pilih?.customerNo ?? ""} · ${pilih?.name ?? ""}`], ["Cabang", r.branchName ?? "—"]]}
                confirmLabel="Tautkan" onConfirm={() => kirim({ aksi: "tautkan", customerId: pilih?.id }, `${r.kode} terdaftar sebagai ${pilih?.customerNo}.`, "Tautkan")} />
            <DialogKtp open={ktpBuka} id={id} kode={r.kode} onClose={() => setKtpBuka(false)} />
        </div>
    );
}

/**
 * "Lihat KTP": `<dialog>` SELALU terpasang (close() pada node tersambung → fokus kembali ke tombol "Lihat KTP", peninjau B S3); isinya
 * (satu POST — server mencatat audit lebih dulu — lalu NIK + foto) hanya terpasang selama terbuka, jadi KTP hilang dari DOM/state saat ditutup.
 */
function DialogKtp({ open, id, kode, onClose }: { open: boolean; id: string; kode: string; onClose: () => void }) {
    const judul = useId();
    return (
        <Dialog open={open} onClose={onClose} labelledBy={judul} className="fi-dialog">
            <header><div><h2 id={judul}>KTP {kode}</h2></div></header>
            {open && <IsiKtp id={id} kode={kode} />}
            <footer><Button onClick={onClose}>Tutup</Button></footer>
        </Dialog>
    );
}

function IsiKtp({ id, kode }: { id: string; kode: string }) {
    const [load] = useLoad(useCallback(async (): Promise<Load<{ nik: string; namaKtp: string; foto: string }>> => {
        try {
            const res = await fetch(`/api/form-kontrol/noo/${encodeURIComponent(id)}/ktp`, { method: "POST", cache: "no-store" });
            const j = await res.json().catch(() => null) as Record<string, unknown> | null;
            if (res.ok && j && typeof j.nik === "string") return { status: "siap", data: { nik: j.nik, namaKtp: String(j.namaKtp ?? ""), foto: String(j.foto ?? "") } };
            return { status: "galat", error: typeof j?.error === "string" && j.kode ? j.error : res.status === 403 ? "Akun Anda tidak berhak membuka KTP ini." : "KTP gagal dibuka." };
        } catch { return { status: "galat", error: "Server tidak terjangkau — periksa sinyal, lalu buka lagi." }; }
    }, [id]));
    return (
            <div className="fi-dialog-body grid gap-3">
                {load.status === "memuat" && <Skeleton rows={3} label="Membuka KTP" />}
                {load.status === "galat" && <MessageStrip tone="neg" title="KTP tidak dibuka.">{load.error}</MessageStrip>}
                {load.data && (
                    <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={load.data.foto} alt={`Foto KTP ${kode}`} style={{ width: "100%", borderRadius: "var(--r-md)" }} />
                        <KeyValues items={[["NIK", <span key="n" className="fi-mono">{load.data.nik}</span>], ["Nama sesuai KTP", load.data.namaKtp]]} />
                        <p className="fi-small fi-muted">Pembukaan ini tercatat. Jangan memotret atau membagikan layar ini.</p>
                    </>
                )}
            </div>
    );
}
