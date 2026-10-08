/*
 * Tujuan: Halaman "Data periode" Insentif Sales (Fiori S4c, it07): wizard Jenis → Unggah → Pratinjau → Terapkan untuk target bulanan
 *   dan progres harian (laporan penjualan), ringkasan data tersimpan periode (hapus realisasi, hapus satu baris target), lalu
 *   bagian kualitas data (DataPeriodeKualitas.tsx). Periode = saringan URL (usePeriode), bukan pemilih sendiri (it07 #3).
 *   Berkas dibaca di peramban dan DIPRATINJAU dulu; tidak ada yang ditulis sebelum dialog Terapkan (it07 #16). Input manual
 *   target/progres tidak ada di jalur ini (it07 #17): koreksi = perbaiki berkas lalu unggah ulang periode.
 * Caller: app/(dashboard)/insentif-sales/data-periode/page.tsx.
 * Dependensi: ./Rangka (InsentifRangka, usePeriode), ./DataPeriodeKualitas, components/fiori/{core,interactive},
 *   lib/insentif-sales-excel (parseTargetExcel) dan xlsx — dimuat saat dipakai, lib/excel-date, lib/insentif-value-source,
 *   lib/insentif-ui (readApi, formatQty, LABEL_STATUS, halamanTerlihat), lib/rekapan-nota/ui (ambil, tanggalPendek),
 *   lib/promo-ui (rupiah).
 * Main Functions: DataPeriode (default), bacaTarget, bacaProgres, ringkasProgres.
 * Side Effects: GET targets/progress/settings/targets/template; POST /targets atau /progress (Terapkan), DELETE /progress
 *   (hapus realisasi periode), DELETE /targets (satu baris). Semua tulis lewat ConfirmDialog.
 */
