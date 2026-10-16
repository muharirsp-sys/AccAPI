/*
 * Tujuan: Tab Koordinat Toko (Supervisor Review SR-3): ringkasan toko JKS yang sudah/belum berkoordinat, templat xlsx (kode toko, latitude,
 *   longitude; diisi contoh toko tanpa koordinat), pratinjau ringan di peramban, lalu unggah lewat dialog konfirmasi dan hasilnya
 *   (disimpan + tabel baris ditolak). Koordinat dipakai penanda toko di peta Supervisor Review.
 * Caller: form-kontrol/FormKontrol.tsx (tab "koordinat"; admin, manager, admin_sales).
 * Dependensi: ../shared (ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive}, lib/supervisor-review/kontrak (tipe),
 *   xlsx (dimuat saat dipakai: pratinjau + templat).
 * Main Functions: TabKoordinat (default), bacaPratinjau, unduhTemplat.
 * Side Effects: GET /api/supervisor-review/koordinat; POST multipart `file` ke URL yang sama lewat ConfirmDialog; unduh templat-koordinat-toko.xlsx.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, ErrorState, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import type { JawabanUnggahKoordinat, RingkasanKoordinat } from "@/lib/supervisor-review/kontrak";
import { ambilFk, tulisFk, useIzinFk } from "../shared";

const URL_API = "/api/supervisor-review/koordinat";
type Ditolak = JawabanUnggahKoordinat["ditolak"][number];

/**
 * Header templat + alias yang dikenali pratinjau. ponytail: `alias` = tebakan klien (huruf kecil tanpa spasi/tanda) untuk pratinjau saja —
 * berkas dikirim apa adanya dan server (SR-1) yang memetakan kolom; bila pemetaan server berbeda, pratinjau bisa keliru menyebut kolom hilang.
 */
const KOLOM = [
    { field: "kode", header: "Kode Toko", alias: ["kodetoko", "custcode", "kodecustomer", "kodepelanggan"] },
    { field: "lat", header: "Latitude", alias: ["latitude", "lat"] },
    { field: "lng", header: "Longitude", alias: ["longitude", "lng", "long", "lon"] },
] as const;
type Field = (typeof KOLOM)[number]["field"];
const normal = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const fieldDari = (h: string): Field | undefined => KOLOM.find((k) => (k.alias as readonly string[]).includes(normal(h)))?.field;

/** `tidakSah` = baris tanpa kode toko, atau latitude/longitude kosong / bukan angka / di luar rentang (server menolaknya per baris). */
type Pratinjau = { baris: number; dikenali: string[]; asing: string[]; wajibHilang: string[]; tidakSah: number };

/** Baca ringan di peramban: sheet pertama, persis cara JKS (sheet_to_json, defval ""). */
async function bacaPratinjau(file: File): Promise<Pratinjau> {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { baris: 0, dikenali: [], asing: [], wajibHilang: KOLOM.map((k) => k.header), tidakSah: 0 };
    const kunci = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })[0] ?? []).map((h) => String(h).trim()).filter(Boolean);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const kolomDari = (f: Field) => kunci.find((h) => fieldDari(h) === f);
    const [kKode, kLat, kLng] = [kolomDari("kode"), kolomDari("lat"), kolomDari("lng")];
    const angka = (v: unknown, maks: number) => { const t = String(v ?? "").trim(); return t !== "" && Number.isFinite(Number(t)) && Math.abs(Number(t)) <= maks; };
    return {
        baris: rows.length,
        dikenali: kunci.filter((h) => fieldDari(h)),
        asing: kunci.filter((h) => !fieldDari(h)),
        wajibHilang: KOLOM.filter((k) => !kolomDari(k.field)).map((k) => k.header),
        tidakSah: rows.filter((r) => !kKode || !kLat || !kLng || String(r[kKode] ?? "").trim() === "" || !angka(r[kLat], 90) || !angka(r[kLng], 180)).length,
    };
}

async function unduhTemplat(contoh: RingkasanKoordinat["contohTanpaKoordinat"]) {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    // Sheet pertama = yang dibaca server; petunjuk + nama toko di sheet kedua supaya tidak ikut terunggah.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([KOLOM.map((k) => k.header), ...contoh.map((c) => [c.custCode, "", ""])]), "Koordinat");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ["Kolom", "Isi"],
        ["Kode Toko", "Kode toko JKS (wajib)"],
        ["Latitude", "Desimal dengan titik, -90 s.d. 90 (wajib). Contoh: -5.147665"],
        ["Longitude", "Desimal dengan titik, -180 s.d. 180 (wajib). Contoh: 119.432732"],
        [],
        ["Kode Toko", "Nama Toko (daftar toko JKS aktif tanpa koordinat, maks. 200)"],
        ...contoh.map((c) => [c.custCode, c.namaToko]),
    ]), "Petunjuk");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "templat-koordinat-toko.xlsx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Tanpa props: cakupan ditegakkan server, izin unggah dibaca dari konteks (useIzinFk); tetap cocok dengan kontrak tab ({ scope }).
