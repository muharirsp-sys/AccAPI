/*
 * Tujuan: Formulir NOO salesman (toko baru yang BELUM ada di Accurate, owner 13 Okt 2026) di Rute hari ini, 390 px dulu: nama toko, pemilik,
 *   alamat, No. HP pemilik, foto toko, lokasi GPS (wajib; izin ditolak = cara menyalakan), KTP (foto + NIK 16 angka + nama sesuai KTP) →
 *   kunjungan hari ini bertanda NOO, menunggu persetujuan SPV. NIK/HP sama dengan NOO lain → 409 dengan pembanding; salesman hanya bisa
 *   mengajukan ulang sebagai "minta konfirmasi SPV: pemilik sama" + alasan.
 * Caller: ./TabAo.tsx (TambahNoo, di bawah Kunjungan luar rute).
 * Dependensi: POST /api/form-kontrol/noo (multipart), components/form-kontrol/camera-capture, lib/form-kontrol/location (ambilLokasi),
 *   lib/form-kontrol/noo-aturan (periksaIsianNoo), ../lapangan (ambilJson, PESAN_SINYAL, sebabGagal), components/fiori/*.
 * Main Functions: TambahNoo, useJagaPindah.
 * Side Effects: kamera + izin lokasi peramban; HTTP POST multipart. id pengajuan (UUID) dibuat sekali per isian → kirim ulang sesudah jawaban
 *   tidak pasti = baris yang sama di server (isian diubah sesudahnya = 409 ID_BEDA_ISI). Foto diperkecil di ponsel (≤ 1600 px JPEG) sebelum
 *   dikirim. Isian hanya di memori layar ini — TIDAK disimpan ke storage; selama formulir terisi, klik tautan ke halaman/tab lain DAN tombol
 *   Kembali peramban dicegat dan ditanya dulu; tombol Batal pada formulir terisi memakai dialog yang sama. Galat per isian (aria-invalid + pesan di bawah isian) sesudah isian disentuh.
 */
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Camera, LocateFixed, Store } from "lucide-react";
import { Button, MessageStrip, Section } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import CameraCapture from "@/components/form-kontrol/camera-capture";
import { ambilLokasi, type GalatLokasi, type GeoCoords } from "@/lib/form-kontrol/location";
import { galatIsianNoo } from "@/lib/form-kontrol/noo-aturan";
import { PESAN_SINYAL, ambilJson, sebabGagal } from "../lapangan";

type Teks = { namaToko: string; namaPemilik: string; alamat: string; noHp: string; nik: string; namaKtp: string };
const KOSONG: Teks = { namaToko: "", namaPemilik: "", alamat: "", noHp: "", nik: "", namaKtp: "" };
type Pembanding = { kode: string; namaToko: string; status: string; cocok: string[] };
// Urutan isian DI LAYAR (atas → bawah): galat pertama yang disebut di bawah tombol = isian salah paling atas.
const URUTAN_LAYAR = ["namaToko", "namaPemilik", "alamat", "noHp", "fotoToko", "gps", "nik", "namaKtp", "fotoKtp"] as const;
type KunciLayar = (typeof URUTAN_LAYAR)[number];

/**
 * Selama `kotor`, (1) klik tautan ke halaman/tab lain (tab Form Kontrol, menu samping) dicegat SEBELUM Next berpindah
 * (capture di document) dan (2) tombol Kembali peramban/Android dicegat lewat satu entri riwayat penjaga (`pushState`, salinan state Next
 * supaya router tetap mengenalinya) + `popstate` → dialog "Buang isian?" yang sama. "Buang" mengulang klik tautan yang sama (perilaku Link asli,
 * termasuk replace) atau mundur sekali lagi; "Tetap di sini" sesudah Kembali memasang penjaga lagi. Formulir tersimpan/dibuang (kotor → false)
 * = penjaga dilepas dengan mundur satu langkah, kecuali sedang meninggalkan halaman.
 */
