/*
 * Tujuan: Satu slot foto bukti kunjungan (check-in, butir merchandising, check-out) untuk wizard Kunjungan (Fiori S5, it05 #9):
 *   ambil foto → unggah → simpan lewat pemanggil; bila gagal (tanpa sinyal/server), foto TETAP di layar dengan Coba lagi dan Ambil ulang.
 * Caller: ./Kunjungan.tsx.
 * Dependensi: components/form-kontrol/camera-capture (kamera), lib/form-kontrol/location (GPS), ../../lapangan (kirimFk, GagalKirim),
 *   components/fiori/*. `butir` (nama butir merchandising) dipakai sebagai nama aksesibel tombol supaya enam tombol "Foto" tidak kembar.
 * Main Functions: FotoBukti.
 * Side Effects: kamera + izin lokasi; POST /api/upload/form-kontrol (FormData sama dengan kode lama: file, salesName, custName, lat, lng);
 *   object URL pratinjau (dicabut setelah tersimpan); beforeunload selama foto belum tersimpan.
 *
 * Mode luring tidak dibuat (P1): foto hanya bertahan selama layar ini terbuka.
 * Owner 14 Nov 2026: `wajibLokasi` (check-in & check-out) — lokasi dibaca SEBELUM unggah lewat ambilLokasi; GPS mati/ditolak = foto tetap di
 *   layar dengan kalimat cara menyalakan GPS (PESAN_GPS_KUNJUNGAN) + Coba lagi (membaca lokasi ulang), tidak ada unggahan/tulis tanpa titik.
 *   Radius titik toko (fix 20 m / validasi 100 m): server menjawab 409 DI_LUAR_RADIUS (kalimat berisi jarak) -> Coba lagi membaca GPS ulang, atau
 *   salesman menulis alasan dan "Ajukan ke IT & lanjutkan" (onPersist dengan alasan; kunjungan tersimpan bertanda menunggu persetujuan IT).
 */
"use client";

