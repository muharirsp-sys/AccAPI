/*
 * Tujuan: Layar "Support principal" Insentif Sales (Fiori S4c, Worklist it07): support principle per salesman (GT/TT/MT) dan per
 *   SPV × principal, Status Insentif per baris, penyebut AO per baris (Target AO file), dan "hitung untuk SPV". Support dan status
 *   menjadi draf yang ditandai per baris lalu disimpan sekaligus lewat dialog; penyebut AO dan hitungan SPV tersimpan per baris lewat
 *   dialog. Kolom insentif = hasil hitung terakhir dari GET dashboard. Pengganti SupportInputSection, SpvSupportInputSection, dan
 *   SupportExcelBar di page.tsx lama (dulu di tab Dashboard SM, tidak terbuka untuk Finance).
 * Caller: app/(dashboard)/insentif-sales/support/page.tsx (default export, prop permKeys).
 * Dependensi: ./Rangka (InsentifRangka, usePeriode, useDashboard), ./data (formatRp), components/fiori/*, lib/insentif-ui,
 *   lib/insentif-sales-excel (impor dinamis), lib/rekapan-nota/ui (ambil, jamWita), sonner.
 * Main Functions: Support (default), ExcelSupport.
 * Side Effects: GET dashboard, spv-support, spv-ikut. Simpan (berurutan): POST support → POST spv-support → PATCH targets/status;
 *   per baris: PATCH targets/ao-file, PATCH spv-ikut. Semuanya MENGUBAH NOMINAL insentif periode itu. Unduh template XLSX.
 *   beforeunload selama ada draf.
 */
"use client";

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import Link from "next/link";
import { Check, Download, Pencil, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, ErrorState, FooterToolbar, MessageStrip, ResponsiveTable, Section, Skeleton, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { DEFAULT_KONSTANTA } from "@/lib/insentif-konstanta";
import type { SupportTemplateRow } from "@/lib/insentif-sales-excel";
import { HALAMAN, LABEL_STATUS, STATUS_INSENTIF_OPSI, formatQty, halamanTerlihat, readApi, sebabNol, type ApiRow } from "@/lib/insentif-ui";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { MONTH_LABELS, formatRp } from "./data";
import { InsentifRangka, useDashboard, usePeriode } from "./Rangka";

type Pasangan = { spvName: string; principle: string };
/** Isian belum disimpan per periode: support sales, status sales (kunci kode|principal), support SPV (kunci SPV|principal). */
type Draf = { support: Record<string, string>; status: Record<string, string>; spv: Record<string, string> };
type Pesan = { tone: "pos" | "info" | "warn" | "neg"; teks: string };

const DRAF_KOSONG: Draf = { support: {}, status: {}, spv: {} };
/** Izin yang membuat server menganggap akun "lihat semua" (canSeeAllInsentif) — syarat PATCH spv-ikut. */
const LIHAT_SEMUA = ["view_all", "manage", "manage_payment", "manage_hierarchy"];
const keySales = (r: { salesCode: string; principle: string }) => `${r.salesCode}|${r.principle}`;
const keySpv = (p: Pasangan) => `${p.spvName}|${p.principle}`;
/**
 * Normalisasi HARUS sama dengan pasanganKey (lib/insentif-settings) — itu yang dibandingkan server. Kode lama memakai /s+/
 * (huruf s, bukan spasi), sehingga nama dengan spasi ganda tidak pernah cocok dengan daftar server.
 */
const ikutKey = (p: Pasangan) => keySpv(p).trim().toUpperCase().replace(/\s+/g, " ");
/**
 * Isian kosong = 0 (kebijakan lama); negatif tetap dikirim dan ditolak server (AM-043). Isian bukan angka = NaN, BUKAN 0: dulu
 * `Number(x) || 0` membuatnya terkirim sebagai support Rp 0 (bayar lebih). Simpan dikunci selama ada isian NaN.
 */
const angka = (v: string) => (v.trim() === "" ? 0 : Number(v));
/**
 * Draf untuk isian number yang tidak terbaca peramban (validity.badInput, mis. "e" atau "1e"): value-nya "" sehingga tak bisa
 * dibedakan dari kosong. Disimpan sebagai penanda ini, dan input menampilkan "" lagi supaya React tidak menimpa teks yang diketik.
 * Dibaca di onInput, bukan hanya onChange: React menahan onChange bila value DOM tetap "" ("" → "e" → ""), sehingga tanpa onInput
 * "e" di isian kosong tetap terkirim sebagai 0 dan penanda tidak terhapus saat teksnya dihapus.
 */
const BUKAN_ANGKA = "bukan angka";
const isiInput = (el: HTMLInputElement) => (el.validity.badInput ? BUKAN_ANGKA : el.value);
const tampilIsi = (v: string) => (v === BUKAN_ANGKA ? "" : v);
/** id keterangan "bukan angka" per isian (aria-describedby): kunci baris berisi spasi/|, jadi dirapikan jadi id yang sah. */
const idSalah = (jenis: string, kunci: string) => `salah-${jenis}-${kunci.replace(/[^A-Za-z0-9_-]/g, "_")}`;
const tanpa = (o: Record<string, string>, keys: string[]) => { const n = { ...o }; for (const x of keys) delete n[x]; return n; };
const isiDraf = (d: Draf) => Object.keys(d.support).length + Object.keys(d.status).length + Object.keys(d.spv).length;
const statusLama = (r: ApiRow) => r.statusInsentif ?? "distributor_principle";
const labelStatus = (s: string) => LABEL_STATUS[s] ?? s;
/** "HTTP 500" mentah tidak tampil (aturan 5 brief); pesan server tetap. */
const sebabMuat = (e?: string) => (e && !/^HTTP \d+$/.test(e) ? e : "Server tidak memberi jawaban yang valid.");

/** Akibat tiap Status Insentif (pesan konfirmasi lama): efeknya bukan cuma baris itu. */
const EFEK_STATUS: Record<string, string> = {
    principle: "Principle: insentif baris itu jadi Rp 0 dan keluar dari penyebut mix, sehingga nominal principal LAIN pada salesman yang sama ikut naik.",
    distributor: "Distributor: support principle diabaikan untuk baris itu — distributor bayar penuh.",
    distributor_principle: "Distributor + Principle: baris itu ikut skema dan support principle dikurangkan dari pool.",
};

/** Server MENJAWAB menolak: endpoint memvalidasi seluruh payload sebelum menulis, jadi tidak ada yang berubah. */
class Ditolak extends Error {}
/** Tanpa jawaban (jaringan putus): permintaan mungkin sudah sampai dan tertulis — hasilnya tidak pasti. */
const PUTUS = "Koneksi ke server terputus sebelum ada jawaban; hasilnya tidak pasti — muat ulang untuk memeriksa sebelum menyimpan lagi.";

async function kirim(url: string, method: "POST" | "PATCH", body: unknown, cadangan: string) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .catch(() => { throw new Error(PUTUS); });
    const data = await readApi(res).catch(() => ({} as Record<string, unknown>));
    if (!res.ok) throw new Ditolak(typeof data.error === "string" ? data.error : cadangan);
    return data;
}

