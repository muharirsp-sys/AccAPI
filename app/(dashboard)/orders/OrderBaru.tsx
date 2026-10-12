/*
 * Tujuan: Form Order baru (Fiori S6d + O2): pelanggan DICARI dari master (nama/kode, semua cabang, saringan cabang opsional; kartu menampilkan
 *   cabang + channel + kategori harga), barang DICARI hanya dari barang cabang pelanggan (satuan + harga per cabang). Harga = MASTER cabang
 *   pelanggan (baca-saja, dengan sumbernya: kategori · cabang · tanggal berlaku); HANYA baris yang harga masternya belum ada boleh diisi
 *   harga petugas (wajib > 0, tercatat "harga petugas"). Promo (diskon/bonus/net per baris + ringkasan) dihitung server dan dibekukan saat
 *   disimpan: pratinjau = tersimpan — simpan membawa `sidik` pratinjau terakhir; angka berubah (PRATINJAU_BERUBAH) = belum tersimpan, angka baru
 *   ditampilkan dan simpan meminta konfirmasi ulang. Ganti pelanggan ke cabang lain dengan baris terisi = konfirmasi (baris cabang lama dibuang,
 *   tidak diam). Simpan lewat dialog, lalu lanjut ke halaman order.
 * Caller: ./baru/page.tsx (/orders/baru). Simpan butuh `order.create` (FastAPI POST /orders).
 * Dependensi: /api/customers/search, /api/items/search, /api/orders/preview (components/order/*), FastAPI POST /orders; ./order-ui;
 *   ../form-kontrol/lapangan (useHariBeku); components/fiori/*; lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: OrderBaru, sumberHarga.
 * Side Effects: HTTP; menyimpan order internal (FastAPI). Tidak ada tulis ke Accurate.
 *
 * Keputusan owner 12 Okt (sesi 13): harga petugas HANYA untuk baris tanpa harga master sah; baris berharga master tidak bisa diubah. Layar tidak
 * pernah mengirim `price` untuk baris berharga master (server menolaknya). Tanggal order bawaan = hari ini WITA (bukan UTC).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lightbulb, Plus, Save, Trash2 } from "lucide-react";
import { Button, FooterToolbar, MessageStrip, Section, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import { PemilihBarang } from "@/components/order/PemilihBarang";
import { PemilihPelanggan, usePelanggan } from "@/components/order/PemilihPelanggan";
import { PanelPromo, PromoBarisInfo } from "@/components/order/PanelPromo";
import { barisBedaCabang, galatDariJawaban, hargaCabangDefault, hargaPetugasSah, kunciHarga, labelSatuan, pratinjauBerubah, type BarangPilih, type PelangganPilih } from "@/components/order/order-cabang";
import { hitungPratinjau, type Pratinjau } from "@/components/order/order-cabang-api";
import { rupiah } from "@/lib/promo-ui";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { useHariBeku } from "../form-kontrol/lapangan";
import { BELUM_PASTI, fastapi, pesanJawaban, sukses, type PriceInfo } from "./order-ui";

/** `price` = harga PETUGAS yang diketik (hanya bermakna untuk baris tanpa harga master); null = harga master. `barang` null = baris baru. */
type Line = { code: string; unit: string; quantity: string; price: string | null; barang: BarangPilih | null };

const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1", price: null, barang: null });
/** Satu satuan saja = dipilih otomatis; satuan lama dipertahankan bila masih ada; selain itu kosong (satuan sengaja tidak ditebak: selisih bisa 72x). */
const satuanAwal = (b: BarangPilih, lama: string) => (b.units.some((u) => u.unit === lama) ? lama : b.units.length === 1 ? b.units[0].unit : "");

