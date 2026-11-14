/*
 * Tujuan: "Rute hari ini" (Fiori S5, it05, ponsel dulu): toko JKS hari ini (WITA) dengan kunjungan yang belum selesai paling atas,
 *   progres kunjungan, tanda prioritas, dan "Kirim status rute hari ini" lewat dialog (pengganti tombol Submit AO).
 * Caller: form-kontrol/FormKontrol.tsx (shell tab, default export `({ scope })`).
 * Dependensi: GET/POST /api/form-kontrol/ao-control, ../shared (Scope, AoRow, principalAwal, penjelasanTanpaJks, compareRoute, hariIniWita,
 *   rentangWita, useIzinFk), lib/tampil (waktuWita),
 *   ../lapangan (bacaFk, kirimFk, keBarisRute, simpanRute, useHariBeku), components/fiori/*, lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: TabAo, badgeToko, badgeNoo, susunKiriman.
 * Side Effects: HTTP GET rute; GET ulang + POST ao-control per toko saat Kirim status; sessionStorage daftar toko rute (Order Sales).
 *
 * FK-MSM2: kunjungan LUAR RUTE (./LuarRute TambahLuarRute) — salesman pemilik menambah pelanggan cabangnya ke kunjungan HARI INI; baris itu
 * ikut rute (server, `luarRute`) dengan penanda "Luar rute". Salesman TANPA JKS memakai principal cabang Accurate (my-scope
 * `principalCabang`): rute tidak buntu, penjelasan tetap tampil; tanpa principal cabang = penjelasan + alasan dari server.
 *
 * Kirim status TIDAK dihapus (keputusan orkestrator S5): kunjungan sudah menulis check-in/status/merch/check-out per toko, TETAPI tanda
 * prioritas dan baris "tidak dikunjungi" hanya tertulis lewat kiriman ini, dan Dashboard SPV menghitung "Rute" dari baris AO.
 * Jadwal harian (owner 14 Nov 2026, butir 1): kepala menyebut minggu siklus (M1–M4) tanggal itu; tiap toko menampilkan alamat, target, omzet
 *   rata-rata, Kelas A, dan tombol Google Maps (lib/form-kontrol/peta.ts: titik toko_koordinat, tanpa titik = cari alamat); rute bisa
 *   dibagikan (Web Share / WhatsApp) dan dicetak (jendela cetak) sesuai urutan JKS.
 * Payload per toko sama dengan Submit AO lama (urut, berhenti di galat pertama). Dua penjaga: hanya salesman
 * pemilik rute yang mengirim (peran lain baca-saja), dan rute DIBACA ULANG sesaat sebelum mengirim — status dari bacaan terbaru, hanya
 * tanda bintang sesi ini di atasnya — supaya status kunjungan yang tersimpan sesudah layar dimuat tidak tertimpa.
 * FK-MSM3: tanda yang belum dikirim bertahan melewati muat ulang rute dan membuka Kunjungan lalu kembali (sessionStorage per
 *   salesman|principal|tanggal, S-3); toko yang hilang dari rute disebut, tandanya dibuang.
 *   Server menolak status untuk toko yang tidak lagi di rute (409 KUNJUNGAN_DIBATALKAN / BUKAN_RUTE_HARI_INI) → rute dimuat ulang.
 * Owner 14 Nov 2026 (tampilan terlalu ramai): informasi sama, susunan baru (antislop: satu fokus per kartu = nama + status kunjungan).
 *   Kartu toko: kode + status di baris atas, nama, status kunjungan, alamat, tiga angka (Target, Realisasi bulan, Limit kredit + sisa),
 *   keterangan kecil, lencana; nomor urut JKS TIDAK ditampilkan (urutan daftar tetap; bagikan/cetak tetap bernomor). Kepala: satu baris aksi
 *   ringkas; saringan = kontrol segmen; ringkasan realisasi = dua angka + keterangan.
 */
"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
// NOO (owner 13 Okt 2026): toko baru (belum di Accurate) diajukan dari sini; kunjungannya bertanda NOO dan tidak masuk daftar Order Sales.
import { isKodeNoo, LABEL_STATUS_NOO, type StatusNoo } from "@/lib/form-kontrol/noo-aturan";
import { TambahNoo } from "./NooFormulir";
import { CalendarDays, FileText, MapPin, Printer, RefreshCw, Send, Share2, Star } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, Section, Skeleton, StatusBadge, VariantNote, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { type Scope, type AoRow, LencanaJks, compareRoute, hariIniWita, rentangWita, penjelasanTanpaJks, principalAwal, useIzinFk, visitDurationMin } from "../shared";
import { adaHasilKunjungan, mingguSiklus, statusBintang } from "@/lib/form-kontrol/constants";
import { sisaLimit } from "@/lib/form-kontrol/order-kunjungan";
import { alamatRingkas, htmlRute, punyaTitik, teksRute, urlPeta } from "@/lib/form-kontrol/peta";
import { bacaFk, ditolakBukanRute, keBarisRute, kirimFk, simpanRute, useHariBeku } from "../lapangan";
import { BatalkanLuarRute, TambahLuarRute } from "./LuarRute";

type Saring = "semua" | "belum" | "tidak" | "perhatian";
/**
 * Draf tanda prioritas: kunci rute (salesman|principal|tanggal) → toko → keinginan. `gugur` = dibuang saat rute termuat (toko hilang dari rute /
 * sudah punya hasil kunjungan): tidak berlaku lagi walau toko itu muncul kembali, disebut di strip sampai strip ditutup.
 */
