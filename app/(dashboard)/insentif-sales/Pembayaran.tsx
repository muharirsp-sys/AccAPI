/*
 * Tujuan: Layar "Pembayaran" Insentif Sales (Fiori S4c, Worklist it07): ubin 12 bulan sebagai pemilih periode URL, daftar penerima
 *   (sales, SPV, SM) dengan bruto → PPh → netto dan rincian per baris, pilih semua yang belum dibayar di saringan aktif, penerima
 *   terpilih di luar saringan disebut namanya, dan Tandai lunas lewat dialog. Pengganti FinanceView di page.tsx lama.
 * Caller: app/(dashboard)/insentif-sales/pembayaran/page.tsx (default export, prop permKeys).
 * Dependensi: ./Rangka (InsentifRangka, usePeriode, useDashboard, KonstantaCtx), ./Rincian (TabelRincian, rincian, PPh, StatusBayar,
 *   pemuat SPV/SM), ./data (format, MONTH_LABELS), components/fiori/*, lib/insentif-ui, lib/insentif-payee, lib/insentif-pph, lib/insentif-payment-date,
 *   lib/rekapan-nota/ui (ambil, jamWita), sonner.
 * Main Functions: Pembayaran (default), barisBulan, ringkasan12Bulan, UbinBulan.
 * Side Effects: GET dashboard (tanpa saringan), spv-dashboard, sm-dashboard, payments?year. Tandai lunas: per penerima terpilih,
 *   paralel, POST /api/insentif-sales/payments (belum tercatat) atau PATCH /payments/[id] (sudah tercatat) — MENCATAT UANG DIBAYAR,
 *   dengan `paymentDate` (tanggal bayar WITA pilihan di dialog; kontrak #134, divalidasi lib/insentif-payment-date seperti server).
 *   beforeunload selama ada pilihan.
 */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Check, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button, ErrorState, FooterToolbar, ListItem, MessageStrip, Section, Skeleton, StatusBadge, VariantNote, type Column, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { DEFAULT_KONSTANTA } from "@/lib/insentif-konstanta";
import { parsePaymentDate, todayWita } from "@/lib/insentif-payment-date";
import { nettoInsentif } from "@/lib/insentif-pph";
import { payeeCode, PAYEE_PRINCIPLE_ALL, type PayeeRole } from "@/lib/insentif-payee";
import { paymentSelectionKey, readApi, sebabNol, type ApiRow, type PaymentRow } from "@/lib/insentif-ui";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { MONTH_LABELS, formatRp, formatShortRp } from "./data";
import { InsentifRangka, KonstantaCtx, useDashboard, usePeriode } from "./Rangka";
import {
    SalesBreakdown, SmBreakdown, SpvBreakdown, StatusBayar, TabelRincian, kolomPph, labelPph, sebabNolSpv, useInsentifSm, useInsentifSpv,
    type SmIncentiveRow, type SpvIncentiveRow,
} from "./Rincian";

/** Baris GET payments. Tanggal bayar datang sebagai teks ISO dari JSON (tipe lama menyebut number); pencatat diisi server saat lunas. */
type Bayar = Omit<PaymentRow, "paymentDate"> & { paymentDate: string | number | null; paidByName?: string | null };

interface Baris {
    role: PayeeRole; salesCode: string; salesName: string; principle: string; branch: string;
    total: number; drift: number; paymentId: string | null; status: string; bayar?: Bayar;
}

const LABEL_PERAN: Record<PayeeRole, string> = { sales: "Sales", spv: "SPV", sm: "SM" };
const KOSONG: ReadonlySet<string> = new Set();
const fmtTanggal = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Makassar" });
const tanggalWita = (v: string | number | Date) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : fmtTanggal.format(d); };
/** "YYYY-MM-DD" (tanggal WITA dari isian) → dd/mm/yyyy tanpa melewati zona waktu. */
const ymdTampil = (ymd: string) => ymd.split("-").reverse().join("/");
const principal = (r: Baris) => (r.principle === PAYEE_PRINCIPLE_ALL ? "—" : r.principle);
const namaBaris = (r: Baris) => (r.role === "sales" ? `${r.salesName} ${r.principle}` : `${LABEL_PERAN[r.role]} ${r.salesName}`);
/** "HTTP 500" mentah tidak tampil (aturan 5 brief); pesan server tetap. */
const sebabMuat = (e?: string) => (e && !/^HTTP \d+$/.test(e) ? e : "Server tidak memberi jawaban yang valid.");
/**
 * Nominal yang BENAR-BENAR menjadi lunas. Baris tanpa catatan dibuat (POST) dengan nominal hitung ulang di layar; baris yang sudah punya
 * catatan (belum/tunggakan) hanya diubah statusnya (PATCH {paymentStatus}) — server tidak menyentuh totalIncentive, jadi yang lunas
 * adalah nominal TERCATAT, yang bisa berbeda dari hitung ulang.
 */
