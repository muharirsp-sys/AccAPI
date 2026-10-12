/*
 * Tujuan: Form Order baru (Fiori S6d + O2): pelanggan DICARI dari master (nama/kode, semua cabang, saringan cabang opsional; kartu menampilkan
 *   cabang + channel + kategori harga), barang DICARI hanya dari barang cabang pelanggan (satuan + harga per cabang), HARGA TERISI DARI
 *   MASTER beserta sumbernya (kategori · cabang · tanggal berlaku); harga yang diubah ditandai. Promo (diskon/bonus/net per baris + ringkasan)
 *   dihitung server dan dibekukan saat disimpan — pratinjau = yang tersimpan. Ganti pelanggan ke cabang lain dengan baris terisi = konfirmasi
 *   (baris cabang lama dibuang, tidak diam). Simpan lewat dialog, lalu lanjut ke halaman order.
 * Caller: ./baru/page.tsx (/orders/baru). Simpan butuh `order.create` (FastAPI POST /orders).
 * Dependensi: /api/customers/search, /api/items/search, /api/orders/preview (components/order/*), FastAPI POST /orders; ./order-ui;
 *   ../form-kontrol/lapangan (useHariBeku); components/fiori/*; lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: OrderBaru, sumberHarga.
 * Side Effects: HTTP; menyimpan order internal (FastAPI). Tidak ada tulis ke Accurate.
 *
 * Perubahan perilaku yang disengaja (it06 #2): harga bawaan bukan lagi 0 — kosong = ikut harga master hasil pratinjau server; harga ≤ 0
 * ditolak di layar (dulu Rp 0 tersimpan sebagai "sudah berharga"). Tanggal order bawaan = hari ini WITA (dulu tanggal UTC).
 * O2: petugas internal tetap boleh mengisi harga manual untuk barang yang harganya belum ada di master (server tidak menimpa harga petugas).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lightbulb, Plus, Save, Trash2 } from "lucide-react";
import { Button, FooterToolbar, MessageStrip, Section, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import { PemilihBarang } from "@/components/order/PemilihBarang";
import { PemilihPelanggan, usePelanggan } from "@/components/order/PemilihPelanggan";
import { PanelPromo, PromoBarisInfo } from "@/components/order/PanelPromo";
import { barisBedaCabang, kunciHarga, labelSatuan, type BarangPilih, type PelangganPilih } from "@/components/order/order-cabang";
import { hitungPratinjau, type Pratinjau } from "@/components/order/order-cabang-api";
import { rupiah } from "@/lib/promo-ui";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { useHariBeku } from "../form-kontrol/lapangan";
import { BELUM_PASTI, fastapi, pesanJawaban, sukses, tidakPasti, type PriceInfo } from "./order-ui";

/** `price` null = ikut harga master dari pratinjau; teks = diketik petugas. `barang` null = baris baru (belum memilih barang). */
type Line = { code: string; unit: string; quantity: string; price: string | null; barang: BarangPilih | null };

const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1", price: null, barang: null });
/** Satu satuan saja = dipilih otomatis; satuan lama dipertahankan bila masih ada; selain itu kosong (satuan sengaja tidak ditebak: selisih bisa 72x). */
const satuanAwal = (b: BarangPilih, lama: string) => (b.units.some((u) => u.unit === lama) ? lama : b.units.length === 1 ? b.units[0].unit : "");

/** "Grosir · CABANG A · berlaku 01/10/2026" — sumber harga master satu baris. */
function sumberHarga(p: PriceInfo): string {
    if (p.source !== "tier") return "harga standar (kategori pelanggan belum tersedia)";
    return [p.priceCategoryName ?? "kategori", p.branchName, p.effectiveDate ? `berlaku ${tanggalPendek(p.effectiveDate)}` : null].filter(Boolean).join(" · ");
}