export function useJagaPindah(kotor: boolean) {
    const [tujuan, setTujuan] = useState<HTMLAnchorElement | "kembali" | null>(null);
    const lepas = useRef(false);
    const pergi = useRef(false);
    // "Buang" sesudah Kembali: beforeunload (useUnsavedGuard) dimatikan dulu lewat render ini, BARU mundur (efek di bawah).
    const [meninggalkan, setMeninggalkan] = useState(false);
    useEffect(() => { if (meninggalkan) history.back(); }, [meninggalkan]);
    useEffect(() => {
        if (!kotor) return;
        const cegat = (e: MouseEvent) => {
            if (lepas.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = (e.target instanceof Element ? e.target.closest("a[href]") : null) as HTMLAnchorElement | null;
            if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
            const u = new URL(a.href, location.href);
            if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;
            e.preventDefault();
            e.stopPropagation();
            setTujuan(a);
        };
        const pasangPenjaga = () => history.pushState({ ...(history.state ?? {}), nooJaga: true }, "", location.href);
        // Kembali dari entri penjaga → mendarat di entri asli (URL sama): tanya dulu; pengguna belum pindah halaman.
        const kembali = () => { if (!lepas.current) setTujuan("kembali"); };
        pergi.current = false;
        pasangPenjaga();
        document.addEventListener("click", cegat, true);
        window.addEventListener("popstate", kembali);
        return () => {
            document.removeEventListener("click", cegat, true);
            window.removeEventListener("popstate", kembali);
            // Masih di entri penjaga (tersimpan/dibuang di halaman ini) → lepas penjaga supaya Kembali berikutnya tidak "diam".
            if (!pergi.current && (history.state as { nooJaga?: boolean } | null)?.nooJaga) history.back();
        };
    }, [kotor]);
    return {
        tujuan,
        meninggalkan,
        tetap: () => {
            if (tujuan === "kembali") history.pushState({ ...(history.state ?? {}), nooJaga: true }, "", location.href);
            setTujuan(null);
        },
        pindah: () => {
            const a = tujuan;
            setTujuan(null);
            if (!a) return;
            pergi.current = true;
            lepas.current = true;
            if (a === "kembali") { setMeninggalkan(true); return; }
            if (!a.isConnected) { location.assign(a.href); return; }
            try { a.click(); } finally { lepas.current = false; }
        },
    };
}

export const PESAN_LOKASI: Record<GalatLokasi, string> = {
    ditolak: "Izin lokasi ditolak. Nyalakan: ketuk ikon gembok/info di bilah alamat peramban → Izin situs → Lokasi → Izinkan, pastikan GPS ponsel menyala, lalu ketuk Ambil lokasi lagi.",
    tidak_tersedia: "Lokasi belum terbaca. Nyalakan GPS/Lokasi ponsel (mode akurasi tinggi), pindah ke tempat terbuka, lalu ambil lagi.",
    waktu_habis: "Lokasi terlalu lama terbaca. Pastikan GPS menyala dan coba lagi di tempat terbuka.",
    tidak_didukung: "Peramban ini tidak bisa membaca lokasi. Pakai Chrome atau Edge terbaru di ponsel.",
};

// ponytail: perkecil di ponsel lewat canvas (≤ 1600 px, JPEG 0.85) supaya dua foto muat ≤ 5 MB tiap berkas di sinyal lemah; server tetap
//   mengolah ulang (sharp). Peramban tanpa createImageBitmap = kirim apa adanya (server menolak > 5 MB dengan kalimat jelas).
async function kecilkan(b: Blob): Promise<Blob> {
    if (typeof createImageBitmap === "undefined") return b;
    try {
        const img = await createImageBitmap(b);
        const skala = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * skala));
        c.height = Math.max(1, Math.round(img.height * skala));
        const g = c.getContext("2d");
        if (!g) return b;
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        return await new Promise<Blob>((ok) => c.toBlob((x) => ok(x ?? b), "image/jpeg", 0.85));
    } catch { return b; }
}

