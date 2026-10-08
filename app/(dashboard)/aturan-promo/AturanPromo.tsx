/*
 * Tujuan: Aturan promo (Fiori S4a): List Report di kiri (status Aktif/Nonaktif/Berakhir/Belum mulai, asal, beban) + Object Page di kanan
 *   (kalimat "artinya", formulir ubah). Dialog Hapus, Salin tarif ke outlet, dan Impor Excel (dipindah dari Rekap; principal wajib,
 *   selalu pratinjau dulu). Tab kedua: Daftar outlet peserta. Persetujuan dan Muat dari Summary pindah ke halaman Summary.
 * Caller: app/(dashboard)/aturan-promo/page.tsx.
 * Dependensi: GET|POST|PATCH|PUT|DELETE /api/promo-rule, POST /api/promo-recap (impor, apply=false|true); components/fiori/*; lib/promo-ui; DaftarOutlet.
 * Main Functions: AturanPromo, Formulir.
 * Side Effects: HTTP; setiap simpan menulis `promo_rule` (izin summary.edit). Logic BL-52/33 tidak ditulis (varian berlabel).
 *
 * Gerbang validasi menahan setiap potongan yang tidak ada di sini, jadi aturan yang salah atau hilang langsung terasa: fakturnya tertahan.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, Plus, Save, Trash2, Upload } from "lucide-react";
import {
    Button, EmptyState, ErrorState, FlexibleColumnLayout, FooterToolbar, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge, VariantNote,
} from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { witaToday } from "@/lib/beranda";
import { BEBAN, STATUS_ATURAN, artinya, bebanDari, bentukAturan, manfaat, statusAturan, tgl, type StatusAturanKey } from "@/lib/promo-ui";
import DaftarOutlet from "./daftar-outlet";

type Rule = {
    id: number; principal: string; suratProgram: string; promoLabel: string; promoGroup: string;
    itemCode: string; itemName: string; customerCode: string;
    periodStart: string | null; periodEnd: string | null; active: boolean;
    tierNo: number; triggerQty: string; triggerUnit: string;
    benefitType: string; benefitValue: string; benefitUnit: string; benefitBeban: string;
    channel: string; outletList: string; outletListMode: string; note: string; importedBy: string;
    source?: string; sourceRef?: string;
};
type Payload = { rules: Rule[]; principals: string[]; total: number; truncated?: number };
type SaringStatus = "hidup" | "semua" | StatusAturanKey;
type Pratinjau = { rows: number; programs: number; tingkatFaktur: number; tarifOutlet: number; outlet: number; issues: string[] };

const KOSONG: Partial<Rule> = {
    principal: "", suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR", promoLabel: "", itemCode: "", itemName: "", customerCode: "",
    periodStart: "", periodEnd: "", active: true, tierNo: 1, triggerQty: "0", triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "", benefitUnit: "%", benefitBeban: "DISTRIBUTOR", channel: "", outletList: "", outletListMode: "", note: "",
};
const ASAL: Record<string, string> = { surat: "Surat", excel: "Impor Excel", manual: "Manual" };
const asalLabel = (r: Partial<Rule>) => `${ASAL[r.source ?? ""] ?? "Manual"}${r.suratProgram ? ` · ${r.suratProgram}` : ""}`;
const sama = (a: Partial<Rule>, b: Partial<Rule>) => JSON.stringify(a) === JSON.stringify(b);

function useDebounced(value: string, ms: number) {
    const [v, setV] = useState(value);
    useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
    return v;
}

/** Satu kelompok isian (di ruang modul supaya isian tidak kehilangan fokus tiap render). */
function Grup({ title, help, children }: { title: string; help: string; children: ReactNode }) {
    return (
        <Section title={title} subtitle={help}>
            <div className="fi-sect-in"><div className="fi-formgrid">{children}</div></div>
        </Section>
    );
}

