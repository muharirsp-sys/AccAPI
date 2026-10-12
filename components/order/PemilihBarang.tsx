/*
 * Tujuan: Pemilih barang satu baris order (O2): cari kode/nama HANYA di barang cabang pelanggan (jeda 300 ms, minimal 2 huruf, permintaan
 *   lama dibatalkan), hasil menampilkan satuan + harga per cabang pelanggan, barang tanpa daftar harga tidak bisa dipilih (Order Sales: juga
 *   barang yang SEMUA satuannya tanpa harga sah — petugas Order Baru boleh, memakai harga petugas), dan "cabang tanpa barang" (flag server)
 *   dijelaskan, bukan daftar kosong polos. Barang terpilih tampil sebagai kartu (Ganti barang).
 * Caller: app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/OrderBaru.tsx.
 * Dependensi: ./useCari, ./order-cabang(-api), lib/promo-ui (rupiah), components/fiori/{core,interactive}.
 * Main Functions: PemilihBarang.
 * Side Effects: HTTP GET /api/items/search.
 */
"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ListItem, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { MIN_HURUF, labelSatuan, type BarangPilih, type Galat, type PelangganPilih, type Peran } from "./order-cabang";
import { cariBarang } from "./order-cabang-api";
import { useCari } from "./useCari";

const BATAS_HASIL = 20;

export type BacaanBarang = { jenis: "memuat"; kode: string } | { jenis: "galat"; kode: string; galat: Galat };

type Props = {
    nomor: number;
    pelanggan: PelangganPilih | null;
    tanggal: string;
    nilai: BarangPilih | null;
    /** Barang dari kode (pemulihan draf) sedang dibaca / gagal dibaca. */
    bacaan?: BacaanBarang | null;
    peran: Peran;
    onPilih: (b: BarangPilih) => void;
    onLepas: () => void;
    onBacaUlang?: () => void;
    /** Alasan pemilih terkunci. */
    kunci?: string;
};

export function PemilihBarang({ nomor, pelanggan, tanggal, nilai, bacaan, peran, onPilih, onLepas, onBacaUlang, kunci }: Props) {
    const [q, setQ] = useState("");
    const cari = useCallback(async (kata: string, signal: AbortSignal) => (pelanggan
        ? cariBarang({ q: kata, pelanggan, tanggal, limit: BATAS_HASIL }, signal, peran)
        : { ok: false as const, batal: true as const }), [pelanggan, tanggal, peran]);
    const [hasil, cobaLagi] = useCari(q, nilai === null && !bacaan && pelanggan !== null, `${pelanggan?.id ?? ""}|${tanggal}`, cari);

    if (bacaan?.jenis === "memuat") return <Skeleton rows={1} label={`Membaca barang ${bacaan.kode}`} />;
    if (bacaan?.jenis === "galat") {
        return (
            <MessageStrip tone="neg" title={`${bacaan.galat.judul}.`}>
                {bacaan.galat.pesan} {bacaan.galat.tindakan}{" "}
                {bacaan.galat.tidakPasti && onBacaUlang && <Button variant="tertiary" onClick={onBacaUlang}>Coba lagi</Button>}
                <Button variant="tertiary" onClick={onLepas}>Cari barang lain</Button>
            </MessageStrip>
        );
    }
    if (nilai) {
        return (
            <div className="fi-panel" role="group" aria-label={`Barang ${nomor} terpilih`} style={{ padding: "var(--sp-3)" }}>
                <div className="fi-btnrow" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <div style={{ minWidth: 0 }}>
                        <b style={{ overflowWrap: "anywhere" }}>{nilai.name || nilai.no}</b>
                        <div className="fi-small fi-muted"><span className="fi-mono">{nilai.no}</span>{nilai.branchName ? ` · ${nilai.branchName}` : ""}</div>
                    </div>
                    <Button variant="tertiary" disabled={Boolean(kunci)} disabledReason={kunci} aria-label={`Ganti barang ${nomor}`} onClick={onLepas}>Ganti barang</Button>
                </div>
            </div>
        );
    }

    const items = hasil.jenis === "siap" ? hasil.data.items : [];
    const cabang = pelanggan?.branchName ?? "";
    return (
        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
            <FormField label="Cari barang" help={pelanggan
                ? `Ketik kode atau nama, minimal ${MIN_HURUF} huruf. Hanya barang cabang ${cabang}; harga mengikuti pelanggan.`
                : "Pilih pelanggan dulu — barang mengikuti cabang pelanggan."}>
                {(a) => (
                    <input {...a} type="search" className="fi-input" autoComplete="off" value={q} placeholder="mis. BARANG A atau A-1"
                        disabled={!pelanggan || Boolean(kunci)} title={!pelanggan ? "Pilih pelanggan dulu" : kunci} onChange={(e) => setQ(e.target.value)} />
                )}
            </FormField>
            <div aria-live="polite" style={{ minWidth: 0 }}>
                {hasil.jenis === "memuat" && <StatusBadge tone="info" busy>Mencari barang…</StatusBadge>}
                {hasil.jenis === "galat" && (
                    <MessageStrip tone="neg" title={`${hasil.galat.judul}.`}>
                        {hasil.galat.pesan} {hasil.galat.tindakan}{" "}
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={cobaLagi}>Coba lagi</Button>
                    </MessageStrip>
                )}
                {hasil.jenis === "siap" && items.length === 0 && (hasil.data.cabangKosong
                    ? <EmptyState title={`Cabang ${cabang} belum punya barang yang bisa diorder`}
                        message="Master barang cabang ini belum tersinkron dari Accurate, atau semua barangnya nonaktif / bukan barang jual. Hubungi Admin untuk menyinkronkan master barang." />
                    : <EmptyState title={`Tidak ada barang “${q.trim()}” di cabang ${cabang}`}
                        message="Pencarian hanya menampilkan barang cabang pelanggan; barang nonaktif tidak ikut. Coba kode atau kata lain." />)}
                {hasil.jenis === "siap" && items.length > 0 && (
                    <ul className="fi-list" style={{ display: "block", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", overflow: "hidden", margin: 0 }} aria-label="Hasil pencarian barang">
                        {items.map((b) => {
                            const tanpaDaftar = b.units.length === 0;
                            // Harga master TIDAK sah (standar / 0 / cabang lain) = price null: sales tidak bisa memesannya; petugas boleh dengan harga petugas.
                            const tanpaHargaSah = peran === "sales" && !tanpaDaftar && b.units.every((u) => u.price === null);
                            const ringkas = tanpaDaftar ? "belum ada daftar harga" : b.units.map((u) => labelSatuan(u, true, rupiah).replace(" · ", " ")).join(" · ");
                            const tutup = tanpaDaftar || tanpaHargaSah;
                            return (
                                <li key={b.id}>
                                    <ListItem doc={b.no} title={b.name} meta={`${b.branchName ?? ""} · ${ringkas}`}
                                        badge={tutup ? <StatusBadge tone="warn">Belum bisa dipilih</StatusBadge> : undefined}
                                        onClick={tutup ? undefined : () => { setQ(""); onPilih(b); }} />
                                </li>
                            );
                        })}
                    </ul>
                )}
                {hasil.jenis === "siap" && items.length >= BATAS_HASIL && <p className="fi-small fi-muted">Menampilkan {BATAS_HASIL} teratas — persempit pencarian dengan kode atau nama yang lebih lengkap.</p>}
            </div>
        </div>
    );
}
