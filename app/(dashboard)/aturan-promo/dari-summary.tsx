/*
 * Tujuan: Memuat aturan promo dari PUBLIKASI Summary — surat yang sudah dibaca OCR, dikoreksi,
 *         dan diterbitkan manusia.
 * Caller: halaman Aturan Promo (/aturan-promo).
 * Dependensi: /api/promo-rule/from-summary. Main Functions: DariSummary.
 * Side Effects: HTTP; memuat menulis `promo_rule` irisan surat itu.
 *
 * Kenapa daftarnya hanya berisi yang SUDAH TERBIT: menerbitkan adalah satu-satunya tempat
 * seseorang menyatakan "saya sudah memeriksa ini". Draft tidak boleh menyeberang ke gerbang
 * yang menahan faktur, betapapun praktisnya.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { FileCheck2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Terbit = {
    draft_id: string; title: string; published_at: string;
    surat_program: string; principal: string; nama_program: string; kelompok: string;
    period: { start?: string; end?: string }; programs: number; codes: string[];
    sudahDimuat: boolean;
};

export default function DariSummary({ setelahMuat }: { setelahMuat?: () => void }) {
    const [list, setList] = useState<Terbit[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setBusy(true); setError("");
        try {
            const res = await fetch("/api/promo-rule/from-summary");
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal membaca publikasi Summary");
            setList(body.published);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal membaca publikasi Summary");
        } finally { setBusy(false); }
    }, []);

    useEffect(() => { void load(); }, [load]);

    async function muat(entry: Terbit) {
        if (entry.sudahDimuat && !confirm(`Surat ${entry.surat_program} sudah pernah dimuat. Muat ulang akan MENGGANTI aturan dari surat ini; aturan dari Excel, tarif outlet, dan yang diketik tangan tidak tersentuh. Lanjutkan?`)) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-rule/from-summary", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ draftId: entry.draft_id }),
            });
            const body = await res.json();
            // Yang DITOLAK tetap diperlihatkan meski pemuatannya gagal seluruhnya: sebabnya
            // itulah yang harus diperbaiki, bukan sekadar "gagal".
            for (const alasan of (body.ditolak ?? []) as string[]) toast.warning(alasan, { duration: 15000 });
            for (const nota of (body.catatan ?? []) as string[]) toast.info(nota, { duration: 12000 });
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal memuat");
            toast.success(`${body.aturan} aturan surat ${body.suratProgram} dimuat`
                + (body.outlet ? `, ${body.outlet} outlet peserta ikut dimuat` : ""));
            await load();
            setelahMuat?.();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal memuat", { duration: 15000 });
        } finally { setBusy(false); }
    }

    return (
        <section className="space-y-3 rounded border border-white/10 p-3">
            <header className="flex flex-wrap items-center gap-2">
                <FileCheck2 size={16} className="text-emerald-300" />
                <h2 className="text-sm font-semibold">Muat dari publikasi Summary</h2>
                <button onClick={() => void load()} disabled={busy}
                    className="ml-auto inline-flex items-center gap-2 rounded bg-white/10 px-2.5 py-1.5 text-xs disabled:opacity-40">
                    <RefreshCw size={13} /> Muat ulang daftar
                </button>
            </header>

            <p className="max-w-3xl text-xs leading-relaxed text-slate-400">
                Surat yang sudah dibaca di <strong>Summary</strong>, dikoreksi, lalu <strong>diterbitkan</strong>
                {" "}bisa langsung menjadi aturan di sini — tanpa perantara Excel. Yang masih draft tidak muncul:
                menerbitkan adalah satu-satunya tempat seseorang menyatakan sudah memeriksanya, dan gerbang yang
                menahan faktur tidak boleh menerima yang belum diperiksa.
                {" "}Program yang <em>tidak bisa dinyatakan utuh</em> sebagai aturan — rafaksi, dasar harga netto,
                rantai beberapa persen dalam satu strata — <strong>ditolak beserta sebabnya</strong>, bukan dimuat separuh.
            </p>

            {error && (
                <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200">{error}</p>
            )}

            <div className="max-h-80 overflow-auto rounded border border-white/10">
                <table className="w-full text-sm">
                    <thead className="bg-white/5 text-slate-300">
                        <tr>
                            {["Surat", "Program", "Periode", "Isi", ""].map((h) => (
                                <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {list.map((entry) => (
                            <tr key={entry.draft_id} className="border-t border-white/5">
                                <td className="whitespace-nowrap px-2 py-1.5 align-top">
                                    {entry.surat_program || <span className="text-slate-500">tanpa nomor</span>}
                                    <span className="block text-xs text-slate-500">{entry.principal}</span>
                                </td>
                                <td className="px-2 py-1.5 align-top">
                                    {entry.nama_program || entry.title}
                                    <span className="block text-xs text-slate-500">{entry.kelompok}</span>
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">
                                    {entry.period?.start ?? "—"}<br />s/d {entry.period?.end ?? "—"}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">
                                    {entry.programs} program · {entry.codes.length} barang
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 text-right align-top">
                                    {entry.sudahDimuat && <span className="mr-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">sudah dimuat</span>}
                                    <button onClick={() => void muat(entry)} disabled={busy}
                                        className="rounded bg-emerald-600 px-2.5 py-1 text-xs disabled:opacity-40">
                                        {entry.sudahDimuat ? "Muat ulang" : "Muat"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {list.length === 0 && !error && (
                            <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-400">
                                Belum ada publikasi Summary. Unggah suratnya di Summary, koreksi detailnya, lalu terbitkan —
                                setelah itu ia muncul di sini.
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
