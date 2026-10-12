/*
 * Tujuan: Order Sales + Order saya (Fiori S5 + O2, ponsel dulu) — salesman MENCARI pelanggan (nama/kode, hanya cabang karyawan Accurate-nya)
 *   dan barang (hanya barang cabang pelanggan, satuan + harga per cabang), mengirim kuantitas; harga, diskon promo, dan bonus dihitung
 *   server dan tampil per baris + ringkasan; nomor permintaan tampil setelah kirim; Order saya membedakan galat dari kosong. Akun yang
 *   belum ditautkan ke karyawan salesman Accurate melihat penjelasan "hubungi Admin", bukan formulir kosong.
 * Caller: ./page.tsx (/sales; dibatasi izin `websales.create`, bukan `order.create`).
 * Dependensi: /api/customers/search, /api/items/search, /api/orders/preview (components/order/*; pratinjau membawa `sidik`), FastAPI
 *   /websales/orders (simpan WAJIB membawa `sidik` pratinjau terakhir; + /api/me untuk CSRF); ../form-kontrol/lapangan (ambilJson, PESAN_SINYAL, toko rute tersimpan); ../form-kontrol/shared (hariIniWita); components/fiori/*;
 *   lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek, jamWita).
 * Main Functions: OrderSales, send, csrfHeader.
 * Side Effects: HTTP; permintaan order masuk ke basis data Web Sales yang terpisah. Payload POST sama dengan halaman lama (tanggal
 *   order bawaan = hari ini WITA, bukan UTC); channel + kode pelanggan kini dari hasil pencarian master.
 *
 * Sales TIDAK mengirim harga: yang dikirim hanya kode, satuan, jumlah. Nilai transaksi dihitung server dari master Accurate (harga cabang
 * pelanggan) + aturan promo terbit, dan ditampilkan di sini supaya sales tahu angkanya. Satuan hanya boleh dari master (salah satuan = nilai
 * salah puluhan kali). Barang tanpa harga di cabang pelanggan ditolak server saat simpan (O1), jadi layar mengunci Kirim — bukan lagi
 * "order tetap bisa dikirim".
 *
 * Pratinjau = tersimpan (kontrak O1 §4): Kirim hanya bila pratinjau LENGKAP untuk isian yang sekarang ada (kunci pratinjau = channel, tanggal,
 * pelanggan, kode/satuan/jumlah tiap baris; berubah = pratinjau lama usang = Kirim terkunci sampai yang baru tiba). `sidik` pratinjau ikut
 * dikirim; PRATINJAU_BERUBAH (409) = order BELUM terkirim, angka baru ditampilkan dan Kirim meminta konfirmasi ulang.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Plus, Send, Trash2 } from "lucide-react";
import { Button, EmptyState, ErrorState, FooterToolbar, ListItem, MessageStrip, Section, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { PemilihBarang, type BacaanBarang } from "@/components/order/PemilihBarang";
import { PemilihPelanggan, usePelanggan } from "@/components/order/PemilihPelanggan";
import { KartuPromoBaris, PanelPromo, PromoBarisInfo } from "@/components/order/PanelPromo";
import { alasanKunciBarang, galatDariJawaban, galatTidakDitemukan, hargaCabangDefault, kalimatGalat, kalimatPenolakan, kunciHarga, labelSatuan, pecahSaran, pratinjauBerubah, tanggalSah, type BarangPilih, type Cakupan, type Galat, type PelangganPilih } from "@/components/order/order-cabang";
import { bacaBarangKode, hitungPratinjau, muatCakupan, type Pratinjau } from "@/components/order/order-cabang-api";
import { resolveApiBase } from "@/lib/apiBase";
import { rupiah } from "@/lib/promo-ui";
import { jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { PESAN_SINYAL, RUTE_TERSIMPAN, ambilJson, bacaRuteTersimpan, type Jawaban } from "../form-kontrol/lapangan";
import { hariIniWita } from "../form-kontrol/shared";

const API_BASE = resolveApiBase();

/** `barang` null + `bacaan` null = baris baru (belum memilih barang); `bacaan` = barang dari draf sedang/gagal dibaca. */
type Line = { code: string; unit: string; quantity: string; barang: BarangPilih | null; bacaan: BacaanBarang | null };
type RequestRow = { id: string; outlet: string; channel: string; order_date: string; status: string; created_at: string; reject_code?: string | null; reject_reason?: string | null };
type DataCakupan = { cakupan?: Cakupan; blokir?: Galat };

const tanpaLangganan = () => () => {};
const hariIniKlien = () => hariIniWita();

let cachedCsrf = "";
async function csrfHeader(): Promise<Record<string, string>> {
    if (!cachedCsrf) {
        try {
            const res = await fetch(`${API_BASE}/api/me`, { credentials: "include", signal: AbortSignal.timeout(15_000) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.csrf_token) cachedCsrf = String(data.csrf_token);
        } catch { /* backend masih memeriksa same-origin bila token tidak tersedia */ }
    }
    return cachedCsrf ? { "X-CSRF-Token": cachedCsrf } : {};
}

/** FastAPI Web Sales. status 0 = tanpa sinyal; data null = badan bukan JSON. */
async function send(method: string, path: string, body?: unknown): Promise<Jawaban> {
    return ambilJson(`${API_BASE}${path}`, {
        method, credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...(await csrfHeader()) },
    });
}

const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1", barang: null, bacaan: null });

/** Satu satuan saja = dipilih otomatis; satuan lama dipertahankan bila masih ada; selain itu kosong (satuan tidak pernah ditebak: selisih bisa 72x). */
const satuanAwal = (b: BarangPilih, lama: string) => (b.units.some((u) => u.unit === lama) ? lama : b.units.length === 1 ? b.units[0].unit : "");

