/*
 * Tujuan: Wave monitor Rekapan Nota — upload export Accurate, lihat wave hari itu, buat wave baru.
 * Caller: menu sidebar "Rekapan Nota" (/rekapan-nota). Guard RBAC: rekapan_nota.view.
 * Dependensi: POST /api/rekapan-nota/upload, GET|POST /api/rekapan-nota/wave.
 * Main Functions: RekapanNotaPage.
 * Side Effects: HTTP upload/read/create. Tidak menyimpan state di localStorage.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, MapPin, Plus, Truck, UploadCloud } from "lucide-react";

type Wave = {
    id: number; tanggal: string; urutan: number; nama: string; tipe: string; status: string;
    jumlah_nota: number; exception_open: number;
};
type UploadResult = {
    uploadId: number; tanggal: string; jumlahNota: number; jumlahBaris: number;
    barisTotalFile: number; principal: string[]; sudahAda?: boolean; pesan?: string;
};

const hariIni = () => new Date().toISOString().slice(0, 10);

const WARNA_STATUS: Record<string, string> = {
    draft: "bg-slate-100 text-slate-700",
    released: "bg-blue-100 text-blue-700",
    confirmed: "bg-emerald-100 text-emerald-700",
    cancelled: "bg-rose-100 text-rose-700",
};

export default function RekapanNotaPage() {
    const [tanggal, setTanggal] = useState(hariIni);
    const [wave, setWave] = useState<Wave[]>([]);
    const [file, setFile] = useState<File | null>(null);
    const [tanggalTersedia, setTanggalTersedia] = useState<string[]>([]);
    const [hasil, setHasil] = useState<UploadResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const muatWave = useCallback(async (tgl: string) => {
        const res = await fetch(`/api/rekapan-nota/wave?tanggal=${tgl}`);
        if (!res.ok) { setError("Gagal memuat daftar wave."); return; }
        setWave(((await res.json()) as { wave: Wave[] }).wave);
    }, []);

    useEffect(() => { void muatWave(tanggal); }, [tanggal, muatWave]);

    async function unggah() {
        if (!file) return;
        setBusy(true); setError(null); setHasil(null);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("tanggal", tanggal);
            const res = await fetch("/api/rekapan-nota/upload", { method: "POST", body: form });
            const payload = await res.json() as UploadResult & { error?: string; tanggalTersedia?: string[] };
            if (payload.tanggalTersedia) setTanggalTersedia(payload.tanggalTersedia);
            if (!res.ok) { setError(payload.error ?? "Upload gagal."); return; }
            setHasil(payload);
            await muatWave(tanggal);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    // Wave kanvas dibuat terpisah, bukan lewat dialog bertingkat: tipe wave menentukan
    // pool mana yang boleh masuk, jadi salah pilih di sini berakibat sampai ke kertas.
    async function buatWave(tipe: "reguler" | "kanvas") {
        const sejenis = wave.filter((w) => w.tipe === tipe);
        const urutan = tipe === "kanvas" ? 9 + sejenis.length : (sejenis.at(-1)?.urutan ?? 0) + 1;
        const nama = tipe === "kanvas"
            ? (prompt("Nama wave kanvas?", "Kanvas") || "")
            : (prompt(`Nama wave ke-${urutan}? (mis. Pagi / Siang / Sore)`, "") || "");
        if (!nama) return;
        setBusy(true); setError(null);
        try {
            const res = await fetch("/api/rekapan-nota/wave", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ tanggal, urutan, nama, tipe }),
            });
            if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? "Gagal membuat wave."); return; }
            await muatWave(tanggal);
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="ui-page-shell ui-page-shell--wide space-y-5" aria-busy={busy}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">Rekapan Nota</h1>
                    <p className="ui-page-description">
                        Upload export Accurate &quot;Rincian Faktur Penjualan&quot;, susun wave, cetak lembar picking dan TTF.
                        Satu nota hanya boleh masuk satu wave &mdash; dijamin unique index, bukan daftar manual.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Link href="/rekapan-nota/kanvas" className="ui-button-secondary min-h-11">
                        <Truck size={16} aria-hidden="true" /> Nota Kanvas
                    </Link>
                    <Link href="/rekapan-nota/area" className="ui-button-secondary min-h-11">
                        <MapPin size={16} aria-hidden="true" /> Mapping Area
                    </Link>
                </div>
            </header>

            <section className="ui-surface-panel ui-panel-padding" aria-labelledby="rekapan-upload-title">
                <h2 id="rekapan-upload-title" className="text-base font-extrabold text-[var(--luxury-text)]">Sumber data</h2>
                <p className="mt-1 text-sm text-[var(--luxury-muted)]">
                    Satu file export bisa memuat rentang berhari-hari, jadi tanggalnya dipilih di sini &mdash; tidak ditebak.
                </p>

                <div className="mt-4 flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold text-[var(--luxury-text)]">Tanggal data</span>
                        <input type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)}
                            className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold text-[var(--luxury-text)]">File export (.xlsx)</span>
                        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm" />
                    </label>
                    <button onClick={unggah} disabled={busy || !file} className="ui-button-primary min-h-11 px-4">
                        <UploadCloud size={16} aria-hidden="true" /> {busy ? "Memproses..." : "Upload ke pool"}
                    </button>
                </div>

                {tanggalTersedia.length > 0 && (
                    <p className="mt-3 text-xs text-[var(--luxury-muted)]">
                        Tanggal yang ada di file: {tanggalTersedia.join(", ")}
                    </p>
                )}
                {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
                {hasil && (
                    <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                        {hasil.sudahAda
                            ? hasil.pesan
                            : `${hasil.jumlahNota} nota / ${hasil.jumlahBaris} baris masuk pool untuk ${hasil.tanggal}. ` +
                              `Principal: ${hasil.principal.join(", ") || "-"}.`}
                    </p>
                )}
            </section>

            <section className="ui-surface-panel ui-panel-padding" aria-labelledby="rekapan-wave-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 id="rekapan-wave-title" className="text-base font-extrabold text-[var(--luxury-text)]">
                        Wave {tanggal}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                        <button onClick={() => buatWave("reguler")} disabled={busy} className="ui-button-secondary min-h-11 px-4">
                            <Plus size={16} aria-hidden="true" /> Wave baru
                        </button>
                        <button onClick={() => buatWave("kanvas")} disabled={busy} className="ui-button-ghost min-h-11 px-4">
                            <Truck size={16} aria-hidden="true" /> Wave kanvas
                        </button>
                    </div>
                </div>

                {wave.length === 0 ? (
                    <p className="ui-state-message">Belum ada wave untuk tanggal ini.</p>
                ) : (
                    <div className="ui-table-frame">
                        <table className="ui-data-table">
                            <thead>
                                <tr>
                                    <th scope="col">#</th><th scope="col">Nama</th><th scope="col">Tipe</th>
                                    <th scope="col">Status</th><th scope="col">Nota</th>
                                    <th scope="col">Exception</th><th scope="col"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {wave.map((w) => (
                                    <tr key={w.id}>
                                        <td>{w.urutan}</td>
                                        <td className="font-semibold">{w.nama}</td>
                                        <td>{w.tipe}</td>
                                        <td>
                                            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${WARNA_STATUS[w.status] ?? ""}`}>
                                                {w.status}
                                            </span>
                                        </td>
                                        <td>{w.jumlah_nota}</td>
                                        <td>
                                            {w.exception_open > 0 && (
                                                <span className="inline-flex items-center gap-1 text-amber-700">
                                                    <AlertTriangle size={14} aria-hidden="true" /> {w.exception_open}
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            <Link href={`/rekapan-nota/wave/${w.id}`} className="ui-button-ghost">Buka</Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </main>
    );
}
