/*
 * Tujuan: Normalisasi diskon pada faktur Accurate — potongan yang Rekap Promo sebut "tak bertuan"
 *         digolongkan manusia jadi Disc Claim atau Disc Distributor, DENGAN aturan promo dasarnya.
 * Caller: Route dashboard `/normalisasi-diskon`.
 * Dependensi: GET /api/promo-recap (baris + calon aturan), /api/promo-recap/normalisasi (simpan/cabut),
 *             components/ui/AsyncState, sonner.
 * Main Functions: NormalisasiDiskonPage, simpan, cabut.
 * Side Effects: HTTP; menulis `discount_normalization`. TIDAK menulis ke Accurate.
 *
 * Faktur yang terbit lewat web IKUT ditampilkan, ditandai "web". Sampai 2026-09-25 disembunyikan
 * dengan alasan gerbang sudah menilainya — tetapi gerbang menilai ORDER, bukan faktur yang akhirnya
 * ada di Accurate. INV/2609/KN00450 terbit dengan 3% principal di kolom 1 (bug rantai persen yang
 * sudah diperbaiki), INV/2609/KN00617 kehilangan satu baris karena diubah di Accurate sesudah
 * terbit; keduanya tak bertuan dan tidak bisa diputuskan di mana pun. Tidak ada putusan gerbang
 * yang tertimpa: normalisasi hanya berlaku pada baris yang TIDAK dijelaskan aturan mana pun.
 *
 * Sejak 1 Okt 2026 golongan tidak bisa dipilih bebas: Disc Claim butuh aturan beban principal,
 * Disc Distributor butuh aturan beban distributor, dan aturannya harus berlaku untuk potongan itu
 * (principal, periode, outlet, barang). Calonnya dihitung server (`alasanTakBerlaku`); satu
 * keputusan untuk beberapa potongan sekaligus hanya bisa memakai aturan yang berlaku untuk SEMUANYA.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { LoadingState } from "@/components/ui/AsyncState";

type Golongan = "principal" | "distributor";

type Row = {
    bucket: Golongan | "unowned"; web?: boolean;
    invoiceNo: string; invoiceId: string; lineKey: string; transDate: string; branchName: string;
    customerNo: string; customerName: string; itemCode: string; itemName: string;
    positions: string; percent: number; amount: number;
    suratProgram: string; promoGroup: string; reason: string;
    calonAturan?: Record<Golongan, number[]>; aturanId?: number;
};

type Aturan = {
    id: number; suratProgram: string; promoGroup: string; promoLabel: string; itemCode: string; itemName: string;
    customerCode: string; periodStart: string | null; periodEnd: string | null; tierNo: number;
    benefitType: string; benefitValue: string; benefitBeban: string; outletList: string; outletListMode: string;
};

type Data = { principals: string[]; recap: { rows: Row[] }; webInvoiceIds: string[]; aturan?: Aturan[] };

type Grup = { key: string; invoiceNo: string; transDate: string; customerNo: string; customerName: string;
    positions: string; percent: number; bucket: Row["bucket"]; rows: Row[]; amount: number; reason: string };

const rp = (value: number) => `Rp ${Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** ISO -> dd/mm/yyyy, bentuk tanggal yang dibaca pengguna di Accurate. */
const tgl = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const persen = (value: number | string) => `${String(value).replace(".", ",")}%`;
const NORMALISASI = "NORMALISASI";
const LABEL: Record<Golongan, string> = { principal: "Disc Claim", distributor: "Disc Distributor" };

/** Irisan calon aturan: satu keputusan untuk banyak potongan hanya sah bila aturannya berlaku untuk semuanya. */
const irisan = (rows: Row[], golongan: Golongan) => rows.length === 0 ? []
    : rows.map((row) => row.calonAturan?.[golongan] ?? []).reduce((a, b) => a.filter((id) => b.includes(id)));

function nilaiAturan(a: Aturan) {
    if (a.benefitType === "DISC_RP") return rp(Number(a.benefitValue));
    if (a.benefitType === "BONUS_QTY") return `bonus ${a.benefitValue}`;
    return persen(a.benefitValue);
}

