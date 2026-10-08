/*
 * Tujuan: "Toko tidak order" (Fiori S5, it05, ponsel dulu): toko berstatus tidak order pada tanggal rute, alasan R01–R14 + catatan
 *   per toko, disimpan per baris; galat muat ≠ kosong.
 * Caller: form-kontrol/page.tsx (shell tab, default export `({ scope })`).
 * Dependensi: GET /api/form-kontrol/ao-control + /reasons, POST /api/form-kontrol/ao-control; ../shared (Scope, AoRow, Reason,
 *   PRINCIPLES, hariIniWita); ../lapangan (bacaFk, kirimFk, keBarisRute); components/fiori/*; lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: TabNoOrder.
 * Side Effects: HTTP GET; POST ao-control (status not_order + alasan) per toko — payload sama dengan kode lama.
 */
"use client";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { CalendarDays, RefreshCw, Save } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { type Scope, type AoRow, type Reason, PRINCIPLES, useIzinFk } from "../shared";
import { bacaFk, keBarisRute, kirimFk, useHariBeku } from "../lapangan";

type Alasan = { reasonCode: string; note: string };
type Data = { rows: AoRow[]; reasons: Reason[] };
type Isian = { dari?: Data; ubah: Record<string, Alasan>; simpan: Record<string, Alasan> };

/** Isian milik data yang sedang tampil; data baru (muat ulang) = isian kosong. */
const dasar = (i: Isian, data: Data | undefined): Isian => (data && i.dari === data ? i : { dari: data, ubah: {}, simpan: {} });
const tersimpanDi = (i: Isian, r: AoRow): Alasan => i.simpan[r.custCode] ?? { reasonCode: r.noOrderReasonCode ?? "", note: r.noOrderNote ?? "" };