/**
 * Draf order di ponsel ini (owner 8 Okt 2026): satu draf per akun per perangkat (`DRAF_ORDER.<id akun>`), ditulis selama ada isian,
 * dihapus setelah order terkirim. Dipulihkan HANYA lewat tombol; tanggal tidak ikut (kembali hari ini). Order Web Sales tidak idempoten:
 * sebelum POST draf ditandai TERPUTUS, sehingga draf dari kiriman yang tak sempat dijawab (halaman tertutup/berpindah) tetap menahan Kirim
 * setelah dipulihkan; tanda itu baru dilepas oleh jawaban pasti (sukses = draf dihapus, ditolak = tanda sebelumnya kembali).
 * O2: bentuk draf TIDAK berubah (kode pelanggan + kode/satuan/jumlah barang); sesudah dipulihkan, pelanggan dan barang dibaca ulang dari
 * master (cabang/harga bisa berubah sejak draf ditulis).
 * ponytail: dua tab berisi draf yang sama — tab yang belum mengirim bisa menulis ulang draf yang sudah terkirim tanpa tanda; tambahkan
 * listener `storage` bila itu terjadi di lapangan.
 */
const DRAF_ORDER = "accapi.order-sales.draf.v1";
const TERPUTUS = "Kiriman order ini terputus sebelum ada jawaban server. Order mungkin sudah masuk — periksa Order saya sebelum mengirim ulang.";
type BarisDraf = { code: string; unit: string; quantity: string };
type DrafOrder = { customerNo: string; outlet: string; note: string; lines: BarisDraf[]; tidakPasti: string; disimpan: string };
function bacaDrafOrder(raw: string | null): DrafOrder | null {
    try {
        const d = raw ? JSON.parse(raw) : null;
        if (!d || !Array.isArray(d.lines)) return null;
        const teks = (v: unknown) => (typeof v === "string" ? v : "");
        const lines: BarisDraf[] = d.lines.map((l: unknown) => {
            const o = (l ?? {}) as Record<string, unknown>;
            return { code: teks(o.code), unit: teks(o.unit), quantity: teks(o.quantity) };
        }).filter((l: BarisDraf) => l.code.trim());
        if (lines.length === 0 && !teks(d.note).trim()) return null;
        return { customerNo: teks(d.customerNo), outlet: teks(d.outlet), note: teks(d.note), lines: lines.length ? lines : [{ code: "", unit: "", quantity: "1" }], tidakPasti: teks(d.tidakPasti), disimpan: teks(d.disimpan) };
    } catch { return null; }
}
const bacaPonsel = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const hapusPonsel = (k: string) => { try { localStorage.removeItem(k); } catch { /* tidak bisa dihapus = tidak bisa dibaca juga */ } };
/** Gagal tulis (penuh/diblokir) = draf lama dibuang, supaya yang basi tidak ditawarkan lagi. */
const tulisPonsel = (k: string, isi: Omit<DrafOrder, "disimpan">) => {
    try { localStorage.setItem(k, JSON.stringify({ ...isi, disimpan: new Date().toISOString() })); } catch { hapusPonsel(k); }
};
let ponselBisaSimpan: boolean | undefined;
/** Penyimpanan peramban bisa ditulis? (mode privat/diblokir = tidak). Tidak berubah selama halaman terbuka. */
const bisaSimpanPonsel = () => {
    if (ponselBisaSimpan === undefined) {
        try { localStorage.setItem(`${DRAF_ORDER}.uji`, "1"); localStorage.removeItem(`${DRAF_ORDER}.uji`); ponselBisaSimpan = true; } catch { ponselBisaSimpan = false; }
    }
    return ponselBisaSimpan;
};
const nomorPermintaan = (id: string) => `#${id.slice(0, 8)}`;
const buatBarisDraf = (lines: Line[]): BarisDraf[] => lines.map((l) => ({ code: l.code, unit: l.unit, quantity: l.quantity }));

/** Barang dari draf yang tak terbaca karena pelanggannya belum terbaca: bukan "tidak ada", jadi kalimatnya sendiri. */
const galatMenungguPelanggan = (kode: string): Galat => ({
    kode: "PELANGGAN_BELUM_TERBACA", judul: "Barang belum bisa diperiksa", menolak: true, tidakPasti: false, blokirSales: false, perBarang: {},
    pesan: `Barang ${kode} belum bisa dibaca karena pelanggan order ini belum terbaca.`, tindakan: "Pilih pelanggan dulu, lalu cari barangnya lagi.",
});