function FotoSlot({ label, blob, onAmbil, kunci, isian, galat }: { label: string; blob: Blob | null; onAmbil: (b: Blob) => void; kunci?: string; isian: KunciLayar; galat?: string }) {
    const [buka, setBuka] = useState(false);
    const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
    const nama = label.charAt(0).toLowerCase() + label.slice(1); // "foto toko", "foto KTP"
    const galatId = useId();
    useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
    return (
        <div className="grid gap-2">
            <span className="fi-label">{label}<span className="fi-req" aria-hidden>*</span></span>
            {url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`Pratinjau ${nama}`} style={{ width: "100%", maxHeight: "10rem", objectFit: "cover", borderRadius: "var(--r-md)" }} />
            )}
            <div className="fi-btnrow">
                <Button icon={<Camera className="fi-icon" aria-hidden />} disabled={Boolean(kunci)} disabledReason={kunci} onClick={() => setBuka(true)} data-isian={isian}
                    aria-describedby={galat ? galatId : undefined} aria-invalid={galat ? true : undefined}>
                    {blob ? `Ambil ulang ${nama}` : `Ambil ${nama}`}
                </Button>
            </div>
            {galat && <p className="fi-msg" id={galatId}>{galat}</p>}
            <CameraCapture open={buka} judul={label} onClose={() => setBuka(false)} onCapture={async (b) => { onAmbil(await kecilkan(b)); }} />
        </div>
    );
}

type Props = { salesCode: string; principle: string; onDiajukan: () => void; kunci?: string };