const nominalLunas = (r: Baris) => (r.paymentId ? r.bayar?.totalIncentive ?? r.total : Math.round(r.total));
const bedaTercatat = (r: Baris) => r.paymentId !== null && r.status !== "lunas" && r.bayar !== undefined && Math.abs(r.bayar.totalIncentive - r.total) >= 1;
const PUTUS = "koneksi terputus; hasilnya tidak pasti — muat ulang untuk memeriksa";
/** Baris yang bisa ditandai lunas: belum lunas dan ada yang dibayar. Rp 0 tidak masuk daftar bayar; sebabnya tampil di baris. */
const bisaDibayar = (r: Baris) => r.status !== "lunas" && r.total > 0;

/**
 * Baris pembayaran periode terpilih: Sales + SPV + SM dihitung ulang dari dashboard, dicocokkan ke catatan incentive_payments.
 * Baris SPV/SM tersimpan di tabel yang sama dengan sales_code berprefiks (lib/insentif-payee), principle = PAYEE_PRINCIPLE_ALL.
 */
function barisBulan(month: number, apiRows: ApiRow[], spv: SpvIncentiveRow[], sm: SmIncentiveRow[], payments: Bayar[]): Baris[] {
    const findPay = (salesCode: string, principle: string) =>
        payments.find((p) => p.salesCode === salesCode && p.principle === principle && p.periodMonth === month);
    // Baris LUNAS menampilkan angka yang BENAR-BENAR dibayar (snapshot di incentive_payments), bukan hasil hitung-ulang. Kalau
    // support/target diubah setelah pembayaran, keduanya berbeda — selisihnya ditandai supaya Finance tahu ada kelebihan/kekurangan
    // bayar, bukan diam-diam menampilkan angka baru dengan badge "lunas" (audit temuan M9).
    const settle = (live: number, pay: Bayar | undefined) => {
        const isLunas = pay?.paymentStatus === "lunas";
        const paid = pay?.totalIncentive ?? 0;
        return { total: isLunas ? paid : live, drift: isLunas && Math.abs(paid - live) >= 1 ? live - paid : 0 };
    };
    const sales = apiRows.map((r): Baris => {
        const pay = findPay(r.salesCode, r.principle);
        return { role: "sales", salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, branch: r.branch, ...settle(r.incentive.total, pay), paymentId: pay?.id ?? null, status: pay?.paymentStatus ?? r.paymentStatus, bayar: pay };
    });
    const extra = [
        ...spv.map((r) => ({ role: "spv" as PayeeRole, name: r.spvName, total: r.total })),
        ...sm.map((r) => ({ role: "sm" as PayeeRole, name: r.smName, total: r.total })),
    ].map((r): Baris => {
        const salesCode = payeeCode(r.role, r.name);
        const pay = findPay(salesCode, PAYEE_PRINCIPLE_ALL);
        return { role: r.role, salesCode, salesName: r.name, principle: PAYEE_PRINCIPLE_ALL, branch: PAYEE_PRINCIPLE_ALL, ...settle(r.total, pay), paymentId: pay?.id ?? null, status: pay?.paymentStatus ?? "belum", bayar: pay };
    });
    return [...sales, ...extra];
}

type RingkasBulan = { month: number; label: string; total: number; belumDibayar: number; status: "lunas" | "tunggakan" | "belum" | "tidak lengkap"; belumDihitung: boolean };

/**
 * Ubin 12 bulan. Periode berjalan dihitung ULANG dari dashboard, bukan dibaca dari incentive_payments: baris di tabel itu baru ada
 * setelah seseorang menandai lunas, jadi bulan yang insentifnya sudah dihitung tapi belum dibayar sepeser pun tampil "-" — persis
 * kebalikan dari yang dicari Finance, yaitu berapa yang MASIH HARUS dibayar (dilaporkan user 2026-08-26). Bulan lain tetap dari
 * catatan pembayaran: hitungan hidup untuk bulan lampau tidak tersedia (target/realisasinya bukan periode yang sedang dimuat).
 */
