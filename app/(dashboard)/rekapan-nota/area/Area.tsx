/*
 * Tujuan: Worklist Mapping area outlet (Fiori S2): antrean outlet tanpa area dengan usulan, cari/saring keyakinan,
 *   area final per baris (draf → Simpan N outlet), dialog "Terima N usulan Tinggi" (pengganti tulis langsung ke master).
 * Caller: app/(dashboard)/rekapan-nota/area/page.tsx.
 * Dependensi: GET|POST /api/rekapan-nota/area; components/fiori/{core,interactive}; lib/rekapan-nota/ui.
 * Main Functions: Area.
 * Side Effects: HTTP baca/tulis customer.area (lewat API yang ada). Tidak ada logic baru.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, Clock } from "lucide-react";
import { Button, EmptyState, ErrorState, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, type Column, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";

type Keyakinan = "TINGGI" | "SEDANG" | "RENDAH";
type Baris = { kode: string; nama: string; alamat: string | null; jumlah_nota: number; usulan: string | null; keyakinan: Keyakinan | null; alasan: string | null };
type Payload = { jumlah: number; dapatUsulan?: number; tinggi?: number; outlet: Baris[] };
type SaringKeyakinan = "" | Keyakinan | "TANPA";

const KY: Record<Keyakinan, { label: string; tone: Tone }> = { TINGGI: { label: "Tinggi", tone: "pos" }, SEDANG: { label: "Sedang", tone: "info" }, RENDAH: { label: "Rendah", tone: "warn" } };

export default function Area({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehKelola = keys.has("rekapan_nota.manage");
    // Usulan disusun dari seluruh outlet berarea; route punya maxDuration 120 dtk.
    const [data, muat] = useLoad(useCallback(() => ambil<Payload>("/api/rekapan-nota/area", (j) => j as Payload, 125_000), []));
    const [isian, setIsian] = useState<Record<string, string>>({});
    const [cari, setCari] = useState("");
    const [keyakinan, setKeyakinan] = useState<SaringKeyakinan>("");
    const [dialog, setDialog] = useState<"terimaTinggi" | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const [galat, setGalat] = useState<string | null>(null);
    const [sibuk, setSibuk] = useState<string | null>(null);


    const outlet = useMemo(() => data.data?.outlet ?? [], [data]);
    const diubah = outlet.filter((o) => (isian[o.kode] ?? "") !== "" && isian[o.kode] !== (o.usulan ?? ""));
    // Baris Tinggi yang area finalnya diubah pengguna bukan lagi "usulan": disimpan lewat footer, bukan ikut Terima Tinggi.
    const tinggi = outlet.filter((o) => o.keyakinan === "TINGGI" && o.usulan && !diubah.includes(o));
    useUnsavedGuard(diubah.length > 0);
    const areaFinal = (o: Baris) => (isian[o.kode] ?? o.usulan ?? "").trim();
    const tersaring = useMemo(() => {
        const q = cari.trim().toLowerCase();
        return outlet.filter((o) => (!q || o.kode.toLowerCase().includes(q) || o.nama.toLowerCase().includes(q))
            && (!keyakinan || (keyakinan === "TANPA" ? !o.usulan : o.keyakinan === keyakinan)));
    }, [outlet, cari, keyakinan]);
    const ringkas = (rows: Baris[]) => `${rows.length} · ${rows.filter((o) => o.keyakinan === "TINGGI").length} Tinggi · ${rows.filter((o) => o.keyakinan === "SEDANG").length} Sedang · ${rows.filter((o) => o.keyakinan === "RENDAH").length} Rendah · ${rows.filter((o) => !o.usulan).length} tanpa usulan`;
    const daftarArea = useMemo(() => [...new Set(outlet.map((o) => o.usulan).filter((a): a is string => Boolean(a)))].sort(), [outlet]);

    /** Simpan ke master outlet. Dari dialog: galat dilempar (tampil di dialog); dari baris/footer: galat di halaman. */
    async function simpan(terima: Array<{ kode: string; area: string }>, kunci: string, dariDialog = false) {
        if (!terima.length) return;
        setSibuk(kunci); setGalat(null); setPesan(null);
        try {
            const res = await fetch("/api/rekapan-nota/area", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ terima }) });
            const p = (await res.json().catch(() => ({}))) as { tersimpan?: number; gagal?: string[]; error?: string };
            if (!res.ok) {
                const msg = p.error ?? `Area tidak tersimpan (HTTP ${res.status}).`;
                if (dariDialog) throw new Error(msg);
                setGalat(msg); return;
            }
            setDialog(null);
            setPesan(`${p.tersimpan ?? 0} outlet dipetakan ${jamWita(new Date())}${p.gagal?.length ? `; ${p.gagal.length} gagal (${p.gagal.join(", ")})` : ""}. Notanya masuk lembar area mulai wave berikutnya; wave yang sudah berisi tetap memakai area saat nota masuk.`);
            // Hanya draf yang tersimpan yang dibuang; baris lain (termasuk yang gagal) tetap jadi draf.
            const tersimpan = new Set(terima.map((t) => t.kode).filter((k) => !p.gagal?.includes(k)));
            setIsian((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !tersimpan.has(k))));
            muat();
        } finally {
            setSibuk(null);
        }
    }

    const badgeKy = (o: Baris) => o.keyakinan ? <StatusBadge tone={KY[o.keyakinan].tone}>{KY[o.keyakinan].label}</StatusBadge> : <span className="fi-small fi-subtle">Tanpa usulan</span>;
    const kolom: Column<Baris>[] = [
        { key: "outlet", header: "Outlet", cell: (o) => <><b>{o.nama}</b><span className="fi-codes">{o.kode}</span></> },
        { key: "alamat", header: "Alamat", secondary: true, cell: (o) => <span className="fi-small">{o.alamat ?? "–"}</span> },
        { key: "nota", header: "Nota", align: "end", cell: (o) => <span className="fi-tnum">{o.jumlah_nota}</span> },
        { key: "usulan", header: "Usulan", cell: (o) => <>{o.usulan && <b>{o.usulan} </b>}{badgeKy(o)}</> },
        { key: "alasan", header: "Alasan", secondary: true, cell: (o) => <span className="fi-small">{o.alasan ?? "–"}</span> },
        { key: "final", header: "Area final", cell: (o) => bolehKelola
            ? <input className="fi-input" list="fi-area-list" aria-label={`Area final ${o.nama}`} placeholder="Pilih area" value={isian[o.kode] ?? o.usulan ?? ""} onChange={(e) => setIsian((s) => ({ ...s, [o.kode]: e.target.value.toUpperCase() }))} style={{ width: "9rem" }} />
            : <span>{o.usulan ?? "–"}</span> },
        { key: "aksi", header: bolehKelola ? "Tindakan" : "", cell: (o) => bolehKelola
            ? <Button busy={sibuk === o.kode} disabled={!areaFinal(o)} disabledReason="Pilih area dulu" onClick={() => simpan([{ kode: o.kode, area: areaFinal(o) }], o.kode)}>Simpan</Button>
            : null },
    ];
    const memuatAwal = data.status === "memuat" && !data.data;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><a href="/rekapan-nota">Rekapan Nota</a></li><li><span aria-current="page">Mapping area</span></li></ol></nav>
                <h1>Mapping area</h1>
                <p>Outlet yang muncul di nota tetapi belum punya area. Usulan, bukan penetapan: area kosong ketahuan di antrean ini, area salah diam-diam mengirim barang ke rute keliru. Selama belum dipetakan, notanya tidak muncul di lembar area mana pun.</p>
            </header>

            {galat && <MessageStrip tone="neg" title={galat} onClose={() => setGalat(null)} />}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {data.status === "galat" && data.data && <MessageStrip tone="neg" title="Gagal memuat ulang.">{data.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}

            {memuatAwal ? (
                <>
                    <MessageStrip tone="info" title="Menyusun usulan dari semua outlet berarea…"><Clock className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> Bisa sampai 2 menit.</MessageStrip>
                    <div className="fi-panel"><Skeleton rows={6} label="Memuat antrean mapping" /></div>
                </>
            ) : data.status === "galat" && !data.data ? (
                <div className="fi-panel"><ErrorState title="Antrean gagal dimuat" message={`${data.error}. Tidak ada yang berubah. Coba lagi; bila berulang, isi area lewat master outlet.`} onRetry={muat} /></div>
            ) : outlet.length === 0 ? (
                <div className="fi-panel"><EmptyState title="Semua outlet di nota sudah punya area" message="Outlet baru muncul di sini saat notanya masuk pool tanpa area. Area menentukan lembar picking per area." /></div>
            ) : (
                <>
                    <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                        <FilterBar title="Outlet tanpa area" activeCount={keyakinan ? 1 : 0} onReset={() => { setKeyakinan(""); setCari(""); }}
                            search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Kode atau nama outlet" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                            fields={<FormField label="Keyakinan">{(a11y) => <select {...a11y} className="fi-input" value={keyakinan} onChange={(e) => setKeyakinan(e.target.value as SaringKeyakinan)}>
                                <option value="">Semua keyakinan</option><option value="TINGGI">Tinggi</option><option value="SEDANG">Sedang</option><option value="RENDAH">Rendah</option><option value="TANPA">Tanpa usulan</option>
                            </select>}</FormField>}
                            chips={keyakinan ? [{ label: `Keyakinan: ${keyakinan === "TANPA" ? "Tanpa usulan" : KY[keyakinan].label}`, onRemove: () => setKeyakinan("") }] : undefined}
                            actions={bolehKelola ? <Button variant="primary" icon={<Check className="fi-icon" aria-hidden />} disabled={!tinggi.length} disabledReason="Tidak ada usulan berkeyakinan Tinggi" onClick={() => setDialog("terimaTinggi")}>Terima {tinggi.length} usulan Tinggi…</Button> : undefined} />
                    </div>
                    <datalist id="fi-area-list">{daftarArea.map((a) => <option key={a} value={a} />)}</datalist>
                    <ResponsiveTable<Baris> title="Outlet tanpa area" count={tersaring.length} columns={kolom} rows={tersaring} rowKey={(o) => o.kode}
                        status={data.status} error={data.error} onRetry={muat}
                        empty={{ title: "Tidak ada outlet yang sesuai saringan", message: "Ubah kata kunci atau keyakinan." }}
                        mobileItem={(o) => <ListItem doc={o.kode} title={`${o.nama} · ${o.jumlah_nota} nota`} badge={badgeKy(o)}
                            meta={<>
                                <span>{o.usulan ? `Usulan area ${o.usulan} · ` : ""}{o.alasan ?? ""}</span>
                                {bolehKelola && (
                                    <span className="fi-page-bar" style={{ marginTop: 6 }}>
                                        <input className="fi-input" list="fi-area-list" aria-label={`Area final ${o.nama}`} placeholder="Pilih area" value={isian[o.kode] ?? o.usulan ?? ""} onChange={(e) => setIsian((s) => ({ ...s, [o.kode]: e.target.value.toUpperCase() }))} style={{ minWidth: "7rem", flex: 1 }} />
                                        <Button busy={sibuk === o.kode} disabled={!areaFinal(o)} disabledReason="Pilih area dulu" onClick={() => simpan([{ kode: o.kode, area: areaFinal(o) }], o.kode)}>Simpan</Button>
                                    </span>
                                )}
                            </>} />} />
                    <p className="fi-small fi-subtle">{ringkas(outlet)} · Nota = jumlah nota outlet ini di pool, semua tanggal.</p>
                </>
            )}

            {bolehKelola && diubah.length > 0 && (
                <FooterToolbar message={<span className="fi-sum"><b>{diubah.length} diubah</b> · belum disimpan</span>}>
                    <Button variant="tertiary" onClick={() => setIsian({})}>Batal</Button>
                    <Button variant="primary" busy={sibuk === "footer"} onClick={() => simpan(diubah.map((o) => ({ kode: o.kode, area: areaFinal(o) })), "footer")}>Simpan {diubah.length} outlet</Button>
                </FooterToolbar>
            )}

            <ConfirmDialog open={dialog === "terimaTinggi"} onClose={() => setDialog(null)} title={`Terima ${tinggi.length} usulan berkeyakinan Tinggi?`} tag="Master outlet" confirmLabel={`Terima ${tinggi.length} usulan`}
                onConfirm={() => simpan(tinggi.map((o) => ({ kode: o.kode, area: o.usulan! })), "dialog", true)}
                facts={[
                    ...tinggi.slice(0, 3).map((o): [string, string] => [`${o.kode} · ${o.nama}`, `area ${o.usulan}`]),
                    ...(tinggi.length > 3 ? [[`${tinggi.length - 3} outlet lain`, "lihat daftar"] as [string, string]] : []),
                    ["Ditulis ke", "Area di master outlet; berlaku untuk nota yang masuk wave setelah ini"],
                    ["Wave yang sudah berisi", "Tetap memakai area saat nota masuk"],
                ]} />
        </div>
    );
}
