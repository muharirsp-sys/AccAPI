/*
 * Tujuan: Formulir NOO salesman (toko baru yang BELUM ada di Accurate, owner 13 Okt 2026) di Rute hari ini, 390 px dulu: nama toko, pemilik,
 *   alamat, No. HP pemilik, foto toko, lokasi GPS (wajib; izin ditolak = cara menyalakan), KTP (foto + NIK 16 angka + nama sesuai KTP) →
 *   kunjungan hari ini bertanda NOO, menunggu persetujuan SPV. NIK/HP sama dengan NOO lain → 409 dengan pembanding; salesman hanya bisa
 *   mengajukan ulang sebagai "minta konfirmasi SPV: pemilik sama" + alasan.
 * Caller: ./TabAo.tsx (TambahNoo, di bawah Kunjungan luar rute).
 * Dependensi: POST /api/form-kontrol/noo (multipart), components/form-kontrol/camera-capture, lib/form-kontrol/location (ambilLokasi),
 *   lib/form-kontrol/noo-aturan (periksaIsianNoo), ../lapangan (ambilJson, PESAN_SINYAL, sebabGagal), components/fiori/*.
 * Main Functions: TambahNoo.
 * Side Effects: kamera + izin lokasi peramban; HTTP POST multipart. id pengajuan (UUID) dibuat sekali per isian → kirim ulang sesudah jawaban
 *   tidak pasti = baris yang sama di server. Foto diperkecil di ponsel (≤ 1600 px JPEG) sebelum dikirim. Isian hanya di memori layar ini.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Camera, LocateFixed, Store } from "lucide-react";
import { Button, MessageStrip, Section } from "@/components/fiori/core";
import { FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import CameraCapture from "@/components/form-kontrol/camera-capture";
import { ambilLokasi, type GalatLokasi, type GeoCoords } from "@/lib/form-kontrol/location";
import { periksaIsianNoo } from "@/lib/form-kontrol/noo-aturan";
import { PESAN_SINYAL, ambilJson, sebabGagal } from "../lapangan";

type Teks = { namaToko: string; namaPemilik: string; alamat: string; noHp: string; nik: string; namaKtp: string };
const KOSONG: Teks = { namaToko: "", namaPemilik: "", alamat: "", noHp: "", nik: "", namaKtp: "" };
type Pembanding = { kode: string; namaToko: string; status: string; cocok: string[] };

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

function FotoSlot({ label, blob, onAmbil, kunci }: { label: string; blob: Blob | null; onAmbil: (b: Blob) => void; kunci?: string }) {
    const [buka, setBuka] = useState(false);
    const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
    useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
    return (
        <div className="grid gap-2">
            <span className="fi-label">{label}<span className="fi-req" aria-hidden>*</span></span>
            {url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`Pratinjau ${label.toLowerCase()}`} style={{ width: "100%", maxHeight: "10rem", objectFit: "cover", borderRadius: "var(--r-md)" }} />
            )}
            <div className="fi-btnrow">
                <Button icon={<Camera className="fi-icon" aria-hidden />} disabled={Boolean(kunci)} disabledReason={kunci} onClick={() => setBuka(true)}>
                    {blob ? `Ambil ulang ${label.toLowerCase()}` : `Ambil ${label.toLowerCase()}`}
                </Button>
            </div>
            <CameraCapture open={buka} onClose={() => setBuka(false)} onCapture={async (b) => { onAmbil(await kecilkan(b)); }} />
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
    const kotor = buka && (Object.values(isi).some(Boolean) || Boolean(fotoToko || fotoKtp));
    useUnsavedGuard(kotor);

    const ubah = (k: keyof Teks) => (e: { target: { value: string } }) => {
        setIsi((p) => ({ ...p, [k]: e.target.value }));
        setGalat("");
        // NIK/HP diubah = pembanding duplikat lama tidak berlaku lagi (server memeriksa ulang saat dikirim).
        if (k === "nik" || k === "noHp") { setPembanding(null); setPemilikSama(false); }
    };
    const cek = periksaIsianNoo((k) => ({ ...isi, lat: lokasi ? String(lokasi.lat) : "", lng: lokasi ? String(lokasi.lng) : "",
        akurasi: lokasi ? String(Math.max(0, lokasi.accuracy)) : "" } as Record<string, string>)[k]);
    const alasan = kunci ?? ("galat" in cek ? cek.galat.error : !fotoToko ? "Ambil foto toko dulu" : !fotoKtp ? "Ambil foto KTP dulu"
        : pembanding && !pemilikSama ? "NIK/No. HP sama dengan NOO lain — perbaiki isian, atau ajukan sebagai pemilik sama"
            : pemilikSama && alasanDuplikat.trim().length < 10 ? "Tulis alasan pemilik sama untuk SPV (minimal 10 huruf)" : undefined);

    async function ambilGps() {
        setMencariLokasi(true);
        setGalatLokasi(null);
        const r = await ambilLokasi();
        setMencariLokasi(false);
        if ("galat" in r) { setLokasi(null); setGalatLokasi(r.galat); } else setLokasi(r.coords);
    }

    function tutup(reset: boolean) {
        setBuka(false);
        if (!reset) return;
        setIsi(KOSONG); setFotoToko(null); setFotoKtp(null); setLokasi(null); setGalatLokasi(null); setGalat("");
        setPembanding(null); setPemilikSama(false); setAlasanDuplikat(""); setId(crypto.randomUUID());
    }

    async function kirim() {
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
                setGalat(`${j.status === 0 ? PESAN_SINYAL : "Server tidak memberi jawaban yang pasti."} Pengajuan belum dipastikan tersimpan; kirim lagi — mengulang aman (pengajuan yang sama tidak menjadi dua).`);
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
                            onClick={() => { setBuka(true); setSukses(""); }}>Toko baru (belum ada di Accurate)</Button>
                        {kunci && <span className="fi-small fi-why">{kunci}</span>}
                    </div>
                ) : (
                    <form className="grid gap-3" aria-label="Formulir toko baru" onSubmit={(e) => { e.preventDefault(); void kirim(); }}>
                        <FormField label="Nama toko" required>{(a) => <input {...a} className="fi-input" value={isi.namaToko} maxLength={120} autoComplete="off" onChange={ubah("namaToko")} />}</FormField>
                        <FormField label="Nama pemilik" required>{(a) => <input {...a} className="fi-input" value={isi.namaPemilik} maxLength={120} autoComplete="off" onChange={ubah("namaPemilik")} />}</FormField>
                        <FormField label="Alamat toko" required>{(a) => <textarea {...a} className="fi-input" rows={2} value={isi.alamat} maxLength={300} onChange={ubah("alamat")} />}</FormField>
                        <FormField label="No. HP pemilik" required help="Nomor seluler, mis. 0812… atau +62812…">
                            {(a) => <input {...a} className="fi-input fi-mono" type="tel" inputMode="tel" autoComplete="off" value={isi.noHp} maxLength={20} onChange={ubah("noHp")} />}
                        </FormField>
                        <FotoSlot label="Foto toko" blob={fotoToko} onAmbil={(b) => { setFotoToko(b); setGalat(""); }} kunci={sibuk ? "Sedang mengirim" : undefined} />
                        <div className="grid gap-2">
                            <span className="fi-label">Lokasi GPS toko<span className="fi-req" aria-hidden>*</span></span>
                            {lokasi && (
                                <p className="fi-small fi-tnum" role="status">
                                    {lokasi.lat.toFixed(6)}, {lokasi.lng.toFixed(6)} · akurasi ± {Math.round(lokasi.accuracy)} m
                                    {lokasi.accuracy > 1000 && " — akurasi rendah, tetap tercatat dan ditandai untuk SPV"}
                                </p>
                            )}
                            {galatLokasi && <MessageStrip tone="neg" title="Lokasi wajib.">{PESAN_LOKASI[galatLokasi]}</MessageStrip>}
                            <div className="fi-btnrow">
                                <Button icon={<LocateFixed className="fi-icon" aria-hidden />} busy={mencariLokasi} disabled={sibuk} onClick={() => void ambilGps()}>
                                    {lokasi ? "Ambil lokasi lagi" : "Ambil lokasi"}
                                </Button>
                            </div>
                        </div>
                        <fieldset className="grid gap-3" style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 12 }}>
                            <legend className="fi-label" style={{ padding: "0 4px" }}>KTP pemilik (data pribadi)</legend>
                            <p className="fi-small fi-muted">Hanya SPV tim dan Admin yang bisa membuka KTP lengkap; setiap pembukaan tercatat.</p>
                            <FormField label="NIK (16 angka)" required>
                                {(a) => <input {...a} className="fi-input fi-mono" inputMode="numeric" autoComplete="off" value={isi.nik} maxLength={19} onChange={ubah("nik")} />}
                            </FormField>
                            <FormField label="Nama sesuai KTP" required>{(a) => <input {...a} className="fi-input" value={isi.namaKtp} maxLength={120} autoComplete="off" onChange={ubah("namaKtp")} />}</FormField>
                            <FotoSlot label="Foto KTP" blob={fotoKtp} onAmbil={(b) => { setFotoKtp(b); setGalat(""); }} kunci={sibuk ? "Sedang mengirim" : undefined} />
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
                            <Button variant="tertiary" disabled={sibuk} onClick={() => tutup(true)}>Batal</Button>
                        </div>
                        {alasan && !kunci && <p className="fi-small fi-why">{alasan}</p>}
                    </form>
                )}
            </div>
        </Section>
    );
}
