/*
 * Tujuan: Tab Hierarki Sales (Fiori S5, it05): SPV dan SM per salesman, dikelompokkan per SPV. Ubah = draf per baris, Simpan per
 *   baris lewat dialog (lama → baru dan akibatnya pada cakupan). Simpan dikunci bila daftar usang (muat ulang gagal/berjalan).
 *   Owner 13 Okt 2026: SPV/SM DIPILIH dari nama akun aktif ber-role itu (GET spvOptions/smOptions), bukan diketik — cakupan SPV/SM
 *   mencocokkan nama akun. Nilai tersimpan yang tidak cocok dengan akun mana pun tetap tampil sebagai opsi bertanda + peringatan baris.
 *   SR-2 (16 Okt 2026): kolom No HP per salesman (tujuan tombol WhatsApp Supervisor Review). PUT mengirim `noHp` HANYA bila diubah; server
 *   menormalkan dan menolak yang tidak sah dengan 400 NO_HP_TIDAK_SAH (kalimatnya tampil di dialog).
 * Caller: form-kontrol/FormKontrol.tsx (tab "hierarki"; peran admin/manager).
 * Dependensi: ../shared (Scope, ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive}, lib/tampil (KOSONG).
 * Main Functions: TabHierarki (default).
 * Side Effects: GET /api/form-kontrol/sales-profiles; PUT /api/form-kontrol/sales-profiles (payload sama; server menolak nama di luar akun
 *   dengan kalimat berkode yang tampil di dialog).
 */
"use client";

import { useCallback, useState } from "react";
import { Pencil, RefreshCw, Save } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Skeleton } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { kunciNama } from "@/lib/form-kontrol/constants";
import { normalHp } from "@/lib/form-kontrol/noo-aturan";
import { KOSONG } from "@/lib/tampil";
import { ambilFk, tulisFk, useIzinFk, type Scope } from "../shared";

interface Profile { salesCode: string; salesName: string; principle: string; branch: string; spvName: string | null; smName: string | null; noHp?: string | null }
type Edit = { spvName: string; smName: string; noHp: string };
type Data = { rows: Profile[]; spv: string[]; sm: string[] };
const TANPA_SPV = "Belum diatur";
const PERAN = ["spv", "sm"] as const;
const NAMA = { spv: "spvName", sm: "smName" } as const;
const LABEL = { spv: "SPV", sm: "SM" } as const;
const teks = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Opsi akun yang cocok (kunciNama) dengan nilai; "" = kosong; undefined = nilai tidak cocok dengan akun mana pun. */
/** No HP dibandingkan dalam bentuk kanonik server (08…); isian tak sah dibandingkan apa adanya (server yang menolaknya). */
const hpKanonik = (v: string) => normalHp(v) ?? v.trim();
const cocokAkun = (v: string, opsi: string[]) => (!v.trim() ? "" : opsi.find((o) => kunciNama(o) === kunciNama(v)));