export default function TabKoordinat() {
    const izinUnggah = useIzinFk("manage");
    const [load, muatUlang] = useLoad(useCallback((): Promise<Load<RingkasanKoordinat>> => ambilFk(URL_API, (j) => ({
        tokoJks: Number(j.tokoJks ?? 0),
        berKoordinat: Number(j.berKoordinat ?? 0),
        contohTanpaKoordinat: Array.isArray(j.contohTanpaKoordinat) ? j.contohTanpaKoordinat as RingkasanKoordinat["contohTanpaKoordinat"] : [],
    }), "Ringkasan koordinat belum berhasil dimuat."), []), { pertahankan: true });
    const ringkasan = load.data;
    const belum = ringkasan ? Math.max(0, ringkasan.tokoJks - ringkasan.berKoordinat) : 0;

    const [dialog, setDialog] = useState(false);
    const [berkas, setBerkas] = useState<File | null>(null);
    const [pratinjau, setPratinjau] = useState<{ status: "kosong" | "membaca" | "siap" | "galat"; data?: Pratinjau }>({ status: "kosong" });
    const [hasil, setHasil] = useState<{ nama: string; disimpan: number; ditolak: Ditolak[] } | null>(null);
    const [galatTemplat, setGalatTemplat] = useState("");

    const giliran = useRef(0); // pratinjau berkas yang sudah diganti tidak boleh menimpa pratinjau berkas terbaru
    const pilihBerkas = async (file: File | null) => {
        const ini = ++giliran.current;
        setBerkas(file);
        if (!file) { setPratinjau({ status: "kosong" }); return; }
        setPratinjau({ status: "membaca" });
        let baca: typeof pratinjau;
        try { baca = { status: "siap", data: await bacaPratinjau(file) }; } catch { baca = { status: "galat" }; }
        if (ini === giliran.current) setPratinjau(baca);
    };
    const bukaDialog = () => { setBerkas(null); setPratinjau({ status: "kosong" }); setDialog(true); };

    const blokir = !berkas ? "Pilih berkas dulu"
        : pratinjau.status === "membaca" ? "Tunggu pratinjau selesai"
        : pratinjau.status === "galat" ? "Berkas tidak bisa dibaca sebagai Excel"
        : pratinjau.data?.baris === 0 ? "Berkas tidak berisi baris" : undefined;

    const kolom: Column<Ditolak>[] = [
        { key: "baris", header: "Baris", align: "end", cell: (r) => <span className="fi-tnum">{r.baris}</span> },
        { key: "kode", header: "Kode toko", cell: (r) => <span className="fi-mono">{r.kode || "—"}</span> },
        { key: "pesan", header: "Alasan ditolak", cell: (r) => r.pesan },
    ];

    return (
        <>
            <Section
                title="Koordinat Toko"
                subtitle="Titik toko di peta Supervisor Review"
                actions={
                    <div className="fi-btnrow">
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Muat ulang</Button>
                        <Button icon={<Download className="fi-icon" aria-hidden />} disabled={!ringkasan}
                            onClick={() => { setGalatTemplat(""); unduhTemplat(ringkasan!.contohTanpaKoordinat).catch(() => setGalatTemplat("Templat gagal dibuat di peramban ini. Coba lagi atau pakai peramban lain.")); }}>Unduh templat</Button>
                        <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} disabled={Boolean(izinUnggah)} disabledReason={izinUnggah} onClick={bukaDialog}>Unggah koordinat</Button>
                    </div>
                }
            >
                {load.status === "memuat" && !ringkasan && <Skeleton rows={2} label="Memuat ringkasan koordinat" />}
                {load.status === "galat" && <ErrorState title="Ringkasan koordinat gagal dimuat" message={load.error} onRetry={muatUlang} />}
                {ringkasan && (
                    <KeyValues items={[
                        ["Toko JKS aktif", <span key="j" className="fi-tnum">{ringkasan.tokoJks}</span>],
                        ["Sudah berkoordinat", <span key="b" className="fi-tnum">{ringkasan.berKoordinat}</span>],
                        ["Belum berkoordinat", <span key="n" className="fi-tnum">{belum}</span>],
                    ]} />
                )}
            </Section>
            {galatTemplat && <MessageStrip tone="neg" title="Templat gagal diunduh." onClose={() => setGalatTemplat("")}>{galatTemplat}</MessageStrip>}
            {ringkasan && belum > 0 && ringkasan.contohTanpaKoordinat.length > 0 && (
                <p className="fi-small fi-muted">Templat berisi {ringkasan.contohTanpaKoordinat.length} toko pertama yang belum berkoordinat; kolom Latitude dan Longitude tinggal diisi.</p>
            )}
            {hasil && (
                <MessageStrip tone={hasil.disimpan > 0 ? "pos" : "warn"} title="Unggahan koordinat selesai." onClose={() => setHasil(null)}>
                    {hasil.nama}: {hasil.disimpan} koordinat disimpan{hasil.ditolak.length > 0 ? `, ${hasil.ditolak.length} baris ditolak` : ""}.
                    {hasil.ditolak.length > 0 ? " Baris yang sah tetap tersimpan; perbaiki sisanya di berkas lalu unggah ulang." : ""}
                </MessageStrip>
            )}
            {hasil && hasil.ditolak.length > 0 && (
                <ResponsiveTable
                    title="Baris ditolak"
                    count={hasil.ditolak.length}
                    columns={kolom}
                    rows={hasil.ditolak}
                    rowKey={(r) => `${r.baris}-${r.kode}`}
                    empty={{ title: "Tidak ada baris ditolak" }}
                    mobileItem={(r) => <ListItem doc={<span className="fi-mono">{r.kode || "—"}</span>} amount={<span className="fi-tnum">baris {r.baris}</span>} title={r.pesan} />}
                />
            )}
            <ConfirmDialog
                open={dialog}
                onClose={() => setDialog(false)}
                tag="Koordinat toko"
                title="Terapkan berkas koordinat?"
                description="Berkas dikirim apa adanya; server membaca kode toko, latitude, dan longitude lalu menyimpan per baris. Koordinat yang sudah ada untuk toko yang sama diganti."
                confirmLabel="Terapkan"
                confirmDisabled={blokir}
                onConfirm={async () => {
                    const fd = new FormData();
                    fd.append("file", berkas!);
                    try {
                        const d = await tulisFk(URL_API, { body: fd, gagal: "Unggah koordinat gagal." });
                        setHasil({ nama: berkas!.name, disimpan: Number(d.disimpan ?? 0), ditolak: Array.isArray(d.ditolak) ? d.ditolak as Ditolak[] : [] });
                        setDialog(false);
                        muatUlang();
                    } catch (e) {
                        // 4xx = tidak ada yang ditulis; 500 bisa berarti sebagian baris sudah tersimpan.
                        if ((e as { status?: number }).status === 500) {
                            muatUlang();
                            throw new Error("Unggahan berhenti di tengah jalan; sebagian koordinat mungkin sudah tersimpan. Periksa ringkasan sebelum mengulang.");
                        }
                        throw e;
                    }
                }}
            >
                <FormField label="Berkas koordinat (.xlsx)" required help="Sheet pertama dibaca: kolom Kode Toko, Latitude, Longitude. Pakai templat bila ragu.">{(a) => (
                    <input {...a} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => void pilihBerkas(e.target.files?.[0] ?? null)} />
                )}</FormField>
                {pratinjau.status === "membaca" && <Skeleton rows={2} label={`Membaca ${berkas?.name ?? "berkas"}`} />}
                {pratinjau.status === "galat" && <p className="fi-msg" role="alert">Berkas tidak bisa dibaca sebagai Excel. Pilih berkas .xlsx lain.</p>}
                {pratinjau.status === "siap" && pratinjau.data && (
                    <>
                        <KeyValues items={[
                            ["Berkas", berkas?.name ?? "—"],
                            ["Baris terbaca", <span key="b" className="fi-tnum">{pratinjau.data.baris}</span>],
                            ["Kolom dikenali", pratinjau.data.dikenali.length ? pratinjau.data.dikenali.join(", ") : "—"],
                            ["Kolom tidak dikenali", pratinjau.data.asing.length ? `${pratinjau.data.asing.join(", ")} (diabaikan)` : "—"],
                        ]} />
                        {pratinjau.data.wajibHilang.length > 0 && (
                            <MessageStrip tone="warn" title={`Kolom wajib tidak ada: ${pratinjau.data.wajibHilang.join(", ")}.`}>
                                Server menolak baris tanpa kolom ini.
                            </MessageStrip>
                        )}
                        {pratinjau.data.wajibHilang.length === 0 && pratinjau.data.tidakSah > 0 && (
                            <MessageStrip tone="warn" title={`${pratinjau.data.tidakSah} baris tampak tidak sah.`}>
                                Kode toko kosong, atau latitude/longitude kosong, bukan angka, atau di luar rentang. Server menolak baris itu dan melaporkannya; baris lain tetap disimpan.
                            </MessageStrip>
                        )}
                    </>
                )}
            </ConfirmDialog>
        </>
    );
}
