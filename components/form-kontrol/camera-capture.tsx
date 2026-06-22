/*
 * Tujuan: Modal kamera langsung (live preview + capture) untuk foto bukti kunjungan — pengganti file picker.
 * Caller: app/(dashboard)/form-kontrol/visit/[custCode]/page.tsx (PhotoInput).
 * Dependensi: getUserMedia native browser (zero dependency), lucide-react ikon.
 * Main Functions: CameraCapture (default export).
 * Side Effects: Membuka stream kamera (facingMode belakang/depan, bisa diganti); stream dihentikan saat modal ditutup.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, X, RotateCcw, Check, Loader2, ImageUp, SwitchCamera } from "lucide-react";

export default function CameraCapture({ open, onClose, onCapture }: {
    open: boolean;
    onClose: () => void;
    onCapture: (blob: Blob) => void;
}) {
    const videoRef  = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const fileRef   = useRef<HTMLInputElement>(null);
    const [error, setError]     = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null); // object URL hasil capture
    const [blob, setBlob]       = useState<Blob | null>(null);
    const [starting, setStarting] = useState(false);
    const [facing, setFacing]   = useState<"environment" | "user">("environment"); // belakang default
    const [mounted, setMounted] = useState(false); // portal butuh document (client only)

    useEffect(() => { setMounted(true); }, []);

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
            setError("Kamera tidak tersedia. Gunakan pilih file foto.");
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

    function confirm() {
        if (blob) onCapture(blob);
        if (preview) URL.revokeObjectURL(preview);
        onClose();
    }

    function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
        const f = e.target.files?.[0]; if (!f) return;
        stopStream();
        setBlob(f);
        setPreview(URL.createObjectURL(f));
        e.target.value = "";
    }

    if (!open || !mounted) return null;
    // ponytail: portal ke body — hindari ancestor transform/filter/backdrop yang bikin
    // position:fixed ter-contain ke ancestor (modal tak full-screen / "tak buka") di tema tertentu.
    return createPortal(
        <div className="fixed inset-0 z-[100] bg-black flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 text-white">
                <span className="text-sm font-semibold">Foto Bukti Kunjungan</span>
                <button onClick={() => { stopStream(); onClose(); }} className="p-1.5 rounded-lg bg-white/10">
                    <X size={18} />
                </button>
            </div>

            <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview} alt="Hasil foto" className="max-h-full max-w-full object-contain" />
                ) : error ? (
                    <div className="text-center px-6 space-y-3">
                        <Camera size={40} className="mx-auto text-slate-500" />
                        <p className="text-sm text-slate-300">{error}</p>
                        <button onClick={() => fileRef.current?.click()}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold">
                            <ImageUp size={16} /> Pilih Foto
                        </button>
                    </div>
                ) : (
                    <>
                        <video ref={videoRef} playsInline muted className="max-h-full max-w-full object-contain"
                            style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }} />
                        {starting && <Loader2 size={28} className="absolute animate-spin text-white/70" />}
                    </>
                )}
            </div>

            <div className="relative px-4 py-5 flex items-center justify-center gap-6">
                {preview ? (
                    <>
                        <button onClick={retake} className="flex flex-col items-center gap-1 text-slate-300">
                            <span className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center"><RotateCcw size={20} /></span>
                            <span className="text-xs">Ulang</span>
                        </button>
                        <button onClick={confirm} className="flex flex-col items-center gap-1 text-emerald-400">
                            <span className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center text-white"><Check size={28} /></span>
                            <span className="text-xs">Gunakan</span>
                        </button>
                    </>
                ) : !error && (
                    <>
                        <button onClick={capture} disabled={starting}
                            className="rounded-full border-4 border-white/80 p-1 disabled:opacity-40">
                            <span className="block rounded-full bg-white" style={{ width: 56, height: 56 }} />
                        </button>
                        <button onClick={() => setFacing(f => f === "environment" ? "user" : "environment")}
                            disabled={starting}
                            className="absolute right-6 flex flex-col items-center gap-1 text-slate-300 disabled:opacity-40">
                            <span className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center"><SwitchCamera size={20} /></span>
                            <span className="text-xs">{facing === "environment" ? "Depan" : "Belakang"}</span>
                        </button>
                    </>
                )}
            </div>

            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickFile} />
        </div>,
        document.body
    );
}
