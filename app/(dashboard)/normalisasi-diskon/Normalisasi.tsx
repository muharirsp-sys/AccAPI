/*
 * Tujuan: Worklist Normalisasi diskon (Fiori S4a): potongan tak bertuan pada faktur Accurate digolongkan sebagai Klaim principal atau
 *   Beban distributor DENGAN aturan promo dasarnya. Tiga kelompok (Tak bertuan, Perlu diputuskan ulang, Sudah digolongkan);
 *   pilih baris lalu Golongkan… / Batalkan… lewat dialog (pengganti window.confirm dan formulir di atas tabel).
 * Caller: app/(dashboard)/normalisasi-diskon/page.tsx.
 * Dependensi: GET /api/promo-recap (baris + calon aturan), POST|DELETE /api/promo-recap/normalisasi; components/fiori/*; lib/promo-ui.
 * Main Functions: Normalisasi, otomatisPerBaris, calonSurat, labelCalon, kelompokkan.
 * Side Effects: HTTP; menulis `discount_normalization`. TIDAK menulis ke Accurate.
 *
 * Faktur yang terbit lewat web ikut ditampilkan (bertanda "web"): gerbang menilai ORDER, bukan faktur yang akhirnya ada di Accurate.
 * Golongan tidak bisa dipilih bebas (sejak 1 Okt 2026): Klaim principal butuh aturan beban principal, Beban distributor butuh aturan
 * beban distributor, dan aturannya harus berlaku untuk potongan itu. Calonnya dihitung server; satu keputusan untuk beberapa potongan
 * hanya bisa memakai surat yang berlaku untuk SEMUANYA, atau "Otomatis per baris".
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Tags, Undo2 } from "lucide-react";
import { Button, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { BEBAN, persen, rupiah, tgl, type BebanKey } from "@/lib/promo-ui";

type Golongan = BebanKey;
type Row = {
    bucket: Golongan | "unowned"; web?: boolean;
    invoiceNo: string; invoiceId: string; lineKey: string; transDate: string; branchName: string;
    customerNo: string; customerName: string; itemCode: string; itemName: string;
    positions: string; percent: number; amount: number;
    suratProgram: string; promoGroup: string; reason: string;
    calonAturan?: Record<Golongan, number[]>; aturanId?: number; bekasNormalisasi?: Golongan;
};
type Aturan = {
    id: number; suratProgram: string; promoGroup: string; promoLabel: string; itemCode: string; itemName: string;
    customerCode: string; periodStart: string | null; periodEnd: string | null; tierNo: number;
    benefitType: string; benefitValue: string; benefitBeban: string; outletList: string; outletListMode: string;
};
type Data = { principals: string[]; recap: { rows: Row[] }; webInvoiceIds: string[]; aturan?: Aturan[] };
type Grup = { key: string; invoiceNo: string; transDate: string; customerNo: string; customerName: string;
    positions: string; percent: number; bucket: Row["bucket"]; rows: Row[]; amount: number; reason: string };
type Tab = "takBertuan" | "ulang" | "sudah";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const kunciBaris = (row: Pick<Row, "lineKey" | "positions">) => `${row.lineKey}|${row.positions}`;
const OTOMATIS = "__otomatis__";

function nilaiAturan(a: Aturan) {
    if (a.benefitType === "DISC_RP") return rupiah(Number(a.benefitValue));
    if (a.benefitType === "BONUS_QTY") return `bonus ${a.benefitValue}`;
    return persen(a.benefitValue);
}

/** Aturan yang NILAINYA sama persis dengan potongan: persen sama, atau bonus untuk potongan 100%. */
const nilaiSama = (a: Aturan, row: Row) => (a.benefitType === "DISC_PCT" && Number(a.benefitValue) === row.percent)
    || (a.benefitType === "BONUS_QTY" && row.percent === 100);

/** OTOMATIS PER BARIS (2 Okt 2026): pilih sendiri HANYA bila potongan punya TEPAT SATU aturan berlaku bernilai sama; sisanya dilewati. */
export function otomatisPerBaris(rows: Row[], golongan: Golongan, aturanById: Map<number, Aturan>) {
    const pilihan = new Map<string, Aturan>();
    for (const row of rows) {
        const sama = (row.calonAturan?.[golongan] ?? []).map((id) => aturanById.get(id))
            .filter((a): a is Aturan => Boolean(a) && nilaiSama(a!, row));
        if (sama.length === 1) pilihan.set(kunciBaris(row), sama[0]);
    }
    return { pilihan, lewat: rows.length - pilihan.size, surat: [...new Set([...pilihan.values()].map((a) => a.suratProgram))].sort() };
}

