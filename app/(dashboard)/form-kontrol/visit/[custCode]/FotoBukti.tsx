/*
 * Tujuan: Satu slot foto bukti kunjungan (check-in, butir merchandising, check-out) untuk wizard Kunjungan (Fiori S5, it05 #9):
 *   ambil foto → unggah → simpan lewat pemanggil; bila gagal (tanpa sinyal/server), foto TETAP di layar dengan Coba lagi dan Ambil ulang.
 * Caller: ./Kunjungan.tsx.
 * Dependensi: components/form-kontrol/camera-capture (kamera), lib/form-kontrol/location (GPS), ../../lapangan (kirimFk, GagalKirim),
 *   components/fiori/*.
 * Main Functions: FotoBukti.
 * Side Effects: kamera + izin lokasi; POST /api/upload/form-kontrol (FormData sama dengan kode lama: file, salesName, custName, lat, lng);
 *   object URL pratinjau (dicabut setelah tersimpan); beforeunload selama foto belum tersimpan.
 *
 * Mode luring tidak dibuat (P1): foto hanya bertahan selama layar ini terbuka.
 */
"use client";

import { useState } from "react";
import { Camera, RefreshCw } from "lucide-react";
import { Button, MessageStrip, StatusBadge } from "@/components/fiori/core";
import { useUnsavedGuard } from "@/components/fiori/interactive";
import CameraCapture from "@/components/form-kontrol/camera-capture";
import { getCurrentCoords, type GeoCoords } from "@/lib/form-kontrol/location";
import { GagalKirim, PESAN_SINYAL, kirimFk } from "../../lapangan";

type Tunda = { blob: Blob; preview: string; coords?: GeoCoords | null; url?: string };

type Props = {
    /** Label tombol ambil foto, mis. "Ambil foto check-in". */
    label: string;
    /** Judul galat, mis. "Foto check-in belum terkirim." */
    judulGagal: string;
    /** Akibat bila gagal, mis. "Langkah ini belum maju." */
    akibat: string;
    existingUrl?: string | null;
    salesName?: string;
    custName?: string;
    /** Menyimpan url foto (mis. POST check-in). Melempar bila gagal; foto tetap tertunda untuk Coba lagi. */
    onPersist: (url: string, coords: GeoCoords | null) => Promise<void>;
    disabledReason?: string;
    kecil?: boolean;
};

function pesanGagal(e: unknown): string {
    if (e instanceof GagalKirim && e.tidakPasti && e.status === 0) return PESAN_SINYAL;
    if (e instanceof GagalKirim && !e.tidakPasti && e.status === 400) return "Foto ditolak server: bukan gambar atau lebih dari 5 MB. Ambil ulang foto.";
    return e instanceof Error ? e.message : "Foto belum tersimpan.";
}

export default function FotoBukti({ label, judulGagal, akibat, existingUrl, salesName, custName, onPersist, disabledReason, kecil }: Props) {
    const [kamera, setKamera] = useState(false);
    const [tunda, setTunda] = useState<Tunda | null>(null);
    const [status, setStatus] = useState<"kirim" | "galat" | null>(null);
    const [pesan, setPesan] = useState("");
    useUnsavedGuard(tunda !== null);

    async function kirim(t: Tunda) {
        setStatus("kirim");
        setPesan("");
        let { coords, url } = t;
        try {
            // ponytail: GPS diambil bersamaan dengan foto — di-stamp server + di-FLAG bila mencurigakan (kode lama).
            if (coords === undefined) coords = await getCurrentCoords();
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
            await onPersist(url, coords);
            URL.revokeObjectURL(t.preview);
            setTunda(null);
            setStatus(null);
        } catch (e) {
            // Foto, lokasi, dan url unggahan (bila sudah ada) disimpan supaya Coba lagi tidak mengunggah/menanyakan GPS ulang.
            setTunda({ ...t, coords, url });
            setStatus("galat");
            setPesan(pesanGagal(e));
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
            disabled={Boolean(disabledReason) || sibuk} disabledReason={disabledReason} onClick={() => setKamera(true)}>
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
                    {pesan} Foto tetap di layar ini; tekan Coba lagi saat ada sinyal. {akibat}
                </MessageStrip>
            )}
            <div className="fi-btnrow">
                {status === "galat" && tunda && (
                    <Button variant="primary" icon={<RefreshCw className="fi-icon" aria-hidden />} disabled={Boolean(disabledReason)} disabledReason={disabledReason}
                        onClick={() => void kirim(tunda)}>Coba lagi</Button>
                )}
                {tombolAmbil}
            </div>
            {!kecil && <p className="fi-small fi-subtle">Foto langsung dari kamera · lokasi dan waktu tercatat otomatis.</p>}
            <CameraCapture open={kamera} onClose={() => setKamera(false)} onCapture={async (blob) => ambil(blob)} />
        </div>
    );
}
