/*
 * Tujuan: Layar penandaan nota kanvas (Q16). Dikelompokkan per salesman karena di situlah
 *         nota kanvas menggumpal; multi-select + satu tombol, plus tawaran "tandai semua
 *         nota salesman ini" sekali klik. Nota kanvas keluar dari pool rekapan reguler (R3.5).
 * Caller: /rekapan-nota/kanvas. Guard RBAC: rekapan_nota.view (menandai butuh manage).
 * Dependensi: GET|POST|DELETE /api/rekapan-nota/kanvas.
 * Main Functions: KanvasPage.
 * Side Effects: HTTP read/write ke nota_kanvas.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Truck, Undo2 } from "lucide-react";

type Nota = {
    no_nota: string; kode_salesman: string; salesman: string; customer: string | null;
    jumlah_baris: number; total_pcs: number; kanvas: boolean;
    terkunci: boolean | null; di_wave: boolean | null;
};
type Nihil = { ditandai_at: string; catatan: string | null; oleh: string } | null;
type Payload = { tanggal: string; jumlahNota: number; ditandai: number; nihil: Nihil; nota: Nota[] };

const hariIni = () => new Date().toISOString().slice(0, 10);

export default function KanvasPage() {
    const [tanggal, setTanggal] = useState(hariIni);
    const [data, setData] = useState<Payload | null>(null);
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [pesan, setPesan] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const muat = useCallback(async (tgl: string) => {
        setError(null);
        const res = await fetch(`/api/rekapan-nota/kanvas?tanggal=${tgl}`);
        if (!res.ok) { setError("Gagal memuat daftar nota."); setData(null); return; }
        setData(await res.json() as Payload);
        setPilih(new Set());
    }, []);

    useEffect(() => { void muat(tanggal); }, [tanggal, muat]);

    async function kirim(method: "POST" | "DELETE", noNota: string[]): Promise<boolean> {
        if (!noNota.length) return false;
        setBusy(true); setError(null); setPesan(null);
        try {
            const res = await fetch("/api/rekapan-nota/kanvas", {
                method, headers: { "content-type": "application/json" },
                body: JSON.stringify({ noNota }),
            });
            const p = await res.json() as {
                error?: string; ditandai?: string[]; dibatalkan?: string[];
                bentrok?: { no_nota: string; nama: string }[]; terkunci?: { no_nota: string; nama: string }[];
            };
            if (!res.ok) {
                const detail = (p.bentrok ?? p.terkunci ?? []).map((x) => `${x.no_nota} (wave ${x.nama})`).join(", ");
                setError(detail ? `${p.error} — ${detail}` : (p.error ?? "Gagal."));
                return false;
            }
            setPesan(method === "POST"
                ? `${p.ditandai?.length ?? 0} nota ditandai kanvas.`
                : `${p.dibatalkan?.length ?? 0} tanda dicabut.`);
            await muat(tanggal);
            return true;
        } catch (e) {
            setError(String(e)); return false;
        } finally {
            setBusy(false);
        }
    }

    async function tandai() {
        const dipilih = [...pilih];
        const ok = await kirim("POST", dipilih);
        if (!ok || !data) return;

        // Tawaran sekali, bukan dialog beruntun: nota kanvas datang serombongan per salesman,
        // jadi pertanyaannya diajukan di titik di mana jawabannya paling mungkin "ya".
        const salesman = [...new Set(data.nota.filter((n) => dipilih.includes(n.no_nota)).map((n) => n.kode_salesman))];
        if (salesman.length !== 1) return;
        const sisa = data.nota.filter(
            (n) => n.kode_salesman === salesman[0] && !n.kanvas && !dipilih.includes(n.no_nota) && !n.di_wave);
        if (!sisa.length) return;
        if (confirm(`Salesman ${salesman[0]} punya ${sisa.length} nota lain hari ini yang belum ditandai. Tandai semua?`)) {
            await kirim("POST", sisa.map((n) => n.no_nota));
        }
    }

    async function setNihil(nihil: boolean) {
        setBusy(true); setError(null); setPesan(null);
        try {
            const res = await fetch("/api/rekapan-nota/kanvas", {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ tanggal, nihil }),
            });
            const p = await res.json() as { error?: string };
            if (!res.ok) { setError(p.error ?? "Gagal."); return; }
            setPesan(nihil ? "Dicatat: tidak ada nota kanvas untuk tanggal ini." : "Pernyataan dicabut.");
            await muat(tanggal);
        } finally {
            setBusy(false);
        }
    }

    if (!data) {
        return (
            <main className="ui-page-shell space-y-4">
                <p className="ui-state-message">{error ?? "Memuat..."}</p>
                <Link href="/rekapan-nota" className="ui-button-secondary min-h-11">Kembali</Link>
            </main>
        );
    }

    // Kelompok per salesman: itulah bentuk data yang cocok dengan cara nota kanvas muncul.
    const perSalesman = new Map<string, Nota[]>();
    for (const n of data.nota) {
        const kunci = `${n.kode_salesman} — ${n.salesman}`;
        perSalesman.set(kunci, [...(perSalesman.get(kunci) ?? []), n]);
    }

    return (
        <main className="ui-page-shell ui-page-shell--wide space-y-5" aria-busy={busy}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">Nota Kanvas</h1>
                    <p className="ui-page-description">
                        Nota kanvas dikeluarkan dari pool rekapan reguler &mdash; barangnya sudah keluar lewat
                        pemindahan gudang, rekapannya dicetak setelah kanvaser pulang. Tandanya melekat pada
                        nomor nota, jadi selamat kalau file export di-upload ulang.
                    </p>
                </div>
                <Link href="/rekapan-nota" className="ui-button-secondary min-h-11">
                    <ArrowLeft size={16} aria-hidden="true" /> Kembali
                </Link>
            </header>

            {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
            {pesan && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{pesan}</p>}

            <section className="ui-surface-panel ui-panel-padding">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold text-[var(--luxury-text)]">Tanggal</span>
                        <input type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)}
                            className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3" />
                    </label>
                    <p className="text-sm text-[var(--luxury-muted)]">
                        {data.jumlahNota} nota &middot; <strong>{data.ditandai}</strong> ditandai kanvas
                    </p>
                    <div className="flex gap-2">
                        <button onClick={tandai} disabled={busy || !pilih.size || !!data.nihil} className="ui-button-primary min-h-11 px-4">
                            <Truck size={16} aria-hidden="true" /> Tandai Kanvas ({pilih.size})
                        </button>
                        <button onClick={() => kirim("DELETE", [...pilih])} disabled={busy || !pilih.size}
                            className="ui-button-secondary min-h-11 px-4">
                            <Undo2 size={16} aria-hidden="true" /> Batal tandai
                        </button>
                    </div>
                </div>
            </section>

            {/* Kanvas tidak setiap hari. Tanpa pernyataan ini, "0 nota bertanda" tidak bisa
                dibedakan dari "belum ada yang memeriksa" — dan itu bedanya besar bagi orang
                yang sedang menyusun wave dan bertanya-tanya apakah masih harus menunggu. */}
            <section className="ui-surface-panel ui-panel-padding">
                <label className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" className="mt-1" checked={!!data.nihil} disabled={busy}
                        onChange={(e) => setNihil(e.target.checked)} />
                    <span>
                        <span className="block text-sm font-bold text-[var(--luxury-text)]">
                            Tidak ada nota kanvas untuk tanggal ini
                        </span>
                        <span className="mt-1 block text-xs text-[var(--luxury-muted)]">
                            {data.nihil
                                ? `Dinyatakan oleh ${data.nihil.oleh} pada ${new Date(data.nihil.ditandai_at).toLocaleString("id-ID")}.`
                                : "Belum ada yang memastikan. Selama kotak ini kosong, layar penyusunan wave " +
                                  "akan bilang bahwa kanvas hari ini belum diperiksa."}
                        </span>
                    </span>
                </label>
            </section>

            {data.jumlahNota === 0 && (
                <p className="ui-state-message">
                    Belum ada nota di pool untuk tanggal ini. Upload export Accurate dulu.
                </p>
            )}

            {[...perSalesman.entries()].map(([salesman, nota]) => {
                const bisaDipilih = nota.filter((n) => !n.terkunci);
                const semua = bisaDipilih.length > 0 && bisaDipilih.every((n) => pilih.has(n.no_nota));
                return (
                    <section key={salesman} className="ui-surface-panel ui-panel-padding">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h2 className="text-sm font-extrabold text-[var(--luxury-text)]">
                                {salesman}
                                <span className="ml-2 font-normal text-[var(--luxury-muted)]">
                                    {nota.length} nota &middot; {nota.filter((n) => n.kanvas).length} kanvas
                                </span>
                            </h2>
                            <label className="flex items-center gap-2 text-xs font-semibold">
                                <input type="checkbox" checked={semua}
                                    onChange={(e) => setPilih((s) => {
                                        const n = new Set(s);
                                        for (const x of bisaDipilih) {
                                            if (e.target.checked) n.add(x.no_nota); else n.delete(x.no_nota);
                                        }
                                        return n;
                                    })} />
                                Pilih semua nota salesman ini
                            </label>
                        </div>
                        <div className="ui-table-frame">
                            <table className="ui-data-table">
                                <thead>
                                    <tr>
                                        <th scope="col"></th><th scope="col">Nota</th><th scope="col">Outlet</th>
                                        <th scope="col">Baris</th><th scope="col">Pcs</th><th scope="col">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {nota.map((n) => (
                                        <tr key={n.no_nota} className={n.kanvas ? "bg-amber-50" : ""}>
                                            <td>
                                                <input type="checkbox" aria-label={`Pilih ${n.no_nota}`}
                                                    disabled={!!n.terkunci} checked={pilih.has(n.no_nota)}
                                                    onChange={() => setPilih((s) => {
                                                        const x = new Set(s);
                                                        if (x.has(n.no_nota)) x.delete(n.no_nota); else x.add(n.no_nota);
                                                        return x;
                                                    })} />
                                            </td>
                                            <td className="font-semibold">{n.no_nota}</td>
                                            <td>{n.customer}</td>
                                            <td className="text-right">{n.jumlah_baris}</td>
                                            <td className="text-right">{n.total_pcs}</td>
                                            <td className="text-xs">
                                                {n.kanvas && <span className="font-semibold text-amber-700">KANVAS</span>}
                                                {n.terkunci && <span className="ml-1 text-[var(--luxury-muted)]">(terkunci di wave kanvas)</span>}
                                                {!n.kanvas && n.di_wave && <span className="text-[var(--luxury-muted)]">sudah di wave reguler</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                );
            })}
        </main>
    );
}
