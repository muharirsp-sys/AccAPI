/*
 * Tujuan: Merender semua komponen inti Fiori dalam enam keadaan layar (Default, Memuat, Kosong, Galat, Sukses, Draf).
 * Caller: app/(dashboard)/dev/ui-kit/page.tsx; tests/fiori-ui-kit.spec.ts (baseline visual).
 * Dependensi: components/fiori/*, sonner (toast).
 * Main Functions: UiKit.
 * Side Effects: Hanya state lokal + toast; tidak ada HTTP. Data contoh, bukan data nyata.
 */
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CircleX, Download, FileText, History, RefreshCw, Send, Wallet } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import {
    AnchorBar, Button, EmptyState, ErrorState, FlexibleColumnLayout, Flow, FooterToolbar, KeyValues, ListItem,
    MessageStrip, ObjectPageHeader, ResponsiveTable, Skeleton, StatusBadge, Tile, type Column, type Tone,
} from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, SchemeSwitcher, useUnsavedGuard } from "@/components/fiori/interactive";

type Keadaan = "default" | "memuat" | "kosong" | "galat" | "sukses" | "draf";
const KEADAAN: Array<[Keadaan, string]> = [["default", "Default"], ["memuat", "Memuat"], ["kosong", "Kosong"], ["galat", "Galat"], ["sukses", "Sukses"], ["draf", "Draf"]];

type Faktur = { no: string; outlet: string; salesman: string; tanggal: string; total: number; status: [Tone, string] };
const FAKTUR: Faktur[] = [
    { no: "INV/2610/KN01412", outlet: "TK Sinar Jaya", salesman: "MKS-07", tanggal: "06/10/2026", total: 4_312_500, status: ["info", "Siap kirim"] },
    { no: "INV/2610/KN01413", outlet: "TK Berkah Abadi", salesman: "MKS-03", tanggal: "06/10/2026", total: 1_875_000, status: ["info", "Siap kirim"] },
    { no: "INV/2610/KN01414", outlet: "UD Maju Bersama", salesman: "MKS-05", tanggal: "06/10/2026", total: 12_640_000, status: ["warn", "Perlu ditinjau"] },
    { no: "INV/2610/KN01415", outlet: "TK Cahaya Baru", salesman: "MKS-07", tanggal: "05/10/2026", total: 960_000, status: ["neg", "Gagal kirim"] },
    { no: "INV/2610/KN01411", outlet: "TK Rezeki", salesman: "MKS-03", tanggal: "05/10/2026", total: 2_205_000, status: ["pos", "Terposting"] },
];
const OPC = [
    { no: "007/KINO/10/2026", principal: "KINO", nilai: 48_200_000, status: ["warn", "Menunggu Finance"] as [Tone, string] },
    { no: "006/KINO/10/2026", principal: "KINO", nilai: 12_750_000, status: ["pos", "Dibayar"] as [Tone, string] },
    { no: "003/GDI/10/2026", principal: "GODREJ", nilai: 31_750_000, status: ["info", "Diajukan"] as [Tone, string] },
];

const rupiah = (n: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
    return (
        <section id={id} className="fi-section grid grid-cols-1 gap-3" aria-labelledby={`${id}-h`}>
            <div className="grid gap-1">
                <h2 id={`${id}-h`} className="fi-title-2">{title}</h2>
                {note && <p className="fi-small fi-muted max-w-[80ch]">{note}</p>}
            </div>
            {children}
        </section>
    );
}

