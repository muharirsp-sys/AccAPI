/*
 * Tujuan: Tab Kontrol JKS (Fiori S5, it05 #20): daftar JKS aktif bersaring (principal, hari, kode sales) dengan halaman, impor Excel
 *   lewat dialog "Terapkan" berisi pratinjau ringan (nama berkas, baris terbaca, kolom dikenali/tidak) — BERKAS YANG SAMA dikirim
 *   ke server yang memetakan kolom (HEADER_MAP di route jks) — lalu hasil `imported` DAN `skipped`; templat kolom diunduh dari klien.
 * Caller: form-kontrol/FormKontrol.tsx (tab "jks").
 * Dependensi: ../shared (Scope, PRINCIPLES, HARI, JksRow, ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive},
 *   xlsx (dimuat saat dipakai: pratinjau + templat).
 * Main Functions: TabJks (default), bacaPratinjau, unduhTemplat.
 * Side Effects: GET /api/form-kontrol/jks; POST /api/form-kontrol/jks (FormData `file`) lewat ConfirmDialog; unduh templat-jks.xlsx.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, RefreshCw, Upload } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { HARI, PRINCIPLES, ambilFk, tulisFk, useIzinFk, type JksRow, type Scope } from "../shared";

/**
 * Kolom templat + header yang dikenali server. ponytail: `alias` = salinan kunci HEADER_MAP di app/api/form-kontrol/jks/route.ts
 * (ternormalisasi: huruf kecil tanpa spasi/tanda), HANYA untuk pratinjau & templat — payload tetap berkas apa adanya. Batasnya:
 * bila HEADER_MAP berubah, pratinjau bisa salah menyebut kolom; pindahkan HEADER_MAP ke lib/form-kontrol (tracker AM) agar satu sumber.
 */
const KOLOM: { field: string; header: string; isi: string; alias: string[] }[] = [
    { field: "salesCode", header: "Kode Sales", isi: "Wajib", alias: ["salescode", "kodesales", "kodesalesman", "sales"] },
    { field: "salesName", header: "Nama Sales", isi: "", alias: ["salesname", "namasales", "namasalesman"] },
    { field: "custCode", header: "Kode Toko", isi: "Wajib", alias: ["custcode", "kodetoko", "kodecustomer", "kodepelanggan"] },
    { field: "custName", header: "Nama Toko", isi: "", alias: ["custname", "namatoko", "namacustomer", "namapelanggan"] },
    { field: "market", header: "Market", isi: "", alias: ["market"] },
    // Sel kosong tersimpan kosong (route membaca "", db `?? "TT"` hanya menangkap kolom yang tidak ada) — jadi wajib diisi.
    { field: "channel", header: "Channel", isi: "Wajib diisi: GT, TT, atau MT (sel kosong tersimpan tanpa channel)", alias: ["channel"] },
    { field: "alamat", header: "Alamat", isi: "", alias: ["alamat", "address"] },
    { field: "kota", header: "Kota", isi: "", alias: ["kota", "city"] },
    { field: "hariKunjungan", header: "Hari", isi: "Senin, Selasa, Rabu, Kamis, Jumat, atau Sabtu", alias: ["hari", "harikunjungan", "day"] },
    { field: "mingguPattern", header: "Pola", isi: "ganjil, genap, atau all; isian lain dibaca all", alias: ["pola", "polaminggu", "minggupattern", "pattern"] },
    { field: "area", header: "Area", isi: "", alias: ["area"] },
    { field: "rayon", header: "Rayon", isi: "", alias: ["rayon"] },
    { field: "principle", header: "Principle", isi: "Wajib", alias: ["principle", "principal", "prinsipal"] },
    { field: "visitFrequency", header: "Frekuensi", isi: "1, 2, atau 4 kali per bulan; kosong = 4 untuk pola all, 2 untuk ganjil/genap", alias: ["freq", "frekuensi", "visitfrequency", "frequency"] },
];
const WAJIB = KOLOM.filter((k) => k.isi === "Wajib");
const normal = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const LIMIT = 50; // bawaan route GET jks

/** `channelKosong` = jumlah baris dengan sel Channel kosong; null bila berkas tanpa kolom Channel (server memakai TT). */
type Pratinjau = { baris: number; dikenali: string[]; asing: string[]; wajibHilang: string[]; channelKosong: number | null };
type DataJks = { rows: JksRow[]; total: number };