/** Satu baris pilihan: cukup untuk membedakan aturan tanpa membuka halaman Aturan Promo. */
function labelAturan(a: Aturan) {
    const cakupan = a.customerCode ? `tarif ${a.customerCode} posisi ${a.tierNo}` : a.itemCode || "seluruh nota";
    const periode = a.periodStart || a.periodEnd ? `${tgl(a.periodStart) || "…"}–${tgl(a.periodEnd) || "dicabut"}` : "tanpa batas waktu";
    return [a.suratProgram, a.promoGroup || a.promoLabel, nilaiAturan(a), cakupan, periode].filter(Boolean).join(" · ");
}

/**
 * Satu grup = faktur x posisi x persen: keputusan diambil per faktur, karena dasar keputusannya
 * (fakturnya di Accurate) juga per faktur. Diurutkan per outlet supaya faktur satu outlet berdampingan.
 */
function kelompokkan(rows: Row[]): Grup[] {
    const map = new Map<string, Grup>();
    for (const row of rows) {
        const key = `${row.bucket}|${row.invoiceId}|${row.positions}|${row.percent}`;
        const grup = map.get(key) ?? { key, invoiceNo: row.invoiceNo, transDate: row.transDate, customerNo: row.customerNo,
            customerName: row.customerName, positions: row.positions, percent: row.percent, bucket: row.bucket,
            rows: [], amount: 0, reason: row.reason };
        grup.rows.push(row);
        grup.amount = Math.round((grup.amount + row.amount) * 100) / 100;
        map.set(key, grup);
    }
    return [...map.values()].sort((a, b) => a.customerName.localeCompare(b.customerName)
        || a.transDate.localeCompare(b.transDate) || a.invoiceNo.localeCompare(b.invoiceNo));
}

