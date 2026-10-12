/*
 * Tujuan: List Report History penjualan (Fiori S3): saringan Tahun → Principal → Customer + cari produk (wajib), tabel item per halaman,
 *   galat pencarian di halaman (bukan toast), impor CSV e-Faktur lewat dialog (pengganti pilih berkas langsung mengimpor).
 * Caller: app/(dashboard)/sales-history/page.tsx.
 * Dependensi: /api/sales-history/{years,principals,customers,item-search,import}; components/fiori/{core,interactive}.
 * Main Functions: HistoryPenjualan.
 * Side Effects: GET pencarian; POST impor (sales_history.manage). Logic BL-60 tidak ditulis (varian berlabel).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Skeleton, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";

type Opt = { value: string; label: string };
type Customer = { kode: string; nama: string; invoices: number };
type Item = { id: number; referensi: string; tanggal: string; principal: string; kodeCust: string; customerNama: string; kodeObjek: string; namaProduk: string; qty: number; satuan: string; hargaSatuan: number; hargaTotal: number; diskonRp: number; keterangan: string };
type Hasil = { items: Item[]; total: number; totalApproximate: boolean; searchBackend: string };

const PAGE = 50;
const rp = (v: number) => `Rp ${Number(v || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const pct = (d: number, b: number) => (b > 0 ? ((d / b) * 100).toFixed(1) : "0,0").replace(".", ",");
const fmtMB = (b: number) => `${(b / 1_048_576).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`;

function useDebounced(value: string, ms: number) {
    const [v, setV] = useState(value);
    useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
    return v;
}

export default function HistoryPenjualan({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehImpor = keys.has("sales_history.manage");
    const [tahun, setTahun] = useState("");
    const [principal, setPrincipal] = useState("");
    const [customer, setCustomer] = useState<Customer | null>(null);
    const [cariCustomer, setCariCustomer] = useState("");
    const [produk, setProduk] = useState("");
    // Halaman terikat ke kata kunci saat diubah; kata kunci baru (setelah debounce) kembali ke halaman 1.
    const [hal, setHal] = useState<{ q: string; n: number }>({ q: "", n: 1 });
    const [berkas, setBerkas] = useState<File | null>(null);
    const [dialog, setDialog] = useState(false);
    const [pesanImpor, setPesanImpor] = useState<string | null>(null);
    const produkQ = useDebounced(produk.trim(), 450);
    const customerQ = useDebounced(cariCustomer.trim(), 350);

    const [tahunOpts] = useLoad(useCallback(() => ambil<Opt[]>("/api/sales-history/years", (j) => ((j as { years: Array<{ year: number; invoices: number }> }).years ?? []).map((y) => ({ value: String(y.year), label: `${y.year} (${y.invoices.toLocaleString("id-ID")} faktur)` }))), []));
    const [principalOpts] = useLoad(useCallback(() => ambil<Opt[]>(`/api/sales-history/principals${tahun ? `?year=${tahun}` : ""}`, (j) => ((j as { principals: Array<{ principal: string; invoices: number }> }).principals ?? []).map((p) => ({ value: p.principal, label: `${p.principal} (${p.invoices.toLocaleString("id-ID")})` }))), [tahun]));
    // Principal yang tidak ada di tahun baru diabaikan di semua kueri (perilaku lama melepasnya).
    const principalValid = !principal || !principalOpts.data || principalOpts.data.some((p) => p.value === principal);
    const principalAktif = principalValid ? principal : "";
    const halaman = hal.q === produkQ ? hal.n : 1;
    const setHalaman = (f: (n: number) => number) => setHal((h) => ({ q: produkQ, n: f(h.q === produkQ ? h.n : 1) }));
    const [customerOpts] = useLoad(useCallback(() => {
        const params = new URLSearchParams({ q: customerQ, limit: "30" });
        if (tahun) params.set("year", tahun);
        if (principalAktif) params.set("principal", principalAktif);
        return ambil<Customer[]>(`/api/sales-history/customers?${params}`, (j) => (j as { customers: Customer[] }).customers ?? []);
    }, [customerQ, tahun, principalAktif]));
    const kunciCari = produkQ.length >= 2 ? JSON.stringify({ produkQ, tahun, principal: principalAktif, kode: customer?.kode ?? "", halaman }) : "";
    const [hasil, muatHasil] = useLoad(useCallback((): Promise<{ status: "siap" | "galat" | "memuat"; data?: Hasil; error?: string }> => {
        if (!kunciCari) return Promise.resolve({ status: "siap", data: { items: [], total: 0, totalApproximate: false, searchBackend: "none" } });
        const k = JSON.parse(kunciCari) as { produkQ: string; tahun: string; principal: string; kode: string; halaman: number };
        const params = new URLSearchParams({ page: String(k.halaman), limit: String(PAGE), product: k.produkQ });
        if (k.tahun) params.set("year", k.tahun);
        if (k.principal) params.set("principal", k.principal);
        if (k.kode) params.set("kodeCust", k.kode);
        return ambil<Hasil>(`/api/sales-history/item-search?${params}`, (j) => { const d = j as Hasil & { ok?: boolean; error?: string }; if (d.ok === false) throw new Error(d.error ?? "Pencarian gagal."); return d; });
    }, [kunciCari]));

    const items = kunciCari ? hasil.data?.items ?? [] : [];
    const total = hasil.data?.total ?? 0;
    const nHalaman = Math.max(1, Math.ceil(total / PAGE));
    const saringAktif = Number(Boolean(tahun)) + Number(Boolean(principalAktif)) + Number(Boolean(customer));
    const reset = () => { setTahun(""); setPrincipal(""); setCustomer(null); setCariCustomer(""); setHal({ q: produkQ, n: 1 }); };

    async function impor() {
        if (!berkas) return;
        const res = await fetch("/api/sales-history/import", { method: "POST", headers: { "x-filename": berkas.name, "content-type": "text/csv" }, body: berkas });
        const d = (await res.json().catch(() => ({}))) as { ok?: boolean; imported?: number; sourceFile?: string; error?: string };
        if (!res.ok || !d.ok) throw new Error(d.error ?? `Impor gagal (HTTP ${res.status}).`);
        setDialog(false); setBerkas(null);
        setPesanImpor(`${(d.imported ?? 0).toLocaleString("id-ID")} item diimpor dari ${d.sourceFile ?? berkas.name} ${jamWita(new Date())}. Data dari berkas bernama sama sebelumnya diganti.`);
        if (kunciCari) muatHasil();
    }

    const kolom: Column<Item>[] = [
        { key: "no", header: "No faktur", cell: (r) => <span className="fi-mono">{r.referensi}</span> },
        { key: "tgl", header: "Tanggal", secondary: true, cell: (r) => <span className="fi-tnum">{r.tanggal}</span> },
        { key: "cust", header: "Customer", cell: (r) => <>{r.customerNama}<span className="fi-codes">{r.kodeCust}</span></> },
        { key: "produk", header: "Produk", cell: (r) => <>{r.namaProduk}<span className="fi-codes">{r.kodeObjek}</span></> },
        { key: "qty", header: "Qty", align: "end", cell: (r) => <span className="fi-tnum">{Number(r.qty || 0).toLocaleString("id-ID")} {r.satuan || ""}</span> },
        { key: "harga", header: "Harga satuan", align: "end", cell: (r) => <span className="fi-tnum">{rp(r.hargaSatuan)}</span> },
        { key: "total", header: "Total bruto", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{rp(r.hargaTotal)}</span> },
        { key: "diskon", header: "Diskon", align: "end", cell: (r) => <span className="fi-tnum"><b className="fi-why">{pct(r.diskonRp, r.hargaTotal)}%</b><span className="fi-sub">{rp(r.diskonRp)}</span></span> },
    ];

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Penjualan</span></li><li><span aria-current="page">History Penjualan</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>History penjualan</h1>
                    <span className="fi-spacer" />
                    {bolehImpor && <Button icon={<Upload className="fi-icon" aria-hidden />} onClick={() => setDialog(true)}>Impor CSV e-Faktur…</Button>}
                </div>
                <p>Riwayat item faktur dari data e-Faktur, untuk melihat harga dan diskon yang pernah diberikan ke toko. Pencarian dimulai dari nama produk.</p>
            </header>

            {pesanImpor && <MessageStrip tone="pos" title={pesanImpor} onClose={() => setPesanImpor(null)} />}
            {berkas && !dialog && <MessageStrip tone="info" title={`${berkas.name} dipilih, belum diimpor.`}><Button variant="tertiary" onClick={() => setDialog(true)}>Lanjutkan impor…</Button></MessageStrip>}
            {!principalValid && <MessageStrip tone="info" title={`Principal ${principal} tidak ada di tahun ${tahun}.`}>Saringan principal diabaikan. <Button variant="tertiary" onClick={() => setPrincipal("")}>Hapus</Button></MessageStrip>}

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={saringAktif} onReset={reset}
                    search={<FormField label="Produk" required help="Minimal 2 huruf; nama atau kode produk.">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Ketik nama produk" value={produk} onChange={(e) => { setProduk(e.target.value); setHal({ q: produkQ, n: 1 }); }} />}</FormField>}
                    fields={<>
                        <FormField label="Tahun">{(a11y) => <select {...a11y} className="fi-input" value={tahun} onChange={(e) => { setTahun(e.target.value); setHal({ q: produkQ, n: 1 }); }}><option value="">Semua tahun</option>{(tahunOpts.data ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</FormField>
                        <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principalAktif} onChange={(e) => { setPrincipal(e.target.value); setHal({ q: produkQ, n: 1 }); }}><option value="">Semua principal</option>{(principalOpts.data ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</FormField>
                        <FormField label="Customer" help={customer ? `${customer.nama} · ${customer.kode}` : "Ketik nama atau kode, lalu pilih."}>
                            {(a11y) => <>
                                <input {...a11y} className="fi-input" list="fi-hist-customer" placeholder="Nama atau kode toko" value={cariCustomer}
                                    onChange={(e) => { const v = e.target.value; setCariCustomer(v); const hit = (customerOpts.data ?? []).find((c) => `${c.nama} · ${c.kode}` === v || c.kode === v); setCustomer(hit ?? null); setHal({ q: produkQ, n: 1 }); }} />
                                <datalist id="fi-hist-customer">{(customerOpts.data ?? []).map((c) => <option key={c.kode} value={`${c.nama} · ${c.kode}`}>{c.invoices} faktur</option>)}</datalist>
                            </>}
                        </FormField>
                    </>}
                    chips={[
                        ...(tahun ? [{ label: `Tahun: ${tahun}`, onRemove: () => setTahun("") }] : []),
                        ...(principalAktif ? [{ label: `Principal: ${principalAktif}`, onRemove: () => setPrincipal("") }] : []),
                        ...(customer ? [{ label: `Customer: ${customer.nama}`, onRemove: () => { setCustomer(null); setCariCustomer(""); } }] : []),
                    ]} />
            </div>

            {!kunciCari ? (
                <div className="fi-panel"><EmptyState title="Ketik nama produk untuk menampilkan item" message="Saringan Tahun, Principal, dan Customer boleh diisi lebih dulu. Pencarian dimulai dari nama produk, minimal 2 huruf." /></div>
            ) : hasil.status === "galat" && !hasil.data ? (
                <div className="fi-panel"><ErrorState title="Pencarian gagal" message={`${hasil.error}. Saringan tidak berubah; coba lagi.`} onRetry={muatHasil} /></div>
            ) : hasil.status === "memuat" && !hasil.data ? (
                <div className="fi-panel"><Skeleton rows={6} label="Mencari item" /></div>
            ) : (
                <>
                    <ResponsiveTable<Item> title="History item" count={total} columns={kolom} rows={items} rowKey={(r) => String(r.id)}
                        status={hasil.status} error={hasil.error} onRetry={muatHasil}
                        actions={<span className="fi-small fi-subtle">Halaman {halaman} dari {nHalaman}{hasil.data?.totalApproximate ? " (perkiraan)" : ""}</span>}
                        empty={{ title: "Tidak ada item yang cocok", message: "Ubah kata kunci produk atau saringan." }}
                        mobileItem={(r) => <ListItem doc={r.referensi} amount={rp(r.hargaTotal)} title={r.namaProduk} meta={`${r.tanggal} · ${r.customerNama} · ${Number(r.qty || 0).toLocaleString("id-ID")} ${r.satuan || ""} × ${rp(r.hargaSatuan)} · diskon ${pct(r.diskonRp, r.hargaTotal)}%`} />} />
                    {nHalaman > 1 && (
                        <div className="fi-page-bar">
                            <Button disabled={halaman <= 1} onClick={() => setHalaman((h) => Math.max(1, h - 1))}>Sebelumnya</Button>
                            <span className="fi-small fi-subtle">Halaman {halaman} · {PAGE} per halaman{halaman < nHalaman ? " · ada halaman berikutnya" : ""}</span>
                            <Button disabled={halaman >= nHalaman} onClick={() => setHalaman((h) => h + 1)}>Berikutnya</Button>
                        </div>
                    )}
                </>
            )}

            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={berkas ? `Impor ${berkas.name}?` : "Impor CSV e-Faktur"} tag="Impor" confirmLabel="Impor"
                confirmDisabled={berkas ? undefined : "Pilih berkas dulu"} onConfirm={impor}
                description={<MessageStrip tone="warn" title="Data dari berkas bernama sama yang pernah diimpor dihapus lebih dulu,">lalu diganti isi berkas ini.</MessageStrip>}
                facts={[["Berkas", berkas ? `${berkas.name} · ${fmtMB(berkas.size)}` : "belum dipilih"], ["Format", "CSV e-Faktur (baris FK dan OF)"]]}>
                <FormField label="Berkas CSV" required>{(a11y) => <input {...a11y} className="fi-input" type="file" accept=".csv,text/csv" onChange={(e) => setBerkas(e.target.files?.[0] ?? null)} />}</FormField>
                <VariantNote bl="BL-60">Usulan: pratinjau jumlah faktur, item, dan rentang tanggal sebelum impor; berkas berisi sama di bawah nama lain dikenali.</VariantNote>
            </ConfirmDialog>
        </div>
    );
}
