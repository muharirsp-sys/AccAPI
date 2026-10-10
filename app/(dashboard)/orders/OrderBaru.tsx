/*
 * Tujuan: Form Order baru (Fiori S6d, it06): pelanggan dari master (nama, kategori harga, channel), barang dengan satuan dari master dan
 *   HARGA TERISI DARI MASTER beserta sumbernya (kategori · cabang · tanggal berlaku); harga yang diubah ditandai. Simpan lewat dialog,
 *   lalu lanjut ke halaman order. Aturan promo dihitung dan dibekukan server saat disimpan.
 * Caller: ./baru/page.tsx (/orders/baru). Simpan butuh `order.create` (FastAPI POST /orders).
 * Dependensi: /api/customers/lookup, /api/outlet-channel, /api/items/units, /api/orders/preview, FastAPI POST /orders; ./order-ui;
 *   ../form-kontrol/shared (hariIniWita); components/fiori/*; lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: OrderBaru, hitungPratinjau.
 * Side Effects: HTTP; menyimpan order internal (FastAPI). Tidak ada tulis ke Accurate.
 *
 * Perubahan perilaku yang disengaja (it06 #2): harga bawaan bukan lagi 0 — kosong = ikut harga master hasil pratinjau server; harga ≤ 0
 * ditolak di layar (dulu Rp 0 tersimpan sebagai "sudah berharga"). Tanggal order bawaan = hari ini WITA (dulu tanggal UTC).
 */
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lightbulb, Plus, Save, Trash2 } from "lucide-react";
import { Button, FooterToolbar, KeyValues, MessageStrip, Section, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { hariIniWita } from "../form-kontrol/shared";
import { BELUM_PASTI, fastapi, nextApi, pesanJawaban, sukses, tidakPasti, type PriceInfo, type Result } from "./order-ui";

/** `price` null = ikut harga master dari pratinjau; teks = diketik petugas. */
type Line = { code: string; unit: string; quantity: string; price: string | null };
type ItemMaster = { found: boolean; name: string; units: string[] };
type CustomerMaster = { found: boolean; name: string; area: string; priceCategoryName: string };
type Suggestion = { program_id: string; message: string; codes: string[] };
type WrongUnit = { code: string; unit: string; known_units: string[] };
type Pratinjau =
    | { status: "memuat" }
    | { status: "siap"; result: Result | null; suggestions: Suggestion[]; prices: PriceInfo[]; tanpaHarga: string[]; catatan?: string }
    | { status: "satuan"; wrong: WrongUnit[] }
    | { status: "galat"; error: string };

const tanpaLangganan = () => () => {};
const hariIniKlien = () => hariIniWita();
const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1", price: null });
const PPN = 0.11;

/** Pratinjau server (harga HANYA dari master; harga ketikan diabaikan server). 409 `missing` → pratinjau kedua dari baris berharga. */
async function hitungPratinjau(channel: string, orderDate: string, customerNo: string, filled: Line[]): Promise<Pratinjau> {
    const panggil = (ls: Line[]) => nextApi("/api/orders/preview", {
        channel, order_date: orderDate, customer_no: customerNo.trim(),
        lines: ls.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
    });
    const siap = (d: Record<string, unknown>, tanpaHarga: string[]): Pratinjau => ({
        status: "siap", result: (d.result as Result) ?? null, suggestions: (d.suggestions as Suggestion[]) ?? [], prices: (d.prices as PriceInfo[]) ?? [], tanpaHarga,
    });
    const j = await panggil(filled);
    if (j.status === 0) return { status: "galat", error: "Server tidak dapat dihubungi; harga master belum bisa dihitung." };
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
    return { status: "galat", error: pesanJawaban(j, "Harga master dan promo belum bisa dihitung.") };
}

/** "Grosir · CABANG A · berlaku 01/10/2026" — sumber harga master satu baris. */
function sumberHarga(p: PriceInfo): string {
    if (p.source !== "tier") return "harga standar (kategori pelanggan belum tersedia)";
    return [p.priceCategoryName ?? "kategori", p.branchName, p.effectiveDate ? `berlaku ${tanggalPendek(p.effectiveDate)}` : null].filter(Boolean).join(" · ");
}

export default function OrderBaru({ permKeys }: { permKeys: string[] }) {
    const router = useRouter();
    const bolehBuat = permKeys.includes("order.create");
    const hariIni = useSyncExternalStore(tanpaLangganan, hariIniKlien, () => "");
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
    const [dialog, setDialog] = useState<null | "biasa" | "ulang">(null);
    // FastAPI POST /orders TIDAK idempoten: jawaban tidak pasti → Simpan ditahan sampai isian diubah atau "Simpan lagi" eksplisit.
    const [ragu, setRagu] = useState(false);
    const [tersimpan, setTersimpan] = useState(false);

    // Pelanggan dari master: nama, kategori harga, dan channel. Channel DITANYAKAN ke master, tidak diketik — server menolak order yang
    // channelnya berbeda dari master (`outlet_channel.verify`), jadi isian bebas hanya menyediakan satu cara untuk salah.
    useEffect(() => {
        const code = customerNo.trim();
        if (!code) { setCustomer(null); setChannel(""); setChannelMasalah(""); return; }
        const timer = setTimeout(async () => {
            const c = await nextApi(`/api/customers/lookup?no=${encodeURIComponent(code)}`);
            if (sukses(c)) {
                const d = c.data;
                setCustomer({ found: Boolean(d.found), name: String(d.name ?? ""), area: String(d.area ?? ""), priceCategoryName: String(d.priceCategoryName ?? "") });
                if (d.found && !outlet.trim()) setOutlet(String(d.name ?? ""));
            } else setCustomer(null);
            const k = await nextApi(`/api/outlet-channel?no=${encodeURIComponent(code)}`);
            if (!sukses(k)) {
                setChannel("");
                setChannelMasalah("Channel outlet tidak bisa ditanyakan ke master sekarang; coba lagi sebentar lagi.");
                return;
            }
            const channels = (k.data.channels ?? {}) as Record<string, string>;
            const dariMaster = String(channels[code] ?? "");
            setChannel(dariMaster);
            // Tiga keadaan, tiga perbaikan berbeda — tiga kalimat (pesan server apa adanya untuk kategori TT/MT).
            setChannelMasalah(!(code in channels)
                ? `Outlet ${code} tidak ada di master pelanggan Accurate; sinkronkan master atau betulkan kodenya.`
                : dariMaster ? "" : `Outlet ${code} belum punya kategori (TT/MT) di Accurate. Isi kategorinya di Accurate lebih dulu.`);
        }, 400);
        return () => clearTimeout(timer);
        // outlet sengaja tidak masuk deps: prefill hanya saat outlet masih kosong.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customerNo]);

    // Satuan dan nama barang dari master, satu permintaan per kode baru. Satuan sengaja tidak ditebak (selisih satuan bisa 72x).
    const codesKey = [...new Set(lines.map((line) => line.code.trim()).filter(Boolean))].join(",");
    useEffect(() => {
        const pending = codesKey.split(",").filter((code) => code && !(code in master));
        if (pending.length === 0) return;
        const timer = setTimeout(async () => {
            const loaded = await Promise.all(pending.map(async (code): Promise<[string, ItemMaster]> => {
                const j = await nextApi(`/api/items/units?code=${encodeURIComponent(code)}`);
                if (!sukses(j)) return [code, { found: false, name: "", units: [] }];
                return [code, { found: Boolean(j.data.found), name: String(j.data.name ?? ""), units: (j.data.units ?? []) as string[] }];
            }));
            setMaster((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
        }, 400);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    // Satuan yang tidak ada di master dibuang; satu-satunya satuan dipilih otomatis.
    useEffect(() => {
        setLines((prev) => prev.map((line) => {
            const info = master[line.code.trim()];
            if (!info || info.units.length === 0 || info.units.includes(line.unit)) return line;
            return { ...line, unit: info.units.length === 1 ? info.units[0] : "" };
        }));
    }, [master]);

    const filled = lines.filter((line) => line.code.trim());
    const siapPratinjau = Boolean(channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0
        && filled.every((line) => line.unit.trim() && Number(line.quantity) > 0));
    // Harga ketikan tidak memengaruhi pratinjau (server memakai master), jadi tidak ikut kunci.
    const previewKey = JSON.stringify([channel, orderDate, customerNo, lines.map((l) => [l.code, l.unit, l.quantity])]);
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

    const hargaMaster = (line: Line) => pratinjau?.status === "siap"
        ? pratinjau.prices.find((p) => p.code === line.code.trim() && p.unit === line.unit.trim().toUpperCase() && p.price != null) : undefined;
    const hargaDipakai = (line: Line) => line.price ?? (hargaMaster(line) ? String(hargaMaster(line)!.price) : "");
    const diubah = (line: Line) => line.price !== null && hargaMaster(line) !== undefined && Number(line.price) !== Number(hargaMaster(line)!.price);

    const ubah = (index: number, key: keyof Line, value: string | null) => {
        setRagu(false);
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    };

    const lengkap = lines.filter((line) => line.code.trim() && line.unit.trim() && Number(line.quantity) > 0);
    const tidakLengkap = lines.findIndex((line) => line.code.trim() && !(line.unit.trim() && Number(line.quantity) > 0));
    const salahSatuan = pratinjau?.status === "satuan"
        ? lines.findIndex((line) => pratinjau.wrong.some((w) => w.code === line.code.trim() && w.unit === line.unit.trim().toUpperCase())) : -1;
    const tanpaHargaIdx = lines.findIndex((line) => line.code.trim() && !(Number(hargaDipakai(line)) > 0));
    const nDiubah = lengkap.filter(diubah).length;
    const terkunciIsian = !bolehBuat ? "Akun Anda tidak berhak membuat order"
        : !customerNo.trim() ? "Pilih pelanggan dan isi minimal satu barang"
            : customer && !customer.found ? `Kode ${customerNo.trim()} tidak ada di master Accurate`
                : !outlet.trim() ? "Isi nama outlet"
                    : !channel.trim() ? (channelMasalah || "Channel outlet belum dipastikan dari master")
                        : filled.length === 0 ? "Isi minimal satu barang"
                            : tidakLengkap >= 0 ? `Lengkapi satuan dan jumlah barang ${tidakLengkap + 1}`
                                : salahSatuan >= 0 ? `Perbaiki satuan barang ${salahSatuan + 1}`
                                    : pratinjau?.status === "memuat" ? "Menunggu harga dihitung"
                                        : tanpaHargaIdx >= 0 ? `Isi harga barang ${tanpaHargaIdx + 1} (lebih dari 0; harga master belum ada)` : undefined;
    const terkunci = ragu ? "Periksa Order Masuk dulu — order terakhir mungkin sudah tersimpan" : terkunciIsian;
    const draf = !tersimpan && Boolean(note.trim() || filled.length > 0);
    useUnsavedGuard(draf);

    async function simpan() {
        const j = await fastapi("POST", "/orders", {
            outlet, channel, order_date: orderDate, note, customer_no: customerNo.trim(),
            lines: lengkap.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity, price: hargaDipakai(line) })),
        });
        if (tidakPasti(j)) {
            setDialog(null);
            setRagu(true);
            return;
        }
        // Galat server (channel beda master 422, dugaan order ganda 409, aturan promo belum terbit 409) tampil apa adanya di dialog.
        if (!sukses(j)) throw new Error(pesanJawaban(j, "Order ditolak server."));
        const order = (j.data.order ?? {}) as { id?: string };
        setTersimpan(true);
        router.push(order.id ? `/orders/${order.id}?baru=1` : "/orders");
    }

    const net = pratinjau?.status === "siap" && pratinjau.result ? Number(pratinjau.result.net) : null;
    const nTanpaHarga = pratinjau?.status === "siap" ? pratinjau.tanpaHarga.length : 0;

    return (
        <div>
            <div className="fi-page" style={{ maxWidth: "60rem" }}>
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><Link href="/orders">Order Masuk</Link></li><li><span aria-current="page">Order baru</span></li></ol></nav>
                    <div className="fi-page-bar"><h1>Order baru</h1></div>
                    <p>Harga terisi dari master Accurate menurut kategori dan cabang pelanggan. Diskon dan bonus dihitung server dari aturan promo terbit, lalu dibekukan saat disimpan.</p>
                </header>
                {!bolehBuat && <MessageStrip tone="warn" title="Akun Anda tidak berhak membuat order.">Minta admin menambahkan izin buat order ke grup akses Anda.</MessageStrip>}
                {ragu && (
                    <MessageStrip tone="warn" title="Hasil simpan belum pasti.">
                        {BELUM_PASTI} Order mungkin sudah tersimpan — periksa <Link href="/orders">Order Masuk</Link>; isian tidak dihapus.{" "}
                        <Button variant="tertiary" disabled={Boolean(terkunciIsian)} disabledReason={terkunciIsian} onClick={() => setDialog("ulang")}>Simpan lagi…</Button>
                    </MessageStrip>
                )}
                {draf && nDiubah > 0 && <MessageStrip tone="info" title="Belum disimpan.">{nDiubah} harga diubah dari harga master.</MessageStrip>}

                <Section title="Pelanggan" subtitle="kode Accurate; channel dan kategori harga dari master">
                    <div className="fi-sect-in">
                        <div className="fi-formgrid">
                            <FormField label="Kode pelanggan Accurate" required
                                error={customer && !customer.found ? `Kode ${customerNo.trim()} tidak ada di master Accurate` : channelMasalah || undefined}
                                help={customer?.found ? `${customer.name}${customer.area ? ` · ${customer.area}` : ""} · harga ${customer.priceCategoryName || "standar (kategori belum tersedia)"}` : "Harga dan seri faktur mengikuti pelanggan."}>
                                {(a) => <input {...a} className="fi-input fi-mono" value={customerNo} placeholder="C.00000" autoComplete="off" onChange={(e) => { setRagu(false); setCustomerNo(e.target.value); }} />}
                            </FormField>
                            <FormField label="Outlet" required>
                                {(a) => <input {...a} className="fi-input" value={outlet} placeholder="Nama outlet" onChange={(e) => { setRagu(false); setOutlet(e.target.value); }} />}
                            </FormField>
                            <FormField label="Channel" help="Dari master Accurate, bukan diketik.">
                                {(a) => <input {...a} className="fi-input" readOnly value={channel || (customerNo.trim() ? "belum dipastikan" : "isi kode pelanggan dulu")} />}
                            </FormField>
                            <FormField label="Tanggal order" help="Bawaan hari ini (WITA).">
                                {(a) => <input {...a} type="date" className="fi-input" value={orderDate} onChange={(e) => { setRagu(false); setTanggalIsi(e.target.value); }} />}
                            </FormField>
                            <FormField label="Catatan" help="Ikut ke keterangan faktur.">
                                {(a) => <input {...a} className="fi-input" value={note} placeholder="opsional" onChange={(e) => { setRagu(false); setNote(e.target.value); }} />}
                            </FormField>
                        </div>
                        <p className="fi-small fi-muted">Salesman faktur dipilih saat order diantrekan, satu per order (disalin ke setiap baris faktur).</p>
                    </div>
                </Section>

                <Section title="Barang" subtitle={`${filled.length} barang · harga terisi dari master`}>
                    <ul aria-label="Barang" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {lines.map((line, index) => {
                            const code = line.code.trim();
                            const info = master[code];
                            const wrong = pratinjau?.status === "satuan" ? pratinjau.wrong.find((w) => w.code === code && w.unit === line.unit.trim().toUpperCase()) : undefined;
                            const hm = hargaMaster(line);
                            const tanpaHarga = pratinjau?.status === "siap" && pratinjau.tanpaHarga.includes(code);
                            const advice = pratinjau?.status === "siap" ? pratinjau.suggestions.find((s) => s.codes.includes(code)) : undefined;
                            const hasilBaris = pratinjau?.status === "siap" ? pratinjau.result?.lines?.find((r) => r.code === code && r.unit === line.unit.trim().toUpperCase()) : undefined;
                            const lengkapBaris = code && line.unit.trim() && Number(line.quantity) > 0;
                            const ubahHarga = diubah(line);
                            return (
                                <li key={index} className="fi-sect-in" style={{ borderBottom: "1px solid var(--line)" }} aria-label={`Barang ${index + 1}`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="fi-tag">Barang {index + 1}</span>
                                        {lines.length > 1 && (
                                            <Button variant="icon" aria-label={`Hapus barang ${index + 1}`} onClick={() => { setRagu(false); setLines((prev) => prev.filter((_, i) => i !== index)); }}>
                                                <Trash2 className="fi-icon" aria-hidden />
                                            </Button>
                                        )}
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_6rem_10rem]">
                                        <FormField label="Kode barang"
                                            error={info && !info.found ? `Kode ${code} tidak ada di master Accurate` : undefined}
                                            help={info?.found ? (info.units.length === 0 ? `${info.name} — belum ada daftar harga` : info.name) : undefined}>
                                            {(a) => <input {...a} className="fi-input fi-mono" value={line.code} placeholder="kode barang" autoComplete="off" onChange={(e) => ubah(index, "code", e.target.value)} />}
                                        </FormField>
                                        <FormField label="Satuan" error={wrong ? `Satuan ${wrong.unit} tidak ada untuk ${wrong.code}. Pilih ${wrong.known_units.join(" atau ")}.` : undefined}>
                                            {(a) => info && info.units.length > 0 ? (
                                                <select {...a} className="fi-input" value={line.unit} onChange={(e) => ubah(index, "unit", e.target.value)}>
                                                    <option value="">pilih</option>
                                                    {info.units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                                                </select>
                                            ) : (
                                                <input {...a} className="fi-input" value={line.unit} placeholder="satuan" onChange={(e) => ubah(index, "unit", e.target.value.toUpperCase())} />
                                            )}
                                        </FormField>
                                        <FormField label="Jumlah">
                                            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={line.quantity} placeholder="0" onChange={(e) => ubah(index, "quantity", e.target.value)} />}
                                        </FormField>
                                        <FormField label="Harga">
                                            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" value={hargaDipakai(line)}
                                                placeholder={pratinjau?.status === "memuat" && lengkapBaris ? "menghitung…" : "harga"} onChange={(e) => ubah(index, "price", e.target.value)} />}
                                        </FormField>
                                    </div>
                                    {lengkapBaris && pratinjau && (
                                        <div className="flex flex-wrap items-center gap-2 fi-small" aria-live="polite">
                                            {pratinjau.status === "memuat" && <StatusBadge tone="info" busy>Menghitung harga…</StatusBadge>}
                                            {hm && !ubahHarga && <><StatusBadge tone="pos">Harga master</StatusBadge><span className="fi-muted">{sumberHarga(hm)}</span></>}
                                            {hm && ubahHarga && (
                                                <>
                                                    <StatusBadge tone="warn">Beda dari master {rupiah(hm.price ?? 0)}</StatusBadge>
                                                    <span className="fi-why">ditahan saat antre setelah usulan BL-19 masuk</span>
                                                    <Button variant="tertiary" onClick={() => ubah(index, "price", null)}>Pakai harga master</Button>
                                                </>
                                            )}
                                            {tanpaHarga && <><StatusBadge tone="warn">Harga master belum ada</StatusBadge><span className="fi-muted">Isi harganya, atau lengkapi harga di Accurate.</span></>}
                                            {hasilBaris && <span className="fi-tnum fi-muted">netto {rupiah(hasilBaris.net)} (harga master)</span>}
                                        </div>
                                    )}
                                    {advice && <p className="fi-small fi-why flex items-start gap-1.5"><Lightbulb className="fi-icon" aria-hidden /><span>{advice.message}</span></p>}
                                </li>
                            );
                        })}
                    </ul>
                    <div className="fi-sect-in">
                        <div><Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { setRagu(false); setLines((prev) => [...prev, emptyLine()]); }}>Tambah barang</Button></div>
                        {pratinjau?.status === "galat" && <MessageStrip tone="warn" title="Harga master dan promo belum terhitung.">{pratinjau.error} Harga bisa diisi manual; order tetap dihitung server saat disimpan.</MessageStrip>}
                        {pratinjau?.status === "satuan" && <MessageStrip tone="neg" title="Satuan tidak cocok dengan master.">Perbaiki satuan di barisnya; nilai order dihitung setelah semua satuan cocok.</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.catatan && <MessageStrip tone="warn" title="Perkiraan tidak tersedia.">{pratinjau.catatan}</MessageStrip>}
                    </div>
                </Section>

                {pratinjau?.status === "siap" && pratinjau.result && net !== null && (
                    <Section title="Perkiraan" subtitle="aturan promo dibekukan saat disimpan">
                        <div className="fi-sect-in">
                            <KeyValues items={[
                                [nTanpaHarga ? "Bruto (yang sudah ada harganya)" : "Bruto", rupiah(pratinjau.result.gross ?? 0)],
                                ["Diskon promo", rupiah(pratinjau.result.discount ?? 0)],
                                ["Netto", rupiah(net)],
                                ["PPN 11%", rupiah(Math.round(net * PPN))],
                                ["Total faktur (estimasi)", rupiah(Math.round(net * (1 + PPN)))],
                            ]} />
                            {(pratinjau.result.bonuses ?? []).map((bonus, i) => (
                                <p key={i} className="fi-small fi-muted">Bonus {bonus.quantity} {bonus.unit} {bonus.code || `dari barang yang dibeli (${(bonus.eligible_codes || []).join(", ")})`} ({bonus.program_id})</p>
                            ))}
                            <p className="fi-small fi-subtle">
                                Perkiraan memakai harga master{nDiubah ? `; ${nDiubah} harga yang diubah dihitung ulang server saat disimpan` : ""}. Angka akhir faktur dihitung Accurate saat Kirim.
                            </p>
                        </div>
                    </Section>
                )}
                <VariantNote bl="BL-19">Harga yang berbeda dari master hari ini tetap tersimpan dan ikut ke antrean. Usulan: order dengan harga beda master ditahan saat diantrekan sampai ditinjau.</VariantNote>
            </div>
            <FooterToolbar message={terkunci ?? `${lengkap.length} barang${net !== null ? ` · netto estimasi ${rupiah(net)}` : ""}${nDiubah ? ` · ${nDiubah} harga diubah` : ""}`}>
                <Link className="fi-btn fi-btn--tertiary" href="/orders">Batal</Link>
                <Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} disabled={Boolean(terkunci)} disabledReason={terkunci} onClick={() => setDialog("biasa")}>Simpan order…</Button>
            </FooterToolbar>
            <ConfirmDialog open={dialog !== null} onClose={() => setDialog(null)}
                title={dialog === "ulang" ? `Simpan lagi order untuk ${outlet || customerNo}?` : `Simpan order untuk ${outlet || customerNo}?`}
                tone={dialog === "ulang" ? "negative" : "primary"}
                description={dialog === "ulang"
                    ? "Jawaban simpan sebelumnya tidak pasti. Bila order itu sudah tersimpan (periksa Order Masuk), simpanan ini bisa ditolak sebagai dugaan order ganda — atau tercatat dua kali bila barangnya berbeda."
                    : "Diskon dan bonus dihitung server dari aturan promo terbit lalu dibekukan pada order. Faktur belum dibuat; order diantrekan dari halamannya."}
                facts={[
                    ["Pelanggan", `${customerNo.trim()}${customer?.found ? ` · ${customer.name}` : ""}`],
                    ["Channel", channel],
                    ["Tanggal order", tanggalPendek(orderDate)],
                    ["Barang", `${lengkap.length} baris`],
                    ["Netto estimasi", net !== null ? rupiah(net) : "dihitung saat disimpan"],
                    ...(nDiubah ? [["Harga diubah", `${nDiubah} barang beda dari master`] as [string, string]] : []),
                ]}
                confirmLabel={dialog === "ulang" ? "Simpan lagi" : "Simpan order"} onConfirm={simpan} />
        </div>
    );
}
