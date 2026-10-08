/*
 * Tujuan: Order Sales + Order saya (Fiori S5, it05, ponsel dulu) — sales mengirim kuantitas; harga per baris, diskon, dan bonus
 *   dihitung server dan ditampilkan; nomor permintaan tampil setelah kirim; Order saya membedakan galat dari kosong.
 * Caller: ./page.tsx (/sales; dibatasi izin `websales.create`, bukan `order.create`).
 * Dependensi: /api/customers/lookup, /api/outlet-channel, /api/items/units, /api/orders/preview, FastAPI /websales/orders (+ /api/me untuk
 *   CSRF); ../form-kontrol/lapangan (ambilJson, PESAN_SINYAL, toko rute tersimpan); ../form-kontrol/shared (hariIniWita);
 *   components/fiori/*; lib/promo-ui (rupiah);
 *   lib/rekapan-nota/ui (tanggalPendek, jamWita).
 * Main Functions: OrderSales, hitungPratinjau, send, csrfHeader.
 * Side Effects: HTTP; permintaan order masuk ke basis data Web Sales yang terpisah. Payload POST sama dengan halaman lama (tanggal
 *   order bawaan kini hari ini WITA, bukan UTC).
 *
 * Sales TIDAK mengirim harga: yang dikirim hanya kode, satuan, jumlah. Nilai transaksi dihitung server dari master Accurate + aturan
 * promo terbit, dan ditampilkan di sini supaya sales tahu angkanya. Satuan hanya boleh dari master (salah satuan = nilai salah
 * puluhan kali).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Lightbulb, Plus, Send, Trash2 } from "lucide-react";
import { Button, EmptyState, ErrorState, FooterToolbar, KeyValues, ListItem, MessageStrip, Section, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { rupiah } from "@/lib/promo-ui";
import { jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { PESAN_SINYAL, RUTE_TERSIMPAN, ambilJson, bacaRuteTersimpan, type Jawaban } from "../form-kontrol/lapangan";
import { hariIniWita } from "../form-kontrol/shared";

const API_BASE = resolveApiBase();

type Line = { code: string; unit: string; quantity: string };
type ItemMaster = { found: boolean; name: string; units: string[] };
type CustomerMaster = { found: boolean; name: string; area: string; priceCategoryName: string };
type Suggestion = { program_id: string; message: string; codes: string[] };
type PriceInfo = { code: string; unit: string; price: number; source: string; priceCategoryName: string | null };
type Result = { gross: string; discount: string; net: string; bonuses: { code: string; unit: string; quantity: string; eligible_codes?: string[] }[] };
type WrongUnit = { code: string; unit: string; known_units: string[] };
/** siap: harga ada (tanpaHarga = kode yang belum berharga, tidak ikut netto); satuan: 409 wrong_unit; galat: lainnya (kirim tidak ditahan). */
type Pratinjau =
    | { status: "memuat" }
    | { status: "siap"; result: Result | null; suggestions: Suggestion[]; prices: PriceInfo[]; tanpaHarga: string[]; catatan?: string }
    | { status: "satuan"; wrong: WrongUnit[] }
    | { status: "galat"; error: string };
type RequestRow = { id: string; outlet: string; channel: string; order_date: string; status: string; created_at: string };

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

/** Pratinjau server. 409 `missing` → pratinjau kedua hanya dari baris berharga, supaya harga per baris dan netto estimasi tetap tampil. */
async function hitungPratinjau(channel: string, orderDate: string, customerNo: string, filled: Line[]): Promise<Pratinjau> {
    const panggil = (ls: Line[]) => ambilJson("/api/orders/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            channel, order_date: orderDate, customer_no: customerNo.trim(),
            lines: ls.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
        }),
    });
    const siap = (d: Record<string, unknown>, tanpaHarga: string[]): Pratinjau => ({
        status: "siap", result: (d.result as Result) ?? null, suggestions: (d.suggestions as Suggestion[]) ?? [], prices: (d.prices as PriceInfo[]) ?? [], tanpaHarga,
    });
    const j = await panggil(filled);
    if (j.status === 0) return { status: "galat", error: `${PESAN_SINYAL} Harga belum bisa dihitung; order tetap bisa dikirim.` };
    const d = j.data ?? {};
    if (j.status >= 200 && j.status < 300 && d.ok) return siap(d, []);
    if (j.status === 409 && Array.isArray(d.wrong_unit)) return { status: "satuan", wrong: d.wrong_unit as WrongUnit[] };
    if (j.status === 409 && Array.isArray(d.missing)) {
        const tanpaHarga = [...new Set((d.missing as unknown[]).map(String))];
        const berharga = filled.filter((line) => !tanpaHarga.includes(line.code.trim()));
        if (berharga.length === 0) return { status: "siap", result: null, suggestions: [], prices: [], tanpaHarga };
        const k = await panggil(berharga);
        if (k.status >= 200 && k.status < 300 && k.data?.ok) return siap(k.data, tanpaHarga);
        return { status: "siap", result: null, suggestions: [], prices: [], tanpaHarga, catatan: String(k.data?.error || "Perkiraan barang berharga tidak tersedia") };
    }
    return { status: "galat", error: String(d.error || "Perkiraan tidak tersedia") };
}

