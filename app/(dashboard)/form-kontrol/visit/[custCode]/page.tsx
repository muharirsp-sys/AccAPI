/*
 * Tujuan: Wizard kunjungan toko yang mempersistenkan check-in, status order, merchandising, dan check-out secara berurutan.
 * Caller: Route Form Kontrol dari daftar JKS untuk customer terpilih.
 * Dependensi: API Form Kontrol, upload foto, geolokasi browser, `CameraCapture`, Next navigation, sonner.
 * Main Functions: `VisitWizardPage`, `PhotoInput`, `doCheckin`, `doSaveStatus`, `doSaveMerch`, `doCheckout`.
 * Side Effects: HTTP upload/read/write kunjungan, akses kamera/lokasi, dan perubahan state wizard; langkah hanya maju setelah persistence sukses.
 */

"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
    ArrowLeft, Camera, CheckCircle2, XCircle, AlertTriangle,
    Loader2, MapPin, Package, Star, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import CameraCapture from "@/components/form-kontrol/camera-capture";
import { getCurrentCoords, type GeoCoords } from "@/lib/form-kontrol/location";

interface StoreInfo {
    id: string; salesCode: string; salesName: string;
    custCode: string; custName: string;
    market: string | null; alamat: string | null; kota: string | null;
    principle: string; visitFrequency: number;
}
interface AoInfo {
    id: string; status: string;
    noOrderReasonCode: string | null; noOrderNote: string | null;
    checkinAt: string | null; checkinPhotoUrl: string | null;
    checkoutAt: string | null; checkoutPhotoUrl: string | null;
}
interface MerchInfo {
    produkJelas: boolean; displayRapi: boolean; dibersihkan: boolean;
    ditataulang: boolean; posisiMudah: boolean; semuaSku: boolean;
    stepPhotos: Record<string, string> | null;
}
interface Reason { id: string; reasonCode: string; label: string; category: string }

const MERCH_STEPS: { key: keyof MerchInfo; label: string }[] = [
    { key: "produkJelas", label: "Produk terlihat jelas" },
    { key: "displayRapi", label: "Display rapi & terorganisir" },
    { key: "dibersihkan", label: "Area display dibersihkan" },
    { key: "ditataulang", label: "Produk ditata ulang" },
    { key: "posisiMudah", label: "Posisi mudah ditemukan konsumen" },
    { key: "semuaSku",    label: "Seluruh SKU terpajang" },
];
async function uploadPhoto(file: File, meta: {
    salesName?: string; custName?: string; coords?: GeoCoords | null;
}): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    if (meta.salesName) fd.append("salesName", meta.salesName);
    if (meta.custName)  fd.append("custName", meta.custName);
    if (meta.coords) {
        fd.append("lat", String(meta.coords.lat));
        fd.append("lng", String(meta.coords.lng));
    }
    const res = await fetch("/api/upload/form-kontrol", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Upload gagal");
    return data.url as string;
}

