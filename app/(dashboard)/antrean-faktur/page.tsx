/*
 * Tujuan: Satu layar untuk antrean faktur Accurate — yang menunggu, yang ditolak, yang TIDAK
 *         PASTI — dengan umur masalah dan eskalasi ke OM setelah 2 jam.
 * Caller: Route dashboard `/antrean-faktur`.
 * Dependensi: /api/invoice-outbox, /api/invoice-verify, components/ui/AsyncState, toast Sonner, lucide-react.
 * Main Functions: AntreanFakturPage, load, act, jelaskan.
 * Side Effects: HTTP; tindakan antrean hanya `resend` dan `discard` (khusus yang DITOLAK), dan
 *               penjelasan selisih verifikasi balik (tidak menyentuh Accurate).
 *
 * Laporan OM bukan halaman terpisah: saringan "hanya lewat 2 jam" pada layar ini adalah
 * laporannya — daftar yang sama, isian yang sama (faktur, sales, jenis masalah, umurnya),
 * dan tidak ada angka kedua yang bisa berbeda dari layar admin.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Send, Trash2, HelpCircle, CheckCircle2, Clock, ShieldCheck, ShieldAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { LoadingState } from "@/components/ui/AsyncState";

type Row = {
    orderId: string; soNo: string | null; source: string; customerNo: string; outlet: string; salesman: string;
    orderDate: string; state: string; attempts: number; lastError: string; accurateNumber: string;
    queuedBy: string; createdAt: string; updatedAt: string; ageMinutes: number; overdue: boolean;
};

type Batch = {
    id: string; fileName: string; principal: string; uploadedAt: string; uploadedBy: string;
    reviewCount: number; lineCount: number; ageMinutes: number; overdue: boolean;
};

type Jenis = "sales" | "isi";
type Finding = { line: number | null; field: string; expected: string; actual: string; jenis: Jenis | null; dijelaskan: boolean };

type Verified = {
    orderId: string; soNo: string | null; state: string; customerNo: string; orderDate: string;
    matchedBy: string; foundWhileUnknown: boolean; status: "cocok" | "selisih" | "tak-terperiksa";
    reason: string; findings: Finding[]; invoiceNumber: string; linesChecked: number; salesman: string;
    invoiceDate: string; terbuka: number; sidik: Record<Jenis, string>;
    penjelasan: Partial<Record<Jenis, { note: string; by: string; at: string }>>;
};

type Verify = { checked: number; summary: Record<string, number>; rows: Verified[] };

type Data = {
    escalateAfterMinutes: number;
    summary: Record<string, number>;
    overdue: number;
    overdueQueue: number;
    overdueBatches: number;
    reviewLinesOverdue: number;
    pendingBatches: Batch[];
    rows: Row[];
};

const STATES: { key: string; label: string; hint: string; className: string }[] = [
    { key: "queued", label: "Menunggu kirim", hint: "sudah diantrekan, belum dikirim", className: "text-slate-200" },
    { key: "sending", label: "Sedang dikirim", hint: "permintaan sedang berjalan", className: "text-blue-300" },
    { key: "rejected", label: "Ditolak Accurate", hint: "Accurate menjawab dan menolak; aman diperbaiki lalu dikirim ulang", className: "text-amber-300" },
    { key: "unknown", label: "TIDAK PASTI", hint: "Accurate tidak menjawab; fakturnya mungkin sudah terbentuk", className: "text-red-300" },
    { key: "posted", label: "Terkirim", hint: "faktur sudah terbentuk di Accurate", className: "text-emerald-300" },
];

/** ISO -> dd/mm/yyyy, sama dengan tanggal di Accurate. */
const tgl = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split("-").reverse().join("/") : iso);
const usia = (minutes: number) => (minutes < 60 ? `${minutes} menit` : `${Math.floor(minutes / 60)} jam ${minutes % 60} menit`);

