/*
 * Tujuan: Overview Rekap promo (Fiori S4a): diskon yang BENAR-BENAR keluar dari Accurate pada periode ini, dipilah Klaim principal /
 *   Beban distributor / Tak bertuan; per program; tarif tidak terpakai; outlet tanpa aturan; rincian + unduh CSV.
 *   Impor aturan Excel dipindah ke Aturan Promo (principal wajib dipilih di sana).
 * Caller: app/(dashboard)/rekap-promo/page.tsx.
 * Dependensi: GET /api/promo-recap (satu pindaian per permintaan); components/fiori/*; lib/promo-ui.
 * Main Functions: RekapPromo, unduh.
 * Side Effects: GET saja; unduhan CSV dibuat di peramban.
 *
 * Angka di layar ini milik Accurate, bukan hitungan kita. Aturan promo hanya dipakai untuk menjelaskan angka itu.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, type Column } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { BEBAN, persen, rupiah, tgl } from "@/lib/promo-ui";

type Program = { key: string; suratProgram: string; promoLabel: string; promoGroup: string; amount: number; lines: number; invoices: number; normalisasi?: number; normalisasiBaris?: number };
type DetailRow = { bucket: "principal" | "distributor" | "unowned"; invoiceNo: string; transDate: string; branchName: string; customerNo: string; customerName: string;
    itemCode: string; itemName: string; positions: string; percent: number; amount: number; suratProgram: string; promoGroup: string; reason: string };
type TarifMenganggur = { customerCode: string; tierNo: number; benefitValue: string; benefitBeban: string; suratProgram: string; promoLabel: string; outletBertransaksi: boolean };
type OutletTanpaAturan = { customerNo: string; customerName: string; amount: number; lines: number; positions: string[]; percents: number[] };
type Data = {
    from: string; to: string; principal: string; principals: string[]; invoicesInRange: number; invoicesWithoutDetail: number; rules: number;
    recap: { invoices: number; lines: number; gross: number; distributor: number; principal: number; unowned: number; programs: Program[]; rows: DetailRow[];
        tarifMenganggur: TarifMenganggur[]; outletTanpaAturan: OutletTanpaAturan[] };
};
type Buka = { jenis: "bucket" | "program"; nilai: string } | null;

const BOM = String.fromCharCode(0xFEFF);
const CRLF = String.fromCharCode(13, 10);
// Tanggal SETEMPAT, bukan UTC: tanggal 1 di WITA tidak boleh berubah jadi tanggal 31 bulan sebelumnya.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const BUCKET_LABEL = { principal: BEBAN.principal.label, distributor: BEBAN.distributor.label, unowned: "Tak bertuan" } as const;

export default function RekapPromo() {
    const now = new Date();
    const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
    const [to, setTo] = useState(ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    const [principal, setPrincipal] = useState("");
    const [buka, setBuka] = useState<Buka>(null);
    const query = `from=${from}&to=${to}${principal ? `&principal=${encodeURIComponent(principal)}` : ""}`;
    // Rekap sebulan bisa puluhan detik (satu pindaian, PR f263fad2).
    const [data, muat] = useLoad(useCallback(() => ambil<Data>(`/api/promo-recap?${query}`, (j) => {
        const d = j as Data & { ok?: boolean; error?: string };
        if (d.ok === false) throw new Error(d.error ?? "Rekap gagal dimuat");
        return d;
    }, 120_000), [query]), { pertahankan: true });
    const r = data.data?.recap;

    // Satu daftar rincian melayani tabel layar DAN unduhan CSV, supaya angkanya tidak pernah berbeda.
    const rincian = useMemo(() => !r || !buka ? [] : buka.jenis === "bucket"
        ? r.rows.filter((row) => row.bucket === buka.nilai)
        : r.rows.filter((row) => `${row.suratProgram}|${row.promoGroup}` === buka.nilai), [r, buka]);
    const totalRincian = rincian.reduce((s, row) => s + row.amount, 0);
    const judulRincian = !buka ? "" : buka.jenis === "program" ? `Rincian program ${buka.nilai.split("|")[0]} · ${buka.nilai.split("|")[1]}` : `Rincian ${BUCKET_LABEL[buka.nilai as keyof typeof BUCKET_LABEL]}`;
    const normQuery = `?from=${from}&to=${to}${principal ? `&principal=${encodeURIComponent(principal)}` : ""}`;

    /** CSV titik koma (Excel Indonesia memakai koma desimal), BOM untuk nama ber-aksen. */
    function unduh() {
        const judul = ["Faktur", "Tanggal", "Principal", "Kode Outlet", "Outlet", "Kode Barang", "Nama Barang", "Posisi", "Persen", "Rupiah", "Surat", "Kelompok", "Keterangan"];
        const escape = (value: string | number) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const isi = rincian.map((row) => [row.invoiceNo, row.transDate, row.branchName, row.customerNo, row.customerName, row.itemCode, row.itemName,
            row.positions, row.percent, row.amount, row.suratProgram, row.promoGroup, row.reason].map(escape).join(";"));
        const teks = BOM + [judul.map(escape).join(";"), ...isi].join(CRLF);
        const url = URL.createObjectURL(new Blob([teks], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `rekap-promo-${(buka?.nilai ?? "").replace(/[^A-Za-z0-9]+/g, "-")}-${from}-sd-${to}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    const kolomProgram: Column<Program>[] = [
        { key: "surat", header: "Surat", cell: (p) => <span className="fi-mono fi-small">{p.suratProgram}</span> },
        { key: "program", header: "Program", cell: (p) => <>{p.promoGroup}<span className="fi-sub">{p.promoLabel}</span></> },
        { key: "faktur", header: "Faktur", align: "end", secondary: true, cell: (p) => <span className="fi-tnum">{p.invoices}</span> },
        { key: "baris", header: "Baris", align: "end", secondary: true, cell: (p) => <span className="fi-tnum">{p.lines}</span> },
        { key: "klaim", header: "Klaim principal", align: "end", cell: (p) => <span className="fi-tnum">{rupiah(p.amount)}{!!p.normalisasi && <span className="fi-sub">termasuk {rupiah(p.normalisasi)} dari normalisasi ({p.normalisasiBaris} baris)</span>}</span> },
        { key: "aksi", header: "", cell: (p) => <Button variant="tertiary" aria-pressed={buka?.jenis === "program" && buka.nilai === p.key} onClick={() => setBuka(buka?.jenis === "program" && buka.nilai === p.key ? null : { jenis: "program", nilai: p.key })}>{buka?.jenis === "program" && buka.nilai === p.key ? "Tutup" : "Rincian"}</Button> },
    ];
    const kolomTarif: Column<TarifMenganggur>[] = [
        { key: "outlet", header: "Outlet", cell: (t) => <><span className="fi-mono">{t.customerCode}</span><span className="fi-sub">{t.promoLabel}</span></> },
        { key: "tarif", header: "Tarif", cell: (t) => <>{persen(t.benefitValue)} di kolom {t.tierNo}<span className="fi-sub">{BEBAN[t.benefitBeban === "PRINCIPAL" ? "principal" : "distributor"].label}</span></> },
        { key: "belanja", header: "Outlet belanja?", cell: (t) => t.outletBertransaksi ? <StatusBadge tone="warn">Ya — periksa</StatusBadge> : <span className="fi-small fi-subtle">Tidak belanja</span> },
    ];
    const kolomTanpa: Column<OutletTanpaAturan>[] = [
        { key: "outlet", header: "Outlet", cell: (o) => <><span className="fi-mono">{o.customerNo}</span><span className="fi-sub">{o.customerName}</span></> },
        { key: "potongan", header: "Potongan", cell: (o) => <span className="fi-small">kolom {o.positions.join(", ")}<span className="fi-sub">{o.percents.map(persen).join(", ") || "—"} · {o.lines} baris</span></span> },
        { key: "nilai", header: "Nilai", align: "end", cell: (o) => <span className="fi-tnum fi-why">{rupiah(o.amount)}</span> },
    ];
    const kolomRincian: Column<DetailRow & { _k: string }>[] = [
        { key: "faktur", header: "Faktur", cell: (row) => <><span className="fi-mono">{row.invoiceNo}</span><span className="fi-sub">{tgl(row.transDate)}</span></> },
        { key: "outlet", header: "Outlet", cell: (row) => <>{row.customerName}<span className="fi-codes">{row.customerNo}</span></> },
        { key: "barang", header: "Barang", secondary: true, cell: (row) => <>{row.itemName}<span className="fi-codes">{row.itemCode || "—"}</span></> },
        { key: "posisi", header: "Posisi", secondary: true, cell: (row) => <span className="fi-mono fi-small">{row.positions}</span> },
        { key: "persen", header: "Persen", align: "end", cell: (row) => <span className="fi-tnum">{row.percent ? persen(row.percent) : "—"}</span> },
        { key: "rupiah", header: "Rupiah", align: "end", cell: (row) => <span className="fi-tnum">{rupiah(row.amount)}</span> },
        { key: "ket", header: "Keterangan", cell: (row) => row.reason ? <span className="fi-small fi-why">{row.reason}</span> : <span className="fi-small fi-subtle">{row.suratProgram} · {row.promoGroup}</span> },
    ];

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><span aria-current="page">Rekap Promo</span></li></ol></nav>
                <h1>Rekap promo {tgl(from)} – {tgl(to)}</h1>
                <p>Diskon yang benar-benar keluar dari Accurate pada periode ini — dibaca dari faktur yang dikirim webhook, bukan dari hitungan kita — lalu dipilah siapa menanggungnya. Aturan promo diimpor dan diubah di Aturan Promo.</p>
            </header>

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Periode faktur" activeCount={principal ? 1 : 0} onReset={() => setPrincipal("")}
                    search={<FormField label="Dari">{(a11y) => <input {...a11y} className="fi-input" type="date" value={from} max={to} onChange={(e) => { if (e.target.value) { setFrom(e.target.value); setBuka(null); } }} />}</FormField>}
                    fields={<>
                        <FormField label="Sampai">{(a11y) => <input {...a11y} className="fi-input" type="date" value={to} min={from} onChange={(e) => { if (e.target.value) { setTo(e.target.value); setBuka(null); } }} />}</FormField>
                        <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => { setPrincipal(e.target.value); setBuka(null); }}><option value="">Semua principal</option>{(data.data?.principals ?? []).map((p) => <option key={p}>{p}</option>)}</select>}</FormField>
                    </>}
                    chips={principal ? [{ label: `Principal: ${principal}`, onRemove: () => setPrincipal("") }] : undefined} />
            </div>

            {data.status === "memuat" && !r ? (
                <>
                    <MessageStrip tone="info" title="Memindai faktur periode ini…">Rekap sebulan bisa puluhan detik.</MessageStrip>
                    <div className="fi-kcards">{[0, 1, 2, 3].map((i) => <div key={i} className="fi-kc"><Skeleton rows={2} label="Menghitung rekap" /></div>)}</div>
                </>
            ) : data.status === "galat" && !r ? (
                <div className="fi-panel"><ErrorState title="Rekap gagal dimuat" message={`${data.error}. Angka tidak ditampilkan sebagai nol.`} onRetry={muat} /></div>
            ) : r && data.data ? (
                <>
                    {data.status === "galat" && <MessageStrip tone="neg" title="Gagal menghitung ulang.">{data.error} Angka di bawah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}
                    {data.status === "memuat" && <MessageStrip tone="info" title="Menghitung ulang rekap…" />}
                    {r.invoices === 0 ? (
                        <div className="fi-panel"><EmptyState title="Belum ada faktur berincian pada periode ini" message={data.data.invoicesInRange ? `${data.data.invoicesInRange} faktur ada di periode ini, tetapi belum satu pun membawa rincian baris (hanya jalur webhook yang membawanya).` : "Ubah periode atau principal."} /></div>
                    ) : (
                        <>
                            <div className="fi-kcards" aria-busy={data.status === "memuat" || undefined}>
                                <div className="fi-kc"><span>Bruto faktur</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(r.gross)}</b><small>{r.invoices} faktur · {r.lines} baris</small></div>
                                <button type="button" className="fi-kc" data-tone="pos" aria-pressed={buka?.nilai === "principal"} onClick={() => setBuka(buka?.nilai === "principal" ? null : { jenis: "bucket", nilai: "principal" })}><span>{BEBAN.principal.label}</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(r.principal)}</b><small>cocok aturan principal, bisa ditagihkan · lihat rincian</small></button>
                                <button type="button" className="fi-kc" aria-pressed={buka?.nilai === "distributor"} onClick={() => setBuka(buka?.nilai === "distributor" ? null : { jenis: "bucket", nilai: "distributor" })}><span>{BEBAN.distributor.label}</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(r.distributor)}</b><small>cocok aturan distributor, biaya sendiri · lihat rincian</small></button>
                                <Link href={`/normalisasi-diskon${normQuery}`} className="fi-kc" data-tone={r.unowned ? "neg" : "pos"}><span>Tak bertuan</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(r.unowned)}</b><small>{r.unowned ? "tidak sesuai promo yang berlaku · golongkan di Normalisasi diskon" : "semua potongan punya aturan"}</small></Link>
                            </div>
                            {r.unowned === 0
                                ? <MessageStrip tone="pos" title="Periode ini bersih:">setiap potongan cocok dengan aturan promo yang berlaku.</MessageStrip>
                                : <MessageStrip tone="neg" title={`${rupiah(r.unowned)} potongan belum bisa dipertanggungjawabkan.`}>
                                    Tak bertuan berarti potongannya tidak sesuai promo yang berlaku — di posisi mana pun, termasuk posisi 1–3 yang belum punya aturan beban distributor.{" "}
                                    <Button variant="tertiary" onClick={() => setBuka({ jenis: "bucket", nilai: "unowned" })}>Lihat rincian</Button>{" "}
                                    <Link className="fi-btn fi-btn--tertiary" href={`/normalisasi-diskon${normQuery}`}>Golongkan<ArrowRight className="fi-icon" aria-hidden /></Link>
                                </MessageStrip>}
                            {data.data.invoicesWithoutDetail > 0 && <MessageStrip tone="warn" title={`${data.data.invoicesWithoutDetail} dari ${data.data.invoicesInRange} faktur belum punya rincian baris`}>(hanya jalur webhook yang membawanya). Angka di atas belum memuat faktur itu.</MessageStrip>}

                            {buka && (
                                <Section id="rincian" title={judulRincian} subtitle={`${rincian.length} baris · ${rupiah(totalRincian)}`}
                                    actions={<><Button icon={<Download className="fi-icon" aria-hidden />} disabled={!rincian.length} onClick={unduh}>Unduh CSV</Button><Button variant="tertiary" onClick={() => setBuka(null)}>Tutup</Button></>}>
                                    <ResponsiveTable<DetailRow & { _k: string }> title={judulRincian} columns={kolomRincian} rows={rincian.slice(0, 500).map((row, i) => ({ ...row, _k: `${row.invoiceNo}|${row.itemCode}|${row.positions}|${i}` }))} rowKey={(row) => row._k}
                                        empty={{ title: "Tidak ada baris" }}
                                        mobileItem={(row) => <ListItem doc={row.invoiceNo} amount={rupiah(row.amount)} title={`${row.customerName} · ${row.itemName || "seluruh nota"}`} meta={row.reason || `${row.suratProgram} · ${row.promoGroup}`} />} />
                                    {rincian.length > 500 && <div className="fi-sect-in"><p className="fi-small fi-subtle">Ditampilkan 500 baris teratas. Unduhan CSV memuat seluruh {rincian.length} baris.</p></div>}
                                </Section>
                            )}

                            <Section title={`Per program (${data.data.rules} aturan terbit)`}>
                                <ResponsiveTable<Program> title="Per program" columns={kolomProgram} rows={r.programs} rowKey={(p) => p.key}
                                    empty={{ title: "Belum ada potongan yang cocok dengan aturan terbit", message: data.data.principal ? undefined : "Coba saring per principal — aturan hanya termuat untuk sebagian principal." }}
                                    mobileItem={(p) => <ListItem doc={p.suratProgram} amount={rupiah(p.amount)} title={p.promoGroup} meta={`${p.invoices} faktur · ${p.lines} baris`} onClick={() => setBuka({ jenis: "program", nilai: p.key })} />} />
                            </Section>

                            <div className="grid gap-4 lg:grid-cols-2">
                                <Section title="Tarif yang tidak terpakai" subtitle="terdaftar tapi tidak menjelaskan satu potongan pun; yang outletnya tetap belanja patut dicurigai">
                                    <ResponsiveTable<TarifMenganggur> title="Tarif yang tidak terpakai" columns={kolomTarif} rows={r.tarifMenganggur} rowKey={(t) => `${t.customerCode}-${t.tierNo}-${t.suratProgram}`}
                                        empty={{ title: "Semua tarif terpakai pada periode ini" }}
                                        mobileItem={(t) => <ListItem doc={t.customerCode} title={`${persen(t.benefitValue)} di kolom ${t.tierNo}`} badge={t.outletBertransaksi ? <StatusBadge tone="warn">Periksa</StatusBadge> : undefined} />} />
                                </Section>
                                <Section title="Outlet yang potongannya belum punya aturan" subtitle="potongan nyata tanpa tarif; di sinilah kode outlet yang terlewat muncul">
                                    <ResponsiveTable<OutletTanpaAturan> title="Outlet tanpa aturan" columns={kolomTanpa} rows={r.outletTanpaAturan} rowKey={(o) => o.customerNo}
                                        empty={{ title: "Tidak ada potongan tanpa aturan pada periode ini" }}
                                        mobileItem={(o) => <ListItem doc={o.customerNo} amount={rupiah(o.amount)} title={o.customerName} meta={`kolom ${o.positions.join(", ")} · ${o.lines} baris`} />} />
                                </Section>
                            </div>
                        </>
                    )}
                </>
            ) : null}
        </div>
    );
}