function PhotoInput({ onUploaded, existingUrl, label = "Upload Foto", size = "md", salesName, custName }: {
    onUploaded: (url: string, coords: GeoCoords | null) => Promise<void>;
    existingUrl?: string | null;
    label?: string;
    size?: "sm" | "md" | "lg";
    salesName?: string;
    custName?: string;
}) {
    const [uploading, setUploading] = useState(false);
    const [camOpen, setCamOpen]     = useState(false);

    async function handleCapture(blob: Blob) {
        setUploading(true);
        try {
            // ponytail: tangkap GPS bersamaan dengan foto — di-stamp server-side + di-FLAG kalau mencurigakan.
            const coords = await getCurrentCoords();
            const file = new File([blob], "kunjungan.jpg", { type: "image/jpeg" });
            const url = await uploadPhoto(file, { salesName, custName, coords });
            await onUploaded(url, coords);
        } catch (error) {
            throw error instanceof Error ? error : new Error("Gagal mengunggah dan menyimpan foto.");
        }
        finally { setUploading(false); }
    }

    const sz = size === "lg" ? "px-6 py-4 text-base" : size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm";
    return (
        <div className="space-y-2">
            {existingUrl && (
                <div className="relative w-full rounded-xl overflow-hidden border border-emerald-500/40 bg-black/20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={existingUrl} alt="Foto" className="w-full max-h-48 object-cover" />
                    <div className="absolute top-2 right-2 bg-emerald-500 rounded-full p-1">
                        <CheckCircle2 size={14} className="text-white" />
                    </div>
                </div>
            )}
            <button type="button" onClick={() => setCamOpen(true)} disabled={uploading}
                className={`w-full flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors ${sz} ${
                    existingUrl ? "bg-slate-700 hover:bg-slate-600 text-slate-300 border border-white/10"
                                : "bg-indigo-600 hover:bg-indigo-500 text-white"
                } disabled:opacity-50`}>
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
                {uploading ? "Mengupload..." : existingUrl ? "Ganti Foto" : label}
            </button>
            <p className="text-xs text-slate-500 text-center">Foto langsung dari kamera · lokasi & waktu otomatis tercatat</p>
            <CameraCapture open={camOpen} onClose={() => setCamOpen(false)} onCapture={handleCapture} />
        </div>
    );
}

