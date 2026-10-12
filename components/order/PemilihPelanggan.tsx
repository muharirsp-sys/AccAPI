/*
 * Tujuan: Pemilih pelanggan Order per cabang (O2): cari nama/kode (jeda 300 ms, minimal 2 huruf, permintaan lama dibatalkan), hasil
 *   menampilkan CABANG + channel, kartu pelanggan terpilih (Ganti pelanggan), saringan cabang opsional untuk petugas internal, dan lima
 *   keadaan yang tidak tercampur: Default (petunjuk) / Memuat / Kosong (dengan sebabnya) / Galat (kalimat + tindakan + Coba lagi) / Sukses.
 * Caller: app/(dashboard)/sales/OrderSales.tsx (salesman: server membatasi ke cabangnya), app/(dashboard)/orders/OrderBaru.tsx (semua cabang).
 * Dependensi: ./useCari, ./order-cabang(-api), components/fiori/{core,interactive}.
 * Main Functions: PemilihPelanggan, usePelanggan.
 * Side Effects: HTTP GET /api/customers/search dan baca satu pelanggan dari kodenya (rute hari ini, pemulihan draf).
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button, EmptyState, ListItem, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { MIN_HURUF, galatTidakDitemukan, type Cakupan, type Galat, type PelangganPilih, type Peran } from "./order-cabang";
import { bacaPelangganKode, cariPelanggan } from "./order-cabang-api";
import { useCari } from "./useCari";

/** kosong = belum dipilih; memuat/galat = pelanggan dari kode (rute hari ini, draf) sedang/gagal dibaca; siap = terpilih. */
export type StatePelanggan =
    | { jenis: "kosong" }
    | { jenis: "memuat"; kode: string }
    | { jenis: "siap"; p: PelangganPilih }
    | { jenis: "galat"; kode: string; galat: Galat };

export function usePelanggan(peran: Peran) {
    const [state, setState] = useState<StatePelanggan>({ jenis: "kosong" });
    const ac = useRef<AbortController | null>(null);
    const pilih = useCallback((p: PelangganPilih) => { ac.current?.abort(); setState({ jenis: "siap", p }); }, []);
    const lepas = useCallback(() => { ac.current?.abort(); setState({ jenis: "kosong" }); }, []);
    /** Baca pelanggan dari kodenya; mengembalikan pelanggannya (atau null bila tidak ditemukan / gagal / dibatalkan). */
    const bacaKode = useCallback(async (kode: string): Promise<PelangganPilih | null> => {
        ac.current?.abort();
        const c = new AbortController();
        ac.current = c;
        setState({ jenis: "memuat", kode });
        const h = await bacaPelangganKode(kode, c.signal, peran);
        if (c.signal.aborted) return null;
        if (!h.ok) {
            if (!("batal" in h)) setState({ jenis: "galat", kode, galat: h.galat });
            return null;
        }
        if (!h.data) { setState({ jenis: "galat", kode, galat: galatTidakDitemukan("pelanggan", kode, peran) }); return null; }
        setState({ jenis: "siap", p: h.data });
        return h.data;
    }, [peran]);
    return { state, pilih, lepas, bacaKode };
}

type Props = {
    state: StatePelanggan;
    peran: Peran;
    onPilih: (p: PelangganPilih) => void;
    onLepas: () => void;
    onBacaUlang?: (kode: string) => void;
    /** Saringan cabang bebas (petugas internal). Salesman tidak punya: server membatasinya ke cabang karyawannya. */
    saringCabang?: boolean;
    /** Cakupan salesman (cabang sendiri) untuk petunjuk. */
    cakupan?: Cakupan | null;
    /** Alasan pemilih terkunci (mis. kiriman sedang berjalan). */
    kunci?: string;
};

