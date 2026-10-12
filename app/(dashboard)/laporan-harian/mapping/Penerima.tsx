/*
 * Tujuan: List Report Penerima laporan (Fiori S3): keyword berkas → alamat email, saringan Aktif/Nonaktif, Nonaktifkan lewat dialog
 *   (pengganti ikon hapus tanpa konfirmasi), draf baris + Simpan perubahan di footer.
 * Caller: app/(dashboard)/laporan-harian/mapping/page.tsx.
 * Dependensi: GET/PUT /api/laporan-harian/mapping (laporan_harian.manage); components/fiori/{core,interactive}.
 * Main Functions: Penerima.
 * Side Effects: HTTP baca/tulis report_recipient. PUT menyimpan SEMUA baris (perilaku API hari ini).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, EmptyState, ErrorState, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";

type Recipient = { keyword: string; emails: string; active: boolean };
type Row = Recipient & { id: string };

const sama = (a: Recipient[], b: Recipient[]) => a.length === b.length && a.every((x, i) => x.keyword === b[i].keyword && x.emails === b[i].emails && x.active === b[i].active);
const strip = ({ keyword, emails, active }: Row): Recipient => ({ keyword, emails, active });

export default function Penerima({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehKelola = keys.has("laporan_harian.manage");
    // Tanpa izin kelola, API menjawab 403: tampilkan keadaan "tidak berwenang", bukan galat.
    const [data, muat] = useLoad(useCallback(() => bolehKelola
        ? ambil<Row[]>("/api/laporan-harian/mapping", (j) => ((j as { recipients: Recipient[] }).recipients).map((r, i) => ({ ...r, id: `${r.keyword}#${i}` })))
        : Promise.resolve({ status: "siap" as const, data: [] as Row[] }), [bolehKelola]));
    // null = mengikuti server; array = suntingan pengguna yang belum disimpan.
    const [draf, setDraf] = useState<Row[] | null>(null);
    const [cari, setCari] = useState("");
    const [tab, setTab] = useState<"aktif" | "nonaktif">("aktif");
    const [nonaktifkan, setNonaktifkan] = useState<Row | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const [galat, setGalat] = useState<string | null>(null);
    const [menyimpan, setMenyimpan] = useState(false);

    const server = useMemo(() => data.data ?? [], [data]);
    const rows = draf ?? server;
    const berubah = draf !== null && !sama(draf.map(strip), server.map(strip));
    const nBerubah = draf ? draf.filter((r) => { const s = server.find((x) => x.id === r.id); return !s || s.keyword !== r.keyword || s.emails !== r.emails || s.active !== r.active; }).length : 0;
    useUnsavedGuard(berubah);
    // Nama aksesibel isian tidak berubah saat diketik: pakai keyword tersimpan, "baru" untuk baris baru.
    const labelRow = (r: Row) => server.find((s) => s.id === r.id)?.keyword || "baru";
    const ubah = (id: string, patch: Partial<Recipient>) => setDraf((d) => (d ?? server).map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const q = cari.trim().toLowerCase();
    const tersaring = rows.filter((r) => (tab === "aktif" ? r.active : !r.active) && (!q || r.keyword.toLowerCase().includes(q) || r.emails.toLowerCase().includes(q)));
    const nAktif = rows.filter((r) => r.active).length;
    const kosongKeyword = rows.filter((r) => !r.keyword.trim() || !r.emails.trim()).length;

    async function simpan() {
        if (!draf) return;
        setMenyimpan(true); setGalat(null); setPesan(null);
        try {
            const res = await fetch("/api/laporan-harian/mapping", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipients: draf.map(strip) }) });
            const p = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) { setGalat(`Tidak tersimpan: ${p.error ?? `HTTP ${res.status}`}.`); return; }
            const ditambah = draf.filter((r) => !server.some((s) => s.id === r.id)).length;
            const dinonaktifkan = draf.filter((r) => !r.active && server.find((s) => s.id === r.id)?.active).length;
            setPesan(`Tersimpan ${jamWita(new Date())}.${ditambah ? ` ${ditambah} penerima ditambah.` : ""}${dinonaktifkan ? ` ${dinonaktifkan} dinonaktifkan.` : ""} Berlaku untuk unggahan berikutnya; run yang sudah dibuat tetap memakai penerima lamanya.`);
            setDraf(null); muat();
        } catch (e) {
            setGalat(`Tidak tersimpan: ${e instanceof Error ? e.message : String(e)}.`);
        } finally {
            setMenyimpan(false);
        }
    }

    const badge = (r: Row) => r.active ? <StatusBadge tone="pos">Aktif</StatusBadge> : <StatusBadge tone="neu">Nonaktif</StatusBadge>;
    const kolom: Column<Row>[] = [
        { key: "kw", header: "Keyword berkas", cell: (r) => bolehKelola ? <input className="fi-input fi-mono" aria-label={`Keyword ${labelRow(r)}`} value={r.keyword} placeholder="mis. SPV ANI" onChange={(e) => ubah(r.id, { keyword: e.target.value.toUpperCase() })} /> : <span className="fi-mono">{r.keyword}</span> },
        { key: "email", header: "Email (pisahkan dengan koma)", cell: (r) => bolehKelola ? <input className="fi-input" aria-label={`Email ${labelRow(r)}`} value={r.emails} placeholder="wajib diisi" onChange={(e) => ubah(r.id, { emails: e.target.value })} style={{ minWidth: "16rem" }} /> : r.emails },
        { key: "status", header: "Status", cell: badge },
        { key: "aksi", header: bolehKelola ? "Tindakan" : "", cell: (r) => bolehKelola ? (r.active ? <Button variant="tertiary" onClick={() => setNonaktifkan(r)}>Nonaktifkan…</Button> : <Button variant="tertiary" onClick={() => ubah(r.id, { active: true })}>Aktifkan</Button>) : null },
    ];

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><a href="/laporan-harian">Laporan Harian</a></li><li><span aria-current="page">Penerima laporan</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Penerima laporan</h1>
                    <span className="fi-spacer" />
                    {bolehKelola && <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} disabled={data.status === "memuat" && !data.data} onClick={() => { setDraf((d) => [...(d ?? server), { id: `baru#${Date.now()}`, keyword: "", emails: "", active: true }]); setTab("aktif"); }}>Tambah penerima</Button>}
                </div>
                <p>Nama berkas laporan dicocokkan persis (huruf besar) ke keyword. Satu email per berkas, ke semua alamat di barisnya. Baris yang dinonaktifkan tetap tersimpan, tidak hilang.</p>
                <div className="fi-page-bar">
                    <FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Keyword atau email" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>
                    <div className="fi-segs" role="group" aria-label="Status" style={{ alignSelf: "end" }}>
                        <button type="button" aria-pressed={tab === "aktif"} onClick={() => setTab("aktif")}>Aktif {nAktif}</button>
                        <button type="button" aria-pressed={tab === "nonaktif"} onClick={() => setTab("nonaktif")}>Nonaktif {rows.length - nAktif}</button>
                    </div>
                </div>
            </header>

            {galat && <MessageStrip tone="neg" title={galat} onClose={() => setGalat(null)}>{/duplikat|kembar/i.test(galat) ? "Satukan alamat keyword yang sama dalam satu baris, dipisah koma." : ""}</MessageStrip>}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {data.status === "galat" && data.data && <MessageStrip tone="neg" title="Gagal memuat ulang.">{data.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}

            {!bolehKelola ? <div className="fi-panel"><EmptyState title="Butuh izin kelola Laporan Harian" message="Daftar penerima hanya bisa dilihat dan diubah oleh pemegang izin kelola. Minta admin menambahkan izin bila Anda bertugas mengelolanya." /></div>
                : data.status === "memuat" && !data.data ? <div className="fi-panel"><Skeleton rows={5} label="Memuat penerima" /></div>
                : data.status === "galat" && !data.data ? <div className="fi-panel"><ErrorState message={data.error} onRetry={muat} /></div>
                : rows.length === 0 ? <div className="fi-panel"><EmptyState title="Belum ada penerima aktif" message="Unggahan Laporan Harian ditolak sampai ada minimal satu penerima aktif. Tambahkan keyword sesuai nama berkas, misalnya SPV ANI." action={bolehKelola ? <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setDraf([{ id: `baru#${Date.now()}`, keyword: "", emails: "", active: true }])}>Tambah penerima</Button> : undefined} /></div>
                : (
                    <>
                        {nAktif === 0 && <MessageStrip tone="warn" title="Tidak ada penerima aktif.">Unggahan Laporan Harian ditolak sampai ada minimal satu penerima aktif.</MessageStrip>}
                        <ResponsiveTable<Row> title="Penerima" count={tersaring.length} columns={kolom} rows={tersaring} rowKey={(r) => r.id}
                            empty={{ title: tab === "aktif" ? "Tidak ada penerima aktif yang sesuai" : "Tidak ada penerima nonaktif yang sesuai", message: q ? "Ubah kata kunci." : undefined }}
                            mobileItem={(r) => <ListItem doc={bolehKelola ? <input className="fi-input fi-mono" aria-label={`Keyword ${labelRow(r)}`} value={r.keyword} placeholder="mis. SPV ANI" onChange={(e) => ubah(r.id, { keyword: e.target.value.toUpperCase() })} /> : r.keyword}
                                title={bolehKelola ? <input className="fi-input" aria-label={`Email ${labelRow(r)}`} value={r.emails} placeholder="wajib diisi" onChange={(e) => ubah(r.id, { emails: e.target.value })} /> : r.emails}
                                meta={bolehKelola ? (r.active ? <Button variant="tertiary" onClick={() => setNonaktifkan(r)}>Nonaktifkan…</Button> : <Button variant="tertiary" onClick={() => ubah(r.id, { active: true })}>Aktifkan</Button>) : undefined} badge={badge(r)} />} />
                    </>
                )}

            {bolehKelola && data.data && (
                <FooterToolbar message={berubah ? <span className="fi-sum"><b>{nBerubah} baris diubah</b> · belum disimpan{kosongKeyword ? ` · ${kosongKeyword} baris belum lengkap` : ""}</span> : undefined}>
                    {berubah && <Button variant="tertiary" onClick={() => setDraf(null)}>Batal</Button>}
                    <Button variant="primary" busy={menyimpan} disabled={!berubah || kosongKeyword > 0} disabledReason={!berubah ? "Belum ada perubahan" : "Isi keyword dan email di semua baris"} onClick={simpan}>Simpan perubahan</Button>
                </FooterToolbar>
            )}

            <ConfirmDialog open={nonaktifkan !== null} onClose={() => setNonaktifkan(null)} title={`Nonaktifkan penerima ${nonaktifkan?.keyword ?? ""}?`} tag="Nonaktif" confirmLabel="Nonaktifkan"
                onConfirm={() => { if (nonaktifkan) ubah(nonaktifkan.id, { active: false }); setNonaktifkan(null); }}
                facts={[
                    ["Akibat", `Berkas ${nonaktifkan?.keyword ?? ""} di laporan berikutnya tidak punya penerima dan tidak dikirim`],
                    ["Data", "Baris tetap tersimpan sebagai nonaktif; bisa diaktifkan lagi"],
                    ["Run yang sudah dibuat", "Tidak berubah"],
                    ["Berlaku", "Setelah Simpan perubahan"],
                ]} />
        </div>
    );
}