export default function AntreanFakturPage() {
    const [data, setData] = useState<Data | null>(null);
    const [verify, setVerify] = useState<Verify | null>(null);
    const [picked, setPicked] = useState<string[]>([]);
    const [onlyOverdue, setOnlyOverdue] = useState(false);
    const [busy, setBusy] = useState(false);
    const [semuaVerifikasi, setSemuaVerifikasi] = useState(false);
    const [catatan, setCatatan] = useState<Record<string, string>>({});
    // Tanggal faktur pilihan saat kirim; kosong = tanggal SO masing-masing.
    const [tanggalFaktur, setTanggalFaktur] = useState("");

    // Memuat / siap / galat harus terlihat berbeda: tabel kosong saat masih memuat terbaca "tidak
    // ada faktur yang menggantung" — persis kesimpulan yang tidak boleh diambil di layar ini.
    const [status, setStatus] = useState<"memuat" | "siap" | "galat">("memuat");
    const [galat, setGalat] = useState("");
    const [verifyStatus, setVerifyStatus] = useState<"memuat" | "siap" | "galat">("memuat");
    const permintaan = useRef<AbortController | null>(null);

    const load = useCallback(async () => {
        permintaan.current?.abort();
        const ctrl = new AbortController();
        permintaan.current = ctrl;
        setStatus("memuat");
        try {
            const query = new URLSearchParams();
            if (picked.length) query.set("state", picked.join(","));
            if (onlyOverdue) query.set("overdue", "1");
            const res = await fetch(`/api/invoice-outbox?${query.toString()}`, { credentials: "include", signal: ctrl.signal });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? `Antrean gagal dimuat (HTTP ${res.status})`);
            setData(body);
            setStatus("siap");
        } catch (error) {
            if (ctrl.signal.aborted) return;
            setGalat(error instanceof Error ? error.message : "Antrean gagal dimuat");
            setStatus("galat");
            return;
        }

        // Verifikasi balik ikut dimuat sendiri, tanpa tombol: kalau harus ditekan, ia akan
        // lupa ditekan justru pada hari yang fakturnya salah.
        setVerifyStatus("memuat");
        try {
            const check = await fetch("/api/invoice-verify", { credentials: "include", signal: ctrl.signal });
            const checked = await check.json().catch(() => ({}));
            setVerify(check.ok && checked.ok ? checked : null);
            setVerifyStatus(check.ok && checked.ok ? "siap" : "galat");
        } catch {
            if (!ctrl.signal.aborted) setVerifyStatus("galat");
        }
    }, [picked, onlyOverdue]);

    useEffect(() => { void load(); return () => permintaan.current?.abort(); }, [load]);

    async function act(orderId: string, action: "resend" | "discard") {
        if (action === "discard" && !confirm(
            "Buang baris ini dari antrean? Fakturnya belum ada di Accurate, jadi aman. Pakai ini "
            + "kalau angkanya yang salah atau aturannya sudah berubah — batch yang sudah diperbaiki "
            + "bisa diantrekan ulang setelahnya dengan angka terbaru.")) return;
        setBusy(true);
        try {
            const res = await fetch("/api/invoice-outbox", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, action }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Tindakan gagal");
            toast.success(action === "resend" ? "Dilepas ulang ke antrean kirim" : "Dibuang dari antrean");
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Tindakan gagal");
        } finally {
            setBusy(false);
        }
    }

    /**
     * Kirim SEMUA yang menunggu, lalu baca balik hasilnya dari Accurate saat itu juga.
     * "Terkirim" saja belum berarti benar — yang dilaporkan berhasil hanya yang isinya
     * TERBUKTI sama dengan yang dikirim.
     */
    async function kirim() {
        const menunggu = data?.summary?.queued ?? 0;
        if (!menunggu) { toast.info("Tidak ada faktur yang menunggu kirim"); return; }
        const tanggal = tanggalFaktur ? tanggalFaktur.split("-").reverse().join("/") : "";
        if (!confirm(
            `Kirim ${menunggu} faktur ke Accurate sekarang?

`
            + `Tanggal faktur: ${tanggal || "tanggal SO masing-masing"}.`
            + (tanggal ? " Tanggal ini juga menentukan periode Accurate dan periode promo di Rekap Promo." : "")
            + "\n\nFaktur yang sudah terbentuk di Accurate TIDAK BISA ditarik. Setelah terkirim, "
            + "isinya langsung dibaca balik dari Accurate dan dibandingkan per baris.")) return;
        setBusy(true);
        try {
            const res = await fetch("/api/invoice-outbox/send", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoiceDate: tanggalFaktur || undefined }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error ?? "Pengiriman gagal");
            if (body.unknown > 0) {
                toast.error(`${body.unknown} faktur TIDAK PASTI nasibnya — Accurate tidak menjawab. Jangan dikirim ulang; cocokkan lewat charField1.`);
            }
            if (body.rejected > 0) toast.warning(`${body.rejected} ditolak Accurate; alasannya ada di kolom Jawaban Accurate`);
            if (body.mismatched > 0) {
                toast.error(`${body.mismatched} faktur terkirim TAPI isinya berselisih — buka Verifikasi balik`);
            } else if (body.unchecked > 0) {
                toast.warning(`${body.sent} terkirim, ${body.unchecked} belum bisa dibaca balik dari Accurate`);
            } else if (body.verifiedOk > 0) {
                toast.success(`${body.verifiedOk} faktur terkirim DAN terverifikasi cocok per baris`);
            }
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Pengiriman gagal");
        } finally {
            setBusy(false);
        }
    }

    /**
     * Jelaskan (atau cabut penjelasan) satu jenis selisih. Sales cukup diterima; isi faktur wajib
     * diberi alasan. Keduanya terpisah: menerima sales tidak ikut menutup selisih isi.
     */
    async function jelaskan(row: Verified, jenis: Jenis, cabut = false) {
        const note = jenis === "sales" ? "" : (catatan[row.orderId] ?? "").trim();
        if (!cabut && jenis === "isi" && !note) { toast.error("Tulis penjelasannya dulu, mis. koreksi qty saat pengiriman"); return; }
        setBusy(true);
        try {
            const res = await fetch("/api/invoice-verify", {
                method: cabut ? "DELETE" : "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: row.orderId, jenis, sidik: row.sidik[jenis], note }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Penjelasan gagal disimpan");
            toast.success(cabut ? "Penjelasan dicabut" : jenis === "sales" ? "Sales di Accurate diterima" : "Selisih isi dijelaskan");
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Penjelasan gagal disimpan");
        } finally {
            setBusy(false);
        }
    }

    // Yang perlu perhatian saja: selisih yang belum dijelaskan, dan baris TIDAK PASTI yang
    // fakturnya ternyata ada. Yang cocok atau sudah dijelaskan hanya tampil bila diminta.
    const verifyRows = (verify?.rows ?? []).filter((row) => semuaVerifikasi
        || (row.status === "selisih" && row.terbuka > 0) || row.foundWhileUnknown);

    const toggle = (key: string) => setPicked((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Antrean Faktur</h1>
                <p className="text-sm text-slate-400">
                    Faktur yang menunggu dikirim ke Accurate, yang ditolak, dan yang tidak jelas nasibnya.
                    Umur dihitung sejak faktur masuk antrean dan belum sampai ke Accurate — menekan
                    Kirim ulang tidak menyetel ulang jamnya. Lewat {data?.escalateAfterMinutes ?? 120} menit masuk laporan OM.
                </p>
            </header>

            {/* Ringkas: satu kalimat + satu tombol. Penjelasan laporan OM dipindah ke `title`
                supaya peringatan tidak menenggelamkan antrean di bawahnya. */}
            {!!data?.overdue && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5" role="alert"
                    title="Ini isi laporan OM. Batch yang barisnya masih perlu ditinjau ikut dihitung: belum masuk antrean bukan berarti tidak ada masalah, justru itu masalah yang diabaikan.">
                    <AlertTriangle className="shrink-0 text-red-300" size={18} aria-hidden="true" />
                    <p className="flex-1 text-sm text-red-200">
                        <strong className="font-semibold">{data.overdue} masalah lewat 2 jam</strong>
                        {" "}— {data.overdueQueue} di antrean faktur
                        {data.overdueBatches > 0 && <>, {data.overdueBatches} batch belum diantrekan ({data.reviewLinesOverdue} baris perlu ditinjau)</>}.
                        {" "}Masuk laporan OM.
                    </p>
                    <button type="button" onClick={() => setOnlyOverdue(true)} disabled={onlyOverdue}
                        className="rounded bg-red-500/20 px-3 py-1.5 text-sm text-red-100 disabled:opacity-60">
                        {onlyOverdue ? "Sedang ditampilkan" : "Tampilkan saja yang lewat 2 jam"}
                    </button>
                </div>
            )}

            {/* Dua kelompok yang tidak boleh terpisah: SARINGAN di kiri, TINDAKAN kirim (tidak bisa
                ditarik) di kanan bersama tanggal fakturnya. Sebelumnya tombol Kirim terbungkus ke
                baris sendiri, jauh dari pemilih tanggal yang menentukan isinya. */}
            <section className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Saring status antrean">
                    {STATES.map((state) => {
                        const jumlah = data?.summary?.[state.key] ?? 0;
                        const aktif = picked.includes(state.key);
                        return (
                            <button key={state.key} type="button" onClick={() => toggle(state.key)} title={state.hint} aria-pressed={aktif}
                                className={`rounded-full border px-3 py-1.5 text-xs ${aktif ? "border-blue-400 bg-blue-500/20" : "border-white/10 bg-black/20"}`}>
                                {/* Warna status hanya bila ADA isinya; nol tidak perlu menarik mata. */}
                                <span className={jumlah ? state.className : "text-slate-400"}>{state.label}</span>
                                <span className={`ml-2 tabular-nums ${jumlah ? "font-semibold text-slate-200" : "text-slate-500"}`}>{data ? jumlah : "…"}</span>
                            </button>
                        );
                    })}
                    <label className="ml-1 flex items-center gap-2 text-sm text-slate-300">
                        <input type="checkbox" checked={onlyOverdue} onChange={(event) => setOnlyOverdue(event.target.checked)} />
                        Hanya yang lewat 2 jam (laporan OM)
                    </label>
                    <button type="button" onClick={() => void load()} disabled={status === "memuat"}
                        className="inline-flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs disabled:opacity-60">
                        <RefreshCw size={13} className={status === "memuat" ? "animate-spin" : ""} /> {status === "memuat" ? "Memuat…" : "Muat ulang"}
                    </button>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Kirim ke Accurate">
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-300"
                        title="Kosong = tanggal SO masing-masing. Isi untuk memfakturkan order yang kemarin belum terproses dengan tanggal hari ini. Tidak boleh lebih awal dari tanggal SO.">
                        Tanggal faktur
                        <input type="date" value={tanggalFaktur} max={new Date().toLocaleDateString("en-CA")}
                            onChange={(event) => setTanggalFaktur(event.target.value)}
                            className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-slate-200" />
                    </label>
                    {tanggalFaktur
                        ? <button type="button" onClick={() => setTanggalFaktur("")} className="text-xs text-slate-400 underline" title="Kembali ke tanggal SO">pakai tanggal SO</button>
                        : <span className="text-xs text-slate-500">kosong = tanggal SO</span>}
                    <button type="button" onClick={() => void kirim()} disabled={busy || !(data?.summary?.queued ?? 0)}
                        title="Kirim semua faktur yang menunggu ke Accurate, lalu baca balik hasilnya dari Accurate dan bandingkan per baris"
                        className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40">
                        <Upload size={14} /> {busy ? "Memproses…" : `Kirim ${data?.summary?.queued ?? 0} faktur ke Accurate`}
                    </button>
                </div>
            </section>

            {status === "galat" && (
                <div className="flex flex-wrap items-center gap-3 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm" role="alert">
                    <span className="text-red-300">
                        {data ? `Gagal memperbarui antrean: ${galat}. Angka di bawah hasil pemuatan sebelumnya.` : `Antrean gagal dimuat: ${galat}.`}
                    </span>
                    <button type="button" onClick={() => void load()} className="rounded bg-white/10 px-2.5 py-1 text-xs">Coba lagi</button>
                </div>
            )}

            {/* Ringkas satu baris, dibuka bila perlu: antrean kirim di bawahnya harus terlihat tanpa
                menggulir. Angka merahnya tetap selalu terlihat di baris ringkasan. */}
            <details className="rounded-lg border border-white/10 bg-black/20">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3">
                    <span className="font-medium text-white">Verifikasi balik faktur Accurate</span>
                    {!verify && verifyStatus === "memuat" && <span className="text-xs text-slate-500" role="status">Memeriksa faktur di Accurate…</span>}
                    {!verify && verifyStatus === "galat" && <span className="text-xs text-red-300" role="alert">Verifikasi balik gagal dimuat — buka Muat ulang</span>}
                    {verify && (
                        <span className="text-xs text-slate-400">
                            {verify.checked} diperiksa ·{" "}
                            <span className="text-emerald-300">{verify.summary.cocok ?? 0} cocok</span> ·{" "}
                            <span className={verify.summary.selisih ? "font-semibold text-red-300" : "text-slate-400"}>
                                {verify.summary.selisih ?? 0} selisih belum dijelaskan
                            </span> ·{" "}
                            <span className="text-slate-300">{verify.summary.dijelaskan ?? 0} sudah dijelaskan</span> ·{" "}
                            <span className="text-amber-300">{verify.summary["tak-terperiksa"] ?? 0} belum bisa diperiksa</span>
                        </span>
                    )}
                </summary>
                <div className="space-y-2 border-t border-white/10 p-4">
                    <p className="text-xs text-slate-500">
                        Isi faktur di Accurate disandingkan dengan payload yang dikirim — satuan, qty, harga,
                        diskon persen, nilai baris, PPN, sales, dan cabang penomoran — dihubungkan lewat{" "}
                        <span className="font-mono">charField1</span>. Sales yang diganti di Accurate cukup diterima;
                        isi yang dikoreksi saat pengiriman wajib dijelaskan. Keduanya terpisah, dan penjelasan
                        berhenti berlaku kalau fakturnya berubah lagi.
                    </p>
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                        <input type="checkbox" checked={semuaVerifikasi} onChange={(event) => setSemuaVerifikasi(event.target.checked)} />
                        Tampilkan semua (termasuk yang cocok dan yang sudah dijelaskan)
                    </label>
                    <div className="overflow-x-auto rounded-lg border border-white/10">
                        <table className="w-full text-sm">
                            <thead className="bg-white/5 text-slate-400">
                                <tr>
                                    <th className="px-3 py-2 text-left">SO</th>
                                    <th className="px-3 py-2 text-left">Faktur Accurate</th>
                                    <th className="px-3 py-2 text-left">Hasil</th>
                                    <th className="px-3 py-2 text-left">Temuan</th>
                                </tr>
                            </thead>
                            <tbody>
                                {verifyRows.map((row) => (
                                    <tr key={row.orderId} className={`border-t border-white/5 ${row.terbuka > 0 ? "bg-red-500/5" : ""}`}>
                                        <td className="px-3 py-2 font-mono text-xs">
                                            {row.soNo ?? row.orderId}
                                            <div className="text-slate-500">{row.customerNo}</div>
                                        </td>
                                        <td className="px-3 py-2 text-xs">
                                            {row.invoiceNumber || "—"}
                                            <div className="text-slate-500">
                                                {row.matchedBy ? `dicocokkan lewat ${row.matchedBy}` : "belum ketemu"}
                                                {row.invoiceDate ? ` · tgl ${row.invoiceDate}` : ""}
                                                {row.salesman ? ` · sales ${row.salesman}` : " · tanpa sales"}
                                            </div>
                                        </td>
                                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                                            {row.status === "cocok" && (
                                                <span className="text-emerald-300">
                                                    <ShieldCheck size={13} className="mr-1 inline" />
                                                    cocok ({row.linesChecked} baris)
                                                </span>
                                            )}
                                            {row.status === "selisih" && row.terbuka > 0 && (
                                                <span className="text-red-300">
                                                    <ShieldAlert size={13} className="mr-1 inline" />
                                                    {row.terbuka} selisih belum dijelaskan
                                                </span>
                                            )}
                                            {row.status === "selisih" && row.terbuka === 0 && (
                                                <span className="text-slate-300">
                                                    <CheckCircle2 size={13} className="mr-1 inline" />
                                                    {row.findings.length} selisih dijelaskan
                                                </span>
                                            )}
                                            {row.status === "tak-terperiksa" && (
                                                <span className="text-amber-300">
                                                    <HelpCircle size={13} className="mr-1 inline" /> belum bisa diperiksa
                                                </span>
                                            )}
                                            {row.foundWhileUnknown && (
                                                <div className="text-red-300">fakturnya ADA di Accurate padahal berstatus TIDAK PASTI</div>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-xs">
                                            {row.status === "tak-terperiksa" && <span className="text-amber-200/90">{row.reason}</span>}
                                            {row.findings.map((finding, index) => (
                                                <div key={index} className={finding.dijelaskan ? "text-slate-500" : "text-red-200/90"}>
                                                    {finding.line ? `baris ${finding.line} · ` : ""}{finding.field}: dikirim{" "}
                                                    <span className="font-mono">{finding.expected}</span>, di Accurate{" "}
                                                    <span className="font-mono">{finding.actual}</span>
                                                    {finding.jenis === null && <span className="text-red-300"> — bereskan di Accurate, tidak bisa dijelaskan</span>}
                                                </div>
                                            ))}
                                            {(["sales", "isi"] as const).filter((jenis) => row.findings.some((finding) => finding.jenis === jenis)).map((jenis) => {
                                                const sudah = row.penjelasan[jenis];
                                                return (
                                                    <div key={jenis} className="mt-2 flex flex-wrap items-center gap-2">
                                                        {sudah ? (
                                                            <>
                                                                <span className="text-emerald-300">
                                                                    <CheckCircle2 size={12} className="mr-1 inline" />
                                                                    {jenis === "sales" ? "Sales di Accurate diterima" : `Isi dijelaskan: ${sudah.note}`}
                                                                </span>
                                                                <span className="text-slate-500">{sudah.by} · {new Date(sudah.at).toLocaleString("id-ID")}</span>
                                                                <button onClick={() => void jelaskan(row, jenis, true)} disabled={busy}
                                                                    className="rounded bg-white/10 px-2 py-0.5 text-slate-300 disabled:opacity-40">Cabut</button>
                                                            </>
                                                        ) : jenis === "sales" ? (
                                                            <button onClick={() => void jelaskan(row, "sales")} disabled={busy}
                                                                title="Sales sudah diganti di Accurate (mis. sales lama pindah divisi). Selisih isi faktur, kalau ada, tetap terbuka."
                                                                className="rounded bg-blue-500/20 px-2 py-1 text-blue-100 disabled:opacity-40">
                                                                Terima sales di Accurate
                                                            </button>
                                                        ) : (
                                                            <>
                                                                <input value={catatan[row.orderId] ?? ""} maxLength={500}
                                                                    onChange={(event) => setCatatan((lama) => ({ ...lama, [row.orderId]: event.target.value }))}
                                                                    placeholder="Penjelasan, mis. koreksi qty saat pengiriman"
                                                                    aria-label={`Penjelasan selisih isi ${row.soNo ?? row.orderId}`}
                                                                    className="min-w-56 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-200" />
                                                                <button onClick={() => void jelaskan(row, "isi")} disabled={busy}
                                                                    className="rounded bg-amber-500/20 px-2 py-1 text-amber-100 disabled:opacity-40">
                                                                    Jelaskan selisih isi
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                            {row.status === "cocok" && <span className="text-slate-500">—</span>}
                                        </td>
                                    </tr>
                                ))}
                                {!verifyRows.length && (
                                    <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                                        {verify?.rows.length
                                            ? "Tidak ada selisih yang belum dijelaskan."
                                            : "Belum ada faktur yang terkirim ke Accurate untuk diperiksa."}
                                    </td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </details>

            {!!data?.pendingBatches?.length && (
                <section className="space-y-2">
                    <h2 className="text-lg font-medium text-white">Batch yang belum diantrekan</h2>
                    <div className="overflow-x-auto rounded-lg border border-white/10">
                        <table className="w-full text-sm">
                            <thead className="bg-white/5 text-slate-400">
                                <tr>
                                    <th className="px-3 py-2 text-left">Berkas</th>
                                    <th className="px-3 py-2 text-right">Baris</th>
                                    <th className="px-3 py-2 text-right">Perlu ditinjau</th>
                                    <th className="px-3 py-2 text-left">Umur</th>
                                    <th className="px-3 py-2 text-left">Diunggah</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {data.pendingBatches.map((batch) => (
                                    <tr key={batch.id} className={`border-t border-white/5 ${batch.overdue ? "bg-red-500/5" : ""}`}>
                                        <td className="px-3 py-2">
                                            {batch.fileName}
                                            <div className="text-xs text-slate-500">{batch.principal}</div>
                                        </td>
                                        <td className="px-3 py-2 text-right">{batch.lineCount}</td>
                                        <td className="px-3 py-2 text-right text-amber-300">{batch.reviewCount}</td>
                                        <td className={`px-3 py-2 text-xs ${batch.overdue ? "text-red-300" : "text-slate-400"}`}>
                                            <Clock size={12} className="mr-1 inline" aria-hidden="true" />{usia(batch.ageMinutes)}
                                            {batch.overdue && <span className="ml-1 whitespace-nowrap font-semibold">· lewat 2 jam</span>}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-slate-500">
                                            {new Date(batch.uploadedAt).toLocaleString("id-ID")}{batch.uploadedBy ? ` · ${batch.uploadedBy}` : ""}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            <a href="/principal-order" className="text-xs text-blue-300 hover:underline">Buka batch</a>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <div className={`overflow-x-auto rounded-lg border border-white/10 transition-opacity ${status === "memuat" && data ? "opacity-60" : ""}`}
                aria-busy={status === "memuat"}>
                <table className="w-full text-sm">
                    <thead className="bg-white/5 text-slate-400">
                        <tr>
                            <th className="px-3 py-2 text-left">Faktur / SO</th>
                            <th className="px-3 py-2 text-left">Outlet</th>
                            <th className="px-3 py-2 text-left">Sales</th>
                            <th className="px-3 py-2 text-left">Tanggal</th>
                            <th className="px-3 py-2 text-left">Status</th>
                            <th className="px-3 py-2 text-left">Umur masalah</th>
                            <th className="px-3 py-2 text-right">Coba</th>
                            <th className="px-3 py-2 text-left">Jawaban Accurate</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {data?.rows.map((row) => (
                            <tr key={row.orderId} className={`border-t border-white/5 ${row.overdue ? "bg-red-500/5" : ""}`}>
                                <td className="px-3 py-2">
                                    <div className="font-mono text-xs">{row.soNo ?? row.orderId}</div>
                                    <div className="text-xs text-slate-500">{row.source}{row.accurateNumber ? ` · ${row.accurateNumber}` : ""}</div>
                                </td>
                                <td className="px-3 py-2">
                                    <div className="font-mono text-xs">{row.customerNo}</div>
                                    <div className="text-xs text-slate-500">{row.outlet || "—"}</div>
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">{row.salesman || "—"}</td>
                                <td className="px-3 py-2 text-xs tabular-nums">{tgl(row.orderDate)}</td>
                                <td className="px-3 py-2 text-xs">
                                    <span className={STATES.find((state) => state.key === row.state)?.className ?? ""}>
                                        {row.state === "posted" && <CheckCircle2 size={13} className="mr-1 inline" />}
                                        {row.state === "unknown" && <HelpCircle size={13} className="mr-1 inline" />}
                                        {STATES.find((state) => state.key === row.state)?.label ?? row.state}
                                    </span>
                                </td>
                                <td className={`px-3 py-2 text-xs ${row.overdue ? "text-red-300" : "text-slate-400"}`}>
                                    {row.state === "posted" ? "—" : (
                                        <>
                                            <Clock size={12} className="mr-1 inline" aria-hidden="true" />{usia(row.ageMinutes)}
                                            {row.overdue && <span className="ml-1 whitespace-nowrap font-semibold">· lewat 2 jam</span>}
                                            {row.attempts > 0 && (
                                                <div className="text-slate-500">coba terakhir {new Date(row.updatedAt).toLocaleString("id-ID")}</div>
                                            )}
                                        </>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right text-xs">{row.attempts}</td>
                                <td className="px-3 py-2 text-xs max-w-md break-words text-amber-200/90">{row.lastError || "—"}</td>
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                    {row.state === "rejected" && (
                                        <>
                                            <button onClick={() => void act(row.orderId, "resend")} disabled={busy}
                                                title="Sudah diperbaiki di Accurate; kirim payload yang sama sekali lagi"
                                                className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs disabled:opacity-40">
                                                <Send size={13} /> Kirim ulang
                                            </button>
                                            <button onClick={() => void act(row.orderId, "discard")} disabled={busy}
                                                title="Angkanya yang salah; buang supaya batch yang diperbaiki bisa diantrekan ulang"
                                                className="px-2 text-red-400 hover:text-red-300 disabled:opacity-40">
                                                <Trash2 size={15} />
                                            </button>
                                        </>
                                    )}
                                    {row.state === "queued" && (
                                        <button onClick={() => void act(row.orderId, "discard")} disabled={busy}
                                            title="Belum terkirim sama sekali. Buang supaya batch bisa diantrekan ulang dengan angka terbaru."
                                            className="px-2 text-slate-400 hover:text-red-300 disabled:opacity-40">
                                            <Trash2 size={15} />
                                        </button>
                                    )}
                                    {row.state === "unknown" && (
                                        <span className="text-xs text-red-300/80">cocokkan manual</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {!data && status === "memuat" && (
                            <tr><td colSpan={9} className="px-3 py-2"><LoadingState embedded rows={4} label="Memuat antrean faktur" /></td></tr>
                        )}
                        {!data && status === "galat" && (
                            <tr><td colSpan={9} className="px-3 py-8 text-center text-red-300">Antrean belum bisa ditampilkan — lihat pesan di atas.</td></tr>
                        )}
                        {data && !data.rows.length && (
                            <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                                {picked.length || onlyOverdue ? "Tidak ada faktur yang sesuai saringan." : "Tidak ada faktur yang menggantung."}
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-slate-500">
                <strong className="text-red-300">TIDAK PASTI</strong> berarti Accurate tidak menjawab — fakturnya
                mungkin sudah terbentuk di sana. Baris itu tidak punya tombol dengan sengaja: faktur ganda di
                Accurate tidak bisa dibatalkan. Cocokkan dulu lewat pencarian <span className="font-mono">charField1</span>,
                baru putuskan. Pengirim terjadwal hanya mengambil yang berstatus <em>menunggu kirim</em>.
            </p>
        </div>
    );
}