export function PemilihPelanggan({ state, peran, onPilih, onLepas, onBacaUlang, saringCabang, cakupan, kunci }: Props) {
    const [q, setQ] = useState("");
    // "Ganti pelanggan" membuka pencarian TANPA melepas pelanggan lama: yang lama baru diganti saat yang baru dipilih (dan pemanggil
    // menyetujuinya — Order Baru meminta konfirmasi bila barisnya akan terbuang), jadi membatalkan tidak kehilangan apa pun.
    const [mengganti, setMengganti] = useState(false);
    const [cabang, setCabang] = useState<number | null>(null);
    const [dikenal, setDikenal] = useState<Map<number, string>>(new Map());
    const cari = useCallback(async (kata: string, signal: AbortSignal) => {
        const h = await cariPelanggan({ q: kata, branchId: cabang, limit: 20 }, signal, peran);
        // Cabang yang pernah muncul di hasil menjadi pilihan saringan (belum ada daftar cabang tersendiri di server).
        if (h.ok && saringCabang) setDikenal((prev) => { const m = new Map(prev); for (const p of h.data.items) m.set(p.branchId, p.branchName); return m; });
        return h;
    }, [cabang, peran, saringCabang]);
    const mencari = state.jenis === "kosong" || (state.jenis === "siap" && mengganti);
    const [hasil, cobaLagi] = useCari(q, mencari, `cab:${cabang ?? ""}`, cari);
    const pilihItem = (p: PelangganPilih) => { setQ(""); setMengganti(false); onPilih(p); };

    if (state.jenis === "memuat") return <Skeleton rows={2} label={`Membaca pelanggan ${state.kode}`} />;
    if (state.jenis === "galat") {
        return (
            <MessageStrip tone="neg" title={`${state.galat.judul}.`}>
                {state.galat.pesan} {state.galat.tindakan}{" "}
                {state.galat.tidakPasti && onBacaUlang && <Button variant="tertiary" onClick={() => onBacaUlang(state.kode)}>Coba lagi</Button>}
                <Button variant="tertiary" onClick={onLepas}>Cari pelanggan lain</Button>
            </MessageStrip>
        );
    }
    if (state.jenis === "siap" && !mengganti) {
        const p = state.p;
        return (
            <div className="fi-panel" role="group" aria-label="Pelanggan terpilih">
                <div className="fi-btnrow" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <div style={{ minWidth: 0 }}>
                        <b style={{ overflowWrap: "anywhere" }}>{p.name}</b>
                        <div className="fi-small fi-muted fi-mono">{p.customerNo}</div>
                    </div>
                    <Button variant="tertiary" disabled={Boolean(kunci)} disabledReason={kunci} onClick={() => setMengganti(true)}>Ganti pelanggan</Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 fi-small">
                    <StatusBadge tone="info">Cabang {p.branchName}</StatusBadge>
                    {p.channel ? <StatusBadge tone="neu">Channel {p.channel}</StatusBadge> : <StatusBadge tone="warn">Channel belum ada</StatusBadge>}
                    <span className="fi-muted">harga {p.priceCategoryName || "standar"}</span>
                </div>
                {p.alamat && <p className="fi-small fi-subtle" style={{ overflowWrap: "anywhere" }}>{p.alamat}</p>}
            </div>
        );
    }

    const items = hasil.jenis === "siap" ? hasil.data.items : [];
    const lingkup = peran === "sales"
        ? (cakupan?.branchName ? `Hanya pelanggan cabang ${cakupan.branchName} (cabang karyawan Accurate Anda).` : "Hanya pelanggan di cabang Anda.")
        : cabang !== null ? `Cabang ${dikenal.get(cabang) ?? cabang}.` : "Semua cabang.";
    return (
        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
            <FormField label="Cari pelanggan" required help={`Ketik nama atau kode, minimal ${MIN_HURUF} huruf. ${lingkup}`}>
                {(a) => (
                    <input {...a} type="search" className="fi-input" autoComplete="off" value={q} placeholder="mis. PELANGGAN A atau C-01" disabled={Boolean(kunci)} title={kunci}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && items[0]) { e.preventDefault(); pilihItem(items[0]); } }} />
                )}
            </FormField>
            {mengganti && state.jenis === "siap" && (
                <div><Button variant="tertiary" onClick={() => { setMengganti(false); setQ(""); }}>Batal ganti — tetap {state.p.name}</Button></div>
            )}
            {saringCabang && (
                <FormField label="Saring cabang" help={dikenal.size ? undefined : "Pilihan cabang muncul dari hasil pencarian."}>
                    {(a) => (
                        <select {...a} className="fi-input" value={cabang ?? ""} onChange={(e) => setCabang(e.target.value ? Number(e.target.value) : null)}>
                            <option value="">Semua cabang</option>
                            {[...dikenal].sort((x, y) => x[1].localeCompare(y[1])).map(([id, nama]) => <option key={id} value={id}>{nama}</option>)}
                        </select>
                    )}
                </FormField>
            )}
            <div aria-live="polite" style={{ minWidth: 0 }}>
                {hasil.jenis === "memuat" && <StatusBadge tone="info" busy>Mencari pelanggan…</StatusBadge>}
                {hasil.jenis === "galat" && (
                    <MessageStrip tone="neg" title={`${hasil.galat.judul}.`}>
                        {hasil.galat.pesan} {hasil.galat.tindakan}{" "}
                        {!hasil.galat.blokirSales && <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={cobaLagi}>Coba lagi</Button>}
                    </MessageStrip>
                )}
                {hasil.jenis === "siap" && items.length === 0 && (
                    <EmptyState title={`Tidak ada pelanggan “${q.trim()}”`}
                        message={`${peran === "sales" ? "Pencarian hanya mencakup cabang Anda" : cabang !== null ? "Pencarian dibatasi ke satu cabang" : "Pencarian mencakup semua cabang"}; pelanggan nonaktif atau tanpa cabang tidak ikut. Coba nama atau kode lain.`} />
                )}
                {hasil.jenis === "siap" && items.length > 0 && (
                    <ul className="fi-list" style={{ display: "block", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", overflow: "hidden", margin: 0 }} aria-label="Hasil pencarian pelanggan">
                        {items.map((p) => (
                            <li key={p.id}>
                                <ListItem doc={p.customerNo} title={p.name} onClick={() => pilihItem(p)}
                                    meta={`Cabang ${p.branchName} · ${p.channel ? `channel ${p.channel}` : "channel belum ada"}`}
                                    badge={p.priceCategoryName ? <span className="fi-small fi-muted">harga {p.priceCategoryName}</span> : undefined} />
                            </li>
                        ))}
                    </ul>
                )}
                {hasil.jenis === "diam" && <p className="fi-small fi-muted"><Search className="fi-icon" aria-hidden style={{ verticalAlign: "-0.15em" }} /> Hasil muncul setelah {MIN_HURUF} huruf pertama.</p>}
            </div>
        </div>
    );
}