/** Formulir aturan; nilai dipegang pemanggil. Mengunci isian bila tanpa izin ubah. */
function Formulir({ d, set, kunci }: { d: Partial<Rule>; set: (patch: Partial<Rule>) => void; kunci: boolean }) {
    const isTarif = Boolean(d.customerCode) && !d.itemCode;
    const inp = (k: keyof Rule, ph = "") => function Isian(a11y: object) {
        return <input {...a11y} className="fi-input" disabled={kunci} placeholder={ph} value={String(d[k] ?? "")} onChange={(e) => set({ [k]: e.target.value } as Partial<Rule>)} />;
    };
    return (
        <>
            <Grup title="Asal aturan" help="Tanpa ini tidak ada yang bisa menjawab “kenapa boleh potong?”">
                <FormField label="Principal" required>{inp("principal", "mis. KINO NON FOOD")}</FormField>
                <FormField label="Surat / program" help="Asal aturannya.">{inp("suratProgram")}</FormField>
                <FormField label="Kelompok" help="Pengelompokan di dalam surat.">{inp("promoGroup")}</FormField>
                <FormField label="Nama program" help="Untuk dibaca manusia saja.">{inp("promoLabel")}</FormField>
                <FormField label="Nama barang" help="Tidak dipakai mencocokkan.">{inp("itemName")}</FormField>
            </Grup>
            <Grup title="Berlaku untuk" help="Dikosongkan berarti “semua”. Daftar peserta menyempitkannya lagi.">
                <FormField label="Kode outlet" help="Kode internal tanpa akhiran cabang, mis. C-AL0063.">{inp("customerCode", "kosong = semua outlet")}</FormField>
                <FormField label="Kode barang">{inp("itemCode", "kosong = semua barang")}</FormField>
                <FormField label="Channel (Type Of Promo)" help="GT dicocokkan dengan outlet berkategori TT di Accurate.">{(a11y) => <select {...a11y} className="fi-input" disabled={kunci} value={d.channel ?? ""} onChange={(e) => set({ channel: e.target.value })}><option value="">Semua channel</option><option value="GT">GT (outlet TT)</option><option value="MT">MT</option><option value="NKA">NKA</option></select>}</FormField>
                <FormField label="Daftar peserta" help="Nama daftar di tab Daftar outlet peserta, mis. LOYALTY.">{(a11y) => <input {...a11y} className="fi-input" disabled={kunci} placeholder="kosong = semua outlet" value={d.outletList ?? ""} onChange={(e) => set({ outletList: e.target.value.toUpperCase(), outletListMode: e.target.value ? d.outletListMode || "INCLUDE" : "" })} />}</FormField>
                <FormField label="Arah daftar">{(a11y) => <select {...a11y} className="fi-input" disabled={kunci || !d.outletList} value={d.outletListMode ?? ""} onChange={(e) => set({ outletListMode: e.target.value })}><option value="">Tanpa daftar</option><option value="INCLUDE">Hanya peserta daftar</option><option value="EXCLUDE">Semua KECUALI peserta daftar</option></select>}</FormField>
            </Grup>
            <Grup title="Potongan" help="Berapa, dalam bentuk apa, di kolom mana, dan siapa yang menanggung.">
                <FormField label="Beban" help="Klaim principal bisa ditagihkan; beban distributor jadi biaya sendiri.">{(a11y) => <select {...a11y} className="fi-input" disabled={kunci} value={d.benefitBeban ?? "PRINCIPAL"} onChange={(e) => set({ benefitBeban: e.target.value })}><option value="PRINCIPAL">{BEBAN.principal.label}</option><option value="DISTRIBUTOR">{BEBAN.distributor.label}</option></select>}</FormField>
                <FormField label="Bentuk potongan">{(a11y) => <select {...a11y} className="fi-input" disabled={kunci} value={d.benefitType ?? "DISC_PCT"} onChange={(e) => set({ benefitType: e.target.value })}><option value="DISC_PCT">Diskon persen</option><option value="DISC_RP">Potongan rupiah</option><option value="BONUS_QTY">Bonus barang</option></select>}</FormField>
                <FormField label="Besar potongan" required help={d.benefitType === "DISC_RP" ? "Angka saja: 20000 = Rp 20.000." : d.benefitType === "BONUS_QTY" ? "Jumlah bonus." : "Angka saja: 2.25 = 2,25%."}>{inp("benefitValue", d.benefitType === "DISC_RP" ? "20000" : "2.25")}</FormField>
                <FormField label={isTarif ? "Kolom diskon ke" : "Tingkat"} help={isTarif ? "DISC_n laporan principal: 1–3 beban distributor, 4–5 klaim principal." : "Urutan tingkat pembelian, mulai 1."}>{(a11y) => <input {...a11y} className="fi-input" type="number" min={1} disabled={kunci} value={d.tierNo ?? 1} onChange={(e) => set({ tierNo: Number(e.target.value) })} />}</FormField>
                <FormField label="Minimal belanja" help="0 = tanpa syarat.">{inp("triggerQty")}</FormField>
                <FormField label="Satuan minimal">{(a11y) => <select {...a11y} className="fi-input" disabled={kunci} value={d.triggerUnit ?? "PCS"} onChange={(e) => set({ triggerUnit: e.target.value })}><option value="PCS">PCS</option><option value="KRT">KRT</option><option value="RP">RP</option></select>}</FormField>
            </Grup>
            <Grup title="Masa berlaku dan catatan" help="Dinilai per tanggal SO, bukan per periode batch.">
                <FormField label="Berlaku mulai" help="Kosong = sejak kapan pun.">{(a11y) => <input {...a11y} className="fi-input" type="date" disabled={kunci} value={d.periodStart ?? ""} onChange={(e) => set({ periodStart: e.target.value })} />}</FormField>
                <FormField label="Berlaku sampai" help="Kosong = sampai dicabut.">{(a11y) => <input {...a11y} className="fi-input" type="date" disabled={kunci} value={d.periodEnd ?? ""} onChange={(e) => set({ periodEnd: e.target.value })} />}</FormField>
                <FormField label="Catatan">{inp("note")}</FormField>
                <label className="fi-check" style={{ alignSelf: "end" }}><input type="checkbox" disabled={kunci} checked={d.active !== false} onChange={(e) => set({ active: e.target.checked })} />Aktif · dimatikan = diabaikan gerbang faktur dan Rekap</label>
            </Grup>
            {isTarif && d.benefitType === "DISC_PCT" && <MessageStrip tone="warn" title="Nomor kolom menentukan siapa yang menanggung.">Kolom 1–3 beban distributor, 4–5 klaim principal; beban yang tidak cocok dengan kolomnya ditolak saat disimpan.</MessageStrip>}
        </>
    );
}

