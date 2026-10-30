/*
 * Tujuan: Modal kamera langsung untuk mengambil, meninjau, dan mempersistenkan foto bukti kunjungan sebelum ditutup.
 * Caller: app/(dashboard)/form-kontrol/visit/[custCode]/FotoBukti.tsx, app/(dashboard)/form-kontrol/tabs/NooFormulir.tsx (foto toko + KTP;
 *   `judul` sendiri, dengan id judul unik per instans; judul bawaan "Foto Bukti Kunjungan").
 * Dependensi: getUserMedia native browser, `Dialog` native bersama, lucide-react ikon, components/fiori/core (MessageStrip, tombol `fi-btn`).
 *   Dipakai di dalam `.fiori` (halaman Form Kontrol), jadi warna tombol dan galat mengikuti token; latar hitam layar kamera memang tetap hitam.
 * Main Functions: CameraCapture (default export).
 * Side Effects: Membuka stream kamera, membuat object URL pratinjau, menunggu callback persistence, dan menghentikan stream saat modal ditutup.
 */
"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Camera, X, RotateCcw, Check, Loader2, ImageUp, SwitchCamera } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import { MessageStrip } from "@/components/fiori/core";

/** Tombol bulat di atas latar hitam: permukaan token terang dengan tinta gelap, kontrasnya terjaga di mode terang maupun gelap. */
const BULAT: CSSProperties = { background: "var(--surface-3)", color: "var(--ink)" };
const PESAN_KAMERA = "Izin kamera ditolak atau kamera tidak ada. Izinkan kamera di pengaturan situs, atau ketuk Pilih Foto.";

export default function CameraCapture({ open, onClose, onCapture, judul = "Foto Bukti Kunjungan" }: {
    open: boolean;
    onClose: () => void;
    onCapture: (blob: Blob) => Promise<void>;
    judul?: string;
}) {
    const judulId = useId();
    const videoRef  = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const fileRef   = useRef<HTMLInputElement>(null);
    const [error, setError]     = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null); // object URL hasil capture
    const [blob, setBlob]       = useState<Blob | null>(null);
    const [starting, setStarting] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [facing, setFacing]   = useState<"environment" | "user">("environment"); // belakang default

    const stopStream = useCallback(() => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }, []);

    const startStream = useCallback(async () => {
        setError(null); setStarting(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: facing } }, audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => {});
            }
        } catch {
            // ponytail: kamera gagal (izin ditolak / tak ada device) → fallback file input, jangan blok.
            setError(PESAN_KAMERA);
        } finally { setStarting(false); }
    }, [facing]); // ganti kamera → identitas berubah → effect restart stream dgn facingMode baru

    useEffect(() => {
        if (!open) return;
        setPreview(null); setBlob(null);
        startStream();
        return () => {
            stopStream();
            setPreview(p => { if (p) URL.revokeObjectURL(p); return null; });
        };
    }, [open, startStream, stopStream]);

    function capture() {
        const v = videoRef.current; if (!v) return;
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext("2d")?.drawImage(v, 0, 0);
        canvas.toBlob((b) => {
            if (!b) return;
            stopStream();
            setBlob(b);
            setPreview(URL.createObjectURL(b));
        }, "image/jpeg", 0.9);
    }

    function retake() {
        if (preview) URL.revokeObjectURL(preview);
        setPreview(null); setBlob(null);
        startStream();
    }

    async function confirm() {
        if (!blob || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            await onCapture(blob);
            if (preview) URL.revokeObjectURL(preview);
            onClose();
        } catch (captureError) {
            setError(
                captureError instanceof Error
                    ? captureError.message
                    : "Foto belum berhasil disimpan. Coba lagi.",
            );
        } finally {
            setSubmitting(false);
        }
    }

    function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
        const f = e.target.files?.[0]; if (!f) return;
        stopStream();
        setBlob(f);
        setPreview(URL.createObjectURL(f));
        e.target.value = "";
    }

    return (
        <Dialog
            open={open}
            onClose={() => { if (!submitting) { stopStream(); onClose(); } }}
            labelledBy={judulId}
            className="m-0 h-dvh w-screen max-h-none max-w-none bg-black text-white flex-col open:flex"
        >
            <div className="flex items-center justify-between px-4 py-3">
                <span id={judulId} className="text-sm font-semibold">{judul}</span>
                <button disabled={submitting} onClick={() => { stopStream(); onClose(); }} className="flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-40" style={BULAT} aria-label="Tutup kamera">
                    <X size={18} />
                </button>
            </div>

            <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                {preview ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={preview} alt="Hasil foto" className="max-h-[calc(100%-4rem)] max-w-full object-contain" />
                        {error && <MessageStrip tone="neg" title="Foto belum disimpan.">{error}</MessageStrip>}
                    </div>
                ) : error ? (
                    <div className="grid justify-items-center gap-3 px-6 text-center">
                        <Camera size={40} className="opacity-70" aria-hidden />
                        <p className="text-sm" role="alert">{error}</p>
                        <button type="button" onClick={() => fileRef.current?.click()} className="fi-btn fi-btn--primary">
                            <ImageUp size={16} aria-hidden /> Pilih Foto
                        </button>
                    </div>
                ) : (
                    <>
                        <video ref={videoRef} playsInline muted className="max-h-full max-w-full object-contain"
                            style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }} />
                        {starting && <Loader2 size={28} className="absolute animate-spin opacity-70" aria-hidden />}
                    </>
                )}
            </div>

            <div className="relative px-4 py-5 flex items-center justify-center gap-6">
                {preview ? (
                    <>
                        <button onClick={retake} disabled={submitting} className="flex flex-col items-center gap-1 disabled:opacity-40">
                            <span className="flex h-12 w-12 items-center justify-center rounded-full" style={BULAT}><RotateCcw size={20} aria-hidden /></span>
                            <span className="text-xs">Ulang</span>
                        </button>
                        <button onClick={() => void confirm()} disabled={submitting} className="flex flex-col items-center gap-1 disabled:opacity-40">
                            <span className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "var(--primary)", color: "var(--on-primary)" }}>
                                {submitting ? <Loader2 size={28} className="animate-spin" aria-hidden /> : <Check size={28} aria-hidden />}
                            </span>
                            <span className="text-xs">{submitting ? "Menyimpan..." : "Gunakan"}</span>
                        </button>
                    </>
                ) : !error && (
                    <>
                        <button onClick={capture} disabled={starting}
                            aria-label="Ambil foto"
                            className="rounded-full p-1 disabled:opacity-40" style={{ border: "4px solid var(--on-primary)" }}>
                            <span className="block rounded-full" style={{ width: 56, height: 56, background: "var(--on-primary)" }} />
                        </button>
                        <button onClick={() => setFacing(f => f === "environment" ? "user" : "environment")}
                            disabled={starting}
                            aria-label={facing === "environment" ? "Ganti ke kamera depan" : "Ganti ke kamera belakang"}
                            className="absolute right-6 flex flex-col items-center gap-1 disabled:opacity-40">
                            <span className="flex h-12 w-12 items-center justify-center rounded-full" style={BULAT}><SwitchCamera size={20} aria-hidden /></span>
                            <span className="text-xs">{facing === "environment" ? "Kamera depan" : "Kamera belakang"}</span>
                        </button>
                    </>
                )}
            </div>

            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickFile} />
        </Dialog>
    );
}