"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, BarChart3, Download, Pencil, Trash2, Upload, Wallet } from "lucide-react";
import {
    Button, Flow, FooterToolbar, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge,
    type Column, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { rupiah } from "@/lib/promo-ui";
import { excelDateToIso } from "@/lib/excel-date";
import { realisasiValue } from "@/lib/insentif-value-source";
import { LABEL_STATUS, formatQty, halamanTerlihat, readApi } from "@/lib/insentif-ui";
import { InsentifRangka, usePeriode } from "./Rangka";
import { KualitasData } from "./DataPeriodeKualitas";

type Jenis = "target" | "progres";

/** Satu baris target; bentuknya = payload POST /api/insentif-sales/targets (tanpa periode). */
interface TargetRow {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel: string;
    spvName: string;
    smName: string;
    targetValue: number;
    targetEc: number;
    targetAo: number;
    targetIa: number;
    splmValue: number;
    tipeSales?: string;
    statusInsentif?: string;
}

/** Satu ember progres harian (sales × principal × cabang × tanggal); bentuknya = payload POST /progress. */
interface ProgresRow {
    salesCode: string; salesName?: string; principle: string; branch: string; date: string;
    periodMonth: number; periodYear: number; spvName?: string; invoiceNumber?: string;
    achievedValueDpp: number; achievedEc: number; achievedAo: number; achievedIa: number;
}

/** GET /progress: realisasi MTD per kode sales (setelah lipat gabung kode). */
interface MtdRow { salesCode: string; realValue: number }

type BarisTarget = { no: number; r: TargetRow };
type Pratinjau = { month: number; year: number; fileName: string; masalah: string | null } & (
    | { jenis: "target"; rows: BarisTarget[] }
    | { jenis: "progres"; payload: ProgresRow[]; barisBerkas: number; dibuang: number; nilaiDibuang: number; ambigu: string[] }
);
type Hasil = { jenis: Jenis; month: number; year: number; judul: string; isi: string };
type Dlg = { kind: "terapkan" } | { kind: "hapusReal" } | { kind: "hapusTarget"; row: TargetRow } | null;

const LABEL_TIPE: Record<string, string> = { exclusive: "Exclusive", mix: "Mix" };

const kunciTarget = (r: { salesCode: string; principle: string }) => `${r.salesCode}|${r.principle}`;
const n = (v: number) => v.toLocaleString("id-ID");

/** Panduan kolom = kolom yang benar-benar dibaca parseTargetExcel (lib/insentif-sales-excel) + normalisasi server. */
const KOLOM_TARGET: Array<[string, string]> = [
    ["Kode Salesman", "wajib"],
    ["Nama Salesman", "wajib"],
    ["Principal", "wajib; ikut kunci baris (satu baris per salesman × principal)"],
    ["Cabang", "wajib; menentukan acuan Value (DPP atau NILAI_JUAL)"],
    ["Channel", "GT, TT, atau MT; kosong = TT"],
    ["SPV", "nama SPV"],
    ["SM", "nama SM"],
    ["Target Value (Rp)", "angka penuh, mis. 412000000"],
    ["Target EC", "angka"],
    ["Target AO", "angka"],
    ["Target IA", "angka; boleh pecahan"],
    ["SPLM Value", "boleh kosong"],
    ["Tipe Sales", "Exclusive atau Mix; kosong = Exclusive; satu kode sales satu tipe"],
    ["Status Insentif", "Distributor + Principle, Distributor, atau Principle; kosong = Distributor + Principle"],
];

/** Panduan kolom = alias yang dibaca bacaProgres di bawah (nama kolom file closing tidak seragam antar export). */
const KOLOM_PROGRES: Array<[string, string]> = [
    ["KODE_SALESMAN", "wajib"],
    ["SALESMAN", "nama salesman; membantu mengenali kode yang belum punya target"],
    ["PRINCIPAL", "wajib"],
    ["JENISPRODUK", "cabang; bila kosong diturunkan dari baris lain dengan principal yang sama"],
    ["TANGGAL", "tanggal transaksi; kosong = tanggal 1 periode"],
    ["DPP", "nilai penjualan; retur bernilai minus"],
    ["NILAI_JUAL", "dipakai untuk cabang beracuan NILAI_JUAL (lihat Pengaturan)"],
    ["EC dan AO", "cacahan per baris"],
    ["IA atau ITEM AKTIF", "cacahan per baris"],
    ["NO_INVOICE atau NO_NOTA", "opsional; satu nota contoh per hari disimpan untuk penelusuran"],
    ["GOLONGAN", "opsional; nama SPV di laporan, dibandingkan dengan SPV di target"],
];

/** Baca berkas target + pemeriksaan klien yang sama dengan unggah lama. Tidak menulis apa pun. */
async function bacaTarget(file: File): Promise<{ rows: TargetRow[]; masalah: string | null }> {
    const { parseTargetExcel } = await import("@/lib/insentif-sales-excel");
    const rows = parseTargetExcel(await file.arrayBuffer()).map((r: Record<string, unknown>): TargetRow => ({
        salesCode: String(r.salesCode || ""),
        salesName: String(r.salesName || ""),
        // TANPA default. "NESTLE"/"BANDUNG" adalah data demo, dan memasangnya di sini
        // membuat tiga lapis validasi di bawah memeriksa nilai yang sudah dipalsukan:
        // baris pemisah/subtotal Excel lolos jadi target hantu, menaikkan `n` mix dan
        // memunculkan penerima yang bisa ditandai Lunas (audit 2026-08-28, C2 — M10
        // ternyata hanya tertutup di parser, tidak di jalur upload).
        principle: String(r.principle || ""),
        branch: String(r.branch || ""),
        channel: String(r.channel || "TT"),
        spvName: String(r.spvName || ""),
        smName: String(r.smName || ""),
        targetValue: Number(r.targetValue || 0),
        targetEc: Number(r.targetEc || 0),
        targetAo: Number(r.targetAo || 0),
        targetIa: Number(r.targetIa || 0),
        splmValue: Number(r.splmValue || 0),
        // Dulu dua kolom ini di-parse lalu dibuang di sini, jadi ENERGIZER tidak pernah
        // bisa di-set "principle" lewat upload — server selalu jatuh ke default.
        tipeSales: String(r.tipeSales || "exclusive"),
        statusInsentif: String(r.statusInsentif || "distributor_principle"),
    }));
    if (rows.length === 0) return { rows, masalah: "Berkas tidak berisi baris target." };
    const invalid = rows.filter((r) => !r.salesCode.trim() || !r.salesName.trim());
    if (invalid.length) return { rows, masalah: `${invalid.length} baris tidak punya kode/nama salesman.` };
    // Principal ikut kunci upsert (salesCode+principle+periode) dan Cabang menentukan
    // acuan Value (DPP vs NILAI_JUAL, lib/insentif-value-source). Keduanya tidak boleh
    // ditebak — baris tanpa Principal biasanya baris pemisah/subtotal di Excel.
    const noPrinciple = rows.filter((r) => !r.principle.trim() || !r.branch.trim());
    if (noPrinciple.length) {
        const contoh = noPrinciple.slice(0, 3).map((r) => r.salesCode).join(", ");
        return { rows, masalah: `${noPrinciple.length} baris tidak punya Principal/Cabang (${contoh}${noPrinciple.length > 3 ? ", …" : ""}).` };
    }
    // Kalau SEMUA baris bertarget 0, hampir pasti header kolomnya tidak terbaca —
    // bukan target yang benar-benar nol. Tolak daripada menimpa target lama dengan nol.
    if (rows.every((r) => !r.targetValue)) return { rows, masalah: "Semua baris bertarget 0 — cek nama kolom 'Target Value (Rp)' di berkas." };
    return { rows, masalah: null };
}

/**
 * Baca laporan penjualan (XLSX/CSV) dan ringkas per (sales, principal, cabang, tanggal) — sama persis dengan unggah lama.
 * Principal & Cabang dibaca PER BARIS dari kolom PRINCIPAL/JENISPRODUK di file — bukan dipilih global, karena 1 file laporan
 * penjualan bisa berisi banyak principal.
 */
async function bacaProgres(file: File, month: number, year: number, branchNilaiJual: string[]) {
    // Baca via XLSX — menangani .xlsx maupun .csv, termasuk field ber-koma di dalam
    // tanda kutip ("ABC PRESIDENT INDONESIA, PT" / alamat) yang bikin split manual geser kolom.
    // ponytail: dimuat saat dipakai. Import statis menyeret ~900 KB xlsx ke bundle route
    // ini untuk semua user, padahal cuma handler upload yang membutuhkannya.
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    // Nama kolom file closing tidak seragam antar export — terima alias, case-insensitive.
    const norm = (k: string) => k.trim().toUpperCase();

    const parsed = rawRows.map((rowObj) => {
        const byKey = new Map(Object.entries(rowObj).map(([k, v]) => [norm(k), v]));
        const get = (...names: string[]) => {
            for (const nm of names) {
                const v = byKey.get(norm(nm));
                if (v !== undefined && v !== "") return String(v).trim();
            }
            return "";
        };
        // Buang pemisah ribuan tapi PERTAHANKAN tanda minus & desimal —
        // baris retur bernilai negatif, kalau tandanya hilang retur malah menambah realisasi.
        // Dua format ribuan beredar di file closing: Inggris (1,234,567.89) dan
        // Indonesia (1.234.567,89). Deteksi dari polanya — kalau dipaksa satu format,
        // "-533.000.000" terbaca -533 dan realisasi satu principal menguap.
        const num = (val: string) => {
            const cleaned = val.replace(/[^\d.,-]/g, "");
            if (!cleaned) return 0;
            // Format Indonesia: titik sebagai pemisah ribuan (selalu 3 digit), koma desimal.
            const idFormat = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned);
            const normalized = idFormat ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
            const x = parseFloat(normalized);
            return Number.isFinite(x) ? x : 0;
        };
        return {
            salesCode: get("KODE_SALESMAN"),
            salesName: get("SALESMAN"),
            principle: get("PRINCIPAL"),
            branch: get("JENISPRODUK"),
            tanggal: get("TANGGAL"),
            invoiceNumber: get("NO_INVOICE", "NO_NOTA") || undefined,
            spvName: get("GOLONGAN") || undefined,
            dpp: num(get("DPP")),
            nilaiJual: num(get("NILAI_JUAL")),
            ec: num(get("EC")),
            ao: num(get("AO")),
            ia: num(get("IA", "ITEM AKTIF")),
        };
    });

    // Cabang kadang kosong (retur di file ADNAN: 2.508 baris, -533 jt). Kalau dibuang,
    // retur hilang dan realisasi jadi lebih tinggi dari seharusnya. Jadi cabang
    // diturunkan dari PRINCIPAL memakai baris LAIN di file yang sama yang cabangnya terisi.
    const branchByPrincipal = new Map<string, Map<string, number>>();
    for (const r of parsed) {
        if (!r.principle || !r.branch) continue;
        const inner = branchByPrincipal.get(r.principle) ?? new Map<string, number>();
        inner.set(r.branch, (inner.get(r.branch) ?? 0) + 1);
        branchByPrincipal.set(r.principle, inner);
    }
    const ambigu = new Set<string>();
    const branchOf = (principle: string, branch: string) => {
        if (branch) return branch;
        const inner = branchByPrincipal.get(principle);
        if (!inner || inner.size === 0) return "";
        if (inner.size > 1) ambigu.add(principle);
        // terbanyak menang — deterministik, dan principal ambigu dilaporkan ke user
        return [...inner.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    // Tanggal transaksi asli dari file. Sel berformat tanggal datang sebagai Date
    // (cellDates), sel berformat angka sebagai serial Excel "46235" — excelDateToIso
    // menangani keduanya. Kosong → tanggal 1 periode itu (bukan hari ini, supaya upload
    // ulang di hari berbeda tetap menghasilkan baris yang sama).
    const isoDate = (raw: string) => excelDateToIso(raw) ?? `${year}-${String(month).padStart(2, "0")}-01`;

    // AGREGASI sebelum kirim. File closing berada di level baris barang (135 ribu baris
    // untuk 2 SM); sistem hanya memakai jumlah per periode, jadi menjumlahkan per
    // (sales, principal, cabang, tanggal) memberi angka identik dengan payload jauh
    // lebih kecil — sekaligus menghapus kebutuhan dedup per nota yang dulu salah.
    const bucket = new Map<string, ProgresRow>();
    let dibuang = 0;
    let nilaiDibuang = 0;
    for (const r of parsed) {
        const branch = branchOf(r.principle, r.branch);
        if (!r.salesCode || !r.principle || !branch) {
            dibuang++;
            nilaiDibuang += r.dpp;
            continue;
        }
        const date = isoDate(r.tanggal);
        const k = `${r.salesCode}|${r.principle}|${branch}|${date}`;
        const cur = bucket.get(k) ?? {
            // Nama ikut dikirim supaya kode yang belum punya target tetap bisa
            // dikenali orangnya oleh deteksi kandidat Gabung Kode Sales.
            salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, branch, date,
            periodMonth: month, periodYear: year, spvName: r.spvName,
            // Satu nota PERWAKILAN per ember (sales x principal x cabang x tanggal).
            // Peringkasan lama membuang nomor nota sama sekali, sehingga baris yang
            // kode sales-nya tidak dikenali tidak bisa ditelusuri ke Accurate — daftar
            // "kombinasi tanpa target" cuma bisa bilang ada masalah, tidak menunjukkan
            // di mana. Satu nota per tanggal sudah cukup untuk membuka jejaknya.
            invoiceNumber: r.invoiceNumber,
            achievedValueDpp: 0, achievedEc: 0, achievedAo: 0, achievedIa: 0,
        };
        // Cabang mana yang memakai NILAI_JUAL diatur di Pengaturan, bukan di kode.
        cur.achievedValueDpp += realisasiValue(branch, r.dpp, r.nilaiJual, branchNilaiJual);
        cur.achievedEc += r.ec;
        cur.achievedAo += r.ao;
        cur.achievedIa += r.ia;
        if (!cur.salesName && r.salesName) cur.salesName = r.salesName;
        if (!cur.spvName && r.spvName) cur.spvName = r.spvName;
        if (!cur.invoiceNumber && r.invoiceNumber) cur.invoiceNumber = r.invoiceNumber;
        bucket.set(k, cur);
    }
    const payload = [...bucket.values()];
    const masalah = payload.length === 0 ? "Tidak ada baris valid. Pastikan kolom KODE_SALESMAN dan PRINCIPAL terisi." : null;
    return { payload, barisBerkas: parsed.length, dibuang, nilaiDibuang, ambigu: [...ambigu], masalah };
}

type RingkasProgres = { key: string; salesCode: string; salesName: string; principle: string; branch: string; hari: number; value: number; ec: number; ao: number; ia: number; dari: string; sampai: string };

/** Tampilan pratinjau saja: ember harian dijumlahkan per salesman × principal × cabang (yang ditulis tetap per hari). */
function ringkasProgres(payload: ProgresRow[]): RingkasProgres[] {
    const m = new Map<string, RingkasProgres>();
    for (const p of payload) {
        const key = `${p.salesCode}|${p.principle}|${p.branch}`;
        const cur = m.get(key) ?? { key, salesCode: p.salesCode, salesName: p.salesName ?? "", principle: p.principle, branch: p.branch, hari: 0, value: 0, ec: 0, ao: 0, ia: 0, dari: p.date, sampai: p.date };
        cur.hari++;
        cur.value += p.achievedValueDpp; cur.ec += p.achievedEc; cur.ao += p.achievedAo; cur.ia += p.achievedIa;
        if (p.date < cur.dari) cur.dari = p.date;
        if (p.date > cur.sampai) cur.sampai = p.date;
        m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
}

export default function DataPeriode({ permKeys }: { permKeys: string[] }) {
    const { month, year, label, bawa } = usePeriode();
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehTarget = perms.has("insentif_sales.upload_target");
    const bolehProgres = perms.has("insentif_sales.upload_progress");
    const bolehHierarki = perms.has("insentif_sales.manage_hierarchy");

    const [jenis, setJenis] = useState<Jenis | null>(null);
    const [berkas, setBerkas] = useState<File | null>(null);
    const [inputKey, setInputKey] = useState(0);
    const [membaca, setMembaca] = useState(false);
    const sedangMembaca = useRef(false);
    const [galatBaca, setGalatBaca] = useState<string | null>(null);
    const [pratinjau, setPratinjau] = useState<Pratinjau | null>(null);
    const [galatTerapkan, setGalatTerapkan] = useState<{ pesan: string; tertolak: boolean } | null>(null);
    const [hasil, setHasil] = useState<Hasil | null>(null);
    const [pesan, setPesan] = useState<{ tone: "pos" | "info"; teks: string } | null>(null);
    const [dialog, setDialog] = useState<Dlg>(null);
    const [versiKualitas, setVersiKualitas] = useState(0);
    const [templat, setTemplat] = useState<{ memuat: boolean; galat: string | null }>({ memuat: false, galat: null });
    const terlihat = useMemo(() => new Set(halamanTerlihat(perms).map((x) => x.key)), [perms]);

    const [targets, muatTargets] = useLoad(useCallback(() => ambil<TargetRow[]>(`/api/insentif-sales/targets?month=${month}&year=${year}`,
        (j) => ((j as { rows?: TargetRow[] }).rows ?? []).map((r): TargetRow => ({
            salesCode: r.salesCode, salesName: r.salesName,
            principle: r.principle, branch: r.branch, channel: r.channel,
            spvName: r.spvName ?? "", smName: r.smName ?? "",
            targetValue: r.targetValue, targetEc: r.targetEc,
            targetAo: r.targetAo, targetIa: r.targetIa, splmValue: r.splmValue ?? 0,
            tipeSales: r.tipeSales, statusInsentif: r.statusInsentif,
        }))), [month, year]));
    const [progres, muatProgres] = useLoad(useCallback(() => ambil<MtdRow[]>(`/api/insentif-sales/progress?month=${month}&year=${year}`,
        (j) => (j as { rows?: MtdRow[] }).rows ?? []), [month, year]));
    // Daftar cabang beracuan NILAI_JUAL diambil dari setelan, bukan konstanta di kode.
    // Belum termuat → unggah progres ditahan. Memakai bawaan diam-diam saat setelan gagal
    // dimuat berarti file diproses dengan aturan yang BUKAN aturan yang sedang berlaku,
    // dan hasilnya tersimpan sebagai realisasi tanpa ada yang tahu.
    const [setelan, muatSetelan] = useLoad(useCallback(() => ambil<string[]>("/api/insentif-sales/settings", (j) => {
        const d = (j as { branchNilaiJual?: unknown }).branchNilaiJual;
        return Array.isArray(d) ? d as string[] : [];
    }), []));

    // Pratinjau/hasil milik periode saat dibaca; periode di saringan berganti = baca ulang (payload progres membawa periodenya).
    const p = pratinjau && pratinjau.month === month && pratinjau.year === year ? pratinjau : null;
    const h = hasil && hasil.month === month && hasil.year === year ? hasil : null;
    const draf = Boolean(berkas || p) && !h;
    useUnsavedGuard(draf);

    const tersimpanKeys = useMemo(() => new Set((targets.data ?? []).map(kunciTarget)), [targets.data]);
    const fileKeys = useMemo(() => new Set(p?.jenis === "target" ? p.rows.map((b) => kunciTarget(b.r)) : []), [p]);
    const baru = p?.jenis === "target" ? p.rows.filter((b) => !tersimpanKeys.has(kunciTarget(b.r))).length : 0;
    const tetap = (targets.data ?? []).filter((r) => !fileKeys.has(kunciTarget(r))).length;
    const ringkas = useMemo(() => (p?.jenis === "progres" ? ringkasProgres(p.payload) : []), [p]);
    const tanggal = p?.jenis === "progres" && p.payload.length ? [p.payload.reduce((a, x) => (x.date < a ? x.date : a), p.payload[0].date), p.payload.reduce((a, x) => (x.date > a ? x.date : a), p.payload[0].date)] : null;
    const totalProgres = (progres.data ?? []).reduce((a, r) => a + (r.realValue || 0), 0);
    const totalTarget = (targets.data ?? []).reduce((a, r) => a + (r.targetValue || 0), 0);

    const izinJenis = jenis === "target" ? bolehTarget : jenis === "progres" ? bolehProgres : false;
    const namaJenis = jenis === "target" ? "target" : "progres";
    const alasanLanjut = !jenis ? "Pilih jenis data"
        : !izinJenis ? `Akun Anda tidak punya izin unggah ${namaJenis}`
            : jenis === "progres" && !setelan.data ? (setelan.status === "galat" ? "Setelan cabang NILAI_JUAL gagal dimuat" : "Menunggu setelan cabang NILAI_JUAL")
                : !berkas ? "Pilih berkas dulu" : undefined;
    const alasanTerapkan = !p ? undefined
        : p.masalah || galatTerapkan?.tertolak ? "Perbaiki berkas lalu baca ulang"
            : !(p.jenis === "target" ? bolehTarget : bolehProgres) ? `Akun Anda tidak punya izin unggah ${p.jenis}` : undefined;

    const langkah: FlowStep[] = [
        { label: "Jenis & periode", state: h || membaca || p ? "done" : "current" },
        { label: "Unggah", state: h || p ? "done" : membaca ? "current" : "todo" },
        { label: "Pratinjau", state: h ? "done" : p ? "current" : "todo" },
        { label: "Terapkan", state: h ? "done" : "todo" },
    ];

    function pilihJenis(j: Jenis) {
        if (j === jenis) return;
        setJenis(j); setBerkas(null); setInputKey((k) => k + 1); setGalatBaca(null); setHasil(null);
    }

    async function baca() {
        if (!jenis || !berkas || alasanLanjut || sedangMembaca.current) return;
        sedangMembaca.current = true;
        setMembaca(true); setGalatBaca(null); setGalatTerapkan(null); setHasil(null); setPesan(null);
        try {
            if (jenis === "target") {
                const r = await bacaTarget(berkas);
                setPratinjau({ jenis, month, year, fileName: berkas.name, masalah: r.masalah, rows: r.rows.map((x, i) => ({ no: i + 1, r: x })) });
            } else {
                const r = await bacaProgres(berkas, month, year, setelan.data ?? []);
                setPratinjau({ jenis, month, year, fileName: berkas.name, ...r });
            }
        } catch (e) {
            setGalatBaca(`${berkas.name} tidak terbaca: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            sedangMembaca.current = false;
            setMembaca(false);
        }
    }

    async function terapkan() {
        if (!p || alasanTerapkan) return;
        const body = p.jenis === "target" ? p.rows.map((b) => ({ ...b.r, periodMonth: p.month, periodYear: p.year })) : p.payload;
        const res = await fetch(`/api/insentif-sales/${p.jenis === "target" ? "targets" : "progress"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        let data: Record<string, unknown>;
        try {
            data = await readApi(res);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setGalatTerapkan({ pesan: msg, tertolak: false });
            throw new Error(msg);
        }
        if (!res.ok) {
            // Route targets & progress memvalidasi SELURUH payload sebelum menulis, lalu menulis dalam satu transaksi:
            // 4xx = tidak ada baris yang ditulis (AM-017/AM-043). Galat lain (502 proxy) belum tentu begitu.
            const msg = String(data.error ?? "Server menolak impor.");
            const tertolak = res.status >= 400 && res.status < 500;
            setGalatTerapkan({ pesan: msg, tertolak });
            throw new Error(tertolak ? `${msg} Tidak ada baris yang ditulis.` : msg);
        }
        const isi = p.jenis === "target"
            ? `${n(Number(data.upserted ?? 0))} baris target ${label} tersimpan. Dashboard, Support principal, dan Pembayaran memakai target ini pada hitungan berikutnya.`
            : `${n(p.barisBerkas)} baris berkas diringkas jadi ${n(Number(data.inserted ?? 0))} baris harian${Number(data.replaced) ? `, mengganti ${n(Number(data.replaced))} baris lama` : ""}. Dashboard dan Pembayaran ${label} dihitung ulang dari realisasi baru.`;
        setHasil({ jenis: p.jenis, month: p.month, year: p.year, judul: p.jenis === "target" ? `Target ${label} diterapkan.` : `Progres ${label} diterapkan.`, isi });
        setPratinjau(null); setBerkas(null); setInputKey((k) => k + 1); setGalatTerapkan(null); setDialog(null);
        muatTargets(); muatProgres(); setVersiKualitas((v) => v + 1);
    }

    /**
     * Hapus seluruh realisasi closing periode ini. Wajib sebelum unggah ulang kalau
     * tanggal barisnya bisa bergeser dari unggahan sebelumnya: POST hanya menimpa kombinasi
     * (kode, principal, periode, TANGGAL) yang ada di file baru, jadi baris lama bertanggal
     * lain tetap tinggal dan ikut terhitung. Dulu ini DELETE manual lewat psql di VPS.
     */
    async function hapusRealisasi() {
        const res = await fetch(`/api/insentif-sales/progress?month=${month}&year=${year}`, { method: "DELETE" });
        const data = await readApi(res);
        if (!res.ok) throw new Error(String(data.error ?? "Gagal menghapus periode."));
        const jml = Number(data.deleted ?? 0);
        setPesan(jml === 0 ? { tone: "info", teks: `Tidak ada realisasi ${label} untuk dihapus.` } : { tone: "pos", teks: `${n(jml)} baris realisasi ${label} dihapus. Unggah ulang closing-nya sekarang.` });
        setDialog(null);
        muatProgres(); setVersiKualitas((v) => v + 1);
    }

    /**
     * Baris target yang sudah ada di database harus benar-benar DELETE — unggah ulang tidak akan menghapusnya karena POST
     * adalah upsert. Baris target hantu tetap membawa Target Value ke agregat SPV/SM dan tetap dihitung sebagai satu
     * principal di penyebut mix, jadi membiarkannya menggeser nominal.
     */
    async function hapusTarget(r: TargetRow) {
        const q = new URLSearchParams({ salesCode: r.salesCode, principle: r.principle, month: String(month), year: String(year) });
        const res = await fetch(`/api/insentif-sales/targets?${q}`, { method: "DELETE" });
        const data = await readApi(res);
        if (!res.ok) throw new Error(String(data.error ?? "Gagal menghapus baris target."));
        setPesan(Number(data.deleted ?? 0) === 0
            ? { tone: "info", teks: `${r.salesCode}/${r.principle} sudah tidak ada di database.` }
            : { tone: "pos", teks: `Baris target ${r.salesCode}/${r.principle} ${label} dihapus.` });
        setDialog(null);
        muatTargets(); setVersiKualitas((v) => v + 1);
    }

    async function unduhTemplat() {
        setTemplat({ memuat: true, galat: null });
        try {
            const res = await fetch("/api/insentif-sales/targets/template");
            if (!res.ok) {
                const data = await readApi(res).catch((): Record<string, unknown> => ({}));
                throw new Error(String(data.error ?? `HTTP ${res.status}`));
            }
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement("a");
            a.href = url;
            a.download = `target_template_${month}_${year}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
            setTemplat({ memuat: false, galat: null });
        } catch (e) {
            setTemplat({ memuat: false, galat: e instanceof Error ? e.message : String(e) });
        }
    }

    const ringkasTarget = targets.status === "galat" && !targets.data ? "Gagal dimuat"
        : !targets.data ? "Memuat…" : targets.data.length ? `${n(targets.data.length)} baris · Target Value ${rupiah(totalTarget)}` : "Belum diunggah";
    const ringkasRealisasi = progres.status === "galat" && !progres.data ? "Gagal dimuat"
        : !progres.data ? "Memuat…" : progres.data.length ? `${n(progres.data.length)} kode sales · ${rupiah(Math.round(totalProgres))}` : "Belum ada";
    const alasanHapusReal = !bolehProgres ? "Butuh izin unggah progres" : progres.data && progres.data.length === 0 ? `Belum ada realisasi ${label}` : undefined;

    const kolomTarget: Column<BarisTarget>[] = [
        { key: "sales", header: "Salesman", cell: ({ r }) => <><span className="fi-mono">{r.salesCode || "—"}</span> · {r.salesName || "—"}</> },
        { key: "principle", header: "Principal", cell: ({ r }) => r.principle || <span className="fi-why">kosong</span> },
        { key: "branch", header: "Cabang", secondary: true, cell: ({ r }) => r.branch || <span className="fi-why">kosong</span> },
        { key: "channel", header: "Channel", secondary: true, cell: ({ r }) => r.channel },
        { key: "spv", header: "SPV / SM", secondary: true, cell: ({ r }) => `${r.spvName || "—"} / ${r.smName || "—"}` },
        { key: "value", header: "Target Value", align: "end", cell: ({ r }) => <span className="fi-tnum">{rupiah(r.targetValue)}</span> },
        { key: "kpi", header: "EC · AO · IA", align: "end", secondary: true, cell: ({ r }) => <span className="fi-tnum">{formatQty(r.targetEc)} · {formatQty(r.targetAo)} · {formatQty(r.targetIa)}</span> },
        { key: "splm", header: "SPLM", align: "end", secondary: true, cell: ({ r }) => <span className="fi-tnum">{rupiah(r.splmValue)}</span> },
        { key: "tipe", header: "Tipe · status", secondary: true, cell: ({ r }) => `${r.tipeSales} · ${r.statusInsentif}` },
        { key: "ket", header: "Keterangan", cell: ({ r }) => targets.data ? (tersimpanKeys.has(kunciTarget(r)) ? <StatusBadge tone="info">Mengganti</StatusBadge> : <StatusBadge tone="pos">Baru</StatusBadge>) : "—" },
    ];
    const kolomProgres: Column<RingkasProgres>[] = [
        { key: "sales", header: "Salesman", cell: (r) => <><span className="fi-mono">{r.salesCode}</span>{r.salesName ? ` · ${r.salesName}` : ""}</> },
        { key: "principle", header: "Principal", cell: (r) => r.principle },
        { key: "branch", header: "Cabang", secondary: true, cell: (r) => r.branch },
        { key: "hari", header: "Hari", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{r.hari}</span> },
        { key: "value", header: "Value", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(Math.round(r.value))}</span> },
        { key: "kpi", header: "EC · AO · IA", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{formatQty(r.ec)} · {formatQty(r.ao)} · {formatQty(r.ia)}</span> },
        { key: "tgl", header: "Tanggal", secondary: true, cell: (r) => <span className="fi-tnum">{tanggalPendek(r.dari)}{r.sampai !== r.dari ? `–${tanggalPendek(r.sampai)}` : ""}</span> },
    ];
    const aksiTarget = (r: TargetRow) => (
        <div className="fi-btnrow">
            <Button variant="tertiary" disabled={!bolehTarget} disabledReason="Butuh izin unggah target" onClick={() => setDialog({ kind: "hapusTarget", row: r })}>Hapus…</Button>
        </div>
    );
    const kolomTersimpan: Column<TargetRow>[] = [
        { key: "sales", header: "Salesman", cell: (r) => <><span className="fi-mono">{r.salesCode}</span> · {r.salesName}</> },
        { key: "principle", header: "Principal", cell: (r) => r.principle },
        { key: "branch", header: "Cabang", secondary: true, cell: (r) => r.branch },
        { key: "channel", header: "Channel", secondary: true, cell: (r) => r.channel },
        { key: "spv", header: "SPV / SM", secondary: true, cell: (r) => `${r.spvName || "—"} / ${r.smName || "—"}` },
        { key: "tipe", header: "Tipe", secondary: true, cell: (r) => LABEL_TIPE[r.tipeSales ?? ""] ?? r.tipeSales ?? "—" },
        { key: "status", header: "Status insentif", secondary: true, cell: (r) => LABEL_STATUS[r.statusInsentif ?? ""] ?? r.statusInsentif ?? "—" },
        { key: "value", header: "Target Value", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.targetValue)}</span> },
        { key: "kpi", header: "EC · AO · IA", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{formatQty(r.targetEc)} · {formatQty(r.targetAo)} · {formatQty(r.targetIa)}</span> },
        { key: "aksi", header: "Tindakan", cell: aksiTarget },
    ];

    let langkahIsi: ReactNode;
    if (h) {
        langkahIsi = (
            <>
                <MessageStrip tone="pos" title={h.judul}>{h.isi}</MessageStrip>
                <div className="fi-btnrow">
                    {terlihat.has("dashboard") && <Link className="fi-btn fi-btn--secondary" href={`/insentif-sales${bawa}`}><BarChart3 className="fi-icon" aria-hidden />Buka Dashboard</Link>}
                    {terlihat.has("pembayaran") && <Link className="fi-btn fi-btn--secondary" href={`/insentif-sales/pembayaran${bawa}`}><Wallet className="fi-icon" aria-hidden />Buka Pembayaran</Link>}
                </div>
            </>
        );
    } else if (membaca) {
        langkahIsi = <><Skeleton rows={3} label={`Membaca ${berkas?.name ?? "berkas"}`} /><p className="fi-small fi-subtle">Membaca {berkas?.name} di peramban; belum ada yang ditulis.</p></>;
    } else if (p) {
        langkahIsi = (
            <>
                {galatTerapkan && (
                    <MessageStrip tone="neg" title={galatTerapkan.tertolak ? "Impor ditolak; tidak ada baris yang ditulis." : "Gagal menerapkan."}>
                        {galatTerapkan.pesan} {galatTerapkan.tertolak ? "Perbaiki berkas lalu unggah ulang; baris lain tidak disimpan sebagian." : "Periksa Data tersimpan di bawah sebelum mengulang."}
                    </MessageStrip>
                )}
                {p.masalah && <MessageStrip tone="neg" title="Berkas tidak bisa diterapkan.">{p.masalah} Perbaiki berkas lalu baca ulang.</MessageStrip>}
                {p.jenis === "target" ? (
                    <>
                        <div className="fi-kcards">
                            <div className="fi-kc"><span>Baris berkas</span><b>{n(p.rows.length)}</b><small>{p.fileName}</small></div>
                            <div className="fi-kc"><span>Baru</span><b>{targets.data ? n(baru) : "—"}</b><small>belum ada di {label}</small></div>
                            <div className="fi-kc"><span>Mengganti</span><b>{targets.data ? n(p.rows.length - baru) : "—"}</b><small>salesman × principal yang sudah tersimpan</small></div>
                            <div className="fi-kc"><span>Tetap tersimpan</span><b>{targets.data ? n(tetap) : "—"}</b><small>tidak ada di berkas, tidak dihapus</small></div>
                            <div className="fi-kc"><span>Target Value</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(p.rows.reduce((a, b) => a + b.r.targetValue, 0))}</b><small>jumlah berkas</small></div>
                        </div>
                        {targets.status === "galat" && !targets.data && <MessageStrip tone="warn" title="Target tersimpan gagal dimuat.">Jumlah baru dan mengganti belum diketahui; unggahan tetap menimpa per salesman × principal.</MessageStrip>}
                        {tetap > 0 && <MessageStrip tone="info" title={`${n(tetap)} baris target tersimpan tidak ada di berkas.`}>Unggahan tidak menghapusnya; baris itu tetap dihitung. Hapus lewat tabel Target tersimpan bila memang tidak berlaku.</MessageStrip>}
                    </>
                ) : (
                    <>
                        <div className="fi-kcards">
                            <div className="fi-kc"><span>Baris berkas</span><b>{n(p.barisBerkas)}</b><small>{p.fileName}</small></div>
                            <div className="fi-kc"><span>Diringkas</span><b>{n(p.payload.length)}</b><small>baris harian</small></div>
                            <div className="fi-kc"><span>Tanggal</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{tanggal ? `${tanggalPendek(tanggal[0])}–${tanggalPendek(tanggal[1])}` : "—"}</b><small>harus di {label}</small></div>
                            <div className="fi-kc"><span>Dilewati</span><b>{n(p.dibuang)}</b><small>{p.dibuang ? rupiah(Math.round(p.nilaiDibuang)) : "baris tanpa kode/principal/cabang"}</small></div>
                            <div className="fi-kc"><span>Realisasi tersimpan</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{progres.data ? rupiah(Math.round(totalProgres)) : "—"}</b><small>baris bertanggal sama diganti; tanggal lain tetap</small></div>
                        </div>
                        {p.dibuang > 0 && <MessageStrip tone="warn" title={`${n(p.dibuang)} baris dilewati (kode sales/principal/cabang kosong),`}>total nilai {rupiah(Math.round(p.nilaiDibuang))}.</MessageStrip>}
                        {p.ambigu.length > 0 && <MessageStrip tone="warn" title="Cabang diturunkan dari principal yang punya lebih dari satu cabang:">{p.ambigu.join(", ")}. Periksa hasilnya.</MessageStrip>}
                    </>
                )}
            </>
        );
    } else {
        langkahIsi = (
            <>
                {targets.data && targets.data.length === 0 && <MessageStrip tone="warn" title={`Target ${label} belum diunggah.`}>Capaian dan insentif periode ini belum bisa dihitung sampai target diterapkan.</MessageStrip>}
                {pratinjau && !p && <MessageStrip tone="info" title="Periode di saringan berganti.">Pratinjau {pratinjau.fileName} dibuat untuk periode lain; tekan Lanjut untuk membaca ulang berkas untuk {label}.</MessageStrip>}
                {galatBaca && <MessageStrip tone="neg" title="Berkas tidak terbaca." onClose={() => setGalatBaca(null)}>{galatBaca}</MessageStrip>}
                <div className="fi-segs" role="group" aria-label="Jenis data">
                    <button type="button" aria-pressed={jenis === "target"} disabled={!bolehTarget} title={bolehTarget ? undefined : "Butuh izin unggah target"} onClick={() => pilihJenis("target")}>Target bulanan</button>
                    <button type="button" aria-pressed={jenis === "progres"} disabled={!bolehProgres} title={bolehProgres ? undefined : "Butuh izin unggah progres"} onClick={() => pilihJenis("progres")}>Progres harian</button>
                </div>
                <p className="fi-small fi-subtle">
                    {jenis === "target" ? "Satu baris per salesman × principal × cabang: target Value, EC, AO, IA, tipe sales, dan status insentif. Menimpa baris tersimpan dengan salesman dan principal yang sama."
                        : jenis === "progres" ? "Laporan penjualan (XLSX/CSV) diringkas per salesman × principal × cabang × tanggal; mengganti progres bertanggal sama di periode ini."
                            : `Pilih data yang akan diunggah untuk ${label}. Periode mengikuti saringan di atas.`}
                </p>
                {jenis === "progres" && setelan.status === "galat" && !setelan.data && (
                    <MessageStrip tone="neg" title="Setelan cabang NILAI_JUAL gagal dimuat.">
                        Progres tidak dibaca dengan aturan bawaan. {setelan.error} <Button variant="tertiary" onClick={muatSetelan}>Coba lagi</Button>
                    </MessageStrip>
                )}
                {jenis && (
                    <>
                        <h3 className="fi-title-3">Kolom berkas {jenis === "target" ? "target (14 kolom, urutan bebas)" : "laporan penjualan"}</h3>
                        <KeyValues items={jenis === "target" ? KOLOM_TARGET : KOLOM_PROGRES} />
                        <p className="fi-small fi-subtle">
                            {jenis === "target"
                                ? "Baris pertama = judul kolom; huruf besar/kecil dan spasi di judul diabaikan. Angka boleh 1.250.000; teks yang bukan angka dibaca 0, jadi periksa pratinjau. Satu baris yang ditolak server (channel, tipe, atau status tak dikenal; angka negatif; salesman × principal ganda; tipe berbeda dalam satu kode) membatalkan seluruh impor."
                                : `Judul kolom tidak peka huruf besar/kecil. Angka 1,234,567.89 maupun 1.234.567,89 terbaca. Tanggal harus di ${label} (tanggal 1 bulan berikutnya juga diterima); satu baris yang ditolak server membatalkan seluruh impor.`}
                        </p>
                        {jenis === "target" && (
                            <>
                                <div className="fi-btnrow">
                                    <Button icon={<Download className="fi-icon" aria-hidden />} busy={templat.memuat} onClick={() => void unduhTemplat()}>Unduh templat</Button>
                                </div>
                                {templat.galat && <MessageStrip tone="neg" title="Templat gagal diunduh." onClose={() => setTemplat({ memuat: false, galat: null })}>{templat.galat}</MessageStrip>}
                            </>
                        )}
                        <div className="fi-dropzone" data-ok={berkas ? "true" : undefined}>
                            <label className="fi-label" htmlFor="data-periode-berkas">Berkas {jenis === "target" ? "target" : "progres"} {label}<span className="fi-req" aria-hidden>*</span></label>
                            <span>{berkas ? <b>{berkas.name}</b> : jenis === "target" ? ".xlsx · satu sheet" : ".xlsx atau .csv · satu sheet"}</span>
                            <input key={inputKey} id="data-periode-berkas" className="fi-input" type="file" accept={jenis === "target" ? ".xlsx,.xls" : ".xlsx,.xls,.csv"} disabled={!izinJenis}
                                onChange={(e) => { setBerkas(e.target.files?.[0] ?? null); setPratinjau(null); setGalatBaca(null); setGalatTerapkan(null); }} />
                        </div>
                    </>
                )}
            </>
        );
    }

    let footer: ReactNode;
    if (h) {
        footer = (
            <FooterToolbar message="Data sudah diterapkan.">
                <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} onClick={() => setHasil(null)}>Unggah berkas lain</Button>
            </FooterToolbar>
        );
    } else if (p) {
        footer = (
            <FooterToolbar message={alasanTerapkan ?? "Kode mirip dan SPV tidak sinkron boleh diputuskan nanti."}>
                <Button variant="tertiary" icon={<ArrowLeft className="fi-icon" aria-hidden />} onClick={() => { setPratinjau(null); setGalatTerapkan(null); }}>Kembali</Button>
                <Button variant="primary" disabled={Boolean(alasanTerapkan)} disabledReason={alasanTerapkan} onClick={() => setDialog({ kind: "terapkan" })}>
                    {p.jenis === "target" ? "Terapkan target…" : "Terapkan progres…"}
                </Button>
            </FooterToolbar>
        );
    } else {
        footer = (
            <FooterToolbar message={membaca ? "Membaca berkas…" : alasanLanjut}>
                <Button variant="primary" busy={membaca} icon={<ArrowRight className="fi-icon" aria-hidden />} disabled={Boolean(alasanLanjut)} disabledReason={alasanLanjut} onClick={() => void baca()}>Lanjut</Button>
            </FooterToolbar>
        );
    }

    const dialogTerapkan = p && dialog?.kind === "terapkan";
    return (
        <InsentifRangka halaman="data" permKeys={permKeys}
            deskripsi="Unggah target bulanan atau progres harian untuk periode di saringan. Berkas dipratinjau dulu; tidak ada yang ditulis sebelum Terapkan."
            aksi={draf ? <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum diterapkan</span> : undefined}>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}

            <Section id="unggah" title="Unggah data periode" subtitle={`${label} · periode mengikuti saringan, bukan pemilih sendiri`}>
                <div className="fi-sect-in">
                    <Flow steps={langkah} label="Langkah unggah data" />
                    {langkahIsi}
                </div>
                {p?.jenis === "target" && !membaca && !h && (
                    <ResponsiveTable<BarisTarget> title={`Pratinjau target ${label}`} count={p.rows.length} columns={kolomTarget} rows={p.rows} rowKey={(b) => String(b.no)}
                        empty={{ title: "Berkas tidak berisi baris target" }}
                        mobileItem={({ r }) => <ListItem doc={r.salesCode || "—"} amount={rupiah(r.targetValue)} title={r.salesName} meta={`${r.principle || "principal kosong"} · ${r.branch || "cabang kosong"} · ${r.channel}`}
                            badge={targets.data ? (tersimpanKeys.has(kunciTarget(r)) ? <StatusBadge tone="info">Mengganti</StatusBadge> : <StatusBadge tone="pos">Baru</StatusBadge>) : undefined} />} />
                )}
                {p?.jenis === "progres" && !membaca && !h && (
                    <ResponsiveTable<RingkasProgres> title={`Pratinjau progres ${label} per salesman × principal`} count={ringkas.length} columns={kolomProgres} rows={ringkas} rowKey={(r) => r.key}
                        empty={{ title: "Tidak ada baris yang akan ditulis" }}
                        mobileItem={(r) => <ListItem doc={r.salesCode} amount={rupiah(Math.round(r.value))} title={r.salesName || r.principle} meta={`${r.principle} · ${r.branch} · ${r.hari} hari`} />} />
                )}
            </Section>

            <Section id="tersimpan" title={`Data tersimpan ${label}`} subtitle="yang dipakai dashboard dan pembayaran saat ini"
                actions={<Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={Boolean(alasanHapusReal)} disabledReason={alasanHapusReal} onClick={() => setDialog({ kind: "hapusReal" })}>Hapus realisasi {label}…</Button>}>
                <div className="fi-sect-in">
                    <KeyValues items={[["Target", ringkasTarget], ["Realisasi", ringkasRealisasi]]} />
                    <p className="fi-small fi-subtle">
                        Hapus realisasi dulu bila closing periode ini pernah diunggah dengan aturan berbeda — unggah ulang hanya menimpa baris bertanggal
                        sama, sisanya ikut terhitung dua kali. Target dan catatan pembayaran tidak ikut terhapus.
                    </p>
                    {progres.status === "galat" && <MessageStrip tone="neg" title="Realisasi gagal dimuat.">{progres.error} <Button variant="tertiary" onClick={muatProgres}>Coba lagi</Button></MessageStrip>}
                </div>
            </Section>

            <Section id="target-tersimpan" title={`Target tersimpan ${label}`} subtitle="per salesman × principal; unggahan tidak menghapus baris yang tidak ada di berkas">
                <ResponsiveTable<TargetRow> title={`Target tersimpan ${label}`} count={targets.data?.length} columns={kolomTersimpan} rows={targets.data ?? []} rowKey={kunciTarget}
                    status={targets.status} error={targets.error ? `Target belum berhasil dimuat (${targets.error}).` : undefined} onRetry={muatTargets}
                    empty={{ title: `Target ${label} belum diunggah`, message: "Pilih Target bulanan di langkah 1 untuk mengunggah." }}
                    mobileItem={(r) => <ListItem doc={r.salesCode} amount={rupiah(r.targetValue)} title={r.salesName}
                        meta={<>{r.principle} · {r.branch} · {r.channel} · {LABEL_STATUS[r.statusInsentif ?? ""] ?? r.statusInsentif}{aksiTarget(r)}</>} />} />
            </Section>

            <KualitasData key={versiKualitas} month={month} year={year} label={label} bolehHierarki={bolehHierarki}
                onBerubah={() => { muatTargets(); muatProgres(); }} />

            {footer}

            <ConfirmDialog open={Boolean(dialogTerapkan)} onClose={() => setDialog(null)} tag={p?.jenis === "target" ? "Target" : "Progres"}
                title={p?.jenis === "target" ? `Terapkan target ${label}?` : `Terapkan progres ${label}?`}
                confirmLabel="Terapkan" confirmDisabled={alasanTerapkan} onConfirm={terapkan}
                facts={!p ? [] : p.jenis === "target" ? [
                    ["Berkas", p.fileName],
                    ["Ditulis", `${n(p.rows.length)} baris target${targets.data ? ` (${n(baru)} baru, ${n(p.rows.length - baru)} mengganti)` : ""}`],
                    ["Tetap tersimpan", targets.data ? `${n(tetap)} baris yang tidak ada di berkas — tidak dihapus` : "belum diketahui"],
                    ["Target Value", rupiah(p.rows.reduce((a, b) => a + b.r.targetValue, 0))],
                    ["Ikut berubah", `Dashboard, Support principal, dan Pembayaran ${label} pada hitungan berikutnya`],
                ] : [
                    ["Berkas", `${p.fileName} · ${n(p.barisBerkas)} baris`],
                    ["Ditulis", `${n(p.payload.length)} baris harian${tanggal ? ` · ${tanggalPendek(tanggal[0])}–${tanggalPendek(tanggal[1])}` : ""}`],
                    ["Diganti", "Baris tersimpan dengan salesman, principal, dan tanggal yang sama"],
                    ["Tetap", "Tanggal lain yang sudah tersimpan tidak disentuh"],
                    ["Dilewati", p.dibuang ? `${n(p.dibuang)} baris · ${rupiah(Math.round(p.nilaiDibuang))}` : "tidak ada"],
                    ["Ikut dihitung ulang", `Dashboard dan Pembayaran ${label}`],
                ]}
                description="Kode mirip dan SPV tidak sinkron tidak memblokir; keduanya bisa diputuskan sesudahnya." />
            <ConfirmDialog open={dialog?.kind === "hapusReal"} onClose={() => setDialog(null)} tone="negative" tag="Hapus"
                title={`Hapus realisasi ${label}?`} confirmLabel="Hapus realisasi" onConfirm={hapusRealisasi}
                facts={[
                    ["Dihapus", `Seluruh realisasi closing ${label}${progres.data?.length ? ` · ${n(progres.data.length)} kode sales · ${rupiah(Math.round(totalProgres))}` : ""}`],
                    ["Tidak ikut terhapus", "Target dan catatan pembayaran"],
                    ["Akibat", `Capaian ${label} kosong sampai closing-nya diunggah ulang`],
                ]} />
            <ConfirmDialog open={dialog?.kind === "hapusTarget"} onClose={() => setDialog(null)} tone="negative" tag="Hapus"
                title={dialog?.kind === "hapusTarget" ? `Hapus target ${dialog.row.salesCode} / ${dialog.row.principle}?` : ""}
                confirmLabel="Hapus baris target" onConfirm={() => (dialog?.kind === "hapusTarget" ? hapusTarget(dialog.row) : undefined)}
                facts={dialog?.kind === "hapusTarget" ? [
                    ["Periode", label],
                    ["Salesman", `${dialog.row.salesCode} · ${dialog.row.salesName}`],
                    ["Target Value", rupiah(dialog.row.targetValue)],
                    ["Akibat", "Hilang dari agregat SPV/SM dan tidak lagi dihitung sebagai principal di penyebut mix salesman ini"],
                ] : []} />
        </InsentifRangka>
    );
}
