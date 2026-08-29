/*
 * Tujuan: Antrean pelengkapan mapping area outlet — daftar yang MENYUSUT kalau dikerjakan,
 *         bukan laporan. Usulan otomatis + terima massal untuk yang berkeyakinan TINGGI.
 * Caller: /rekapan-nota/area. Guard RBAC: rekapan_nota.view (menyimpan butuh manage).
 * Dependensi: GET|POST /api/rekapan-nota/area.
 * Main Functions: AreaMappingPage.
 * Side Effects: HTTP read/write ke customer.area.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";

type Baris = {
    kode: string; nama: string; alamat: string | null; jumlah_nota: number;
    usulan: string | null; keyakinan: "TINGGI" | "SEDANG" | "RENDAH" | null; alasan: string | null;
};
type Payload = { jumlah: number; dapatUsulan: number; tinggi: number; outlet: Baris[] };

const WARNA: Record<string, string> = {
    TINGGI: "bg-emerald-100 text-emerald-800",
    SEDANG: "bg-amber-100 text-amber-800",
    RENDAH: "bg-slate-100 text-slate-700",
};

export default function AreaMappingPage() {
    const [data, setData] = useState<Payload | null>(null);
    const [isian, setIsian] = useState<Record<string, string>>({});
    const [pesan, setPesan] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const muat = useCallback(async () => {
        const res = await fetch("/api/rekapan-nota/area");
        if (!res.ok) { setError("Gagal memuat antrean mapping."); return; }
        setData(await res.json() as Payload);
        setIsian({});
    }, []);

    useEffect(() => { void muat(); }, [muat]);

    async function simpan(terima: { kode: string; area: string }[]) {
        if (!terima.length) return;
        setBusy(true); setError(null); setPesan(null);
        try {
            const res = await fetch("/api/rekapan-nota/area", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ terima }),
            });
            const p = await res.json() as { tersimpan?: number; gagal?: string[]; error?: string };
            if (!res.ok) { setError(p.error ?? "Gagal menyimpan."); return; }
            setPesan(`${p.tersimpan} outlet tersimpan${p.gagal?.length ? `, ${p.gagal.length} gagal (${p.gagal.join(", ")})` : ""}.`);
            await muat();
        } finally {
            setBusy(false);
        }
    }

    if (!data) return <main className="ui-page-shell"><p className="ui-state-message">{error ?? "Memuat..."}</p></main>;

    const tinggi = data.outlet.filter((o) => o.keyakinan === "TINGGI" && o.usulan);

    return (
        <main className="ui-page-shell ui-page-shell--wide space-y-5" aria-busy={busy}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">Mapping Area Outlet</h1>
                    <p className="ui-page-description">
                        {data.jumlah} outlet berjualan tapi belum punya area &mdash; {data.dapatUsulan} dapat usulan
                        otomatis, {data.tinggi} di antaranya berkeyakinan TINGGI. Selama belum dipetakan, notanya
                        tidak muncul di lembar HNZ mana pun.
                    </p>
                </div>
                <Link href="/rekapan-nota" className="ui-button-secondary min-h-11">
                    <ArrowLeft size={16} aria-hidden="true" /> Kembali
                </Link>
            </header>

            {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
            {pesan && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{pesan}</p>}

            <section className="ui-surface-panel ui-panel-padding">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-[var(--luxury-muted)]">
                        Usulan, bukan penetapan. Area salah lebih mahal daripada area kosong: yang kosong ketahuan
                        di antrean ini, yang salah diam-diam mengirim barang ke rute keliru.
                    </p>
                    <button
                        onClick={() => simpan(tinggi.map((o) => ({ kode: o.kode, area: o.usulan! })))}
                        disabled={busy || tinggi.length === 0}
                        className="ui-button-primary min-h-11 px-4">
                        <Check size={16} aria-hidden="true" /> Terima semua yang TINGGI ({tinggi.length})
                    </button>
                </div>

                <div className="ui-table-frame">
                    <table className="ui-data-table">
                        <thead>
                            <tr>
                                <th scope="col">Kode</th><th scope="col">Outlet</th><th scope="col">Alamat</th>
                                <th scope="col">Nota</th><th scope="col">Usulan</th><th scope="col">Keyakinan</th>
                                <th scope="col">Alasan</th><th scope="col">Area final</th><th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.outlet.map((o) => (
                                <tr key={o.kode}>
                                    <td className="font-semibold">{o.kode}</td>
                                    <td>{o.nama}</td>
                                    <td className="max-w-72 truncate text-xs text-[var(--luxury-muted)]" title={o.alamat ?? ""}>{o.alamat}</td>
                                    <td className="text-right">{o.jumlah_nota}</td>
                                    <td>{o.usulan ?? "-"}</td>
                                    <td>
                                        {o.keyakinan && (
                                            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${WARNA[o.keyakinan]}`}>
                                                {o.keyakinan}
                                            </span>
                                        )}
                                    </td>
                                    <td className="max-w-80 text-xs text-[var(--luxury-muted)]">{o.alasan}</td>
                                    <td>
                                        <input
                                            aria-label={`Area untuk ${o.kode}`}
                                            value={isian[o.kode] ?? o.usulan ?? ""}
                                            onChange={(e) => setIsian((s) => ({ ...s, [o.kode]: e.target.value }))}
                                            className="w-24 rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 py-1 text-sm" />
                                    </td>
                                    <td>
                                        <button
                                            onClick={() => simpan([{ kode: o.kode, area: isian[o.kode] ?? o.usulan ?? "" }])}
                                            disabled={busy || !(isian[o.kode] ?? o.usulan)}
                                            className="ui-button-ghost">Simpan</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </main>
    );
}