function ringkasan12Bulan(month: number, rows: Baris[], payments: Bayar[], lengkap: boolean): RingkasBulan[] {
    return Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const monthPayments = payments.filter((p) => p.periodMonth === m);
        const ini = m === month;
        const total = ini ? rows.reduce((a, r) => a + r.total, 0) : monthPayments.reduce((a, p) => a + p.totalIncentive, 0);
        const belumDibayar = ini
            ? rows.filter((r) => r.status !== "lunas").reduce((a, r) => a + r.total, 0)
            : monthPayments.filter((p) => p.paymentStatus !== "lunas").reduce((a, p) => a + p.totalIncentive, 0);
        const hasLunas = monthPayments.some((p) => p.paymentStatus === "lunas");
        const hasTunggakan = monthPayments.some((p) => p.paymentStatus === "tunggakan");
        // Bulan terpilih dengan sumber hitung (sales/SPV/SM) yang gagal dimuat tidak boleh terbaca Lunas: barisnya belum semua ada.
        const status = ini && !lengkap ? "tidak lengkap" : hasTunggakan ? "tunggakan" : hasLunas && belumDibayar === 0 ? "lunas" : "belum";
        // Bulan yang bukan periode terpilih DAN belum punya satu pun catatan pembayaran tidak diketahui nilainya — bukan nol.
        // Menampilkannya sebagai "-" terbaca "tidak ada yang harus dibayar", padahal artinya "belum dihitung".
        return { month: m, label: MONTH_LABELS[i], total, belumDibayar, status, belumDihitung: !ini && monthPayments.length === 0 };
    });
}

const STATUS_UBIN: Partial<Record<RingkasBulan["status"], { tone: Tone; label: string }>> = {
    lunas: { tone: "pos", label: "Lunas" },
    tunggakan: { tone: "neg", label: "Tunggakan" },
    "tidak lengkap": { tone: "warn", label: "Belum lengkap" },
};

function UbinBulan({ ringkas, month, year, pilih, tersaring }: { ringkas: RingkasBulan[]; month: number; year: number; pilih: (m: number) => void; tersaring: boolean }) {
    return (
        <Section title={`Rekap pembayaran ${year}`}
            subtitle={`Klik bulan untuk memuat periodenya; bulan terpilih selalu dihitung ulang dari Dashboard. Bulan lain hanya menampilkan catatan pembayaran yang sudah ada; "?" berarti belum pernah dihitung, bukan nol.${tersaring ? " Ubin menjumlah semua principal termasuk SPV dan SM, tanpa saringan." : ""}`}>
            <div className="fi-sect-in">
                <div role="group" aria-label={`Pilih bulan ${year}`} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                    {ringkas.map((m) => {
                        const st = m.belumDihitung ? undefined : STATUS_UBIN[m.status];
                        return (
                            <button key={m.month} type="button" className="fi-kc" aria-pressed={m.month === month} onClick={() => pilih(m.month)}>
                                <span>{m.label}</span>
                                <strong className="fi-tnum">{m.belumDihitung ? "?" : m.total ? formatShortRp(m.total) : "-"}</strong>
                                {m.belumDihitung ? <small>belum dihitung</small>
                                    : m.belumDibayar > 0 && m.status !== "lunas" ? <small className="fi-tnum">belum: {formatShortRp(m.belumDibayar)}</small> : null}
                                {st ? <span className="justify-self-start"><StatusBadge tone={st.tone}>{st.label}</StatusBadge></span> :!m.belumDihitung && m.belumDibayar === 0 && <small>Belum dibayar</small>}
                            </button>
                        );
                    })}
                </div>
            </div>
        </Section>
    );
}

type Peran = "semua" | "sales" | "spvsm";

