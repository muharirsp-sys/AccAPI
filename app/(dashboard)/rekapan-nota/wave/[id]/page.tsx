/*
 * Tujuan: Penyusunan satu wave — ambil nota dari pool, atur prioritas, pilih grup cetak,
 *         rilis/konfirmasi, dan lihat antrean exception. Pintu ke lembar cetak & TTF.
 * Caller: /rekapan-nota/wave/[id]. Guard RBAC: rekapan_nota.view (aksi butuh manage).
 * Dependensi: GET /api/rekapan-nota/pool, GET|PATCH /api/rekapan-nota/wave/[id],
 *             POST|PATCH /api/rekapan-nota/wave/[id]/nota.
 * Main Functions: WavePage.
 * Side Effects: HTTP read/write. Tidak menyimpan state di localStorage.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { use } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Printer, Send, Undo2 } from "lucide-react";

type Wave = { id: number; tanggal: string; urutan: number; nama: string; tipe: string; status: string };
type NotaWave = {
    no_nota: string; prioritas: string; snap_area: string | null; snap_grup_all: string;
    snap_grup_gdi: string; snap_pareto: boolean | null; snap_total_krt: number | null;
    dilepas: boolean; dilepas_alasan: string | null;
    customer: string | null; region: string | null; jumlah_baris: number; total_pcs: number;
};
type NotaPool = {
    no_nota: string; kode_cust: string; customer: string | null; salesman: string | null;
    area: string | null; grup_all: string; grup_gdi: string;
    jumlah_baris: number; total_pcs: number; total_krt: number | null; pareto: boolean | null;
};
type Exception = { id: number; jenis: string; ref_tipe: string; ref_kode: string; keterangan: string | null; status: string };
type PickGroup = { id: number; kode: string; nama: string; dimensi: string };
type Detail = { wave: Wave; nota: NotaWave[]; exception: Exception[]; pickGroup: PickGroup[]; pickGroupTersedia: PickGroup[] };

export default function WavePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [pool, setPool] = useState<NotaPool[]>([]);
    const [disembunyikan, setDisembunyikan] = useState(0);
    const [kanvasNihilOleh, setKanvasNihilOleh] = useState<string | null>(null);
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [grupPilih, setGrupPilih] = useState<Set<number>>(new Set());
    const [pesan, setPesan] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const muat = useCallback(async () => {
        const res = await fetch(`/api/rekapan-nota/wave/${id}`);
        if (!res.ok) { setError("Gagal memuat wave."); return; }
        const d = await res.json() as Detail;
        setDetail(d);
        setGrupPilih(new Set(d.pickGroup.map((g) => g.id)));

        const p = await fetch(`/api/rekapan-nota/pool?tanggal=${d.wave.tanggal}&tipe=${d.wave.tipe}`);
        if (p.ok) {
            const isi = await p.json() as { nota: NotaPool[]; disembunyikan?: number; kanvasNihilOleh?: string | null };
            setPool(isi.nota);
            setDisembunyikan(isi.disembunyikan ?? 0);
            setKanvasNihilOleh(isi.kanvasNihilOleh ?? null);
        }
    }, [id]);

    useEffect(() => { void muat(); }, [muat]);

    async function kirim(url: string, method: string, body: unknown): Promise<boolean> {
        setBusy(true); setError(null); setPesan(null);
        try {
            const res = await fetch(url, {
                method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            });
            const payload = await res.json() as { error?: string; ditolak?: string[]; pemilik?: { no_nota: string; nama: string; tanggal: string }[] };
            if (!res.ok && !payload.ditolak) { setError(payload.error ?? "Gagal."); return false; }
            if (payload.ditolak?.length) {
                // Inilah jawaban "kenapa nota ini tidak ada di rekapan sore?" — langsung di layar.
                setError(`Ditolak: ${payload.pemilik?.map((p) => `${p.no_nota} sudah di wave ${p.nama} (${p.tanggal})`).join("; ")
                    || payload.ditolak.join(", ")}`);
            }
            await muat();
            return true;
        } catch (e) {
            setError(String(e)); return false;
        } finally {
            setBusy(false);
        }
    }

    async function tambahNota(prioritas: "normal" | "urgent") {
        if (!pilih.size) return;
        const ok = await kirim(`/api/rekapan-nota/wave/${id}/nota`, "POST",
            { noNota: [...pilih], prioritas });
        if (ok) setPilih(new Set());
    }

    async function takeout(noNota: string) {
        const alasan = prompt(`Alasan melepas ${noNota} dari wave ini? (wajib, min 5 karakter)`, "");
        if (!alasan) return;
        await kirim(`/api/rekapan-nota/wave/${id}/nota`, "PATCH", { aksi: "takeout", noNota, alasan });
    }

    async function simpanGrup() {
        const ok = await kirim(`/api/rekapan-nota/wave/${id}`, "PATCH",
            { aksi: "set_grup", pickGroupIds: [...grupPilih] });
        if (ok) setPesan("Grup cetak tersimpan.");
    }

    async function transisi(aksi: "release" | "confirm" | "cancel") {
        const ok = await kirim(`/api/rekapan-nota/wave/${id}`, "PATCH", { aksi });
        if (ok) setPesan(`Wave di-${aksi}.`);
    }

    if (!detail) return <main className="ui-page-shell"><p className="ui-state-message">{error ?? "Memuat..."}</p></main>;

    const { wave } = detail;
    const aktif = detail.nota.filter((n) => !n.dilepas);
    const exceptionOpen = detail.exception.filter((e) => e.status === "open");
    const draft = wave.status === "draft";
    const cetakUrl = `/rekapan-nota/wave/${id}/cetak?grup=${[...grupPilih].join(",")}`;

    return (
        <main className="ui-page-shell ui-page-shell--wide space-y-5" aria-busy={busy}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">Wave {wave.nama} &mdash; {wave.tanggal}</h1>
                    <p className="ui-page-description">
                        Urutan {wave.urutan} &middot; tipe {wave.tipe} &middot; status <strong>{wave.status}</strong> &middot;{" "}
                        {aktif.length} nota aktif
                    </p>
                </div>
                <Link href="/rekapan-nota" className="ui-button-secondary min-h-11">
                    <ArrowLeft size={16} aria-hidden="true" /> Kembali
                </Link>
            </header>

            {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
            {pesan && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{pesan}</p>}

            <section className="ui-surface-panel ui-panel-padding">
                <h2 className="text-base font-extrabold text-[var(--luxury-text)]">Grup cetak</h2>
                <p className="mt-1 text-sm text-[var(--luxury-muted)]">
                    Grup dari dimensi berbeda digabung dengan DAN, grup sedimensi dengan ATAU.
                    Contoh lembar HNZ1 = Area 1/10/PGU <em>dan</em> Non Pareto.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    {detail.pickGroupTersedia.map((g) => (
                        <label key={g.id} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-semibold ${
                            grupPilih.has(g.id)
                                ? "border-[var(--luxury-teal)] bg-[var(--surface-2)] text-[var(--luxury-text)]"
                                : "border-[var(--border-strong)] text-[var(--luxury-muted)]"}`}>
                            <input type="checkbox" className="sr-only" checked={grupPilih.has(g.id)}
                                onChange={() => setGrupPilih((s) => {
                                    const n = new Set(s);
                                    if (n.has(g.id)) n.delete(g.id); else n.add(g.id);
                                    return n;
                                })} />
                            {g.nama}
                            <span className="ml-1 opacity-60">({g.dimensi})</span>
                        </label>
                    ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                    <button onClick={simpanGrup} disabled={busy} className="ui-button-secondary min-h-11 px-4">Simpan grup</button>
                    <Link href={cetakUrl} target="_blank" className="ui-button-primary min-h-11 px-4">
                        <Printer size={16} aria-hidden="true" /> Lembar rekapan
                    </Link>
                    <Link href={`/rekapan-nota/wave/${id}/ttf`} target="_blank" className="ui-button-secondary min-h-11 px-4">
                        <Printer size={16} aria-hidden="true" /> TTF
                    </Link>
                    {draft && (
                        <button onClick={() => transisi("release")} disabled={busy} className="ui-button-primary min-h-11 px-4">
                            <Send size={16} aria-hidden="true" /> Rilis wave
                        </button>
                    )}
                    {wave.status === "released" && (
                        <button onClick={() => transisi("confirm")} disabled={busy} className="ui-button-primary min-h-11 px-4">
                            Konfirmasi selesai
                        </button>
                    )}
                    {(draft || wave.status === "released") && (
                        <button onClick={() => transisi("cancel")} disabled={busy} className="ui-button-ghost min-h-11 px-4">
                            Batalkan
                        </button>
                    )}
                </div>
            </section>

            {exceptionOpen.length > 0 && (
                <section className="ui-surface-panel ui-panel-padding">
                    <h2 className="flex items-center gap-2 text-base font-extrabold text-amber-700">
                        <AlertTriangle size={18} aria-hidden="true" /> Exception terbuka ({exceptionOpen.length})
                    </h2>
                    <p className="mt-1 text-sm text-[var(--luxury-muted)]">
                        Rilis tetap boleh jalan &mdash; gudang tidak diblokir. Yang tidak boleh adalah menutup wave
                        selagi exception konversi masih terbuka.
                    </p>
                    <div className="ui-table-frame mt-3">
                        <table className="ui-data-table">
                            <thead><tr><th scope="col">Jenis</th><th scope="col">Referensi</th><th scope="col">Keterangan</th></tr></thead>
                            <tbody>
                                {exceptionOpen.map((e) => (
                                    <tr key={e.id}>
                                        <td className="font-semibold">{e.jenis}</td>
                                        <td>{e.ref_tipe} {e.ref_kode}</td>
                                        <td className="text-[var(--luxury-muted)]">{e.keterangan}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <section className="ui-surface-panel ui-panel-padding">
                <h2 className="text-base font-extrabold text-[var(--luxury-text)]">Isi wave ({aktif.length} nota)</h2>
                <div className="ui-table-frame mt-3">
                    <table className="ui-data-table">
                        <thead>
                            <tr>
                                <th scope="col">Nota</th><th scope="col">Outlet</th><th scope="col">Area</th>
                                <th scope="col">Grup All</th><th scope="col">Krt</th><th scope="col">Pareto</th>
                                <th scope="col">Prioritas</th><th scope="col"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {detail.nota.map((n) => (
                                <tr key={n.no_nota} className={n.dilepas ? "opacity-40 line-through" : ""}>
                                    <td className="font-semibold">{n.no_nota}</td>
                                    <td>{n.customer}</td>
                                    <td>{n.snap_area ?? <span className="text-amber-700">belum dipetakan</span>}</td>
                                    <td>{n.snap_grup_all}</td>
                                    <td>{n.snap_total_krt?.toFixed(2) ?? "-"}</td>
                                    <td>{n.snap_pareto === null ? "-" : n.snap_pareto ? "PARETO" : "NON"}</td>
                                    <td>{n.prioritas}</td>
                                    <td>
                                        {!n.dilepas && (
                                            <button onClick={() => takeout(n.no_nota)} disabled={busy} className="ui-button-ghost">
                                                <Undo2 size={14} aria-hidden="true" /> Take-out
                                            </button>
                                        )}
                                        {n.dilepas && <span className="text-xs">{n.dilepas_alasan}</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {draft && (
                <section className="ui-surface-panel ui-panel-padding">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-base font-extrabold text-[var(--luxury-text)]">
                                Pool tersedia ({pool.length} nota)
                            </h2>
                            {disembunyikan === 0 && wave.tipe === "reguler" && (
                                <p className="mt-1 text-xs text-[var(--luxury-muted)]">
                                    {kanvasNihilOleh
                                        ? `Kanvas: dinyatakan tidak ada oleh ${kanvasNihilOleh}.`
                                        : <>Kanvas hari ini <strong>belum diperiksa</strong>.{" "}
                                            <Link href="/rekapan-nota/kanvas" className="underline">Periksa sekarang</Link></>}
                                </p>
                            )}
                            {disembunyikan > 0 && (
                                <p className="mt-1 text-xs text-amber-700">
                                    {disembunyikan} nota disembunyikan karena{" "}
                                    {wave.tipe === "kanvas" ? "TIDAK ditandai kanvas" : "ditandai kanvas"}.{" "}
                                    <Link href="/rekapan-nota/kanvas" className="underline">Periksa penandaannya</Link>{" "}
                                    kalau ada yang terasa kurang.
                                </p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => tambahNota("normal")} disabled={busy || !pilih.size}
                                className="ui-button-primary min-h-11 px-4">Tambah ke wave ({pilih.size})</button>
                            <button onClick={() => tambahNota("urgent")} disabled={busy || !pilih.size}
                                className="ui-button-secondary min-h-11 px-4">Tambah sebagai urgent</button>
                        </div>
                    </div>
                    <div className="ui-table-frame max-h-[28rem] overflow-auto">
                        <table className="ui-data-table">
                            <thead>
                                <tr>
                                    <th scope="col">
                                        <input type="checkbox" aria-label="Pilih semua"
                                            checked={pool.length > 0 && pilih.size === pool.length}
                                            onChange={(e) => setPilih(e.target.checked ? new Set(pool.map((p) => p.no_nota)) : new Set())} />
                                    </th>
                                    <th scope="col">Nota</th><th scope="col">Outlet</th><th scope="col">Sales</th>
                                    <th scope="col">Area</th><th scope="col">Krt</th><th scope="col">Baris</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pool.map((p) => (
                                    <tr key={p.no_nota}>
                                        <td>
                                            <input type="checkbox" aria-label={`Pilih ${p.no_nota}`} checked={pilih.has(p.no_nota)}
                                                onChange={() => setPilih((s) => {
                                                    const n = new Set(s);
                                                    if (n.has(p.no_nota)) n.delete(p.no_nota); else n.add(p.no_nota);
                                                    return n;
                                                })} />
                                        </td>
                                        <td className="font-semibold">{p.no_nota}</td>
                                        <td>{p.customer}</td>
                                        <td>{p.salesman}</td>
                                        <td>{p.area ?? <span className="text-amber-700">belum dipetakan</span>}</td>
                                        <td>{p.total_krt?.toFixed(2) ?? "-"}</td>
                                        <td>{p.jumlah_baris}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </main>
    );
}