export default function UiKit() {
    const [keadaan, setKeadaan] = useState<Keadaan>("default");
    const [cari, setCari] = useState("");
    const [statusSaring, setStatusSaring] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "no", dir: "desc" });
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [rejectOpen, setRejectOpen] = useState(false);
    const [terkirim, setTerkirim] = useState(false);
    const [catatan, setCatatan] = useState("");
    const [opcDipilih, setOpcDipilih] = useState<string | null>(OPC[0].no);
    const [strip, setStrip] = useState(true);

    const draf = catatan !== "";
    useUnsavedGuard(draf);

    const sukses = keadaan === "sukses" || terkirim;
    const tabelRows = keadaan === "memuat" || keadaan === "kosong" ? [] : FAKTUR
        .map((f): Faktur => (sukses && f.status[1] === "Siap kirim" ? { ...f, status: ["pos", "Terposting"] } : f))
        .filter((f) => (!cari || `${f.no} ${f.outlet}`.toLowerCase().includes(cari.toLowerCase())) && (!statusSaring || f.status[1] === statusSaring))
        .sort((a, b) => {
            const av = sort.key === "total" ? a.total : sort.key === "outlet" ? a.outlet : a.no;
            const bv = sort.key === "total" ? b.total : sort.key === "outlet" ? b.outlet : b.no;
            return (av < bv ? -1 : av > bv ? 1 : 0) * (sort.dir === "asc" ? 1 : -1);
        });
    // Aksi massal hanya untuk baris yang terlihat: pilihan yang tersembunyi saringan tidak ikut terkirim.
    const terpilih = tabelRows.filter((f) => selected.has(f.no));
    const saringanAktif = [cari && `Cari: ${cari}`, statusSaring && `Status: ${statusSaring}`].filter(Boolean) as string[];

    const columns: Column<Faktur>[] = [
        { key: "no", header: "No. faktur", sortable: true, cell: (f) => <span className="fi-mono">{f.no}</span> },
        { key: "outlet", header: "Outlet", sortable: true, cell: (f) => f.outlet },
        { key: "salesman", header: "Salesman", secondary: true, cell: (f) => f.salesman },
        { key: "tanggal", header: "Tanggal", secondary: true, cell: (f) => f.tanggal },
        { key: "total", header: "Total", align: "end", sortable: true, cell: (f) => rupiah(f.total) },
        { key: "status", header: "Status", cell: (f) => <StatusBadge tone={f.status[0]}>{f.status[1]}</StatusBadge> },
    ];

    const opc = OPC.find((o) => o.no === opcDipilih);

    return (
        <FioriScope className="min-h-full">
            <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-10 px-4 py-6 md:px-6">
                <header className="grid grid-cols-1 gap-4">
                    <div className="grid gap-1">
                        <p className="fi-caption">Internal · hanya development · S0</p>
                        <h1 className="fi-title-1">UI kit Fiori</h1>
                        <p className="fi-muted max-w-[80ch]">Komponen inti dari UI kit Tahap 2 (aksen Biru SP) di enam keadaan layar. Data contoh, bukan data nyata. Halaman ini dipakai Playwright sebagai baseline visual.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                        <SchemeSwitcher />
                        <div className="fi-segs" role="group" aria-label="Keadaan">
                            {KEADAAN.map(([value, label]) => (
                                <button key={value} type="button" aria-pressed={keadaan === value} onClick={() => { setKeadaan(value); setTerkirim(false); setSelected(new Set()); setCatatan(value === "draf" ? "Kirim sebelum jam 10 pagi." : ""); }}>{label}</button>
                            ))}
                        </div>
                    </div>
                </header>

                <Section id="tombol" title="Tombol dan badge" note="Satu tombol utama per kelompok aksi; label kata kerja. Tombol nonaktif menyebut alasannya. Status selalu ikon + label + warna.">
                    <div className="fi-panel">
                        <div className="fi-btnrow">
                            <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />}>Kirim ke Accurate</Button>
                            <Button icon={<Download className="fi-icon" aria-hidden />}>Ekspor</Button>
                            <Button variant="tertiary" icon={<History className="fi-icon" aria-hidden />}>Lihat riwayat</Button>
                            <Button variant="negative" icon={<CircleX className="fi-icon" aria-hidden />}>Tolak</Button>
                            <Button variant="icon" aria-label="Muat ulang"><RefreshCw className="fi-icon" aria-hidden /></Button>
                            <Button variant="primary" disabled disabledReason="Pilih faktur dulu">Kirim terpilih</Button>
                            <Button variant="primary" busy>Mengirim…</Button>
                        </div>
                        <div className="fi-btnrow">
                            <StatusBadge tone="pos">Terposting</StatusBadge>
                            <StatusBadge tone="info">Siap kirim</StatusBadge>
                            <StatusBadge tone="warn">Perlu ditinjau</StatusBadge>
                            <StatusBadge tone="neg">Gagal kirim</StatusBadge>
                            <StatusBadge tone="neu">Draf</StatusBadge>
                            <StatusBadge tone="info" busy>Mengirim</StatusBadge>
                        </div>
                    </div>
                </Section>

                <Section id="pesan" title="Message strip" note="Info yang harus terbaca di halaman. Galat = role alert; lainnya role status. Toast hanya untuk sukses singkat.">
                    <div className="grid gap-2.5">
                        <MessageStrip tone="info" title="Info.">Faktur yang sudah terposting tidak bisa diubah dari sini.</MessageStrip>
                        {sukses && <MessageStrip tone="pos" title="Berhasil.">Faktur terpilih terkirim ke Accurate.</MessageStrip>}
                        <MessageStrip tone="warn" title="Perlu ditinjau.">1 faktur memakai harga yang berbeda dari daftar harga Accurate.</MessageStrip>
                        {(keadaan === "galat" || strip) && (
                            <MessageStrip tone="neg" title="Gagal kirim." onClose={keadaan === "galat" ? undefined : () => setStrip(false)}>
                                INV/2610/KN01415 ditolak Accurate: pelanggan tidak ditemukan.
                            </MessageStrip>
                        )}
                    </div>
                </Section>

                <Section id="tile" title="Tile (Beranda per peran)" note="Angka besar hanya bila angkanya inti tugas.">
                    {keadaan === "memuat" ? (
                        <div className="fi-panel"><Skeleton rows={3} label="Memuat Beranda" /></div>
                    ) : keadaan === "galat" ? (
                        <div className="fi-panel"><ErrorState message="Server tidak menjawab dalam 30 detik." onRetry={() => setKeadaan("default")} /></div>
                    ) : (
                        <div className="fi-tiles">
                            <Tile title="Antrean faktur" subtitle="Siap dikirim ke Accurate" icon={<FileText className="fi-icon" />} value={keadaan === "kosong" ? 0 : sukses ? 0 : 2} unit="faktur" footer="Terakhir dikirim 09.12 WITA" />
                            <Tile title="Perlu ditinjau" subtitle="Harga atau diskon berbeda" icon={<FileText className="fi-icon" />} value={keadaan === "kosong" ? 0 : 1} unit="faktur" tone={keadaan === "kosong" ? undefined : "warn"} />
                            <Tile title="Gagal kirim" subtitle="Ditolak Accurate" icon={<CircleX className="fi-icon" />} value={keadaan === "kosong" ? 0 : 1} unit="faktur" tone={keadaan === "kosong" ? undefined : "neg"} />
                            <Tile title="Pelunasan" subtitle="Input pelunasan pelanggan" icon={<Wallet className="fi-icon" />} footer="Pintasan" />
                        </div>
                    )}
                </Section>

                <Section id="daftar" title="List Report: filter bar + tabel responsif" note="Tabel di desktop; kolom sekunder pindah ke bawah baris di tablet; list item di ponsel. Saringan pindah ke bottom sheet di ponsel.">
                    <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                        <FilterBar
                            title="Antrean faktur"
                            activeCount={saringanAktif.length}
                            search={(
                                <FormField label="Cari">
                                    {(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="No. faktur atau outlet" value={cari} onChange={(e) => setCari(e.target.value)} />}
                                </FormField>
                            )}
                            fields={(
                                <FormField label="Status">
                                    {(a11y) => (
                                        <select {...a11y} className="fi-input" value={statusSaring} onChange={(e) => setStatusSaring(e.target.value)}>
                                            <option value="">Semua status</option>
                                            {["Siap kirim", "Perlu ditinjau", "Gagal kirim", "Terposting"].map((s) => <option key={s}>{s}</option>)}
                                        </select>
                                    )}
                                </FormField>
                            )}
                            chips={saringanAktif.map((label) => ({ label, onRemove: () => (label.startsWith("Cari") ? setCari("") : setStatusSaring("")) }))}
                            onReset={() => { setCari(""); setStatusSaring(""); }}
                        />
                        <ResponsiveTable
                            title="Faktur"
                            count={keadaan === "memuat" ? undefined : tabelRows.length}
                            columns={columns}
                            rows={tabelRows}
                            rowKey={(f) => f.no}
                            status={keadaan === "memuat" ? "memuat" : keadaan === "galat" ? "galat" : "siap"}
                            error="Koneksi ke server terputus."
                            onRetry={() => setKeadaan("default")}
                            empty={saringanAktif.length && keadaan !== "kosong"
                                ? { title: "Tidak ada faktur yang sesuai saringan", message: "Ubah atau hapus saringan untuk melihat faktur lain." }
                                : { title: "Belum ada faktur di antrean", message: "Faktur muncul di sini setelah order divalidasi." }}
                            sort={sort}
                            onSortChange={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }))}
                            selected={selected}
                            onSelectedChange={setSelected}
                            mobileItem={(f) => (
                                <ListItem doc={f.no} amount={rupiah(f.total)} title={f.outlet} meta={`${f.salesman} · ${f.tanggal}`}
                                    badge={<StatusBadge tone={f.status[0]}>{f.status[1]}</StatusBadge>} />
                            )}
                        />
                        <FooterToolbar message={terpilih.length ? `${terpilih.length} faktur dipilih · ${rupiah(terpilih.reduce((n, f) => n + f.total, 0))}` : "Pilih faktur yang akan dikirim."}>
                            <Button variant="negative" disabled={!terpilih.length} onClick={() => setRejectOpen(true)}>Tolak</Button>
                            <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={!terpilih.length} disabledReason="Pilih faktur dulu" onClick={() => setConfirmOpen(true)}>
                                Kirim ke Accurate
                            </Button>
                        </FooterToolbar>
                    </div>
                </Section>

                <Section id="objek" title="Object Page: header, alur, anchor bar, form, footer" note="Draf: indikator di header, alasan di footer, peringatan peramban saat meninggalkan halaman.">
                    <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                        <ObjectPageHeader
                            breadcrumbs={[{ label: "Antrean faktur", href: "#daftar" }, { label: "INV/2610/KN01412" }]}
                            title="INV/2610/KN01412"
                            status={<StatusBadge tone={sukses ? "pos" : "info"}>{sukses ? "Terposting" : "Siap kirim"}</StatusBadge>}
                            draft={draf}
                            actions={<Button icon={<History className="fi-icon" aria-hidden />}>Riwayat</Button>}
                            attributes={[
                                { label: "Outlet", value: "TK Sinar Jaya" },
                                { label: "Salesman", value: "MKS-07 Andi Pratama" },
                                { label: "Tanggal faktur", value: "06/10/2026" },
                                { label: "Total", value: rupiah(4_312_500) },
                            ]}
                            flow={<Flow steps={[
                                { label: "Order masuk", state: "done" },
                                { label: "Divalidasi", state: "done" },
                                { label: "Siap kirim", state: sukses ? "done" : keadaan === "galat" ? "late" : "current" },
                                { label: "Terposting", state: sukses ? "current" : "todo" },
                                { label: "Dilunasi", state: "todo" },
                            ]} />}
                        />
                        <AnchorBar anchors={[{ id: "objek-ringkasan", label: "Ringkasan" }, { id: "objek-kirim", label: "Pengiriman" }]} />
                        <div className="grid gap-4 p-4">
                            <div id="objek-ringkasan" className="fi-section grid gap-2">
                                <h3 className="fi-title-3">Ringkasan</h3>
                                {keadaan === "memuat" ? <Skeleton rows={3} label="Memuat ringkasan" /> : (
                                    <div className="max-w-md"><KeyValues items={[["Jumlah item", "14"], ["Diskon", rupiah(186_250)], ["PPN", rupiah(426_938)], ["Total", rupiah(4_312_500)]]} /></div>
                                )}
                            </div>
                            <div id="objek-kirim" className="fi-section grid gap-2">
                                <h3 className="fi-title-3">Pengiriman</h3>
                                <div className="fi-formgrid">
                                    <FormField label="Tanggal kirim" required help="Tanggal WITA." error={keadaan === "galat" ? "Tanggal kirim tidak boleh sebelum tanggal faktur." : undefined}>
                                        {(a11y) => <input {...a11y} className="fi-input" type="date" defaultValue={keadaan === "galat" ? "2026-10-05" : "2026-10-07"} />}
                                    </FormField>
                                    <FormField label="Gudang" required>
                                        {(a11y) => <select {...a11y} className="fi-input" defaultValue="MKS"><option value="MKS">Gudang Makassar</option><option value="PRE">Gudang Parepare</option></select>}
                                    </FormField>
                                    <FormField label="Nomor faktur" help="Diberikan saat order divalidasi.">
                                        {(a11y) => <input {...a11y} className="fi-input fi-mono" readOnly value="INV/2610/KN01412" />}
                                    </FormField>
                                </div>
                                <FormField label="Catatan pengiriman">
                                    {(a11y) => <textarea {...a11y} className="fi-input" value={catatan} onChange={(e) => setCatatan(e.target.value)} />}
                                </FormField>
                            </div>
                        </div>
                        <FooterToolbar message={draf ? "Perubahan belum disimpan." : keadaan === "galat" ? "Perbaiki 1 isian sebelum menyimpan." : "Belum ada perubahan."}>
                            {draf && <Button onClick={() => { setCatatan(""); setKeadaan("default"); }}>Buang perubahan</Button>}
                            <Button variant="primary" disabled={!draf} disabledReason="Belum ada perubahan" onClick={() => { setCatatan(""); setKeadaan("sukses"); toast.success("Perubahan disimpan."); }}>Simpan</Button>
                        </FooterToolbar>
                    </div>
                </Section>

                <Section id="fcl" title="Flexible Column Layout + worklist" note="Dua kolom di desktop; di bawah 1024 px satu kolom: daftar ↔ detail dengan tombol Kembali.">
                    <FlexibleColumnLayout
                        detailOpen={opc != null}
                        onBack={() => setOpcDipilih(null)}
                        listLabel="Daftar OFF Program Control"
                        list={keadaan === "memuat" ? <Skeleton rows={5} label="Memuat daftar" /> : keadaan === "kosong" ? (
                            <EmptyState title="Belum ada pengajuan" message="Pengajuan OFF program muncul di sini setelah dibuat dari Summary." />
                        ) : (
                            <ul>
                                {OPC.map((o) => (
                                    <li key={o.no}>
                                        <ListItem doc={o.no} amount={rupiah(o.nilai)} meta={o.principal} current={o.no === opcDipilih}
                                            badge={<StatusBadge tone={o.status[0]}>{o.status[1]}</StatusBadge>} onClick={() => setOpcDipilih(o.no)} />
                                    </li>
                                ))}
                            </ul>
                        )}
                        detail={opc && keadaan !== "kosong" && keadaan !== "memuat" ? (
                            <div className="grid gap-3 p-4">
                                <div className="flex flex-wrap items-center gap-3"><h3 className="fi-title-2 fi-mono">{opc.no}</h3><StatusBadge tone={opc.status[0]}>{opc.status[1]}</StatusBadge></div>
                                <div className="max-w-md"><KeyValues items={[["Principal", opc.principal], ["Nilai", rupiah(opc.nilai)], ["Periode", "Oktober 2026"]]} /></div>
                            </div>
                        ) : (
                            <EmptyState title="Pilih pengajuan" message="Detail pengajuan tampil di sini." />
                        )}
                    />
                </Section>

                <Section id="keadaan" title="Keadaan kosong, memuat, galat" note="Tiga keadaan yang selalu berbeda: galat tidak pernah tampil sebagai kosong.">
                    <div className="grid gap-4 md:grid-cols-3">
                        <div className="fi-panel"><EmptyState title="Belum ada data" message="Data muncul setelah berkas pertama diunggah." /></div>
                        <div className="fi-panel"><Skeleton rows={4} /></div>
                        <div className="fi-panel"><ErrorState message="Server tidak menjawab." onRetry={() => toast("Mencoba lagi…")} /></div>
                    </div>
                </Section>
            </div>

            <ConfirmDialog
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                tag="Tidak bisa dibatalkan"
                title={`Kirim ${terpilih.length} faktur ke Accurate?`}
                description="Faktur dibuat di Accurate Online atas nama cabang Anda."
                facts={[["Jumlah faktur", String(terpilih.length)], ["Total nilai", rupiah(terpilih.reduce((n, f) => n + f.total, 0))], ["Tujuan", "Accurate Online"]]}
                confirmLabel={`Kirim ${terpilih.length} faktur`}
                onConfirm={async () => {
                    await new Promise((r) => setTimeout(r, 600));
                    setConfirmOpen(false);
                    setSelected(new Set());
                    setTerkirim(true);
                    toast.success(`${terpilih.length} faktur terkirim ke Accurate.`);
                }}
            />
            <ConfirmDialog
                open={rejectOpen}
                onClose={() => setRejectOpen(false)}
                tone="negative"
                tag="Mengubah status"
                title={`Tolak ${terpilih.length} faktur?`}
                description="Faktur kembali ke Order Masuk dan tidak dikirim ke Accurate."
                facts={[["Jumlah faktur", String(terpilih.length)]]}
                reason={{ label: "Alasan penolakan", placeholder: "Contoh: harga belum disetujui principal" }}
                confirmLabel="Tolak faktur"
                onConfirm={() => { setRejectOpen(false); setSelected(new Set()); toast(`${terpilih.length} faktur ditolak.`); }}
            />
        </FioriScope>
    );
}