export default function AturanPromo({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehUbah = keys.has("summary.edit");
    const [tab, setTab] = useState<"aturan" | "outlet">("aturan");
    const [principal, setPrincipal] = useState("");
    const [jenis, setJenis] = useState("");
    const [beban, setBeban] = useState("");
    const [status, setStatus] = useState<SaringStatus>("hidup");
    const [cari, setCari] = useState("");
    const [dari, setDari] = useState("");
    const [sampai, setSampai] = useState("");
    const [terpilihId, setTerpilihId] = useState<number | "baru" | null>(null);
    const [draf, setDraf] = useState<Partial<Rule> | null>(null);
    const [pilih, setPilih] = useState<Set<number>>(new Set());
    const [dialog, setDialog] = useState<"hapus" | "hapusSatu" | "salin" | "impor" | "buang" | null>(null);
    // Tujuan pindah yang menunggu konfirmasi buang perubahan (undefined = tidak ada).
    const [pindahKe, setPindahKe] = useState<number | "baru" | null | undefined>(undefined);
    const cariQ = useDebounced(cari.trim(), 300);
    const [salinKode, setSalinKode] = useState("");
    const [galatSimpan, setGalatSimpan] = useState<string | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const [menyimpan, setMenyimpan] = useState(false);
    const [impor, setImpor] = useState<{ principal: string; file: File | null; pratinjau: Pratinjau | null }>({ principal: "", file: null, pratinjau: null });
    const hariIni = witaToday();

    const query = new URLSearchParams(Object.entries({ principal, jenis, beban, q: cariQ, dari, sampai }).filter(([, v]) => v)).toString();
    const [data, muat] = useLoad(useCallback(() => ambil<Payload>(`/api/promo-rule?${query}`, (j) => {
        const d = j as Payload & { ok?: boolean; error?: string };
        if (d.ok === false) throw new Error(d.error ?? "Gagal memuat aturan promo");
        return d;
    }), [query]), { pertahankan: true });

    const rules = useMemo(() => (data.data?.rules ?? []).filter((r) => {
        const s = statusAturan(r, hariIni);
        return status === "semua" || (status === "hidup" ? s === "aktif" || s === "belum" : s === status);
    }), [data, status, hariIni]);
    const asli = typeof terpilihId === "number" ? data.data?.rules.find((r) => r.id === terpilihId) ?? null : null;
    const awal: Partial<Rule> | null = terpilihId === "baru" ? { ...KOSONG, principal: principal || "" } : asli ? { ...asli, periodStart: asli.periodStart ?? "", periodEnd: asli.periodEnd ?? "" } : null;
    const tampil = draf ?? awal;
    const berubah = draf !== null && awal !== null && !sama(draf, awal);
    useUnsavedGuard(berubah);
    const terpilihRules = rules.filter((r) => pilih.has(r.id));
    const ubahAsalSurat = berubah && asli?.source === "surat";

    function pindah(id: number | "baru" | null) { setTerpilihId(id); setDraf(null); setGalatSimpan(null); }
    /** Perubahan yang belum disimpan tidak dibuang diam-diam: pindah aturan lewat dialog. */
    function buka(id: number | "baru" | null) { if (berubah) { setPindahKe(id); setDialog("buang"); } else pindah(id); }

    async function simpan() {
        if (!tampil) return;
        setMenyimpan(true); setGalatSimpan(null); setPesan(null);
        try {
            const res = await fetch("/api/promo-rule", { method: tampil.id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tampil) });
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; rule?: { id: number }; id?: number };
            if (!res.ok || !body.ok) { setGalatSimpan(body.error ?? `Tidak tersimpan (HTTP ${res.status}).`); return; }
            setPesan(tampil.id ? `Aturan #${tampil.id} tersimpan. Gerbang faktur dan Rekap memakainya mulai sekarang.` : "Aturan baru tersimpan.");
            setDraf(null);
            if (!tampil.id) setTerpilihId(body.rule?.id ?? body.id ?? null);
            muat();
        } catch (e) {
            setGalatSimpan(e instanceof Error ? e.message : String(e));
        } finally {
            setMenyimpan(false);
        }
    }

    async function hapus(ids: number[]) {
        const res = await fetch(`/api/promo-rule?ids=${ids.join(",")}`, { method: "DELETE" });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; deleted?: number; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Gagal menghapus (HTTP ${res.status}).`);
        setDialog(null); setPilih(new Set());
        if (typeof terpilihId === "number" && ids.includes(terpilihId)) { setTerpilihId(null); setDraf(null); }
        setPesan(`${body.deleted ?? ids.length} aturan dihapus. Potongan yang tadinya dijelaskan aturan itu kembali tertahan gerbang validasi.`);
        muat();
    }

    async function salin() {
        if (!asli) return;
        const res = await fetch("/api/promo-rule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: asli.id, customerCodes: salinKode }) });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; outlets?: number; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Gagal menyalin (HTTP ${res.status}).`);
        setDialog(null); setSalinKode("");
        setPesan(`Tarif ${manfaat(asli.benefitType, asli.benefitValue)} (kolom DISC_${asli.tierNo}) disalin ke ${body.outlets ?? 0} outlet.`);
        muat();
    }

    /** Impor dua langkah: pratinjau (apply=false) lalu muat (apply=true). Principal dikirim dari layar. */
    async function jalankanImpor() {
        if (!impor.file || !impor.principal) return;
        const apply = Boolean(impor.pratinjau);
        const form = new FormData();
        form.append("file", impor.file); form.append("principal", impor.principal); form.append("apply", String(apply));
        const res = await fetch("/api/promo-recap", { method: "POST", credentials: "include", body: form });
        const body = (await res.json().catch(() => ({}))) as Pratinjau & { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Impor gagal (HTTP ${res.status}).`);
        if (!apply) { setImpor((s) => ({ ...s, pratinjau: body })); return; }
        const bagian = [body.rows > 0 ? `${body.rows} aturan surat (${body.programs} program)` : "", body.tarifOutlet > 0 ? `${body.tarifOutlet} tarif untuk ${body.outlet} outlet` : ""].filter(Boolean);
        setDialog(null); setImpor({ principal: "", file: null, pratinjau: null });
        setPesan(bagian.length ? `Dimuat ke ${impor.principal}: ${bagian.join(" + ")}.` : "Berkas ini tidak memuat satu aturan pun.");
        muat();
    }

    const statusOf = (r: Rule) => STATUS_ATURAN[statusAturan(r, hariIni)];
    const saringAktif = [principal, jenis, beban, dari || sampai].filter(Boolean).length + (status !== "hidup" ? 1 : 0);
    const memuatAwal = data.status === "memuat" && !data.data;

    const daftar = (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }}>
            <header>{bolehUbah && rules.length > 0 && <input type="checkbox" aria-label="Pilih semua aturan yang tampil" checked={rules.every((r) => pilih.has(r.id))} onChange={(e) => setPilih(e.target.checked ? new Set(rules.map((r) => r.id)) : new Set())} />}<h2>Aturan</h2><span>{rules.length}{data.data?.truncated ? ` dari ${data.data.total}+` : ""}{data.status === "memuat" && data.data ? " · memperbarui…" : ""}</span></header>
            {memuatAwal ? <div className="fi-sect-in"><Skeleton rows={6} label="Memuat aturan promo" /></div>
                : data.status === "galat" && !data.data ? <ErrorState message={data.error} onRetry={muat} />
                : rules.length === 0 ? <EmptyState title={cari ? `Tidak ada aturan untuk “${cari}”` : "Tidak ada aturan yang sesuai saringan"} message="Coba kode outlet tanpa akhiran cabang, atau ubah saringan status." />
                : (
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Daftar aturan">
                        {rules.map((r) => (
                            <li key={r.id} className="fi-wl-row">
                                {bolehUbah && <input type="checkbox" aria-label={`Pilih aturan ${r.id}`} checked={pilih.has(r.id)} onChange={() => setPilih((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />}
                                <button type="button" className="fi-li" aria-current={terpilihId === r.id || undefined} onClick={() => buka(r.id)}>
                                    <span className="fi-li-r1"><span className="fi-li-doc">#{r.id} · {bentukAturan(r).label}</span><StatusBadge tone={statusOf(r).tone}>{statusOf(r).label}</StatusBadge></span>
                                    <span className="fi-li-title">{r.itemCode ? `${r.itemCode} ${r.itemName}`.trim() : r.customerCode || "semua barang"} · {manfaat(r.benefitType, r.benefitValue)}</span>
                                    <span className="fi-li-r3"><span>{asalLabel(r)} · {r.customerCode || (r.outletList ? `${r.outletListMode === "EXCLUDE" ? "semua KECUALI" : "hanya"} ${r.outletList}` : "semua outlet")}{r.channel ? ` · ${r.channel}` : ""}</span><StatusBadge tone={BEBAN[bebanDari(r.benefitBeban)].tone}>{BEBAN[bebanDari(r.benefitBeban)].label}</StatusBadge></span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            {!!data.data?.truncated && <div className="fi-sect-in"><p className="fi-small fi-subtle">Ditampilkan 500 aturan pertama; persempit dengan saringan.</p></div>}
        </div>
    );

    const detail = !tampil ? (
        <EmptyState title="Pilih aturan di daftar" message="Detail dan kalimat artinya tampil di sini." action={bolehUbah ? <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => buka("baru")}>Aturan baru</Button> : undefined} />
    ) : (
        <div style={{ display: "grid", gap: 12 }}>
            <ObjectPageHeader title={tampil.id ? `Aturan #${tampil.id}` : "Aturan baru"} draft={berubah}
                status={tampil.id && asli ? <><StatusBadge tone={statusOf(asli).tone}>{statusOf(asli).label}</StatusBadge> <StatusBadge tone={BEBAN[bebanDari(tampil.benefitBeban ?? "")].tone}>{BEBAN[bebanDari(tampil.benefitBeban ?? "")].label}</StatusBadge></> : undefined}
                attributes={[{ label: "Asal", value: asalLabel(tampil) }, { label: "Berlaku", value: `${tgl(tampil.periodStart) || "kapan pun"} – ${tgl(tampil.periodEnd) || "dicabut"}` }, ...(tampil.importedBy ? [{ label: "Oleh", value: tampil.importedBy }] : [])]} />
            {galatSimpan && <MessageStrip tone="neg" title={galatSimpan} onClose={() => setGalatSimpan(null)} />}
            {ubahAsalSurat && (
                <>
                    <MessageStrip tone="warn" title="Mengubah aturan asal surat menjadikannya aturan manual.">Muat ulang {asli?.suratProgram} dari Summary akan gagal selama aturan manual ini ada.</MessageStrip>
                    <VariantNote bl="BL-52">Usulan: aturan tetap tercatat asal suratnya dengan tanda “diubah manual”; muat ulang melewatinya dan melaporkannya.</VariantNote>
                </>
            )}
            <MessageStrip tone="info" title="Artinya:">{artinya(tampil)}{tampil.id && asli && !asli.active ? " Aturan ini nonaktif, jadi gerbang faktur mengabaikannya dan potongannya terhitung tak bertuan." : ""}</MessageStrip>
            <Formulir d={tampil} kunci={!bolehUbah} set={(patch) => setDraf({ ...(draf ?? awal!), ...patch })} />
            {bolehUbah && (
                <FooterToolbar message={berubah ? "Perubahan belum disimpan" : undefined}>
                    {tampil.id && <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} onClick={() => setDialog("hapusSatu")}>Hapus…</Button>}
                    {asli && asli.customerCode && !asli.itemCode && <Button icon={<Copy className="fi-icon" aria-hidden />} onClick={() => { setSalinKode(""); setDialog("salin"); }}>Salin ke outlet lain…</Button>}
                    {berubah && <Button variant="tertiary" onClick={() => { setDraf(null); setGalatSimpan(null); if (terpilihId === "baru") setTerpilihId(null); }}>Batal</Button>}
                    <Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} busy={menyimpan} disabled={tampil.id ? !berubah : !tampil.principal || !tampil.benefitValue} disabledReason={tampil.id ? "Belum ada perubahan" : "Isi principal dan besar potongan"} onClick={simpan}>Simpan</Button>
                </FooterToolbar>
            )}
        </div>
    );

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><span aria-current="page">Aturan Promo</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Aturan promo</h1>
                    <span className="fi-spacer" />
                    {bolehUbah && tab === "aturan" && <Button icon={<Upload className="fi-icon" aria-hidden />} onClick={() => { setImpor({ principal: principal || "", file: null, pratinjau: null }); setDialog("impor"); }}>Impor Excel…</Button>}
                    {bolehUbah && tab === "aturan" && <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => buka("baru")}>Aturan baru</Button>}
                </div>
                <p>Daftar potongan yang boleh muncul di faktur. Gerbang validasi menahan setiap potongan yang tidak ada di sini. Persetujuan dan Muat dari Summary kini ada di halaman Summary.</p>
                <div className="fi-segs" role="group" aria-label="Bagian">
                    <button type="button" aria-pressed={tab === "aturan"} onClick={() => setTab("aturan")}>Aturan{data.data ? ` (${data.data.total})` : ""}</button>
                    <button type="button" aria-pressed={tab === "outlet"} onClick={() => setTab("outlet")}>Daftar outlet peserta</button>
                </div>
            </header>

            {tab === "outlet" ? <DaftarOutlet bolehUbah={bolehUbah} /> : (
                <>
                    {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
                    {data.status === "galat" && data.data && <MessageStrip tone="neg" title="Gagal memperbarui aturan promo.">{data.error} Daftar masih hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}
                    <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                        <FilterBar title="Saringan" activeCount={saringAktif} onReset={() => { setPrincipal(""); setJenis(""); setBeban(""); setStatus("hidup"); setDari(""); setSampai(""); }}
                            search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Kode outlet, barang, atau surat" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                            fields={<>
                                <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => setPrincipal(e.target.value)}><option value="">Semua principal</option>{(data.data?.principals ?? []).map((p) => <option key={p}>{p}</option>)}</select>}</FormField>
                                <FormField label="Status">{(a11y) => <select {...a11y} className="fi-input" value={status} onChange={(e) => setStatus(e.target.value as SaringStatus)}><option value="hidup">Aktif dan belum mulai</option><option value="semua">Semua status</option><option value="aktif">Aktif</option><option value="nonaktif">Nonaktif</option><option value="berakhir">Berakhir</option><option value="belum">Belum mulai</option></select>}</FormField>
                                <FormField label="Beban">{(a11y) => <select {...a11y} className="fi-input" value={beban} onChange={(e) => setBeban(e.target.value)}><option value="">Semua beban</option><option value="PRINCIPAL">{BEBAN.principal.label}</option><option value="DISTRIBUTOR">{BEBAN.distributor.label}</option></select>}</FormField>
                                <FormField label="Berlaku untuk">{(a11y) => <select {...a11y} className="fi-input" value={jenis} onChange={(e) => setJenis(e.target.value)}><option value="">Semua bentuk</option><option value="tarif">Tarif outlet</option><option value="barang">Per barang</option><option value="faktur">Tingkat faktur</option></select>}</FormField>
                                <FormField label="Berlaku dari">{(a11y) => <input {...a11y} className="fi-input" type="date" value={dari} max={sampai || undefined} onChange={(e) => setDari(e.target.value)} />}</FormField>
                                <FormField label="Berlaku sampai">{(a11y) => <input {...a11y} className="fi-input" type="date" value={sampai} min={dari || undefined} onChange={(e) => setSampai(e.target.value)} />}</FormField>
                            </>}
                            chips={[
                                ...(principal ? [{ label: `Principal: ${principal}`, onRemove: () => setPrincipal("") }] : []),
                                ...(status !== "hidup" ? [{ label: `Status: ${status === "semua" ? "Semua" : STATUS_ATURAN[status].label}`, onRemove: () => setStatus("hidup") }] : []),
                                ...(beban ? [{ label: `Beban: ${BEBAN[bebanDari(beban)].label}`, onRemove: () => setBeban("") }] : []),
                                ...(jenis ? [{ label: `Bentuk: ${jenis}`, onRemove: () => setJenis("") }] : []),
                                ...(dari || sampai ? [{ label: `Berlaku: ${tgl(dari) || "…"} – ${tgl(sampai) || "…"}`, onRemove: () => { setDari(""); setSampai(""); } }] : []),
                            ]} />
                    </div>
                    <FlexibleColumnLayout list={daftar} detail={detail} detailOpen={terpilihId !== null} onBack={() => buka(null)} listLabel="Daftar aturan" detailLabel="Detail aturan" />
                    {bolehUbah && terpilihRules.length > 0 && (
                        <FooterToolbar message={<span className="fi-sum"><b>{terpilihRules.length} aturan dipilih</b></span>}>
                            <Button variant="tertiary" onClick={() => setPilih(new Set())}>Batal pilih</Button>
                            <Button variant="negative" icon={<Trash2 className="fi-icon" aria-hidden />} onClick={() => setDialog("hapus")}>Hapus {terpilihRules.length} aturan…</Button>
                        </FooterToolbar>
                    )}
                </>
            )}

            <ConfirmDialog open={dialog === "hapus" || dialog === "hapusSatu"} onClose={() => setDialog(null)} tag="Hapus" tone="negative"
                title={dialog === "hapusSatu" ? `Hapus aturan #${tampil?.id ?? ""}?` : `Hapus ${terpilihRules.length} aturan?`} confirmLabel="Hapus aturan"
                onConfirm={() => hapus(dialog === "hapusSatu" && tampil?.id ? [tampil.id] : terpilihRules.map((r) => r.id))}
                facts={[
                    ["Aturan", dialog === "hapusSatu" && tampil ? `${asalLabel(tampil)} · ${tampil.customerCode || tampil.itemCode || "seluruh nota"} · ${manfaat(tampil.benefitType ?? "", tampil.benefitValue ?? "")}` : terpilihRules.slice(0, 3).map((r) => `#${r.id}`).join(", ") + (terpilihRules.length > 3 ? ` dan ${terpilihRules.length - 3} lain` : "")],
                    ["Akibat", "Potongan yang tadinya dijelaskan aturan ini kembali tertahan gerbang validasi; fakturnya tidak bisa dikirim sampai ada aturan pengganti"],
                ]} />
            <ConfirmDialog open={dialog === "buang"} onClose={() => { setDialog(null); setPindahKe(undefined); }} tag="Perubahan" tone="negative" title={`Buang perubahan pada aturan #${tampil?.id ?? "baru"}?`}
                confirmLabel="Buang perubahan" onConfirm={() => { setDialog(null); if (pindahKe !== undefined) pindah(pindahKe); setPindahKe(undefined); }}
                facts={[["Akibat", "Isian yang diubah dikembalikan ke nilai tersimpan"]]} />
            <ConfirmDialog open={dialog === "salin"} onClose={() => setDialog(null)} tag="Salin tarif" title={asli ? `Salin tarif ${manfaat(asli.benefitType, asli.benefitValue)} dari ${asli.customerCode} ke outlet lain?` : "Salin tarif"}
                confirmLabel="Salin tarif" confirmDisabled={salinKode.trim() ? undefined : "Isi kode outlet dulu"} onConfirm={salin}
                facts={[["Disimpan", "Satu baris per kode outlet; pencocokan per pelanggan"], ["Kolom", asli ? `DISC_${asli.tierNo} · ${BEBAN[bebanDari(asli.benefitBeban)].label}` : ""]]}>
                <FormField label="Kode outlet tujuan" required help="Pisahkan dengan koma, spasi, atau baris baru, mis. C-SAT015, C-SAT016.">{(a11y) => <textarea {...a11y} className="fi-input" rows={3} value={salinKode} onChange={(e) => setSalinKode(e.target.value)} />}</FormField>
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "impor"} onClose={() => setDialog(null)} tag="Impor"
                title={impor.pratinjau ? `Muat aturan ke ${impor.principal}?` : "Impor aturan dari Excel"} confirmLabel={impor.pratinjau ? "Muat aturan" : "Pratinjau"}
                confirmDisabled={!impor.principal ? "Pilih principal dulu" : !impor.file ? "Pilih berkas dulu" : undefined} onConfirm={jalankanImpor}
                facts={impor.pratinjau ? [
                    ["Aturan surat", `${impor.pratinjau.rows} baris · ${impor.pratinjau.programs} program · ${impor.pratinjau.tingkatFaktur} tingkat faktur`],
                    ["Tarif outlet", impor.pratinjau.tarifOutlet ? `${impor.pratinjau.tarifOutlet} tarif untuk ${impor.pratinjau.outlet} outlet` : "Tidak ada"],
                    ["Yang diganti", "Hanya bagian yang dibawa berkas ini untuk principal ini: sheet Detail mengganti aturan surat, sheet Discount Reguler mengganti tarif outlet"],
                ] as Array<[string, string]> : [["Berkas", "Sheet Detail dan/atau Discount Reguler (.xlsx, maks. 20 MB)"]]}>
                <FormField label="Principal" required help="Aturan dimuat ke principal ini.">{(a11y) => <><input {...a11y} className="fi-input" list="fi-principal-list" value={impor.principal} onChange={(e) => { const v = e.target.value; const kanon = (data.data?.principals ?? []).find((x) => x.toUpperCase() === v.trim().toUpperCase()); setImpor({ ...impor, principal: kanon ?? v.toUpperCase(), pratinjau: null }); }} /><datalist id="fi-principal-list">{(data.data?.principals ?? []).map((p) => <option key={p} value={p} />)}</datalist></>}</FormField>
                <FormField label="Berkas Excel" required>{(a11y) => <input {...a11y} className="fi-input" type="file" accept=".xlsx" onChange={(e) => setImpor({ ...impor, file: e.target.files?.[0] ?? null, pratinjau: null })} />}</FormField>
                {impor.pratinjau?.issues.length ? <MessageStrip tone="warn" title={`${impor.pratinjau.issues.length} temuan:`}>{impor.pratinjau.issues.slice(0, 3).join("; ")}{impor.pratinjau.issues.length > 3 ? " …" : ""}</MessageStrip> : null}
            </ConfirmDialog>
        </div>
    );
}