/** Calon dasar = SURAT yang punya aturan berlaku untuk SETIAP potongan terpilih; per potongan, aturan bernilai sama didahulukan. */
type CalonSurat = { surat: string; pilihan: Map<string, Aturan>; sama: boolean };
export function calonSurat(rows: Row[], golongan: Golongan, aturanById: Map<number, Aturan>): CalonSurat[] {
    if (!rows.length) return [];
    const perBaris = rows.map((row) => (row.calonAturan?.[golongan] ?? []).map((id) => aturanById.get(id)).filter((a): a is Aturan => Boolean(a)));
    const surat = [...new Set(perBaris[0].map((a) => a.suratProgram))].filter((nama) => perBaris.every((daftar) => daftar.some((a) => a.suratProgram === nama)));
    return surat.map((nama) => {
        const pilihan = new Map<string, Aturan>();
        let sama = true;
        rows.forEach((row, index) => {
            const milik = perBaris[index].filter((a) => a.suratProgram === nama);
            const cocok = milik.find((a) => nilaiSama(a, row));
            if (!cocok) sama = false;
            pilihan.set(kunciBaris(row), cocok ?? milik[0]);
        });
        return { surat: nama, pilihan, sama };
    }).sort((x, y) => Number(y.sama) - Number(x.sama) || x.surat.localeCompare(y.surat));
}

function labelCalon(c: CalonSurat) {
    const aturan = [...new Set(c.pilihan.values())];
    const a = aturan[0];
    const kelompok = [...new Set(aturan.map((x) => x.promoGroup || x.promoLabel).filter(Boolean))];
    const cakupan = aturan.length > 1 ? `${aturan.length} aturan (per barang)` : a.customerCode ? `tarif ${a.customerCode} posisi ${a.tierNo}` : a.itemCode || "seluruh nota";
    const periode = a.periodStart || a.periodEnd ? `${tgl(a.periodStart) || "…"}–${tgl(a.periodEnd) || "dicabut"}` : "tanpa batas waktu";
    return [c.surat, kelompok.slice(0, 2).join(", ") + (kelompok.length > 2 ? ` +${kelompok.length - 2}` : ""),
        [...new Set(aturan.map(nilaiAturan))].join(" / "), cakupan, periode].filter(Boolean).join(" · ");
}

/** Satu grup = faktur × posisi × persen: keputusan diambil per faktur. Diurutkan per outlet. */
export function kelompokkan(rows: Row[]): Grup[] {
    const map = new Map<string, Grup>();
    for (const row of rows) {
        const key = `${row.bucket}|${row.invoiceId}|${row.positions}|${row.percent}`;
        const grup = map.get(key) ?? { key, invoiceNo: row.invoiceNo, transDate: row.transDate, customerNo: row.customerNo,
            customerName: row.customerName, positions: row.positions, percent: row.percent, bucket: row.bucket, rows: [], amount: 0, reason: row.reason };
        grup.rows.push(row);
        grup.amount = Math.round((grup.amount + row.amount) * 100) / 100;
        map.set(key, grup);
    }
    return [...map.values()].sort((a, b) => a.customerName.localeCompare(b.customerName) || a.transDate.localeCompare(b.transDate) || a.invoiceNo.localeCompare(b.invoiceNo));
}

const posisiLabel = (p: string) => (p === "faktur" ? "tingkat faktur" : `D${p.replace(/\+/g, "+D")}`);

