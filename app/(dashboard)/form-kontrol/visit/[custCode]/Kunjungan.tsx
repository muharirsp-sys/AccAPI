/*
 * Tujuan: Wizard Kunjungan toko (Fiori S5, it05): Check-in → Status → Merchandising → Check-out, Kembali di setiap langkah, status
 *   tersimpan tampil lagi, galat di langkahnya (langkah tidak maju), foto tetap di layar bila tanpa sinyal. Toko tutup (R15, owner 8 Okt,
 *   kontrak #132): Tidak order + alasan R15 → merchandising DILEWATI → foto bukti toko tutup (= foto check-out, wajib) → selesai tanpa order.
 * Caller: ./page.tsx (rute /form-kontrol/visit/[custCode]?salesCode&principle&date).
 * Owner 13 Nov 2026: Status — sales tipe principal mencatat nomor order di sistem principal, tipe AccAPI diarahkan ke Order Sales; Merchandising
 *   — blok Item super (saran wajib: ditawarkan → dipesan → alasan), dikirim bersama merchandising (server memeriksa ulang).
 * Dependensi: GET /api/form-kontrol/visit + /reasons + /item-super/saran; POST /api/form-kontrol/checkin, /ao-control, /merchandising, /checkout;
 *   ./FotoBukti; ../../lapangan (ambilJson, kirimFk, sebabGagal, PESAN_SINYAL), ../../shared (alasanIzinFk, rentangWita); components/fiori/*; lib/rekapan-nota/ui; lib/tampil (KOSONG, waktuWita).
 * Main Functions: Kunjungan (muat/kosong/galat), Wizard (langkah), MERCH_STEPS.
 * Side Effects: HTTP baca/tulis kunjungan; kamera/lokasi lewat FotoBukti. Langkah hanya maju setelah simpan sukses. Payload sama dengan
 *   wizard lama. FK-MSM3: 409 KUNJUNGAN_DIBATALKAN / BUKAN_RUTE_HARI_INI (toko tidak lagi di rute) → wizard diganti penjelasan (judul per kode,
 *   isian yang tidak tersimpan disebut, fokus ke penjelasan) + Rute hari ini langsung di bagian Kunjungan luar rute (`#luar-rute`).
 * Owner 14 Nov 2026: kepala menampilkan alamat + tombol Google Maps (lib/form-kontrol/peta.ts; titik toko_koordinat dari GET visit `titik`);
 *   GPS WAJIB saat check-in dan check-out (FotoBukti `wajibLokasi`; server menolak tanpa titik 400 GPS_WAJIB) — titik check-out ikut terkirim.
 * Dua alur order (owner 14 Nov 2026): lima langkah Check-in → Status → Order → Merchandising → Check-out (./langkah). Status ORDER tersimpan =
 *   halaman order (./order) dibuka OTOMATIS: stok toko, item super wajib ditawarkan dulu, lalu Kirim order (salesman AccAPI) atau "Sudah input
 *   order" (salesman sistem principal). Langkah Order selesai = ao.orderDicatatPada (server); TIDAK ORDER melewati Order dan menjawab item super
 *   di Merchandising seperti semula. Nomor order principal pindah ke halaman order. Kepala menampilkan limit kredit toko.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// NOO (owner 13 Okt 2026, P7): kunjungan toko baru (kode NOO) = hanya "Tidak order" + alasan; server menolak ORDER (409 NOO_BELUM_TERDAFTAR).
import { isKodeNoo } from "@/lib/form-kontrol/noo-aturan";
import { ArrowLeft, MapPin, ShoppingCart, XCircle } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, KeyValues, MessageStrip, ObjectPageHeader, Skeleton, StatusBadge, VariantNote,
    type FlowStep,
} from "@/components/fiori/core";
import { FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { TOKO_TUTUP_CODE } from "@/lib/form-kontrol/constants";
import type { GeoCoords } from "@/lib/form-kontrol/location";
import { nomorDariRef, type LimitToko } from "@/lib/form-kontrol/order-kunjungan";
import { alamatRingkas, punyaTitik, teksRealisasi, urlPeta } from "@/lib/form-kontrol/peta";
import { LABEL_STATUS_TITIK, RADIUS_M, statusTitik, type StatusTitik } from "@/lib/form-kontrol/radius";
import { GagalKirim, PESAN_SINYAL, ambilJson, ditolakBukanRute, kirimFk, sebabGagal } from "../../lapangan";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { alasanIzinFk, hariIniWita, rentangWita } from "../../shared";
import FotoBukti from "./FotoBukti";
import { ItemSuperBlok, ambilSaran, isianTawaran, jawabanAwal, jumlahBelum, ringkasItemSuper, ubahJawabanDi, type ItemSuperInfo, type Jawaban } from "./ItemSuper";
import { L, LANGKAH, TeksLimit, bacaLimit, urlOrderKunjungan } from "./langkah";

interface StoreInfo {
    id: string; salesCode: string; salesName: string;
    custCode: string; custName: string;
    market: string | null; alamat: string | null; kota: string | null;
    principle: string; visitFrequency: number;
    /** JKS Web-LL: target toko per bulan (termasuk PPN); null = JKS lama / luar rute. */
    targetToko?: number | null;
    /** FK-MSM2: kunjungan luar rute (toko tidak di JKS; ditambahkan salesman hari itu). */
    luarRute?: boolean;
}
interface AoInfo {
    id: string; status: string;
    noOrderReasonCode: string | null; noOrderNote: string | null;
    checkinAt: string | null; checkinPhotoUrl: string | null;
    checkoutAt: string | null; checkoutPhotoUrl: string | null;
    /** Sales tipe principal (owner 13 Nov 2026): nomor order di sistem principal (kolom invoice_number). */
    invoiceNumber?: string | null;
    /** Langkah Order kunjungan selesai (0043): websales:<id>[,…] | principal; null = belum. */
    orderRef?: string | null;
    orderDicatatPada?: string | null;
}
interface MerchInfo {
    produkJelas: boolean; displayRapi: boolean; dibersihkan: boolean;
    ditataulang: boolean; posisiMudah: boolean; semuaSku: boolean;
    stepPhotos: Record<string, string> | null;
}
interface Reason { id: string; reasonCode: string; label: string; category: string }
/** Penolakan "toko tidak (lagi) di rute": kode server, kalimatnya, dan tahapnya — `awal` = dari GET visit, sebelum foto check-in diambil. */
type BukanRute = { kode: string; pesan: string; tahap: "awal" | "checkin" | "lanjut" };
type Data = { store: StoreInfo | null; ao: AoInfo | null; merch: MerchInfo | null; reasons: Reason[]; bukanRute: BukanRute | null;
    /** Dua tipe sales (owner 13 Nov 2026). */
    sumberOrder: "accapi" | "principal";
    /** null = saran item super gagal dimuat (`saranGalat`): halaman tetap terbuka, hanya Simpan merchandising yang menunggu muat ulang saran. */
    itemSuper: ItemSuperInfo | null; saranGalat: string | null;
    /** Titik toko (toko_koordinat) + status radius untuk tombol Google Maps; null = peta mencari nama + alamat, tanpa radius. */
    titik: { lat: number; lng: number; status: StatusTitik } | null;
    /** Realisasi faktur Accurate bulan berjalan (owner 14 Nov 2026); null = server lama. */
    realisasi: { total: number; faktur: number } | null;
    /** Limit kredit toko (owner 14 Nov 2026); null = tidak diketahui (tidak tampil). */
    limit: LimitToko | null };

