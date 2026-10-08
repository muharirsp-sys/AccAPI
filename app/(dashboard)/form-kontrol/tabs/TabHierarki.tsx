/*
 * Tujuan: Tab Hierarki Sales (Fiori S5, it05): SPV dan SM per salesman, dikelompokkan per SPV. Ubah = draf per baris, Simpan per
 *   baris lewat dialog (lama → baru dan akibatnya pada cakupan). Simpan dikunci bila daftar usang (muat ulang gagal/berjalan).
 * Caller: form-kontrol/FormKontrol.tsx (tab "hierarki"; peran admin/manager).
 * Dependensi: ../shared (Scope, ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive}.
 * Main Functions: TabHierarki (default).
 * Side Effects: GET /api/form-kontrol/sales-profiles; PUT /api/form-kontrol/sales-profiles (payload sama dengan hari ini).
 */
"use client";

import { useCallback, useState } from "react";
import { Pencil, RefreshCw, Save } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Skeleton } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { ambilFk, tulisFk, useIzinFk, type Scope } from "../shared";

interface Profile { salesCode: string; salesName: string; principle: string; branch: string; spvName: string | null; smName: string | null }
type Edit = { spvName: string; smName: string };
const TANPA_SPV = "Belum diatur";

export default function TabHierarki({ scope }: { scope: Scope }) {
    void scope; // tab admin; server memeriksa cakupan global sendiri (allowedSalesCodes === null)
    const izin = useIzinFk("manage");
    const [load, muatUlang] = useLoad(useCallback(
        (): Promise<Load<Profile[]>> => ambilFk("/api/form-kontrol/sales-profiles", (j) => (j.rows ?? []) as Profile[], "Hierarki sales belum berhasil dimuat."), []));
    const [edits, setEdits] = useState<Record<string, Edit>>({});
    const [simpan, setSimpan] = useState<Profile | null>(null);
    const [sukses, setSukses] = useState("");

    const profiles = load.data ?? [];
    const nilai = (p: Profile): Edit => edits[p.salesCode] ?? { spvName: p.spvName ?? "", smName: p.smName ?? "" };
    const berubah = (p: Profile) => { const e = edits[p.salesCode]; return Boolean(e) && (e.spvName !== (p.spvName ?? "") || e.smName !== (p.smName ?? "")); };
    const nDraf = profiles.filter(berubah).length;
    useUnsavedGuard(nDraf > 0);
    const kunci = izin ?? (load.status !== "siap" ? "Tunggu daftar selesai dimuat ulang." : undefined);

    const spvNames = [...new Set(profiles.map((r) => r.spvName).filter(Boolean) as string[])].sort();
    const smNames = [...new Set(profiles.map((r) => r.smName).filter(Boolean) as string[])].sort();
    const grup = new Map<string, Profile[]>();
    for (const p of profiles) { const k = p.spvName ?? TANPA_SPV; grup.set(k, [...(grup.get(k) ?? []), p]); }
    const kunciGrup = [...grup.keys()].sort((a, b) => (a === TANPA_SPV ? 1 : b === TANPA_SPV ? -1 : a.localeCompare(b)));
    const ubah = (p: Profile, patch: Partial<Edit>) => { setEdits((prev) => ({ ...prev, [p.salesCode]: { ...nilai(p), ...patch } })); setSukses(""); };

    let isi;
    if (!load.data && load.status === "galat") isi = <ErrorState title="Hierarki sales belum berhasil dimuat" message={(load.error ?? "").replace("Hierarki sales belum berhasil dimuat.", "").trim() || undefined} onRetry={muatUlang} />;
    else if (!load.data) isi = <Skeleton rows={6} label="Memuat hierarki sales" />;
    else if (profiles.length === 0) isi = <EmptyState title="Belum ada profil sales" message="Profil sales dibuat saat akun salesman ditautkan; hierarki diatur setelahnya." />;
    else isi = (
        <div className={load.status === "memuat" ? "fi-busy grid gap-3" : "grid gap-3"} aria-busy={load.status === "memuat" || undefined}>
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {(load.error ?? "").replace("Hierarki sales belum berhasil dimuat.", "").trim()} Yang tampil adalah hasil sebelumnya; simpan dikunci.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                </MessageStrip>
            )}
            {kunciGrup.map((k) => {
                const anggota = grup.get(k)!;
                const sm = anggota[0]?.smName;
                return (
                    <details key={k} open className="fi-sect">
                        <summary className="flex flex-wrap items-center gap-2 px-4" style={{ minHeight: 44, cursor: "pointer" }}>
                            <b>{k === TANPA_SPV ? "SPV belum diatur" : k}</b>
                            {sm && <span className="fi-small fi-subtle">SM: {sm}</span>}
                            <span className="fi-small fi-subtle">· {anggota.length} salesman</span>
                        </summary>
                        <ul className="grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                            {anggota.map((p) => {
                                const e = nilai(p);
                                const draf = berubah(p);
                                return (
                                    <li key={p.salesCode} className="grid items-end gap-3 border-t px-4 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" style={{ borderColor: "var(--line)" }}>
                                        <div className="min-w-0">
                                            <b className="fi-small">{p.salesName}</b>
                                            <span className="fi-codes">{p.salesCode} · {p.principle}</span>
                                            {draf && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf</span>}
                                        </div>
                                        <FormField label={`SPV ${p.salesName}`}>{(a) => (
                                            <input {...a} list="fk-spv-list" className="fi-input" style={{ minHeight: 44 }} value={e.spvName} placeholder="Nama SPV" onChange={(ev) => ubah(p, { spvName: ev.target.value })} />
                                        )}</FormField>
                                        <FormField label={`SM ${p.salesName}`}>{(a) => (
                                            <input {...a} list="fk-sm-list" className="fi-input" style={{ minHeight: 44 }} value={e.smName} placeholder="Nama SM" onChange={(ev) => ubah(p, { smName: ev.target.value })} />
                                        )}</FormField>
                                        <Button variant={draf ? "primary" : "secondary"} style={{ minHeight: 44 }} icon={<Save className="fi-icon" aria-hidden />}
                                            disabled={!draf || Boolean(kunci)} disabledReason={kunci ?? "Belum ada perubahan"} onClick={() => setSimpan(p)}>
                                            Simpan
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    </details>
                );
            })}
        </div>
    );

    const target = simpan ? nilai(simpan) : null;
    return (
        <>
            <div className="fi-page-bar">
                <h2 className="fi-title-2">Hierarki Sales</h2>
                {nDraf > 0 && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />{nDraf} perubahan belum disimpan</span>}
                <span className="fi-spacer" />
                <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Muat ulang</Button>
            </div>
            <p className="fi-small fi-muted">SPV dan SM tiap salesman menentukan siapa yang bisa melihat data siapa (Dashboard SPV, Kontrol SM, cakupan Form Kontrol).</p>
            {sukses && <MessageStrip tone="pos" title={sukses} onClose={() => setSukses("")} />}
            <datalist id="fk-spv-list">{spvNames.map((n) => <option key={n} value={n} />)}</datalist>
            <datalist id="fk-sm-list">{smNames.map((n) => <option key={n} value={n} />)}</datalist>
            {isi}
            <ConfirmDialog
                open={simpan !== null}
                onClose={() => setSimpan(null)}
                title={`Ubah hierarki ${simpan?.salesName ?? ""}?`}
                description="Akibatnya langsung: SPV dan SM baru melihat data salesman ini; yang lama tidak lagi."
                facts={simpan && target ? [
                    ["Salesman", `${simpan.salesName} · ${simpan.salesCode}`],
                    ["SPV", `${simpan.spvName ?? "—"} → ${target.spvName || "—"}`],
                    ["SM", `${simpan.smName ?? "—"} → ${target.smName || "—"}`],
                ] : []}
                confirmLabel="Simpan hierarki"
                confirmDisabled={kunci}
                onConfirm={async () => {
                    const p = simpan!;
                    const e = nilai(p);
                    await tulisFk("/api/form-kontrol/sales-profiles", {
                        method: "PUT",
                        body: { salesCode: p.salesCode, spvName: e.spvName || null, smName: e.smName || null },
                        gagal: "Hierarki belum tersimpan.",
                    });
                    setSimpan(null);
                    // Isian tidak dibuang: sampai daftar termuat ulang baris tetap menampilkan nilai baru (lalu tidak lagi "Draf").
                    setSukses(`Hierarki ${p.salesName} tersimpan.`);
                    muatUlang();
                }}
            />
        </>
    );
}
