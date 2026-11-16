/*
 * Tujuan: Tagihan Kunjungan (owner 16 Nov 2026) — layar Incaso: "munculkan ke Incaso bahwa toko tersebut sudah dikunjungi, tapi tidak tertagih
 *   dan tidak order". Per tanggal: kunjungan yang mencatat hasil tagih nota belum lunas, saringan bawaan Tidak tertagih + tidak order, lalu
 *   Tidak tertagih / Tertagih / Semua. Tiap baris: salesman, toko, principal, jam kunjungan, hasil tagih (nominal / alasan + catatan), order,
 *   dan nota belum lunas toko SAAT INI (berkurang sesudah Incaso menginput pelunasan).
 * Caller: ./page.tsx.
 * Dependensi: GET /api/form-kontrol/tagihan, components/fiori/{core,interactive}, lib/form-kontrol/constants (labelAlasanTagih), lib/promo-ui
 *   (rupiah), lib/tampil (KOSONG, sebabHttp, waktuWita), lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: TagihanKunjungan.
 * Side Effects: HTTP baca saja.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column } from "@/components/fiori/core";
import { FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { labelAlasanTagih } from "@/lib/form-kontrol/constants";
import { rupiah } from "@/lib/promo-ui";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { KOSONG, sebabHttp, waktuWita } from "@/lib/tampil";

type Ringkas = { jumlah: number; nilai: number; tertagih: number; sisa: number; umurMaks: number; lewatTempo: number };
type Baris = {
    salesCode: string; salesName: string; custCode: string; custName: string; principle: string; status: string; noOrderReasonCode: string | null;
    checkinAt: string | null; checkoutAt: string | null; tagihStatus: "tertagih" | "tidak_tertagih"; tagihNominal: number | null;
    tagihAlasan: string | null; tagihCatatan: string | null; nota: Ringkas | null;
};
type Saring = "tanpa_hasil" | "tidak" | "tertagih" | "semua";

const order = (b: Baris) => b.status === "ordered" || b.status === "active";
const COCOK: Record<Saring, (b: Baris) => boolean> = {
    tanpa_hasil: (b) => b.tagihStatus === "tidak_tertagih" && !order(b),
    tidak: (b) => b.tagihStatus === "tidak_tertagih",
    tertagih: (b) => b.tagihStatus === "tertagih",
    semua: () => true,
};

export default function TagihanKunjungan({ hariIni }: { hariIni: string }) {
    const [tanggal, setTanggal] = useState(hariIni);
    const [saring, setSaring] = useState<Saring>("tanpa_hasil");
    const loader = useCallback(async (): Promise<Load<Baris[]>> => {
        try {
            const r = await fetch(`/api/form-kontrol/tagihan?${new URLSearchParams({ tanggal })}`, { credentials: "include", cache: "no-store" });
            const d = await r.json().catch(() => null) as { ok?: boolean; rows?: Baris[]; error?: string } | null;
            if (r.ok && d?.ok && Array.isArray(d.rows)) return { status: "siap", data: d.rows };
            return { status: "galat", error: d?.error ?? `Data tagihan kunjungan gagal dimuat. ${sebabHttp(r.status)}` };
        } catch {
            return { status: "galat", error: `Data tagihan kunjungan gagal dimuat. ${sebabHttp(0)}` };
        }
    }, [tanggal]);
    const [load, muatUlang] = useLoad(loader);
    const rows = useMemo(() => load.data ?? [], [load.data]);
    const tampil = rows.filter(COCOK[saring]);
    const n = (s: Saring) => rows.filter(COCOK[s]).length;
    const totalTertagih = rows.reduce((s, b) => s + (b.tagihStatus === "tertagih" ? b.tagihNominal ?? 0 : 0), 0);

    const hasil = (b: Baris) => b.tagihStatus === "tertagih"
        ? <StatusBadge tone="pos">Tertagih {rupiah(b.tagihNominal ?? 0)}</StatusBadge>
        : <StatusBadge tone="neg" wrap>Tidak tertagih · {labelAlasanTagih(b.tagihAlasan)}</StatusBadge>;
    const teksNota = (x: Ringkas | null) => !x ? KOSONG : x.jumlah === 0 ? "Lunas sekarang"
        : `${x.jumlah} nota · sisa ${rupiah(x.sisa)} · tertua ${x.umurMaks} hari${x.lewatTempo ? ` · ${x.lewatTempo} lewat tempo` : ""}`;
    const kolom: Column<Baris>[] = [
        { key: "toko", header: "Toko", cell: (b) => <><b>{b.custName}</b><div className="fi-small fi-subtle"><span className="fi-mono">{b.custCode}</span> · {b.principle}</div></> },
        { key: "sales", header: "Salesman", cell: (b) => <>{b.salesName}<div className="fi-small fi-subtle fi-mono">{b.salesCode}</div></> },
        { key: "jam", header: "Kunjungan", secondary: true, cell: (b) => b.checkinAt ? `${waktuWita(b.checkinAt)}${b.checkoutAt ? `–${waktuWita(b.checkoutAt)}` : ""} WITA` : KOSONG },
        { key: "tagih", header: "Hasil tagih", cell: (b) => <>{hasil(b)}{b.tagihCatatan && <div className="fi-small">{b.tagihCatatan}</div>}</> },
        { key: "order", header: "Order", cell: (b) => order(b) ? <StatusBadge tone="pos">Order</StatusBadge> : <StatusBadge tone="neu">Tidak order</StatusBadge> },
        { key: "nota", header: "Nota belum lunas sekarang", secondary: true, cell: (b) => teksNota(b.nota) },
    ];

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman">
                    <ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">Tagihan Kunjungan</span></li></ol>
                </nav>
                <div className="fi-page-bar">
                    <h1>Tagihan Kunjungan</h1>
                    <span className="fi-spacer" />
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && Boolean(load.data)} onClick={muatUlang}>Muat ulang</Button>
                </div>
                <p>
                    Toko bernota belum lunas yang dikunjungi salesman pada {tanggalPanjang(tanggal)}, dengan hasil tagih yang dicatat salesman di Form Kontrol.
                    Kolom nota menunjukkan sisa saat ini, jadi berkurang sesudah pelunasan diinput.
                </p>
            </header>
            <div className="grid gap-3">
                <div className="flex flex-wrap items-end gap-3">
                    <FormField label="Tanggal kunjungan">
                        {(a) => <input {...a} type="date" className="fi-input" value={tanggal} max={hariIni} onChange={(e) => e.target.value && setTanggal(e.target.value)} />}
                    </FormField>
                    {rows.length > 0 && (
                        <p className="fi-small" role="status">
                            {rows.length} kunjungan bernota · {n("tertagih")} tertagih {rupiah(totalTertagih)} · {n("tidak")} tidak tertagih
                        </p>
                    )}
                </div>
                <div className="fi-segs" role="group" aria-label="Saring kunjungan" style={{ justifySelf: "start", flexWrap: "nowrap", overflowX: "auto", maxWidth: "100%" }}>
                    {([["tanpa_hasil", "Tidak tertagih & tidak order"], ["tidak", "Tidak tertagih"], ["tertagih", "Tertagih"], ["semua", "Semua"]] as const).map(([k, label]) => (
                        <button key={k} type="button" aria-pressed={saring === k} onClick={() => setSaring(k)} style={{ flex: "none", whiteSpace: "nowrap" }}>
                            {label}<span className="fi-count">{n(k)}</span>
                        </button>
                    ))}
                </div>
                {load.status === "galat" && load.data && <MessageStrip tone="neg" title="Gagal memuat ulang.">{load.error} Yang tampil adalah hasil sebelumnya.</MessageStrip>}
                <ResponsiveTable<Baris> title="Kunjungan" count={tampil.length} columns={kolom} rows={tampil}
                    rowKey={(b) => `${b.salesCode}|${b.custCode}|${b.principle}`}
                    status={load.status === "memuat" && !load.data ? "memuat" : load.status === "galat" && !load.data ? "galat" : "siap"}
                    error={load.error} onRetry={muatUlang}
                    mobileItem={(b) => (
                        <ListItem title={b.custName} doc={b.custCode} badge={hasil(b)}
                            meta={<>
                                {b.salesName} · {b.principle} · {order(b) ? "Order" : "Tidak order"}{b.checkinAt ? ` · ${waktuWita(b.checkinAt)} WITA` : ""}
                                <br />{teksNota(b.nota)}{b.tagihCatatan && <><br />Catatan: {b.tagihCatatan}</>}
                            </>} />
                    )}
                    empty={rows.length === 0
                        ? { title: "Belum ada kunjungan bernota", message: `Belum ada salesman yang mencatat hasil tagih pada ${tanggalPanjang(tanggal)}.` }
                        : { title: "Tidak ada yang cocok", message: "Pilih saringan lain di atas.", action: <Button onClick={() => setSaring("semua")}>Tampilkan semua</Button> }} />
            </div>
        </div>
    );
}