export default function NormalisasiDiskonPage() {
    const now = new Date();
    const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
    const [to, setTo] = useState(ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    const [principal, setPrincipal] = useState("");
    const [data, setData] = useState<Data | null>(null);
    // Memuat, siap, atau galat: tiga keadaan yang berbeda dan harus TERLIHAT berbeda. Tabel kosong
    // saat masih memuat terbaca "tidak ada potongan tak bertuan" — kesimpulan yang salah.
    const [status, setStatus] = useState<"memuat" | "siap" | "galat">("memuat");
    const [galat, setGalat] = useState("");
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [golongan, setGolongan] = useState<Golongan | "">("");
    const [aturanId, setAturanId] = useState("");
    const [cariAturan, setCariAturan] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [galatSimpan, setGalatSimpan] = useState("");
    const permintaan = useRef<AbortController | null>(null);
    // Penjaga klik ganda: `disabled` baru berlaku sesudah render, klik kedua bisa lebih dulu.
    const sedangKirim = useRef(false);

    const load = useCallback(async () => {
        // Saringan yang berganti cepat tidak boleh dijawab oleh permintaan lama yang datang belakangan.
        permintaan.current?.abort();
        const ctrl = new AbortController();
        permintaan.current = ctrl;
        setStatus("memuat");
        try {
            const query = new URLSearchParams({ from, to });
            if (principal) query.set("principal", principal);
            const res = await fetch(`/api/promo-recap?${query.toString()}`, { credentials: "include", signal: ctrl.signal });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? `Data gagal dimuat (HTTP ${res.status})`);
            setData(body);
            setPilih(new Set());
            setStatus("siap");
        } catch (error) {
            if (ctrl.signal.aborted) return;
            setGalat(error instanceof Error ? error.message : "Data gagal dimuat");
            setStatus("galat");
        }
    }, [from, to, principal]);

    useEffect(() => { void load(); return () => permintaan.current?.abort(); }, [load]);

    const { calon, sudah, aturanById } = useMemo(() => {
        const web = new Set(data?.webInvoiceIds ?? []);
        const rows = (data?.recap.rows ?? []).map((row) => ({ ...row, web: web.has(row.invoiceId) }));
        return {
            calon: kelompokkan(rows.filter((row) => row.bucket === "unowned")),
            sudah: kelompokkan(rows.filter((row) => row.suratProgram === NORMALISASI)),
            aturanById: new Map((data?.aturan ?? []).map((a) => [a.id, a])),
        };
    }, [data]);

    const terpilih = (grup: Grup[]) => grup.filter((entry) => pilih.has(entry.key));
    const toggle = (key: string) => setPilih((lama) => {
        const baru = new Set(lama);
        if (baru.has(key)) baru.delete(key); else baru.add(key);
        return baru;
    });

    const barisTerpilih = terpilih(calon).flatMap((entry) => entry.rows);
    const totalTerpilih = barisTerpilih.reduce((sum, row) => sum + row.amount, 0);
    // Calon untuk pilihan saat ini; yang nilainya SAMA dengan potongannya didahulukan — itu bukti terkuat.
    const persenTerpilih = new Set(barisTerpilih.map((row) => row.percent));
    const calonAturan = (golongan ? irisan(barisTerpilih, golongan) : [])
        .map((id) => aturanById.get(id)).filter((a): a is Aturan => Boolean(a))
        .map((a) => ({ a, sama: a.benefitType === "DISC_PCT" && persenTerpilih.has(Number(a.benefitValue)) }))
        .sort((x, y) => Number(y.sama) - Number(x.sama) || x.a.suratProgram.localeCompare(y.a.suratProgram));
    const cari = cariAturan.trim().toUpperCase();
    const calonTampil = cari ? calonAturan.filter(({ a }) => `${labelAturan(a)} ${a.itemName}`.toUpperCase().includes(cari)) : calonAturan;
    const dipilih = calonAturan.find(({ a }) => String(a.id) === aturanId)?.a ?? null;

    const petunjuk = !barisTerpilih.length ? "Centang potongan di tabel yang akan dinormalisasi."
        : !golongan ? "Pilih jenis normalisasi."
            : !calonAturan.length ? (terpilih(calon).length > 1
                ? `Tidak ada satu aturan ${golongan} yang berlaku untuk semua ${terpilih(calon).length} potongan terpilih. Pilih lebih sedikit, atau tambahkan aturannya di Aturan Promo.`
                : "Tidak ada aturan promo yang berlaku untuk potongan ini. Tambahkan aturannya di Aturan Promo bila memang ada dasarnya.")
                : !dipilih ? "Pilih aturan promo yang menjadi dasar keputusan."
                    : `Dasar: ${dipilih.suratProgram}${dipilih.promoLabel ? ` — ${dipilih.promoLabel}` : ""}, beban ${dipilih.benefitBeban.toLowerCase()}.`;
    const bisaSimpan = Boolean(barisTerpilih.length && golongan && dipilih) && !busy;

    async function simpan() {
        if (!golongan || !dipilih || !barisTerpilih.length || sedangKirim.current) return;
        if (!window.confirm(`${barisTerpilih.length} potongan senilai ${rp(totalTerpilih)} akan digolongkan sebagai `
            + `${LABEL[golongan]} berdasarkan aturan ${labelAturan(dipilih)}. Lanjutkan?`)) return;
        sedangKirim.current = true;
        setBusy(true);
        setGalatSimpan("");
        try {
            const res = await fetch("/api/promo-recap/normalisasi", {
                method: "POST", credentials: "include", headers: { "content-type": "application/json" },
                body: JSON.stringify({ bucket: golongan, promoRuleId: dipilih.id, note, rows: barisTerpilih.map((row) => ({
                    lineKey: row.lineKey, positions: row.positions, amount: row.amount, percent: row.percent,
                    invoiceNo: row.invoiceNo, invoiceId: row.invoiceId, transDate: row.transDate, branchName: row.branchName,
                    customerNo: row.customerNo, itemCode: row.itemCode })) }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan");
            toast.success(`${body.disimpan} potongan dinormalisasi sebagai ${LABEL[golongan]}`);
            setNote(""); setAturanId(""); setCariAturan("");
            await load();
        } catch (error) {
            // Pilihan dibiarkan apa adanya supaya bisa langsung diperbaiki; sebabnya tetap terlihat.
            const pesan = error instanceof Error ? error.message : "Gagal menyimpan";
            setGalatSimpan(pesan);
            toast.error(pesan);
        } finally {
            sedangKirim.current = false;
            setBusy(false);
        }
    }

    async function cabut() {
        const rows = terpilih(sudah).flatMap((entry) => entry.rows);
        if (!rows.length) { toast.error("Pilih dulu normalisasi yang akan dibatalkan"); return; }
        if (sedangKirim.current || !window.confirm(`${rows.length} potongan akan kembali tak bertuan. Lanjutkan?`)) return;
        sedangKirim.current = true;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-recap/normalisasi", {
                method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
                body: JSON.stringify({ keys: rows.map((row) => ({ lineKey: row.lineKey, positions: row.positions })) }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal membatalkan");
            toast.success(`${body.dicabut} normalisasi dibatalkan`);
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal membatalkan");
        } finally {
            sedangKirim.current = false;
            setBusy(false);
        }
    }

    const totalCalon = calon.reduce((sum, grup) => sum + grup.amount, 0);
    const memuatAwal = status === "memuat" && !data;
    const fieldCls = "rounded border border-white/10 bg-black/40 px-3 py-2 text-sm disabled:opacity-50";

    const tabel = (grup: Grup[], sudahDiputuskan: boolean) => (
        <div className={`overflow-x-auto rounded-lg border border-white/10 max-h-[32rem] transition-opacity ${status === "memuat" && data ? "opacity-60" : ""}`}
            aria-busy={status === "memuat"}>
            <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-950/95 text-slate-400 backdrop-blur">
                    <tr>
                        <th className="px-3 py-2 w-8">
                            <input type="checkbox" aria-label={sudahDiputuskan ? "Pilih semua yang sudah dinormalisasi" : "Pilih semua potongan tak bertuan"}
                                checked={grup.length > 0 && grup.every((entry) => pilih.has(entry.key))}
                                disabled={!grup.length}
                                onChange={(e) => setPilih((lama) => {
                                    const baru = new Set(lama);
                                    for (const entry of grup) { if (e.target.checked) baru.add(entry.key); else baru.delete(entry.key); }
                                    return baru;
                                })} />
                        </th>
                        <th className="px-3 py-2 text-left">Faktur</th>
                        <th className="px-3 py-2 text-left">Outlet</th>
                        <th className="px-3 py-2 text-left">Posisi</th>
                        <th className="px-3 py-2 text-right">Persen</th>
                        <th className="px-3 py-2 text-left">Barang</th>
                        <th className="px-3 py-2 text-right">Nominal</th>
                        <th className="px-3 py-2 text-left">{sudahDiputuskan ? "Digolongkan" : "Sebab"}</th>
                    </tr>
                </thead>
                <tbody>
                    {grup.map((entry) => {
                        const dasar = entry.rows[0].aturanId ? aturanById.get(entry.rows[0].aturanId) : undefined;
                        const klaim = irisan(entry.rows, "principal").length;
                        const distributor = irisan(entry.rows, "distributor").length;
                        return (
                            <tr key={entry.key} className={`border-t border-white/5 align-top ${pilih.has(entry.key) ? "bg-blue-500/10" : ""}`}>
                                <td className="px-3 py-1.5">
                                    <input type="checkbox" aria-label={`Pilih ${entry.invoiceNo} posisi ${entry.positions}`} checked={pilih.has(entry.key)} onChange={() => toggle(entry.key)} />
                                </td>
                                <td className="px-3 py-1.5">
                                    <div className="font-mono text-xs">
                                        {entry.invoiceNo}
                                        {entry.rows[0].web && <span className="ml-1.5 rounded bg-blue-500/20 px-1 text-[10px] text-blue-200" title="Terbit lewat web ini">web</span>}
                                    </div>
                                    <div className="text-xs text-slate-500">{tgl(entry.transDate)}</div>
                                </td>
                                <td className="px-3 py-1.5">
                                    <div className="font-mono text-xs">{entry.customerNo}</div>
                                    <div className="text-xs text-slate-500">{entry.customerName}</div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{entry.positions === "faktur" ? "tingkat faktur" : `D${entry.positions.replaceAll("+", "+D")}`}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{entry.percent ? persen(entry.percent) : "—"}</td>
                                <td className="px-3 py-1.5 text-xs">
                                    {/* ponytail: <details> bawaan, tanpa state buka-tutup */}
                                    <details>
                                        <summary className="cursor-pointer whitespace-nowrap text-slate-300">{entry.rows.length} baris</summary>
                                        <ul className="mt-1 space-y-0.5">
                                            {entry.rows.map((row) => (
                                                <li key={row.lineKey} className="flex gap-3 whitespace-nowrap">
                                                    <span className="font-mono">{row.itemCode || "—"}</span>
                                                    <span className="text-slate-500 truncate max-w-56">{row.itemName}</span>
                                                    <span className="ml-auto tabular-nums">{rp(row.amount)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{rp(entry.amount)}</td>
                                <td className="px-3 py-1.5 text-xs max-w-md">
                                    {sudahDiputuskan ? (
                                        <>
                                            <span className="font-medium text-slate-200">{LABEL[entry.bucket as Golongan] ?? entry.bucket}</span>
                                            {dasar && <span className="text-slate-300"> · {dasar.suratProgram}{dasar.promoGroup ? ` ${dasar.promoGroup}` : ""}</span>}
                                            <div className="text-slate-500">{entry.rows[0].reason}</div>
                                        </>
                                    ) : (
                                        <>
                                            <span className="text-amber-200">{entry.reason}</span>
                                            {/* Bisa atau tidaknya diputuskan, terlihat sebelum dicentang. */}
                                            <div className="mt-0.5 text-slate-500">
                                                {klaim || distributor
                                                    ? `Aturan berlaku: ${klaim} untuk Disc Claim · ${distributor} untuk Disc Distributor`
                                                    : "Belum ada aturan promo yang berlaku"}
                                            </div>
                                        </>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                    {memuatAwal && (
                        <tr><td colSpan={8} className="px-3 py-2">
                            <LoadingState embedded rows={3} label={sudahDiputuskan ? "Memuat normalisasi" : "Memuat potongan tak bertuan"} />
                        </td></tr>
                    )}
                    {!grup.length && status === "galat" && !data && (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-red-300" role="alert">
                            Gagal memuat data: {galat}{" "}
                            <button type="button" onClick={() => void load()} className="ml-2 rounded bg-white/10 px-2 py-1 text-xs text-slate-200">Coba lagi</button>
                        </td></tr>
                    )}
                    {!grup.length && data && (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                            {sudahDiputuskan ? "Belum ada yang dinormalisasi pada periode ini." : "Tidak ada potongan tak bertuan pada periode ini."}
                        </td></tr>
                    )}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Normalisasi Diskon</h1>
                <p className="max-w-5xl text-sm text-slate-400">
                    Potongan tak bertuan pada faktur Accurate, termasuk yang terbit lewat web (bertanda <b>web</b>).
                    Satu baris = satu faktur, satu posisi. Golongkan jadi <b>Disc Claim</b> atau <b>Disc Distributor</b> dengan
                    menunjuk <b>aturan promo</b> yang berlaku untuk potongannya, supaya keluar dari tak bertuan di Rekap Promo.
                    Faktur di Accurate tidak diubah; bila fakturnya atau aturannya berubah sesudah diputuskan, keputusannya
                    otomatis tidak dipakai.
                </p>
            </header>

            <section className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-black/20 p-4" aria-label="Saringan">
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Dari</span>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldCls} />
                </label>
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Sampai</span>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldCls} />
                </label>
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Principal</span>
                    <select value={principal} onChange={(e) => setPrincipal(e.target.value)} className={fieldCls}>
                        <option value="">Semua principal</option>
                        {(data?.principals ?? []).map((nama) => <option key={nama} value={nama}>{nama}</option>)}
                    </select>
                </label>
                <button type="button" onClick={() => void load()} disabled={status === "memuat"}
                    className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-60">
                    <RefreshCw size={15} className={status === "memuat" ? "animate-spin" : ""} /> {status === "memuat" ? "Memuat…" : "Muat ulang"}
                </button>
                {status === "galat" && data && (
                    <p className="basis-full text-sm text-red-300" role="alert">
                        Gagal memuat ulang: {galat}. Tabel di bawah masih hasil pemuatan sebelumnya.
                    </p>
                )}
            </section>

            <section className="space-y-3" aria-labelledby="judul-tak-bertuan">
                <div>
                    <h2 id="judul-tak-bertuan" className="text-lg font-semibold text-white">Tak bertuan · {data ? rp(totalCalon) : "…"}</h2>
                    <p className="text-xs text-slate-500">
                        Satu baris per faktur, posisi, dan persen. Terpilih: {terpilih(calon).length} potongan · {rp(totalTerpilih)}
                    </p>
                </div>

                {/* Urutan baca = urutan keputusan: potongan (centang) -> jenis -> aturan dasar -> simpan. */}
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
                    <label className="text-sm">
                        <span className="block text-slate-400 mb-1">Jenis normalisasi</span>
                        <select value={golongan} onChange={(e) => { setGolongan(e.target.value as Golongan | ""); setAturanId(""); setGalatSimpan(""); }}
                            className={`${fieldCls} min-w-60`}>
                            <option value="">— pilih jenis —</option>
                            <option value="principal">Disc Claim (ditagihkan ke principal)</option>
                            <option value="distributor">Disc Distributor (beban sendiri)</option>
                        </select>
                    </label>
                    <div className="min-w-[min(30rem,100%)] flex-[2] text-sm">
                        <label htmlFor="aturan-dasar" className="block text-slate-400 mb-1">Aturan promo dasar</label>
                        <div className="flex gap-2">
                            {calonAturan.length > 8 && (
                                <input value={cariAturan} onChange={(e) => setCariAturan(e.target.value)} aria-label="Cari aturan promo"
                                    placeholder="Cari surat, kelompok, barang…" className={`${fieldCls} w-56`} />
                            )}
                            <select id="aturan-dasar" value={dipilih ? aturanId : ""} onChange={(e) => { setAturanId(e.target.value); setGalatSimpan(""); }}
                                disabled={!golongan || !calonAturan.length} className={`${fieldCls} w-full min-w-0`}>
                                <option value="">
                                    {!golongan ? "Pilih jenis normalisasi dulu" : calonAturan.length ? `— pilih dari ${calonAturan.length} aturan yang berlaku —` : "Tidak ada aturan yang berlaku"}
                                </option>
                                {calonTampil.map(({ a, sama }) => (
                                    <option key={a.id} value={a.id}>{labelAturan(a)}{sama ? " — nilai sama" : ""}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <label className="text-sm">
                        <span className="block text-slate-400 mb-1">Catatan (opsional)</span>
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. dasar keputusannya" maxLength={500}
                            className={`${fieldCls} min-w-56`} />
                    </label>
                    <button type="button" disabled={!bisaSimpan} onClick={() => void simpan()}
                        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40">
                        {busy ? "Menyimpan…" : golongan ? `Simpan sebagai ${LABEL[golongan]}` : "Simpan normalisasi"}
                    </button>
                    <p className={`basis-full text-xs ${galatSimpan ? "text-red-300" : barisTerpilih.length && golongan && !calonAturan.length ? "text-amber-300" : "text-slate-400"}`}
                        role={galatSimpan ? "alert" : "status"} aria-live="polite">
                        {galatSimpan ? `Tidak tersimpan: ${galatSimpan}` : petunjuk}
                    </p>
                </div>
                {tabel(calon, false)}
            </section>

            <section className="space-y-3" aria-labelledby="judul-sudah">
                <div className="flex items-end gap-3">
                    <h2 id="judul-sudah" className="text-lg font-semibold text-white">Sudah dinormalisasi</h2>
                    <button type="button" disabled={busy || !terpilih(sudah).length} onClick={() => void cabut()}
                        className="ml-auto inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                        <Undo2 size={15} /> Batalkan yang dipilih
                    </button>
                </div>
                {tabel(sudah, true)}
            </section>
        </div>
    );
}
