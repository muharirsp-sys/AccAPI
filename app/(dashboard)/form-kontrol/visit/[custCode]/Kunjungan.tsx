/*
 * Tujuan: Wizard Kunjungan toko (Fiori S5, it05): Check-in → Status → Merchandising → Check-out, Kembali di setiap langkah, status
 *   tersimpan tampil lagi, galat di langkahnya (langkah tidak maju), foto tetap di layar bila tanpa sinyal.
 * Caller: ./page.tsx (rute /form-kontrol/visit/[custCode]?salesCode&principle&date).
 * Dependensi: GET /api/form-kontrol/visit + /reasons; POST /api/form-kontrol/checkin, /ao-control, /merchandising, /checkout;
 *   ./FotoBukti; ../../lapangan (ambilJson, kirimFk, sebabGagal, PESAN_SINYAL), ../../shared (alasanIzinFk, jamWita); components/fiori/*; lib/rekapan-nota/ui.
 * Main Functions: Kunjungan (muat/kosong/galat), Wizard (langkah), MERCH_STEPS.
 * Side Effects: HTTP baca/tulis kunjungan; kamera/lokasi lewat FotoBukti. Langkah hanya maju setelah simpan sukses. Payload sama dengan
 *   wizard lama.
 */
"use client";

import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShoppingCart, XCircle } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, MessageStrip, ObjectPageHeader, Skeleton, StatusBadge, VariantNote,
    type FlowStep,
} from "@/components/fiori/core";
import { FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import type { GeoCoords } from "@/lib/form-kontrol/location";
import { PESAN_SINYAL, ambilJson, kirimFk, sebabGagal } from "../../lapangan";
import { alasanIzinFk, jamWita } from "../../shared";
import FotoBukti from "./FotoBukti";

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
type Data = { store: StoreInfo | null; ao: AoInfo | null; merch: MerchInfo | null; reasons: Reason[] };

const MERCH_STEPS: { key: keyof Omit<MerchInfo, "stepPhotos">; label: string }[] = [
    { key: "produkJelas", label: "Produk terlihat jelas" },
    { key: "displayRapi", label: "Display rapi & terorganisir" },
    { key: "dibersihkan", label: "Area display dibersihkan" },
    { key: "ditataulang", label: "Produk ditata ulang" },
    { key: "posisiMudah", label: "Posisi mudah ditemukan konsumen" },
    { key: "semuaSku", label: "Seluruh SKU terpajang" },
];
const LANGKAH = ["Check-in", "Status", "Merchandising", "Check-out"];

/** `izinFk` = kunci izin form_kontrol.* akun (dari server); penguncian tombol mengikuti alasanIzinFk seperti tab Form Kontrol. */
type Props = { custCode: string; salesCode: string; principle: string; date: string; izinFk: string[] };

export default function Kunjungan(props: Props) {
    const { custCode, salesCode, principle, date } = props;
    const router = useRouter();
    const loader = useCallback(async (): Promise<Load<Data>> => {
        const p = new URLSearchParams({ salesCode, custCode, principle, date });
        const [v, r] = await Promise.all([ambilJson(`/api/form-kontrol/visit?${p}`), ambilJson("/api/form-kontrol/reasons")]);
        const tanpaSinyal = `${PESAN_SINYAL} Ini bukan toko kosong; coba lagi saat ada sinyal.`;
        // 404 = toko tidak ada di JKS salesman/principal ini → Kosong, bukan Galat.
        if (v.status === 404) return { status: "siap", data: { store: null, ao: null, merch: null, reasons: [] } };
        if (v.status === 400) return { status: "galat", error: "Kode salesman atau principal tidak terbawa. Buka kunjungan dari Rute hari ini." };
        if (v.status < 200 || v.status >= 300 || !v.data) return { status: "galat", error: v.status === 0 ? tanpaSinyal : sebabGagal(v.status) };
        if (r.status < 200 || r.status >= 300 || !r.data) return { status: "galat", error: `Daftar alasan tidak order gagal dimuat. ${r.status === 0 ? tanpaSinyal : sebabGagal(r.status)}` };
        return {
            status: "siap",
            data: {
                store: (v.data.store as StoreInfo) ?? null, ao: (v.data.ao as AoInfo) ?? null, merch: (v.data.merch as MerchInfo) ?? null,
                reasons: (Array.isArray(r.data.rows) ? r.data.rows : []) as Reason[],
            },
        };
    }, [salesCode, custCode, principle, date]);
    const [load, muatUlang] = useLoad(loader);
    const kembali = () => router.back();

    const crumbs = [{ label: "Rute hari ini", href: "/form-kontrol?tab=ao" }, { label: "Kunjungan" }];
    if (!load.data) {
        return (
            <div>
                <ObjectPageHeader breadcrumbs={crumbs} title={custCode} attributes={[{ label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` }]} />
                <div className="fi-page" style={{ maxWidth: "46rem" }}>
                    {load.status === "galat"
                        ? <ErrorState title="Data kunjungan gagal dimuat" message={load.error} onRetry={muatUlang} />
                        : <Skeleton rows={5} label="Memuat kunjungan" />}
                </div>
            </div>
        );
    }
    if (!load.data.store) {
        return (
            <div>
                <ObjectPageHeader breadcrumbs={crumbs} title={custCode} attributes={[{ label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` }]} />
                <div className="fi-page" style={{ maxWidth: "46rem" }}>
                    <EmptyState title="Toko ini tidak ada di JKS Anda"
                        message={`Kunjungan hanya bisa dibuat untuk toko di JKS ${salesCode || "salesman"} untuk ${principle || "principal ini"}. Kembali ke rute, atau minta SPV menambahkan toko ini ke JKS.`}
                        action={<Link className="fi-btn fi-btn--secondary" href="/form-kontrol?tab=ao"><ArrowLeft className="fi-icon" aria-hidden />Rute hari ini</Link>} />
                </div>
            </div>
        );
    }
    return <Wizard {...props} data={load.data} store={load.data.store} kembali={kembali} />;
}

function Wizard({ salesCode, custCode, principle, date, izinFk, data, store, kembali }: Props & { data: Data; store: StoreInfo; kembali: () => void }) {
    const awalStatus = data.ao?.status && data.ao.status !== "not_visited" ? awalDari(data.ao.status) : null;
    const [ao, setAo] = useState<AoInfo | null>(data.ao);
    const [checkinPhoto, setCheckinPhoto] = useState<string | null>(data.ao?.checkinPhotoUrl ?? null);
    const [checkinAt, setCheckinAt] = useState<string | null>(data.ao?.checkinAt ?? null);
    const [checkoutPhoto, setCheckoutPhoto] = useState<string | null>(data.ao?.checkoutPhotoUrl ?? null);
    const [checkoutAt, setCheckoutAt] = useState<string | null>(data.ao?.checkoutAt ?? null);
    // Status tersimpan tampil lagi (#5) — tetapi tetap WAJIB dikonfirmasi tiap kunjungan, walau toko sudah transaksi bulan ini:
    // status lama tidak membuat langkah terlewati; true hanya jika dikonfirmasi sesi ini / kunjungan sudah check-out.
    const [orderStatus, setOrderStatus] = useState<"ordered" | "not_order" | null>(awalStatus);
    const [reasonCode, setReasonCode] = useState(data.ao?.noOrderReasonCode ?? "");
    const [reasonNote, setReasonNote] = useState(data.ao?.noOrderNote ?? "");
    const [statusConfirmed, setStatusConfirmed] = useState(false);
    const [merch, setMerch] = useState<Record<string, boolean>>(() => data.merch ? Object.fromEntries(MERCH_STEPS.map((s) => [s.key, Boolean(data.merch![s.key])])) : {});
    const [stepPhotos, setStepPhotos] = useState<Record<string, string>>(data.merch?.stepPhotos ?? {});
    const [merchPersisted, setMerchPersisted] = useState(Boolean(data.merch));
    const [saving, setSaving] = useState(false);
    const [galat, setGalat] = useState("");
    const [lihat, setLihat] = useState<number | null>(null);

    const nMerch = MERCH_STEPS.filter((s) => merch[s.key]).length;
    const allMerchDone = nMerch === MERCH_STEPS.length;
    const checkinDone = Boolean(checkinPhoto || ao?.checkinPhotoUrl);
    const checkoutDone = Boolean(checkoutPhoto || ao?.checkoutPhotoUrl);
    const statusDone = checkoutDone || statusConfirmed;
    const maks = checkoutDone ? 4 : checkinDone && statusDone && allMerchDone && merchPersisted ? 3 : checkinDone && statusDone ? 2 : checkinDone ? 1 : 0;
    // `lihat` = langkah yang dibuka lewat Kembali; tidak pernah melewati langkah terjauh yang sudah tersimpan.
    const step = maks === 4 ? 4 : Math.min(lihat ?? maks, maks);
    const tersimpanStatus = { status: (ao?.status && ao.status !== "not_visited") ? awalDari(ao.status) : null, code: ao?.noOrderReasonCode ?? "", note: ao?.noOrderNote ?? "" };
    const drafStatus = orderStatus !== tersimpanStatus.status
        || (orderStatus === "not_order" && (reasonCode !== tersimpanStatus.code || reasonNote !== tersimpanStatus.note));
    const draf = !checkoutDone && ((drafStatus && orderStatus !== null) || (!merchPersisted && nMerch > 0));
    useUnsavedGuard(draf);

    const tanpaIzin = alasanIzinFk(new Set(izinFk), "submit");
    const pindah = (s: number | null) => { setGalat(""); setLihat(s); };

    async function doCheckin(url: string, coords: GeoCoords | null) {
        await kirimFk("/api/form-kontrol/checkin", {
            salesCode, custCode, principle, date, photoUrl: url,
            lat: coords?.lat ?? null, lng: coords?.lng ?? null, accuracy: coords?.accuracy ?? null,
        }, { ulangAman: true });
        setCheckinPhoto(url);
        setCheckinAt(new Date().toISOString()); // tampilan saja; jam resmi = server (BL-28)
        pindah(null);
    }

    async function doSaveStatus() {
        if (!orderStatus || (orderStatus === "not_order" && !reasonCode) || saving) return;
        setSaving(true);
        setGalat("");
        try {
            await kirimFk("/api/form-kontrol/ao-control", {
                salesCode, custCode, principle, date, status: orderStatus,
                noOrderReasonCode: orderStatus === "not_order" ? reasonCode : null,
                noOrderNote: orderStatus === "not_order" ? reasonNote : null,
            }, { ulangAman: true });
            setAo((current) => ({
                ...(current ?? { id: "", checkinAt: null, checkinPhotoUrl: null, checkoutAt: null, checkoutPhotoUrl: null }),
                status: orderStatus,
                noOrderReasonCode: orderStatus === "not_order" ? reasonCode : null,
                noOrderNote: orderStatus === "not_order" ? reasonNote : null,
            }));
            setStatusConfirmed(true);
            pindah(lihat === null ? null : 2);
        } catch (e) {
            setGalat(`Status belum tersimpan. ${e instanceof Error ? e.message : ""}`.trim());
        } finally { setSaving(false); }
    }

    async function doSaveMerch() {
        if (!allMerchDone || saving) return;
        if (merchPersisted) { pindah(null); return; }
        setSaving(true);
        setGalat("");
        try {
            await kirimFk("/api/form-kontrol/merchandising", {
                salesCode, custCode, principle, date,
                produkJelas: !!merch.produkJelas, displayRapi: !!merch.displayRapi,
                dibersihkan: !!merch.dibersihkan, ditataulang: !!merch.ditataulang,
                posisiMudah: !!merch.posisiMudah, semuaSku: !!merch.semuaSku,
                stepPhotos: Object.keys(stepPhotos).length > 0 ? stepPhotos : null, note: null,
            }, { ulangAman: true });
            setMerchPersisted(true);
            pindah(null);
        } catch (e) {
            // #7: galat merchandising tampil di langkah ini dan langkah tidak maju (dulu diam lalu muncul "Gagal check-out").
            setGalat(`Merchandising belum tersimpan. ${e instanceof Error ? e.message : ""}`.trim());
        } finally { setSaving(false); }
    }

    async function doCheckout(url: string) {
        await kirimFk("/api/form-kontrol/checkout", { salesCode, custCode, principle, date, photoUrl: url }, { ulangAman: true });
        setCheckoutPhoto(url);
        setCheckoutAt(new Date().toISOString());
    }

    const flow: FlowStep[] = LANGKAH.map((label, i) => ({ label, state: i < maks && i !== step ? "done" : i === step ? "current" : "todo" }));
    const statusTeks = (s: string | null | undefined) => s === "ordered" || s === "active" ? "ORDER" : s ? "TIDAK ORDER" : "—";
    const alasanLabel = (code: string) => { const r = data.reasons.find((x) => x.reasonCode === code); return r ? `${r.reasonCode} · ${r.label}` : code; };
    const kartuCheckin = (
        <KeyValues items={[
            ["Check-in", checkinAt ? `${jamWita(checkinAt)} WITA` : "Tercatat"],
            ...(checkinPhoto ? [["Foto", "tersimpan · lokasi dan waktu dicap server"] as [string, ReactNode]] : []),
        ]} />
    );
    const tombolKembali = (s: number) => (
        <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} disabled={saving} onClick={() => (s === 0 ? kembali() : pindah(s - 1))}>
            {s === 0 ? "Rute hari ini" : "Kembali"}
        </Button>
    );

    let isi: ReactNode;
    let kaki: ReactNode = null;
    if (step === 0) {
        isi = checkinDone ? (
            <div className="fi-panel">
                <MessageStrip tone="pos" title="Check-in sudah tercatat.">Lanjutkan ke status kunjungan.</MessageStrip>
                {checkinPhoto && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={checkinPhoto} alt="Foto check-in" style={{ width: "100%", maxHeight: "12rem", objectFit: "cover", borderRadius: "var(--r-md)" }} />
                )}
                {kartuCheckin}
            </div>
        ) : (
            <div className="fi-panel">
                <h2 className="fi-title-3">Mulai kunjungan</h2>
                <p className="fi-small fi-muted">Foto di depan toko sebagai bukti check-in (wajib).</p>
                <FotoBukti label="Ambil foto check-in" judulGagal="Foto check-in belum terkirim." akibat="Langkah ini belum maju; check-in belum dipastikan tercatat."
                    salesName={store.salesName} custName={store.custName} disabledReason={tanpaIzin} onPersist={doCheckin} />
            </div>
        );
        kaki = <FooterToolbar message={checkinDone ? undefined : "Langkah maju setelah foto check-in tersimpan."}>
            {tombolKembali(0)}
            {checkinDone && <Button variant="primary" onClick={() => pindah(1)}>Lanjut</Button>}
        </FooterToolbar>;
    } else if (step === 1) {
        const kurang = !orderStatus ? "Pilih hasil kunjungan" : orderStatus === "not_order" && !reasonCode ? "Pilih alasan tidak order" : tanpaIzin;
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel">{kartuCheckin}</div>
                <div className="fi-panel">
                    <h2 className="fi-title-3">Hasil kunjungan</h2>
                    {statusConfirmed && !drafStatus && <p className="fi-small fi-muted">Tersimpan: {statusTeks(ao?.status)}.</p>}
                    <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Hasil kunjungan">
                        {(["ordered", "not_order"] as const).map((s) => (
                            <label key={s} className="fi-btn fi-btn--secondary" style={{ height: "auto", minHeight: 64, flexDirection: "column", gap: 6, whiteSpace: "normal",
                                ...(orderStatus === s ? { background: s === "ordered" ? "var(--pos-bg)" : "var(--neg-bg)", borderColor: s === "ordered" ? "var(--pos)" : "var(--neg)", color: s === "ordered" ? "var(--pos)" : "var(--neg)" } : {}) }}>
                                <input type="radio" name="hasil-kunjungan" value={s} checked={orderStatus === s} onChange={() => { setOrderStatus(s); setGalat(""); }}
                                    style={{ width: 20, height: 20, minHeight: 0, minWidth: 0, margin: 0, accentColor: "var(--primary)" }} />
                                {s === "ordered" ? <ShoppingCart className="fi-icon" aria-hidden /> : <XCircle className="fi-icon" aria-hidden />}
                                {s === "ordered" ? "ORDER" : "TIDAK ORDER"}
                            </label>
                        ))}
                    </div>
                    {orderStatus === "not_order" && (
                        <>
                            <FormField label="Alasan tidak order" required error={!reasonCode ? "Pilih alasan" : undefined}>
                                {(a) => (
                                    <select {...a} className="fi-input" value={reasonCode} onChange={(e) => { setReasonCode(e.target.value); setGalat(""); }}>
                                        <option value="">Pilih alasan</option>
                                        {data.reasons.map((r) => <option key={r.reasonCode} value={r.reasonCode}>{r.reasonCode} · {r.label}</option>)}
                                    </select>
                                )}
                            </FormField>
                            <FormField label="Catatan">
                                {(a) => <input {...a} className="fi-input" value={reasonNote} placeholder="Catatan tambahan" onChange={(e) => setReasonNote(e.target.value)} />}
                            </FormField>
                            <VariantNote bl="Toko tutup">“Toko tutup” belum menjadi kode alasan sendiri; pilih R14 Lainnya dan tulis “toko tutup” di catatan. Merchandising tetap wajib 6/6 sebelum check-out.</VariantNote>
                        </>
                    )}
                </div>
                {galat && <MessageStrip tone="neg" title="Gagal menyimpan.">{galat}</MessageStrip>}
            </div>
        );
        // Status yang sudah dikonfirmasi sesi ini dan tidak diubah → Lanjut tanpa menulis ulang (seperti Merchandising).
        const tanpaUbah = statusConfirmed && !drafStatus;
        kaki = <FooterToolbar message={tanpaUbah ? "Status sudah tersimpan." : kurang}>
            {tombolKembali(1)}
            {tanpaUbah
                ? <Button variant="primary" onClick={() => pindah(2)}>Lanjut</Button>
                : <Button variant="primary" busy={saving} disabled={Boolean(kurang)} disabledReason={kurang} onClick={() => void doSaveStatus()}>Simpan &amp; lanjut</Button>}
        </FooterToolbar>;
    } else if (step === 2) {
        const kurang = !allMerchDone ? `Lengkapi ${MERCH_STEPS.length - nMerch} butir lagi` : tanpaIzin;
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="fi-title-3">Merchandising wajib</h2>
                        <StatusBadge tone={allMerchDone ? "pos" : "neu"}>{nMerch} dari {MERCH_STEPS.length}</StatusBadge>
                    </div>
                    <p className="fi-small fi-muted">Keenam butir wajib dicentang sebelum check-out. Foto bukti per butir otomatis mencentang butirnya.</p>
                </div>
                <ul aria-label="Merchandising" className="fi-panel" style={{ listStyle: "none", gap: 0, padding: "4px 16px" }}>
                    {MERCH_STEPS.map(({ key, label }) => {
                        const id = `merch-${key}`;
                        return (
                            <li key={key} className="grid items-center gap-3" style={{ gridTemplateColumns: "auto minmax(0,1fr) auto", minHeight: 56, borderBottom: "1px solid var(--line)", padding: "6px 0" }}>
                                <input id={id} type="checkbox" checked={Boolean(merch[key])} disabled={saving}
                                    onChange={() => { setMerchPersisted(false); setGalat(""); setMerch((p) => ({ ...p, [key]: !p[key] })); }}
                                    style={{ width: 24, height: 24, minHeight: 0, margin: 0, accentColor: "var(--primary)" }} />
                                <label htmlFor={id} style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", overflowWrap: "anywhere" }}>{label}</label>
                                <FotoBukti kecil label="Foto" judulGagal="Foto bukti belum terkirim." akibat="Butir ini belum berfoto."
                                    existingUrl={stepPhotos[key]} salesName={store.salesName} custName={store.custName} disabledReason={tanpaIzin}
                                    onPersist={async (url) => {
                                        setMerchPersisted(false);
                                        setStepPhotos((p) => ({ ...p, [key]: url }));
                                        setMerch((p) => ({ ...p, [key]: true })); // foto = bukti → otomatis dicentang
                                    }} />
                            </li>
                        );
                    })}
                </ul>
                {galat && <MessageStrip tone="neg" title="Gagal menyimpan.">{galat}</MessageStrip>}
            </div>
        );
        kaki = <FooterToolbar message={kurang ?? (merchPersisted ? "Merchandising sudah tersimpan." : undefined)}>
            {tombolKembali(2)}
            <Button variant="primary" busy={saving} disabled={Boolean(kurang)} disabledReason={kurang} onClick={() => void doSaveMerch()}>
                {merchPersisted ? "Lanjut" : "Simpan & lanjut"}
            </Button>
        </FooterToolbar>;
    } else if (step === 3) {
        // #8 di UI: check-out hanya setelah check-in (langkah ini hanya terbuka setelah check-in + status + merch tersimpan).
        const terkunci = !checkinDone ? "Check-in dulu sebelum check-out" : tanpaIzin;
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel">
                    <h2 className="fi-title-3">Ringkasan kunjungan</h2>
                    <KeyValues items={[
                        ["Check-in", checkinAt ? `${jamWita(checkinAt)} WITA` : "Tercatat"],
                        ["Status", ao?.status === "not_order" && ao.noOrderReasonCode ? `TIDAK ORDER · ${alasanLabel(ao.noOrderReasonCode)}` : statusTeks(ao?.status)],
                        ["Merchandising", `${nMerch} dari ${MERCH_STEPS.length} · ${Object.keys(stepPhotos).length} foto`],
                    ]} />
                </div>
                <div className="fi-panel">
                    <h2 className="fi-title-3">Foto check-out</h2>
                    <p className="fi-small fi-muted">Foto bukti selesai kunjungan.</p>
                    <FotoBukti label="Ambil foto check-out" judulGagal="Foto check-out belum terkirim." akibat="Langkah ini belum maju; check-out belum dipastikan tercatat."
                        salesName={store.salesName} custName={store.custName} disabledReason={terkunci} onPersist={(url) => doCheckout(url)} />
                </div>
                <VariantNote bl="BL-28">Server belum menolak check-out tanpa check-in; layar ini yang menjaganya. Cap foto dibakar server dalam WIB (Asia/Jakarta). Usulan: tanggal dan cap WITA dari server, check-in ulang tersimpan sebagai riwayat.</VariantNote>
            </div>
        );
        kaki = <FooterToolbar message="Kunjungan selesai setelah foto check-out tersimpan.">{tombolKembali(3)}</FooterToolbar>;
    } else {
        const durasi = checkinAt && checkoutAt ? Math.max(0, Math.round((new Date(checkoutAt).getTime() - new Date(checkinAt).getTime()) / 60000)) : null;
        isi = (
            <div className="grid gap-4">
                <MessageStrip tone="pos" title="Kunjungan selesai.">Tersimpan di server; SPV melihatnya di dashboard.</MessageStrip>
                <div className="fi-panel">
                    <KeyValues items={[
                        ["Waktu", checkinAt && checkoutAt ? `${jamWita(checkinAt)}–${jamWita(checkoutAt)} WITA (${durasi} menit)` : "Tercatat"],
                        ["Status", statusTeks(ao?.status)],
                        ["Merchandising", `${nMerch} dari ${MERCH_STEPS.length}`],
                    ]} />
                </div>
                <VariantNote bl="BL-43">Order dari kunjungan belum tertaut ke kunjungannya. Usulan: tombol “Buat order untuk toko ini” membuka Order Sales dengan toko ini terisi dan order tersimpan bersama kunjungan.</VariantNote>
            </div>
        );
        kaki = <FooterToolbar><Button variant="primary" icon={<ArrowLeft className="fi-icon" aria-hidden />} onClick={kembali}>Kembali ke rute</Button></FooterToolbar>;
    }

    return (
        <div>
            <ObjectPageHeader
                breadcrumbs={[{ label: "Rute hari ini", href: "/form-kontrol?tab=ao" }, { label: "Kunjungan" }]}
                title={store.custName}
                status={checkoutDone ? <StatusBadge tone="pos">Selesai</StatusBadge> : checkinDone ? <StatusBadge tone="info">Sedang dikunjungi</StatusBadge> : undefined}
                draft={draf}
                attributes={[
                    { label: "Kode", value: <span className="fi-mono">{store.custCode}</span> },
                    { label: "Principal", value: store.principle },
                    { label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` },
                    ...(store.alamat || store.market ? [{ label: "Alamat", value: [store.market, store.alamat, store.kota].filter(Boolean).join(" · ") }] : []),
                    { label: "Frekuensi", value: `${store.visitFrequency}×/bulan` },
                ]}
                flow={step < 4 ? <><Flow steps={flow} label="Langkah kunjungan" /><span className="fi-small fi-subtle">Langkah {step + 1} dari 4 · {LANGKAH[step]}</span></> : undefined}
            />
            <div className="fi-page" style={{ maxWidth: "46rem" }}>
                {tanpaIzin && <MessageStrip tone="warn" title="Hanya lihat.">{tanpaIzin}</MessageStrip>}
                {isi}
            </div>
            {kaki}
        </div>
    );
}

/** Status tersimpan → pilihan wizard (kode lama: selain ordered/active — termasuk priority — dianggap tidak order). */
function awalDari(s: string): "ordered" | "not_order" {
    return s === "ordered" || s === "active" ? "ordered" : "not_order";
}
