/*
 * Tujuan: Menyusun aturan promo dengan tangan — tambah, ubah, hapus, dan salin tarif ke
 *         beberapa outlet sekaligus.
 * Caller: pengguna lewat menu Promo & Klaim > Aturan Promo.
 * Dependensi: /api/promo-rule. Main Functions: AturanPromoPage.
 * Side Effects: HTTP; setiap simpan langsung menulis `promo_rule`.
 *
 * Halaman ini dan importir berkas di Rekap Promo menulis TABEL YANG SAMA. Impor dipakai saat
 * satu principal dimuat sekaligus; halaman ini saat satu baris perlu diperbaiki — menambah
 * satu outlet tidak boleh berarti menyusun ulang seluruh berkas dan mempertaruhkan muatannya.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Trash2, Copy, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

type Rule = {
    id: number; principal: string; suratProgram: string; promoLabel: string; promoGroup: string;
    itemCode: string; itemName: string; customerCode: string;
    periodStart: string | null; periodEnd: string | null; active: boolean;
    tierNo: number; triggerQty: string; triggerUnit: string;
    benefitType: string; benefitValue: string; benefitUnit: string; benefitBeban: string;
    onFaktur: boolean; note: string; importedBy: string;
};

const KOSONG: Partial<Rule> = {
    principal: "KINO NON FOOD", suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR",
    promoLabel: "", itemCode: "", itemName: "", customerCode: "",
    periodStart: "", periodEnd: "", active: true, tierNo: 1, triggerQty: "0", triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "", benefitUnit: "%", benefitBeban: "DISTRIBUTOR",
    onFaktur: true, note: "",
};

/** Bentuk aturan, dibaca dari isinya — bukan dari kolom penanda yang bisa berbeda dari isinya. */
function bentuk(rule: Pick<Rule, "customerCode" | "itemCode">): string {
    if (rule.customerCode && !rule.itemCode) return "Tarif outlet";
    if (rule.itemCode) return "Per barang";
    return "Tingkat faktur";
}