type TandaDraf = { prioritas: boolean; nama: string; gugur?: "hilang" | "hasil" };
type DrafBintang = Record<string, Record<string, TandaDraf>>;
const DRAF_BINTANG = "fk-draf-prioritas";
/** ponytail: sessionStorage tab ini (pola simpanRute); tidak tersedia = draf hanya hidup selama layar ini terbuka. */
function bacaDrafBintang(): DrafBintang {
    try { const v: unknown = JSON.parse(sessionStorage.getItem(DRAF_BINTANG) ?? "{}"); return v && typeof v === "object" ? v as DrafBintang : {}; } catch { return {}; }
}
const sedang = (r: AoRow) => Boolean(r.checkinAt && !r.checkoutAt);

/** Satu badge dominan per toko: ikon + label + warna, tidak pernah warna saja. */
function badgeToko(r: AoRow): { tone: Tone; label: string } {
    if (sedang(r)) return { tone: "info", label: "Lanjutkan" };
    if (r.status === "not_order") return { tone: "neg", label: "Tidak order" };
    if (r.status === "ordered" || r.status === "active") return { tone: "pos", label: "Order" };
    if (r.checkoutAt) return { tone: "pos", label: "Selesai" };
    if (r.isPriority) return { tone: "warn", label: "Prioritas" };
    if (r.needsAttention) return { tone: "warn", label: "Perhatian" };
    return { tone: "neu", label: "Belum" };
}

/**
 * R4: status PENGAJUAN toko baru (NOO) di kartu rute, terpisah dari badge kunjungan di atas; label = LABEL_STATUS_NOO. Toko yang DITOLAK SPV tetap
 * di rute (kunjungannya sudah terjadi) dan diberi tanda jelas + alasan di teks kecil (alasanTolakToko). Tanpa status (bukan NOO / server lama) = null.
 */
const TONE_NOO: Record<StatusNoo, Tone> = { menunggu_spv: "warn", disetujui: "info", ditolak: "neg", terdaftar: "pos" };
function badgeNoo(r: AoRow): ReactNode {
    return r.nooStatus ? <StatusBadge tone={TONE_NOO[r.nooStatus]}><span className="sr-only">Status pengajuan: </span>{LABEL_STATUS_NOO[r.nooStatus]}</StatusBadge> : null;
}

/** Nama bulan tanggal rute ("November"); tanggal tak sah = "bulan ini". */
const namaBulan = (ymd: string) => { const t = new Date(`${ymd}T00:00:00`); return Number.isNaN(t.getTime()) ? "bulan ini" : new Intl.DateTimeFormat("id-ID", { month: "long" }).format(t); };

const ringkas = (n: number) => new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/**
 * Status kunjungan toko hari ini, satu kalimat. "Belum dikunjungi" hanya ditulis bila badge tidak sudah mengatakannya (badge "Belum"):
 * toko bertanda Order/Tidak order/Prioritas tanpa check-in tetap disebut belum dikunjungi.
 */
function kunjunganToko(r: AoRow): string {
    if (sedang(r)) return `Sedang dikunjungi · check-in ${waktuWita(r.checkinAt)}`;
    if (r.checkoutAt) {
        const menit = visitDurationMin(r);
        return `Selesai ${rentangWita(r.checkinAt, r.checkoutAt)}${menit !== null ? ` (${menit} menit)` : ""}`;
    }
    return badgeToko(r).label === "Belum" ? "" : "Belum dikunjungi";
}

/** Keterangan kecil di bawah angka: jenis kunjungan, omzet rata-rata JKS, hari order, peringatan. */
function catatanToko(r: AoRow): string {
    return [
        r.luarRute ? (isKodeNoo(r.custCode) ? "Toko baru (NOO) · tanpa order" : "Luar rute") : "",
        r.omzetRata ? `Omzet ±${ringkas(r.omzetRata)}/bln` : "",
        // #3: angka ini menghitung HARI dengan status order/aktif bulan ini (db.ts getTodayRoute), bukan jumlah kunjungan.
        r.monthlyOrderCount > 0 ? `${r.monthlyOrderCount} hari order bulan ini` : "",
        r.needsAttention ? "≥ 2× tidak order bulan ini" : "",
    ].filter(Boolean).join(" · ");
}

/**
 * Tiga angka toko (owner 14 Nov 2026): target JKS per bulan, realisasi faktur Accurate bulan berjalan (% target + jumlah faktur), limit kredit
 * (sisa = limit − piutang sinkron terakhir). Angka yang tidak diketahui = "-"; ketiganya tidak diketahui = tidak tampil.
 */