export default function TabNoOrder({ scope }: { scope: Scope }) {
    const judulId = useId();
    const salesman = Boolean(scope.salesCode);
    const tim = scope.allowedSalesCodes;
    // Salesman: hari ini WITA dibekukan saat layar dibuka (lewat 00.00 isian tidak hilang; strip menawarkan hari baru).
    const beku = useHariBeku();
    const [tanggalPilih, setTanggalPilih] = useState(beku.hari);
    const tanggal = salesman ? beku.hari : tanggalPilih;
    const [principle, setPrinciple] = useState(scope.principle ?? PRINCIPLES[0]);
    const [salesCode, setSalesCode] = useState(scope.salesCode ?? "");
    const tanpaIzin = useIzinFk("submit");

    const loader = useCallback(async (): Promise<Load<Data>> => {
        if (!salesCode) return { status: "siap", data: { rows: [], reasons: [] } };
        const p = new URLSearchParams({ date: tanggal, principle });
        p.set("salesCode", salesCode);
        const [ao, alasan] = await Promise.all([
            bacaFk(`/api/form-kontrol/ao-control?${p}`, (d) => keBarisRute(d.rows, principle).filter((r) => r.status === "not_order")),
            bacaFk("/api/form-kontrol/reasons", (d) => (Array.isArray(d.rows) ? d.rows : []) as Reason[]),
        ]);
        if (ao.status !== "siap") return { status: "galat", error: `Toko tidak order gagal dimuat. ${ao.error ?? ""}`.trim() };
        if (alasan.status !== "siap") return { status: "galat", error: `Daftar alasan gagal dimuat. ${alasan.error ?? ""}`.trim() };
        return { status: "siap", data: { rows: ao.data!, reasons: alasan.data! } };
    }, [tanggal, principle, salesCode]);
    const [load, muatUlang] = useLoad(loader);
    const data = load.data;

    // Isian per toko + alasan yang sudah tersimpan sesi ini; keduanya kembali ke data server saat data dimuat ulang.
    // Semua pembaruan lewat setter fungsional dari state TERBARU (bukan `sesi` hasil render): simpan toko A yang selesai sesudah await
    // tidak boleh membuang ketikan toko B yang diisi selama menunggu (temuan peninjau P2).
    const [isian, setIsian] = useState<Isian>({ ubah: {}, simpan: {} });
    const sesi = useMemo(() => dasar(isian, data), [data, isian]);
    const [menyimpan, setMenyimpan] = useState<string | null>(null);
    const [galat, setGalat] = useState<Record<string, string>>({});

    const tersimpan = (r: AoRow): Alasan => tersimpanDi(sesi, r);
    const nilai = (r: AoRow): Alasan => sesi.ubah[r.custCode] ?? tersimpan(r);
    const berubah = (r: AoRow) => { const a = nilai(r), b = tersimpan(r); return a.reasonCode !== b.reasonCode || a.note !== b.note; };
    const rows = data?.rows ?? [];
    const nDraf = rows.filter(berubah).length;
    const tanpaAlasan = rows.filter((r) => !tersimpan(r).reasonCode).length;
    useUnsavedGuard(nDraf > 0);

    const ketik = (cust: string, patch: Partial<Alasan>, r: AoRow) => {
        setGalat((g) => ({ ...g, [cust]: "" }));
        setIsian((prev) => {
            const b = dasar(prev, data);
            return { ...b, ubah: { ...b.ubah, [cust]: { ...(b.ubah[cust] ?? tersimpanDi(b, r)), ...patch } } };
        });
    };

    async function simpan(r: AoRow) {
        const a = nilai(r);
        if (!a.reasonCode || menyimpan) return;
        setMenyimpan(r.custCode);
        setGalat((g) => ({ ...g, [r.custCode]: "" }));
        try {
            await kirimFk("/api/form-kontrol/ao-control", {
                salesCode: r.salesCode,
                custCode: r.custCode,
                principle,
                date: tanggal,
                status: "not_order",
                noOrderReasonCode: a.reasonCode,
                noOrderNote: a.note,
            }, { ulangAman: true });
            setIsian((prev) => {
                const b = dasar(prev, data);
                const ubah = { ...b.ubah };
                // Isian toko ini yang diubah lagi selama menunggu tetap jadi draf; yang sama dengan kiriman dibersihkan.
                const kini = ubah[r.custCode];
                if (kini && kini.reasonCode === a.reasonCode && kini.note === a.note) delete ubah[r.custCode];
                return { ...b, ubah, simpan: { ...b.simpan, [r.custCode]: a } };
            });
        } catch (e) {
            setGalat((g) => ({ ...g, [r.custCode]: `Alasan belum tersimpan. ${e instanceof Error ? e.message : ""}`.trim() }));
        } finally {
            setMenyimpan(null);
        }
    }

    let isi: ReactNode;
    if (!salesCode) {
        isi = tim === null ? <EmptyState title="Isi kode salesman" message="Toko tidak order tampil per salesman." />
            : tim.length === 0 ? <EmptyState title="Belum ada salesman di tim Anda" message="Salesman muncul setelah Admin Sales mengisi SPV/SM mereka di Hierarki Sales." />
                : <EmptyState title="Pilih salesman tim Anda" message="Toko tidak order tampil per salesman." />;
    } else if (load.status === "galat" && rows.length === 0) {
        isi = <ErrorState title="Data gagal dimuat" message={`${load.error} Ini bukan daftar kosong.`} onRetry={muatUlang} />;
    } else if (!data) {
        isi = <Skeleton rows={4} label="Memuat toko tidak order" />;
    } else if (rows.length === 0) {
        isi = <EmptyState title="Tidak ada toko berstatus tidak order" message={`Belum ada toko ${principle} yang dicatat tidak order untuk ${tanggalPanjang(tanggal)}.`} />;
    } else {
        isi = (
            <div className={load.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={load.status === "memuat" || undefined}>
                {load.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {load.error} Yang tampil adalah hasil sebelumnya.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                    </MessageStrip>
                )}
                {tanpaAlasan > 0 && <MessageStrip tone="warn" title={`${tanpaAlasan} toko belum punya alasan tersimpan.`}>Setiap toko tidak order wajib beralasan.</MessageStrip>}
                <Section title="Toko tidak order" subtitle={`${rows.length} toko`}>
                    <ul aria-label="Toko tidak order" style={{ listStyle: "none", padding: 0 }}>
                        {rows.map((r) => {
                            const a = nilai(r);
                            const draf = berubah(r);
                            const ada = Boolean(tersimpan(r).reasonCode);
                            return (
                                <li key={r.custCode} className="fi-sect-in" style={{ borderBottom: "1px solid var(--line)" }} aria-label={r.custName}>
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <b className="fi-title-3" style={{ overflowWrap: "anywhere" }}>{r.custName}</b>
                                            <span className="fi-sub fi-mono">{r.custCode}</span>
                                        </div>
                                        {draf ? <StatusBadge tone="warn">Belum disimpan</StatusBadge>
                                            : ada ? <StatusBadge tone="pos">Alasan tersimpan</StatusBadge>
                                                : <StatusBadge tone="neg">Belum ada alasan</StatusBadge>}
                                    </div>
                                    <FormField label="Alasan tidak order" required error={!a.reasonCode ? "Pilih alasan" : undefined}>
                                        {(f) => (
                                            <select {...f} className="fi-input" value={a.reasonCode} onChange={(e) => ketik(r.custCode, { reasonCode: e.target.value }, r)}>
                                                <option value="">Pilih alasan</option>
                                                {data.reasons.map((x) => <option key={x.reasonCode} value={x.reasonCode}>{x.reasonCode} · {x.label}</option>)}
                                            </select>
                                        )}
                                    </FormField>
                                    <FormField label="Catatan">
                                        {(f) => <input {...f} className="fi-input" value={a.note} placeholder="opsional" onChange={(e) => ketik(r.custCode, { note: e.target.value }, r)} />}
                                    </FormField>
                                    {galat[r.custCode] && <p className="fi-msg" role="alert">{galat[r.custCode]}</p>}
                                    <div className="fi-btnrow">
                                        <Button variant={draf ? "primary" : "secondary"} icon={<Save className="fi-icon" aria-hidden />} busy={menyimpan === r.custCode}
                                            disabled={Boolean(tanpaIzin) || !a.reasonCode || (menyimpan !== null && menyimpan !== r.custCode)}
                                            disabledReason={tanpaIzin ?? (!a.reasonCode ? "Pilih alasan dulu" : "Menunggu simpanan lain selesai")}
                                            onClick={() => void simpan(r)}>Simpan alasan</Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </Section>
            </div>
        );
    }

    return (
        <section aria-labelledby={judulId} className="grid gap-4">
            <div className="grid gap-1">
                <h2 id={judulId} className="fi-title-2">Toko tidak order</h2>
                <p className="fi-small fi-muted flex flex-wrap items-center gap-x-2">
                    <CalendarDays className="fi-icon" aria-hidden /><span>{tanggalPanjang(tanggal)} · WITA</span>
                    {salesCode && <span>· <span className="fi-mono">{salesCode}</span> · {principle}</span>}
                </p>
                <p className="fi-small fi-muted">Tidak boleh ada toko tanpa alasan — setiap toko tidak order wajib terdokumentasi.</p>
            </div>
            <div className="fi-formgrid">
                <FormField label="Principal">
                    {(a) => (
                        <select {...a} className="fi-input" value={principle} onChange={(e) => setPrinciple(e.target.value)}>
                            {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    )}
                </FormField>
                {!salesman && tim === null && (
                    <FormField label="Kode salesman">
                        {(a) => <input {...a} className="fi-input fi-mono" value={salesCode} placeholder="mis. S01" onChange={(e) => setSalesCode(e.target.value)} />}
                    </FormField>
                )}
                {!salesman && tim !== null && tim.length > 0 && (
                    <FormField label="Salesman tim">
                        {(a) => (
                            <select {...a} className="fi-input" value={salesCode} onChange={(e) => setSalesCode(e.target.value)}>
                                <option value="">Pilih salesman</option>
                                {tim.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        )}
                    </FormField>
                )}
                {!salesman && (
                    <FormField label="Tanggal">
                        {(a) => <input {...a} type="date" className="fi-input" value={tanggalPilih} onChange={(e) => { if (e.target.value) setTanggalPilih(e.target.value); }} />}
                    </FormField>
                )}
                {salesCode && (
                    <div className="flex items-end">
                        <Button icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang} busy={load.status === "memuat" && Boolean(data)}>Muat ulang</Button>
                    </div>
                )}
            </div>
            {salesman && beku.berganti && (
                <MessageStrip tone="warn" title="Tanggal sudah berganti.">
                    Toko dan isian yang tampil masih untuk {tanggalPanjang(tanggal)}; tidak ada yang dibuang.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={beku.pakaiHariBaru}>Muat {tanggalPanjang(beku.hariBaru)}</button>
                </MessageStrip>
            )}
            {nDraf > 0 && <p className="fi-draft" role="status">{nDraf} alasan belum disimpan.</p>}
            {isi}
            <VariantNote bl="Toko tutup">
                “Toko tutup” belum menjadi kode alasan sendiri (jawaban owner 7 Okt); sementara pilih R14 Lainnya dan tulis “toko tutup” di catatan.
                Usulan: kode alasan baru di daftar alasan dan laporan.
            </VariantNote>
        </section>
    );
}