const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1" });

/**
 * Draf order di ponsel ini (owner 8 Okt 2026): satu draf per akun per perangkat (`DRAF_ORDER.<id akun>`), ditulis selama ada isian,
 * dihapus setelah order terkirim. Dipulihkan HANYA lewat tombol; tanggal tidak ikut (kembali hari ini). Order Web Sales tidak idempoten:
 * sebelum POST draf ditandai TERPUTUS, sehingga draf dari kiriman yang tak sempat dijawab (halaman tertutup/berpindah) tetap menahan Kirim
 * setelah dipulihkan; tanda itu baru dilepas oleh jawaban pasti (sukses = draf dihapus, ditolak = tanda sebelumnya kembali).
 * ponytail: dua tab berisi draf yang sama — tab yang belum mengirim bisa menulis ulang draf yang sudah terkirim tanpa tanda; tambahkan
 * listener `storage` bila itu terjadi di lapangan.
 */
const DRAF_ORDER = "accapi.order-sales.draf.v1";
const TERPUTUS = "Kiriman order ini terputus sebelum ada jawaban server. Order mungkin sudah masuk — periksa Order saya sebelum mengirim ulang.";
type DrafOrder = { customerNo: string; outlet: string; note: string; lines: Line[]; tidakPasti: string; disimpan: string };
function bacaDrafOrder(raw: string | null): DrafOrder | null {
    try {
        const d = raw ? JSON.parse(raw) : null;
        if (!d || !Array.isArray(d.lines)) return null;
        const teks = (v: unknown) => (typeof v === "string" ? v : "");
        const lines: Line[] = d.lines.map((l: unknown) => {
            const o = (l ?? {}) as Record<string, unknown>;
            return { code: teks(o.code), unit: teks(o.unit), quantity: teks(o.quantity) };
        }).filter((l: Line) => l.code.trim());
        if (lines.length === 0 && !teks(d.note).trim()) return null;
        return { customerNo: teks(d.customerNo), outlet: teks(d.outlet), note: teks(d.note), lines: lines.length ? lines : [emptyLine()], tidakPasti: teks(d.tidakPasti), disimpan: teks(d.disimpan) };
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

export default function OrderSales({ akunId }: { akunId: string }) {
    const kunciDraf = `${DRAF_ORDER}.${akunId}`;
    // Hari ini dari jam peramban dalam WITA; snapshot server "" supaya hidrasi tidak bentrok dengan jam server.
    const hariIni = useSyncExternalStore(tanpaLangganan, hariIniKlien, () => "");
    const ruteRaw = useSyncExternalStore(tanpaLangganan, () => { try { return sessionStorage.getItem(RUTE_TERSIMPAN); } catch { return null; } }, () => null);
    const tokoRute = useMemo(() => bacaRuteTersimpan(ruteRaw, hariIni), [ruteRaw, hariIni]);

    const [customerNo, setCustomerNo] = useState("");
    const [customer, setCustomer] = useState<CustomerMaster | null>(null);
    const [outlet, setOutlet] = useState("");
    const [channel, setChannel] = useState("");
    const [channelMasalah, setChannelMasalah] = useState("");
    const [tanggalIsi, setTanggalIsi] = useState<string | null>(null);
    const orderDate = tanggalIsi ?? hariIni;
    const [note, setNote] = useState("");
    const [lines, setLines] = useState<Line[]>([emptyLine()]);
    const [master, setMaster] = useState<Record<string, ItemMaster>>({});
    const [hasil, setHasil] = useState<{ key: string; p: Pratinjau } | null>(null);
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
    // Mulai mengisi menutup tawaran draf; draf lama tetap di ponsel sampai isian baru menjadi draf (menggantikannya).
    const ubahIsian = () => { setSukses(""); setTidakPasti(""); setDiputuskan(true); };
    function pulihkan() {
        const d = bacaDrafOrder(bacaPonsel(kunciDraf)); // dibaca saat diklik: tab lain bisa sudah mengirim/mengubahnya
        setDiputuskan(true);
        if (!d) return;
        setCustomerNo(d.customerNo); setOutlet(d.outlet); setNote(d.note); setLines(d.lines); setTidakPasti(d.tidakPasti); setSukses("");
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

    // Konfirmasi pelanggan: nama dan kategori harga. Outlet diisi otomatis supaya sales tidak mengetik nama yang berbeda dari master.
    //
    // Channel ikut DITANYAKAN ke master, tidak diketik. Server sudah menolak order yang channelnya berbeda dari master
    // (`outlet_channel.verify`), jadi kotak isian bebas hanya menyediakan satu cara untuk salah: perkiraan promo dihitung untuk channel
    // yang diakui, lalu ordernya ditolak saat dikirim. Yang memutuskan promo per channel adalah master, jadi itu pula yang diperlihatkan.
    useEffect(() => {
        const code = customerNo.trim();
        if (!code) { setCustomer(null); setChannel(""); setChannelMasalah(""); return; }
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/customers/lookup?no=${encodeURIComponent(code)}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.ok) { setCustomer(null); return; }
                setCustomer({ found: Boolean(data.found), name: String(data.name ?? ""), area: String(data.area ?? ""), priceCategoryName: String(data.priceCategoryName ?? "") });
                if (data.found && !outlet.trim()) setOutlet(String(data.name ?? ""));
            } catch { setCustomer(null); }
            try {
                const res = await fetch(`/api/outlet-channel?no=${encodeURIComponent(code)}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.ok) throw new Error();
                const channels = (data.channels ?? {}) as Record<string, string>;
                const dariMaster = String(channels[code] ?? "");
                setChannel(dariMaster);
                // Tiga keadaan, tiga perbaikan yang berbeda — jadi tiga kalimat, bukan satu "channel tidak diketahui" yang tidak
                // menyuruh siapa pun berbuat apa.
                setChannelMasalah(!(code in channels)
                    ? `Outlet ${code} tidak ada di master pelanggan Accurate; sinkronkan master atau betulkan kodenya.`
                    : dariMaster ? "" : `Outlet ${code} belum punya kategori (TT/MT) di Accurate. Isi kategorinya di Accurate lebih dulu.`);
            } catch {
                setChannel("");
                setChannelMasalah("Channel outlet tidak bisa ditanyakan ke master sekarang; coba lagi sebentar lagi.");
            }
        }, 400);
        return () => clearTimeout(timer);
        // outlet sengaja tidak masuk deps: prefill hanya saat outlet masih kosong.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customerNo]);

    // Satuan dari master Accurate, satu permintaan per kode baru.
    const codesKey = [...new Set(lines.map((line) => line.code.trim()).filter(Boolean))].join(",");
    useEffect(() => {
        const pending = codesKey.split(",").filter((code) => code && !(code in master));
        if (pending.length === 0) return;
        const timer = setTimeout(async () => {
            const loaded = await Promise.all(pending.map(async (code) => {
                const fallback: [string, ItemMaster] = [code, { found: false, name: "", units: [] }];
                try {
                    const res = await fetch(`/api/items/units?code=${encodeURIComponent(code)}`);
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.ok) return fallback;
                    return [code, { found: Boolean(data.found), name: String(data.name ?? ""), units: (data.units ?? []) as string[] }] as [string, ItemMaster];
                } catch { return fallback; }
            }));
            setMaster((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
        }, 400);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    useEffect(() => {
        setLines((prev) => prev.map((line) => {
            const info = master[line.code.trim()];
            if (!info || info.units.length === 0 || info.units.includes(line.unit)) return line;
            return { ...line, unit: info.units.length === 1 ? info.units[0] : "" };
        }));
    }, [master]);

    // Nilai transaksi dan saran promo dihitung server; sales melihat, tidak menentukan.
    const filled = lines.filter((line) => line.code.trim());
    const siapPratinjau = Boolean(channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0
        && filled.every((line) => line.unit.trim() && Number(line.quantity) > 0));
    const previewKey = JSON.stringify([channel, orderDate, customerNo, lines]);
    const pratinjau: Pratinjau | null = !siapPratinjau ? null : hasil?.key === previewKey ? hasil.p : { status: "memuat" };
    useEffect(() => {
        if (!siapPratinjau) return;
        let hidup = true;
        const timer = setTimeout(async () => {
            const p = await hitungPratinjau(channel, orderDate, customerNo, lines.filter((line) => line.code.trim()));
            if (hidup) setHasil({ key: previewKey, p });
        }, 600);
        return () => { hidup = false; clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey, siapPratinjau]);

    const updateLine = (index: number, key: keyof Line, value: string) => {
        ubahIsian();
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    };

    const lengkap = lines.filter((line) => line.code.trim() && line.unit.trim() && Number(line.quantity) > 0);
    const tidakLengkap = lines.findIndex((line) => line.code.trim() && !(line.unit.trim() && Number(line.quantity) > 0));
    const salahSatuan = pratinjau?.status === "satuan"
        ? lines.findIndex((line) => pratinjau.wrong.some((w) => w.code === line.code.trim() && w.unit === line.unit.trim().toUpperCase())) : -1;
    const terkunciIsian = !customerNo.trim() ? "Isi kode pelanggan"
        : !outlet.trim() ? "Isi nama outlet"
            : !channel.trim() ? (channelMasalah || "Channel outlet belum dipastikan dari master")
                : filled.length === 0 ? "Isi kode barang"
                    : tidakLengkap >= 0 ? `Lengkapi satuan dan jumlah barang ${tidakLengkap + 1}`
                        : salahSatuan >= 0 ? `Perbaiki satuan barang ${salahSatuan + 1}`
                            : pratinjau?.status === "memuat" ? "Menunggu harga dihitung" : undefined;
    const terkunci = tidakPasti ? "Periksa Order saya dulu — order terakhir mungkin sudah masuk" : terkunciIsian;
    // Draf = barang/catatan yang belum dikirim (pelanggan saja tidak dijaga: tetap terisi setelah kirim seperti halaman lama).
    const draf = Boolean(note.trim() || filled.length > 0);
    useUnsavedGuard(draf);
    const tawaran = useMemo(() => (diputuskan ? null : bacaDrafOrder(drafRaw)), [diputuskan, drafRaw]);
    // Dihapus hanya bila draf SESI INI dikosongkan sendiri: ketukan pertama di kolom mana pun tidak menghapus draf lama yang belum diputuskan.
    const adaDrafSesi = useRef(false);
    const mengirim = useRef(false); // selama POST berjalan draf (bertanda TERPUTUS) tidak ditimpa pembaruan layar lain
    useEffect(() => {
        if (mengirim.current) return;
        if (draf) { tulisPonsel(kunciDraf, { customerNo, outlet, note, lines, tidakPasti }); adaDrafSesi.current = true; }
        else if (adaDrafSesi.current) { hapusPonsel(kunciDraf); adaDrafSesi.current = false; }
    }, [kunciDraf, draf, customerNo, outlet, note, lines, tidakPasti]);

    async function kirim() {
        const isi = { customerNo, outlet, note, lines };
        tulisPonsel(kunciDraf, { ...isi, tidakPasti: TERPUTUS }); // lihat DRAF_ORDER: dilepas hanya oleh jawaban pasti
        mengirim.current = true;
        try { await kirimSekali(isi); } finally { mengirim.current = false; }
    }
    async function kirimSekali(isi: { customerNo: string; outlet: string; note: string; lines: Line[] }) {
        const j = await send("POST", "/websales/orders", {
            outlet, channel, order_date: orderDate, note, customer_no: customerNo.trim(),
            lines: lengkap.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
        });
        if (j.status === 0 || j.status >= 502 || j.data === null) {
            // Order Web Sales TIDAK idempoten: jawaban tidak pasti → Kirim ditahan (terkunci) sampai isian diubah atau "Kirim lagi" eksplisit.
            setDialog(null);
            setTidakPasti(`${j.status === 0 ? PESAN_SINYAL : "Server tidak memberi jawaban yang pasti."} Order mungkin sudah masuk. Periksa Order saya di bawah sebelum mengirim ulang; isian tidak dihapus.`);
            muatUlangOrder();
            return;
        }
        if (j.status < 200 || j.status >= 300 || !j.data.ok) {
            const detail = j.data.detail ?? j.data.error;
            tulisPonsel(kunciDraf, { ...isi, tidakPasti }); // ditolak pasti = tidak ada order baru; tanda sebelumnya kembali
            throw new Error(typeof detail === "string" && detail ? detail : "Order ditolak server.");
        }
        const req = (j.data.request ?? {}) as { id?: string };
        hapusPonsel(kunciDraf); // langsung, bukan lewat efek: tetap terhapus walau halaman sudah ditinggalkan
        adaDrafSesi.current = false;
        setDialog(null);
        setTidakPasti("");
        setSukses(req.id ? nomorPermintaan(String(req.id)) : "terkirim");
        setLines([emptyLine()]);
        setNote("");
        setHasil(null);
        muatUlangOrder();
    }

    const nTanpaHarga = pratinjau?.status === "siap" ? pratinjau.tanpaHarga.length : 0;
    const netto = pratinjau?.status === "siap" && pratinjau.result ? rupiah(pratinjau.result.net) : null;

    return (
        <div>
            <div className="fi-page" style={{ maxWidth: "48rem" }}>
                <div className="fi-page-head">
                    <h1>Order Sales</h1>
                    <p>Kirim jumlah barang; harga, diskon, dan bonus dihitung server dari master Accurate dan promo yang berlaku.</p>
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
                {tawaran && (
                    <MessageStrip tone="info" title="Ada draf order di ponsel ini.">
                        {[tawaran.customerNo.trim() || "Tanpa kode pelanggan", tawaran.outlet.trim(), `${tawaran.lines.filter((l) => l.code.trim()).length} barang`].filter(Boolean).join(" · ")}
                        {tawaran.disimpan && ` · disimpan ${jamWita(tawaran.disimpan)}`}.
                        {tawaran.tidakPasti && " Kiriman terakhirnya belum pasti — periksa Order saya sebelum mengirim lagi."}
                        {" "}Tanggal order kembali ke hari ini; mulai mengisi akan menggantinya.{" "}
                        <Button variant="tertiary" onClick={pulihkan}>Pulihkan draf</Button>{" "}
                        <Button variant="tertiary" onClick={() => setDialog("buang")}>Buang…</Button>
                    </MessageStrip>
                )}
                {draf && !sukses && <p className="fi-draft" role="status">{simpanPonsel
                    ? "Isian belum dikirim — tersimpan sebagai draf di ponsel ini, belum di server."
                    : "Isian belum dikirim — belum tersimpan di server maupun di ponsel; jangan tutup halaman ini."}</p>}

                <Section title="Pelanggan">
                    <div className="fi-sect-in">
                        {tokoRute.length > 0 && (
                            <FormField label="Toko di rute hari ini" help="Dari Rute hari ini yang terakhir dibuka di ponsel ini.">
                                {(a) => (
                                    <select {...a} className="fi-input" value={tokoRute.some((t) => t.kode === customerNo.trim()) ? customerNo.trim() : ""}
                                        onChange={(e) => { if (!e.target.value) return; ubahIsian(); setOutlet(""); setCustomerNo(e.target.value); }}>
                                        <option value="">Pilih toko</option>
                                        {tokoRute.map((t) => <option key={t.kode} value={t.kode}>{t.nama} · {t.kode}</option>)}
                                    </select>
                                )}
                            </FormField>
                        )}
                        <div className="fi-formgrid">
                            <FormField label="Kode pelanggan Accurate" required
                                error={customer && !customer.found ? `Kode ${customerNo.trim()} tidak ada di master Accurate` : undefined}
                                help={customer?.found ? `${customer.name}${customer.area ? ` · ${customer.area}` : ""} · harga ${customer.priceCategoryName || "standar (kategori belum tersedia)"}` : undefined}>
                                {(a) => <input {...a} className="fi-input fi-mono" value={customerNo} placeholder="C.00000" autoComplete="off" onChange={(e) => { ubahIsian(); setCustomerNo(e.target.value); }} />}
                            </FormField>
                            <FormField label="Outlet" required>
                                {(a) => <input {...a} className="fi-input" value={outlet} placeholder="Nama outlet" onChange={(e) => { ubahIsian(); setOutlet(e.target.value); }} />}
                            </FormField>
                            <FormField label="Channel" help="Dari master Accurate, bukan diketik.">
                                {(a) => <input {...a} className="fi-input" readOnly value={channel || (customerNo.trim() ? "belum dipastikan" : "isi kode pelanggan dulu")} />}
                            </FormField>
                            <FormField label="Tanggal order" help="Bawaan hari ini (WITA).">
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
                        <VariantNote bl="BL-32">Pelanggan dan barang dicari dengan kode persis; belum ada pencarian nama dan belum dibatasi ke toko di JKS Anda. Usulan: cari nama atau kode, hanya toko JKS salesman.</VariantNote>
                    </div>
                </Section>

                <Section title="Barang" subtitle={`${lines.length} baris`}>
                    <ul aria-label="Barang" style={{ listStyle: "none", padding: 0 }}>
                        {lines.map((line, index) => {
                            const code = line.code.trim();
                            const info = master[code];
                            const wrong = pratinjau?.status === "satuan" ? pratinjau.wrong.find((w) => w.code === code && w.unit === line.unit.trim().toUpperCase()) : undefined;
                            const price = pratinjau?.status === "siap" ? pratinjau.prices.find((row) => row.code === code && row.unit === line.unit) : undefined;
                            const tanpaHarga = pratinjau?.status === "siap" && pratinjau.tanpaHarga.includes(code);
                            const advice = pratinjau?.status === "siap" ? pratinjau.suggestions.find((item) => item.codes.includes(code)) : undefined;
                            const lengkapBaris = code && line.unit.trim() && Number(line.quantity) > 0;
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
                                    <FormField label="Kode barang"
                                        error={info && !info.found ? `Kode ${code} tidak ada di master Accurate` : undefined}
                                        help={info?.found ? (info.units.length === 0 ? `${info.name} — belum ada daftar harga` : info.name) : undefined}>
                                        {(a) => <input {...a} className="fi-input fi-mono" value={line.code} placeholder="kode barang" autoComplete="off" onChange={(e) => updateLine(index, "code", e.target.value)} />}
                                    </FormField>
                                    <div className="grid grid-cols-2 gap-3">
                                        <FormField label="Satuan" error={wrong ? `Satuan ${wrong.unit} tidak ada untuk ${wrong.code}. Pilih ${wrong.known_units.join(" atau ")}.` : undefined}>
                                            {(a) => info && info.units.length > 0 ? (
                                                <select {...a} className="fi-input" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)}>
                                                    <option value="">pilih</option>
                                                    {info.units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                                                </select>
                                            ) : (
                                                <input {...a} className="fi-input" value={line.unit} placeholder="satuan" onChange={(e) => updateLine(index, "unit", e.target.value.toUpperCase())} />
                                            )}
                                        </FormField>
                                        <FormField label="Jumlah">
                                            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={line.quantity} placeholder="0" onChange={(e) => updateLine(index, "quantity", e.target.value)} />}
                                        </FormField>
                                    </div>
                                    {lengkapBaris && pratinjau && (
                                        <div className="flex flex-wrap items-center gap-2 fi-small" aria-live="polite">
                                            {pratinjau.status === "memuat" && <StatusBadge tone="info" busy>Menghitung harga…</StatusBadge>}
                                            {price && <><StatusBadge tone="pos">Harga ada</StatusBadge><span className="fi-muted fi-tnum">{price.priceCategoryName || "standar"} {rupiah(price.price)} per {price.unit} (estimasi)</span></>}
                                            {tanpaHarga && <><StatusBadge tone="warn">Harga belum tersedia</StatusBadge><span className="fi-muted">Order tetap bisa dikirim; petugas mengisi harga dari master.</span></>}
                                        </div>
                                    )}
                                    {advice && (
                                        <p className="fi-small fi-why flex items-start gap-1.5">
                                            <Lightbulb className="fi-icon" aria-hidden /><span>{advice.message}</span>
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <div className="fi-sect-in">
                        <div><Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { ubahIsian(); setLines((prev) => [...prev, emptyLine()]); }}>Tambah barang</Button></div>
                        {pratinjau?.status === "galat" && <MessageStrip tone="warn" title="Perkiraan harga tidak tersedia.">{pratinjau.error}</MessageStrip>}
                        {pratinjau?.status === "satuan" && <MessageStrip tone="neg" title="Satuan tidak cocok dengan master.">Perbaiki satuan di barisnya; nilai order dihitung setelah semua satuan cocok.</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.catatan && <MessageStrip tone="warn" title="Perkiraan tidak tersedia.">{pratinjau.catatan}</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.result && (
                            <div className="fi-panel" aria-label="Perkiraan nilai order">
                                <KeyValues items={[
                                    [nTanpaHarga ? "Bruto (yang sudah ada harganya)" : "Bruto", rupiah(pratinjau.result.gross)],
                                    ["Diskon", rupiah(pratinjau.result.discount)],
                                    ["Netto estimasi", rupiah(pratinjau.result.net)],
                                ]} />
                                {pratinjau.result.bonuses.map((bonus, i) => (
                                    <p key={i} className="fi-small fi-muted">
                                        Bonus {bonus.quantity} {bonus.unit} {bonus.code || `dari barang yang dibeli (${(bonus.eligible_codes || []).join(", ")})`}
                                    </p>
                                ))}
                                {nTanpaHarga > 0 && <p className="fi-small fi-why">{nTanpaHarga} barang belum berharga tidak ikut dihitung.</p>}
                                <p className="fi-small fi-subtle">Perkiraan; angka final dibekukan petugas saat order diproses.</p>
                            </div>
                        )}
                        {pratinjau?.status === "siap" && !pratinjau.result && nTanpaHarga > 0 && (
                            <p className="fi-small fi-why">{nTanpaHarga} barang belum berharga; netto estimasi belum bisa dihitung.</p>
                        )}
                    </div>
                </Section>

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
                                                badge={row.status === "pulled" ? <StatusBadge tone="pos">Sudah ditarik petugas</StatusBadge> : <StatusBadge tone="info">Menunggu ditarik petugas</StatusBadge>} />
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
            <FooterToolbar message={terkunci ?? `${lengkap.length} barang${netto ? ` · netto estimasi ${netto}` : ""}${nTanpaHarga ? ` · ${nTanpaHarga} belum berharga` : ""}`}>
                <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={Boolean(terkunci)} disabledReason={terkunci} onClick={() => setDialog("biasa")}>Kirim order…</Button>
            </FooterToolbar>
            <ConfirmDialog open={dialog === "buang"} onClose={() => setDialog(null)} tone="negative" title="Buang draf order di ponsel ini?"
                description="Draf yang belum dikirim dihapus dari ponsel ini dan tidak bisa dikembalikan. Order yang sudah terkirim tidak terpengaruh."
                facts={tawaran ? [["Pelanggan", tawaran.customerNo.trim() || "–"], ["Barang", `${tawaran.lines.filter((l) => l.code.trim()).length} baris`]] : []}
                confirmLabel="Buang draf" onConfirm={buangDraf} />
            <ConfirmDialog open={dialog === "biasa" || dialog === "ulang"} onClose={() => setDialog(null)}
                title={dialog === "ulang" ? `Kirim lagi order untuk ${outlet || customerNo}?` : `Kirim order untuk ${outlet || customerNo}?`}
                tone={dialog === "ulang" ? "negative" : "primary"}
                description={dialog === "ulang"
                    ? "Jawaban kiriman sebelumnya tidak pasti. Bila order itu sudah masuk (periksa Order saya), kiriman ini mencatat order yang sama DUA kali dan belum bisa dibatalkan dari ponsel."
                    : "Order masuk antrean petugas; harga dan promo final dibekukan saat ditarik. Order yang sudah terkirim belum bisa dibatalkan dari ponsel."}
                facts={[
                    ["Pelanggan", `${customerNo.trim()}${customer?.found ? ` · ${customer.name}` : ""}`],
                    ["Channel", channel],
                    ["Tanggal order", tanggalPendek(orderDate)],
                    ["Barang", `${lengkap.length} baris`],
                    ["Netto estimasi", netto ?? "dihitung petugas"],
                    ...(nTanpaHarga ? [["Belum berharga", `${nTanpaHarga} barang`] as [string, string]] : []),
                ]}
                confirmLabel={dialog === "ulang" ? "Kirim lagi" : "Kirim order"} onConfirm={kirim} />
        </div>
    );
}