/** `bukanRute` dari GET visit (FK-MSM3) → BukanRute tahap awal; bentuk lain = tidak ada penolakan. */
function luarRuteAwal(v: unknown): BukanRute | null {
    const b = v as { kode?: unknown; error?: unknown } | null;
    return b && typeof b.kode === "string" && typeof b.error === "string" ? { kode: b.kode, pesan: b.error, tahap: "awal" } : null;
}

const MERCH_STEPS: { key: keyof Omit<MerchInfo, "stepPhotos">; label: string }[] = [
    { key: "produkJelas", label: "Produk terlihat jelas" },
    { key: "displayRapi", label: "Display rapi & terorganisir" },
    { key: "dibersihkan", label: "Area display dibersihkan" },
    { key: "ditataulang", label: "Produk ditata ulang" },
    { key: "posisiMudah", label: "Posisi mudah ditemukan konsumen" },
    { key: "semuaSku", label: "Seluruh SKU terpajang" },
];
/** `izinFk` = kunci izin form_kontrol.* akun (dari server); penguncian tombol mengikuti alasanIzinFk seperti tab Form Kontrol. */
type Props = { custCode: string; salesCode: string; principle: string; date: string; izinFk: string[] };

export default function Kunjungan(props: Props) {
    const { custCode, salesCode, principle, date } = props;
    const router = useRouter();
    const loader = useCallback(async (): Promise<Load<Data>> => {
        const p = new URLSearchParams({ salesCode, custCode, principle, date });
        const [v, r, s] = await Promise.all([ambilJson(`/api/form-kontrol/visit?${p}`), ambilJson("/api/form-kontrol/reasons"), ambilSaran(p)]);
        const tanpaSinyal = `${PESAN_SINYAL} Ini bukan toko kosong; coba lagi saat ada sinyal.`;
        // 404 = toko tidak ada di JKS salesman/principal ini → Kosong, bukan Galat.
        if (v.status === 404) return { status: "siap", data: { store: null, ao: null, merch: null, reasons: [], bukanRute: null, sumberOrder: "accapi", itemSuper: null, saranGalat: null, titik: null, realisasi: null, limit: null } };
        if (v.status === 400) return { status: "galat", error: "Kode salesman atau principal tidak terbawa. Buka kunjungan dari Rute hari ini." };
        if (v.status < 200 || v.status >= 300 || !v.data) return { status: "galat", error: v.status === 0 ? tanpaSinyal : sebabGagal(v.status) };
        if (r.status < 200 || r.status >= 300 || !r.data) return { status: "galat", error: `Daftar alasan tidak order gagal dimuat. ${r.status === 0 ? tanpaSinyal : sebabGagal(r.status)}` };
        return {
            status: "siap",
            data: {
                store: (v.data.store as StoreInfo) ?? null, ao: (v.data.ao as AoInfo) ?? null, merch: (v.data.merch as MerchInfo) ?? null,
                reasons: (Array.isArray(r.data.rows) ? r.data.rows : []) as Reason[],
                bukanRute: luarRuteAwal(v.data.bukanRute),
                sumberOrder: v.data.sumberOrder === "principal" ? "principal" : "accapi",
                itemSuper: "info" in s ? s.info : null, saranGalat: "galat" in s ? s.galat : null,
                titik: v.data.titik && typeof v.data.titik === "object" && punyaTitik(v.data.titik as { lat?: number; lng?: number })
                    ? { ...v.data.titik as { lat: number; lng: number }, status: statusTitik((v.data.titik as { status?: unknown }).status) } : null,
                realisasi: v.data.realisasi && typeof (v.data.realisasi as { total?: unknown }).total === "number"
                    ? v.data.realisasi as { total: number; faktur: number } : null,
                limit: bacaLimit(v.data.limit),
            },
        };
    }, [salesCode, custCode, principle, date]);
    const [load, muatUlang] = useLoad(loader);
    const kembali = () => router.back();
    // FK-MSM3: server menolak tulis karena toko tidak (lagi) di rute tanggal ini (kunjungan luar rute dibatalkan di layar lain / bukan JKS
    // hari itu) → wizard diganti penjelasan + jalan ke Rute hari ini (dimuat ulang dari server), bukan galat yang bisa diulang.
    const [ditolak, setBukanRute] = useState<BukanRute | null>(null);
    // Penolakan saat menulis menang; tanpa itu, penolakan dari GET visit (toko sudah di luar rute saat layar dibuka) — wizard tidak dibuka.
    const bukanRute = ditolak ?? (load.data?.store ? load.data.bukanRute : null);
    const fokusBukanRute = useRef<HTMLDivElement>(null);
    const adaPenjelasan = Boolean(bukanRute);
    useEffect(() => { if (adaPenjelasan) fokusBukanRute.current?.focus(); }, [adaPenjelasan]);

    const crumbs = [{ label: "Rute hari ini", href: "/form-kontrol?tab=ao" }, { label: "Kunjungan" }];
    if (bukanRute) {
        const judul = bukanRute.kode === "KUNJUNGAN_DIBATALKAN" ? "Kunjungan luar rute ini sudah dibatalkan"
            : `Toko ini tidak ada di rute ${date === hariIniWita() ? "hari ini" : "tanggal ini"}`;
        const isian = { awal: "Kunjungan tidak bisa dimulai dari layar ini.", checkin: "Check-in ini tidak tercatat.",
            lanjut: "Isian di layar ini tidak tersimpan; check-in yang sudah dikirim tetap tercatat." }[bukanRute.tahap];
        return (
            <div>
                <ObjectPageHeader breadcrumbs={crumbs} title={load.data?.store?.custName ?? custCode} attributes={[{ label: "Tanggal", value: `${tanggalPanjang(date)} · WITA` }]} />
                <div className="fi-page" style={{ maxWidth: "46rem" }} ref={fokusBukanRute} tabIndex={-1}>
                    <EmptyState title={judul} message={`${bukanRute.pesan} ${isian}`}
                        action={<Link className="fi-btn fi-btn--secondary" href="/form-kontrol?tab=ao#luar-rute"><ArrowLeft className="fi-icon" aria-hidden />Rute hari ini</Link>} />
                </div>
            </div>
        );
    }
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
                        message={`Kunjungan hanya bisa dibuat untuk toko di JKS ${salesCode || "salesman"} untuk ${principle || "principal ini"}, atau toko yang ditambahkan sebagai kunjungan luar rute pada tanggal ini. Kembali ke Rute hari ini lalu tambahkan lewat Kunjungan luar rute.`}
                        action={<Link className="fi-btn fi-btn--secondary" href="/form-kontrol?tab=ao#luar-rute"><ArrowLeft className="fi-icon" aria-hidden />Rute hari ini</Link>} />
                </div>
            </div>
        );
    }
    return <Wizard {...props} data={load.data} store={load.data.store} kembali={kembali} onBukanRute={setBukanRute} />;
}