export default function Normalisasi({ permKeys, awal }: { permKeys: string[]; awal: { from?: string; to?: string; principal?: string } }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehUbah = keys.has("summary.edit");
    const now = new Date();
    const [from, setFrom] = useState(awal.from ?? ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
    const [to, setTo] = useState(awal.to ?? ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    const [principal, setPrincipal] = useState(awal.principal ?? "");
    const [tab, setTab] = useState<Tab>("takBertuan");
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<"golongkan" | "batalkan" | null>(null);
    const [golongan, setGolongan] = useState<Golongan | "">("");
    const [suratDipilih, setSuratDipilih] = useState("");
    const [cariAturan, setCariAturan] = useState("");
    const [note, setNote] = useState("");
    const [pesan, setPesan] = useState<string | null>(null);

    const query = `from=${from}&to=${to}${principal ? `&principal=${encodeURIComponent(principal)}` : ""}`;
    const [data, muat] = useLoad(useCallback(() => ambil<Data>(`/api/promo-recap?${query}`, (j) => {
        const d = j as Data & { ok?: boolean; error?: string };
        if (d.ok === false) throw new Error(d.error ?? "Data gagal dimuat");
        return d;
    }, 120_000), [query]), { pertahankan: true });

    const { takBertuan, ulang, sudah, aturanById } = useMemo(() => {
        const web = new Set(data.data?.webInvoiceIds ?? []);
        const rows = (data.data?.recap.rows ?? []).map((row) => ({ ...row, web: web.has(row.invoiceId) }));
        const calon = kelompokkan(rows.filter((row) => row.bucket === "unowned"));
        return {
            takBertuan: calon.filter((g) => !g.rows.some((r) => r.bekasNormalisasi)),
            ulang: calon.filter((g) => g.rows.some((r) => r.bekasNormalisasi)),
            sudah: kelompokkan(rows.filter((row) => row.aturanId !== undefined)),
            aturanById: new Map((data.data?.aturan ?? []).map((a) => [a.id, a])),
        };
    }, [data]);

    const daftar = tab === "takBertuan" ? takBertuan : tab === "ulang" ? ulang : sudah;
    const terpilihGrup = daftar.filter((g) => pilih.has(g.key));
    const barisTerpilih = terpilihGrup.flatMap((g) => g.rows);
    const totalTerpilih = barisTerpilih.reduce((s, r) => s + r.amount, 0);
    const suratBerbeda = new Set(barisTerpilih.map((r) => r.suratProgram).filter(Boolean)).size;

    const calonAturan = golongan ? calonSurat(barisTerpilih, golongan, aturanById) : [];
    const cari = cariAturan.trim().toUpperCase();
    const calonTampil = cari ? calonAturan.filter((c) => `${labelCalon(c)} ${[...c.pilihan.values()].map((a) => a.itemName).join(" ")}`.toUpperCase().includes(cari)) : calonAturan;
    const dipilih = calonAturan.find((c) => c.surat === suratDipilih) ?? null;
    const dipilihAturan = dipilih ? [...new Set(dipilih.pilihan.values())] : [];
    const otomatis = golongan ? otomatisPerBaris(barisTerpilih, golongan, aturanById) : null;
    const modeOtomatis = suratDipilih === OTOMATIS && Boolean(otomatis?.pilihan.size);
    const adaPilihan = calonAturan.length > 0 || Boolean(otomatis?.pilihan.size);
    const barisKirim = modeOtomatis ? barisTerpilih.filter((row) => otomatis!.pilihan.has(kunciBaris(row))) : barisTerpilih;
    const totalKirim = barisKirim.reduce((s, r) => s + r.amount, 0);

    const petunjuk = !golongan ? "Pilih beban dulu."
        : modeOtomatis ? `Otomatis per baris: ${otomatis!.pilihan.size} potongan memakai aturan yang nilainya sama persis (surat ${otomatis!.surat.join(", ")})`
            + (otomatis!.lewat ? `; ${otomatis!.lewat} dilewati karena tidak ada atau ada lebih dari satu aturan bernilai sama — tetap tak bertuan.` : ".")
        : !adaPilihan ? (terpilihGrup.length > 1
            ? `Tidak ada satu surat yang berlaku untuk semua ${terpilihGrup.length} potongan terpilih. Pilih lebih sedikit, atau tambahkan aturannya di Aturan Promo.`
            : "Tidak ada aturan promo yang berlaku untuk potongan ini. Tambahkan aturannya di Aturan Promo bila memang ada dasarnya.")
        : !calonAturan.length && !dipilih ? "Tidak ada satu surat untuk semua potongan terpilih — pilih “Otomatis per baris”."
        : !dipilih ? "Pilih surat yang menjadi dasar keputusan."
        : `Dasar: surat ${dipilih.surat}${dipilihAturan[0].promoLabel ? ` — ${dipilihAturan[0].promoLabel}` : ""}, ${dipilihAturan.length > 1 ? `${dipilihAturan.length} aturan, masing-masing untuk barangnya` : "1 aturan"}.`;
    const bisaSimpan = Boolean(barisKirim.length && golongan && (dipilih || modeOtomatis));

    function bukaGolongkan() { setGolongan(""); setSuratDipilih(""); setCariAturan(""); setNote(""); setDialog("golongkan"); }

    async function simpan() {
        if (!golongan || !bisaSimpan) return;
        const pilihan = modeOtomatis ? otomatis!.pilihan : dipilih!.pilihan;
        const dilewati = modeOtomatis ? otomatis!.lewat : 0;
        const res = await fetch("/api/promo-recap/normalisasi", {
            method: "POST", credentials: "include", headers: { "content-type": "application/json" },
            body: JSON.stringify({ bucket: golongan, note, rows: barisKirim.map((row) => ({
                promoRuleId: pilihan.get(kunciBaris(row))!.id,
                lineKey: row.lineKey, positions: row.positions, amount: row.amount, percent: row.percent,
                invoiceNo: row.invoiceNo, invoiceId: row.invoiceId, transDate: row.transDate, branchName: row.branchName,
                customerNo: row.customerNo, itemCode: row.itemCode })) }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; disimpan?: number; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Tidak tersimpan (HTTP ${res.status}).`);
        setDialog(null); setPilih(new Set());
        setPesan(`${body.disimpan ?? barisKirim.length} potongan digolongkan sebagai ${BEBAN[golongan].label}${dilewati ? `; ${dilewati} dilewati, tetap tak bertuan` : ""}.`);
        muat();
    }

    async function batalkan() {
        const res = await fetch("/api/promo-recap/normalisasi", {
            method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
            body: JSON.stringify({ keys: barisTerpilih.map((row) => ({ lineKey: row.lineKey, positions: row.positions })) }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; dicabut?: number; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Gagal membatalkan (HTTP ${res.status}).`);
        setDialog(null); setPilih(new Set());
        setPesan(`${body.dicabut ?? barisTerpilih.length} penggolongan dibatalkan; potongannya kembali tak bertuan.`);
        muat();
    }

    const kolom: Column<Grup>[] = [
        { key: "faktur", header: "Faktur", cell: (g) => <><span className="fi-mono">{g.invoiceNo}</span>{g.rows[0].web && <> <StatusBadge tone="info">web</StatusBadge></>}<span className="fi-sub">{tgl(g.transDate)}</span></> },
        { key: "outlet", header: "Outlet", cell: (g) => <>{g.customerName}<span className="fi-codes">{g.customerNo}</span></> },
        { key: "posisi", header: "Posisi", cell: (g) => <span className="fi-mono fi-small">{posisiLabel(g.positions)}</span> },
        { key: "persen", header: "Persen", align: "end", cell: (g) => <span className="fi-tnum">{g.percent ? persen(g.percent) : "—"}</span> },
        { key: "barang", header: "Barang", secondary: true, cell: (g) => (
            <details className="fi-small"><summary style={{ cursor: "pointer" }}>{g.rows.length} baris</summary>
                <ul style={{ margin: "4px 0 0", paddingLeft: 0, listStyle: "none" }}>{g.rows.map((r) => <li key={r.lineKey}><span className="fi-mono">{r.itemCode || "—"}</span> {r.itemName} · <span className="fi-tnum">{rupiah(r.amount)}</span></li>)}</ul>
            </details>) },
        { key: "nominal", header: "Nominal", align: "end", cell: (g) => <span className="fi-tnum">{rupiah(g.amount)}</span> },
        { key: "sebab", header: tab === "sudah" ? "Digolongkan" : "Sebab", cell: (g) => {
            if (tab === "sudah") {
                const dasar = g.rows[0].aturanId ? aturanById.get(g.rows[0].aturanId) : undefined;
                const b = BEBAN[g.bucket as Golongan];
                return <>{b ? <StatusBadge tone={b.tone}>{b.label}</StatusBadge> : g.bucket}{dasar && <span className="fi-sub">{dasar.suratProgram}{dasar.promoGroup ? ` ${dasar.promoGroup}` : ""}</span>}</>;
            }
            const klaim = calonSurat(g.rows, "principal", aturanById).length;
            const dist = calonSurat(g.rows, "distributor", aturanById).length;
            return <><span className="fi-small fi-why">{g.reason}</span><span className="fi-sub">{klaim || dist ? `Surat berlaku: ${klaim} klaim principal · ${dist} beban distributor` : "Belum ada aturan promo yang berlaku"}</span></>;
        } },
    ];

    const memuatAwal = data.status === "memuat" && !data.data;
    const totalTakBertuan = [...takBertuan, ...ulang].reduce((s, g) => s + g.amount, 0);

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><span aria-current="page">Normalisasi Diskon</span></li></ol></nav>
                <h1>Normalisasi diskon</h1>
                <p>Potongan tak bertuan pada faktur Accurate, termasuk yang terbit lewat web. Satu baris = satu faktur, satu posisi. Golongkan sebagai Klaim principal atau Beban distributor dengan menunjuk aturan promo dasarnya. Faktur di Accurate tidak diubah; bila faktur atau aturannya berubah sesudah diputuskan, keputusannya tidak dipakai lagi dan muncul di Perlu diputuskan ulang.</p>
            </header>

            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {data.status === "galat" && data.data && <MessageStrip tone="neg" title="Gagal memuat ulang.">{data.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Periode faktur" activeCount={principal ? 1 : 0} onReset={() => setPrincipal("")}
                    search={<FormField label="Dari">{(a11y) => <input {...a11y} className="fi-input" type="date" value={from} max={to} onChange={(e) => { if (e.target.value) { setFrom(e.target.value); setPilih(new Set()); } }} />}</FormField>}
                    fields={<>
                        <FormField label="Sampai">{(a11y) => <input {...a11y} className="fi-input" type="date" value={to} min={from} onChange={(e) => { if (e.target.value) { setTo(e.target.value); setPilih(new Set()); } }} />}</FormField>
                        <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => { setPrincipal(e.target.value); setPilih(new Set()); }}><option value="">Semua principal</option>{(data.data?.principals ?? []).map((p) => <option key={p}>{p}</option>)}</select>}</FormField>
                    </>}
                    chips={principal ? [{ label: `Principal: ${principal}`, onRemove: () => setPrincipal("") }] : undefined} />
            </div>

            <div className="fi-page-bar">
                <div className="fi-segs" role="group" aria-label="Kelompok potongan">
                    {([["takBertuan", `Tak bertuan ${takBertuan.length}`], ["ulang", `Perlu diputuskan ulang ${ulang.length}`], ["sudah", `Sudah digolongkan ${sudah.length}`]] as const)
                        .map(([k, label]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => { setTab(k); setPilih(new Set()); }}>{label}</button>)}
                </div>
                {data.data && <span className="fi-small fi-subtle">Tak bertuan {rupiah(totalTakBertuan)} · <Link href={`/rekap-promo`}>Lihat Rekap promo</Link></span>}
            </div>

            <ResponsiveTable<Grup> title={tab === "sudah" ? "Sudah digolongkan" : tab === "ulang" ? "Perlu diputuskan ulang" : "Tak bertuan"} count={daftar.length}
                columns={kolom} rows={daftar} rowKey={(g) => g.key} status={memuatAwal ? "memuat" : data.status} error={data.error} onRetry={muat}
                selected={bolehUbah ? pilih : undefined} onSelectedChange={bolehUbah ? setPilih : undefined} rowLabel={(g) => `Pilih ${g.invoiceNo} posisi ${g.positions}`}
                empty={tab === "sudah" ? { title: "Belum ada yang digolongkan pada periode ini" } : tab === "ulang" ? { title: "Tidak ada keputusan lama yang perlu diulang" } : { title: "Tidak ada potongan tak bertuan pada periode ini", message: "Semua potongan punya aturan promo yang berlaku." }}
                mobileItem={(g) => <ListItem doc={bolehUbah ? <label className="fi-check"><input type="checkbox" aria-label={`Pilih ${g.invoiceNo} posisi ${g.positions}`} checked={pilih.has(g.key)} onChange={() => setPilih((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })} />{g.invoiceNo}</label> : g.invoiceNo}
                    amount={rupiah(g.amount)} title={`${g.customerName} · ${posisiLabel(g.positions)}${g.percent ? ` · ${persen(g.percent)}` : ""}`} meta={tab === "sudah" ? undefined : g.reason}
                    badge={tab === "sudah" && BEBAN[g.bucket as Golongan] ? <StatusBadge tone={BEBAN[g.bucket as Golongan].tone}>{BEBAN[g.bucket as Golongan].label}</StatusBadge> : undefined} />} />

            {bolehUbah && terpilihGrup.length > 0 && (
                <FooterToolbar message={<span className="fi-sum"><b>{terpilihGrup.length} potongan</b> · {rupiah(totalTerpilih)}{tab !== "sudah" && suratBerbeda > 1 ? ` · dari ${suratBerbeda} surat berbeda: pilih Otomatis per baris di dialog` : ""}</span>}>
                    {tab === "sudah"
                        ? <Button variant="primary" icon={<Undo2 className="fi-icon" aria-hidden />} onClick={() => setDialog("batalkan")}>Batalkan {terpilihGrup.length} penggolongan…</Button>
                        : <Button variant="primary" icon={<Tags className="fi-icon" aria-hidden />} onClick={bukaGolongkan}>Golongkan…</Button>}
                </FooterToolbar>
            )}

            <ConfirmDialog open={dialog === "golongkan"} onClose={() => setDialog(null)} tag="Normalisasi"
                title={golongan ? `Golongkan ${modeOtomatis ? barisKirim.length : terpilihGrup.length} potongan sebagai ${BEBAN[golongan].label}?` : `Golongkan ${terpilihGrup.length} potongan?`}
                confirmLabel={golongan ? `Golongkan sebagai ${BEBAN[golongan].label}` : "Golongkan"} confirmDisabled={bisaSimpan ? undefined : petunjuk} onConfirm={simpan}
                facts={[["Potongan", `${modeOtomatis ? barisKirim.length : barisTerpilih.length} baris · ${rupiah(modeOtomatis ? totalKirim : totalTerpilih)}`], ["Faktur Accurate", "Tidak diubah"]]}>
                <FormField label="Beban" required>{(a11y) => <select {...a11y} className="fi-input" value={golongan} onChange={(e) => { setGolongan(e.target.value as Golongan | ""); setSuratDipilih(""); }}>
                    <option value="">— pilih beban —</option><option value="principal">Klaim principal (ditagihkan ke principal)</option><option value="distributor">Beban distributor (biaya sendiri)</option>
                </select>}</FormField>
                {calonAturan.length > 8 && <FormField label="Cari aturan">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Surat, kelompok, barang" value={cariAturan} onChange={(e) => setCariAturan(e.target.value)} />}</FormField>}
                <FormField label="Aturan promo dasar (surat)" required help={petunjuk}>{(a11y) => <select {...a11y} className="fi-input" value={dipilih || modeOtomatis ? suratDipilih : ""} disabled={!golongan || !adaPilihan} onChange={(e) => setSuratDipilih(e.target.value)}>
                    <option value="">{!golongan ? "Pilih beban dulu" : calonAturan.length ? `— pilih dari ${calonAturan.length} surat yang berlaku —` : adaPilihan ? "— pilih “Otomatis per baris” —" : "Tidak ada aturan yang berlaku"}</option>
                    {!!otomatis?.pilihan.size && <option value={OTOMATIS}>Otomatis per baris — {otomatis.pilihan.size} dari {barisTerpilih.length} potongan punya tepat satu aturan bernilai sama</option>}
                    {calonTampil.map((c) => <option key={c.surat} value={c.surat}>{labelCalon(c)}{c.sama ? " — nilai sama" : ""}</option>)}
                </select>}</FormField>
                <FormField label="Catatan" help="Opsional, mis. dasar keputusannya.">{(a11y) => <input {...a11y} className="fi-input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "batalkan"} onClose={() => setDialog(null)} tag="Normalisasi" tone="negative"
                title={`Batalkan ${terpilihGrup.length} penggolongan?`} confirmLabel="Batalkan penggolongan" onConfirm={batalkan}
                facts={[["Potongan", `${barisTerpilih.length} baris · ${rupiah(totalTerpilih)}`], ["Akibat", "Kembali tak bertuan di Rekap promo sampai digolongkan lagi"]]} />
        </div>
    );
}