/** "Grosir · CABANG A · berlaku 01/10/2026" — sumber harga master satu baris; harga petugas disebut sebagai harga petugas. */
function sumberHarga(p: PriceInfo): string {
    if (p.source === "petugas") return "diisi petugas (harga master belum ada)";
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
    const [ulangPratinjau, setUlangPratinjau] = useState(0);
    // PRATINJAU_BERUBAH: order BELUM tersimpan; netto lama -> baru untuk isian (kunci pratinjau) yang sama, hilang bila isian berubah.
    const [berubah, setBerubah] = useState<{ key: string; lama: number | null; baru: number } | null>(null);
    const [dialog, setDialog] = useState<null | "biasa" | "ulang">(null);
    // FastAPI POST /orders TIDAK idempoten: jawaban tidak pasti → Simpan ditahan sampai isian diubah atau "Simpan lagi" eksplisit.
    const [ragu, setRagu] = useState(false);
    // ORDER_GANDA: petugas yang sudah memeriksa Order Masuk menyatakan BUKAN order ganda (confirm_duplicate), per isian.
    const [ganda, setGanda] = useState(false);
    const [bukanGanda, setBukanGanda] = useState(false);
    const [tersimpan, setTersimpan] = useState(false);
    const ubahIsian = () => { setRagu(false); setGanda(false); setBukanGanda(false); };

    const filled = lines.filter((line) => line.code.trim());
    const barisSiap = (l: Line) => Boolean(l.barang && l.unit.trim() && Number(l.quantity) > 0);
    const siapPratinjau = Boolean(pelanggan && channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0 && filled.every(barisSiap));

    const berlakuHarga = (l: Line) => l.barang?.hargaUntuk === kunciHarga(pelanggan?.id, orderDate);
    const infoHarga = (l: Line, p: Pratinjau | null | undefined) => (p?.status === "siap" ? p.prices.find((x) => x.code === l.code.trim() && x.unit === l.unit.trim().toUpperCase()) : undefined);
    /**
     * Baris TANPA harga master sah = satu-satunya yang boleh memakai harga petugas. Dinilai dari daftar harga hasil pencarian (selama masih
     * berlaku untuk pelanggan + tanggal ini), selain itu dari pratinjau TERAKHIR yang diterima — bukan dari pratinjau isian sekarang, supaya
     * tidak berputar (harga petugas ikut kunci pratinjau).
     */
    const tanpaMaster = (l: Line): boolean => {
        const u = l.barang?.units.find((x) => x.unit === l.unit);
        if (u && berlakuHarga(l)) return u.price === null;
        const pi = infoHarga(l, hasil?.p);
        if (pi) return pi.hargaMaster == null;
        return hasil?.p.status === "siap" && hasil.p.tanpaHarga.includes(l.code.trim());
    };
    /** Harga petugas yang DIKIRIM (ke pratinjau dan simpan): hanya baris tanpa master dengan harga sah; selain itu server memakai harga master. */
    const hargaKirim = (l: Line) => (tanpaMaster(l) && l.price !== null && hargaPetugasSah(l.price) ? l.price.trim() : "");

    const previewKey = JSON.stringify([channel, orderDate, kodePel, lines.map((l) => [l.code, l.unit, l.quantity, hargaKirim(l)])]);
    const pratinjau: Pratinjau | null = !siapPratinjau ? null : hasil?.key === previewKey ? hasil.p : { status: "memuat" };
    useEffect(() => {
        if (!siapPratinjau) return;
        let hidup = true;
        const timer = setTimeout(async () => {
            const p = await hitungPratinjau({ channel, orderDate, customerNo: kodePel, peran: "petugas",
                lines: lines.filter((l) => l.code.trim()).map((l) => ({ code: l.code, unit: l.unit, quantity: l.quantity, price: hargaKirim(l) })) });
            if (hidup) setHasil({ key: previewKey, p });
        }, 600);
        return () => { hidup = false; clearTimeout(timer); };
        // previewKey SUDAH memuat channel, tanggal, pelanggan, dan kode/satuan/jumlah/harga petugas tiap baris; `lines` sengaja tidak masuk deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey, siapPratinjau, ulangPratinjau]);
    const hitungUlang = () => { setHasil(null); setUlangPratinjau((v) => v + 1); };
    const berubahKini = berubah?.key === previewKey ? berubah : null;

    /** Harga yang DITAMPILKAN untuk baris: master (baca-saja) dari pratinjau / daftar harga; harga petugas yang diketik untuk baris tanpa master. */
    const hargaTampil = (l: Line): string => {
        if (tanpaMaster(l)) return l.price ?? "";
        const pi = infoHarga(l, pratinjau);
        if (pi?.price != null) return String(pi.price);
        const u = l.barang?.units.find((x) => x.unit === l.unit);
        return u && berlakuHarga(l) && u.price !== null ? String(u.price) : "";
    };

    const ubah = (index: number, key: "unit" | "quantity" | "price", value: string | null) => {
        ubahIsian();
        // Harga petugas dikosongkan = kembali ke harga master (kontrak: price kosong = harga master).
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, [key]: key === "price" && value === "" ? null : value } : line)));
    };
    const pilihBarang = (index: number, b: BarangPilih) => {
        ubahIsian();
        setLines((prev) => prev.map((line, i) => (i === index ? { ...line, code: b.no, barang: b, price: null, unit: satuanAwal(b, line.unit) } : line)));
    };
    const lepasBarang = (index: number) => { ubahIsian(); setLines((prev) => prev.map((line, i) => (i === index ? emptyLine() : line))); };

    const terapkanPelanggan = (p: PelangganPilih) => { ubahIsian(); setOutlet(p.name); pel.pilih(p); };
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
    // Baris tanpa master: harga petugas WAJIB sah (> 0). Baris berharga master tidak punya isian harga.
    const hargaBelumSah = lines.findIndex((line) => line.barang && line.unit.trim() && tanpaMaster(line) && !hargaPetugasSah(line.price ?? ""));
    const nPetugas = lengkap.filter((l) => hargaKirim(l) !== "").length;
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
                                            : hargaBelumSah >= 0 ? (lines[hargaBelumSah].price === null
                                                ? `Isi harga barang ${hargaBelumSah + 1} (harga master belum ada)`
                                                : `Harga barang ${hargaBelumSah + 1} harus angka lebih dari 0 (desimal pakai titik, maksimal 4 digit)`)
                                                : pratinjau?.status === "galat" ? (pratinjau.galat.menolak ? `${pratinjau.galat.judul}. ${pratinjau.galat.tindakan}` : "Perkiraan harga dan promo belum tersedia — hitung ulang dulu")
                                                    : pratinjau?.status === "memuat" ? "Menunggu harga dihitung"
                                                        : pratinjau?.status === "siap" && pratinjau.tanpaHarga.length > 0 ? `Isi harga barang ${lines.findIndex((l) => pratinjau.tanpaHarga.includes(l.code.trim())) + 1} (harga master belum ada)`
                                                            : pratinjau?.status === "siap" && pratinjau.channelMasalah ? pratinjau.channelMasalah
                                                                : pratinjau?.status === "siap" && !pratinjau.sidik ? "Pratinjau lengkap belum tersedia — hitung ulang dulu" : undefined;
    // Sesudah tersimpan halaman masih tampil sampai halaman order terbuka: Simpan terkunci supaya order tidak tersimpan dua kali.
    const sudahTersimpan = tersimpan ? "Order sudah tersimpan; membuka halaman order…" : undefined;
    const terkunci = sudahTersimpan ?? (ragu ? "Periksa Order Masuk dulu — order terakhir mungkin sudah tersimpan" : terkunciIsian);
    const draf = !tersimpan && Boolean(note.trim() || filled.length > 0);
    useUnsavedGuard(draf);

    const net = pratinjau?.status === "siap" && pratinjau.result ? Number(pratinjau.result.net) : null;
    const nTanpaHarga = pratinjau?.status === "siap" ? pratinjau.tanpaHarga.length : 0;
    const hasilPratinjau = pratinjau?.status === "siap" ? pratinjau.result : null;

    async function simpan() {
        // Sidik pratinjau TERAKHIR untuk isian yang sekarang; tombol Simpan sudah terkunci bila tidak ada, ini sabuk pengaman.
        const sidik = pratinjau?.status === "siap" ? pratinjau.sidik : null;
        if (!sidik) throw new Error("Pratinjau harga dan promo belum tersedia untuk isian ini. Tunggu perkiraan selesai atau hitung ulang, lalu simpan lagi.");
        const j = await fastapi("POST", "/orders", {
            outlet, channel, order_date: orderDate, note, customer_no: kodePel.trim(), sidik,
            ...(bukanGanda ? { confirm_duplicate: true } : {}),
            // `price` HANYA untuk baris tanpa harga master yang diketik petugas; kosong = harga master server.
            lines: lengkap.map((line) => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity, ...(hargaKirim(line) ? { price: hargaKirim(line) } : {}) })),
        });
        const baik = sukses(j);
        // Tidak pasti = putus, badan bukan JSON, >= 502 tanpa kode, atau LAYANAN_TIDAK_PASTI. 503 KONFIGURASI_SERVER = PASTI tidak tersimpan.
        if (!baik && galatDariJawaban(j, "petugas").tidakPasti) {
            setDialog(null);
            setRagu(true);
            return;
        }
        if (!baik) {
            const baru = pratinjauBerubah(j);
            if (baru) {
                // Angka berubah sejak pratinjau: BELUM tersimpan. Dialog ditutup, angka baru dihitung ulang dan ditampilkan; simpan lagi = konfirmasi ulang.
                setDialog(null);
                setBerubah({ key: previewKey, lama: net, baru: baru.net });
                hitungUlang();
                return;
            }
            if (galatDariJawaban(j, "petugas").kode === "ORDER_GANDA") setGanda(true);
            // Galat server tampil di dialog: kode O1/promo dijadikan kalimat + tindakan; selain itu kalimat server apa adanya.
            throw new Error(pesanJawaban(j, "Order ditolak server."));
        }
        const order = ((j.data as Record<string, unknown>).order ?? {}) as { id?: string };
        setTersimpan(true);
        router.push(order.id ? `/orders/${order.id}?baru=1` : "/orders");
    }

    return (
        <div>
            <div className="fi-page" style={{ maxWidth: "60rem" }}>
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><Link href="/orders">Order Masuk</Link></li><li><span aria-current="page">Order baru</span></li></ol></nav>
                    <div className="fi-page-bar"><h1>Order baru</h1></div>
                    <p>Harga terisi dari master Accurate menurut kategori dan cabang pelanggan (baca-saja). Diskon dan bonus dihitung server dari aturan promo terbit; angka yang tampil di pratinjau = angka yang dibekukan saat disimpan.</p>
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
                {berubahKini && (
                    <MessageStrip tone="warn" title="Hitungan berubah sejak pratinjau — order BELUM tersimpan.">
                        Netto estimasi {berubahKini.lama !== null ? rupiah(berubahKini.lama) : "—"} menjadi {rupiah(berubahKini.baru)} (harga atau promo berubah). Periksa angka baru di bawah, lalu simpan lagi.
                    </MessageStrip>
                )}
                {draf && nPetugas > 0 && <MessageStrip tone="info" title="Belum disimpan.">{nPetugas} barang memakai harga petugas (harga master belum ada).</MessageStrip>}

                <Section title="Pelanggan" subtitle="cari nama atau kode; cabang, channel, dan kategori harga dari master">
                    <div className="fi-sect-in">
                        <PemilihPelanggan state={pel.state} peran="petugas" saringCabang onPilih={pilihPelanggan} onLepas={pel.lepas}
                            onBacaUlang={(kode) => { void pel.bacaKode(kode); }} />
                        <div className="fi-formgrid">
                            <FormField label="Outlet" required help={pelanggan ? undefined : "Terisi dari nama pelanggan yang dipilih."}>
                                {(a) => <input {...a} className="fi-input" value={outlet} placeholder="Nama outlet" onChange={(e) => { ubahIsian(); setOutlet(e.target.value); }} />}
                            </FormField>
                            <FormField label="Tanggal order" help="Bawaan hari ini (WITA). Harga di daftar barang mengikuti tanggal ini.">
                                {(a) => <input {...a} type="date" className="fi-input" value={orderDate} onChange={(e) => { ubahIsian(); setTanggalIsi(e.target.value); }} />}
                            </FormField>
                            <FormField label="Catatan" help="Ikut ke keterangan faktur.">
                                {(a) => <input {...a} className="fi-input" value={note} placeholder="opsional" onChange={(e) => { ubahIsian(); setNote(e.target.value); }} />}
                            </FormField>
                        </div>
                        {channelMasalah && <MessageStrip tone="warn">{channelMasalah}</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.channelMasalah && (
                            <MessageStrip tone="warn" title="Channel pelanggan berbeda dari master.">{pratinjau.channelMasalah} Order ini akan ditolak sampai channel dibetulkan di Accurate.</MessageStrip>
                        )}
                        {pratinjau?.status === "galat" && pratinjau.galat.menolak && (
                            <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.pesan} {pratinjau.galat.tindakan}</MessageStrip>
                        )}
                        <p className="fi-small fi-muted">Salesman faktur dipilih saat order diantrekan, satu per order (disalin ke setiap baris faktur).</p>
                    </div>
                </Section>

                <Section title="Barang" subtitle={`${filled.length} barang · harga master baca-saja${pelanggan ? ` · barang cabang ${pelanggan.branchName}` : ""}`}>
                    <ul aria-label="Barang" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                        {lines.map((line, index) => {
                            const code = line.code.trim();
                            const wrong = pratinjau?.status === "satuan" ? pratinjau.wrong.find((w) => w.code === code && w.unit === line.unit.trim().toUpperCase()) : undefined;
                            const beda = pratinjau?.status === "barang" ? pratinjau.galat.perBarang[code] : undefined;
                            const info = infoHarga(line, pratinjau);
                            const tanpaHarga = pratinjau?.status === "siap" && pratinjau.tanpaHarga.includes(code);
                            const perluPetugas = Boolean(line.barang && line.unit.trim()) && tanpaMaster(line);
                            const advice = pratinjau?.status === "siap" ? pratinjau.suggestions.find((s) => s.codes.includes(code)) : undefined;
                            const lengkapBaris = Boolean(line.barang && line.unit.trim() && Number(line.quantity) > 0);
                            const petugasSah = line.price !== null && hargaPetugasSah(line.price);
                            return (
                                <li key={index} className="fi-sect-in" style={{ borderBottom: "1px solid var(--line)" }} aria-label={`Barang ${index + 1}`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="fi-tag">Barang {index + 1}</span>
                                        {lines.length > 1 && (
                                            <Button variant="icon" aria-label={`Hapus barang ${index + 1}`} onClick={() => { ubahIsian(); setLines((prev) => prev.filter((_, i) => i !== index)); }}>
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
                                                        {line.barang!.units.map((u) => <option key={u.unit} value={u.unit}>{labelSatuan(u, berlakuHarga(line), rupiah)}</option>)}
                                                    </select>
                                                )}
                                            </FormField>
                                            <FormField label="Jumlah">
                                                {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={line.quantity} placeholder="0" onChange={(e) => ubah(index, "quantity", e.target.value)} />}
                                            </FormField>
                                            <FormField label="Harga"
                                                help={perluPetugas ? "Harga master belum ada — isi harga petugas (lebih dari 0)." : "Harga master; tidak bisa diubah."}
                                                error={perluPetugas && line.price !== null && !petugasSah ? "Isi angka lebih dari 0 (desimal pakai titik, maksimal 4 digit)." : undefined}>
                                                {(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" value={hargaTampil(line)} readOnly={!perluPetugas} required={perluPetugas}
                                                    placeholder={perluPetugas ? "isi harga" : pratinjau?.status === "memuat" && lengkapBaris ? "menghitung…" : "harga master"}
                                                    onChange={(e) => ubah(index, "price", e.target.value)} />}
                                            </FormField>
                                        </div>
                                    )}
                                    {lengkapBaris && pratinjau && (
                                        <div className="flex flex-wrap items-center gap-2 fi-small" aria-live="polite">
                                            {pratinjau.status === "memuat" && <StatusBadge tone="info" busy>Menghitung harga…</StatusBadge>}
                                            {info && info.source !== "petugas" && <><StatusBadge tone="pos">Harga master</StatusBadge><span className="fi-muted">{sumberHarga(info)}</span>
                                                {hargaCabangDefault(info, pelanggan?.branchName) && <StatusBadge tone="neu">harga cabang default</StatusBadge>}</>}
                                            {info && info.source === "petugas" && <><StatusBadge tone="warn">Harga petugas</StatusBadge><span className="fi-muted">{sumberHarga(info)}</span></>}
                                            {tanpaHarga && <><StatusBadge tone="warn">Harga master belum ada</StatusBadge><span className="fi-muted">Isi harga petugas, atau lengkapi daftar harga di Accurate.</span></>}
                                        </div>
                                    )}
                                    {lengkapBaris && <PromoBarisInfo result={hasilPratinjau} code={code} unit={line.unit} nomor={index + 1} />}
                                    {advice && <p className="fi-small fi-why flex items-start gap-1.5"><Lightbulb className="fi-icon" aria-hidden /><span>{advice.message}</span></p>}
                                </li>
                            );
                        })}
                    </ul>
                    <div className="fi-sect-in">
                        <div><Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { ubahIsian(); setLines((prev) => [...prev, emptyLine()]); }}>Tambah barang</Button></div>
                        {pratinjau?.status === "galat" && !pratinjau.galat.menolak && (
                            <MessageStrip tone="warn" title="Harga master dan promo belum terhitung.">
                                {pratinjau.galat.pesan} {pratinjau.galat.tindakan} Order baru bisa disimpan sesudah perkiraan tersedia.{" "}
                                <Button variant="tertiary" onClick={hitungUlang}>Hitung ulang</Button>
                            </MessageStrip>
                        )}
                        {pratinjau?.status === "satuan" && <MessageStrip tone="neg" title="Satuan tidak cocok dengan master.">Perbaiki satuan di barisnya; nilai order dihitung setelah semua satuan cocok.</MessageStrip>}
                        {pratinjau?.status === "barang" && <MessageStrip tone="neg" title={`${pratinjau.galat.judul}.`}>{pratinjau.galat.tindakan}</MessageStrip>}
                        {pratinjau?.status === "siap" && pratinjau.catatan && (
                            <MessageStrip tone="warn" title="Perkiraan tidak tersedia.">{pratinjau.catatan.pesan} {pratinjau.catatan.tindakan}{" "}<Button variant="tertiary" onClick={hitungUlang}>Hitung ulang</Button></MessageStrip>
                        )}
                    </div>
                </Section>

                {pratinjau?.status === "siap" && pratinjau.result && net !== null && (
                    <Section title="Perkiraan" subtitle="pratinjau = yang dibekukan saat disimpan">
                        <div className="fi-sect-in">
                            <PanelPromo result={pratinjau.result} suggestions={pratinjau.suggestions} nTanpaHarga={nTanpaHarga} ppn
                                catatan={`Perkiraan memakai harga master${nPetugas ? `; ${nPetugas} barang memakai harga petugas (harga master belum ada)` : ""}. Angka akhir faktur dihitung Accurate saat Kirim.`} />
                        </div>
                    </Section>
                )}
            </div>
            <FooterToolbar message={terkunci ?? `${lengkap.length} barang${net !== null ? ` · netto estimasi ${rupiah(net)} sebelum PPN` : ""}${nPetugas ? ` · ${nPetugas} harga petugas` : ""}`}>
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
                    : berubahKini
                        ? `Angka berubah sejak pratinjau sebelumnya: netto ${berubahKini.lama !== null ? rupiah(berubahKini.lama) : "—"} menjadi ${rupiah(berubahKini.baru)}. Simpan hanya bila angka baru ini sudah Anda periksa. Diskon dan bonus dibekukan pada order; faktur belum dibuat.`
                        : "Diskon dan bonus dihitung server dari aturan promo terbit lalu dibekukan pada order, sama dengan pratinjau. Faktur belum dibuat; order diantrekan dari halamannya."}
                facts={[
                    ["Pelanggan", `${kodePel.trim()}${pelanggan ? ` · ${pelanggan.name}` : ""}`],
                    ["Cabang", pelanggan?.branchName ?? "–"],
                    ["Channel", channel],
                    ["Tanggal order", tanggalPendek(orderDate)],
                    ["Barang", `${lengkap.length} baris`],
                    ["Netto estimasi (sebelum PPN)", net !== null ? rupiah(net) : "dihitung saat disimpan"],
                    ...(nPetugas ? [["Harga petugas", `${nPetugas} barang (harga master belum ada)`] as [string, string]] : []),
                ]}
                confirmLabel={dialog === "ulang" ? "Simpan lagi" : berubahKini ? "Simpan dengan angka baru" : "Simpan order"}
                confirmDisabled={sudahTersimpan ?? (ganda && !bukanGanda ? "Centang dulu: sudah diperiksa, ini bukan order ganda" : undefined)} onConfirm={simpan}>
                {ganda && (
                    <label className="fi-small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={bukanGanda} onChange={(e) => setBukanGanda(e.target.checked)} />
                        <span>Saya sudah memeriksa Order Masuk: order ini BUKAN order ganda. (Tercatat pada catatan order.)</span>
                    </label>
                )}
            </ConfirmDialog>
        </div>
    );
}