export default function OrderBaru({ permKeys }: { permKeys: string[] }) {
    const router = useRouter();
    const bolehBuat = permKeys.includes("order.create");
    // Hari ini WITA DIBEKUKAN saat form dibuka: lewat 00.00 tanggal order tidak berganti diam-diam (petugas yang memilih).
    const { hari: hariIni, berganti, hariBaru, pakaiHariBaru } = useHariBeku();
    // Pelanggan dari pencarian master: kode, nama, cabang, channel, kategori harga. Channel TIDAK diketik — server menolak order yang
    // channelnya berbeda dari master (`outlet_channel.verify`), jadi isian bebas hanya menyediakan satu cara untuk salah.
    const pel = usePelanggan("petugas");
    const pelanggan: PelangganPilih | null = pel.state.jenis === "siap" ? pel.state.p : null;
    const kodePel = pelanggan?.customerNo ?? "";
    const channel = pelanggan?.channel ?? "";
    const channelMasalah = pelanggan && !pelanggan.channel ? `Outlet ${pelanggan.customerNo} belum punya kategori (TT/MT) di Accurate. Isi kategorinya di Accurate lebih dulu.` : "";
    const [calon, setCalon] = useState<PelangganPilih | null>(null); // pelanggan cabang lain yang menunggu konfirmasi buang baris
    const [outlet, setOutlet] = useState("");
    const [tanggalIsi, setTanggalIsi] = useState<string | null>(null);
    const orderDate = tanggalIsi ?? hariIni;
    const [note, setNote] = useState("");
    const [lines, setLines] = useState<Line[]>([emptyLine()]);
    const [hasil, setHasil] = useState<{ key: string; p: Pratinjau } | null>(null);
    const [dialog, setDialog] = useState<null | "biasa" | "ulang">(null);
    // FastAPI POST /orders TIDAK idempoten: jawaban tidak pasti → Simpan ditahan sampai isian diubah atau "Simpan lagi" eksplisit.
    const [ragu, setRagu] = useState(false);
    const [tersimpan, setTersimpan] = useState(false);

    const filled = lines.filter((line) => line.code.trim());
    const barisSiap = (l: Line) => Boolean(l.barang && l.unit.trim() && Number(l.quantity) > 0);
    const siapPratinjau = Boolean(pelanggan && channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0 && filled.every(barisSiap));
    // Harga ketikan tidak memengaruhi pratinjau (server memakai master), jadi tidak ikut kunci.
    const previewKey = JSON.stringify([channel, orderDate, kodePel, lines.map((l) => [l.code, l.unit, l.quantity])]);
    const pratinjau: Pratinjau | null = !siapPratinjau ? null : hasil?.key === previewKey ? hasil.p : { status: "memuat" };
    useEffect(() => {
        if (!siapPratinjau) return;
        let hidup = true;
        const timer = setTimeout(async () => {
            const p = await hitungPratinjau({ channel, orderDate, customerNo: kodePel, peran: "petugas",
                lines: lines.filter((l) => l.code.trim()).map((l) => ({ code: l.code, unit: l.unit, quantity: l.quantity })) });
            if (hidup) setHasil({ key: previewKey, p });
        }, 600);
        return () => { hidup = false; clearTimeout(timer); };
        // previewKey SUDAH memuat channel, tanggal, pelanggan, dan kode/satuan/jumlah tiap baris; `lines` sengaja tidak masuk deps
        // karena harga ketikan ikut di dalamnya dan tidak boleh memicu pratinjau ulang (server memakai harga master).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey, siapPratinjau]);

    const hargaMaster = (line: Line) => pratinjau?.status === "siap"
        ? pratinjau.prices.find((p) => p.code === line.code.trim() && p.unit === line.unit.trim().toUpperCase() && p.price != null) : undefined;
    const hargaDipakai = (line: Line) => line.price ?? (hargaMaster(line) ? String(hargaMaster(line)!.price) : "");
    const diubah = (line: Line) => line.price !== null && hargaMaster(line) !== undefined && Number(line.price) !== Number(hargaMaster(line)!.price);

    const ubah = (index: number, key: "unit" | "quantity" | "price", value: string | null) => {
        setRagu(false);
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    };
    const pilihBarang = (index: number, b: BarangPilih) => {
        setRagu(false);
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, code: b.no, barang: b, price: null, unit: satuanAwal(b, line.unit) } : line)));
    };
    const lepasBarang = (index: number) => { setRagu(false); setLines((prev) => prev.map((line, i) => (i === index ? emptyLine() : line))); };

    const terapkanPelanggan = (p: PelangganPilih) => { setRagu(false); setOutlet(p.name); pel.pilih(p); };
    /** Ganti ke pelanggan cabang lain dengan baris terisi: barang cabang lama tidak boleh ikut — konfirmasi dulu, jangan buang diam-diam. */
    function pilihPelanggan(p: PelangganPilih) {
        if (barisBedaCabang(lines, p.branchId).dibuang.length > 0) { setCalon(p); return; }
        terapkanPelanggan(p);
    }
    const bedaCabang = calon ? barisBedaCabang(lines, calon.branchId) : null;
    function konfirmasiGanti() {
        if (!calon || !bedaCabang) return;
        setLines(bedaCabang.tersisa.some((l) => l.code.trim()) ? bedaCabang.tersisa : [emptyLine()]);
        terapkanPelanggan(calon);
        setCalon(null);
    }

    const lengkap = lines.filter(barisSiap);
    const tidakLengkap = lines.findIndex((line) => line.barang && !(line.unit.trim() && Number(line.quantity) > 0));
    const salahSatuan = pratinjau?.status === "satuan"
        ? lines.findIndex((line) => pratinjau.wrong.some((w) => w.code === line.code.trim() && w.unit === line.unit.trim().toUpperCase())) : -1;
    const salahBarang = pratinjau?.status === "barang" ? lines.findIndex((line) => line.code.trim() in pratinjau.galat.perBarang) : -1;
    const tanpaHargaIdx = lines.findIndex((line) => line.code.trim() && !(Number(hargaDipakai(line)) > 0));
    const nDiubah = lengkap.filter(diubah).length;
    const terkunciIsian = !bolehBuat ? "Akun Anda tidak berhak membuat order"
        : pel.state.jenis === "kosong" ? "Cari dan pilih pelanggan, lalu minimal satu barang"
            : pel.state.jenis === "memuat" ? "Membaca data pelanggan"
                : pel.state.jenis === "galat" ? "Data pelanggan belum terbaca; pilih pelanggan lagi"
                    : !outlet.trim() ? "Isi nama outlet"
                        : !channel.trim() ? (channelMasalah || "Channel outlet belum dipastikan dari master")
                            : filled.length === 0 ? "Cari dan pilih minimal satu barang"
                                : tidakLengkap >= 0 ? `Lengkapi satuan dan jumlah barang ${tidakLengkap + 1}`
                                    : salahSatuan >= 0 ? `Perbaiki satuan barang ${salahSatuan + 1}`
                                        : salahBarang >= 0 ? `Hapus atau ganti barang ${salahBarang + 1}: ${pratinjau?.status === "barang" ? pratinjau.galat.judul : ""}`
                                            : pratinjau?.status === "galat" && pratinjau.galat.menolak ? `${pratinjau.galat.judul}. ${pratinjau.galat.tindakan}`
                                                : pratinjau?.status === "memuat" ? "Menunggu harga dihitung"
                                                    : tanpaHargaIdx >= 0 ? (lines[tanpaHargaIdx].price === null && !hargaMaster(lines[tanpaHargaIdx])
                                                        ? `Isi harga barang ${tanpaHargaIdx + 1} (harga master belum ada)`
                                                        : `Harga barang ${tanpaHargaIdx + 1} harus lebih dari 0`) : undefined;
    // Sesudah tersimpan halaman masih tampil sampai halaman order terbuka: Simpan terkunci supaya order tidak tersimpan dua kali.
    const sudahTersimpan = tersimpan ? "Order sudah tersimpan; membuka halaman order…" : undefined;
    const terkunci = sudahTersimpan ?? (ragu ? "Periksa Order Masuk dulu — order terakhir mungkin sudah tersimpan" : terkunciIsian);
    const draf = !tersimpan && Boolean(note.trim() || filled.length > 0);
    useUnsavedGuard(draf);

    async function simpan() {
        const j = await fastapi("POST", "/orders", {
            outlet, channel, order_date: orderDate, note, customer_no: kodePel.trim(),
            lines: lengkap.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity, price: hargaDipakai(line) })),
        });
        if (tidakPasti(j)) {
            setDialog(null);
            setRagu(true);
            return;
        }
        // Galat server (channel beda master 422, dugaan order ganda 409, aturan promo belum terbit 409, aturan cabang O1) tampil di dialog.
        if (!sukses(j)) throw new Error(pesanJawaban(j, "Order ditolak server."));
        const order = (j.data.order ?? {}) as { id?: string };
        setTersimpan(true);
        router.push(order.id ? `/orders/${order.id}?baru=1` : "/orders");
    }

    const net = pratinjau?.status === "siap" && pratinjau.result ? Number(pratinjau.result.net) : null;
    const nTanpaHarga = pratinjau?.status === "siap" ? pratinjau.tanpaHarga.length : 0;
    const hasilPratinjau = pratinjau?.status === "siap" ? pratinjau.result : null;

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
                {berganti && tanggalIsi === null && (
                    <MessageStrip tone="info" title="Hari sudah berganti.">
                        Tanggal order tetap {tanggalPendek(hariIni)} (hari form ini dibuka).{" "}
                        <Button variant="tertiary" onClick={pakaiHariBaru}>Pakai {tanggalPendek(hariBaru)}</Button>
                    </MessageStrip>
                )}
                {draf && nDiubah > 0 && <MessageStrip tone="info" title="Belum disimpan.">{nDiubah} harga diubah dari harga master.</MessageStrip>}

                <Section title="Pelanggan" subtitle="cari nama atau kode; cabang, channel, dan kategori harga dari master">
                    <div className="fi-sect-in">
                        <PemilihPelanggan state={pel.state} peran="petugas" saringCabang onPilih={pilihPelanggan} onLepas={pel.lepas}
                            onBacaUlang={(kode) => { void pel.bacaKode(kode); }} />
                        <div className="fi-formgrid">
                            <FormField label="Outlet" required help={pelanggan ? undefined : "Terisi dari nama pelanggan yang dipilih."}>
                                {(a) => <input {...a} className="fi-input" value={outlet} placeholder="Nama outlet" onChange={(e) => { setRagu(false); setOutlet(e.target.value); }} />}
                            </FormField>
                            <FormField label="Tanggal order" help="Bawaan hari ini (WITA). Harga di daftar barang mengikuti tanggal ini.">
                                {(a) => <input {...a} type="date" className="fi-input" value={orderDate} onChange={(e) => { setRagu(false); setTanggalIsi(e.target.value); }} />}
                            </FormField>
                            <FormField label="Catatan" help="Ikut ke keterangan faktur.">
                                {(a) => <input {...a} className="fi-input" value={note} placeholder="opsional" onChange={(e) => { setRagu(false); setNote(e.target.value); }} />}
                            </FormField>
                        </div>
                        {channelMasalah && <MessageStrip tone="warn">{channelMasalah}</MessageStrip>}
                        {pratinjau?.status === "galat" && pratinjau.galat.menolak && (
                            <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.pesan} {pratinjau.galat.tindakan}</MessageStrip>
                        )}
                        <p className="fi-small fi-muted">Salesman faktur dipilih saat order diantrekan, satu per order (disalin ke setiap baris faktur).</p>
                    </div>
                </Section>

                <Section title="Barang" subtitle={`${filled.length} barang · harga terisi dari master${pelanggan ? ` · barang cabang ${pelanggan.branchName}` : ""}`}>
                    <ul aria-label="Barang" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {lines.map((line, index) => {
                            const code = line.code.trim();
                            const wrong = pratinjau?.status === "satuan" ? pratinjau.wrong.find((w) => w.code === code && w.unit === line.unit.trim().toUpperCase()) : undefined;
                            const beda = pratinjau?.status === "barang" ? pratinjau.galat.perBarang[code] : undefined;
                            const hm = hargaMaster(line);
                            const tanpaHarga = pratinjau?.status === "siap" && pratinjau.tanpaHarga.includes(code);
                            const advice = pratinjau?.status === "siap" ? pratinjau.suggestions.find((s) => s.codes.includes(code)) : undefined;
                            const lengkapBaris = Boolean(line.barang && line.unit.trim() && Number(line.quantity) > 0);
                            const ubahHarga = diubah(line);
                            const berlakuHarga = line.barang?.hargaUntuk === kunciHarga(pelanggan?.id, orderDate);
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
                                    <PemilihBarang nomor={index + 1} pelanggan={pelanggan} tanggal={orderDate} nilai={line.barang} peran="petugas"
                                        onPilih={(b) => pilihBarang(index, b)} onLepas={() => lepasBarang(index)} />
                                    {beda && <p className="fi-msg" role="alert">{beda} Hapus barang ini atau ganti dengan barang cabang pelanggan.</p>}
                                    {line.barang && (
                                        <div className="grid gap-3 sm:grid-cols-[12rem_6rem_10rem]">
                                            <FormField label="Satuan" error={wrong ? `Satuan ${wrong.unit} tidak ada untuk ${wrong.code}. Pilih ${wrong.known_units.join(" atau ")}.` : undefined}
                                                help={line.barang.units.length === 0 ? "Belum ada daftar harga" : undefined}>
                                                {(a) => (
                                                    <select {...a} className="fi-input" value={line.unit} onChange={(e) => ubah(index, "unit", e.target.value)}>
                                                        <option value="">pilih</option>
                                                        {line.barang!.units.map((u) => <option key={u.unit} value={u.unit}>{labelSatuan(u, berlakuHarga, rupiah)}</option>)}
                                                    </select>
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
                                    )}
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
                                        </div>
                                    )}
                                    {lengkapBaris && <PromoBarisInfo result={hasilPratinjau} code={code} unit={line.unit} nomor={index + 1} />}
                                    {advice && <p className="fi-small fi-why flex items-start gap-1.5"><Lightbulb className="fi-icon" aria-hidden /><span>{advice.message}</span></p>}
                                </li>
                            );
                        })}
                    </ul>
                    <div className="fi-sect-in">
                        <div><Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { setRagu(false); setLines((prev) => [...prev, emptyLine()]); }}>Tambah barang</Button></div>
                        {pratinjau?.status === "galat" && !pratinjau.galat.menolak && <MessageStrip tone="warn" title="Harga master dan promo belum terhitung.">{pratinjau.galat.pesan} Harga bisa diisi manual; order tetap dihitung server saat disimpan.</MessageStrip>}
                        {pratinjau?.status === "satuan" && <MessageStrip tone="neg" title="Satuan tidak cocok dengan master.">Perbaiki satuan di barisnya; nilai order dihitung setelah semua satuan cocok.</MessageStrip>}
                        {pratinjau?.status === "barang" && <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.tindakan}</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.catatan && <MessageStrip tone="warn" title="Perkiraan tidak tersedia.">{pratinjau.catatan.pesan} {pratinjau.catatan.tindakan}</MessageStrip>}
                    </div>
                </Section>

                {pratinjau?.status === "siap" && pratinjau.result && net !== null && (
                    <Section title="Perkiraan" subtitle="aturan promo dibekukan saat disimpan">
                        <div className="fi-sect-in">
                            <PanelPromo result={pratinjau.result} suggestions={pratinjau.suggestions} nTanpaHarga={nTanpaHarga} ppn
                                catatan={`Perkiraan memakai harga master${nDiubah ? `; ${nDiubah} harga yang diubah dihitung ulang server saat disimpan` : ""}. Angka akhir faktur dihitung Accurate saat Kirim.`} />
                        </div>
                    </Section>
                )}
                <VariantNote bl="BL-19">Harga yang berbeda dari master hari ini tetap tersimpan dan ikut ke antrean. Usulan: order dengan harga beda master ditahan saat diantrekan sampai ditinjau.</VariantNote>
            </div>
            <FooterToolbar message={terkunci ?? `${lengkap.length} barang${net !== null ? ` · netto estimasi ${rupiah(net)}` : ""}${nDiubah ? ` · ${nDiubah} harga diubah` : ""}`}>
                <Link className="fi-btn fi-btn--tertiary" href="/orders">Batal</Link>
                <Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} disabled={Boolean(terkunci)} disabledReason={terkunci} onClick={() => setDialog("biasa")}>Simpan order…</Button>
            </FooterToolbar>
            <ConfirmDialog open={calon !== null && bedaCabang !== null} onClose={() => setCalon(null)} tone="negative" tag="Ganti pelanggan"
                title={`Ganti pelanggan ke ${calon?.name ?? ""}?`}
                description={`${calon?.name ?? "Pelanggan ini"} ada di cabang ${calon?.branchName ?? ""}. Pelanggan hanya bisa dipesankan barang cabangnya sendiri, jadi barang di order ini yang bukan milik cabang ${calon?.branchName ?? ""} dibuang. Yang sudah diisi di barisnya hilang.`}
                facts={[
                    ["Pelanggan sekarang", pelanggan ? `${pelanggan.name} · cabang ${pelanggan.branchName}` : "–"],
                    ["Barang dibuang", `${bedaCabang?.dibuang.length ?? 0} baris`],
                    ...(bedaCabang?.dibuang.map((l, i): [string, string] => [`Barang ${i + 1}`, `${l.barang?.name ?? l.code} (${l.code}${l.barang?.branchName ? ` · cabang ${l.barang.branchName}` : ""})`]) ?? []),
                ]}
                confirmLabel={`Ganti dan buang ${bedaCabang?.dibuang.length ?? 0} baris`} cancelLabel="Tetap di pelanggan sekarang" onConfirm={konfirmasiGanti} />
            <ConfirmDialog open={dialog !== null} onClose={() => setDialog(null)}
                title={dialog === "ulang" ? `Simpan lagi order untuk ${outlet || kodePel}?` : `Simpan order untuk ${outlet || kodePel}?`}
                tone={dialog === "ulang" ? "negative" : "primary"}
                description={dialog === "ulang"
                    ? "Jawaban simpan sebelumnya tidak pasti. Bila order itu sudah tersimpan (periksa Order Masuk), simpanan ini bisa ditolak sebagai dugaan order ganda — atau tercatat dua kali bila barangnya berbeda."
                    : "Diskon dan bonus dihitung server dari aturan promo terbit lalu dibekukan pada order. Faktur belum dibuat; order diantrekan dari halamannya."}
                facts={[
                    ["Pelanggan", `${kodePel.trim()}${pelanggan ? ` · ${pelanggan.name}` : ""}`],
                    ["Cabang", pelanggan?.branchName ?? "–"],
                    ["Channel", channel],
                    ["Tanggal order", tanggalPendek(orderDate)],
                    ["Barang", `${lengkap.length} baris`],
                    ["Netto estimasi", net !== null ? rupiah(net) : "dihitung saat disimpan"],
                    ...(nDiubah ? [["Harga diubah", `${nDiubah} barang beda dari master`] as [string, string]] : []),
                ]}
                confirmLabel={dialog === "ulang" ? "Simpan lagi" : "Simpan order"} confirmDisabled={sudahTersimpan} onConfirm={simpan} />
        </div>
    );
}