function AngkaToko({ r, bulan }: { r: AoRow; bulan: string }) {
    if (!r.targetToko && r.realisasiBulan == null && !r.limit) return null;
    const persen = r.targetToko && r.realisasiBulan != null ? Math.round((r.realisasiBulan / r.targetToko) * 100) : null;
    const sisa = r.limit ? sisaLimit(r.limit) : null;
    const sel: [string, string, ReactNode][] = [
        ["Target", r.targetToko ? ringkas(r.targetToko) : KOSONG, r.targetToko ? "per bulan" : ""],
        // Label pendek (bulan disingkat: "Nov") supaya tiga kolom sejajar di 390 px; bulan penuh ada di ringkasan rute.
        [`Realisasi ${bulan === "bulan ini" ? "" : bulan.slice(0, 3)}`.trim(), r.realisasiBulan == null ? KOSONG : ringkas(r.realisasiBulan),
            r.realisasiBulan == null ? "" : !r.fakturBulan ? "belum ada faktur" : `${persen !== null ? `${persen}% · ` : ""}${r.fakturBulan} faktur`],
        ["Limit kredit", !r.limit ? KOSONG : r.limit.limit === null ? "Tidak diatur" : ringkas(r.limit.limit),
            sisa === null ? "" : sisa < 0 ? <b style={{ color: "var(--neg)" }}>lewat {ringkas(-sisa)}</b> : `sisa ${ringkas(sisa)}`],
    ];
    return (
        <span className="grid grid-cols-3 gap-2" style={{ padding: "6px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
            {sel.map(([label, nilai, sub]) => (
                <span key={label} className="grid min-w-0" style={{ alignContent: "start" }}>
                    <span className="fi-caption" style={{ overflowWrap: "anywhere" }}>{label}</span>
                    <b className="fi-tnum" style={{ color: "var(--ink)" }}>{nilai}</b>
                    {sub && <span className="fi-caption fi-tnum">{sub}</span>}
                </span>
            ))}
        </span>
    );
}

/** Urutan kunjungan JKS (bagikan/cetak): urutan dulu, lalu nama — tanpa status kunjungan. */
const urutJks = (a: AoRow, b: AoRow) => (a.urutan ?? Infinity) - (b.urutan ?? Infinity) || a.custName.localeCompare(b.custName);

/** Toggle bintang (lib/form-kontrol statusBintang); membatalkan bintang yang dipasang sesi ini mengembalikan baris semula. */
const bintang = (r: AoRow): AoRow => {
    const status = statusBintang(r.status);
    return { ...r, status, isPriority: status === "priority" };
};

/**
 * Baris yang dikirim = bacaan TERBARU server; tanda bintang sesi ini ditimpakan hanya bila status toko itu tidak berubah sejak layar
 * dimuat (bila berubah — mis. salesman baru menyimpan ORDER — bintang dilewati dan status server yang dikirim).
 */
function susunKiriman(segar: AoRow[], dimuat: AoRow[], bintangSesi: Record<string, AoRow>) {
    const lama = new Map(dimuat.map((r) => [r.custCode, r]));
    let dilewati = 0;
    const rows = segar.map((r) => {
        const mau = bintangSesi[r.custCode];
        if (!mau) return r;
        if (lama.get(r.custCode)?.status !== r.status) { dilewati++; return r; }
        return r.isPriority === mau.isPriority ? r : bintang(r);
    });
    return { rows, dilewati };
}

export default function TabAo({ scope }: { scope: Scope }) {
    const judulId = useId();
    // Akun salesman (profil tertaut): tanggal = hari ini WITA saat layar dibuka, tidak bisa diubah (it05 #1). Peran lain boleh melihat
    // tanggal lain.
    const salesman = Boolean(scope.salesCode);
    const tim = scope.allowedSalesCodes;
    const beku = useHariBeku();
    const [tanggalPilih, setTanggalPilih] = useState(beku.hari);
    const tanggal = salesman ? beku.hari : tanggalPilih;
    // Principal = JKS aktif cakupan (my-scope, FK-MSM butir 1): satu = langsung terpilih tanpa pilihan; lebih dari satu = dipilih.
    // FK-MSM2: salesman TANPA JKS = principal cabang Accurate-nya (hanya untuk kunjungan luar rute).
    const principalCabang = salesman && !scope.principles?.length ? scope.principalCabang ?? null : null;
    const daftarPrincipal = scope.principles?.length ? scope.principles : principalCabang ? [principalCabang] : [];
    const tanpaJks = penjelasanTanpaJks(scope);
    const [principle, setPrinciple] = useState(() => principalAwal(scope) || principalCabang || "");
    const [salesCode, setSalesCode] = useState(scope.salesCode ?? "");
    const [saring, setSaring] = useState<Saring>("semua");
    const [dialog, setDialog] = useState(false);
    const [sukses, setSukses] = useState("");
    const [infoBagi, setInfoBagi] = useState("");
    // Hasil "Batalkan" luar rute terakhir tidak pasti → semua Batalkan dikunci sampai rute dimuat ulang (cegah keputusan dari daftar usang).
    const [batalTakPasti, setBatalTakPasti] = useState(false);
    const tanpaIzin = useIzinFk("submit");
    // Hanya salesman pemilik rute yang mengirim status (perilaku lama untuk peran salesman); SPV/SM/admin baca-saja.
    const bukanPemilik = salesman && salesCode === scope.salesCode ? undefined
        : "Hanya salesman pemilik rute yang mengirim status rute; tampilan ini baca-saja.";

    const [draf, setDraf] = useState<DrafBintang>(bacaDrafBintang);
    const loader = useCallback(async (): Promise<Load<AoRow[]>> => {
        // Tanpa salesman/principal terpilih tidak ada permintaan: server menjawab baris AO lintas salesman (admin) atau kosong — bukan rute.
        if (!salesCode || !principle) return { status: "siap", data: [] };
        const p = new URLSearchParams({ date: tanggal, principle });
        p.set("salesCode", salesCode);
        const hasil = await bacaFk(`/api/form-kontrol/ao-control?${p}`, (d) => keBarisRute(d.rows, principle));
        if (hasil.status === "siap" && tanggal === hariIniWita()) {
            simpanRute(tanggal, salesCode, hasil.data!.filter((r) => !isKodeNoo(r.custCode)).map((r) => ({ kode: r.custCode, nama: r.custName })));
        }
        if (hasil.status === "siap") {
            // Tanda untuk toko yang hilang dari rute / sudah punya hasil kunjungan gugur SEKARANG (bukan saat strip ditutup).
            const kini = new Map(hasil.data!.map((r) => [r.custCode, r]));
            const k = `${salesCode}|${principle}|${tanggal}`;
            setDraf((prev) => {
                const gugur = (c: string, m: TandaDraf) => m.gugur ?? (!kini.has(c) ? "hilang" : adaHasilKunjungan(kini.get(c)!.status) ? "hasil" : undefined);
                const mau = Object.entries(prev[k] ?? {});
                if (!mau.some(([c, m]) => gugur(c, m) !== m.gugur)) return prev;
                return { ...prev, [k]: Object.fromEntries(mau.map(([c, m]) => [c, { ...m, gugur: gugur(c, m) }])) };
            });
        }
        return hasil;
    }, [tanggal, principle, salesCode]);
    const [load, muatUlang] = useLoad(loader);

    const asal = load.data;
    // Tanda prioritas yang belum dikirim = keinginan per toko (prioritas ya/tidak) untuk rute salesman|principal|tanggal ini.
    // bertahan melewati muat ulang rute (Tambah luar rute, Batalkan, Muat ulang) dan diterapkan ke baris TERBARU; tidak berlaku untuk toko
    // yang sudah punya hasil kunjungan atau sudah berstatus itu. Toko yang hilang dari rute: tanda dibuang dan disebut (strip), tidak diam.
    const kunciRute = `${salesCode}|${principle}|${tanggal}`;
    // Bertahan juga saat salesman membuka Kunjungan lalu kembali; yang disimpan hanya draf tanggal ini.
    useEffect(() => {
        try {
            sessionStorage.setItem(DRAF_BINTANG, JSON.stringify(Object.fromEntries(Object.entries(draf).filter(([k]) => k.endsWith(`|${tanggal}`)))));
        } catch { /* penyimpanan tidak tersedia: draf hanya di layar ini */ }
    }, [draf, tanggal]);
    const ubahan = useMemo(() => {
        const mau = draf[kunciRute] ?? {};
        return Object.fromEntries((asal ?? []).flatMap((r) => {
            const m = mau[r.custCode];
            return m && !m.gugur && !adaHasilKunjungan(r.status) && r.isPriority !== m.prioritas ? [[r.custCode, bintang(r)] as const] : [];
        }));
    }, [asal, draf, kunciRute]);
    const gugur = Object.values(draf[kunciRute] ?? {}).filter((m) => m.gugur);
    const rows = useMemo(() => (asal ?? []).map((r) => ubahan[r.custCode] ?? r), [asal, ubahan]);
    const nUbah = Object.keys(ubahan).length;
    useUnsavedGuard(nUbah > 0);

    function tandai(r: AoRow) {
        setSukses("");
        setDraf((prev) => {
            const mau = { ...prev[kunciRute] };
            // Membatalkan tanda sesi ini mengembalikan baris semula.
            if (ubahan[r.custCode]) delete mau[r.custCode];
            else mau[r.custCode] = { prioritas: !r.isPriority, nama: r.custName };
            return { ...prev, [kunciRute]: mau };
        });
    }
    const buangHilang = () => {
        setDraf((prev) => ({ ...prev, [kunciRute]: Object.fromEntries(Object.entries(prev[kunciRute] ?? {}).filter(([, m]) => !m.gugur)) }));
        document.getElementById(judulId)?.focus(); // fokus tidak jatuh ke BODY saat strip ditutup
    };

    const n = {
        order: rows.filter((r) => r.status === "ordered").length,
        aktif: rows.filter((r) => r.status === "active").length,
        tidak: rows.filter((r) => r.status === "not_order").length,
        prioritas: rows.filter((r) => r.status === "priority").length,
        belum: rows.filter((r) => r.status === "not_visited").length,
        dikunjungi: rows.filter((r) => r.checkinAt).length,
        belumSelesai: rows.filter((r) => !r.checkoutAt).length,
        perhatian: rows.filter((r) => r.isPriority || r.needsAttention).length,
    };
    const shown = rows
        .filter((r) => saring === "semua" ? true : saring === "belum" ? !r.checkoutAt : saring === "tidak" ? r.status === "not_order" : (r.isPriority || r.needsAttention))
        .slice()
        // Kunjungan yang sedang berjalan selalu paling atas; sisanya urutan rute lama (tidak order → perhatian → order → belum → selesai).
        .sort((a, b) => Number(sedang(b)) - Number(sedang(a)) || compareRoute(a, b));

    const kirimTerkunci = bukanPemilik ?? tanpaIzin ?? (rows.length === 0 ? "Tidak ada toko di rute ini"
        : load.status === "memuat" ? "Menunggu rute selesai dimuat"
            : load.status === "galat" ? "Rute gagal dimuat ulang; muat ulang dulu supaya status yang dikirim tidak usang" : undefined);

    async function kirimStatus() {
        const p = new URLSearchParams({ date: tanggal, principle });
        p.set("salesCode", salesCode);
        const segar = await bacaFk(`/api/form-kontrol/ao-control?${p}`, (d) => keBarisRute(d.rows, principle));
        if (segar.status !== "siap") throw new Error(`Rute tidak bisa dibaca ulang sebelum dikirim, jadi tidak ada yang dikirim. ${segar.error ?? ""}`.trim());
        const { rows: kiriman, dilewati } = susunKiriman(segar.data!, asal ?? [], ubahan);
        let terkirim = 0;
        for (const row of kiriman) {
            try {
                await kirimFk("/api/form-kontrol/ao-control", {
                    salesCode: row.salesCode,
                    custCode: row.custCode,
                    principle,
                    date: tanggal,
                    status: row.status,
                    noOrderReasonCode: row.noOrderReasonCode ?? null,
                    noOrderNote: row.noOrderNote ?? null,
                }, { ulangAman: true });
            } catch (e) {
                const sebab = e instanceof Error ? e.message : "Gagal mengirim.";
                // FK-MSM3: toko tidak lagi di rute (mis. kunjungan luar rute dibatalkan di layar lain) → rute dimuat ulang; kirim ulang memakai rute baru.
                if (ditolakBukanRute(e)) muatUlang();
                const belum = kiriman.slice(terkirim + 1).map((r) => r.custName);
                throw new Error(`${sebab} Berhenti di ${row.custName}: ${terkirim} dari ${kiriman.length} toko sudah terkirim.${belum.length
                    ? ` Belum dikirim: ${belum.join(", ")}.` : ""} Tekan Kirim status lagi untuk melanjutkan dari rute terbaru di server.`);
            }
            terkirim++;
        }
        setDialog(false);
        setDraf((prev) => { const sisa = { ...prev }; delete sisa[kunciRute]; return sisa; });
        setSukses(`Status ${terkirim} toko terkirim untuk ${tanggalPanjang(tanggal)} dari rute terbaru di server.${dilewati
            ? ` ${dilewati} tanda prioritas tidak dikirim karena status tokonya berubah sejak layar dimuat.` : ""}`);
        muatUlang();
    }

    const hariLabel = tanggalPanjang(tanggal);
    const judulHari = tanggal === hariIniWita() ? "hari ini" : hariLabel;
    const minggu = mingguSiklus(tanggal).toUpperCase();
    const judulRute = `Rute ${salesman && scope.salesName ? scope.salesName : salesCode} · ${principle} · ${hariLabel} (minggu ${minggu})`;
    async function bagikan() {
        const teks = teksRute(judulRute, rows.slice().sort(urutJks), namaBulan(tanggal));
        setInfoBagi("");
        try {
            if (typeof navigator !== "undefined" && navigator.share) { await navigator.share({ title: judulRute, text: teks }); return; }
        } catch (e) { if (e instanceof DOMException && e.name === "AbortError") return; }
        // Tanpa Web Share (desktop) / gagal: WhatsApp, penerima dipilih sendiri. Jendela diblokir = kalimat, bukan diam.
        const w = window.open(`https://wa.me/?text=${encodeURIComponent(teks)}`, "_blank");
        if (!w) { setInfoBagi("Jendela WhatsApp diblokir peramban. Izinkan pop-up untuk situs ini, lalu tekan Bagikan rute lagi."); return; }
        w.opener = null;
    }
    function cetak() {
        const w = window.open("", "_blank");
        if (!w) { setInfoBagi("Jendela cetak diblokir peramban. Izinkan pop-up untuk situs ini, lalu tekan Cetak rute lagi."); return; }
        w.document.write(htmlRute(judulRute, rows.slice().sort(urutJks), namaBulan(tanggal)));
        w.document.close();
        w.focus();
        w.print();
    }
    let isi: ReactNode;
    if (!salesCode && tim !== null && tim.length === 0) {
        isi = <EmptyState title="Belum ada salesman di tim Anda" message="Salesman muncul setelah Admin Sales mengisi SPV/SM mereka di Hierarki Sales." />;
    } else if (tanpaJks && !principalCabang) {
        isi = <EmptyState title={tanpaJks.title} message={`${tanpaJks.message}${scope.alasanCabang ? ` Kunjungan luar rute juga belum bisa: ${scope.alasanCabang}` : ""}`} />;
    } else if (!salesCode) {
        isi = tim === null
            ? <EmptyState title="Isi kode salesman" message="Rute tampil per salesman. Ketik kode salesman di atas." />
            : <EmptyState title="Pilih salesman tim Anda" message="Rute tampil per salesman." />;
    } else if (!principle) {
        isi = <EmptyState title="Pilih principal" message={`JKS dalam cakupan Anda memuat ${daftarPrincipal.length} principal; rute tampil per principal.`} />;
    } else if (load.status === "galat" && rows.length === 0) {
        // Juga saat muat ulang gagal sesudah hasil kosong: galat tidak pernah tampil sebagai rute kosong.
        isi = <ErrorState title="Rute gagal dimuat" message={`${load.error} Ini bukan rute kosong; kunjungan yang sudah tersimpan tidak hilang.`} onRetry={muatUlang} />;
    } else if (!asal) {
        isi = <><Skeleton rows={2} label="Memuat rute" /><Skeleton rows={5} label="Memuat rute" /></>;
    } else if (rows.length === 0) {
        isi = <EmptyState title={tanggal === hariIniWita() ? "Tidak ada rute terjadwal hari ini" : "Tidak ada rute terjadwal pada tanggal ini"}
            message={principalCabang ? "Belum ada toko di kunjungan ini. Tambahkan toko lewat Kunjungan luar rute di bawah."
                : `JKS ${salesCode} tidak punya toko ${principle} untuk ${hariLabel}. Bila ini keliru, minta SPV memeriksa JKS${daftarPrincipal.length > 1 ? " atau pilih principal lain" : ""}.`} />;
    } else {
        const lebar = (k: number) => `${rows.length ? (k / rows.length) * 100 : 0}%`;
        const nOrder = n.order + n.aktif;
        // Realisasi bulan berjalan toko-toko di rute ini (server lama tanpa angka = baris tidak tampil).
        const adaReal = rows.some((r) => r.realisasiBulan != null);
        const real = { total: rows.reduce((s, r) => s + (r.realisasiBulan ?? 0), 0), faktur: rows.reduce((s, r) => s + (r.fakturBulan ?? 0), 0),
            target: rows.reduce((s, r) => s + (r.targetToko ?? 0), 0), toko: rows.filter((r) => (r.fakturBulan ?? 0) > 0).length };
        const rp = (v: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(v);
        isi = (
            <div className={load.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={load.status === "memuat" || undefined}>
                {load.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {load.error} Yang tampil adalah hasil sebelumnya.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                    </MessageStrip>
                )}
                <div className="fi-panel grid gap-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <b className="fi-title-3 fi-tnum">{n.dikunjungi} dari {rows.length} dikunjungi</b>
                        <span className="fi-small fi-subtle fi-tnum">{nOrder} order · {n.tidak} tidak order · {rows.length - nOrder - n.tidak} belum</span>
                    </div>
                    <div role="img" aria-label={`${nOrder} order, ${n.tidak} tidak order, ${rows.length - nOrder - n.tidak} belum`}
                        className="flex overflow-hidden" style={{ height: 8, borderRadius: "var(--r-pill)", background: "var(--surface-3)" }}>
                        <i style={{ width: lebar(nOrder), background: "var(--pos-solid)" }} />
                        <i style={{ width: lebar(n.tidak), background: "var(--neg-solid)" }} />
                    </div>
                    {adaReal && (
                        <div className="grid gap-1">
                            <dl className="grid grid-cols-2 gap-3" style={{ margin: 0 }}>
                                <div className="grid">
                                    <dt className="fi-caption">Realisasi {namaBulan(tanggal)} s.d. {hariLabel}</dt>
                                    <dd className="fi-tnum" style={{ margin: 0 }}><b>{rp(real.total)}</b></dd>
                                </div>
                                <div className="grid">
                                    <dt className="fi-caption">Target toko rute ini</dt>
                                    <dd className="fi-tnum" style={{ margin: 0 }}>{real.target > 0 ? <><b>{rp(real.target)}</b> ({Math.round((real.total / real.target) * 100)}%)</> : KOSONG}</dd>
                                </div>
                            </dl>
                            <p className="fi-caption fi-tnum" style={{ margin: 0 }}>
                                {real.faktur} faktur di {real.toko} dari {rows.length} toko. Faktur Accurate semua salesman di cabang {principle}, termasuk PPN, belum dikurangi retur.
                            </p>
                        </div>
                    )}
                </div>
                {/* Satu baris segmen; di ponsel sempit segmen terakhir bergeser di dalam kontrol ini saja (halaman tidak bergulir menyamping). */}
                <div className="fi-segs" role="group" aria-label="Saring toko" style={{ justifySelf: "start", flexWrap: "nowrap", overflowX: "auto", maxWidth: "100%" }}>
                    {([["semua", "Semua", rows.length], ["belum", "Belum selesai", n.belumSelesai], ["tidak", "Tidak order", n.tidak], ["perhatian", "Perhatian", n.perhatian]] as const).map(([k, label, jml]) => (
                        <button key={k} type="button" aria-pressed={saring === k} onClick={() => setSaring(k)} style={{ flex: "none", whiteSpace: "nowrap" }}>
                            {label}<span className="fi-count">{jml}</span>
                        </button>
                    ))}
                </div>
                <Section title="Toko di rute" subtitle={`${shown.length} toko`}>
                    {shown.length === 0 ? <EmptyState title="Tidak ada toko pada saringan ini" message="Pilih saringan lain untuk melihat toko lainnya." /> : (<>
                        <p className="fi-caption" style={{ padding: "8px 16px 0", margin: 0 }}>
                            Ketuk toko untuk mulai kunjungan. Bintang menandai toko prioritas; toko yang sudah punya hasil kunjungan tidak bisa ditandai.{bukanPemilik ? ` ${bukanPemilik}` : ""}
                        </p>
                        <ul aria-label="Toko di rute" style={{ listStyle: "none", padding: 0 }}>
                            {shown.map((r) => {
                                const b = badgeToko(r);
                                const q = new URLSearchParams({ salesCode: r.salesCode, principle, date: tanggal });
                                const alasanBintang = bukanPemilik ?? (adaHasilKunjungan(r.status) ? "Toko ini sudah punya hasil kunjungan" : undefined);
                                // Owner 13 Okt: kunjungan luar rute salah tambah boleh dibatalkan pemiliknya hari itu, selama belum ada check-in/status
                                // APA PUN (juga "tidak dikunjungi" dari Kirim status rute; server menolaknya).
                                const bisaBatal = r.luarRute && salesman && !bukanPemilik && tanggal === hariIniWita() && !r.checkinAt && !r.adaStatus;
                                const alamat = alamatRingkas(r);
                                return (
                                    <li key={r.id ?? r.custCode} className="fi-wl-row" style={{ gridTemplateColumns: "auto minmax(0,1fr)", paddingLeft: 4 }}>
                                        <Button variant="icon" aria-pressed={r.isPriority} aria-label={`Prioritas ${r.custName}`} title="Tandai prioritas"
                                            disabled={Boolean(alasanBintang)} disabledReason={alasanBintang} onClick={() => tandai(r)}>
                                            <Star className="fi-icon" aria-hidden style={r.isPriority ? { fill: "var(--warn-solid)", color: "var(--warn-solid)" } : undefined} />
                                        </Button>
                                        <ListItem href={`/form-kontrol/visit/${encodeURIComponent(r.custCode)}?${q}`} doc={r.custCode} title={r.custName}
                                            amount={<StatusBadge tone={b.tone}>{b.label}</StatusBadge>}
                                            meta={<span className="grid gap-1.5">
                                                {kunjunganToko(r) && <span style={{ color: sedang(r) ? "var(--info)" : "var(--ink-muted)" }}>{kunjunganToko(r)}</span>}
                                                {alamat && <span style={{ overflowWrap: "anywhere" }}>{alamat}</span>}
                                                <AngkaToko r={r} bulan={namaBulan(tanggal)} />
                                                {catatanToko(r) && <span>{catatanToko(r)}</span>}
                                                {r.nooAlasanTolak && <span style={{ overflowWrap: "anywhere" }}>Alasan ditolak: {r.nooAlasanTolak}</span>}
                                                <LencanaJks r={r} />
                                            </span>}
                                            badge={badgeNoo(r)} />
                                        {/* Baris bawah kartu (kolom isi): tidak memeras nama toko panjang di 390 px; tautan peta di luar ListItem (bukan tautan bersarang). */}
                                        <div className="flex flex-wrap gap-2" style={{ gridColumn: 2, justifySelf: "start" }}>
                                            <a className="fi-btn fi-btn--tertiary" href={urlPeta(r)} target="_blank" rel="noopener noreferrer">
                                                <MapPin className="fi-icon" aria-hidden />{punyaTitik(r) ? "Buka peta" : "Cari di peta"}
                                                <span className="sr-only"> {r.custName} di Google Maps</span>
                                            </a>
                                            {bisaBatal && (
                                                <BatalkanLuarRute id={r.id} custName={r.custName} custCode={r.custCode}
                                                    kunci={tanpaIzin ?? (batalTakPasti ? "Hasil pembatalan terakhir belum pasti; muat ulang rute dulu."
                                                        : load.status !== "siap" ? "Menunggu rute selesai dimuat" : undefined)}
                                                    onTakPasti={() => setBatalTakPasti(true)}
                                                    onBatal={() => { setSukses(`Kunjungan luar rute ${r.custName} dibatalkan.`); muatUlang(); }} />
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </>)}
                </Section>
            </div>
        );
    }

    return (
        <section aria-labelledby={judulId} className="grid gap-4">
            <div className="grid gap-1">
                <div className="flex items-center justify-between gap-2">
                    <h2 id={judulId} className="fi-title-2" tabIndex={-1}>Rute hari ini</h2>
                    {salesCode && principle && (
                        <Button variant="icon" aria-label="Muat ulang" title="Muat ulang rute" icon={<RefreshCw className="fi-icon" aria-hidden />}
                            onClick={muatUlang} busy={load.status === "memuat" && Boolean(asal)} />
                    )}
                </div>
                <p className="fi-small fi-muted flex flex-wrap items-center gap-x-2" style={{ margin: 0 }}>
                    <CalendarDays className="fi-icon" aria-hidden />
                    <span>{hariLabel} · WITA · minggu {minggu}</span>
                </p>
                {salesCode && (
                    <p className="fi-small fi-muted" style={{ margin: 0 }}>
                        {principle && <b style={{ color: "var(--ink)" }}>{principle}</b>}{principle ? " · " : ""}<span className="fi-mono">{salesCode}</span>{scope.salesName && salesman ? ` ${scope.salesName}` : ""}
                    </p>
                )}
            </div>

            <div className="fi-formgrid">
                {daftarPrincipal.length > 1 && (
                    <FormField label="Principal">
                        {(a) => (
                            <select {...a} className="fi-input" value={principle} onChange={(e) => { setPrinciple(e.target.value); setSukses(""); }}>
                                {!principle && <option value="">Pilih principal</option>}
                                {daftarPrincipal.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        )}
                    </FormField>
                )}
                {!salesman && tim === null && (
                    <FormField label="Kode salesman">
                        {(a) => <input {...a} className="fi-input fi-mono" value={salesCode} placeholder="mis. S01" onChange={(e) => { setSalesCode(e.target.value); setSukses(""); }} />}
                    </FormField>
                )}
                {!salesman && tim !== null && tim.length > 0 && (
                    <FormField label="Salesman tim">
                        {(a) => (
                            <select {...a} className="fi-input" value={salesCode} onChange={(e) => { setSalesCode(e.target.value); setSukses(""); }}>
                                <option value="">Pilih salesman</option>
                                {tim.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        )}
                    </FormField>
                )}
                {!salesman && (
                    <FormField label="Tanggal">
                        {(a) => <input {...a} type="date" className="fi-input" value={tanggalPilih} onChange={(e) => { if (e.target.value) setTanggalPilih(e.target.value); setSukses(""); }} />}
                    </FormField>
                )}
                {salesCode && principle && rows.length > 0 && (
                    // Satu baris aksi ringkas (tersier; Muat ulang = ikon di samping judul): di ponsel 390 px muat sebaris, rute tetap fokus layar.
                    <div className="flex flex-wrap items-end gap-1" role="group" aria-label="Aksi rute">
                        <Button variant="tertiary" icon={<Share2 className="fi-icon" aria-hidden />} onClick={() => void bagikan()}>Bagikan rute</Button>
                        <Button variant="tertiary" icon={<Printer className="fi-icon" aria-hidden />} onClick={cetak}>Cetak rute</Button>
                    </div>
                )}
            </div>

            {salesman && beku.berganti && (
                <MessageStrip tone="warn" title="Tanggal sudah berganti.">
                    Rute dan isian yang tampil masih untuk {hariLabel}.{" "}
                    {nUbah > 0 ? `${nUbah} tanda prioritas belum dikirim untuk ${hariLabel} tidak dibawa ke hari baru. Kirim dulu bila masih perlu. ` : "Tidak ada yang dibuang. "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setSukses(""); beku.pakaiHariBaru(); }}>Muat rute {tanggalPanjang(beku.hariBaru)}</button>
                </MessageStrip>
            )}
            {tanpaJks && principalCabang && (
                <MessageStrip tone="info" title={`${tanpaJks.title}.`}>
                    Rute terjadwal kosong sampai Admin Sales mengimpor JKS Anda. Anda tetap bisa menambah kunjungan luar rute (principal {principalCabang},
                    cabang Accurate Anda); di Laporan Kunjungan toko itu bisa Anda masukkan ke JKS.
                </MessageStrip>
            )}
            {sukses && <MessageStrip tone="pos" title="Terkirim.">{sukses}</MessageStrip>}
            {infoBagi && <MessageStrip tone="warn" title="Jendela diblokir peramban." onClose={() => setInfoBagi("")}>{infoBagi}</MessageStrip>}
            {batalTakPasti && (
                <MessageStrip tone="warn" title="Hasil pembatalan terakhir belum pasti.">
                    Muat ulang rute untuk melihat apakah kunjungan itu sudah batal; Batalkan dikunci sampai rute dimuat ulang.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setBatalTakPasti(false); setSukses(""); muatUlang(); }}>Muat ulang</button>
                </MessageStrip>
            )}
            {gugur.length > 0 && (
                <MessageStrip tone="warn" title={`${gugur.length} tanda prioritas dibuang.`} onClose={buangHilang}>
                    {[["hilang", "tidak lagi ada di rute ini"], ["hasil", "sudah punya hasil kunjungan"]].map(([g, sebab]) => {
                        const nama = gugur.filter((m) => m.gugur === g).map((m) => m.nama);
                        return nama.length ? `${nama.join(", ")} ${sebab}, jadi tandanya tidak dikirim. ` : "";
                    })}
                </MessageStrip>
            )}
            {nUbah > 0 && <p className="fi-draft" role="status">{nUbah} tanda prioritas belum dikirim. Kirim lewat “Kirim status rute”.</p>}

            {isi}

            {salesman && salesCode === scope.salesCode && principle && tanggal === hariIniWita() && asal && (
                <TambahLuarRute salesCode={salesCode} principle={principle} tanggal={tanggal} ruteKode={rows.map((r) => r.custCode)}
                    onDitambah={muatUlang} kunci={tanpaIzin} />
            )}
            {salesman && salesCode === scope.salesCode && principle && tanggal === hariIniWita() && asal && (
                <TambahNoo salesCode={salesCode} principle={principle} onDiajukan={muatUlang} kunci={tanpaIzin} />
            )}

            <Section title="Akhir hari" subtitle="setelah kunjungan terakhir">
                <div className="fi-sect-in">
                    <p className="fi-small fi-muted">
                        Kirim status rute mengirim status setiap toko di daftar ini apa adanya, termasuk tanda prioritas. Toko yang belum disentuh
                        tercatat “tidak dikunjungi”. Laporan kunjungan (tindak lanjut untuk SPV) dikirim di tab Laporan Kunjungan.
                    </p>
                    <div className="fi-btnrow">
                        <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(kirimTerkunci)} disabledReason={kirimTerkunci}
                            onClick={() => setDialog(true)}>Kirim status rute…</Button>
                        <Link className="fi-btn fi-btn--secondary" href="/form-kontrol?tab=laporan"><FileText className="fi-icon" aria-hidden />Buka laporan ke SPV</Link>
                    </div>
                    {kirimTerkunci && rows.length > 0 && <p className="fi-small fi-why">{kirimTerkunci}</p>}
                </div>
            </Section>

            {/* Satu catatan varian per layar (audit No 80): it05 #4 dan BL-28 digabung. */}
            <VariantNote bl="it05 #4, BL-28">
                Status kunjungan sudah tersimpan per toko saat check-in/status/check-out, tetapi tanda prioritas dan toko yang tidak dikunjungi baru
                tercatat lewat Kirim status rute, dan Dashboard SPV menghitung rute dari kiriman itu. Tanggal &quot;hari ini&quot; dihitung di ponsel dalam
                WITA. Usulan: status ditulis hanya per kunjungan, rute direncanakan dibaca dari JKS, dan server yang menetapkan tanggal serta cap foto WITA.
            </VariantNote>

            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Kirim status ${rows.length} toko rute ${judulHari}?`}
                description="Rute dibaca ulang dari server sesaat sebelum dikirim; status setiap toko dikirim dari bacaan itu, satu per satu, ditambah tanda prioritas dari layar ini. Toko yang belum disentuh tercatat “tidak dikunjungi”; Dashboard SPV menghitung rute dari kiriman ini."
                facts={[
                    ["Tanggal", `${hariLabel} · WITA`],
                    ["Salesman · principal", `${salesCode} · ${principle}`],
                    ["Order", String(n.order)],
                    ...(n.aktif ? [["Aktif", String(n.aktif)] as [string, string]] : []),
                    ["Tidak order", String(n.tidak)],
                    ["Prioritas", String(n.prioritas)],
                    ["Belum dikunjungi", String(n.belum)],
                ]}
                confirmLabel="Kirim status" onConfirm={kirimStatus} />
        </section>
    );
}