/** Baca ringan di peramban: baris dan header sheet pertama, persis cara server membacanya (sheet_to_json, defval ""). */
async function bacaPratinjau(file: File): Promise<Pratinjau> {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { baris: 0, dikenali: [], asing: [], wajibHilang: WAJIB.map((k) => k.header), channelKosong: null };
    const mentah = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })[0] ?? []).map(String); // = kunci objek baris
    const header = mentah.map((h) => h.trim()).filter(Boolean);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const field = (h: string) => KOLOM.find((k) => k.alias.includes(normal(h)))?.field;
    const ada = new Set(header.map(field).filter(Boolean));
    // Server: header terakhir yang dipetakan ke channel menang (urutan kolom).
    const kolomChannel = mentah.filter((h) => field(h) === "channel").at(-1);
    return {
        baris: rows.length,
        channelKosong: kolomChannel === undefined ? null : rows.filter((r) => String(r[kolomChannel] ?? "").trim() === "").length,
        dikenali: header.filter((h) => field(h)),
        asing: header.filter((h) => !field(h)),
        wajibHilang: WAJIB.filter((k) => !ada.has(k.field)).map((k) => k.header),
    };
}

async function unduhTemplat() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    // Sheet pertama = yang dibaca server; petunjuk di sheet kedua supaya tidak ikut terimpor.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([KOLOM.map((k) => k.header)]), "JKS");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Kolom", "Isi"], ...KOLOM.map((k) => [k.header, k.isi || "Opsional"])]), "Petunjuk");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "templat-jks.xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TabJks({ scope }: { scope: Scope }) {
    const izinImpor = useIzinFk("manage");
    const semuaSales = scope.allowedSalesCodes === null;
    const [principle, setPrinciple] = useState("");
    const [hari, setHari] = useState("");
    const [sales, setSales] = useState("");
    const [page, setPage] = useState(1);
    const saring = (f: () => void) => { f(); setPage(1); };

    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<DataJks>> => {
        // Query sama dengan hari ini (+ `page`, parameter route yang sudah ada).
        const p = new URLSearchParams();
        if (principle) p.set("principle", principle);
        if (hari) p.set("hari", hari);
        if (sales.trim()) p.set("salesCode", sales.trim());
        if (scope.allowedSalesCodes) p.set("salesCodes", scope.allowedSalesCodes.join(","));
        if (page > 1) p.set("page", String(page));
        return ambilFk(`/api/form-kontrol/jks?${p}`, (j) => ({ rows: (j.rows ?? []) as JksRow[], total: Number(j.total ?? 0) }), "Data JKS belum berhasil dimuat.");
    }, [principle, hari, sales, page, scope.allowedSalesCodes]), { pertahankan: true });

    const rows = load.data?.rows ?? [];
    const total = load.data?.total ?? 0;
    const halaman = Math.max(1, Math.ceil(total / LIMIT));
    const tanpaHari = rows.filter((r) => !r.hariKunjungan).length;
    const aktif = Number(Boolean(principle)) + Number(Boolean(hari)) + Number(Boolean(sales.trim()));

    // Dialog impor: berkas + pratinjau milik halaman; dikosongkan tiap dialog dibuka.
    const [impor, setImpor] = useState(false);
    const [berkas, setBerkas] = useState<File | null>(null);
    const [pratinjau, setPratinjau] = useState<{ status: "kosong" | "membaca" | "siap" | "galat"; data?: Pratinjau }>({ status: "kosong" });
    const [hasil, setHasil] = useState<{ nama: string; imported: number; skipped: number } | null>(null);
    const [galatTemplat, setGalatTemplat] = useState("");

    const giliran = useRef(0); // pratinjau berkas yang sudah diganti tidak boleh menimpa pratinjau berkas terbaru
    const pilihBerkas = async (file: File | null) => {
        const ini = ++giliran.current;
        setBerkas(file);
        if (!file) { setPratinjau({ status: "kosong" }); return; }
        setPratinjau({ status: "membaca" });
        let hasilBaca: typeof pratinjau;
        try { hasilBaca = { status: "siap", data: await bacaPratinjau(file) }; } catch { hasilBaca = { status: "galat" }; }
        if (ini === giliran.current) setPratinjau(hasilBaca);
    };
    const bukaImpor = () => { setBerkas(null); setPratinjau({ status: "kosong" }); setImpor(true); };

    const blokirImpor = !berkas ? "Pilih berkas dulu"
        : pratinjau.status === "membaca" ? "Tunggu pratinjau selesai"
        : pratinjau.status === "galat" ? "Berkas tidak bisa dibaca sebagai Excel"
        : pratinjau.data?.baris === 0 ? "Berkas tidak berisi baris" : undefined;

    const kolom: Column<JksRow>[] = [
        { key: "cust", header: "Kode toko", cell: (r) => <span className="fi-mono">{r.custCode}</span> },
        { key: "nama", header: "Nama toko", cell: (r) => r.custName },
        { key: "sales", header: "Salesman", secondary: true, cell: (r) => <><span className="fi-mono">{r.salesCode}</span>{r.salesName ? ` · ${r.salesName}` : ""}</> },
        { key: "market", header: "Market", secondary: true, cell: (r) => r.market || "—" },
        { key: "kota", header: "Kota", secondary: true, cell: (r) => r.kota || "—" },
        { key: "hari", header: "Hari", cell: (r) => r.hariKunjungan || <StatusBadge tone="warn">Belum diisi</StatusBadge> },
        { key: "pola", header: "Pola minggu", cell: (r) => r.mingguPattern },
        { key: "area", header: "Area", secondary: true, cell: (r) => r.area || "—" },
        { key: "rayon", header: "Rayon", secondary: true, cell: (r) => r.rayon || "—" },
        { key: "principle", header: "Principal", cell: (r) => r.principle },
        { key: "freq", header: "Frekuensi", align: "end", cell: (r) => <span className="fi-tnum">{r.visitFrequency}×/bln</span> },
    ];

    return (
        <>
            <FilterBar
                title="Kontrol JKS"
                activeCount={aktif}
                chips={[
                    ...(principle ? [{ label: `Principal: ${principle}`, onRemove: () => saring(() => setPrinciple("")) }] : []),
                    ...(hari ? [{ label: `Hari: ${hari}`, onRemove: () => saring(() => setHari("")) }] : []),
                    ...(sales.trim() ? [{ label: `Kode sales: ${sales.trim()}`, onRemove: () => saring(() => setSales("")) }] : []),
                ]}
                onReset={() => saring(() => { setPrinciple(""); setHari(""); setSales(""); })}
                actions={
                    <div className="fi-btnrow">
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Muat ulang</Button>
                        <Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => { setGalatTemplat(""); unduhTemplat().catch(() => setGalatTemplat("Templat gagal dibuat di peramban ini. Coba lagi atau pakai peramban lain.")); }}>Unduh templat</Button>
                        <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} disabled={Boolean(izinImpor)} disabledReason={izinImpor} onClick={bukaImpor}>Impor Excel</Button>
                    </div>
                }
                search={semuaSales ? (
                    <FormField label="Kode sales">{(a) => <input {...a} className="fi-input" value={sales} onChange={(e) => saring(() => setSales(e.target.value))} placeholder="Semua salesman" />}</FormField>
                ) : undefined}
                fields={
                    <>
                        <FormField label="Principal">{(a) => (
                            <select {...a} className="fi-input" value={principle} onChange={(e) => saring(() => setPrinciple(e.target.value))}>
                                <option value="">Semua principal</option>
                                {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Hari kunjungan">{(a) => (
                            <select {...a} className="fi-input" value={hari} onChange={(e) => saring(() => setHari(e.target.value))}>
                                <option value="">Semua hari</option>
                                {HARI.map((h) => <option key={h} value={h}>{h}</option>)}
                            </select>
                        )}</FormField>
                    </>
                }
            />
            {galatTemplat && <MessageStrip tone="neg" title="Templat gagal diunduh." onClose={() => setGalatTemplat("")}>{galatTemplat}</MessageStrip>}
            {hasil && (
                <MessageStrip tone="pos" title="Impor JKS diterapkan." onClose={() => setHasil(null)}>
                    {hasil.nama}: {hasil.imported} baris ditulis, {hasil.skipped} baris dilewati
                    {hasil.skipped > 0 ? " (tanpa kode sales, kode toko, atau principal)" : ""}.
                </MessageStrip>
            )}
            {tanpaHari > 0 && (
                <MessageStrip tone="warn" title={`${tanpaHari} toko di halaman ini belum punya hari kunjungan.`}>
                    Wajib dilengkapi: perbaiki kolom Hari di berkas JKS lalu impor ulang.
                </MessageStrip>
            )}
            {!semuaSales && (
                <VariantNote bl="BL-32">
                    Server belum membatasi JKS ke tim Anda: kode sales tim ikut dikirim tetapi belum dipakai, jadi daftar ini bisa memuat toko
                    salesman lain.
                </VariantNote>
            )}
            <ResponsiveTable
                title="JKS aktif"
                count={total}
                columns={kolom}
                rows={rows}
                rowKey={(r) => r.id}
                status={load.status}
                error={load.error}
                onRetry={muatUlang}
                empty={aktif
                    ? { title: "Tidak ada JKS yang sesuai saringan", message: "Ubah atau hapus saringan." }
                    : { title: "Belum ada data JKS", message: "Unduh templat, isi, lalu Impor Excel untuk memulai." }}
                mobileItem={(r) => (
                    <ListItem doc={<span className="fi-mono">{r.custCode}</span>} amount={<span className="fi-tnum">{r.visitFrequency}×/bln</span>}
                        title={r.custName}
                        meta={`${r.salesCode} · ${r.hariKunjungan || "Hari belum diisi"} · ${r.mingguPattern} · ${r.principle}`}
                        badge={r.hariKunjungan ? undefined : <StatusBadge tone="warn">Belum diisi</StatusBadge>} />
                )}
            />
            {halaman > 1 && (
                <div className="fi-btnrow">
                    <Button icon={<ChevronLeft className="fi-icon" aria-hidden />} disabled={page <= 1 || load.status === "memuat"} onClick={() => setPage((p) => p - 1)}>Sebelumnya</Button>
                    <span className="fi-small fi-tnum">Halaman {page} dari {halaman}</span>
                    <Button disabled={page >= halaman || load.status === "memuat"} onClick={() => setPage((p) => p + 1)}>Berikutnya<ChevronRight className="fi-icon" aria-hidden /></Button>
                </div>
            )}
            <ConfirmDialog
                open={impor}
                onClose={() => setImpor(false)}
                tag="Impor JKS"
                title="Terapkan berkas JKS?"
                description="Berkas dikirim apa adanya; server memetakan kolom lalu menulis per baris (kunci: kode sales + kode toko + principal). Baris yang sudah ada diganti isinya."
                confirmLabel="Terapkan"
                confirmDisabled={blokirImpor}
                onConfirm={async () => {
                    const fd = new FormData();
                    fd.append("file", berkas!);
                    try {
                        const d = await tulisFk("/api/form-kontrol/jks", { body: fd, gagal: "Impor JKS gagal." });
                        setHasil({ nama: berkas!.name, imported: Number(d.imported ?? 0), skipped: Number(d.skipped ?? 0) });
                        setImpor(false);
                        muatUlang();
                    } catch (e) {
                        // Server menulis per baris tanpa transaksi: 500 bisa berarti sebagian baris sudah tersimpan.
                        if ((e as { status?: number }).status === 500) {
                            muatUlang();
                            throw new Error("Impor berhenti di tengah jalan; sebagian baris mungkin sudah tersimpan. Periksa daftar JKS sebelum mengulang.");
                        }
                        throw e;
                    }
                }}
            >
                <FormField label="Berkas JKS (.xlsx)" required help="Sheet pertama dibaca. Pakai templat bila ragu nama kolomnya.">{(a) => (
                    <input {...a} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => void pilihBerkas(e.target.files?.[0] ?? null)} />
                )}</FormField>
                {pratinjau.status === "membaca" && <Skeleton rows={2} label={`Membaca ${berkas?.name ?? "berkas"}`} />}
                {pratinjau.status === "galat" && <p className="fi-msg" role="alert">Berkas tidak bisa dibaca sebagai Excel. Pilih berkas .xlsx lain.</p>}
                {pratinjau.status === "siap" && pratinjau.data && (
                    <>
                        <KeyValues items={[
                            ["Berkas", berkas?.name ?? "—"],
                            ["Baris terbaca", <span key="b" className="fi-tnum">{pratinjau.data.baris}</span>],
                            ["Kolom dikenali", pratinjau.data.dikenali.length ? `${pratinjau.data.dikenali.length}: ${pratinjau.data.dikenali.join(", ")}` : "—"],
                            ["Kolom tidak dikenali", pratinjau.data.asing.length ? `${pratinjau.data.asing.join(", ")} (diabaikan)` : "—"],
                        ]} />
                        {(pratinjau.data.channelKosong ?? 0) > 0 && (
                            <MessageStrip tone="warn" title={`Kolom Channel kosong di ${pratinjau.data.channelKosong} baris.`}>
                                Baris itu tersimpan tanpa channel (bukan TT). Isi GT, TT, atau MT bila perlu, lalu pilih ulang berkasnya.
                            </MessageStrip>
                        )}
                        {pratinjau.data.wajibHilang.length > 0 && (
                            <MessageStrip tone="warn" title={`Kolom wajib tidak ada: ${pratinjau.data.wajibHilang.join(", ")}.`}>
                                Server melewati baris tanpa kolom ini.
                            </MessageStrip>
                        )}
                    </>
                )}
                <VariantNote bl="it05 #20">
                    Pratinjau perubahan per baris (baru, berubah, tidak ada di berkas) belum ada di server: Terapkan langsung menulis, menjadikan
                    semua baris di berkas Aktif, dan membaca pola minggu yang tidak dikenal sebagai &quot;all&quot;.
                </VariantNote>
            </ConfirmDialog>
        </>
    );
}
