/*
 * Tujuan: Melihat dan menyusun DAFTAR OUTLET peserta program — "toko mana saja yang ikut".
 * Caller: halaman Aturan Promo (/aturan-promo).
 * Dependensi: /api/promo-outlet. Main Functions: DaftarOutlet.
 * Side Effects: HTTP; setiap simpan langsung menulis `promo_outlet`.
 *
 * Kenapa ada layar untuk ini: surat program menyebut peserta ("KHUSUS CHANNEL GT PESERTA
 * LOYALTY"), tetapi daftarnya selama ini hanya hidup di satu berkas Excel. Selama begitu,
 * tidak ada yang bisa menjawab "toko mana saja yang ikut?" tanpa meminta berkasnya, dan tidak
 * ada gerbang yang bisa menahan bonus yang jatuh ke toko yang bukan peserta.
 *
 * Kotak isiannya sengaja menerima KODE APA SAJA yang dipunya orangnya — kode internal Accurate
 * maupun kode pelanggan Kino — karena yang memegang daftar loyalty adalah tim sales, dan yang
 * ada di tangan mereka adalah kode Kino. Yang tidak terbaca dikembalikan dengan sebabnya.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileUp, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

type Member = {
    id: number; listName: string; customerCode: string; customerName: string;
    tier: string; sourceCode: string; periodStart: string | null; periodEnd: string | null;
    active: boolean; note: string; importedBy: string;
};
type ListInfo = { name: string; members: number; tiers: Record<string, number> };

const inputCls = "w-full rounded border border-white/15 bg-white/5 px-2 py-1.5 text-sm outline-none focus:border-blue-400";

function F({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="block text-sm">
            <span className="mb-1 block text-slate-300">{label}</span>
            {children}
            {hint && <span className="mt-1 block text-xs leading-snug text-slate-500">{hint}</span>}
        </label>
    );
}

export default function DaftarOutlet() {
    const [lists, setLists] = useState<ListInfo[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [list, setList] = useState("");
    const [q, setQ] = useState("");
    const [busy, setBusy] = useState(false);
    const [tambah, setTambah] = useState<{ listName: string; codes: string; tier: string; periodStart: string; periodEnd: string; note: string } | null>(null);
    // Kode distributor kita, datang dari server (diturunkan dari batch laporan principal
    // terakhir). Lampiran surat memuat outlet SELURUH distributor nasional; kode inilah yang
    // memisahkan milik kita dari milik orang lain.
    const [distCode, setDistCode] = useState("");
    const [listName, setListName] = useState("LOYALTY");

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const params = new URLSearchParams();
            if (list) params.set("list", list);
            if (q) params.set("q", q);
            const res = await fetch(`/api/promo-outlet?${params}`);
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal memuat daftar outlet");
            setLists(body.lists); setMembers(body.members);
            if (body.distCode) setDistCode((lama) => lama || body.distCode);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat daftar outlet");
        } finally { setBusy(false); }
    }, [list, q]);

    useEffect(() => { void load(); }, [load]);

    async function simpan() {
        if (!tambah) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-outlet", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tambah),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan");
            toast.success(`${body.ditambah} outlet masuk daftar ${body.listName} (dari ${body.diminta} kode`
                + (body.kembar > 0 ? `, ${body.kembar} kembar digabung)` : ")"));
            // Yang ditolak DIPERLIHATKAN satu per satu, bukan diringkas jadi satu angka: yang
            // mengisi perlu tahu kode MANA yang harus diperbaiki, bukan bahwa ada yang gagal.
            for (const alasan of (body.ditolak ?? []) as string[]) toast.warning(alasan, { duration: 12000 });
            setTambah(null);
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyimpan");
        } finally { setBusy(false); }
    }

    /**
     * Unggah surat PDF atau berkas terpisah. Satu tombol untuk keduanya: yang membedakan hanya
     * jenis berkasnya, dan menanyakannya lebih dulu ke pengguna cuma menambah satu langkah
     * yang jawabannya sudah ada di nama berkas.
     */
    async function unggah(file: File) {
        setBusy(true);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("distCode", distCode);
            form.append("listName", listName);
            const res = await fetch("/api/promo-outlet", { method: "POST", body: form });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal membaca berkas");
            const kembar = body.kembar > 0 ? `, ${body.kembar} kembar digabung` : "";
            // Sumber bacaannya DISEBUT: yang lewat OCR itu berbayar per halaman, dan yang
            // mengunggah berhak tahu kapan ia membayar dan kapan tidak.
            const lewat = body.ocrPages > 0 ? ` (dibaca ${body.sumberTeks}, ${body.ocrPages} halaman)` : "";
            toast.success(body.sumber === "surat"
                ? `Surat ${body.listName}: ${body.ditambah} outlet peserta dimuat${kembar}, ${body.aturanDitunjuk} aturan surat ini ditunjuk ke daftarnya${lewat}`
                : `${body.ditambah} outlet masuk daftar ${body.listName}${kembar}`);
            for (const alasan of (body.ditolak ?? []) as string[]) toast.warning(alasan, { duration: 12000 });
            for (const nota of (body.catatan ?? []) as string[]) toast.info(nota, { duration: 12000 });
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal membaca berkas", { duration: 15000 });
        } finally { setBusy(false); }
    }

    async function hapus(ids: number[], sebutan: string) {
        if (!confirm(`Keluarkan ${sebutan} dari daftar? Aturan yang menunjuk daftar ini akan berhenti berlaku untuknya.`)) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/promo-outlet?ids=${ids.join(",")}`, { method: "DELETE" });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menghapus");
            toast.success(`${body.deleted} outlet dikeluarkan`);
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menghapus");
        } finally { setBusy(false); }
    }

    return (
        <section className="space-y-3 rounded border border-white/10 p-3">
            <header className="flex flex-wrap items-center gap-2">
                <Users size={16} className="text-blue-300" />
                <h2 className="text-sm font-semibold">Daftar outlet peserta</h2>
                <button onClick={() => void load()} disabled={busy}
                    className="ml-auto inline-flex items-center gap-2 rounded bg-white/10 px-2.5 py-1.5 text-xs disabled:opacity-40">
                    <RefreshCw size={13} /> Muat ulang
                </button>
                <a href="/api/promo-outlet?template=1"
                    className="inline-flex items-center gap-2 rounded bg-white/10 px-2.5 py-1.5 text-xs">
                    <Download size={13} /> Template daftar outlet
                </a>
                <a href="/api/promo-recap?template=1"
                    className="inline-flex items-center gap-2 rounded bg-white/10 px-2.5 py-1.5 text-xs"
                    title="Dua sheet: Detail (aturan per barang) dan Discount Reguler (tarif/diskon MT per outlet)">
                    <Download size={13} /> Template aturan &amp; tarif MT
                </a>
                <label className={`inline-flex cursor-pointer items-center gap-2 rounded bg-emerald-600 px-2.5 py-1.5 text-xs ${busy ? "opacity-40" : ""}`}>
                    <FileUp size={13} /> Unggah surat / berkas
                    <input type="file" accept=".pdf,.xlsx,.xls,.csv" disabled={busy} className="hidden"
                        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void unggah(file); }} />
                </label>
                <button onClick={() => setTambah({ listName: list || lists[0]?.name || "LOYALTY", codes: "", tier: "", periodStart: "", periodEnd: "", note: "" })}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded bg-blue-600 px-2.5 py-1.5 text-xs disabled:opacity-40">
                    <Plus size={13} /> Ketik manual
                </button>
            </header>

            <p className="max-w-3xl text-xs leading-relaxed text-slate-400">
                Sebagian program hanya untuk toko tertentu, dan suratnya sendiri yang bilang begitu:
                bonus Resik V dan Ovale berlaku <strong>khusus peserta LOYALTY</strong>, sedangkan potongan MSG justru
                berlaku untuk <strong>semua kecuali peserta LOYALTY</strong>. Daftar di bawah inilah yang dipakai gerbang
                untuk memutuskannya. Satu daftar dipakai beberapa surat sekaligus — aturan cukup menunjuknya,
                jadi mengubah daftar di sini langsung mengubah semua surat yang memakainya.
            </p>

            <p className="max-w-3xl rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-relaxed text-emerald-100">
                <strong>Kalau daftarnya tercetak di suratnya, unggah saja suratnya.</strong> Surat ber-“LIST OUTLET
                TERLAMPIR” memuat tabel peserta di halaman lampirannya; sistem membacanya, mengambil baris milik
                kode distributor kita saja, dan langsung menunjuk semua aturan surat itu ke daftarnya. Tidak ada
                langkah menyalin, jadi tidak ada yang bisa meleset saat menyalin. Gunakan <strong>Template</strong> +
                berkas terpisah hanya untuk daftar yang memang <em>tidak</em> tercetak di surat mana pun — peserta
                loyalty kuartalan, misalnya.
                <br /><br />
                <strong>Surat hasil scan tetap terbaca.</strong> Kalau suratnya tidak punya lapisan teks, sistem
                otomatis membacanya dengan <strong>Mistral OCR 4.1</strong> — mesin yang sama dengan Summary Promo di
                produksi. OCR itu <em>berbayar per halaman</em>, jadi ia hanya dipakai kalau lapisan teksnya memang
                tidak menjawab, dan hasilnya disimpan supaya surat yang sama tidak pernah ditagih dua kali.
            </p>

            <div className="flex flex-wrap items-end gap-2">
                <F label="Kode distributor kita" hint="Tujuh angka pada kolom KODE DIST di lampiran surat. Dipakai memisahkan outlet kita dari outlet distributor lain pada surat yang sama.">
                    <input value={distCode} onChange={(e) => setDistCode(e.target.value)} placeholder="1201671" className={`${inputCls} w-40`} />
                </F>
                <F label="Nama daftar (berkas terpisah)" hint="Hanya dipakai kalau yang diunggah BUKAN surat. Surat memakai nomornya sendiri sebagai nama daftar.">
                    <input value={listName} onChange={(e) => setListName(e.target.value.toUpperCase())} placeholder="LOYALTY" className={`${inputCls} w-44`} />
                </F>
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <F label="Daftar">
                    <select value={list} onChange={(e) => setList(e.target.value)} className={inputCls}>
                        <option value="">Semua daftar</option>
                        {lists.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} ({entry.members})</option>)}
                    </select>
                </F>
                <F label="Cari">
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="kode atau nama toko" className={`${inputCls} min-w-56`} />
                </F>
                {lists.map((entry) => (
                    <span key={entry.name} className="rounded bg-white/5 px-2 py-1 text-xs text-slate-300">
                        {entry.name}: {entry.members} toko
                        <span className="text-slate-500">
                            {" "}({Object.entries(entry.tiers).map(([tier, n]) => `${tier} ${n}`).join(", ")})
                        </span>
                    </span>
                ))}
            </div>

            {tambah && (
                <div className="space-y-3 rounded border border-blue-500/30 bg-blue-500/5 p-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <F label="Nama daftar" hint="Tanpa kuartal. Periodenya diisi per toko di bawah, karena keanggotaan berganti tiap kuartal sedangkan suratnya cuma menyebut “LOYALTY”.">
                            <input value={tambah.listName} onChange={(e) => setTambah({ ...tambah, listName: e.target.value })} placeholder="LOYALTY" className={inputCls} />
                        </F>
                        <F label="Tingkat" hint="PLATINUM/GOLD/SILVER. Keterangan saja — tidak ada surat yang membedakannya.">
                            <input value={tambah.tier} onChange={(e) => setTambah({ ...tambah, tier: e.target.value })} placeholder="PLATINUM" className={inputCls} />
                        </F>
                        <F label="Ikut mulai" hint="Dikosongkan = berlaku sejak kapan pun.">
                            <input type="date" value={tambah.periodStart} onChange={(e) => setTambah({ ...tambah, periodStart: e.target.value })} className={inputCls} />
                        </F>
                        <F label="Ikut sampai" hint="Dikosongkan = sampai dikeluarkan.">
                            <input type="date" value={tambah.periodEnd} onChange={(e) => setTambah({ ...tambah, periodEnd: e.target.value })} className={inputCls} />
                        </F>
                    </div>
                    <F label="Kode outlet"
                        hint="Boleh kode internal Accurate (C-WIN013) ATAU kode pelanggan Kino (22160031402) — dipisah koma, spasi, atau baris baru. Kode Kino diterjemahkan lewat Mapping Principal. Yang tidak dikenali ditolak dan disebutkan satu per satu, tidak dimuat diam-diam.">
                        <textarea value={tambah.codes} onChange={(e) => setTambah({ ...tambah, codes: e.target.value })}
                            rows={4} placeholder="C-WIN013, C-KOS005&#10;22160031402" className={inputCls} />
                    </F>
                    <F label="Catatan" hint="Mis. “dari berkas Loyalty Makassar Q3, dikirim SPV 15 Sep”.">
                        <input value={tambah.note} onChange={(e) => setTambah({ ...tambah, note: e.target.value })} className={inputCls} />
                    </F>
                    <div className="flex gap-2">
                        <button onClick={() => void simpan()} disabled={busy}
                            className="rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">Simpan</button>
                        <button onClick={() => setTambah(null)} className="rounded bg-white/10 px-3 py-2 text-sm">Batal</button>
                    </div>
                </div>
            )}

            <div className="max-h-96 overflow-auto rounded border border-white/10">
                <table className="w-full text-sm">
                    <thead className="bg-white/5 text-slate-300">
                        <tr>
                            {["Daftar", "Outlet", "Tingkat", "Kode Kino", "Ikut", ""].map((h) => (
                                <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {members.map((member) => (
                            <tr key={member.id} className={`border-t border-white/5 ${member.active ? "" : "opacity-50"}`}>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">{member.listName}</td>
                                <td className="px-2 py-1.5 align-top">
                                    {member.customerCode}
                                    <span className="block text-xs text-slate-500">{member.customerName}</span>
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs">{member.tier || <span className="text-slate-500">—</span>}</td>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">
                                    {member.sourceCode || <span className="text-slate-600">diketik langsung</span>}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 align-top text-xs text-slate-400">
                                    {member.periodStart ?? "kapan pun"}<br />s/d {member.periodEnd ?? "dikeluarkan"}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 text-right align-top">
                                    <button onClick={() => void hapus([member.id], `${member.customerCode} ${member.customerName}`)}
                                        className="rounded px-2 py-1 text-xs text-red-300 hover:bg-white/10" title="Keluarkan dari daftar">
                                        <Trash2 size={13} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {members.length === 0 && (
                            <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-400">
                                Belum ada outlet di daftar ini. Selama daftarnya kosong, aturan yang menunjuknya tidak
                                berlaku untuk siapa pun — itu disengaja: lebih baik tertahan daripada lolos tanpa dasar.
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