export default function Pembayaran({ permKeys }: { permKeys: string[] }) {
    const { month, year, principle, branch, ubah, label } = usePeriode();
    const izinBayar = permKeys.includes("insentif_sales.manage_payment");
    // Dashboard dimuat TANPA saringan: saringan principal/cabang diterapkan di klien supaya penerima terpilih di luar saringan tetap
    // ikut dihitung dan disimpan (lihat `tersembunyi`), seperti saringan principle di FinanceView lama.
    const [dash, muatDash] = useDashboard({ month, year, principle: "ALL", branch: "ALL" });
    // Insentif SPV & SM ikut dibayar dari tabel yang sama — diambil dari endpoint hitungannya masing-masing, karena baris dashboard
    // hanya berisi baris per-sales. Baris disimpan UTUH (bukan nama+total): rinciannya dipakai baris rincian di tabel ini.
    const [spvLoad, muatSpv] = useInsentifSpv(month, year);
    const [smLoad, muatSm] = useInsentifSm(month, year);
    const [bayarLoad, muatBayar] = useLoad(useCallback(() => ambil<Bayar[]>(`/api/insentif-sales/payments?year=${year}`, (j) => (j as { rows?: Bayar[] }).rows ?? []), [year]));
    const k = dash.data?.konstanta ?? DEFAULT_KONSTANTA;

    const apiRows = useMemo(() => dash.data?.rows ?? [], [dash.data]);
    const spvRows = useMemo(() => spvLoad.data ?? [], [spvLoad.data]);
    // SM di luar whitelist total-nya 0 — jangan bikin baris pembayaran kosong.
    const smRows = useMemo(() => (smLoad.data ?? []).filter((r) => r.total > 0), [smLoad.data]);
    const payments = useMemo(() => bayarLoad.data ?? [], [bayarLoad.data]);
    const detailRows = useMemo(() => barisBulan(month, apiRows, spvRows, smRows, payments), [month, apiRows, spvRows, smRows, payments]);
    const lengkap = ![dash, spvLoad, smLoad].some((l) => l.status === "galat");
    const ringkas = useMemo(() => ringkasan12Bulan(month, detailRows, payments, lengkap), [month, detailRows, payments, lengkap]);

    // Rincian hanya ada untuk periode berjalan: catatan incentive_payments menyimpan nominal saja, bukan target/realisasinya.
    const salesByKey = useMemo(() => new Map(apiRows.map((r) => [`${r.salesCode}|${r.principle}`, r])), [apiRows]);
    const spvByName = useMemo(() => new Map(spvRows.map((r) => [r.spvName, r])), [spvRows]);
    const smByName = useMemo(() => new Map(smRows.map((r) => [r.smName, r])), [smRows]);

    const [peran, setPeran] = useState<Peran>("semua");
    const cocokSaringan = (r: Baris) => (principle === "ALL" || r.principle === principle) && (branch === "ALL" || r.branch === branch);
    const cocokPeran = (r: Baris) => peran === "semua" || (peran === "sales") === (r.role === "sales");
    const tersaring = detailRows.filter(cocokSaringan);
    const terlihat = tersaring.filter(cocokPeran);
    const hapusSaringan = () => { setPeran("semua"); ubah({ principle: "ALL", branch: "ALL" }); };

    // Pilihan = draf layar ini. Terikat ke periode: pindah bulan mengosongkannya, supaya penerima yang dicentang untuk September
    // tidak ikut ditandai lunas di Oktober.
    const periode = `${year}-${month}`;
    const [pilihan, setPilihan] = useState<{ periode: string; keys: ReadonlySet<string> }>({ periode, keys: KOSONG });
    const selected = pilihan.periode === periode ? pilihan.keys : KOSONG;
    const pilih = (keys: ReadonlySet<string>) => setPilihan({ periode, keys });
    const dipilih = detailRows.filter((r) => selected.has(paymentSelectionKey(r)) && bisaDibayar(r));
    // Centang di luar saringan TETAP ikut dibayar — menyembunyikannya tanpa memberi tahu berarti Finance menandai lunas uang yang
    // tidak dilihatnya. Namanya disebut, bukan dibuang diam-diam.
    const tersembunyi = dipilih.filter((r) => !(cocokSaringan(r) && cocokPeran(r)));
    useUnsavedGuard(dipilih.length > 0);

    const bruto = dipilih.reduce((a, r) => a + nominalLunas(r), 0);
    // Per baris, bukan atas jumlahnya: yang ditransfer adalah netto tiap penerima, jadi pembulatan PPh-nya juga per penerima.
    const netto = dipilih.reduce((a, r) => a + nettoInsentif(nominalLunas(r), k.pph.rate), 0);
    const tercatatBeda = dipilih.filter(bedaTercatat);
    const perPeran = (["sales", "spv", "sm"] as const).map((p) => [p, dipilih.filter((r) => r.role === p).length] as const).filter(([, n]) => n > 0)
        .map(([p, n]) => `${n} ${LABEL_PERAN[p]}`).join(", ");
    const nama = (xs: Baris[]) => xs.slice(0, 10).map((r) => r.salesName).join(", ") + (xs.length > 10 ? `, dan ${xs.length - 10} lainnya` : "");

    const memuat = dash.status === "memuat" || spvLoad.status === "memuat" || smLoad.status === "memuat" || bayarLoad.status === "memuat";
    const [dialog, setDialog] = useState(false);
    const [pesan, setPesan] = useState<string | null>(null);
    // Tanggal bayar (owner 8 Okt, S4c-2): tanggal WITA pilihan Finance, bawaan hari ini; dikirim sebagai `paymentDate` di POST dan PATCH.
    // Sahnya dinilai dengan fungsi yang sama dengan server (lib/insentif-payment-date): bukan masa depan WITA, tidak sebelum tanggal 1 periode.
    const [tanggalBayar, setTanggalBayar] = useState("");
    const hariIni = todayWita(new Date());
    const awalPeriode = `${year}-${String(month).padStart(2, "0")}-01`;
    const galatTanggal = !tanggalBayar ? "Isi tanggal bayar dulu"
        : "error" in parsePaymentDate(tanggalBayar, { periodMonth: month, periodYear: year }, new Date())
            ? `Tanggal bayar harus ${ymdTampil(awalPeriode)} s.d. ${ymdTampil(hariIni)} (WITA)` : undefined;
    // Dibaca saat diklik, bukan dari render terakhir: dialog yang dibuka lewat 00.00 WITA tidak membawa tanggal kemarin.
    const bukaDialog = () => { setTanggalBayar(todayWita(new Date())); setDialog(true); };
    const muatSemua = () => { muatDash(); muatSpv(); muatSm(); muatBayar(); };
    // Sumber yang gagal dimuat (juga muat ulang yang gagal dengan data lama) MENGUNCI penandaan: status di layar bisa usang — baris yang
    // baru saja lunas tampil "Belum dibayar" dan POST kedua akan menimpa tanggal bayar/pencatatnya (risiko transfer ganda).
    const gagalMuat = ([["status pembayaran", bayarLoad], ["insentif sales", dash], ["insentif SPV", spvLoad], ["insentif SM", smLoad]] as const)
        .filter(([, l]) => l.status === "galat").map(([n]) => n);
    const terkunci = memuat ? "Menunggu data selesai dimuat"
        : gagalMuat.length ? `Data ${gagalMuat.join(", ")} gagal dimuat — muat ulang dulu sebelum menandai` : undefined;
    const alasanTandai = !izinBayar ? "Butuh izin kelola pembayaran insentif"
        : terkunci ?? (dipilih.length === 0 ? "Pilih penerima yang belum dibayar dulu" : undefined);
    const bolehPilih = (r: Baris) => izinBayar && !terkunci && bisaDibayar(r);

    /**
     * Panggilan dan urutannya sama dengan handleMarkLunas lama: satu permintaan per penerima, paralel; gagal sebagian dipertahankan.
     * Tambahan kontrak #134: `paymentDate` (YYYY-MM-DD WITA) di POST dan PATCH; 400 server (tanggal tidak sah) tampil di dialog per penerima.
     */
    async function tandaiLunas() {
        const daftar = dipilih;
        const paymentDate = tanggalBayar;
        const results = await Promise.allSettled(daftar.map(async (row) => {
            // Upsert payment record dulu jika belum ada. Galat jaringan: permintaan mungkin sudah sampai — disebut tidak pasti.
            const res = await (!row.paymentId
                ? fetch("/api/insentif-sales/payments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        salesCode: row.salesCode,
                        salesName: row.salesName,
                        principle: row.principle,
                        branch: row.branch || PAYEE_PRINCIPLE_ALL,
                        periodMonth: month,
                        periodYear: year,
                        totalIncentive: Math.round(row.total),
                        paymentStatus: "lunas",
                        paymentDate,
                    }),
                })
                : fetch(`/api/insentif-sales/payments/${row.paymentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ paymentStatus: "lunas", paymentDate }),
                })).catch(() => { throw new Error(PUTUS); });
            if (!res.ok) {
                const data = await readApi(res).catch(() => ({} as Record<string, unknown>));
                throw new Error(typeof data.error === "string" ? data.error : row.paymentId ? "Gagal memperbarui status pembayaran." : "Gagal membuat status pembayaran.");
            }
            return paymentSelectionKey(row);
        }));
        const berhasil = new Set(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
        const gagal = daftar.flatMap((row, i) => { const r = results[i]; return r.status === "rejected" ? [`${row.salesName}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []; });
        setPilihan((p) => ({ periode: p.periode, keys: new Set([...p.keys].filter((key) => !berhasil.has(key))) }));
        muatBayar();
        const nettoOk = daftar.filter((r) => berhasil.has(paymentSelectionKey(r))).reduce((a, r) => a + nettoInsentif(nominalLunas(r), k.pph.rate), 0);
        if (berhasil.size > 0) setPesan(`${berhasil.size} pembayaran ${label} ditandai lunas ${jamWita(new Date())} · netto ${formatRp(nettoOk)} · tanggal bayar ${ymdTampil(paymentDate)}.`);
        if (gagal.length === 0) {
            setDialog(false);
            toast.success(`${berhasil.size} pembayaran ditandai lunas.`);
            return;
        }
        const rincian = gagal.slice(0, 5).join("; ") + (gagal.length > 5 ? `; dan ${gagal.length - 5} lainnya` : "");
        throw new Error(berhasil.size === 0
            ? `Semua ${gagal.length} pembayaran gagal diperbarui. Pilihan tetap dipertahankan. ${rincian}`
            : `${berhasil.size} pembayaran berhasil, ${gagal.length} gagal. Pilihan yang gagal tetap dipertahankan. ${rincian}`);
    }

    const sebab = (r: Baris) => {
        if (r.total > 0) return null;
        const sales = r.role === "sales" ? salesByKey.get(`${r.salesCode}|${r.principle}`) : undefined;
        const spv = r.role === "spv" ? spvByName.get(r.salesName) : undefined;
        return sales ? sebabNol(sales, k) : spv ? sebabNolSpv(spv, k) : null;
    };
    const status = (r: Baris) => {
        if (selected.has(paymentSelectionKey(r)) && bisaDibayar(r)) return <StatusBadge tone="info">Akan dibayar</StatusBadge>;
        const b = r.status === "lunas" ? r.bayar : undefined;
        const ket = b?.paymentDate ? `${tanggalWita(b.paymentDate)}${b.paidByName ? ` · ${b.paidByName}` : ""}` : "";
        return <><StatusBayar status={r.status} />{ket && <span className="fi-sub">{ket}</span>}</>;
    };
    const catatan = (r: Baris) => {
        const s = sebab(r);
        return <>
            {s && <span className="fi-sub">Rp 0 · {s}</span>}
            {bedaTercatat(r) && <span className="fi-sub fi-why">tercatat {formatRp(nominalLunas(r))} — nominal ini yang ditandai lunas</span>}
            {r.drift !== 0 && (
                <span className="fi-sub fi-why" title="Angka dibayar berbeda dari hasil hitung ulang — support/target berubah setelah pembayaran.">
                    hitung ulang: {formatRp(r.total + r.drift)}
                </span>
            )}
        </>;
    };
    const kotak = (r: Baris) => (
        <input type="checkbox" aria-label={`Pilih ${namaBaris(r)}`} checked={selected.has(paymentSelectionKey(r))} disabled={!bolehPilih(r)} title={izinBayar ? terkunci : "Butuh izin kelola pembayaran insentif"}
            onChange={() => { const next = new Set(selected); const key = paymentSelectionKey(r); if (next.has(key)) next.delete(key); else next.add(key); pilih(next); }} />
    );

    const kolom: Column<Baris>[] = [
        { key: "penerima", header: "Penerima", cell: (r) => <><b>{r.salesName}</b><span className="fi-sub"><span className="fi-mono">{r.salesCode}</span></span></> },
        { key: "peran", header: "Peran", cell: (r) => LABEL_PERAN[r.role] },
        { key: "principal", header: "Principal", secondary: true, cell: principal },
        { key: "bruto", header: "Bruto", align: "end", cell: (r) => <><b>{formatRp(r.total)}</b>{catatan(r)}</> },
        // PPh/netto dari nominal yang SUNGGUH ditandai lunas (tercatat bila sudah ada catatan), sama dengan footer dan dialog.
        ...kolomPph<Baris>(k, nominalLunas),
        { key: "status", header: "Status", cell: status },
    ];

    const d = dash.data;
    const sumberGagal = [
        spvLoad.status === "galat" && !spvLoad.data ? { apa: "SPV", error: spvLoad.error, ulang: muatSpv } : null,
        smLoad.status === "galat" && !smLoad.data ? { apa: "SM", error: smLoad.error, ulang: muatSm } : null,
    ].filter((x) => x !== null);
    // Muat ulang yang gagal (data lama tetap tampil) disebut di strip tabel; sumber mana pun cukup.
    const galatUlang = [dash, spvLoad, smLoad, bayarLoad].find((l) => l.status === "galat" && l.data !== undefined);

    let isi: ReactNode;
    // Gagal memuat status pembayaran — juga muat ulang dengan data lama — mengganti seluruh tampilan, seperti kode lama: status usang
    // akan menampilkan baris yang baru saja lunas sebagai "Belum dibayar".
    if (bayarLoad.status === "galat") {
        isi = <ErrorState title="Data pembayaran belum berhasil dimuat." message={`${sebabMuat(bayarLoad.error)} Status belum ditampilkan agar kegagalan tidak terlihat sebagai belum dibayar.`} onRetry={muatBayar} />;
    } else if (dash.status === "galat" && !d) {
        isi = <ErrorState title={dash.error} message="Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid." onRetry={muatDash} />;
    } else if (!d || !bayarLoad.data) {
        isi = <><Skeleton rows={3} label="Memuat status pembayaran" /><Skeleton rows={6} label="Memuat penerima" /></>;
    } else {
        isi = (
            <>
                <div className={memuat ? "fi-busy" : undefined} aria-busy={memuat || undefined}>
                    <UbinBulan ringkas={ringkas} month={month} year={year} pilih={(m) => ubah({ month: String(m) })} tersaring={principle !== "ALL" || branch !== "ALL" || peran !== "semua"} />
                </div>
                {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
                {sumberGagal.map((s) => (
                    <MessageStrip key={s.apa} tone="neg" title={s.error ?? `Insentif ${s.apa} belum berhasil dimuat.`}>
                        Baris {s.apa} tidak ada di daftar dan total bulan ini belum termasuk {s.apa}.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={s.ulang}>Coba lagi</button>
                    </MessageStrip>
                ))}
                {tersembunyi.length > 0 && (
                    <MessageStrip tone="info" title={`${tersembunyi.length} penerima terpilih tidak terlihat karena saringan:`}>
                        {nama(tersembunyi)}.{tersembunyi.some((r) => r.role !== "sales") && " SPV dan SM tidak berprincipal dan tidak bercabang."} Mereka ikut ditandai lunas.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={hapusSaringan}>Tampilkan</button>
                    </MessageStrip>
                )}
                <TabelRincian<Baris>
                    title={`Insentif ${label}`} count={terlihat.length} columns={kolom} rows={terlihat} rowKey={paymentSelectionKey} rowLabel={namaBaris}
                    status={galatUlang ? "galat" : memuat ? "memuat" : "siap"} error={galatUlang?.error} onRetry={muatSemua}
                    selected={selected} onSelectedChange={pilih} selectableRow={bolehPilih}
                    actions={
                        <div className="fi-segs" role="group" aria-label="Peran penerima">
                            {([["semua", "Semua"], ["sales", "Sales"], ["spvsm", "SPV & SM"]] as const).map(([v, l]) => (
                                <button key={v} type="button" aria-pressed={peran === v} onClick={() => setPeran(v)}>
                                    {l} {v === "semua" ? tersaring.length : tersaring.filter((r) => (v === "sales") === (r.role === "sales")).length}
                                </button>
                            ))}
                        </div>
                    }
                    empty={detailRows.length === 0
                        ? { title: `Belum ada insentif ${label}`, message: "Insentif periode ini belum dihitung: target atau progres belum diunggah. Pilih bulan lain di ubin di atas." }
                        : { title: "Tidak ada penerima untuk saringan ini", message: `${detailRows.length} penerima lain tersembunyi oleh saringan.`, action: <Button onClick={hapusSaringan}>Hapus saringan</Button> }}
                    rincian={(r) => {
                        const sales = r.role === "sales" ? salesByKey.get(`${r.salesCode}|${r.principle}`) : undefined;
                        const spv = r.role === "spv" ? spvByName.get(r.salesName) : undefined;
                        const sm = r.role === "sm" ? smByName.get(r.salesName) : undefined;
                        return sales ? <SalesBreakdown r={sales} semuaBaris={apiRows} />
                            : spv ? <SpvBreakdown rincian={spv.rincian} />
                                : sm ? <SmBreakdown r={sm} />
                                    : <p className="fi-small fi-muted">Rincian hanya tersedia untuk periode yang dihitung ulang ({label}). Catatan pembayaran menyimpan nominalnya saja, bukan target dan realisasinya.</p>;
                    }}
                    mobileItem={(r) => (
                        <div className="fi-wl-row">
                            {kotak(r)}
                            <ListItem doc={r.salesCode} amount={`Netto ${formatRp(nettoInsentif(nominalLunas(r), k.pph.rate))}`}
                                title={`${r.salesName} · ${LABEL_PERAN[r.role]}${r.role === "sales" ? ` · ${r.principle}` : ""}`}
                                meta={<>Bruto {formatRp(r.total)}{catatan(r)}</>} badge={status(r)} />
                        </div>
                    )}
                />
                <VariantNote bl="BL-27">
                    Lunas belum bisa dibatalkan dari layar ini. Bila BL-27 masuk, baris lunas mendapat aksi Batalkan lunas dengan alasan wajib, dan
                    status kembali Belum dibayar di daftar ini.
                </VariantNote>
                <FooterToolbar message={dipilih.length > 0
                    ? <span className="fi-sum"><b>{dipilih.length} dipilih</b> · Bruto {formatRp(bruto)} · {labelPph(k.pph.rate)} -{formatRp(bruto - netto)} · Netto <b>{formatRp(netto)}</b>{tersembunyi.length > 0 && ` · ${tersembunyi.length} di luar saringan`}{terkunci && <span className="fi-why"> · {terkunci}</span>}</span>
                    : alasanTandai}>
                    {dipilih.length > 0 && <Button variant="tertiary" onClick={() => pilih(KOSONG)}>Kosongkan pilihan</Button>}
                    <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={Boolean(alasanTandai)} disabledReason={alasanTandai} onClick={bukaDialog}>
                        {dipilih.length > 0 ? `Tandai ${dipilih.length} lunas…` : "Tandai lunas…"}
                    </Button>
                </FooterToolbar>
            </>
        );
    }

    return (
        // Rincian dan kolom PPh membaca konstanta yang dipakai server; bawaan hanya berlaku sebelum data pertama datang.
        <KonstantaCtx.Provider value={k}>
            <InsentifRangka
                halaman="pembayaran"
                permKeys={permKeys}
                deskripsi={`Bruto, ${labelPph(k.pph.rate)}, dan netto per penerima (sales, SPV, SM). Bulan terpilih dihitung ulang dari Dashboard; baris lunas memakai nominal yang dibayar.`}
                saringan={{ principals: dengan(d?.opsiFilter.principles ?? [], principle), branches: dengan(d?.opsiFilter.branches ?? [], branch) }}
                aksi={
                    <>
                        {dipilih.length > 0 && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Pilihan belum disimpan</span>}
                        <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={memuat && Boolean(d)} onClick={muatSemua}>Muat ulang</Button>
                    </>
                }
            >
                {isi}
                <ConfirmDialog
                    open={dialog}
                    onClose={() => setDialog(false)}
                    title={`Tandai ${dipilih.length} penerima ${label} lunas?`}
                    tag="Pembayaran"
                    confirmLabel="Tandai lunas"
                    confirmDisabled={dipilih.length === 0 ? "Tidak ada penerima terpilih" : terkunci ?? galatTanggal}
                    facts={[
                        ["Penerima", perPeran || "—"],
                        ["Bruto", formatRp(bruto)],
                        [labelPph(k.pph.rate), `-${formatRp(bruto - netto)}`],
                        ["Netto dibayar", <b key="n">{formatRp(netto)}</b>],
                        ["Tanggal bayar", galatTanggal ? "—" : `${ymdTampil(tanggalBayar)} (WITA) · dicatat bersama nama Anda`],
                        ...(tercatatBeda.length > 0 ? [["Nominal tercatat", `${tercatatBeda.length} penerima sudah punya catatan; yang lunas adalah nominal tercatat, bukan hitung ulang: `
                            + tercatatBeda.slice(0, 5).map((r) => `${r.salesName} tercatat ${formatRp(nominalLunas(r))}, hitung ulang ${formatRp(r.total)}`).join("; ")] as [string, string]] : []),
                        ...(tersembunyi.length > 0 ? [["Di luar saringan", `${tersembunyi.length} ikut ditandai: ${nama(tersembunyi)}`] as [string, string]] : []),
                    ]}
                    onConfirm={tandaiLunas}
                >
                    <FormField label="Tanggal bayar" required error={tanggalBayar && galatTanggal ? galatTanggal : undefined}
                        help={`Tanggal transfer menurut WITA; bawaan hari ini. Boleh mundur sampai ${ymdTampil(awalPeriode)}, tidak boleh melewati hari ini.`}>
                        {(a) => <input {...a} className="fi-input" type="date" min={awalPeriode} max={hariIni} value={tanggalBayar} onChange={(e) => setTanggalBayar(e.target.value)} />}
                    </FormField>
                    <VariantNote bl="BL-27">
                        Penerima tanpa catatan pembayaran dicatat lunas dengan nominal hitung ulang yang dimuat di layar ini; penerima yang sudah
                        punya catatan hanya berubah status, dengan nominal tercatatnya. Bila BL-27 masuk, server menghitung ulang bruto, PPh, dan
                        netto saat Anda menandai lunas, dan menolak seluruhnya bila ada nominal yang berubah sejak halaman dimuat.
                    </VariantNote>
                    <VariantNote bl="BL-47">
                        Bukti transfer belum disimpan (tombol Upload bukti lama hanya memunculkan pesan dan sudah dihapus). Bila BL-47 masuk,
                        dialog ini meminta satu bukti transfer yang tertaut ke semua penerima di atas.
                    </VariantNote>
                </ConfirmDialog>
            </InsentifRangka>
        </KonstantaCtx.Provider>
    );
}

/** Pilihan dari URL tetap ada di daftar walau data belum datang, supaya select tidak diam-diam menampilkan "Semua". */
const dengan = (xs: string[], v: string) => (v === "ALL" || xs.includes(v) ? xs : [...xs, v]);