export function TambahNoo({ salesCode, principle, onDiajukan, kunci }: Props) {
    const [buka, setBuka] = useState(false);
    const [isi, setIsi] = useState<Teks>(KOSONG);
    const [fotoToko, setFotoToko] = useState<Blob | null>(null);
    const [fotoKtp, setFotoKtp] = useState<Blob | null>(null);
    const [lokasi, setLokasi] = useState<GeoCoords | null>(null);
    const [galatLokasi, setGalatLokasi] = useState<GalatLokasi | null>(null);
    const [mencariLokasi, setMencariLokasi] = useState(false);
    const [id, setId] = useState(() => crypto.randomUUID());
    const [sibuk, setSibuk] = useState(false);
    const [galat, setGalat] = useState("");
    const [pembanding, setPembanding] = useState<Pembanding[] | null>(null);
    const [pemilikSama, setPemilikSama] = useState(false);
    const [alasanDuplikat, setAlasanDuplikat] = useState("");
    const [sukses, setSukses] = useState("");
    // Batal pada formulir terisi minta konfirmasi lewat dialog yang sama dengan penjaga pindah halaman.
    const [buangMinta, setBuangMinta] = useState(false);
    const [disentuh, setDisentuh] = useState<ReadonlySet<KunciLayar>>(new Set());
    const formRef = useRef<HTMLFormElement>(null);
    const idForm = useId();
    const kotor = buka && (Object.values(isi).some(Boolean) || Boolean(fotoToko || fotoKtp || lokasi));
    const jaga = useJagaPindah(kotor);
    useUnsavedGuard(kotor && !jaga.meninggalkan);
    const sentuh = (...k: KunciLayar[]) => setDisentuh((p) => (k.every((x) => p.has(x)) ? p : new Set([...p, ...k])));

    const ubah = (k: keyof Teks) => (e: { target: { value: string } }) => {
        setIsi((p) => ({ ...p, [k]: e.target.value }));
        setGalat("");
        // NIK/HP diubah = pembanding duplikat lama tidak berlaku lagi (server memeriksa ulang saat dikirim).
        if (k === "nik" || k === "noHp") { setPembanding(null); setPemilikSama(false); }
    };
    const cek = galatIsianNoo((k) => ({ ...isi, lat: lokasi ? String(lokasi.lat) : "", lng: lokasi ? String(lokasi.lng) : "",
        akurasi: lokasi ? String(Math.max(0, lokasi.accuracy)) : "" } as Record<string, string>)[k]);
    const galatLayar: Partial<Record<KunciLayar, string>> = {
        ...Object.fromEntries(Object.entries(cek.galat).map(([k, g]) => [k, g!.error])),
        ...(!fotoToko ? { fotoToko: "Ambil foto toko dulu." } : {}),
        ...(!fotoKtp ? { fotoKtp: "Ambil foto KTP dulu." } : {}),
    };
    const pertama = URUTAN_LAYAR.find((k) => galatLayar[k]);
    // Galat di bawah isian hanya sesudah isian itu disentuh (keluar dari isian / ambil foto / ambil lokasi) atau "Ke isian" diketuk.
    const galatDi = (k: KunciLayar) => (disentuh.has(k) ? galatLayar[k] : undefined);
    const alasan = kunci ?? (pertama ? galatLayar[pertama]
        : pembanding && !pemilikSama ? "NIK/No. HP sama dengan NOO lain. Perbaiki isian, atau ajukan sebagai pemilik sama."
            : pemilikSama && alasanDuplikat.trim().length < 10 ? "Tulis alasan pemilik sama untuk SPV (minimal 10 huruf)" : undefined);
    /** Tampilkan SEMUA galat isian lalu fokus ke isian salah paling atas. */
    function keIsian() {
        sentuh(...URUTAN_LAYAR);
        // Sesudah render galat (dan sesudah peramban sentuh memindah fokus ke tombol yang diketuk) — fokus pindah ke isian salah paling atas.
        const el = pertama ? formRef.current?.querySelector<HTMLElement>(`[data-isian="${pertama}"]`) : null;
        if (el) setTimeout(() => el.focus(), 0);
    }

    async function ambilGps() {
        setMencariLokasi(true);
        setGalatLokasi(null);
        const r = await ambilLokasi();
        setMencariLokasi(false);
        sentuh("gps");
        if ("galat" in r) { setLokasi(null); setGalatLokasi(r.galat); } else setLokasi(r.coords);
    }

    function tutup(reset: boolean) {
        setBuka(false);
        if (!reset) return;
        setIsi(KOSONG); setFotoToko(null); setFotoKtp(null); setLokasi(null); setGalatLokasi(null); setGalat("");
        setPembanding(null); setPemilikSama(false); setAlasanDuplikat(""); setDisentuh(new Set()); setId(crypto.randomUUID());
    }

    async function kirim() {
        if (pertama && !kunci) { keIsian(); return; }
        if (alasan || sibuk || !fotoToko || !fotoKtp || !lokasi) return;
        setSibuk(true);
        setGalat("");
        const f = new FormData();
        f.set("id", id); f.set("salesCode", salesCode); f.set("principle", principle);
        for (const [k, v] of Object.entries(isi)) f.set(k, v);
        f.set("lat", String(lokasi.lat)); f.set("lng", String(lokasi.lng)); f.set("akurasi", String(Math.max(0, lokasi.accuracy)));
        f.set("fotoToko", new File([fotoToko], "toko.jpg", { type: fotoToko.type || "image/jpeg" }));
        f.set("fotoKtp", new File([fotoKtp], "ktp.jpg", { type: fotoKtp.type || "image/jpeg" }));
        if (pemilikSama) { f.set("pemilikSama", "ya"); f.set("alasanDuplikat", alasanDuplikat); }
        try {
            const j = await ambilJson("/api/form-kontrol/noo", { method: "POST", body: f });
            const d = j.data;
            if (j.status >= 200 && j.status < 300 && d?.row) {
                const row = d.row as { kode: string; namaToko: string };
                setSukses(`${row.namaToko} diajukan sebagai toko baru ${row.kode} dan masuk kunjungan hari ini (bertanda NOO). Menunggu persetujuan SPV; order bisa sesudah toko terdaftar di Accurate.`);
                tutup(true);
                onDiajukan();
                return;
            }
            if (j.status === 0 || j.status >= 502 || !d) {
                setGalat(`${j.status === 0 ? PESAN_SINYAL : "Server tidak memberi jawaban yang pasti."} Pengajuan belum dipastikan tersimpan; kirim lagi. Mengulang aman: pengajuan yang sama tidak menjadi dua.`);
                return;
            }
            if (d.kode === "NOO_DUPLIKAT" && Array.isArray(d.pembanding)) setPembanding(d.pembanding as Pembanding[]);
            setGalat(typeof d.kode === "string" && typeof d.error === "string" ? d.error : sebabGagal(j.status));
        } finally { setSibuk(false); }
    }

    return (
        <Section title="Toko baru (NOO)" subtitle="belum ada di Accurate">
            <div className="fi-sect-in">
                <p className="fi-small fi-muted">
                    Toko yang belum terdaftar sebagai pelanggan Accurate: isi data toko, pemilik, dan KTP. Toko masuk kunjungan hari ini bertanda NOO
                    (tanpa order); SPV menyetujui, lalu Admin mendaftarkannya di Accurate.
                </p>
                {sukses && <MessageStrip tone="pos" onClose={() => setSukses("")}>{sukses}</MessageStrip>}
                {!buka ? (
                    <div className="fi-btnrow">
                        <Button icon={<Store className="fi-icon" aria-hidden />} disabled={Boolean(kunci)} disabledReason={kunci}
                            onClick={() => { setBuka(true); setSukses(""); }}>Tambah toko baru</Button>
                        {kunci && <span className="fi-small fi-why">{kunci}</span>}
                    </div>
                ) : (
                    <form ref={formRef} className="grid gap-3" aria-label="Formulir toko baru" noValidate onSubmit={(e) => { e.preventDefault(); void kirim(); }}>
                        <FormField label="Nama toko" required error={galatDi("namaToko")}>{(a) => <input {...a} data-isian="namaToko" className="fi-input" value={isi.namaToko} maxLength={120} autoComplete="off" onChange={ubah("namaToko")} onBlur={() => sentuh("namaToko")} />}</FormField>
                        <FormField label="Nama pemilik" required error={galatDi("namaPemilik")}>{(a) => <input {...a} data-isian="namaPemilik" className="fi-input" value={isi.namaPemilik} maxLength={120} autoComplete="off" onChange={ubah("namaPemilik")} onBlur={() => sentuh("namaPemilik")} />}</FormField>
                        <FormField label="Alamat toko" required error={galatDi("alamat")}>{(a) => <textarea {...a} data-isian="alamat" className="fi-input" rows={2} value={isi.alamat} maxLength={300} onChange={ubah("alamat")} onBlur={() => sentuh("alamat")} />}</FormField>
                        <FormField label="No. HP pemilik" required help="Nomor seluler, mis. 0812… atau +62812…" error={galatDi("noHp")}>
                            {(a) => <input {...a} data-isian="noHp" className="fi-input fi-mono" type="tel" inputMode="tel" autoComplete="off" value={isi.noHp} maxLength={20} onChange={ubah("noHp")} onBlur={() => sentuh("noHp")} />}
                        </FormField>
                        <FotoSlot label="Foto toko" isian="fotoToko" galat={galatDi("fotoToko")} blob={fotoToko} onAmbil={(b) => { setFotoToko(b); setGalat(""); sentuh("fotoToko"); }} kunci={sibuk ? "Sedang mengirim" : undefined} />
                        <div className="grid gap-2">
                            <span className="fi-label">Lokasi GPS toko<span className="fi-req" aria-hidden>*</span></span>
                            {lokasi && (
                                <p className="fi-small fi-tnum" role="status">
                                    {lokasi.lat.toFixed(6)}, {lokasi.lng.toFixed(6)} · akurasi ± {Math.round(lokasi.accuracy)} m
                                    {lokasi.accuracy > 1000 && ". Akurasi rendah, tetap tercatat dan ditandai untuk SPV."}
                                </p>
                            )}
                            {galatLokasi && <MessageStrip tone="neg" title="Lokasi wajib.">{PESAN_LOKASI[galatLokasi]}</MessageStrip>}
                            {!galatLokasi && galatDi("gps") && <p className="fi-msg" id={`${idForm}-gps`}>{galatDi("gps")}</p>}
                            <div className="fi-btnrow">
                                <Button icon={<LocateFixed className="fi-icon" aria-hidden />} busy={mencariLokasi} disabled={sibuk} onClick={() => void ambilGps()} data-isian="gps"
                                    aria-describedby={!galatLokasi && galatDi("gps") ? `${idForm}-gps` : undefined} aria-invalid={galatDi("gps") ? true : undefined}>
                                    {lokasi ? "Ambil lokasi lagi" : "Ambil lokasi"}
                                </Button>
                            </div>
                        </div>
                        <fieldset className="grid gap-3" style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 12 }}>
                            <legend className="fi-label" style={{ padding: "0 4px" }}>KTP pemilik (data pribadi)</legend>
                            <p className="fi-small fi-muted">Hanya SPV/SM tim dan Admin yang bisa membuka KTP lengkap; setiap pembukaan tercatat.</p>
                            <FormField label="NIK (16 angka)" required error={galatDi("nik")}>
                                {(a) => <input {...a} data-isian="nik" className="fi-input fi-mono" inputMode="numeric" autoComplete="off" value={isi.nik} maxLength={19} onChange={ubah("nik")} onBlur={() => sentuh("nik")} />}
                            </FormField>
                            <FormField label="Nama sesuai KTP" required error={galatDi("namaKtp")}>{(a) => <input {...a} data-isian="namaKtp" className="fi-input" value={isi.namaKtp} maxLength={120} autoComplete="off" onChange={ubah("namaKtp")} onBlur={() => sentuh("namaKtp")} />}</FormField>
                            <FotoSlot label="Foto KTP" isian="fotoKtp" galat={galatDi("fotoKtp")} blob={fotoKtp} onAmbil={(b) => { setFotoKtp(b); setGalat(""); sentuh("fotoKtp"); }} kunci={sibuk ? "Sedang mengirim" : undefined} />
                        </fieldset>
                        {pembanding && (
                            <MessageStrip tone="warn" title="NIK atau No. HP sudah dipakai NOO lain.">
                                <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                                    {pembanding.map((p) => <li key={p.kode}><span className="fi-mono">{p.kode}</span> {p.namaToko} · {p.cocok.join(" & ")} sama</li>)}
                                </ul>
                                Perbaiki isian bila salah ketik. Bila pemiliknya memang sama (toko lain), ajukan sebagai permintaan konfirmasi SPV.
                            </MessageStrip>
                        )}
                        {pembanding && (
                            <label className="flex items-start gap-2" style={{ minHeight: 44 }}>
                                <input type="checkbox" checked={pemilikSama} onChange={(e) => setPemilikSama(e.target.checked)} style={{ width: 22, height: 22, marginTop: 2 }} />
                                <span>Minta konfirmasi SPV: pemilik sama</span>
                            </label>
                        )}
                        {pemilikSama && (
                            <FormField label="Alasan untuk SPV" required help="Minimal 10 huruf, mis. pemilik membuka toko kedua.">
                                {(a) => <textarea {...a} className="fi-input" rows={2} maxLength={500} value={alasanDuplikat} onChange={(e) => setAlasanDuplikat(e.target.value)} />}
                            </FormField>
                        )}
                        {galat && <MessageStrip tone="neg" title="Belum diajukan.">{galat}</MessageStrip>}
                        <div className="fi-btnrow">
                            <Button type="submit" variant="primary" busy={sibuk} disabled={Boolean(alasan)} disabledReason={alasan}>Ajukan toko baru</Button>
                            <Button variant="tertiary" disabled={sibuk} onClick={() => (kotor ? setBuangMinta(true) : tutup(true))}>Batal</Button>
                        </div>
                        {/* Wilayah live SELALU terpasang (pembaca layar mengumumkan perubahan galat pertama, bukan hanya saat fokus). */}
                        <div aria-live="polite" data-uji="galat-live">
                            {alasan && !kunci && (
                                <p className="fi-small fi-why">
                                    {alasan}{" "}
                                    {/* mousedown tidak memindah fokus: blur isian yang sedang diisi akan memunculkan galatnya dan menggeser tombol ini sebelum klik selesai. */}
                                    {pertama && <button type="button" className="fi-btn fi-btn--tertiary" onMouseDown={(e) => e.preventDefault()} onClick={keIsian}>Ke isian yang belum benar</button>}
                                </p>
                            )}
                        </div>
                    </form>
                )}
                <ConfirmDialog open={jaga.tujuan !== null || buangMinta} onClose={buangMinta ? () => setBuangMinta(false) : jaga.tetap} title="Buang isian toko baru?" tone="negative"
                    description={`Isian, foto toko, foto KTP, dan lokasi belum diajukan. ${buangMinta ? "Bila dibuang" : "Bila pindah halaman"}, semuanya hilang dan harus diambil ulang.`}
                    confirmLabel={buangMinta ? "Buang isian" : "Buang isian dan pindah"} cancelLabel="Tetap di sini"
                    onConfirm={buangMinta ? () => { setBuangMinta(false); tutup(true); } : jaga.pindah} />
            </div>
        </Section>
    );
}