export default function TabHierarki({ scope }: { scope: Scope }) {
    void scope; // tab admin; server memeriksa cakupan global sendiri (allowedSalesCodes === null)
    const izin = useIzinFk("manage");
    const [load, muatUlang] = useLoad(useCallback(
        (): Promise<Load<Data>> => ambilFk("/api/form-kontrol/sales-profiles",
            (j) => ({ rows: (j.rows ?? []) as Profile[], spv: teks(j.spvOptions), sm: teks(j.smOptions) }), "Hierarki sales belum berhasil dimuat."), []));
    const [edits, setEdits] = useState<Record<string, Edit>>({});
    const [simpan, setSimpan] = useState<Profile | null>(null);
    const [sukses, setSukses] = useState("");

    const profiles = load.data?.rows ?? [];
    const opsi = { spv: load.data?.spv ?? [], sm: load.data?.sm ?? [] };
    const nilai = (p: Profile): Edit => edits[p.salesCode] ?? { spvName: p.spvName ?? "", smName: p.smName ?? "", noHp: p.noHp ?? "" };
    // Nama dibandingkan lewat kunciNama (trim + tanpa beda huruf), sama dengan server: ejaan lama "adnan" yang disimpan server sebagai ejaan
    // akun "ADNAN" bukan perubahan (tanpa ini baris tetap "Draf" sesudah tersimpan).
    const noHpBerubah = (p: Profile, e: Edit) => hpKanonik(e.noHp) !== (p.noHp ?? "");
    const berubah = (p: Profile) => { const e = edits[p.salesCode]; return Boolean(e) && (kunciNama(e.spvName) !== kunciNama(p.spvName) || kunciNama(e.smName) !== kunciNama(p.smName) || noHpBerubah(p, e)); };
    const nDraf = profiles.filter(berubah).length;
    useUnsavedGuard(nDraf > 0);
    const kunci = izin ?? (load.status !== "siap" ? "Tunggu daftar selesai dimuat ulang." : undefined);

    const grup = new Map<string, Profile[]>();
    for (const p of profiles) { const k = p.spvName?.trim() || TANPA_SPV; grup.set(k, [...(grup.get(k) ?? []), p]); }
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
                                    <li key={p.salesCode} className="grid items-end gap-3 border-t px-4 py-3 lg:grid-cols-[minmax(10rem,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" style={{ borderColor: "var(--line)" }}>
                                        <div className="min-w-0">
                                            <b className="fi-small">{p.salesName}</b>
                                            <span className="fi-codes">{p.salesCode} · {p.principle}</span>
                                            {draf && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf</span>}
                                        </div>
                                        {PERAN.map((k) => {
                                            const v = e[NAMA[k]];
                                            const akun = cocokAkun(v, opsi[k]);
                                            return (
                                                <FormField key={k} label={`${LABEL[k]} ${p.salesName}`}>{(a) => (
                                                    <select {...a} className="fi-input" value={akun ?? v}
                                                        onChange={(ev) => ubah(p, k === "spv" ? { spvName: ev.target.value } : { smName: ev.target.value })}>
                                                        <option value="">Belum dipilih</option>
                                                        {akun === undefined && <option value={v}>{v.trim()} (tidak cocok dengan akun)</option>}
                                                        {opsi[k].map((n) => <option key={n} value={n}>{n}</option>)}
                                                    </select>
                                                )}</FormField>
                                            );
                                        })}
                                        <FormField label={`No HP ${p.salesName}`}>{(a) => (
                                            <input {...a} className="fi-input" type="tel" inputMode="tel" autoComplete="off" placeholder="08…"
                                                value={e.noHp} onChange={(ev) => ubah(p, { noHp: ev.target.value })} />
                                        )}</FormField>
                                        <Button variant={draf ? "primary" : "secondary"} icon={<Save className="fi-icon" aria-hidden />}
                                            disabled={!draf || Boolean(kunci)} disabledReason={kunci ?? "Belum ada perubahan"} onClick={() => setSimpan(p)}>
                                            Simpan
                                        </Button>
                                        {PERAN.filter((k) => cocokAkun(e[NAMA[k]], opsi[k]) === undefined).map((k) => (
                                            <div key={k} style={{ gridColumn: "1 / -1" }}>
                                                <MessageStrip tone="warn" title={`${LABEL[k]} "${e[NAMA[k]].trim()}"`}>
                                                    tidak cocok dengan akun {LABEL[k]} mana pun, jadi {LABEL[k]} ini tidak melihat timnya. Pilih akun {LABEL[k]} dari daftar lalu simpan.
                                                </MessageStrip>
                                            </div>
                                        ))}
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
            <p className="fi-small fi-muted">SPV dan SM tiap salesman menentukan siapa yang bisa melihat data siapa (Dashboard SPV, Kontrol SM, cakupan Form Kontrol). Pilihan = nama akun SPV/SM aktif; akun dibuat di menu User dan Izin.</p>
            {kunci && <p className="fi-small fi-why">{kunci}</p>}
            {sukses && <MessageStrip tone="pos" title={sukses} onClose={() => setSukses("")} />}
            {isi}
            <ConfirmDialog
                open={simpan !== null}
                onClose={() => setSimpan(null)}
                title={`Ubah hierarki ${simpan?.salesName ?? ""}?`}
                description="Akibatnya langsung: SPV dan SM baru melihat data salesman ini; yang lama tidak lagi."
                facts={simpan && target ? [
                    ["Salesman", `${simpan.salesName} · ${simpan.salesCode}`],
                    ["SPV", `${simpan.spvName ?? KOSONG} → ${target.spvName.trim() || KOSONG}`],
                    ["SM", `${simpan.smName ?? KOSONG} → ${target.smName.trim() || KOSONG}`],
                    ...(noHpBerubah(simpan, target) ? [["No HP", `${simpan.noHp ?? KOSONG} → ${target.noHp.trim() || KOSONG}`] as [string, string]] : []),
                ] : []}
                confirmLabel="Simpan hierarki"
                confirmDisabled={kunci}
                onConfirm={async () => {
                    const p = simpan!;
                    const e = nilai(p);
                    const gagal = "Hierarki belum tersimpan.";
                    const hp = noHpBerubah(p, e);
                    try {
                        await tulisFk("/api/form-kontrol/sales-profiles", {
                            method: "PUT",
                            // noHp hanya dikirim bila diubah: menyimpan SPV/SM tidak menyentuh nomor; "" = hapus (server: null).
                            body: { salesCode: p.salesCode, spvName: e.spvName.trim() || null, smName: e.smName.trim() || null, ...(hp ? { noHp: e.noHp.trim() || null } : {}) },
                            gagal,
                        });
                    } catch (err) {
                        // 400 tanpa kalimat dari server (hanya kode NO_HP_TIDAK_SAH) tetap harus terbaca di dialog.
                        if (hp && (err as { status?: number }).status === 400 && (err as Error).message === gagal) throw new Error(`${gagal} No HP tidak sah: tulis nomor seluler Indonesia berbentuk 08… (10–13 angka).`);
                        throw err;
                    }
                    setSimpan(null);
                    // Isian tidak dibuang: sampai daftar termuat ulang baris tetap menampilkan nilai baru (lalu tidak lagi "Draf").
                    setSukses(`Hierarki ${p.salesName} tersimpan.`);
                    muatUlang();
                }}
            />
        </>
    );
}
