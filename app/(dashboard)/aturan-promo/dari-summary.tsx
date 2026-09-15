/*
 * Tujuan: Memuat aturan promo dari PUBLIKASI Summary — surat yang sudah dibaca OCR, dikoreksi,
 *         dan diterbitkan manusia.
 * Caller: halaman Aturan Promo (/aturan-promo).
 * Dependensi: /api/promo-rule/from-summary, /api/promo-rule/approval. Main Functions: DariSummary.
 * Side Effects: HTTP; memuat menulis `promo_rule` irisan surat itu. Simulasi tidak menulis apa pun.
 *
 * Kenapa daftarnya hanya berisi yang SUDAH TERBIT: menerbitkan adalah satu-satunya tempat
 * seseorang menyatakan "saya sudah memeriksa ini". Draft tidak boleh menyeberang ke gerbang
 * yang menahan faktur, betapapun praktisnya.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { FileCheck2, FlaskConical, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";

type Terbit = {
    draft_id: string; title: string; published_at: string;
    surat_program: string; principal: string; nama_program: string; kelompok: string;
    period: { start?: string; end?: string }; programs: number; codes: string[];
    sudahDimuat: boolean;
};

type Simulasi = {
    ok: boolean; suratProgram: string; ruleCount: number;
    groups: { promoGroup: string; benefitType: string; benefitValue: string; benefitBeban: string;
        tierNo: number; triggerQty: string; triggerUnit: string; periodStart: string; periodEnd: string;
        channel: string; outletList: string; outletListMode: string; itemCodes: string[] }[];
    refused: string[]; notes: string[]; warnings: string[];
    trial: { lines: number; explained: number; noDiscount: number;
        unexplained: { soNo: string; itemCode: string; percent: number; reason: string }[] };
};
type Persetujuan = {
    dicentang: boolean; dicentangOleh: string; dicentangPada: string | null; catatan: string;
    buktiNama: string; buktiUkuran: number; buktiOleh: string; buktiPada: string | null;
};

export default function DariSummary({ setelahMuat }: { setelahMuat?: () => void }) {
    const [list, setList] = useState<Terbit[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    // Simulasi dan persetujuan hidup per publikasi yang sedang DIBUKA, bukan per baris tabel:
    // yang dibaca orang satu surat pada satu waktu, dan menampilkan sepuluh simulasi sekaligus
    // hanya membuat tidak satu pun dibaca.
    const [buka, setBuka] = useState<{ entry: Terbit; sim: Simulasi; setuju: Persetujuan } | null>(null);
    const [catatan, setCatatan] = useState("");

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

    /** Simulasi TIDAK menulis apa pun. Ia menjawab tiga pertanyaan sebelum orang menandatangani. */
    async function simulasikan(entry: Terbit) {
        setBusy(true);
        try {
            const res = await fetch(`/api/promo-rule/from-summary?simulate=${encodeURIComponent(entry.draft_id)}`);
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Simulasi gagal");
            setBuka({ entry, sim: body.simulasi, setuju: body.persetujuan });
            setCatatan(body.persetujuan?.catatan ?? "");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Simulasi gagal", { duration: 15000 });
        } finally { setBusy(false); }
    }

    /** Centang dan/atau unggah bukti. Satu pintu, karena orang mengerjakannya dalam satu duduk. */
    async function setujui(entry: Terbit, opsi: { centang?: boolean; file?: File | null }) {
        setBusy(true);
        try {
            const form = new FormData();
            form.append("draftId", entry.draft_id);
            form.append("suratProgram", entry.surat_program);
            form.append("principal", entry.principal);
            form.append("note", catatan);
            if (opsi.centang !== undefined) form.append("confirmed", String(opsi.centang));
            if (opsi.file) form.append("file", opsi.file);
            const res = await fetch("/api/promo-rule/approval", { method: "POST", body: form });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan persetujuan");
            toast.success(opsi.file ? `Bukti "${opsi.file.name}" tersimpan` : opsi.centang ? "Program dinyatakan benar" : "Pernyataan dicabut");
            await simulasikan(entry);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal menyimpan persetujuan", { duration: 15000 });
        } finally { setBusy(false); }
    }

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
                                    <button onClick={() => void simulasikan(entry)} disabled={busy}
                                        title="Lihat aturan apa yang akan terbaca sistem, dan apa hasilnya atas faktur nyata. Tidak menulis apa pun."
                                        className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-xs disabled:opacity-40">
                                        <FlaskConical size={13} /> Simulasikan
                                    </button>
                                    <button onClick={() => void muat(entry)} disabled={busy}
                                        title="Hanya bisa setelah simulasinya diperiksa, dinyatakan benar, dan bukti bertanda tangan diunggah"
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

            {buka && (
                <div className="space-y-4 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <h3 className="text-sm font-semibold text-white">
                            Simulasi {buka.entry.surat_program || buka.entry.title}
                        </h3>
                        <span className="text-xs text-slate-400">tidak menulis apa pun</span>
                        <button onClick={() => setBuka(null)} className="ml-auto text-xs text-slate-400 hover:text-slate-200">Tutup</button>
                    </div>

                    {/* Peringatan lebih dulu: itulah yang harus dibaca, dan yang paling mudah dilewati
                        kalau ia diletakkan di bawah tabel yang panjang. */}
                    {buka.sim.warnings.map((pesan) => (
                        <p key={pesan} className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">{pesan}</p>
                    ))}

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded border border-white/10 bg-black/20 p-3">
                            <p className="text-xs text-slate-400">Akan jadi aturan</p>
                            <p className="text-lg font-semibold">{buka.sim.ruleCount}</p>
                            <p className="text-xs text-slate-500">{buka.sim.groups.length} bentuk berbeda</p>
                        </div>
                        <div className="rounded border border-white/10 bg-black/20 p-3">
                            <p className="text-xs text-slate-400">Diuji atas faktur nyata</p>
                            <p className="text-lg font-semibold">{buka.sim.trial.lines}</p>
                            <p className="text-xs text-emerald-400">{buka.sim.trial.explained} potongan dijelaskan</p>
                        </div>
                        <div className="rounded border border-white/10 bg-black/20 p-3">
                            <p className="text-xs text-slate-400">Tidak dijelaskan</p>
                            <p className={`text-lg font-semibold ${buka.sim.trial.unexplained.length ? "text-amber-300" : ""}`}>
                                {buka.sim.trial.unexplained.length}
                            </p>
                            <p className="text-xs text-slate-500">{buka.sim.trial.noDiscount} baris memang tanpa potongan</p>
                        </div>
                    </div>

                    {buka.sim.groups.length > 0 && (
                        <div className="overflow-x-auto rounded border border-white/10">
                            <table className="w-full text-xs">
                                <thead className="bg-white/5 text-slate-300">
                                    <tr>{["Kelompok", "Potongan", "Ditanggung", "Ambang", "Berlaku", "Batasan", "Barang"].map((h) => (
                                        <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{h}</th>))}</tr>
                                </thead>
                                <tbody>
                                    {buka.sim.groups.map((g, i) => (
                                        <tr key={i} className="border-t border-white/5">
                                            <td className="px-2 py-1.5">{g.promoGroup}</td>
                                            <td className="whitespace-nowrap px-2 py-1.5">
                                                {g.benefitType === "DISC_PCT" ? `${g.benefitValue}%`
                                                    : g.benefitType === "DISC_RP" ? `Rp ${Number(g.benefitValue).toLocaleString("id-ID")}`
                                                        : `bonus ${g.benefitValue}`}
                                                <span className="block text-slate-500">tingkat {g.tierNo}</span>
                                            </td>
                                            <td className="whitespace-nowrap px-2 py-1.5">{g.benefitBeban === "PRINCIPAL" ? "Principal" : "Kita"}</td>
                                            <td className="whitespace-nowrap px-2 py-1.5">
                                                {Number(g.triggerQty) > 0 ? `${Number(g.triggerQty).toLocaleString("id-ID")} ${g.triggerUnit}` : <span className="text-slate-500">tanpa syarat</span>}
                                            </td>
                                            <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{g.periodStart}<br />s/d {g.periodEnd}</td>
                                            <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">
                                                {g.channel || <span className="text-slate-600">semua channel</span>}
                                                {g.outletList && <span className="block">{g.outletListMode === "EXCLUDE" ? "kecuali" : "hanya"} {g.outletList}</span>}
                                            </td>
                                            <td className="px-2 py-1.5 text-slate-400">{g.itemCodes.length || "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {buka.sim.refused.length > 0 && (
                        <ul className="list-disc space-y-1 pl-5 text-xs text-amber-200">
                            {buka.sim.refused.map((r) => <li key={r}>{r}</li>)}
                        </ul>
                    )}
                    {buka.sim.trial.unexplained.length > 0 && (
                        <details className="rounded border border-white/10 text-xs">
                            <summary className="cursor-pointer px-3 py-2 text-slate-300">
                                {buka.sim.trial.unexplained.length} baris nyata berpotongan yang tidak dijelaskan aturan ini
                            </summary>
                            <ul className="space-y-1 px-3 pb-3 text-slate-400">
                                {buka.sim.trial.unexplained.slice(0, 30).map((u, i) => (
                                    <li key={i}><span className="font-mono">{u.soNo}</span> {u.itemCode} — {u.reason}</li>
                                ))}
                            </ul>
                        </details>
                    )}

                    {/* Dua pernyataan manusia. Sengaja di BAWAH simulasinya: mencentang sebelum
                        melihat hasilnya tidak menambah keamanan apa pun. */}
                    <div className="space-y-3 rounded border border-white/10 bg-black/20 p-3">
                        <h4 className="text-xs font-semibold text-slate-200">Sebelum bisa dimuat, dua hal ini wajib ada</h4>
                        <label className="block text-xs">
                            <span className="mb-1 block text-slate-400">Catatan (opsional) — mis. siapa yang memeriksa, atau apa yang sudah dikonfirmasi ke principal</span>
                            <input value={catatan} onChange={(e) => setCatatan(e.target.value)}
                                className="w-full rounded border border-white/15 bg-white/5 px-2.5 py-2 outline-none transition focus:border-blue-400 focus:ring-1 focus:ring-blue-400/40" />
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className={`inline-flex cursor-pointer items-center gap-2 rounded bg-white/10 px-3 py-2 text-xs ${busy ? "opacity-40" : ""}`}>
                                <Upload size={13} /> {buka.setuju.buktiNama ? "Ganti bukti bertanda tangan" : "Unggah surat bertanda tangan (PDF)"}
                                <input type="file" accept=".pdf" disabled={busy} className="hidden"
                                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void setujui(buka.entry, { file: f }); }} />
                            </label>
                            {buka.setuju.buktiNama
                                ? <a href={`/api/promo-rule/approval?draftId=${encodeURIComponent(buka.entry.draft_id)}&file=1`}
                                    className="text-xs text-emerald-400 hover:underline">
                                    {buka.setuju.buktiNama} ({Math.round(buka.setuju.buktiUkuran / 1024)} KB) · {buka.setuju.buktiOleh}
                                </a>
                                : <span className="text-xs text-amber-300">belum ada bukti tanda tangan OM dan tim</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            <button onClick={() => void setujui(buka.entry, { centang: !buka.setuju.dicentang })} disabled={busy}
                                className={`inline-flex items-center gap-2 rounded px-3 py-2 text-xs disabled:opacity-40 ${buka.setuju.dicentang ? "bg-white/10" : "bg-blue-600"}`}>
                                <ShieldCheck size={14} />
                                {buka.setuju.dicentang ? "Cabut pernyataan" : "Program ini sudah benar dan bisa berjalan"}
                            </button>
                            {buka.setuju.dicentang && (
                                <span className="text-xs text-emerald-400">
                                    dinyatakan {buka.setuju.dicentangOleh}
                                    {buka.setuju.dicentangPada ? ` · ${new Date(buka.setuju.dicentangPada).toLocaleString("id-ID")}` : ""}
                                </span>
                            )}
                        </div>
                        <p className="text-xs leading-relaxed text-slate-500">
                            Sistem bisa menilai apakah aturannya terbaca, tetapi tidak bisa menilai apakah programnya
                            memang disetujui orang yang berwenang — jadi buktinya wajib ada, bukan dinilai.
                        </p>
                    </div>
                </div>
            )}
        </section>
    );
}