export default function OrderSales({ akunId }: { akunId: string }) {
    const kunciDraf = `${DRAF_ORDER}.${akunId}`;
    // Hari ini dari jam peramban dalam WITA; snapshot server "" supaya hidrasi tidak bentrok dengan jam server.
    const hariIni = useSyncExternalStore(tanpaLangganan, hariIniKlien, () => "");
    const ruteRaw = useSyncExternalStore(tanpaLangganan, () => { try { return sessionStorage.getItem(RUTE_TERSIMPAN); } catch { return null; } }, () => null);
    const tokoRute = useMemo(() => bacaRuteTersimpan(ruteRaw, hariIni), [ruteRaw, hariIni]);

    const pel = usePelanggan("sales");
    const pelanggan: PelangganPilih | null = pel.state.jenis === "siap" ? pel.state.p : null;
    const kodePel = pel.state.jenis === "siap" ? pel.state.p.customerNo : pel.state.jenis === "kosong" ? "" : pel.state.kode;
    const [outlet, setOutlet] = useState("");
    const channel = pelanggan?.channel ?? "";
    const channelMasalah = pelanggan && !pelanggan.channel ? `Outlet ${pelanggan.customerNo} belum punya kategori (TT/MT) di Accurate. Isi kategorinya di Accurate lebih dulu.` : "";
    const [tanggalIsi, setTanggalIsi] = useState<string | null>(null);
    const orderDate = tanggalIsi ?? hariIni;
    const [note, setNote] = useState("");
    const [lines, setLines] = useState<Line[]>([emptyLine()]);
    const [hasil, setHasil] = useState<{ key: string; p: Pratinjau } | null>(null);
    const [ulangPratinjau, setUlangPratinjau] = useState(0);
    // PRATINJAU_BERUBAH: order BELUM terkirim; angka lama -> baru ditampilkan untuk isian (kunci pratinjau) yang sama, hilang bila isian berubah.
    const [berubah, setBerubah] = useState<{ key: string; lama: string | null; baru: string } | null>(null);
    // "ulang" = kirim lagi sesudah jawaban tidak pasti, dengan peringatan order ganda (pilihan eksplisit salesman).
    const [dialog, setDialog] = useState<null | "biasa" | "ulang" | "buang">(null);
    const [sukses, setSukses] = useState("");
    // Order Web Sales TIDAK idempoten: selama hasil kirim terakhir tidak pasti, Kirim ditahan sampai salesman mengubah isian atau
    // memilih "Kirim lagi" secara eksplisit (temuan peninjau P1: 502 sesudah tersimpan + kirim ulang = 2 order).
    const [tidakPasti, setTidakPasti] = useState("");
    // Draf ponsel akun ini ditawarkan sampai salesman memilih Pulihkan/Buang atau mulai mengisi.
    const drafRaw = useSyncExternalStore(tanpaLangganan, () => bacaPonsel(kunciDraf), () => null);
    const simpanPonsel = useSyncExternalStore(tanpaLangganan, bisaSimpanPonsel, () => false);
    const [diputuskan, setDiputuskan] = useState(false);
    const acBarang = useRef<AbortController | null>(null);
    // Mulai mengisi menutup tawaran draf; draf lama tetap di ponsel sampai isian baru menjadi draf (menggantikannya).
    const ubahIsian = () => { setSukses(""); setTidakPasti(""); setDiputuskan(true); };

    /** Baca satu barang dari kodenya untuk baris `index` (pemulihan draf / Coba lagi). */
    const muatBarangKode = useCallback(async (index: number, kode: string, p: PelangganPilih, tanggal: string) => {
        acBarang.current ??= new AbortController();
        const sinyal = acBarang.current.signal;
        setLines((prev) => prev.map((l, i) => (i === index ? { ...l, bacaan: { jenis: "memuat", kode } } : l)));
        const h = await bacaBarangKode(kode, p, tanggal, sinyal, "sales");
        if (sinyal.aborted || (!h.ok && "batal" in h)) return;
        setLines((prev) => prev.map((l, i) => {
            if (i !== index || l.code.trim() !== kode) return l;
            if (!h.ok) return { ...l, bacaan: { jenis: "galat", kode, galat: h.galat } };
            if (!h.data) return { ...l, bacaan: { jenis: "galat", kode, galat: galatTidakDitemukan("barang", kode, "sales") } };
            return { ...l, barang: h.data, bacaan: null, unit: satuanAwal(h.data, l.unit) };
        }));
    }, []);

    async function pulihkan() {
        const d = bacaDrafOrder(bacaPonsel(kunciDraf)); // dibaca saat diklik: tab lain bisa sudah mengirim/mengubahnya
        setDiputuskan(true);
        if (!d) return;
        setOutlet(d.outlet); setNote(d.note); setTidakPasti(d.tidakPasti); setSukses("");
        acBarang.current?.abort();
        acBarang.current = new AbortController();
        setLines(d.lines.map((l) => ({ ...l, barang: null, bacaan: l.code.trim() ? { jenis: "memuat", kode: l.code.trim() } : null })));
        const p = d.customerNo.trim() ? await pel.bacaKode(d.customerNo) : null;
        if (!p) {
            setLines((prev) => prev.map((l) => (l.bacaan ? { ...l, bacaan: { jenis: "galat", kode: l.code.trim(), galat: galatMenungguPelanggan(l.code.trim()) } } : l)));
            return;
        }
        d.lines.forEach((l, i) => { if (l.code.trim()) void muatBarangKode(i, l.code.trim(), p, hariIni); });
    }
    function buangDraf() { hapusPonsel(kunciDraf); setDialog(null); setDiputuskan(true); }

    const muatOrder = useCallback(async (): Promise<Load<RequestRow[]>> => {
        const j = await send("GET", "/websales/orders");
        if (j.status >= 200 && j.status < 300 && j.data) return { status: "siap", data: (j.data.requests as RequestRow[]) ?? [] };
        return {
            status: "galat",
            error: j.status === 0 ? `${PESAN_SINYAL} Ini bukan daftar kosong.` : j.status === 401 ? "Sesi login berakhir; masuk ulang lalu coba lagi."
                : j.status === 403 ? "Akun Anda belum punya izin melihat order sales." : "Server order sales tidak menjawab dengan benar.",
        };
    }, []);
    const [orderSaya, muatUlangOrder] = useLoad(muatOrder);

    // Cakupan cabang salesman (cabang karyawan Accurate yang ditautkan ke akun). `blokir` = jawaban PASTI (belum tertaut / karyawan tidak
    // aktif) → penjelasan menggantikan formulir; putus / server sibuk = galat sementara (bukan "belum tertaut").
    const muatPeta = useCallback(async (): Promise<Load<DataCakupan>> => {
        const r = await muatCakupan();
        if ("cakupan" in r) return { status: "siap", data: { cakupan: r.cakupan } };
        if ("blokir" in r) return { status: "siap", data: { blokir: r.blokir } };
        return { status: "galat", error: kalimatGalat(r.galat) };
    }, []);
    const [petaL, muatUlangPeta] = useLoad(muatPeta);
    const blokir = petaL.data?.blokir ?? null;

    // Nilai transaksi dan saran promo dihitung server; sales melihat, tidak menentukan.
    const filled = lines.filter((line) => line.code.trim());
    const barisSiap = (l: Line) => Boolean(l.barang && l.unit.trim() && Number(l.quantity) > 0);
    const siapPratinjau = Boolean(pelanggan && channel.trim() && tanggalSah(orderDate) && filled.length > 0 && filled.every(barisSiap));
    const previewKey = JSON.stringify([channel, orderDate, kodePel, lines.map((l) => [l.code, l.unit, l.quantity])]);
    const pratinjau: Pratinjau | null = !siapPratinjau ? null : hasil?.key === previewKey ? hasil.p : { status: "memuat" };
    useEffect(() => {
        if (!siapPratinjau) return;
        let hidup = true;
        const timer = setTimeout(async () => {
            const p = await hitungPratinjau({ channel, orderDate, customerNo: kodePel, peran: "sales",
                lines: lines.filter((l) => l.code.trim()).map((l) => ({ code: l.code, unit: l.unit, quantity: l.quantity })) });
            if (hidup) setHasil({ key: previewKey, p });
        }, 600);
        return () => { hidup = false; clearTimeout(timer); };
        // previewKey SUDAH memuat channel, tanggal, pelanggan, dan kode/satuan/jumlah tiap baris.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey, siapPratinjau, ulangPratinjau]);
    const hitungUlang = () => { setHasil(null); setUlangPratinjau((v) => v + 1); };
    const berubahKini = berubah?.key === previewKey ? berubah : null;

    const updateLine = (index: number, key: "unit" | "quantity", value: string) => {
        ubahIsian();
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    };
    const pilihBarang = (index: number, b: BarangPilih) => {
        ubahIsian();
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, code: b.no, barang: b, bacaan: null, unit: satuanAwal(b, line.unit) } : line)));
    };
    const lepasBarang = (index: number) => {
        ubahIsian();
        setLines((prev) => prev.map((line, i) => (i === index ? { ...emptyLine() } : line)));
    };

    const lengkap = lines.filter(barisSiap);
    const tidakLengkap = lines.findIndex((line) => line.barang && !(line.unit.trim() && Number(line.quantity) > 0));
    const menunggu = lines.findIndex((line) => line.code.trim() && !line.barang);
    const salahSatuan = pratinjau?.status === "satuan"
        ? lines.findIndex((line) => pratinjau.wrong.some((w) => w.code === line.code.trim() && w.unit === line.unit.trim().toUpperCase())) : -1;
    const salahBarang = pratinjau?.status === "barang" ? lines.findIndex((line) => line.code.trim() in pratinjau.galat.perBarang) : -1;
    const tanpaHargaIdx = pratinjau?.status === "siap" ? lines.findIndex((line) => pratinjau.tanpaHarga.includes(line.code.trim())) : -1;
    const terkunciIsian = petaL.status === "memuat" && !petaL.data ? "Memuat cabang Anda"
        : petaL.status === "galat" && !petaL.data ? "Cabang Anda belum terbaca; muat ulang halaman ini"
            : blokir ? "Akun belum dihubungkan ke karyawan Accurate — hubungi Admin"
                : pel.state.jenis === "kosong" ? "Cari dan pilih pelanggan"
                    : pel.state.jenis === "memuat" ? "Membaca data pelanggan"
                        : pel.state.jenis === "galat" ? "Data pelanggan belum terbaca; pilih pelanggan lagi"
                            : !outlet.trim() ? "Isi nama outlet"
                                : !channel.trim() ? (channelMasalah || "Channel outlet belum dipastikan dari master")
                                    : !tanggalSah(orderDate) ? "Isi tanggal order"
                                    : filled.length === 0 ? "Cari dan pilih barang"
                                        : menunggu >= 0 ? `Menunggu data barang ${menunggu + 1}`
                                            : tidakLengkap >= 0 ? `Lengkapi satuan dan jumlah barang ${tidakLengkap + 1}`
                                                : salahSatuan >= 0 ? `Perbaiki satuan barang ${salahSatuan + 1}`
                                                    : salahBarang >= 0 && pratinjau?.status === "barang" ? alasanKunciBarang(pratinjau.galat, salahBarang + 1)
                                                        : pratinjau?.status === "galat" ? (pratinjau.galat.menolak ? `${pratinjau.galat.judul}. ${pratinjau.galat.tindakan}` : "Perkiraan harga belum tersedia — hitung ulang dulu")
                                                            : tanpaHargaIdx >= 0 ? `Harga barang ${tanpaHargaIdx + 1} belum ada di Accurate untuk cabang ini — belum bisa dikirim`
                                                                : pratinjau?.status === "memuat" ? "Menunggu harga dihitung"
                                                                    : pratinjau?.status === "siap" && pratinjau.channelMasalah ? pratinjau.channelMasalah
                                                                        : pratinjau?.status === "siap" && !pratinjau.sidik ? "Pratinjau lengkap belum tersedia — hitung ulang dulu" : undefined;
    const terkunci = tidakPasti ? "Periksa Order saya dulu — order terakhir mungkin sudah masuk" : terkunciIsian;
    // Draf = barang/catatan yang belum dikirim (pelanggan saja tidak dijaga: tetap terisi setelah kirim seperti halaman lama).
    const draf = Boolean(note.trim() || filled.length > 0);
    useUnsavedGuard(draf);
    const tawaran = useMemo(() => (diputuskan ? null : bacaDrafOrder(drafRaw)), [diputuskan, drafRaw]);
    // Dihapus hanya bila draf SESI INI dikosongkan sendiri: ketukan pertama di kolom mana pun tidak menghapus draf lama yang belum diputuskan.
    const adaDrafSesi = useRef(false);
    const mengirim = useRef(false); // selama POST berjalan draf (bertanda TERPUTUS) tidak ditimpa pembaruan layar lain
    const barisDraf = JSON.stringify(buatBarisDraf(lines));
    useEffect(() => {
        if (mengirim.current) return;
        if (draf) { tulisPonsel(kunciDraf, { customerNo: kodePel, outlet, note, lines: JSON.parse(barisDraf) as BarisDraf[], tidakPasti }); adaDrafSesi.current = true; }
        else if (adaDrafSesi.current) { hapusPonsel(kunciDraf); adaDrafSesi.current = false; }
    }, [kunciDraf, draf, kodePel, outlet, note, barisDraf, tidakPasti]);

    async function kirim() {
        // Sidik pratinjau TERAKHIR untuk isian yang sekarang; tombol Kirim sudah terkunci bila tidak ada, ini sabuk pengaman.
        const sidik = pratinjau?.status === "siap" ? pratinjau.sidik : null;
        if (!sidik) throw new Error("Pratinjau harga dan promo belum tersedia untuk isian ini. Tunggu perkiraan selesai atau hitung ulang, lalu kirim lagi.");
        const isi = { customerNo: kodePel, outlet, note, lines: buatBarisDraf(lines) };
        tulisPonsel(kunciDraf, { ...isi, tidakPasti: TERPUTUS }); // lihat DRAF_ORDER: dilepas hanya oleh jawaban pasti
        mengirim.current = true;
        try { await kirimSekali(isi, sidik); } finally { mengirim.current = false; }
    }
    async function kirimSekali(isi: { customerNo: string; outlet: string; note: string; lines: BarisDraf[] }, sidik: string) {
        const j = await send("POST", "/websales/orders", {
            outlet, channel, order_date: orderDate, note, customer_no: kodePel.trim(), sidik,
            lines: lengkap.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
        });
        const sukses = j.status >= 200 && j.status < 300 && j.data !== null && Boolean(j.data.ok);
        // Tidak pasti = putus, badan bukan JSON, >= 502 tanpa kode, atau LAYANAN_TIDAK_PASTI. 503 KONFIGURASI_SERVER = PASTI tidak tersimpan.
        if (!sukses && galatDariJawaban(j, "sales").tidakPasti) {
            // Order Web Sales TIDAK idempoten: jawaban tidak pasti → Kirim ditahan (terkunci) sampai isian diubah atau "Kirim lagi" eksplisit.
            setDialog(null);
            setTidakPasti(`${j.status === 0 ? PESAN_SINYAL : "Server tidak memberi jawaban yang pasti."} Order mungkin sudah masuk. Periksa Order saya di bawah sebelum mengirim ulang; isian tidak dihapus.`);
            muatUlangOrder();
            return;
        }
        if (!sukses) {
            tulisPonsel(kunciDraf, { ...isi, tidakPasti }); // ditolak pasti = tidak ada order baru; tanda sebelumnya kembali
            const baru = pratinjauBerubah(j);
            if (baru) {
                // Angka berubah sejak pratinjau: BELUM terkirim. Dialog ditutup, angka baru dihitung ulang dan ditampilkan; kirim lagi = konfirmasi ulang.
                setDialog(null);
                setBerubah({ key: previewKey, lama: netto, baru: rupiah(baru.net) });
                hitungUlang();
                return;
            }
            const g = galatDariJawaban(j, "sales");
            throw new Error(kalimatPenolakan(g) || "Order ditolak server.");
        }
        const req = ((j.data as Record<string, unknown>).request ?? {}) as { id?: string };
        hapusPonsel(kunciDraf); // langsung, bukan lewat efek: tetap terhapus walau halaman sudah ditinggalkan
        adaDrafSesi.current = false;
        setDialog(null);
        setTidakPasti("");
        setSukses(req.id ? nomorPermintaan(String(req.id)) : "terkirim");
        setLines([emptyLine()]);
        setNote("");
        setHasil(null);
        setBerubah(null);
        muatUlangOrder();
    }

    const nTanpaHarga = pratinjau?.status === "siap" ? pratinjau.tanpaHarga.length : 0;
    const netto = pratinjau?.status === "siap" && pratinjau.result ? rupiah(pratinjau.result.net ?? 0) : null;
    const hasilPratinjau = pratinjau?.status === "siap" ? pratinjau.result : null;
    const saranServer = pratinjau?.status === "siap" ? pratinjau.suggestions : [];
    // Saran "hampir dapat" dari server dibagi per baris (program jumlah) dan ringkasan order (program nilai); semua angkanya dari server.
    const { perBaris: saranBaris, ringkasan: saranRingkasan } = pecahSaran(saranServer, lines);
    const namaBarang = (code: string) => lines.find((l) => l.code.trim() === code)?.barang?.name || code;
    const cabangPelanggan = pelanggan?.branchName ?? "";

    return (
        <div>
            <div className="fi-page" style={{ maxWidth: "48rem" }}>
                <div className="fi-page-head">
                    <h1>Order Sales</h1>
                    <p>Kirim jumlah barang; harga cabang pelanggan, diskon, dan bonus dihitung server dari master Accurate dan promo yang berlaku.</p>
                </div>
                {sukses && (
                    <MessageStrip tone="pos" title={sukses === "terkirim" ? "Order terkirim." : `Order terkirim · No. permintaan ${sukses}.`}>
                        Menunggu ditarik petugas. Statusnya terlihat di Order saya.
                    </MessageStrip>
                )}
                {tidakPasti && (
                    <MessageStrip tone="warn" title="Hasil kirim belum pasti.">
                        {tidakPasti}{" "}
                        <Button variant="tertiary" disabled={Boolean(terkunciIsian)} disabledReason={terkunciIsian} onClick={() => setDialog("ulang")}>Kirim lagi…</Button>
                    </MessageStrip>
                )}
                {tawaran && !blokir && (
                    <MessageStrip tone="info" title="Ada draf order di ponsel ini.">
                        {[tawaran.customerNo.trim() || "Tanpa kode pelanggan", tawaran.outlet.trim(), `${tawaran.lines.filter((l) => l.code.trim()).length} barang`].filter(Boolean).join(" · ")}
                        {tawaran.disimpan && ` · disimpan ${jamWita(tawaran.disimpan)}`}.
                        {tawaran.tidakPasti && " Kiriman terakhirnya belum pasti — periksa Order saya sebelum mengirim lagi."}
                        {" "}Tanggal order kembali ke hari ini; pelanggan dan barang dibaca ulang dari master. Mulai mengisi akan menggantinya.{" "}
                        <Button variant="tertiary" onClick={() => void pulihkan()}>Pulihkan draf</Button>{" "}
                        <Button variant="tertiary" onClick={() => setDialog("buang")}>Buang…</Button>
                    </MessageStrip>
                )}
                {draf && !sukses && !blokir && <p className="fi-draft" role="status">{simpanPonsel
                    ? "Isian belum dikirim — tersimpan sebagai draf di ponsel ini, belum di server."
                    : "Isian belum dikirim — belum tersimpan di server maupun di ponsel; jangan tutup halaman ini."}</p>}

                {blokir ? (
                    <Section title="Order belum bisa dibuat">
                        <div className="fi-sect-in">
                            <MessageStrip tone="warn" title={`${blokir.judul}.`}>{blokir.pesan}</MessageStrip>
                            <p>{blokir.tindakan}</p>
                            <p className="fi-small fi-muted">Sesudah Admin menautkan akun Anda, buka ulang halaman ini. Order yang sudah pernah Anda kirim tetap terlihat di bawah.</p>
                        </div>
                    </Section>
                ) : (
                    <>
                        <Section title="Pelanggan" subtitle={petaL.data?.cakupan?.branchName ? `cabang ${petaL.data.cakupan.branchName}` : undefined}>
                            <div className="fi-sect-in">
                                {petaL.status === "memuat" && !petaL.data ? <Skeleton rows={2} label="Memuat cabang Anda" />
                                    : petaL.status === "galat" && !petaL.data ? <ErrorState title="Cabang Anda belum terbaca" message={petaL.error} onRetry={muatUlangPeta} />
                                        : (
                                            <>
                                                {tokoRute.length > 0 && (
                                                    <FormField label="Toko di rute hari ini" help="Dari Rute hari ini yang terakhir dibuka di ponsel ini.">
                                                        {(a) => (
                                                            <select {...a} className="fi-input" value={tokoRute.some((t) => t.kode === kodePel) ? kodePel : ""}
                                                                onChange={(e) => {
                                                                    if (!e.target.value) return;
                                                                    ubahIsian();
                                                                    setOutlet("");
                                                                    void pel.bacaKode(e.target.value).then((p) => { if (p) setOutlet(p.name); });
                                                                }}>
                                                                <option value="">Pilih toko</option>
                                                                {tokoRute.map((t) => <option key={t.kode} value={t.kode}>{t.nama} · {t.kode}</option>)}
                                                            </select>
                                                        )}
                                                    </FormField>
                                                )}
                                                <PemilihPelanggan state={pel.state} peran="sales" cakupan={petaL.data?.cakupan}
                                                    onPilih={(p) => { ubahIsian(); setOutlet(p.name); pel.pilih(p); }}
                                                    onLepas={() => { ubahIsian(); pel.lepas(); }}
                                                    onBacaUlang={(kode) => { void pel.bacaKode(kode); }} />
                                                <div className="fi-formgrid">
                                                    <FormField label="Outlet" required help={pelanggan ? undefined : "Terisi dari nama pelanggan yang dipilih."}>
                                                        {(a) => <input {...a} className="fi-input" value={outlet} placeholder="Nama outlet" onChange={(e) => { ubahIsian(); setOutlet(e.target.value); }} />}
                                                    </FormField>
                                                    <FormField label="Tanggal order" help="Bawaan hari ini (WITA). Harga di daftar barang mengikuti tanggal ini.">
                                                        {(a) => <input {...a} type="date" className="fi-input" value={orderDate} onChange={(e) => { ubahIsian(); setTanggalIsi(e.target.value); }} />}
                                                    </FormField>
                                                    <FormField label="Catatan">
                                                        {(a) => <input {...a} className="fi-input" value={note} placeholder="opsional" onChange={(e) => { ubahIsian(); setNote(e.target.value); }} />}
                                                    </FormField>
                                                </div>
                                                {channelMasalah && (
                                                    /* Ditahan, dan sebabnya disebut. Server menolak order tanpa channel juga; menyebutkan alasannya di sini membuat
                                                       sales tahu SIAPA yang membetulkannya, bukan menekan Kirim sampai layarnya berhenti mengeluh. */
                                                    <MessageStrip tone="warn">{channelMasalah}</MessageStrip>
                                                )}
                                                {pratinjau?.status === "galat" && pratinjau.galat.menolak && (
                                                    <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.pesan} {pratinjau.galat.tindakan}</MessageStrip>
                                                )}
                                                {pratinjau?.status === "siap" && pratinjau.channelMasalah && (
                                                    <MessageStrip tone="warn" title="Channel pelanggan berbeda dari master.">{pratinjau.channelMasalah} Order ini akan ditolak sampai channel pelanggan dibetulkan di Accurate.</MessageStrip>
                                                )}
                                                <VariantNote bl="BL-32">Pencarian pelanggan dan barang sudah per cabang karyawan Accurate Anda. Belum dibatasi ke toko di JKS Anda. Usulan: hanya toko JKS salesman.</VariantNote>
                                            </>
                                        )}
                            </div>
                        </Section>

                        <Section title="Barang" subtitle={`${lines.length} baris${cabangPelanggan ? ` · barang cabang ${cabangPelanggan}` : ""}`}>
                            <ul aria-label="Barang" style={{ listStyle: "none", padding: 0 }}>
                                {lines.map((line, index) => {
                                    const code = line.code.trim();
                                    const wrong = pratinjau?.status === "satuan" ? pratinjau.wrong.find((w) => w.code === code && w.unit === line.unit.trim().toUpperCase()) : undefined;
                                    const bedaCabang = pratinjau?.status === "barang" ? pratinjau.galat.perBarang[code] : undefined;
                                    const price = pratinjau?.status === "siap" ? pratinjau.prices.find((row) => row.code === code && row.unit === line.unit && row.price != null) : undefined;
                                    const tanpaHarga = pratinjau?.status === "siap" && pratinjau.tanpaHarga.includes(code);
                                    const lengkapBaris = Boolean(line.barang && line.unit.trim() && Number(line.quantity) > 0);
                                    const berlakuHarga = line.barang?.hargaUntuk === kunciHarga(pelanggan?.id, orderDate);
                                    return (
                                        // Nomor baris dibuat eksplisit: di layar HP baris kedua dan ketiga terlihat sama saja, dan sales mengoreksi baris yang salah.
                                        <li key={index} className="fi-sect-in" style={{ borderBottom: "1px solid var(--line)" }} aria-label={`Barang ${index + 1}`}>
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="fi-tag">Barang {index + 1}</span>
                                                {lines.length > 1 && (
                                                    <Button variant="icon" aria-label={`Hapus barang ${index + 1}`} onClick={() => { ubahIsian(); setLines((prev) => prev.filter((_, i) => i !== index)); }}>
                                                        <Trash2 className="fi-icon" aria-hidden />
                                                    </Button>
                                                )}
                                            </div>
                                            <PemilihBarang nomor={index + 1} pelanggan={pelanggan} tanggal={orderDate} nilai={line.barang} bacaan={line.bacaan} peran="sales"
                                                onPilih={(b) => pilihBarang(index, b)} onLepas={() => lepasBarang(index)}
                                                onBacaUlang={pelanggan ? () => void muatBarangKode(index, code, pelanggan, orderDate) : undefined} />
                                            {bedaCabang && pratinjau?.status === "barang" && <p className="fi-msg" role="alert">{bedaCabang} {pratinjau.galat.tindakan}</p>}
                                            {line.barang && (
                                                <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(0,3fr) minmax(0,2fr)" }}>
                                                    <FormField label="Satuan" error={wrong ? `Satuan ${wrong.unit} tidak ada untuk ${wrong.code}. Pilih ${wrong.known_units.join(" atau ")}.` : undefined}
                                                        help={line.barang.units.length === 0 ? "Belum ada daftar harga" : undefined}>
                                                        {(a) => (
                                                            <select {...a} className="fi-input" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)}>
                                                                <option value="">pilih</option>
                                                                {/* Satuan tanpa harga master sah tidak bisa dipesan sales (harga tidak pernah dikirim dari sini). */}
                                                                {line.barang!.units.map((u) => <option key={u.unit} value={u.unit} disabled={berlakuHarga && u.price === null}>{labelSatuan(u, berlakuHarga, rupiah)}</option>)}
                                                            </select>
                                                        )}
                                                    </FormField>
                                                    <FormField label="Jumlah">
                                                        {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={line.quantity} placeholder="0" onChange={(e) => updateLine(index, "quantity", e.target.value)} />}
                                                    </FormField>
                                                </div>
                                            )}
                                            {lengkapBaris && pratinjau && (
                                                <div className="flex flex-wrap items-center gap-2 fi-small" aria-live="polite">
                                                    {pratinjau.status === "memuat" && <StatusBadge tone="info" busy>Menghitung harga…</StatusBadge>}
                                                    {price && <><StatusBadge tone="pos">Harga ada</StatusBadge><span className="fi-muted fi-tnum">{price.priceCategoryName || "standar"} {rupiah(price.price ?? 0)} per {price.unit} (estimasi)</span>
                                                        {hargaCabangDefault(price, cabangPelanggan) && <StatusBadge tone="neu">harga cabang default{price.branchName ? ` · ${price.branchName}` : ""}</StatusBadge>}</>}
                                                    {tanpaHarga && <><StatusBadge tone="neg">Harga belum ada</StatusBadge><span className="fi-muted">Belum bisa dikirim: harga barang ini belum ada di Accurate untuk cabang pelanggan. Minta petugas melengkapinya.</span></>}
                                                </div>
                                            )}
                                            {lengkapBaris && <PromoBarisInfo result={hasilPratinjau} code={code} unit={line.unit} nomor={index + 1} saran={saranServer} />}
                                            {lengkapBaris && (saranBaris.get(index)?.length ?? 0) > 0 && (
                                                <KartuPromoBaris nomor={index + 1} kodeBaris={code} unitBaris={line.unit} saran={saranBaris.get(index)!} namaBarang={namaBarang}
                                                    onTambah={(n) => updateLine(index, "quantity", String(Number(line.quantity) + n))} />
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                            <div className="fi-sect-in">
                                <div><Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { ubahIsian(); setLines((prev) => [...prev, emptyLine()]); }}>Tambah barang</Button></div>
                                {berubahKini && (
                                    <MessageStrip tone="warn" title="Hitungan berubah sejak pratinjau — order BELUM terkirim.">
                                        Netto estimasi {berubahKini.lama ?? "—"} menjadi {berubahKini.baru} (harga atau promo berubah). Periksa angka baru di bawah, lalu kirim lagi.
                                    </MessageStrip>
                                )}
                                {pratinjau?.status === "galat" && !pratinjau.galat.menolak && (
                                    <MessageStrip tone="warn" title="Perkiraan harga tidak tersedia.">
                                        {pratinjau.galat.pesan} {pratinjau.galat.tindakan} Order baru bisa dikirim sesudah perkiraan tersedia.{" "}
                                        <Button variant="tertiary" onClick={hitungUlang}>Hitung ulang</Button>
                                    </MessageStrip>
                                )}
                                {pratinjau?.status === "satuan" && <MessageStrip tone="neg" title="Satuan tidak cocok dengan master.">Perbaiki satuan di barisnya; nilai order dihitung setelah semua satuan cocok.</MessageStrip>}
                                {pratinjau?.status === "barang" && <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.tindakan}</MessageStrip>}
                                {pratinjau?.status === "siap" && pratinjau.catatan && <MessageStrip tone="warn" title="Perkiraan tidak tersedia.">{kalimatGalat(pratinjau.catatan)}{" "}<Button variant="tertiary" onClick={hitungUlang}>Hitung ulang</Button></MessageStrip>}
                                {pratinjau?.status === "siap" && pratinjau.result && (
                                    <PanelPromo result={pratinjau.result} suggestions={pratinjau.suggestions} nTanpaHarga={nTanpaHarga} saranRingkasan={saranRingkasan} namaBarang={namaBarang}
                                        catatan="Perkiraan memakai aturan promo yang terbit sekarang; angka final dibekukan petugas saat order ditarik." />
                                )}
                                {pratinjau?.status === "siap" && !pratinjau.result && nTanpaHarga > 0 && (
                                    <p className="fi-small fi-why">{nTanpaHarga} barang belum berharga; netto estimasi belum bisa dihitung.</p>
                                )}
                            </div>
                        </Section>
                    </>
                )}

                <Section title="Order saya" subtitle="permintaan terbaru">
                    {orderSaya.status === "galat" && !orderSaya.data?.length ? (
                        <ErrorState title="Order saya gagal dimuat" message={orderSaya.error} onRetry={muatUlangOrder} />
                    ) : !orderSaya.data ? (
                        <div className="fi-sect-in"><Skeleton rows={3} label="Memuat order saya" /></div>
                    ) : (
                        <div className={orderSaya.status === "memuat" ? "fi-busy" : undefined}>
                            {orderSaya.status === "galat" && (
                                <div className="fi-sect-in">
                                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                                        {orderSaya.error} Yang tampil adalah hasil sebelumnya.{" "}
                                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlangOrder}>Coba lagi</button>
                                    </MessageStrip>
                                </div>
                            )}
                            {orderSaya.data.length === 0 ? (
                                <EmptyState title="Belum ada order terkirim" message="Order yang dikirim muncul di sini dengan nomor permintaan." />
                            ) : (
                                <ul aria-label="Order saya" style={{ listStyle: "none", padding: 0 }}>
                                    {orderSaya.data.map((row) => (
                                        <li key={row.id}>
                                            <ListItem doc={nomorPermintaan(row.id)} title={row.outlet}
                                                meta={`${row.channel} · order ${tanggalPendek(row.order_date)}${row.created_at ? ` · dikirim ${jamWita(row.created_at)}` : ""}`}
                                                badge={row.status === "pulled" ? <StatusBadge tone="pos">Sudah ditarik petugas</StatusBadge>
                                                    : row.status === "rejected" ? <StatusBadge tone="neg">Ditolak petugas</StatusBadge> : <StatusBadge tone="info">Menunggu ditarik petugas</StatusBadge>} />
                                            {row.status === "rejected" && (
                                                <p className="fi-small fi-why" style={{ padding: "0 14px 10px" }}>
                                                    {kalimatPenolakan(galatDariJawaban({ status: 409, data: { kode: row.reject_code ?? "", error: row.reject_reason ?? "" } }, "sales")) || "Ditolak saat ditarik."} Order ini tidak akan diproses; buat order baru dengan isian yang sudah dibetulkan.
                                                </p>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                    <div className="fi-sect-in">
                        <VariantNote bl="BL-18">Status hanya “menunggu ditarik” atau “sudah ditarik petugas”; butuh harga, difakturkan, dan dibatalkan belum terlihat, dan salesman belum bisa membatalkan. Usulan: status sampai faktur dan batal selama belum ditarik.</VariantNote>
                    </div>
                </Section>
            </div>
            {!blokir && (
                <FooterToolbar message={terkunci ?? `${lengkap.length} barang${netto ? ` · netto estimasi ${netto} sebelum PPN` : ""}${nTanpaHarga ? ` · ${nTanpaHarga} belum berharga` : ""}`}>
                    <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(terkunci)} disabledReason={terkunci} onClick={() => setDialog("biasa")}>Kirim order…</Button>
                </FooterToolbar>
            )}
            <ConfirmDialog open={dialog === "buang"} onClose={() => setDialog(null)} tone="negative" title="Buang draf order di ponsel ini?"
                description="Draf yang belum dikirim dihapus dari ponsel ini dan tidak bisa dikembalikan. Order yang sudah terkirim tidak terpengaruh."
                facts={tawaran ? [["Pelanggan", tawaran.customerNo.trim() || "–"], ["Barang", `${tawaran.lines.filter((l) => l.code.trim()).length} baris`]] : []}
                confirmLabel="Buang draf" onConfirm={buangDraf} />
            <ConfirmDialog open={dialog === "biasa" || dialog === "ulang"} onClose={() => setDialog(null)}
                title={dialog === "ulang" ? `Kirim lagi order untuk ${outlet || kodePel}?` : `Kirim order untuk ${outlet || kodePel}?`}
                tone={dialog === "ulang" ? "negative" : "primary"}
                description={dialog === "ulang"
                    ? "Jawaban kiriman sebelumnya tidak pasti. Bila order itu sudah masuk (periksa Order saya), kiriman ini mencatat order yang sama DUA kali dan belum bisa dibatalkan dari ponsel."
                    : berubahKini ? `Angka berubah sejak pratinjau sebelumnya: netto ${berubahKini.lama ?? "—"} menjadi ${berubahKini.baru}. Kirim lagi hanya bila angka baru ini sudah Anda periksa. Order yang sudah terkirim belum bisa dibatalkan dari ponsel.`
                        : "Order masuk antrean petugas; harga dan promo final dibekukan saat ditarik. Order yang sudah terkirim belum bisa dibatalkan dari ponsel."}
                facts={[
                    ["Pelanggan", `${kodePel.trim()}${pelanggan ? ` · ${pelanggan.name}` : ""}`],
                    ["Cabang", cabangPelanggan || "–"],
                    ["Channel", channel],
                    ["Tanggal order", tanggalPendek(orderDate)],
                    ["Barang", `${lengkap.length} baris`],
                    ["Netto estimasi (sebelum PPN)", netto ?? "dihitung petugas"],
                    ...(nTanpaHarga ? [["Belum berharga", `${nTanpaHarga} barang`] as [string, string]] : []),
                ]}
                confirmLabel={dialog === "ulang" ? "Kirim lagi" : "Kirim order"} onConfirm={kirim} />
        </div>
    );
}