function StepDot({ n, label, done, active }: { n: number; label: string; done: boolean; active: boolean }) {
    return (
        <div className={`flex flex-col items-center gap-1 ${active ? "opacity-100" : done ? "opacity-70" : "opacity-30"}`}>
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                done ? "bg-emerald-500 border-emerald-500 text-white" :
                active ? "bg-indigo-600 border-indigo-400 text-white" :
                "bg-black/30 border-white/20 text-slate-400"
            }`}>
                {done ? <CheckCircle2 size={14} /> : n}
            </div>
            <span className="text-xs text-slate-400 whitespace-nowrap">{label}</span>
        </div>
    );
}

export default function VisitWizardPage() {
    const params = useParams();
    const searchParams = useSearchParams();
    const router = useRouter();

    const custCode  = params.custCode as string;
    const salesCode = searchParams.get("salesCode") ?? "";
    const principle = searchParams.get("principle") ?? "";
    const date      = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    const [loading, setLoading]           = useState(true);
    const [store, setStore]               = useState<StoreInfo | null>(null);
    const [ao, setAo]                     = useState<AoInfo | null>(null);
    const [reasons, setReasons]           = useState<Reason[]>([]);
    const [checkinPhoto, setCheckinPhoto] = useState<string | null>(null);
    const [orderStatus, setOrderStatus]   = useState<"ordered" | "not_order" | null>(null);
    const [reasonCode, setReasonCode]     = useState("");
    const [reasonNote, setReasonNote]     = useState("");
    const [merch, setMerch]               = useState<Record<string, boolean>>({});
    const [stepPhotos, setStepPhotos]     = useState<Record<string, string>>({});
    const [checkoutPhoto, setCheckoutPhoto] = useState<string | null>(null);
    const [saving, setSaving]             = useState(false);
    // ponytail: status WAJIB dikonfirmasi tiap kunjungan, walau toko sudah transaksi bulan ini.
    // Tidak auto-skip dari ao.status lama — true hanya jika dikonfirmasi sesi ini / visit sudah checkout.
    const [statusConfirmed, setStatusConfirmed] = useState(false);
    const [merchPersisted, setMerchPersisted] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams({ salesCode, custCode, principle, date });
            const [vRes, rRes] = await Promise.all([
                fetch(`/api/form-kontrol/visit?${p}`),
                fetch("/api/form-kontrol/reasons"),
            ]);
            const [vd, rd] = await Promise.all([vRes.json(), rRes.json()]);
            if (vd.store) setStore(vd.store);
            if (vd.ao) {
                const a = vd.ao as AoInfo;
                setAo(a);
                if (a.checkinPhotoUrl)  setCheckinPhoto(a.checkinPhotoUrl);
                if (a.checkoutPhotoUrl) setCheckoutPhoto(a.checkoutPhotoUrl);
                if (a.status && a.status !== "not_visited")
                    setOrderStatus(a.status === "ordered" || a.status === "active" ? "ordered" : "not_order");
                if (a.noOrderReasonCode) setReasonCode(a.noOrderReasonCode);
                if (a.noOrderNote)       setReasonNote(a.noOrderNote);
            }
            if (vd.merch) {
                const m = vd.merch as MerchInfo;
                setMerch({ produkJelas: m.produkJelas, displayRapi: m.displayRapi,
                    dibersihkan: m.dibersihkan, ditataulang: m.ditataulang,
                    posisiMudah: m.posisiMudah, semuaSku: m.semuaSku });
                if (m.stepPhotos) setStepPhotos(m.stepPhotos);
                setMerchPersisted(true);
            }
            setReasons(rd.rows ?? []);
        } catch { toast.error("Gagal memuat data kunjungan"); }
        finally { setLoading(false); }
    }, [salesCode, custCode, principle, date]);

    useEffect(() => { load(); }, [load]);

    const allMerchDone = MERCH_STEPS.every(s => merch[s.key]);
    const checkinDone  = !!(checkinPhoto || ao?.checkinPhotoUrl);
    const checkoutDone = !!(checkoutPhoto || ao?.checkoutPhotoUrl);
    // status selesai HANYA jika dikonfirmasi sesi ini, atau visit sudah checkout penuh (resume).
    // ao.status lama (transaksi bulan ini) TIDAK dihitung → sales tetap wajib isi order/tidak.
    const statusDone   = checkoutDone || statusConfirmed;

    function currentStep(): 0|1|2|3|4 {
        if (checkoutDone) return 4;
        if (checkinDone && statusDone && allMerchDone && merchPersisted) return 3;
        if (checkinDone && statusDone) return 2;
        if (checkinDone) return 1;
        return 0;
    }
    const step = loading ? -1 : currentStep();

    async function doCheckin(url: string, coords: GeoCoords | null) {
        setSaving(true);
        try {
            const res = await fetch("/api/form-kontrol/checkin", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, custCode, principle, date, photoUrl: url,
                    lat: coords?.lat ?? null, lng: coords?.lng ?? null, accuracy: coords?.accuracy ?? null }),
            });
            if (!res.ok) throw new Error("Gagal check-in");
            setCheckinPhoto(url); toast.success("Check-in berhasil!");
        } catch (e) {
            throw e instanceof Error ? e : new Error("Gagal check-in");
        }
        finally { setSaving(false); }
    }

    async function doSaveStatus() {
        if (!orderStatus) { toast.error("Pilih status"); return; }
        if (orderStatus === "not_order" && !reasonCode) { toast.error("Pilih alasan"); return; }
        setSaving(true);
        try {
            const res = await fetch("/api/form-kontrol/ao-control", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, custCode, principle, date, status: orderStatus,
                    noOrderReasonCode: orderStatus === "not_order" ? reasonCode : null,
                    noOrderNote: orderStatus === "not_order" ? reasonNote : null }),
            });
            if (!res.ok) throw new Error("Gagal simpan status");
            setAo((current) => current ? {
                ...current,
                status: orderStatus,
                noOrderReasonCode: orderStatus === "not_order" ? reasonCode : null,
                noOrderNote: orderStatus === "not_order" ? reasonNote : null,
            } : current);
            setStatusConfirmed(true);
            toast.success("Status tersimpan. Lanjutkan merchandising.");
        } catch (e) { toast.error(e instanceof Error ? e.message : "Gagal"); }
        finally { setSaving(false); }
    }

    async function doSaveMerch() {
        setSaving(true);
        try {
            const res = await fetch("/api/form-kontrol/merchandising", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, custCode, principle, date,
                    produkJelas: !!merch.produkJelas, displayRapi: !!merch.displayRapi,
                    dibersihkan: !!merch.dibersihkan, ditataulang: !!merch.ditataulang,
                    posisiMudah: !!merch.posisiMudah, semuaSku: !!merch.semuaSku,
                    stepPhotos: Object.keys(stepPhotos).length > 0 ? stepPhotos : null, note: null }),
            });
            if (!res.ok) throw new Error("Gagal simpan merchandising");
            setMerchPersisted(true);
            toast.success("Merchandising tersimpan. Lanjutkan check-out.");
        } catch (e) {
            throw e instanceof Error ? e : new Error("Gagal check-out");
        }
        finally { setSaving(false); }
    }

    async function doCheckout(url: string) {
        setSaving(true);
        try {
            const res = await fetch("/api/form-kontrol/checkout", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, custCode, principle, date, photoUrl: url }),
            });
            if (!res.ok) throw new Error("Gagal check-out");
            setCheckoutPhoto(url); toast.success("Kunjungan selesai! ✓");
        } catch (e) { toast.error(e instanceof Error ? e.message : "Gagal"); }
        finally { setSaving(false); }
    }

    if (loading) return (
        <div className="flex items-center justify-center min-h-[60vh] text-slate-400 gap-2">
            <Loader2 size={20} className="animate-spin" /> Memuat...
        </div>
    );

    if (!store) return (
        <div className="max-w-lg mx-auto px-4 py-8 text-center text-slate-400">
            <XCircle size={48} className="mx-auto mb-3 opacity-30" />
            <p>Toko tidak ditemukan di JKS.</p>
            <button onClick={() => router.back()} className="mt-4 text-indigo-400 flex items-center gap-1 mx-auto">
                <ArrowLeft size={14} /> Kembali
            </button>
        </div>
    );

    return (
        <div className="max-w-lg mx-auto px-3 pb-20 pt-2">
            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
                <button onClick={() => router.back()} className="p-2 rounded-lg bg-black/30 border border-white/10 text-slate-400 hover:text-white">
                    <ArrowLeft size={18} />
                </button>
                <div className="flex-1 min-w-0">
                    <h1 className="text-lg font-bold text-white truncate">{store.custName}</h1>
                    <p className="text-xs text-slate-400">{store.custCode} · {store.principle} · {date}</p>
                </div>
            </div>

            {/* Store info */}
            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-3 mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
                {store.market && <span className="flex items-center gap-1"><Package size={11} />{store.market}</span>}
                {store.alamat && <span className="flex items-center gap-1"><MapPin size={11} />{store.alamat}{store.kota ? `, ${store.kota}` : ""}</span>}
                <span className="flex items-center gap-1"><Star size={11} />{store.visitFrequency}×/bulan</span>
            </div>

            {/* Step indicator */}
            <div className="flex items-center justify-between bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3 mb-5">
                {["Check-in","Status","Merch","Check-out"].map((lbl, i) => (
                    <div key={i} className="flex items-center gap-1">
                        <StepDot n={i+1} label={lbl} done={step > i} active={step === i} />
                        {i < 3 && <div className={`w-5 h-px ${step > i ? "bg-emerald-500" : "bg-white/10"}`} />}
                    </div>
                ))}
            </div>

            {/* ── Step 0: Check-in ── */}
            {step === 0 && (
                <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-5 space-y-4">
                    <div className="text-center space-y-1">
                        <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mx-auto">
                            <Camera size={22} className="text-indigo-400" />
                        </div>
                        <h2 className="text-base font-bold text-white">Mulai Kunjungan</h2>
                        <p className="text-xs text-slate-400">Foto di depan toko sebagai bukti check-in wajib</p>
                    </div>
                    <PhotoInput label="Ambil Foto Check-in" size="lg" existingUrl={checkinPhoto}
                        salesName={store.salesName} custName={store.custName}
                        onUploaded={(url, coords) => doCheckin(url, coords)} />
                    {saving && <p className="text-xs text-center text-slate-400 flex items-center justify-center gap-1"><Loader2 size={12} className="animate-spin" />Menyimpan check-in...</p>}
                </div>
            )}

            {/* ── Step 1: Status ── */}
            {step === 1 && (
                <div className="space-y-3">
                    <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-4">
                        <p className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 size={11} /> Check-in berhasil tercatat</p>
                        <h2 className="text-base font-bold text-white">Status Order</h2>
                        <div className="grid grid-cols-2 gap-3">
                            {(["ordered","not_order"] as const).map(s => (
                                <button key={s} onClick={() => setOrderStatus(s)}
                                    className={`py-5 rounded-xl font-bold text-sm flex flex-col items-center gap-2 border-2 transition-all ${
                                        orderStatus === s
                                            ? s === "ordered" ? "bg-emerald-500/20 border-emerald-500 text-emerald-400" : "bg-rose-500/20 border-rose-500 text-rose-400"
                                            : "bg-black/30 border-white/10 text-slate-400 hover:border-white/30"
                                    }`}>
                                    {s === "ordered" ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
                                    {s === "ordered" ? "ORDER" : "TIDAK ORDER"}
                                </button>
                            ))}
                        </div>
                        {orderStatus === "not_order" && (
                            <div className="space-y-2">
                                <select value={reasonCode} onChange={e => setReasonCode(e.target.value)}
                                    className={`w-full bg-black/30 border rounded-lg text-sm text-white px-3 py-2 ${!reasonCode ? "border-rose-500/50" : "border-white/10"}`}>
                                    <option value="">— Pilih Alasan (Wajib) —</option>
                                    {reasons.map(r => <option key={r.reasonCode} value={r.reasonCode}>[{r.category}] {r.label}</option>)}
                                </select>
                                <input value={reasonNote} onChange={e => setReasonNote(e.target.value)}
                                    placeholder="Catatan tambahan..."
                                    className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500" />
                            </div>
                        )}
                    </div>
                    <button onClick={doSaveStatus} disabled={!orderStatus || (orderStatus === "not_order" && !reasonCode) || saving}
                        className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2">
                        {saving && <Loader2 size={14} className="animate-spin" />}
                        Simpan & Lanjut Merchandising
                    </button>
                </div>
            )}

            {/* ── Step 2: Merchandising ── */}
            {step === 2 && (
                <div className="space-y-3">
                    <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-2">
                        <div className="flex items-center justify-between">
                            <h2 className="text-base font-bold text-white">Merchandising Wajib</h2>
                            <span className={`text-sm font-bold px-3 py-1 rounded-lg ${allMerchDone ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-500/20 text-slate-400"}`}>
                                {MERCH_STEPS.filter(s => merch[s.key]).length}/6
                            </span>
                        </div>
                        <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${allMerchDone ? "bg-emerald-500" : "bg-indigo-500"}`}
                                style={{ width: `${(MERCH_STEPS.filter(s => merch[s.key]).length / 6) * 100}%` }} />
                        </div>
                        {!allMerchDone && (
                            <p className="text-xs text-amber-400 flex items-center gap-1">
                                <AlertTriangle size={11} /> Semua 6 item wajib diselesaikan sebelum bisa check-out
                            </p>
                        )}
                    </div>

                    {MERCH_STEPS.map(({ key, label }) => (
                        <div key={key} className={`bg-[#1a1c23]/60 border rounded-xl p-4 space-y-2 transition-colors ${merch[key] ? "border-emerald-500/30" : "border-white/10"}`}>
                            <label className="flex items-start gap-3 cursor-pointer">
                                <button type="button" onClick={() => {
                                    setMerchPersisted(false);
                                    setMerch(p => ({ ...p, [key]: !p[key] }));
                                }}
                                    className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center shrink-0 border-2 transition-colors ${
                                        merch[key] ? "bg-emerald-500 border-emerald-500" : "bg-black/30 border-white/20"}`}>
                                    {merch[key] && <CheckCircle2 size={12} className="text-white" />}
                                </button>
                                <span className={`text-sm ${merch[key] ? "text-emerald-400" : "text-slate-300"}`}>{label}</span>
                            </label>
                            <div className="pl-4">
                                <PhotoInput label="Foto Bukti" size="sm" existingUrl={stepPhotos[key]}
                                    salesName={store.salesName} custName={store.custName}
                                    onUploaded={async (url) => {
                                        setMerchPersisted(false);
                                        setStepPhotos(p => ({ ...p, [key]: url }));
                                        setMerch(p => ({ ...p, [key]: true })); // foto = bukti → auto-centang
                                    }} />
                            </div>
                        </div>
                    ))}

                    <button onClick={doSaveMerch} disabled={!allMerchDone || saving}
                        className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2">
                        {saving && <Loader2 size={14} className="animate-spin" />}
                        {allMerchDone ? "Selesai Merchandising — Lanjut Check-out" : `Selesaikan ${6 - MERCH_STEPS.filter(s => merch[s.key]).length} item lagi`}
                    </button>
                </div>
            )}

            {/* ── Step 3: Check-out ── */}
            {step === 3 && (
                <div className="space-y-3">
                    <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-2">
                        <h2 className="text-base font-bold text-white mb-3">Ringkasan Kunjungan</h2>
                        {[
                            { label: "Check-in", ok: true, text: "Tercatat" },
                            { label: "Status",   ok: orderStatus === "ordered", text: orderStatus === "ordered" ? "ORDER ✓" : "TIDAK ORDER" },
                            { label: "Merchandising", ok: true, text: "6/6 selesai" },
                        ].map(item => (
                            <div key={item.label} className={`flex items-center gap-2 text-sm ${item.ok ? "text-emerald-400" : "text-rose-400"}`}>
                                {item.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                                <span className="text-slate-400">{item.label}:</span> {item.text}
                            </div>
                        ))}
                    </div>
                    <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-5 space-y-4">
                        <div className="text-center space-y-1">
                            <div className="w-12 h-12 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center mx-auto">
                                <ImageIcon size={22} className="text-emerald-400" />
                            </div>
                            <h3 className="text-sm font-bold text-white">Foto Check-out</h3>
                            <p className="text-xs text-slate-400">Foto bukti selesai kunjungan</p>
                        </div>
                        <PhotoInput label="Ambil Foto Check-out" size="lg" existingUrl={checkoutPhoto}
                            salesName={store.salesName} custName={store.custName}
                            onUploaded={(url) => doCheckout(url)} />
                        {saving && <p className="text-xs text-center text-slate-400 flex items-center justify-center gap-1"><Loader2 size={12} className="animate-spin" />Menyimpan...</p>}
                    </div>
                </div>
            )}

            {/* ── Step 4: Done ── */}
            {step === 4 && (
                <div className="bg-[#1a1c23]/60 border border-emerald-500/30 rounded-xl p-6 text-center space-y-4">
                    <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mx-auto">
                        <CheckCircle2 size={32} className="text-emerald-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-white">Kunjungan Selesai</h2>
                        <p className="text-sm text-slate-400 mt-1">{store.custName} · {principle}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                        {[
                            { label: "Status", value: orderStatus === "ordered" ? "ORDER ✓" : "TIDAK ORDER", color: orderStatus === "ordered" ? "text-emerald-400" : "text-rose-400" },
                            { label: "Merchandising", value: "6/6 ✓", color: "text-emerald-400" },
                            { label: "Check-in", value: "Tercatat", color: "text-white" },
                            { label: "Check-out", value: "Tercatat", color: "text-white" },
                        ].map(item => (
                            <div key={item.label} className="bg-black/30 rounded-lg p-2.5 text-left">
                                <p className="text-slate-500">{item.label}</p>
                                <p className={`font-semibold ${item.color}`}>{item.value}</p>
                            </div>
                        ))}
                    </div>
                    <button onClick={() => router.back()}
                        className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2">
                        <ArrowLeft size={14} /> Kembali ke Rute
                    </button>
                </div>
            )}
        </div>
    );
}