import { useState } from "react";
import { Camera, RefreshCw, Send } from "lucide-react";
import { Button, MessageStrip, StatusBadge } from "@/components/fiori/core";
import { FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import { MAKS_ALASAN, MIN_ALASAN } from "@/lib/form-kontrol/radius";
import CameraCapture from "@/components/form-kontrol/camera-capture";
import { PESAN_GPS_KUNJUNGAN, ambilLokasiKunjungan, getCurrentCoords, type GeoCoords } from "@/lib/form-kontrol/location";
import { GagalKirim, PESAN_SINYAL, kirimFk } from "../../lapangan";

/** `alasan` = alasan ajuan IT yang belum dipastikan terkirim (jaringan putus) — Coba lagi mengirimnya lagi. */
type Tunda = { blob: Blob; preview: string; coords?: GeoCoords | null; url?: string; alasan?: string };

type Props = {
    /** Label tombol ambil foto, mis. "Ambil foto check-in". */
    label: string;
    /** Judul galat, mis. "Foto check-in belum terkirim." */
    judulGagal: string;
    /** Akibat bila gagal, mis. "Langkah ini belum maju." */
    akibat: string;
    existingUrl?: string | null;
    /** Nama butir yang difoto (mis. "Produk terlihat jelas"); masuk ke nama aksesibel tombol ambil foto. */
    butir?: string;
    salesName?: string;
    custName?: string;
    /**
     * Menyimpan url foto (mis. POST check-in). Melempar bila gagal; foto tetap tertunda untuk Coba lagi. `alasan` = alasan pengajuan ke IT bila
     * lokasi di luar radius titik toko (hanya terkirim lewat tombol Ajukan ke IT).
     */
    onPersist: (url: string, coords: GeoCoords | null, alasan?: string) => Promise<void>;
    disabledReason?: string;
    kecil?: boolean;
    /** GPS wajib (check-in/check-out): tanpa lokasi tidak ada unggahan maupun tulis. */
    wajibLokasi?: boolean;
};

/** Lokasi wajib belum terbaca: kalimatnya sudah memuat cara menyalakan GPS + Coba lagi. */
class TanpaLokasi extends Error {}

function pesanGagal(e: unknown): string {
    if (e instanceof TanpaLokasi) return e.message;
    if (e instanceof GagalKirim && e.tidakPasti && e.status === 0) return PESAN_SINYAL;
    // Penolakan GPS dari server (GPS_WAJIB / GPS_TIDAK_SAH) membawa kalimatnya sendiri — bukan "foto ditolak".
    if (e instanceof GagalKirim && (e.kode?.startsWith("GPS_") || e.kode === "DI_LUAR_RADIUS" || e.kode === "ALASAN_AJUAN_PENDEK")) return e.message;
    if (e instanceof GagalKirim && !e.tidakPasti && e.status === 400) return "Foto ditolak server: bukan gambar atau lebih dari 5 MB. Ambil ulang foto.";
    return e instanceof Error ? e.message : "Foto belum tersimpan.";
}

export default function FotoBukti({ label, judulGagal, akibat, existingUrl, butir, salesName, custName, onPersist, disabledReason, kecil, wajibLokasi }: Props) {
    const [kamera, setKamera] = useState(false);
    const [tunda, setTunda] = useState<Tunda | null>(null);
    const [status, setStatus] = useState<"kirim" | "galat" | null>(null);
    const [pesan, setPesan] = useState("");
    const [sebabLokasi, setSebabLokasi] = useState(false);
    const [luarRadius, setLuarRadius] = useState(false);
    const [alasan, setAlasan] = useState("");
    /** Panjang alasan dihitung seperti server (lib/form-kontrol/radius.ts alasanAjuanSah: spasi dirapikan). */
    const alasanRapi = alasan.replace(/\s+/g, " ").trim();
    useUnsavedGuard(tunda !== null);

    async function kirim(t: Tunda, ajuan?: string) {
        setStatus("kirim");
        setPesan("");
        setSebabLokasi(false);
        let { coords, url } = t;
        try {
            // ponytail: GPS diambil bersamaan dengan foto; server men-stamp dan menandai (FLAG) bila mencurigakan (kode lama).
            if (coords === undefined || (wajibLokasi && !coords)) {
                if (wajibLokasi) {
                    const h = await ambilLokasiKunjungan();
                    if ("galat" in h) { coords = undefined; throw new TanpaLokasi(PESAN_GPS_KUNJUNGAN[h.galat]); }
                    coords = h.coords;
                } else coords = await getCurrentCoords();
            }
            if (!url) {
                const fd = new FormData();
                fd.append("file", new File([t.blob], "kunjungan.jpg", { type: "image/jpeg" }));
                if (salesName) fd.append("salesName", salesName);
                if (custName) fd.append("custName", custName);
                if (coords) {
                    fd.append("lat", String(coords.lat));
                    fd.append("lng", String(coords.lng));
                }
                const d = await kirimFk("/api/upload/form-kontrol", fd);
                url = typeof d.url === "string" ? d.url : "";
                if (!url) throw new GagalKirim("Server tidak mengembalikan alamat foto.", true);
            }
            await onPersist(url, coords, ajuan);
            URL.revokeObjectURL(t.preview);
            setTunda(null);
            setStatus(null);
            setLuarRadius(false);
            setAlasan("");
        } catch (e) {
            // Foto, lokasi, dan url unggahan (bila sudah ada) disimpan supaya Coba lagi tidak mengunggah/menanyakan GPS ulang — KECUALI server
            // menolak titiknya (GPS_*): Coba lagi membaca lokasi ulang.
            const gpsDitolak = e instanceof GagalKirim && Boolean(e.kode?.startsWith("GPS_"));
            // Di luar radius: Coba lagi membaca GPS ulang (salesman mendekat ke toko); titik ini tetap dipakai bila salesman mengajukan ke IT.
            const radius = e instanceof GagalKirim && (e.kode === "DI_LUAR_RADIUS" || e.kode === "ALASAN_AJUAN_PENDEK");
            setTunda({ ...t, coords: gpsDitolak ? undefined : coords, url, alasan: radius ? undefined : ajuan });
            setStatus("galat");
            setPesan(pesanGagal(e));
            setSebabLokasi(e instanceof TanpaLokasi || gpsDitolak || radius);
            setLuarRadius(radius);
        }
    }

    function ambil(blob: Blob) {
        if (tunda) URL.revokeObjectURL(tunda.preview);
        const t: Tunda = { blob, preview: URL.createObjectURL(blob) };
        setTunda(t);
        setKamera(false);
        void kirim(t);
    }

    const sibuk = status === "kirim";
    const gambar = tunda?.preview ?? existingUrl ?? null;
    const tombolAmbil = (
        <Button variant={existingUrl || tunda ? (kecil ? "secondary" : "tertiary") : kecil ? "secondary" : "primary"} icon={<Camera className="fi-icon" aria-hidden />}
            disabled={Boolean(disabledReason) || sibuk} disabledReason={disabledReason} onClick={() => setKamera(true)}
            aria-label={butir ? `${tunda ? "Ambil ulang foto" : existingUrl ? "Ganti foto" : "Foto"} bukti: ${butir}` : undefined}>
            {tunda ? "Ambil ulang" : existingUrl ? "Ganti foto" : label}
        </Button>
    );

    return (
        <div className="grid gap-2" style={{ minWidth: 0 }}>
            {gambar && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={gambar} alt={tunda ? "Foto yang belum terkirim" : "Foto tersimpan"}
                    style={kecil
                        ? { width: 44, height: 44, objectFit: "cover", borderRadius: "var(--r-sm)" }
                        : { width: "100%", maxHeight: "12rem", objectFit: "cover", borderRadius: "var(--r-md)", boxShadow: "var(--shadow-1)" }} />
            )}
            {sibuk && <StatusBadge tone="info" busy>Mengunggah foto…</StatusBadge>}
            {status === "galat" && (
                <MessageStrip tone="neg" title={judulGagal}>
                    {pesan} {sebabLokasi ? "Foto tetap di layar ini." : "Foto tetap di layar ini; tekan Coba lagi saat ada sinyal."} {akibat}
                </MessageStrip>
            )}
            {luarRadius && tunda && status !== "kirim" && (
                <div className="fi-panel grid gap-2">
                    <FormField label="Alasan untuk IT (lokasi jauh dari titik toko)" required
                        help={`Minimal ${MIN_ALASAN} huruf, mis. "titik toko di peta salah, toko di belakang pasar". Kunjungan berlanjut; IT memeriksa lokasinya.`}>
                        {(a) => <textarea {...a} className="fi-input" rows={2} maxLength={MAKS_ALASAN} value={alasan} onChange={(ev) => setAlasan(ev.target.value)} />}
                    </FormField>
                    <div className="fi-btnrow">
                        <Button icon={<Send className="fi-icon" aria-hidden />} disabled={alasanRapi.length < MIN_ALASAN || Boolean(disabledReason)}
                            disabledReason={disabledReason ?? (alasanRapi.length < MIN_ALASAN ? `Tulis alasan minimal ${MIN_ALASAN} huruf` : undefined)}
                            onClick={() => void kirim(tunda, alasanRapi)}>Ajukan ke IT &amp; lanjutkan</Button>
                    </div>
                </div>
            )}
            <div className="fi-btnrow">
                {status === "galat" && tunda && (
                    <Button variant="primary" icon={<RefreshCw className="fi-icon" aria-hidden />} disabled={Boolean(disabledReason)} disabledReason={disabledReason}
                        onClick={() => void kirim(luarRadius ? { ...tunda, coords: undefined } : tunda, luarRadius ? undefined : tunda.alasan)}>Coba lagi</Button>
                )}
                {tombolAmbil}
            </div>
            {!kecil && disabledReason && <p className="fi-small fi-why">{disabledReason}</p>}
            {!kecil && <p className="fi-small fi-subtle">{wajibLokasi ? "Foto langsung dari kamera · GPS wajib menyala; lokasi dan waktu tercatat otomatis."
                : "Foto langsung dari kamera · lokasi dan waktu tercatat otomatis."}</p>}
            <CameraCapture open={kamera} onClose={() => setKamera(false)} onCapture={async (blob) => ambil(blob)} />
        </div>
    );
}