/**
 * Support principle: unduh template terisi + unggah Excel. SM mengisi support untuk ratusan pasangan sales/SPV x principal; mengetiknya
 * satu per satu di layar itu sumber salah ketik, dan support memotong pool insentif — salah angka = salah bayar. Template sengaja SUDAH
 * berisi pasangan periode itu beserta nilai tersimpan, jadi yang diketik hanya kolom nominal. Hasil unggah masuk ke DRAF, bukan langsung
 * ditulis: angkanya tetap terlihat di tabel lalu disimpan lewat jalur validasi yang sama.
 */
function ExcelSupport({ kind, templateRows, fileName, knownKeys, disabledReason, onLoaded, onPesan }: {
    kind: "sales" | "spv"; templateRows: SupportTemplateRow[]; fileName: string; knownKeys: Set<string>; disabledReason?: string;
    onLoaded: (values: Record<string, string>) => void; onPesan: (p: Pesan) => void;
}) {
    const [busy, setBusy] = useState(false);
    const berkas = useRef<HTMLInputElement>(null);
    const apa = kind === "sales" ? "sales" : "SPV";

    async function unduh() {
        setBusy(true);
        try {
            const { generateSupportTemplate } = await import("@/lib/insentif-sales-excel");
            const data = generateSupportTemplate(kind, templateRows);
            const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            onPesan({ tone: "neg", teks: `Template support ${apa} gagal dibuat: ${e instanceof Error ? e.message : String(e)}` });
        }
        setBusy(false);
    }

    async function unggah(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true);
        try {
            const { parseSupportExcel } = await import("@/lib/insentif-sales-excel");
            const parsed = parseSupportExcel(await file.arrayBuffer(), kind);
            // Nominal tidak masuk akal ditolak SEBELUM apa pun terisi. Nol itu sah (mencabut support; sel kosong atau "-"), negatif
            // tidak — dan diam-diam membulatkannya ke 0 akan membayar lebih. Hanya baris periode ini yang diperiksa: baris yang memang
            // dilewati (tidak ada di periode) tidak ditulis, jadi angkanya tidak boleh membatalkan impor (sama dengan progres).
            const bad = parsed.filter((r) => knownKeys.has(`${r.key}|${r.principle}`) && (!Number.isFinite(r.supportAmount) || r.supportAmount < 0));
            if (bad.length) {
                onPesan({ tone: "neg", teks: `${bad.length} baris di Excel support ${apa} bernilai tidak valid (mis. ${bad[0].key}/${bad[0].principle}). Tidak ada yang diisi.` });
                return;
            }
            const values: Record<string, string> = {};
            const unknown: string[] = [];
            for (const r of parsed) {
                const k = `${r.key}|${r.principle}`;
                if (knownKeys.has(k)) values[k] = String(r.supportAmount);
                else unknown.push(k);
            }
            if (Object.keys(values).length === 0) {
                onPesan({ tone: "neg", teks: `Tidak ada baris Excel support ${apa} yang cocok dengan periode ini. Cek kolom kunci dan Principal, atau unduh templatenya dulu.` });
                return;
            }
            onLoaded(values);
            onPesan({
                tone: "info",
                teks: `${Object.keys(values).length} baris support ${apa} terisi dari Excel sebagai draf — periksa lalu Simpan & hitung ulang.`
                    + (unknown.length ? ` ${unknown.length} baris dilewati (tidak ada di periode ini).` : ""),
            });
        } catch (err) {
            onPesan({ tone: "neg", teks: `Excel support ${apa} gagal dibaca: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
            setBusy(false);
            e.target.value = "";
        }
    }

    return (
        <>
            <Button icon={<Download className="fi-icon" aria-hidden />} busy={busy} aria-label={`Unduh template support ${apa}`} onClick={() => void unduh()}>Unduh template</Button>
            <Button icon={<Upload className="fi-icon" aria-hidden />} disabled={busy || Boolean(disabledReason)} disabledReason={disabledReason}
                aria-label={`Unggah Excel support ${apa}`} onClick={() => berkas.current?.click()}>Unggah Excel</Button>
            <input ref={berkas} type="file" accept=".xlsx,.xls" hidden aria-label={`Berkas Excel support ${apa}`} onChange={(e) => void unggah(e)} />
        </>
    );
}

export default function Support({ permKeys }: { permKeys: string[] }) {
    const { month, year, principle, branch, ubah, bawa, label } = usePeriode();
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    const izinSupport = perms.has("insentif_sales.input_support");
    const izinTarget = perms.has("insentif_sales.upload_target");
    const izinLihatSemua = LIHAT_SEMUA.some((x) => perms.has(`insentif_sales.${x}`));
    const hrefData = halamanTerlihat(perms).some((h) => h.key === "data") ? `${HALAMAN.find((h) => h.key === "data")!.href}${bawa}` : undefined;

    const [dash, muatDash] = useDashboard({ month, year, principle, branch });
    const [spvLoad, muatSpvSup] = useLoad(useCallback(() => ambil(`/api/insentif-sales/spv-support?month=${month}&year=${year}`, (j) => {
        const map: Record<string, number> = {};
        for (const r of (j as { rows?: Array<Pasangan & { supportAmount: number }> }).rows ?? []) map[keySpv(r)] = r.supportAmount;
        return map;
    }), [month, year]));
    const [ikutLoad, muatIkut] = useLoad(useCallback(() => ambil(`/api/insentif-sales/spv-ikut?month=${month}&year=${year}`,
        (j) => new Set<string>((j as { ikut?: string[] }).ikut ?? [])), [month, year]));

    const d = dash.data;
    const k = d?.konstanta ?? DEFAULT_KONSTANTA;
    const apiRows = useMemo(() => d?.rows ?? [], [d]);
    // MT juga perlu: computeMt mengurangi support dari pool sama seperti GT, jadi baris MT harus bisa diisi — kalau tidak, support
    // principle utk sales MT tak pernah masuk.
    const gtRows = useMemo(() => apiRows.filter((r) => r.channel === "GT" || r.channel === "TT" || r.channel === "MT"), [apiRows]);
    const pairs = useMemo(() => {
        const seen = new Map<string, Pasangan>();
        for (const r of apiRows) {
            if (!r.spvName) continue;
            const p = { spvName: r.spvName, principle: r.principle };
            if (!seen.has(keySpv(p))) seen.set(keySpv(p), p);
        }
        return [...seen.values()].sort((a, b) => a.spvName.localeCompare(b.spvName) || a.principle.localeCompare(b.principle));
    }, [apiRows]);
    // Tombol "hitung untuk SPV" hanya bermakna kalau SEMUA sales bawahan pasangan ini "principle" — kalau ada satu saja yang distributor,
    // principal itu sudah dihitung untuk SPV tanpa tombol.
    const semuaPrinciple = useMemo(() => {
        const status = new Map<string, boolean>();
        for (const r of apiRows) {
            if (!r.spvName) continue;
            const key = keySpv({ spvName: r.spvName, principle: r.principle });
            status.set(key, (status.get(key) ?? true) && r.statusInsentif === "principle");
        }
        return status;
    }, [apiRows]);
    const ikut = useMemo(() => ikutLoad.data ?? new Set<string>(), [ikutLoad.data]);
    const savedSpv = spvLoad.data;

    // Draf per periode: pindah bulan tidak membuang isian dan tidak membawanya ke periode lain (kuncinya sama antarbulan).
    const periode = `${year}-${month}`;
    const [drafSemua, setDrafSemua] = useState<Record<string, Draf>>({});
    const draf = drafSemua[periode] ?? DRAF_KOSONG;
    const ubahDraf = (f: (x: Draf) => Draf) => setDrafSemua((a) => ({ ...a, [periode]: f(a[periode] ?? DRAF_KOSONG) }));

    const nilaiSupport = (r: ApiRow) => draf.support[keySales(r)] ?? String(r.support ?? 0);
    const nilaiStatus = (r: ApiRow) => draf.status[keySales(r)] ?? statusLama(r);
    const nilaiSpv = (p: Pasangan) => draf.spv[keySpv(p)] ?? String(savedSpv?.[keySpv(p)] ?? 0);
    const supportBerubah = (r: ApiRow) => draf.support[keySales(r)] !== undefined && angka(draf.support[keySales(r)]) !== (r.support ?? 0);
    const statusBerubah = (r: ApiRow) => nilaiStatus(r) !== statusLama(r);
    const spvBerubah = (p: Pasangan) => savedSpv !== undefined && draf.spv[keySpv(p)] !== undefined && angka(draf.spv[keySpv(p)]) !== (savedSpv[keySpv(p)] ?? 0);

    const ubahSupport = gtRows.filter(supportBerubah);
    const ubahStatus = gtRows.filter(statusBerubah);
    const ubahSpv = pairs.filter(spvBerubah);
    const ubahSales = gtRows.filter((r) => supportBerubah(r) || statusBerubah(r));
    const nPerubahan = ubahSupport.length + ubahStatus.length + ubahSpv.length;
    const nBaris = ubahSales.length + ubahSpv.length;
    // Draf di baris yang sedang disembunyikan saringan TIDAK ikut terkirim (payload = baris yang dimuat) — disebut, bukan dibuang diam-diam.
    const kunciSales = new Set(gtRows.map(keySales));
    const kunciSpv = new Set(pairs.map(keySpv));
    const drafTersembunyi = Object.keys(draf.support).filter((x) => !kunciSales.has(x)).length
        + Object.keys(draf.status).filter((x) => !kunciSales.has(x)).length + Object.keys(draf.spv).filter((x) => !kunciSpv.has(x)).length;
    const periodeLain = Object.entries(drafSemua).filter(([p, x]) => p !== periode && isiDraf(x) > 0).map(([p]) => p.split("-").map(Number));
    useUnsavedGuard(nPerubahan > 0 || drafTersembunyi > 0 || periodeLain.length > 0);

    const memuat = dash.status === "memuat";
    const tunggu = "Menunggu data selesai dimuat";
    const kunciIsiSupport = !izinSupport ? "Butuh izin isi support" : memuat ? tunggu : undefined;
    const kunciIsiStatus = !izinTarget ? "Butuh izin unggah target" : memuat ? tunggu : undefined;
    const kunciIsiSpv = !izinSupport ? "Butuh izin isi support" : memuat || spvLoad.status === "memuat" ? tunggu : undefined;
    const kunciIkut = !izinTarget || !izinLihatSemua ? "Hanya admin/Finance dengan izin unggah target yang boleh mengubah hitungan principal SPV"
        : ikutLoad.status === "galat" && !ikutLoad.data ? "Status hitungan SPV belum berhasil dimuat"
            : memuat || ikutLoad.status === "memuat" ? tunggu : undefined;
    const isianSalah = gtRows.filter((r) => Number.isNaN(angka(nilaiSupport(r)))).length + pairs.filter((p) => Number.isNaN(angka(nilaiSpv(p)))).length;
    const alasanSimpan = nPerubahan === 0 ? "Belum ada perubahan"
        : isianSalah ? `${isianSalah} isian support bukan angka — perbaiki atau kosongkan (= Rp 0) dulu`
            : memuat || spvLoad.status === "memuat" ? tunggu : undefined;

    const [dlgSimpan, setDlgSimpan] = useState(false);
    const [dlgAo, setDlgAo] = useState<ApiRow | null>(null);
    const [dlgIkut, setDlgIkut] = useState<Pasangan | null>(null);
    const [pesan, setPesan] = useState<Pesan | null>(null);

    /**
     * Satu simpan untuk semua draf periode ini, berurutan: support sales → support SPV → status. Ketiga endpoint memvalidasi SELURUH
     * payload sebelum menulis (AM-043), jadi angka support tidak valid ditolak di langkah pertama dan tidak ada yang berubah. Payload
     * tiap langkah sama dengan tombol lama: support = semua baris yang dimuat (bukan hanya yang berubah), status = baris yang berubah
     * (endpoint status menerima daftar dan menulisnya dalam satu transaksi).
     * Status dulu tersimpan langsung per baris karena draf menampilkan status baru di sebelah nominal dari status LAMA; kini barisnya
     * ditandai "diubah" + nilai sebelumnya, dan kolom insentif berlabel hitung terakhir.
     */
    async function simpan() {
        const n = nPerubahan;
        const tersimpan: string[] = [];
        let tidakDitemukan = 0;
        try {
            if (ubahSupport.length) {
                const data = await kirim("/api/insentif-sales/support", "POST", gtRows.map((r) => ({
                    salesCode: r.salesCode, principle: r.principle,
                    periodMonth: month, periodYear: year,
                    supportAmount: angka(nilaiSupport(r)),
                })), "Gagal simpan support");
                tersimpan.push(`support sales (${String(data.upserted ?? gtRows.length)} baris)`);
                ubahDraf((x) => ({ ...x, support: tanpa(x.support, [...kunciSales]) }));
            }
            if (ubahSpv.length) {
                const data = await kirim("/api/insentif-sales/spv-support", "POST", pairs.map((p) => ({
                    spvName: p.spvName, principle: p.principle,
                    periodMonth: month, periodYear: year,
                    supportAmount: angka(nilaiSpv(p)),
                })), "Gagal simpan support SPV");
                tersimpan.push(`support SPV (${String(data.upserted ?? pairs.length)} baris)`);
                ubahDraf((x) => ({ ...x, spv: tanpa(x.spv, [...kunciSpv]) }));
            }
            if (ubahStatus.length) {
                const data = await kirim("/api/insentif-sales/targets/status", "PATCH", ubahStatus.map((r) => ({
                    salesCode: r.salesCode, principle: r.principle,
                    periodMonth: month, periodYear: year, statusInsentif: nilaiStatus(r),
                })), "Gagal mengubah status.");
                tidakDitemukan = Number(data.tidakDitemukan ?? 0);
                tersimpan.push(`status (${ubahStatus.length} baris)`);
                ubahDraf((x) => ({ ...x, status: tanpa(x.status, [...kunciSales]) }));
            }
        } catch (e) {
            const ditolak = e instanceof Ditolak;
            const sebab = e instanceof Error ? e.message : "Gagal menyimpan.";
            const sudah = tersimpan.length ? ` Yang sudah tersimpan: ${tersimpan.join(", ")}.` : "";
            // Hanya penolakan server yang pasti "tidak ada yang diubah"; tanpa jawaban, langkah terakhir mungkin tertulis.
            const teks = ditolak
                ? (tersimpan.length ? `${sebab}${sudah} Sisanya tetap draf.` : `${sebab} Tidak ada yang diubah.`)
                : `${sebab}${sudah} Isian tetap draf sampai Anda memeriksanya.`;
            if (tersimpan.length || !ditolak) { muatDash(); muatSpvSup(); }
            setPesan({ tone: "neg", teks });
            throw new Error(teks);
        }
        setDlgSimpan(false);
        setPesan(tidakDitemukan > 0
            ? { tone: "warn", teks: `Tersimpan ${jamWita(new Date())}, tetapi ${tidakDitemukan} baris tidak punya target periode ini — statusnya tidak tersimpan. Insentif ${label} dihitung ulang.` }
            : { tone: "pos", teks: `${n} perubahan tersimpan ${jamWita(new Date())}; insentif ${label} dihitung ulang.` });
        toast.success("Support tersimpan, dihitung ulang");
        muatDash();
        if (ubahSpv.length) muatSpvSup();
    }

    /** Tombol per baris: AO baris GT/TT dinilai terhadap Target AO di file target, bukan ambang tetap. Hanya periode yang dibuka. */
    async function gantiAo(r: ApiRow) {
        const pakaiFile = !r.aoFile;
        const ke = formatQty(pakaiFile ? r.target.ao : k.gt.aoAmbang);
        await kirim("/api/insentif-sales/targets/ao-file", "PATCH",
            { salesCode: r.salesCode, principle: r.principle, periodMonth: month, periodYear: year, pakaiFile }, "Gagal mengubah ambang AO.");
        setDlgAo(null);
        setPesan({ tone: "pos", teks: `AO ${r.salesCode}/${r.principle} → ÷ ${ke}. Insentif dihitung ulang.` });
        muatDash();
    }

    /**
     * Principal yang semua sales-nya dibayar principal, tapi SPV-nya tetap dibayar distributor (VINDA Agustus 2026). Menaikkan jumlah
     * principal SPV → rate per principal ikut berubah.
     */
    async function gantiIkut(p: Pasangan) {
        const nyala = !ikut.has(ikutKey(p));
        await kirim("/api/insentif-sales/spv-ikut", "PATCH",
            { spvName: p.spvName, principle: p.principle, periodMonth: month, periodYear: year, ikut: nyala }, "Gagal mengubah hitungan SPV.");
        setDlgIkut(null);
        setPesan({ tone: "pos", teks: `${p.spvName} / ${p.principle}: ${nyala ? "ikut dihitung" : "dikeluarkan"}. Insentif SPV dihitung ulang.` });
        muatSpvSup(); muatIkut(); muatDash();
    }

    // ── Sel ──────────────────────────────────────────────────────────────────
    const diubah = <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />diubah</span>;
    const sebelumnya = (teks: string) => <span className="fi-sub fi-why">sebelumnya {teks}</span>;
    const selStatus = (r: ApiRow) => (
        <>
            <select className="fi-input" aria-label={`Status insentif ${r.salesCode} ${r.principle}`} value={nilaiStatus(r)} disabled={Boolean(kunciIsiStatus)} title={kunciIsiStatus}
                onChange={(e) => { const v = e.target.value; ubahDraf((x) => ({ ...x, status: { ...x.status, [keySales(r)]: v } })); }}>
                {STATUS_INSENTIF_OPSI.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {statusBerubah(r) && sebelumnya(labelStatus(statusLama(r)))}
        </>
    );
    const ketikSupport = (r: ApiRow, el: HTMLInputElement) => { const v = isiInput(el); ubahDraf((x) => ({ ...x, support: { ...x.support, [keySales(r)]: v } })); };
    const isiSupport = (r: ApiRow) => (
        <>
            <input type="number" min={0} inputMode="numeric" className="fi-input fi-cellin fi-tnum" aria-label={`Support ${r.salesCode} ${r.principle}`}
                value={tampilIsi(nilaiSupport(r))} disabled={Boolean(kunciIsiSupport)} title={kunciIsiSupport} aria-invalid={Number.isNaN(angka(nilaiSupport(r))) || undefined}
                aria-describedby={Number.isNaN(angka(nilaiSupport(r))) ? idSalah("sup", keySales(r)) : undefined}
                onChange={(e) => ketikSupport(r, e.currentTarget)} onInput={(e) => ketikSupport(r, e.currentTarget)} />
            {Number.isNaN(angka(nilaiSupport(r))) && <span id={idSalah("sup", keySales(r))} className="fi-sub fi-why">bukan angka</span>}
            {supportBerubah(r) && sebelumnya(formatRp(r.support ?? 0))}
        </>
    );
    const penyebutAo = (r: ApiRow) => (
        <>
            <span className="fi-tnum">÷ {formatQty(r.ambangAo)}</span>
            {r.channel === "MT" ? <span className="fi-sub">target baris</span>
                : !(r.target.ao > 0) ? <span className="fi-sub">Target AO file kosong</span>
                    : !r.aoFile && r.ambangAo === r.target.ao ? <span className="fi-sub">sudah = target file</span>
                        : (
                            <Button variant="tertiary" aria-pressed={r.aoFile} disabled={Boolean(kunciIsiStatus)} disabledReason={kunciIsiStatus} onClick={() => setDlgAo(r)}
                                aria-label={`${r.aoFile ? `Kembali ke ${formatQty(k.gt.aoAmbang)}` : `Pakai target file (${formatQty(r.target.ao)})`} untuk ${r.salesCode} ${r.principle}…`}>
                                {r.aoFile ? `Kembali ke ${formatQty(k.gt.aoAmbang)}…` : `Pakai target file (${formatQty(r.target.ao)})…`}
                            </Button>
                        )}
        </>
    );
    const insentif = (r: ApiRow) => { const s = sebabNol(r, k); return <><b>{formatRp(r.incentive.total)}</b>{s && <span className="fi-sub">{s}</span>}</>; };
    const ketikSpv = (p: Pasangan, el: HTMLInputElement) => { const v = isiInput(el); ubahDraf((x) => ({ ...x, spv: { ...x.spv, [keySpv(p)]: v } })); };
    const isiSpv = (p: Pasangan) => (
        <>
            <input type="number" min={0} inputMode="numeric" className="fi-input fi-cellin fi-tnum" aria-label={`Support SPV ${p.spvName} ${p.principle}`}
                value={tampilIsi(nilaiSpv(p))} disabled={Boolean(kunciIsiSpv)} title={kunciIsiSpv} aria-invalid={Number.isNaN(angka(nilaiSpv(p))) || undefined}
                aria-describedby={Number.isNaN(angka(nilaiSpv(p))) ? idSalah("spv", keySpv(p)) : undefined}
                onChange={(e) => ketikSpv(p, e.currentTarget)} onInput={(e) => ketikSpv(p, e.currentTarget)} />
            {Number.isNaN(angka(nilaiSpv(p))) && <span id={idSalah("spv", keySpv(p))} className="fi-sub fi-why">bukan angka</span>}
            {spvBerubah(p) && sebelumnya(formatRp(savedSpv?.[keySpv(p)] ?? 0))}
        </>
    );
    const tombolIkut = (p: Pasangan) => {
        const on = ikut.has(ikutKey(p));
        if (!semuaPrinciple.get(keySpv(p)) && !on) return <span className="fi-small fi-subtle">Otomatis (ada sales Distributor)</span>;
        return (
            <Button variant="secondary" aria-pressed={on} icon={on ? <Check className="fi-icon" aria-hidden /> : undefined} disabled={Boolean(kunciIkut)} disabledReason={kunciIkut}
                title="Semua sales pasangan ini berstatus Principle, jadi principal ini tidak dihitung untuk SPV kecuali tombol ini dinyalakan."
                aria-label={`${on ? "Dihitung untuk SPV" : "Hitung untuk SPV"}: ${p.principle} untuk ${p.spvName} walau sales-nya Principle…`}
                onClick={() => setDlgIkut(p)}>
                {on ? "Dihitung untuk SPV…" : "Sales Principle · hitung untuk SPV…"}
            </Button>
        );
    };

    const kolomSales: Column<ApiRow>[] = [
        { key: "sales", header: "Salesman", cell: (r) => <><span className="fi-mono">{r.salesCode}</span>{(supportBerubah(r) || statusBerubah(r)) && <> {diubah}</>}<span className="fi-sub">{r.salesName}</span></> },
        { key: "principal", header: "Principal", cell: (r) => r.principle },
        { key: "tipe", header: "Tipe", secondary: true, cell: (r) => r.tipeSales ?? "-" },
        { key: "status", header: "Status insentif", cell: selStatus },
        { key: "ao", header: "Penyebut AO", cell: penyebutAo },
        { key: "support", header: "Support (Rp)", align: "end", cell: isiSupport },
        { key: "insentif", header: "Insentif (hitung terakhir)", align: "end", cell: insentif },
    ];
    const kolomSpv: Column<Pasangan>[] = [
        { key: "spv", header: "SPV", cell: (p) => <><b>{p.spvName}</b>{spvBerubah(p) && <> {diubah}</>}</> },
        { key: "principal", header: "Principal", cell: (p) => p.principle },
        { key: "support", header: "Support (Rp)", align: "end", cell: isiSpv },
        { key: "ikut", header: "Dihitung untuk SPV", cell: tombolIkut },
    ];
    const ponselSales = (r: ApiRow) => (
        <div className="grid gap-2 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
                <span><span className="fi-mono">{r.salesCode}</span>{(supportBerubah(r) || statusBerubah(r)) && <> {diubah}</>}<span className="fi-sub">{r.salesName} · {r.principle} · {r.tipeSales ?? "-"}</span></span>
                <span className="text-right">{insentif(r)}</span>
            </div>
            <label className="fi-field"><span className="fi-label">Status insentif</span>{selStatus(r)}</label>
            <label className="fi-field"><span className="fi-label">Support (Rp)</span>{isiSupport(r)}</label>
            <div className="fi-small">Penyebut AO {penyebutAo(r)}</div>
        </div>
    );
    const ponselSpv = (p: Pasangan) => (
        <div className="grid gap-2 px-4 py-3">
            <span><b>{p.spvName}</b> · {p.principle}{spvBerubah(p) && <> {diubah}</>}</span>
            <label className="fi-field"><span className="fi-label">Support (Rp)</span>{isiSpv(p)}</label>
            <div>{tombolIkut(p)}</div>
        </div>
    );

    // ── Isi halaman ──────────────────────────────────────────────────────────
    const saringanAktif = principle !== "ALL" || branch !== "ALL";
    const hapusSaringan = () => ubah({ principle: "ALL", branch: "ALL" });
    const terisi = gtRows.filter((r) => angka(nilaiSupport(r)) > 0).length;
    const terisiSpv = pairs.filter((p) => angka(nilaiSpv(p)) > 0).length;
    let isi: ReactNode;
    if (!d && dash.status === "galat") {
        isi = <ErrorState title={dash.error} message="Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid." onRetry={muatDash} />;
    } else if (!d) {
        isi = <Skeleton rows={6} label="Memuat baris support" />;
    } else if (apiRows.length === 0) {
        isi = d.cakupan.dibatasi && !d.cakupan.jumlahKode
            ? <EmptyState title="Belum ada salesman dalam cakupan Anda" message={`Identitas hierarki Anda: ${d.cakupan.identitas?.role?.toUpperCase() ?? "-"} "${d.cakupan.identitas?.name ?? "belum diisi"}". Tidak ada kode sales yang cocok untuk periode ini.`} />
            : saringanAktif
                ? <EmptyState title="Tidak ada baris support untuk saringan ini" message="Ubah principal atau cabang, lalu periksa kembali hasilnya." action={<Button onClick={hapusSaringan}>Hapus saringan</Button>} />
                : <EmptyState title={`Target ${label} belum diunggah`} message="Support diisi per baris target, jadi belum ada baris support. Unggah target di Data periode, lalu kembali ke sini."
                    action={hrefData ? <Link className="fi-btn fi-btn--primary" href={hrefData}>Buka Data periode</Link> : undefined} />;
    } else {
        isi = (
            <>
                <Section title="Support sales" subtitle={`${gtRows.length} baris · ${terisi} bersupport · support memotong pool insentif sebelum persentase pencapaian dikalikan`}
                    actions={
                        <ExcelSupport kind="sales" fileName={`support_sales_${month}_${year}.xlsx`} knownKeys={kunciSales} disabledReason={kunciIsiSupport} onPesan={setPesan}
                            templateRows={gtRows.map((r) => ({ key: r.salesCode, label: r.salesName, principle: r.principle, supportAmount: Number(nilaiSupport(r)) || 0 }))}
                            onLoaded={(values) => ubahDraf((x) => ({ ...x, support: { ...x.support, ...values } }))} />
                    }>
                    <ResponsiveTable<ApiRow> title="Support sales" columns={kolomSales} rows={gtRows} rowKey={keySales} mobileItem={ponselSales}
                        status={dash.status} error={dash.error} onRetry={muatDash}
                        empty={{ title: "Tidak ada baris GT, TT, atau MT", message: "Support hanya diisi untuk baris berchannel GT, TT, atau MT." }} />
                </Section>
                <Section title="Support SPV"
                    subtitle={savedSpv ? `${pairs.length} pasangan · ${terisiSpv} bersupport · support yang menutup penuh rate mengeluarkan principal itu dari hitungan SPV: rate per principal naik dan principal itu tidak dibayar distributor` : "per SPV × principal"}
                    actions={savedSpv && pairs.length > 0 ? (
                        <ExcelSupport kind="spv" fileName={`support_spv_${month}_${year}.xlsx`} knownKeys={kunciSpv} disabledReason={kunciIsiSpv} onPesan={setPesan}
                            templateRows={pairs.map((p) => ({ key: p.spvName, principle: p.principle, supportAmount: Number(nilaiSpv(p)) || 0 }))}
                            onLoaded={(values) => ubahDraf((x) => ({ ...x, spv: { ...x.spv, ...values } }))} />
                    ) : undefined}>
                    {ikutLoad.status === "galat" && (
                        <div className="fi-sect-in">
                            <MessageStrip tone="neg" title="Status “hitung untuk SPV” belum berhasil dimuat.">
                                {sebabMuat(ikutLoad.error)} Tombolnya dikunci sampai statusnya terbaca.{" "}
                                <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatIkut}>Coba lagi</button>
                            </MessageStrip>
                        </div>
                    )}
                    {!savedSpv && spvLoad.status === "galat" ? (
                        // Galat bukan nol: menampilkan isian 0 di sini lalu menyimpan akan menimpa support SPV yang sebenarnya.
                        <ErrorState title="Support SPV belum berhasil dimuat." message={`${sebabMuat(spvLoad.error)} Isian tidak ditampilkan agar nilai tersimpan tidak tertimpa nol.`} onRetry={muatSpvSup} />
                    ) : !savedSpv ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat support SPV" /></div>
                        : (
                            <ResponsiveTable<Pasangan> title="Support SPV" columns={kolomSpv} rows={pairs} rowKey={keySpv} mobileItem={ponselSpv}
                                status={spvLoad.status} error={spvLoad.error ? sebabMuat(spvLoad.error) : undefined} onRetry={muatSpvSup}
                                empty={{ title: "Belum ada pasangan SPV × principal", message: "Kolom SPV di baris target periode ini kosong." }} />
                        )}
                </Section>
            </>
        );
    }

    const daftarUbah: Array<[string, ReactNode]> = [
        ...ubahSales.map((r): [string, ReactNode] => [`${r.salesCode} · ${r.principle}`, [
            statusBerubah(r) ? `Status ${labelStatus(statusLama(r))} → ${labelStatus(nilaiStatus(r))}` : "",
            supportBerubah(r) ? `Support ${formatRp(r.support ?? 0)} → ${formatRp(angka(nilaiSupport(r)))}` : "",
        ].filter(Boolean).join(" · ")]),
        ...ubahSpv.map((p): [string, ReactNode] => [`SPV ${p.spvName} · ${p.principle}`, `Support ${formatRp(savedSpv?.[keySpv(p)] ?? 0)} → ${formatRp(angka(nilaiSpv(p)))}`]),
    ];
    const efek = [...new Set(ubahStatus.map((r) => EFEK_STATUS[nilaiStatus(r)]).filter(Boolean))];
    const dikirim = [
        ubahSupport.length ? `support sales ${gtRows.length} baris yang dimuat (yang tidak berubah ikut dikirim ulang)` : "",
        ubahSpv.length ? `support SPV ${pairs.length} pasangan` : "",
        ubahStatus.length ? `status ${ubahStatus.length} baris` : "",
    ].filter(Boolean).join("; ");
    const ao = dlgAo;
    const nyala = dlgIkut ? !ikut.has(ikutKey(dlgIkut)) : false;

    return (
        <InsentifRangka
            halaman="support"
            permKeys={permKeys}
            deskripsi="Support yang ditanggung principal memotong insentif sales dan SPV. Support dan status disimpan sekaligus; penyebut AO dan hitungan SPV tersimpan per baris."
            saringan={{ principals: dengan(d?.opsiFilter.principles ?? [], principle), branches: dengan(d?.opsiFilter.branches ?? [], branch) }}
            aksi={
                <>
                    {nPerubahan > 0 && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum disimpan</span>}
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={memuat && Boolean(d)} onClick={() => { muatDash(); muatSpvSup(); muatIkut(); }}>Muat ulang</Button>
                </>
            }
        >
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            {dash.status === "galat" && d && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {dash.error} Yang tampil adalah hasil sebelumnya.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatDash}>Coba lagi</button>
                </MessageStrip>
            )}
            {periodeLain.length > 0 && (
                <MessageStrip tone="info" title="Ada perubahan belum disimpan di periode lain:">
                    {periodeLain.map(([y, m], i) => (
                        <span key={`${y}-${m}`}>{i > 0 && ", "}
                            <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => ubah({ year: String(y), month: String(m) })}>{MONTH_LABELS[m - 1]} {y}</button>
                        </span>
                    ))}
                </MessageStrip>
            )}
            {drafTersembunyi > 0 && (
                <MessageStrip tone="info" title={`${drafTersembunyi} isian draf ada di baris yang tersembunyi saringan dan belum ikut disimpan.`}>
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={hapusSaringan}>Hapus saringan</button>
                </MessageStrip>
            )}
            {isi}
            {d && apiRows.length > 0 && (
                <FooterToolbar message={nPerubahan > 0 ? <span className="fi-sum"><b>{nPerubahan} perubahan</b> di {nBaris} baris belum disimpan</span> : alasanSimpan}>
                    {nPerubahan > 0 && <Button variant="tertiary" onClick={() => ubahDraf(() => DRAF_KOSONG)}>Batalkan perubahan</Button>}
                    <Button variant="primary" disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={() => setDlgSimpan(true)}>Simpan &amp; hitung ulang…</Button>
                </FooterToolbar>
            )}

            <ConfirmDialog
                open={dlgSimpan}
                onClose={() => setDlgSimpan(false)}
                title={`Simpan ${nPerubahan} perubahan dan hitung ulang ${label}?`}
                tag="Support"
                confirmLabel="Simpan & hitung ulang"
                confirmDisabled={alasanSimpan}
                description={efek.length > 0 ? <ul className="grid gap-1">{efek.map((x) => <li key={x}>{x}</li>)}</ul> : undefined}
                facts={[
                    ...daftarUbah.slice(0, 8),
                    ...(daftarUbah.length > 8 ? [["Lainnya", `${daftarUbah.length - 8} baris lagi`] as [string, ReactNode]] : []),
                    ["Dikirim", dikirim],
                    ["Bila ditolak", "Server memeriksa seluruh angka sebelum menulis; langkah yang ditolak tidak mengubah apa pun dan isiannya tetap draf."],
                    ["Akibat", `Insentif ${label} dihitung ulang. Pembayaran yang sudah lunas tetap memakai nominal yang dibayar; selisihnya ditandai di Pembayaran.`],
                ]}
                onConfirm={simpan}
            >
                <VariantNote bl="BL-33">
                    Hari ini server menyimpan nilai terakhir dan pengisinya saja. Bila BL-33 masuk, setiap perubahan support dan status tercatat di
                    riwayat dengan nilai lama dan baru.
                </VariantNote>
            </ConfirmDialog>

            <ConfirmDialog
                open={ao !== null}
                onClose={() => setDlgAo(null)}
                title={ao ? `Nilai AO ${ao.salesCode} / ${ao.principle} terhadap ${ao.aoFile ? "ambang tetap" : "Target AO file"}?` : ""}
                tag="Penyebut AO"
                confirmLabel={ao?.aoFile ? `Kembali ke ${formatQty(k.gt.aoAmbang)}` : "Pakai target file"}
                facts={ao ? [
                    ["Penyebut AO", `÷ ${formatQty(ao.ambangAo)} → ÷ ${formatQty(ao.aoFile ? k.gt.aoAmbang : ao.target.ao)}`],
                    ["Periode", `${label} saja; periode lain dan bulan yang sudah dibayar tidak bergeser`],
                    ["Akibat", "Penyebut AO baris ini berubah dan nominal AO-nya dihitung ulang. Tersimpan langsung, bukan draf."],
                ] : []}
                onConfirm={() => (ao ? gantiAo(ao) : undefined)}
            />

            <ConfirmDialog
                open={dlgIkut !== null}
                onClose={() => setDlgIkut(null)}
                title={dlgIkut ? (nyala
                    ? `Hitung ${dlgIkut.principle} untuk SPV ${dlgIkut.spvName} periode ${label}?`
                    : `Keluarkan ${dlgIkut.principle} dari hitungan SPV ${dlgIkut.spvName} periode ${label}?`) : ""}
                tag="Support SPV"
                confirmLabel={nyala ? "Hitung untuk SPV" : "Keluarkan dari hitungan"}
                facts={dlgIkut ? [
                    ["Dasar", "Semua sales pasangan ini berstatus Principle (sales dibayar principal)"],
                    ["Akibat", nyala
                        ? "Principal ini dihitung untuk SPV walau sales-nya Principle. Jumlah principal SPV ini bertambah, sehingga rate per principal-nya ikut berubah."
                        : "Jumlah principal SPV ini berkurang, sehingga rate per principal-nya ikut berubah."],
                    ["Periode", `${label} saja; periode lain tidak berubah`],
                    ["Disimpan", "Langsung, bukan draf"],
                ] : []}
                onConfirm={() => (dlgIkut ? gantiIkut(dlgIkut) : undefined)}
            />
        </InsentifRangka>
    );
}

/** Pilihan dari URL tetap ada di daftar walau data belum datang, supaya select tidak diam-diam menampilkan "Semua". */
const dengan = (xs: string[], v: string) => (v === "ALL" || xs.includes(v) ? xs : [...xs, v]);
