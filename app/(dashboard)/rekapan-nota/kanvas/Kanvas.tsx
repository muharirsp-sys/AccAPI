/*
 * Tujuan: Worklist Nota kanvas per salesman (Fiori S2): pilih dan tandai/lepas tanda, dialog "tandai semua nota salesman"
 *   (pengganti confirm browser), pernyataan nihil lewat dialog (pengganti kotak centang yang langsung tersimpan).
 * Caller: app/(dashboard)/rekapan-nota/kanvas/page.tsx.
 * Dependensi: GET|POST|DELETE|PATCH /api/rekapan-nota/kanvas; components/fiori/{core,interactive}; lib/rekapan-nota/ui; lib/beranda (witaToday).
 * Main Functions: Kanvas.
 * Side Effects: HTTP baca/tulis nota_kanvas dan kanvas_nihil. Logic BL-57 tidak ditulis (varian berlabel).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Lock, Truck, Undo2 } from "lucide-react";
import {
    Button, EmptyState, ErrorState, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, VariantNote, type Column,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { witaToday } from "@/lib/beranda";
import { ambil, jamWita, tanggalPanjang, tanggalPendek } from "@/lib/rekapan-nota/ui";

type Nota = { no_nota: string; kode_salesman: string; salesman: string; customer: string | null; jumlah_baris: number; total_pcs: number; kanvas: boolean; terkunci: boolean | null; di_wave: boolean | null };
type Nihil = { ditandai_at: string; catatan: string | null; oleh: string } | null;
type Payload = { tanggal: string; jumlahNota: number; ditandai: number; nihil: Nihil; nota: Nota[] };
type Dialog = "tandaiSemua" | "nihil" | "cabutNihil" | null;

async function kirimJson(method: string, body: unknown) {
    const res = await fetch("/api/rekapan-nota/kanvas", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; bentrok?: Array<{ no_nota: string; nama: string }>; terkunci?: Array<{ no_nota: string; nama: string }> };
    return { ok: res.ok, status: res.status, payload };
}

export default function Kanvas({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehKelola = keys.has("rekapan_nota.manage");
    const [tanggal, setTanggal] = useState(witaToday);
    const [data, muat] = useLoad(useCallback(() => ambil<Payload>(`/api/rekapan-nota/kanvas?tanggal=${tanggal}`), [tanggal]));
    const [salesmanSaring, setSalesmanSaring] = useState("");
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<Dialog>(null);
    const [sisaSalesman, setSisaSalesman] = useState<{ kode: string; nama: string; nota: Nota[] } | null>(null);
    const [catatanNihil, setCatatanNihil] = useState("");
    const [pesan, setPesan] = useState<string | null>(null);
    const [galat, setGalat] = useState<string | null>(null);
    const [sibuk, setSibuk] = useState<"tandai" | "lepas" | null>(null);


    const nota = useMemo(() => data.data?.nota ?? [], [data]);
    const nihil = data.data?.nihil ?? null;
    const perSalesman = useMemo(() => {
        const m = new Map<string, { kode: string; nama: string; nota: Nota[] }>();
        for (const n of nota) {
            if (salesmanSaring && n.kode_salesman !== salesmanSaring) continue;
            const g = m.get(n.kode_salesman) ?? { kode: n.kode_salesman, nama: n.salesman, nota: [] };
            g.nota.push(n); m.set(n.kode_salesman, g);
        }
        return [...m.values()];
    }, [nota, salesmanSaring]);
    const salesmanList = useMemo(() => [...new Map(nota.map((n) => [n.kode_salesman, n.salesman])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [nota]);
    const dipilih = perSalesman.flatMap((g) => g.nota).filter((n) => pilih.has(n.no_nota)); // hanya yang terlihat setelah saringan
    const bisaTandai = dipilih.filter((n) => !n.kanvas && !n.di_wave);
    const bisaLepas = dipilih.filter((n) => n.kanvas && !n.terkunci);

    /** Hasil tulis tampil di halaman (bukan dialog); pilihan tidak dikosongkan saat gagal. */
    async function tandai(noNota: string[], dariDialog = false) {
        if (!noNota.length) return;
        setSibuk("tandai"); setGalat(null); setPesan(null);
        try {
            const r = await kirimJson("POST", { noNota });
            if (!r.ok) {
                const detail = (r.payload.bentrok ?? []).map((x) => `${x.no_nota} ada di Wave ${x.nama}`).join(", ");
                const msg = `${r.payload.error ?? "Tidak ada nota yang ditandai."}${detail ? ` ${detail}.` : ""} Tidak ada nota yang ditandai.`;
                if (dariDialog) throw new Error(msg);
                setGalat(msg); return;
            }
            const ditandai = (r.payload.ditandai as string[] | undefined) ?? [];
            setPesan(`${ditandai.length} nota ditandai kanvas ${jamWita(new Date())}: ${ditandai.join(", ")}. Keluar dari pool reguler dan menunggu wave kanvas.`);
            setDialog(null);
            // Tawaran sekali: bila semua yang ditandai dari satu salesman dan salesman itu masih punya nota reguler lain.
            const kode = [...new Set(nota.filter((n) => noNota.includes(n.no_nota)).map((n) => n.kode_salesman))];
            const sisa = kode.length === 1 ? nota.filter((n) => n.kode_salesman === kode[0] && !n.kanvas && !n.di_wave && !noNota.includes(n.no_nota)) : [];
            setPilih(new Set()); muat();
            if (!dariDialog && sisa.length) { setSisaSalesman({ kode: kode[0], nama: sisa[0].salesman, nota: sisa }); setDialog("tandaiSemua"); }
        } finally {
            setSibuk(null);
        }
    }

    async function lepasTanda() {
        if (!bisaLepas.length) return;
        setSibuk("lepas"); setGalat(null); setPesan(null);
        try {
            const r = await kirimJson("DELETE", { noNota: bisaLepas.map((n) => n.no_nota) });
            if (!r.ok) {
                const detail = (r.payload.terkunci ?? []).map((x) => `${x.no_nota} di Wave ${x.nama}`).join(", ");
                setGalat(`${r.payload.error ?? "Tanda tidak dicabut."}${detail ? ` ${detail}.` : ""}`); return;
            }
            setPesan(`${((r.payload.dibatalkan as string[] | undefined) ?? []).length} tanda kanvas dicabut; notanya kembali ke pool reguler.`);
            setPilih(new Set()); muat();
        } finally {
            setSibuk(null);
        }
    }

    async function setNihil(nihilBaru: boolean) {
        const r = await kirimJson("PATCH", { tanggal, nihil: nihilBaru, catatan: nihilBaru ? catatanNihil.trim() || undefined : undefined });
        if (!r.ok) throw new Error(r.payload.error ?? "Pernyataan tidak tersimpan.");
        setDialog(null); setCatatanNihil(""); setGalat(null);
        setPesan(nihilBaru ? `Dicatat: tidak ada nota kanvas ${tanggalPendek(tanggal)}.` : "Pernyataan nihil dicabut; penandaan dibuka lagi.");
        muat();
    }

    const kolom: Column<Nota>[] = [
        { key: "nota", header: "Nota", cell: (n) => <span className="fi-mono">{n.no_nota}</span> },
        { key: "outlet", header: "Outlet", cell: (n) => n.customer ?? "–" },
        { key: "baris", header: "Baris", align: "end", secondary: true, cell: (n) => <span className="fi-tnum">{n.jumlah_baris}</span> },
        { key: "pcs", header: "Pcs", align: "end", cell: (n) => <span className="fi-tnum">{n.total_pcs}</span> },
        { key: "status", header: "Status", cell: (n) => statusNota(n) },
    ];
    const statusNota = (n: Nota) => n.kanvas
        ? <StatusBadge tone="info"><Truck className="fi-icon" aria-hidden />Kanvas{n.terkunci ? " · terkunci" : ""}</StatusBadge>
        : n.di_wave ? <StatusBadge tone="neu"><Lock className="fi-icon" aria-hidden />Di wave reguler</StatusBadge> : <span className="fi-small fi-subtle">Reguler</span>;
    const togglePilih = (no: string) => setPilih((s) => { const x = new Set(s); if (x.has(no)) x.delete(no); else x.add(no); return x; });
    const memuatAwal = data.status === "memuat" && !data.data;
    const kosong = data.status === "siap" && nota.length === 0;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><a href="/rekapan-nota">Rekapan Nota</a></li><li><span aria-current="page">Nota kanvas</span></li></ol></nav>
                <h1>Nota kanvas · {tanggalPanjang(tanggal)}</h1>
                <p>Barang kanvas sudah keluar lewat pemindahan gudang; rekapannya dicetak setelah kanvaser pulang. Nota bertanda masuk wave kanvas, bukan wave reguler. Tanda melekat pada nomor nota, jadi selamat kalau file export diunggah ulang.</p>
                <div className="fi-page-bar">
                    <FormField label="Tanggal">{(a11y) => <input {...a11y} className="fi-input" type="date" value={tanggal} onChange={(e) => { if (e.target.value) { setTanggal(e.target.value); setPilih(new Set()); } }} />}</FormField>
                    <FormField label="Salesman">{(a11y) => <select {...a11y} className="fi-input" value={salesmanSaring} onChange={(e) => setSalesmanSaring(e.target.value)}><option value="">Semua salesman</option>{salesmanList.map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}</select>}</FormField>
                    {data.data && <span className="fi-small fi-subtle" style={{ alignSelf: "end", paddingBottom: 10 }}>{data.data.jumlahNota} nota · <b>{data.data.ditandai}</b> bertanda kanvas</span>}
                </div>
            </header>

            {galat && <MessageStrip tone="neg" title={galat} onClose={() => setGalat(null)} />}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {data.status === "galat" && data.data && <MessageStrip tone="neg" title="Gagal memuat ulang.">{data.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>}
            {nihil && (
                <MessageStrip tone="info" title={`Dinyatakan tidak ada nota kanvas ${tanggalPendek(tanggal)}`}>
                    oleh {nihil.oleh} · {jamWita(nihil.ditandai_at)}{nihil.catatan ? ` · ${nihil.catatan}` : ""}. Penandaan kanvas dimatikan untuk tanggal ini.{" "}
                    {bolehKelola && <Button variant="tertiary" onClick={() => setDialog("cabutNihil")}>Cabut pernyataan…</Button>}
                </MessageStrip>
            )}

            {memuatAwal ? <div className="fi-panel"><Skeleton rows={6} label="Memuat nota" /></div>
                : data.status === "galat" && !data.data ? <div className="fi-panel"><ErrorState message={data.error} onRetry={muat} /></div>
                : kosong ? (
                    <>
                        <div className="fi-panel">
                            <EmptyState title={`Belum ada nota ${tanggalPendek(tanggal)} di pool`} message="Nota muncul setelah file export diunggah di Rekapan Nota. Bila hari ini tidak ada kanvas, nihil bisa dinyatakan sekarang." />
                        </div>
                        <VariantNote bl="BL-57">Setelah nihil dinyatakan, hanya tombol di layar ini yang mati; layar lain yang masih terbuka tetap bisa menandai. Usulan: server juga menolak penandaan setelah nihil.</VariantNote>
                    </>
                ) : perSalesman.length === 0 ? <div className="fi-panel"><EmptyState title="Tidak ada nota salesman ini" message="Pilih salesman lain atau Semua salesman." /></div>
                : perSalesman.map((g) => {
                    const sisa = g.nota.filter((n) => !n.kanvas && !n.di_wave);
                    const nK = g.nota.filter((n) => n.kanvas).length;
                    return (
                        <Section key={g.kode} title={`${g.kode} · ${g.nama}`} subtitle={`${g.nota.length} nota · ${nK} bertanda kanvas`}
                            actions={bolehKelola && !nihil && sisa.length > 1 ? <Button variant="tertiary" onClick={() => { setSisaSalesman({ kode: g.kode, nama: g.nama, nota: sisa }); setDialog("tandaiSemua"); }}>Tandai semua {sisa.length} nota…</Button> : undefined}>
                            <ResponsiveTable<Nota> title={`Nota ${g.nama}`} columns={kolom} rows={g.nota} rowKey={(n) => n.no_nota}
                                selected={bolehKelola ? pilih : undefined} onSelectedChange={bolehKelola ? setPilih : undefined}
                                selectableRow={(n) => !n.terkunci && !(n.di_wave && !n.kanvas)}
                                empty={{ title: "Tidak ada nota" }}
                                mobileItem={(n) => <ListItem
                                    doc={bolehKelola && !n.terkunci && !(n.di_wave && !n.kanvas) ? <label className="fi-check"><input type="checkbox" aria-label={`Pilih ${n.no_nota}`} checked={pilih.has(n.no_nota)} onChange={() => togglePilih(n.no_nota)} />{n.no_nota}</label> : n.no_nota}
                                    title={`${n.customer ?? "–"} · ${n.jumlah_baris} baris · ${n.total_pcs} pcs`} badge={statusNota(n)} />} />
                        </Section>
                    );
                })}

            {bolehKelola && !memuatAwal && data.data && (
                <FooterToolbar message={nihil ? "Nihil sudah dinyatakan untuk tanggal ini" : dipilih.length ? <span className="fi-sum"><b>{dipilih.length} dipilih</b>{bisaTandai.length !== dipilih.length ? ` · ${bisaTandai.length} bisa ditandai` : ""}</span> : kosong ? undefined : "Pilih nota untuk ditandai atau dilepas tandanya"}>
                    {!nihil && kosong && <Button onClick={() => setDialog("nihil")}>Nyatakan nihil…</Button>}
                    {!nihil && !kosong && <Button onClick={() => setDialog("nihil")} disabled={(data.data.ditandai ?? 0) > 0} disabledReason="Masih ada nota bertanda kanvas">Nyatakan nihil…</Button>}
                    <Button icon={<Undo2 className="fi-icon" aria-hidden />} busy={sibuk === "lepas"} disabled={!bisaLepas.length} disabledReason="Pilih nota bertanda kanvas yang belum terkunci" onClick={lepasTanda}>Lepas tanda{bisaLepas.length ? ` (${bisaLepas.length})` : ""}</Button>
                    <Button variant="primary" icon={<Truck className="fi-icon" aria-hidden />} busy={sibuk === "tandai"} disabled={Boolean(nihil) || !bisaTandai.length}
                        disabledReason={nihil ? "Nihil sudah dinyatakan" : kosong ? "Belum ada nota" : "Pilih nota reguler dulu"} onClick={() => tandai(bisaTandai.map((n) => n.no_nota))}>
                        Tandai kanvas{bisaTandai.length ? ` (${bisaTandai.length})` : ""}
                    </Button>
                </FooterToolbar>
            )}

            <ConfirmDialog open={dialog === "tandaiSemua"} onClose={() => { setDialog(null); setSisaSalesman(null); }} title={`Tandai ${sisaSalesman?.nota.length ?? 0} nota ${sisaSalesman?.kode ?? ""} · ${sisaSalesman?.nama ?? ""} sebagai kanvas?`} tag="Kanvas"
                confirmLabel={`Tandai ${sisaSalesman?.nota.length ?? 0} nota`} onConfirm={() => tandai(sisaSalesman?.nota.map((n) => n.no_nota) ?? [], true)}
                facts={[
                    ["Nota", sisaSalesman?.nota.map((n) => `${n.no_nota} ${n.customer ?? ""}`.trim()).join(" · ") ?? ""],
                    ["Akibat", "Keluar dari pool reguler; hanya bisa masuk wave kanvas"],
                    ["Nota di wave reguler", "Ditolak; lepas dulu dari wavenya"],
                ]} />
            <ConfirmDialog open={dialog === "nihil"} onClose={() => setDialog(null)} title={`Nyatakan tidak ada nota kanvas ${tanggalPendek(tanggal)}?`} tag="Nihil" confirmLabel="Nyatakan nihil" onConfirm={() => setNihil(true)}
                facts={[["Tercatat", "Nama Anda dan jam saat ini"], ["Akibat", `Tandai kanvas dimatikan untuk ${tanggalPendek(tanggal)}; cabut pernyataan untuk membukanya lagi. Layar penyusunan wave tidak lagi berkata “kanvas belum diperiksa”`]]}>
                <FormField label="Catatan" help="Opsional, mis. kanvaser cuti.">{(a11y) => <input {...a11y} className="fi-input" value={catatanNihil} onChange={(e) => setCatatanNihil(e.target.value)} />}</FormField>
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "cabutNihil"} onClose={() => setDialog(null)} title={`Cabut pernyataan nihil ${tanggalPendek(tanggal)}?`} tag="Nihil" confirmLabel="Cabut pernyataan" onConfirm={() => setNihil(false)}
                facts={[["Akibat", "Penandaan kanvas dibuka lagi; layar penyusunan wave kembali menandai kanvas belum diperiksa"]]} />
        </div>
    );
}