function Wizard({ salesCode, custCode, principle, date, izinFk, data, store, kembali, onBukanRute }: Props & {
    data: Data; store: StoreInfo; kembali: () => void; onBukanRute: (b: BukanRute) => void;
}) {
    const awalStatus = data.ao?.status && data.ao.status !== "not_visited" ? awalDari(data.ao.status) : null;
    const [ao, setAo] = useState<AoInfo | null>(data.ao);
    const [checkinPhoto, setCheckinPhoto] = useState<string | null>(data.ao?.checkinPhotoUrl ?? null);
    const [checkinAt, setCheckinAt] = useState<string | null>(data.ao?.checkinAt ?? null);
    const [checkoutPhoto, setCheckoutPhoto] = useState<string | null>(data.ao?.checkoutPhotoUrl ?? null);
    const [checkoutAt, setCheckoutAt] = useState<string | null>(data.ao?.checkoutAt ?? null);
    const noo = isKodeNoo(custCode);
    const pilihanHasil: ("ordered" | "not_order")[] = noo ? ["not_order"] : ["ordered", "not_order"];
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
    // Dua tipe sales (owner 13 + 14 Nov 2026): input order di AccAPI atau di sistem principal; keduanya lewat halaman order kunjungan.
    const principalSales = data.sumberOrder === "principal";
    const router = useRouter();
    const urlOrder = urlOrderKunjungan({ custCode, salesCode, principle, date });
    // Item super: saran (bisa dimuat ulang tanpa membuang isian) + jawaban per saran (wajib + lain), awal = yang tersimpan untuk kunjungan ini.
    const [saranIs, setSaranIs] = useState<ItemSuperInfo | null>(data.itemSuper);
    const [galatSaran, setGalatSaran] = useState<string | null>(data.saranGalat);
    const [memuatSaran, setMemuatSaran] = useState(false);
    const [jawaban, setJawaban] = useState<Record<string, Jawaban>>(() => jawabanAwal(data.itemSuper, {}));
    const isKurang = jumlahBelum(saranIs, jawaban);
    const ubahJawaban = (kode: string, patch: Partial<Jawaban>) => {
        setMerchPersisted(false); setGalat("");
        setJawaban((p) => ubahJawabanDi(p, kode, patch));
    };
    /** Muat ulang saran (galat awal / daftar berubah di server); jawaban yang sudah diisi dipertahankan, item baru kosong. */
    async function muatUlangSaran(): Promise<boolean> {
        setMemuatSaran(true);
        const s = await ambilSaran(new URLSearchParams({ salesCode, custCode, principle, date }));
        setMemuatSaran(false);
        if ("galat" in s) { setGalatSaran(s.galat); return false; }
        setSaranIs(s.info); setGalatSaran(null);
        setJawaban((p) => jawabanAwal(s.info, p));
        return true;
    }

    const nMerch = MERCH_STEPS.filter((s) => merch[s.key]).length;
    const allMerchDone = nMerch === MERCH_STEPS.length;
    const checkinDone = Boolean(checkinPhoto || ao?.checkinPhotoUrl);
    const checkoutDone = Boolean(checkoutPhoto || ao?.checkoutPhotoUrl);
    // Order kunjungan yang sudah tercatat (halaman order) = status ORDER sudah dikonfirmasi pada kunjungan ini: kembali dari halaman order tidak
    // meminta konfirmasi status lagi.
    const statusDone = checkoutDone || statusConfirmed || ((ao?.status === "ordered" || ao?.status === "active") && Boolean(ao?.orderDicatatPada));
    // Toko tutup TERSIMPAN (status di server, bukan pilihan yang belum disimpan): server tidak mewajibkan merchandising (#132), jadi langkah
    // itu dilewati dan foto check-out menjadi foto bukti toko tutup yang wajib.
    const tutup = ao?.status === "not_order" && ao.noOrderReasonCode === TOKO_TUTUP_CODE;
    // ORDER TERSIMPAN = langkah Order wajib (halaman order); selesai bila server mencatat order_dicatat_pada. TIDAK ORDER melewati Order.
    const orderTersimpan = ao?.status === "ordered" || ao?.status === "active";
    const orderDone = !orderTersimpan || Boolean(ao?.orderDicatatPada);
    const maks = checkoutDone ? L.selesai
        : checkinDone && statusDone && orderDone && (tutup || (allMerchDone && merchPersisted)) ? L.checkout
            : checkinDone && statusDone && orderDone ? L.merch
                : checkinDone && statusDone ? L.order : checkinDone ? L.status : L.checkin;
    // `lihat` = langkah yang dibuka lewat Kembali; tidak pernah melewati langkah terjauh yang sudah tersimpan.
    const step = maks === L.selesai ? L.selesai : Math.min(lihat ?? maks, maks);
    const tersimpanStatus = { status: (ao?.status && ao.status !== "not_visited") ? awalDari(ao.status) : null, code: ao?.noOrderReasonCode ?? "", note: ao?.noOrderNote ?? "" };
    const drafStatus = orderStatus !== tersimpanStatus.status
        || (orderStatus === "not_order" && (reasonCode !== tersimpanStatus.code || reasonNote !== tersimpanStatus.note));
    const adaJawaban = Object.values(jawaban).some((j) => j.ditawarkan !== null);
    const draf = !checkoutDone && ((drafStatus && orderStatus !== null) || (!tutup && !merchPersisted && (nMerch > 0 || adaJawaban)));
    useUnsavedGuard(draf);

    const tanpaIzin = alasanIzinFk(new Set(izinFk), "submit");
    const pindah = (s: number | null) => { setGalat(""); setLihat(s); };
    /** Tahap yang diajukan ke IT di sesi ini (lokasi di luar radius titik toko). */
    const [ajuanIt, setAjuanIt] = useState<string[]>([]);
    const radiusTeks = data.titik ? `Check-in dan check-out harus dalam ${RADIUS_M[data.titik.status]} m dari titik toko (${LABEL_STATUS_TITIK[data.titik.status].toLowerCase()}).`
        : "Toko belum punya titik: lokasi check-in Anda dicatat sebagai bahan titik toko.";

    async function doCheckin(url: string, coords: GeoCoords | null, alasan?: string) {
        try {
            const d = await kirimFk("/api/form-kontrol/checkin", {
                salesCode, custCode, principle, date, photoUrl: url,
                lat: coords?.lat ?? null, lng: coords?.lng ?? null, accuracy: coords?.accuracy ?? null,
                ...(alasan ? { alasanLuarRadius: alasan } : {}),
            }, { ulangAman: true });
            if (d.diajukanKeIt === true) setAjuanIt((x) => [...x.filter((t) => t !== "check-in"), "check-in"]);
        } catch (e) {
            if (ditolakBukanRute(e)) onBukanRute({ kode: e.kode ?? "", pesan: e.message, tahap: "checkin" });
            throw e;
        }
        setCheckinPhoto(url);
        setCheckinAt(new Date().toISOString()); // tampilan saja; jam resmi = server (BL-28)
        pindah(null);
    }

    async function doSaveStatus() {
        if (!orderStatus || (orderStatus === "not_order" && !reasonCode) || saving) return;
        setSaving(true);
        setGalat("");
        try {
            // Nomor order principal tidak dikirim dari sini lagi (pindah ke halaman order; kunci absen = tidak diubah server).
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
            // ORDER yang ordernya belum tercatat = halaman order dibuka OTOMATIS (owner 14 Nov 2026). Toko tutup langsung ke foto bukti;
            // TIDAK ORDER lain ke Merchandising seperti biasa.
            if (orderStatus === "ordered" && !ao?.orderDicatatPada) { router.push(urlOrder); return; }
            pindah(lihat === null || (orderStatus === "not_order" && reasonCode === TOKO_TUTUP_CODE) ? null : L.merch);
        } catch (e) {
            if (ditolakBukanRute(e)) return onBukanRute({ kode: e.kode ?? "", pesan: e.message, tahap: "lanjut" });
            setGalat(`Status belum tersimpan. ${e instanceof Error ? e.message : ""}`.trim());
        } finally { setSaving(false); }
    }

    async function doSaveMerch() {
        if (!allMerchDone || !saranIs || isKurang > 0 || saving) return;
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
                // Item super (owner 13 Nov 2026): semua saran wajib + saran lain yang dijawab lengkap; server memeriksa ulang. Kunjungan ORDER
                // menjawabnya di halaman order: jawaban tersimpan itu (dimuat dari server) yang dikirim ulang di sini.
                itemSuper: isianTawaran(jawaban),
            }, { ulangAman: true });
            setMerchPersisted(true);
            pindah(null);
        } catch (e) {
            if (ditolakBukanRute(e)) return onBukanRute({ kode: e.kode ?? "", pesan: e.message, tahap: "lanjut" });
            // Daftar saran wajib di server berubah sejak layar dibuka (unggahan item super baru / riwayat beli): muat ulang saran, isian tetap.
            if (e instanceof GagalKirim && e.kode === "ITEM_SUPER_BELUM_LENGKAP" && await muatUlangSaran()) {
                setGalat("Merchandising belum tersimpan: daftar item super berubah sejak layar dibuka. Jawab item yang belum terisi lalu simpan lagi.");
                return;
            }
            // #7: galat merchandising tampil di langkah ini dan langkah tidak maju (dulu diam lalu muncul "Gagal check-out").
            setGalat(`Merchandising belum tersimpan. ${e instanceof Error ? e.message : ""}`.trim());
        } finally { setSaving(false); }
    }

    async function doCheckout(url: string, coords: GeoCoords | null, alasan?: string) {
        const d = await kirimFk("/api/form-kontrol/checkout", { salesCode, custCode, principle, date, photoUrl: url,
            lat: coords?.lat ?? null, lng: coords?.lng ?? null, accuracy: coords?.accuracy ?? null, ...(alasan ? { alasanLuarRadius: alasan } : {}) }, { ulangAman: true });
        if (d.diajukanKeIt === true) setAjuanIt((x) => [...x.filter((t) => t !== "check-out"), "check-out"]);
        setCheckoutPhoto(url);
        setCheckoutAt(new Date().toISOString());
    }

    // TIDAK ORDER tersimpan (statusDone) = langkah Order dilewati; toko tutup juga melewati Merchandising.
    const lewatOrder = statusDone && !orderTersimpan;
    const flow: FlowStep[] = LANGKAH.map((label, i) => ({
        label: lewatOrder && i === L.order ? "Order dilewati" : tutup && i === L.merch ? "Merchandising dilewati" : tutup && i === L.checkout ? "Foto bukti & check-out" : label,
        state: i < maks && i !== step ? "done" : i === step ? "current" : "todo",
    }));
    /** Kembali dari langkah `s`: langkah yang dilewati (Order untuk TIDAK ORDER, Merchandising untuk toko tutup) ikut dilompati. */
    const sebelum = (s: number) => {
        let k = s - 1;
        if (k === L.merch && tutup) k--;
        if (k === L.order && !orderTersimpan) k--;
        return k;
    };
    const statusTeks = (s: string | null | undefined) => s === "ordered" || s === "active" ? "ORDER" : s ? "TIDAK ORDER" : KOSONG;
    const teksOrder = !ao?.orderDicatatPada ? "Belum tercatat"
        : ao.orderRef === "principal" ? `Diinput di sistem ${store.principle}${ao.invoiceNumber ? ` · No. ${ao.invoiceNumber}` : ""}`
            : `Order ${nomorDariRef(ao.orderRef).join(", ")}`;
    const alasanLabel = (code: string) => { const r = data.reasons.find((x) => x.reasonCode === code); return r ? `${r.reasonCode} · ${r.label}` : code; };
    const kartuCheckin = (
        <KeyValues items={[
            ["Check-in", checkinAt ? `${waktuWita(checkinAt)} WITA` : "Tercatat"],
            ...(checkinPhoto ? [["Foto", "tersimpan · lokasi dan waktu dicap server"] as [string, ReactNode]] : []),
        ]} />
    );
    const tombolKembali = (s: number) => (
        <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} disabled={saving} onClick={() => (s === 0 ? kembali() : pindah(sebelum(s)))}>
            {s === 0 ? "Rute hari ini" : "Kembali"}
        </Button>
    );

    let isi: ReactNode;
    let kaki: ReactNode = null;
    if (step === L.checkin) {
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
                <p className="fi-small fi-muted">Foto di depan toko sebagai bukti check-in (wajib). GPS ponsel wajib menyala: titik Anda dicatat untuk analisa kunjungan. {radiusTeks}</p>
                <FotoBukti wajibLokasi label="Ambil foto check-in" judulGagal="Foto check-in belum terkirim." akibat="Langkah ini belum maju; check-in belum dipastikan tercatat."
                    salesName={store.salesName} custName={store.custName} disabledReason={tanpaIzin} onPersist={doCheckin} />
            </div>
        );
        kaki = <FooterToolbar message={checkinDone ? undefined : "Langkah maju setelah foto check-in tersimpan."}>
            {tombolKembali(0)}
            {checkinDone && <Button variant="primary" onClick={() => pindah(L.status)}>Lanjut</Button>}
        </FooterToolbar>;
    } else if (step === L.status) {
        const kurang = !orderStatus ? "Pilih hasil kunjungan" : orderStatus === "not_order" && !reasonCode ? "Pilih alasan tidak order" : tanpaIzin;
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel">{kartuCheckin}</div>
                <div className="fi-panel">
                    <h2 className="fi-title-3">Hasil kunjungan</h2>
                    {statusConfirmed && !drafStatus && <p className="fi-small fi-muted">Tersimpan: {statusTeks(ao?.status)}.</p>}
                    {noo && (
                        <MessageStrip tone="info" title="Toko baru (NOO), belum terdaftar di Accurate:">
                            hasil kunjungan hanya Tidak order dengan alasan. Order bisa dibuat sesudah Admin mendaftarkan toko dan menautkannya.
                        </MessageStrip>
                    )}
                    <div className={`grid ${noo ? "grid-cols-1" : "grid-cols-2"} gap-3`} role="radiogroup" aria-label="Hasil kunjungan">
                        {pilihanHasil.map((s) => (
                            <label key={s} className="fi-btn fi-btn--secondary" style={{ height: "auto", minHeight: 64, flexDirection: "column", gap: 6, whiteSpace: "normal",
                                ...(orderStatus === s ? { background: s === "ordered" ? "var(--pos-bg)" : "var(--neg-bg)", borderColor: s === "ordered" ? "var(--pos)" : "var(--neg)", color: s === "ordered" ? "var(--pos)" : "var(--neg)" } : {}) }}>
                                <input type="radio" name="hasil-kunjungan" value={s} checked={orderStatus === s} onChange={() => { setOrderStatus(s); setGalat(""); }}
                                    style={{ width: 20, height: 20, minHeight: 0, minWidth: 0, margin: 0, accentColor: "var(--primary)" }} />
                                {s === "ordered" ? <ShoppingCart className="fi-icon" aria-hidden /> : <XCircle className="fi-icon" aria-hidden />}
                                {s === "ordered" ? "ORDER" : "TIDAK ORDER"}
                            </label>
                        ))}
                    </div>
                    {orderStatus === "ordered" && !noo && (
                        <MessageStrip tone="info" title="Berikutnya halaman order:">
                            isi stok toko, tawarkan item super, lalu {principalSales
                                ? `input order di sistem ${store.principle} dan tekan Sudah input order. Tidak ada yang dikirim ke Accurate dari sini.`
                                : "input dan kirim order toko ini."}
                        </MessageStrip>
                    )}
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
                            {reasonCode === TOKO_TUTUP_CODE && (
                                <MessageStrip tone="info" title="Toko tutup:">
                                    merchandising dilewati. Langkah berikutnya foto bukti toko tutup (wajib) sebagai check-out; kunjungan selesai tanpa order.
                                </MessageStrip>
                            )}
                            {nomorDariRef(ao?.orderRef).length > 0 && (
                                <MessageStrip tone="warn" title="Order kunjungan ini sudah terkirim.">
                                    Order {nomorDariRef(ao?.orderRef).join(", ")} sudah masuk antrean petugas. Mengubah hasil ke TIDAK ORDER tidak membatalkannya;
                                    minta petugas membatalkan order itu bila memang tidak jadi.
                                </MessageStrip>
                            )}
                        </>
                    )}
                </div>
                {galat && <MessageStrip tone="neg" title="Gagal menyimpan.">{galat}</MessageStrip>}
            </div>
        );
        // Status yang sudah dikonfirmasi sesi ini dan tidak diubah → Lanjut tanpa menulis ulang (seperti Merchandising).
        const tanpaUbah = (statusConfirmed || statusDone) && !drafStatus;
        kaki = <FooterToolbar message={tanpaUbah ? "Status sudah tersimpan." : kurang}>
            {tombolKembali(L.status)}
            {tanpaUbah
                ? <Button variant="primary" onClick={() => pindah(tutup ? L.checkout : orderTersimpan ? L.order : L.merch)}>Lanjut</Button>
                : <Button variant="primary" busy={saving} disabled={Boolean(kurang)} disabledReason={kurang} onClick={() => void doSaveStatus()}>
                    {orderStatus === "ordered" && !ao?.orderDicatatPada ? "Simpan & buka order" : "Simpan & lanjut"}
                </Button>}
        </FooterToolbar>;
    } else if (step === L.order) {
        // ORDER tersimpan: pekerjaan order ada di halaman order (dibuka otomatis sesudah Simpan); langkah ini = jalan ke sana + ringkasannya.
        const nomorWs = nomorDariRef(ao?.orderRef);
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel grid gap-3">
                    <h2 className="fi-title-3">Order toko ini</h2>
                    {orderDone ? (
                        <MessageStrip tone="pos" title="Order kunjungan sudah tercatat.">
                            {ao?.orderRef === "principal" || principalSales ? `Diinput di sistem ${store.principle}${ao?.invoiceNumber ? ` (No. ${ao.invoiceNumber})` : ""}.`
                                : `Order ${nomorWs.join(", ")} masuk antrean petugas.`}
                        </MessageStrip>
                    ) : (
                        <p className="fi-small">
                            {principalSales
                                ? `Di halaman order: isi stok toko, tawarkan item super, input order di sistem ${store.principle}, lalu tekan Sudah input order.`
                                : "Di halaman order: isi stok toko, tawarkan item super, lalu input dan kirim order. Sesudah order terkirim Anda kembali ke sini untuk Merchandising."}
                        </p>
                    )}
                    <div><Link className={`fi-btn ${orderDone ? "fi-btn--secondary" : "fi-btn--primary"}`} href={urlOrder}>
                        <ShoppingCart className="fi-icon" aria-hidden />{orderDone ? "Buka lagi halaman order" : "Buka halaman order"}</Link></div>
                </div>
            </div>
        );
        kaki = <FooterToolbar message={orderDone ? undefined : "Langkah maju setelah order kunjungan tercatat di halaman order."}>
            {tombolKembali(L.order)}
            {orderDone && <Button variant="primary" onClick={() => pindah(L.merch)}>Lanjut</Button>}
        </FooterToolbar>;
    } else if (step === L.merch) {
        // Kunjungan ORDER menjawab item super di halaman order; blok itu hanya muncul di sini bila jawabannya belum lengkap (daftar berubah).
        const tampilIs = !orderTersimpan || isKurang > 0 || !saranIs;
        const kurang = !allMerchDone ? `Lengkapi ${MERCH_STEPS.length - nMerch} butir lagi`
            : !saranIs ? "Muat ulang saran item super dulu"
            : isKurang > 0 ? `Jawab ${isKurang} item super lagi` : tanpaIzin;
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
                                <FotoBukti kecil label="Foto" butir={label} judulGagal="Foto bukti belum terkirim." akibat="Butir ini belum berfoto."
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
                {!tampilIs ? null : saranIs
                    ? <ItemSuperBlok info={saranIs} jawaban={jawaban} ubah={ubahJawaban} terkunci={saving || Boolean(tanpaIzin)} isKurang={isKurang} />
                    : (
                        <MessageStrip tone="neg" title="Saran item super belum termuat.">
                            {galatSaran} Merchandising baru bisa disimpan sesudah saran termuat.{" "}
                            <Button variant="tertiary" busy={memuatSaran} onClick={() => void muatUlangSaran()}>Muat ulang saran</Button>
                        </MessageStrip>
                    )}
                {galat && <MessageStrip tone="neg" title="Gagal menyimpan.">{galat}</MessageStrip>}
            </div>
        );
        kaki = <FooterToolbar message={kurang ?? (merchPersisted ? "Merchandising sudah tersimpan." : undefined)}>
            {tombolKembali(L.merch)}
            <Button variant="primary" busy={saving} disabled={Boolean(kurang)} disabledReason={kurang} onClick={() => void doSaveMerch()}>
                {merchPersisted ? "Lanjut" : "Simpan & lanjut"}
            </Button>
        </FooterToolbar>;
    } else if (step === L.checkout) {
        // #8 di UI: check-out hanya setelah check-in (langkah ini hanya terbuka setelah check-in + status + merch tersimpan).
        const terkunci = !checkinDone ? "Check-in dulu sebelum check-out" : tanpaIzin;
        isi = (
            <div className="grid gap-4">
                <div className="fi-panel">
                    <h2 className="fi-title-3">Ringkasan kunjungan</h2>
                    <KeyValues items={[
                        ["Check-in", checkinAt ? `${waktuWita(checkinAt)} WITA` : "Tercatat"],
                        ["Status", ao?.status === "not_order" && ao.noOrderReasonCode ? `TIDAK ORDER · ${alasanLabel(ao.noOrderReasonCode)}` : statusTeks(ao?.status)],
                        ...(orderTersimpan ? [["Order", teksOrder] as [string, ReactNode]] : []),
                        ["Merchandising", tutup ? "Dilewati (toko tutup)" : `${nMerch} dari ${MERCH_STEPS.length} · ${Object.keys(stepPhotos).length} foto`],
                        ...(!tutup && (saranIs?.wajib.length ?? 0) > 0 ? [["Item super", ringkasItemSuper(jawaban)] as [string, ReactNode]] : []),
                    ]} />
                </div>
                <div className="fi-panel">
                    <h2 className="fi-title-3">{tutup ? "Foto bukti toko tutup" : "Foto check-out"}</h2>
                    <p className="fi-small fi-muted">
                        {tutup ? "Wajib: foto tampak depan toko yang tutup. Foto ini dicatat sebagai check-out; kunjungan selesai tanpa order dan tanpa merchandising."
                            : "Foto bukti selesai kunjungan."}
                    </p>
                    <FotoBukti label={tutup ? "Ambil foto bukti toko tutup" : "Ambil foto check-out"} judulGagal={tutup ? "Foto bukti toko tutup belum terkirim." : "Foto check-out belum terkirim."}
                        akibat="Langkah ini belum maju; check-out belum dipastikan tercatat."
                        wajibLokasi salesName={store.salesName} custName={store.custName} disabledReason={terkunci} onPersist={doCheckout} />
                </div>
                <VariantNote bl="BL-28">Server belum menolak check-out tanpa check-in; layar ini yang menjaganya. Cap foto dibakar server dalam WIB (Asia/Jakarta). Usulan: tanggal dan cap WITA dari server, check-in ulang tersimpan sebagai riwayat.</VariantNote>
            </div>
        );
        kaki = <FooterToolbar message={tutup ? "Kunjungan selesai setelah foto bukti toko tutup tersimpan." : "Kunjungan selesai setelah foto check-out tersimpan."}>{tombolKembali(L.checkout)}</FooterToolbar>;
    } else {
        const durasi = checkinAt && checkoutAt ? Math.max(0, Math.round((new Date(checkoutAt).getTime() - new Date(checkinAt).getTime()) / 60000)) : null;
        isi = (
            <div className="grid gap-4">
                <MessageStrip tone="pos" title="Kunjungan selesai.">Tersimpan di server; SPV melihatnya di dashboard.</MessageStrip>
                <div className="fi-panel">
                    <KeyValues items={[
                        ["Waktu", checkinAt && checkoutAt ? `${rentangWita(checkinAt, checkoutAt)} WITA (${durasi} menit)` : "Tercatat"],
                        ["Status", tutup ? `TIDAK ORDER · ${alasanLabel(TOKO_TUTUP_CODE)}` : statusTeks(ao?.status)],
                        ...(orderTersimpan ? [["Order", teksOrder] as [string, ReactNode]] : []),
                        ["Merchandising", tutup ? "Dilewati (toko tutup) · foto bukti tersimpan" : `${nMerch} dari ${MERCH_STEPS.length}`],
                        ...(!tutup && (saranIs?.wajib.length ?? 0) > 0 ? [["Item super", ringkasItemSuper(jawaban)] as [string, ReactNode]] : []),
                    ]} />
                </div>
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
                    { label: "Alamat", value: <span className="flex flex-wrap items-center gap-x-2">
                        <span>{alamatRingkas(store) || KOSONG}</span>
                        <a className="fi-btn fi-btn--tertiary" href={urlPeta({ ...store, ...data.titik })} target="_blank" rel="noopener noreferrer">
                            <MapPin className="fi-icon" aria-hidden />{data.titik ? "Buka peta" : "Cari di peta"}<span className="sr-only"> {store.custName} di Google Maps</span></a>
                    </span> },
                    store.luarRute ? { label: "Jenis", value: <StatusBadge tone="info">{isKodeNoo(store.custCode) ? "Toko baru (NOO)" : "Luar rute"}</StatusBadge> } : { label: "Frekuensi", value: `${store.visitFrequency}×/bulan` },
                    // Owner 14 Nov 2026: realisasi faktur Accurate bulan berjalan s.d. tanggal kunjungan.
                    ...(data.realisasi && /^\d{4}-\d{2}-\d{2}$/.test(date) ? (() => {
                        const bulan = new Intl.DateTimeFormat("id-ID", { month: "long" }).format(new Date(`${date}T00:00:00`));
                        // "750 rb (3 faktur, 50% target)" — label sudah menyebut "Realisasi <bulan>", kata itu tidak diulang di nilainya.
                        const nilai = teksRealisasi({ realisasiBulan: data.realisasi.total, fakturBulan: data.realisasi.faktur, targetToko: store.targetToko }, bulan)
                            .replace(/^realisasi /, "");
                        return [{ label: `Realisasi ${bulan}`, value: nilai }];
                    })() : []),
                    // Owner 14 Nov 2026: limit kredit toko di cabang principal (sisa = limit − piutang sinkron terakhir).
                    ...(data.limit ? [{ label: "Limit kredit", value: <TeksLimit l={data.limit} /> }] : []),
                ]}
                flow={step < L.selesai ? <><div className="fi-flow-lega"><Flow steps={flow} label="Langkah kunjungan" /></div><span className="fi-small fi-subtle">Langkah {step + 1} dari {LANGKAH.length} · {LANGKAH[step]}</span></> : undefined}
            />
            <div className="fi-page" style={{ maxWidth: "46rem" }}>
                {tanpaIzin && <MessageStrip tone="warn" title="Hanya lihat.">{tanpaIzin}</MessageStrip>}
                {ajuanIt.length > 0 && (
                    <MessageStrip tone="info" title="Diajukan ke IT.">
                        Lokasi {ajuanIt.join(" dan ")} Anda di luar radius titik toko. Kunjungan tetap tersimpan dan menunggu persetujuan IT.
                    </MessageStrip>
                )}
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