export default function AturanPromoPage() {
    const [rules, setRules] = useState<Rule[]>([]);
    const [principals, setPrincipals] = useState<string[]>([]);
    const [principal, setPrincipal] = useState("");
    const [jenis, setJenis] = useState("");
    const [q, setQ] = useState("");
    const [total, setTotal] = useState(0);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState<Partial<Rule> | null>(null);
    const [salin, setSalin] = useState<{ rule: Rule; kode: string } | null>(null);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const params = new URLSearchParams();
            if (principal) params.set("principal", principal);
            if (jenis) params.set("jenis", jenis);
            if (q) params.set("q", q);
            const res = await fetch(`/api/promo-rule?${params}`);
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal memuat aturan");
            setRules(body.rules); setPrincipals(body.principals); setTotal(body.total);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat aturan");
        } finally { setBusy(false); }
    }, [principal, jenis, q]);

    useEffect(() => { void load(); }, [load]);

    async function simpan() {
        if (!draft) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-rule", {
                method: draft.id ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(draft),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan");
            toast.success(draft.id ? "Aturan diperbarui" : "Aturan ditambahkan");
            setDraft(null); await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyimpan");
        } finally { setBusy(false); }
    }

    async function hapus(rule: Rule) {
        if (!confirm(`Hapus aturan ${rule.suratProgram} ${rule.customerCode || rule.itemCode || "(tingkat faktur)"}?\n`
            + "Potongan yang tadinya dijelaskan aturan ini akan kembali tertahan gerbang.")) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/promo-rule?id=${rule.id}`, { method: "DELETE" });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menghapus");
            toast.success("Aturan dihapus"); await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menghapus");
        } finally { setBusy(false); }
    }

    async function salinKeOutlet() {
        if (!salin) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-rule", {
                method: "PUT", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: salin.rule.id, customerCodes: salin.kode }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyalin");
            toast.success(`Tarif disalin ke ${body.outlets} outlet`);
            setSalin(null); await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyalin");
        } finally { setBusy(false); }
    }

    const F = ({ label, children }: { label: string; children: React.ReactNode }) => (
        <label className="text-sm"><span className="block text-slate-400 mb-1">{label}</span>{children}</label>
    );
    const inputCls = "w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-sm";

    return (
        <div className="space-y-4 p-4">
            <header>
                <h1 className="text-lg font-semibold">Aturan Promo</h1>
                <p className="text-sm text-slate-400">
                    Aturan terbit yang dipakai gerbang validasi dan Rekap Promo. Yang dimuat dari berkas dan
                    yang diketik di sini masuk ke tabel yang sama — tidak ada salinan kedua.
                </p>
            </header>

            <section className="flex flex-wrap items-end gap-2">
                <F label="Principal">
                    <select value={principal} onChange={(e) => setPrincipal(e.target.value)} className={inputCls}>
                        <option value="">Semua</option>
                        {principals.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                </F>
                <F label="Bentuk">
                    <select value={jenis} onChange={(e) => setJenis(e.target.value)} className={inputCls}>
                        <option value="">Semua</option>
                        <option value="tarif">Tarif outlet</option>
                        <option value="barang">Per barang</option>
                        <option value="faktur">Tingkat faktur</option>
                    </select>
                </F>
                <F label="Cari surat / kelompok / kode">
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="mis. C-AL0063" className={inputCls} />
                </F>
                <button onClick={() => void load()} disabled={busy}
                    className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                    <RefreshCw size={15} /> Muat ulang
                </button>
                <button onClick={() => setDraft({ ...KOSONG })} disabled={busy}
                    className="ml-auto inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                    <Plus size={15} /> Aturan baru
                </button>
            </section>

            {draft && (
                <section className="rounded border border-blue-500/30 bg-blue-500/5 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">{draft.id ? `Ubah aturan #${draft.id}` : "Aturan baru"}</h2>
                        <button onClick={() => setDraft(null)} className="rounded p-1 hover:bg-white/10"><X size={16} /></button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        <F label="Principal"><input value={draft.principal ?? ""} onChange={(e) => setDraft({ ...draft, principal: e.target.value })} className={inputCls} /></F>
                        <F label="Surat / program"><input value={draft.suratProgram ?? ""} onChange={(e) => setDraft({ ...draft, suratProgram: e.target.value })} className={inputCls} /></F>
                        <F label="Kelompok"><input value={draft.promoGroup ?? ""} onChange={(e) => setDraft({ ...draft, promoGroup: e.target.value })} className={inputCls} /></F>
                        <F label="Nama program"><input value={draft.promoLabel ?? ""} onChange={(e) => setDraft({ ...draft, promoLabel: e.target.value })} className={inputCls} /></F>

                        <F label="Kode outlet (kosong = semua)"><input value={draft.customerCode ?? ""} onChange={(e) => setDraft({ ...draft, customerCode: e.target.value })} placeholder="C-AL0063" className={inputCls} /></F>
                        <F label="Kode barang (kosong = semua)"><input value={draft.itemCode ?? ""} onChange={(e) => setDraft({ ...draft, itemCode: e.target.value })} className={inputCls} /></F>
                        <F label="Nama barang"><input value={draft.itemName ?? ""} onChange={(e) => setDraft({ ...draft, itemName: e.target.value })} className={inputCls} /></F>
                        <F label="Beban">
                            <select value={draft.benefitBeban ?? "PRINCIPAL"} onChange={(e) => setDraft({ ...draft, benefitBeban: e.target.value })} className={inputCls}>
                                <option value="DISTRIBUTOR">DISTRIBUTOR (beban kita)</option>
                                <option value="PRINCIPAL">PRINCIPAL (bisa diklaim)</option>
                            </select>
                        </F>

                        <F label="Jenis manfaat">
                            <select value={draft.benefitType ?? "DISC_PCT"} onChange={(e) => setDraft({ ...draft, benefitType: e.target.value })} className={inputCls}>
                                <option value="DISC_PCT">DISC_PCT — diskon persen</option>
                                <option value="DISC_RP">DISC_RP — potongan rupiah</option>
                                <option value="BONUS_QTY">BONUS_QTY — bonus barang</option>
                            </select>
                        </F>
                        <F label="Nilai manfaat"><input value={draft.benefitValue ?? ""} onChange={(e) => setDraft({ ...draft, benefitValue: e.target.value })} placeholder="2.25" className={inputCls} /></F>
                        <F label={draft.customerCode && !draft.itemCode ? "POSISI kolom diskon (1-5)" : "Tingkat (tier)"}>
                            <input type="number" min={1} value={draft.tierNo ?? 1} onChange={(e) => setDraft({ ...draft, tierNo: Number(e.target.value) })} className={inputCls} />
                        </F>
                        <F label="Ambang pemicu / satuan">
                            <div className="flex gap-1">
                                <input value={draft.triggerQty ?? "0"} onChange={(e) => setDraft({ ...draft, triggerQty: e.target.value })} className={inputCls} />
                                <select value={draft.triggerUnit ?? "PCS"} onChange={(e) => setDraft({ ...draft, triggerUnit: e.target.value })} className={inputCls}>
                                    <option value="PCS">PCS</option><option value="KRT">KRT</option><option value="RP">RP</option>
                                </select>
                            </div>
                        </F>

                        <F label="Berlaku mulai"><input type="date" value={draft.periodStart ?? ""} onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })} className={inputCls} /></F>
                        <F label="Berlaku sampai"><input type="date" value={draft.periodEnd ?? ""} onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })} className={inputCls} /></F>
                        <F label="Catatan"><input value={draft.note ?? ""} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} /></F>
                        <label className="flex items-end gap-2 text-sm pb-1.5">
                            <input type="checkbox" checked={draft.active !== false} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                            <span>Aktif</span>
                        </label>
                    </div>
                    {draft.customerCode && !draft.itemCode && draft.benefitType === "DISC_PCT" && (
                        <p className="text-xs text-amber-200">
                            Ini aturan <strong>tarif outlet</strong>: berlaku untuk SEMUA barang outlet itu, dan angka
                            di kolom tingkat berarti <strong>posisi kolom diskon</strong>. Posisi 1–3 beban distributor,
                            4–5 klaim principal. Beban yang tidak sesuai posisinya akan ditolak — aturan begitu tidak
                            akan pernah cocok dengan potongan mana pun.
                        </p>
                    )}
                    <div className="flex gap-2">
                        <button onClick={() => void simpan()} disabled={busy}
                            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                            <Save size={15} /> Simpan
                        </button>
                        <button onClick={() => setDraft(null)} className="rounded bg-white/10 px-3 py-2 text-sm">Batal</button>
                    </div>
                </section>
            )}

            {salin && (
                <section className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                    <h2 className="text-sm font-semibold">
                        Salin tarif {salin.rule.benefitValue}% posisi {salin.rule.tierNo} ({salin.rule.customerCode}) ke outlet lain
                    </h2>
                    <p className="text-xs text-slate-300">
                        Satu grup outlet berbagi tarif yang sama, tetapi tetap <strong>satu baris per kode</strong>:
                        gerbang mencocokkan per pelanggan, dan kode anggota grup tidak selalu berawalan sama
                        (SATU SAMA JAYA: <code>C-SA0269</code>, <code>C-SAT015</code>, <code>C-SAT016</code>).
                        Tulis kodenya dipisah koma atau spasi.
                    </p>
                    <textarea value={salin.kode} onChange={(e) => setSalin({ ...salin, kode: e.target.value })}
                        rows={2} placeholder="C-SAT015, C-SAT016" className={inputCls} />
                    <div className="flex gap-2">
                        <button onClick={() => void salinKeOutlet()} disabled={busy}
                            className="inline-flex items-center gap-2 rounded bg-emerald-600 px-3 py-2 text-sm disabled:opacity-40">
                            <Copy size={15} /> Salin
                        </button>
                        <button onClick={() => setSalin(null)} className="rounded bg-white/10 px-3 py-2 text-sm">Batal</button>
                    </div>
                </section>
            )}

            <p className="text-sm text-slate-400">{rules.length} dari {total} aturan ditampilkan.</p>

            <div className="overflow-x-auto rounded border border-white/10">
                <table className="w-full text-sm">
                    <thead className="bg-white/5 text-slate-300">
                        <tr>
                            {["Bentuk", "Surat / kelompok", "Outlet", "Barang", "Posisi/tier", "Manfaat", "Beban", "Berlaku", ""].map((h) => (
                                <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rules.map((rule) => (
                            <tr key={rule.id} className={`border-t border-white/5 ${rule.active ? "" : "opacity-50"}`}>
                                <td className="whitespace-nowrap px-2 py-1.5">{bentuk(rule)}</td>
                                <td className="px-2 py-1.5">{rule.suratProgram}<span className="block text-xs text-slate-400">{rule.promoGroup}</span></td>
                                <td className="whitespace-nowrap px-2 py-1.5">{rule.customerCode || "—"}</td>
                                <td className="px-2 py-1.5">{rule.itemCode || "—"}<span className="block text-xs text-slate-400">{rule.itemName}</span></td>
                                <td className="px-2 py-1.5 text-center">{rule.tierNo}</td>
                                <td className="whitespace-nowrap px-2 py-1.5">
                                    {rule.benefitType === "DISC_PCT" ? `${rule.benefitValue}%` : `${rule.benefitType} ${rule.benefitValue}`}
                                    {Number(rule.triggerQty) > 0 && <span className="block text-xs text-slate-400">≥ {Number(rule.triggerQty).toLocaleString("id-ID")} {rule.triggerUnit}</span>}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5">{rule.benefitBeban}</td>
                                <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate-400">
                                    {rule.periodStart ?? "—"} s/d {rule.periodEnd ?? "—"}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1.5 text-right">
                                    <button onClick={() => setDraft({ ...rule, periodStart: rule.periodStart ?? "", periodEnd: rule.periodEnd ?? "" })}
                                        className="rounded px-2 py-1 text-xs hover:bg-white/10">Ubah</button>
                                    {rule.customerCode && !rule.itemCode && (
                                        <button onClick={() => setSalin({ rule, kode: "" })}
                                            className="rounded px-2 py-1 text-xs hover:bg-white/10" title="Salin ke outlet lain">
                                            <Copy size={13} />
                                        </button>
                                    )}
                                    <button onClick={() => void hapus(rule)} className="rounded px-2 py-1 text-xs text-red-300 hover:bg-white/10">
                                        <Trash2 size={13} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {rules.length === 0 && (
                            <tr><td colSpan={9} className="px-2 py-6 text-center text-slate-400">Belum ada aturan yang cocok dengan saringan ini.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
