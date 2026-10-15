/*
 * Tujuan: Dialog "Antrekan faktur untuk Order …?" (it06 `antre1`, pengganti JSON payload + "Masukkan ke antrean faktur"): pelanggan,
 *   cabang/seri faktur, tanggal faktur, nilai + PPN, hasil cek harga, dan SALESMAN WAJIB dipilih (C7: satu per order, disalin ke setiap
 *   baris faktur). Payload teknis tetap ada di bagian terlipat.
 * Caller: ./OrderDetail.tsx (dipasang hanya saat dibuka, sehingga setiap pembukaan memuat ulang pratinjau).
 * Dependensi: GET /api/orders/salesmen?branchId= (O2: hanya salesman cabang PELANGGAN order, cabangnya dari `branch.branchId` pratinjau),
 *   POST /api/orders/[id]/invoice (pratinjau `queue:false`, antre `queue:true` + `salesman`); ./order-ui; components/order/order-cabang;
 *   components/fiori/*; lib/promo-ui (rupiah); lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: AntreFaktur.
 * Side Effects: HTTP; `queue:true` menulis satu baris Antrean Faktur (tanpa tulis ke Accurate — faktur dibuat saat Kirim di Antrean Faktur).
 */
"use client";

import { useEffect, useState } from "react";
import { Button, MessageStrip, Skeleton, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, type Load } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { galatDariJawaban, kodeDikenal, urlSalesmanCabang } from "@/components/order/order-cabang";
import { nextApi, nomorOrder, pesanJawaban, sukses, tidakPasti, type OrderFull } from "./order-ui";

type Salesman = { number: string; name: string };
type Pratinjau = { payload: Record<string, unknown>; branch: { branchId?: number; branchName?: string } | null; salesman: { number: string; name: string } | null };
/** Kode penolakan server (mis. salesman bukan cabang pelanggan) ikut dibawa supaya layar menyebut sebabnya, bukan "payload gagal". */
type Cek = { untuk: string; load: Load<Pratinjau>; kode?: string };
export type HasilAntre = { jenis: "antre" | "terposting" | "ragu"; pesan?: string };

const PPN = 0.11;

/** Pratinjau payload (dry-run): menyentuh master satuan, cabang, dan — bila dipilih — salesman; tidak menulis apa pun. */
async function pratinjau(id: string, salesman: string): Promise<{ load: Load<Pratinjau>; kode?: string }> {
    const j = await nextApi(`/api/orders/${encodeURIComponent(id)}/invoice`, { queue: false, ...(salesman ? { salesman } : {}) });
    if (!sukses(j)) {
        const kode = galatDariJawaban(j).kode;
        return { load: { status: "galat", error: pesanJawaban(j, "Payload faktur gagal dibuat.") }, kode: kodeDikenal(kode) ? kode : undefined };
    }
    return { load: { status: "siap", data: { payload: (j.data.payload ?? {}) as Record<string, unknown>, branch: (j.data.branch ?? null) as Pratinjau["branch"], salesman: (j.data.salesman ?? null) as Pratinjau["salesman"] } } };
}

export function AntreFaktur({ order, hargaBeda, onClose, onSelesai, onMuatUlang }: {
    order: OrderFull;
    /** Jumlah barang yang harganya beda dari master; null = harga master tidak terbaca. */
    hargaBeda: number | null;
    onClose: () => void;
    onSelesai: (hasil: HasilAntre) => void;
    /** Dipanggil saat server menolak dengan 409 (mis. "sudah ada di antrean"): status antrean halaman dibaca ulang. */
    onMuatUlang?: () => void;
}) {
    const [salesman, setSalesman] = useState("");
    // Pratinjau DIKAITKAN dengan salesman yang dipilih: tombol hanya aktif bila pratinjau untuk pilihan ITU lulus (bukan pilihan sebelumnya).
    const [cek, setCek] = useState<Cek | null>(null);
    // Cabang pelanggan dari pratinjau yang LULUS, diingat terpisah: pratinjau berikutnya yang gagal (mis. salesman ditolak) tidak boleh
    // membuat cabangnya hilang dan daftar salesman jatuh ke "tak terbaca".
    const [cabang, setCabang] = useState<{ id: number; nama: string } | null>(null);
    const [versiDaftar, setVersiDaftar] = useState(0);
    const [daftarDibaca, setDaftarDibaca] = useState<{ untuk: number; versi: number; load: Load<Salesman[]> } | null>(null);

    useEffect(() => {
        let hidup = true;
        void pratinjau(order.id, salesman).then(({ load, kode }) => {
            if (!hidup) return;
            setCek({ untuk: salesman, load, kode });
            const b = load.data?.branch;
            if (b?.branchId != null) setCabang({ id: b.branchId, nama: b.branchName ?? "" });
        });
        return () => { hidup = false; };
    }, [order.id, salesman]);

    const cekKini: Load<Pratinjau> = cek?.untuk === salesman ? cek.load : { status: "memuat" };
    const terakhir = cekKini.status === "siap" ? cekKini.data : cek?.load.data; // fakta kepala tetap tampil saat salesman berganti
    // O2: daftar salesman = salesman cabang PELANGGAN order (cabangnya dibaca server dari pelanggan dan dikirim di `branch` pratinjau); cabang
    // lain tidak ditawarkan, dan server menolaknya juga. Tanpa cabang yang terbaca daftar TIDAK dimuat tanpa batas (bukan "semua cabang").
    const cabangId = cabang?.id ?? null;
    const cabangNama = cabang?.nama ?? "";
    useEffect(() => {
        if (cabangId === null) return;
        let hidup = true;
        void nextApi(urlSalesmanCabang(cabangId)).then((j) => {
            if (!hidup) return;
            setDaftarDibaca({ untuk: cabangId, versi: versiDaftar, load: sukses(j) ? { status: "siap", data: (j.data.salesmen as Salesman[]) ?? [] } : { status: "galat", error: pesanJawaban(j, "Daftar salesman gagal dimuat.") } });
        });
        return () => { hidup = false; };
    }, [cabangId, versiDaftar]);
    const daftar: Load<Salesman[]> = cabangId === null
        ? (cek && cek.load.status === "galat" && !cek.load.data ? { status: "galat", error: `Cabang pelanggan order ini belum terbaca, jadi salesman cabangnya belum bisa dimuat. ${cek.load.error ?? ""}`.trim() } : { status: "memuat" })
        : daftarDibaca?.untuk === cabangId && daftarDibaca.versi === versiDaftar ? daftarDibaca.load : { status: "memuat" };
    const net = Number(order.result?.net ?? NaN);
    const tutupAlasan = daftar.status === "memuat" ? "Daftar salesman sedang dimuat"
        : daftar.status === "galat" ? "Daftar salesman gagal dimuat; tutup lalu coba lagi"
            : !salesman ? "Pilih salesman dulu"
                : cekKini.status === "memuat" ? "Pemeriksaan payload sedang berjalan"
                    : cekKini.status === "galat" ? "Payload faktur belum lulus pemeriksaan" : undefined;

    async function antrekan() {
        const j = await nextApi(`/api/orders/${encodeURIComponent(order.id)}/invoice`, { queue: true, salesman });
        // Putus / ≥ 502 / bukan JSON: baris antrean MUNGKIN sudah tertulis → halaman memuat ulang status antrean dan mengunci.
        if (tidakPasti(j)) { onSelesai({ jenis: "ragu" }); return; }
        if (!sukses(j)) {
            // 409 = keadaan di server berbeda dari yang dilihat layar (mis. order sudah diantrekan dari tab lain): baca ulang status.
            if (j.status === 409) onMuatUlang?.();
            throw new Error(pesanJawaban(j, "Order tidak diantrekan."));
        }
        if (j.data.queued === false && j.data.posted) { onSelesai({ jenis: "terposting", pesan: String(j.data.pesan ?? "Faktur order ini sudah ada di Accurate.") }); return; }
        onSelesai({ jenis: "antre" });
    }

    return (
        <ConfirmDialog open onClose={onClose} tag="Order Masuk · Antrean Faktur" title={`Antrekan faktur untuk ${nomorOrder(order.id)}?`}
            description="Faktur belum dibuat. Fakturist mengirimnya dari Antrean Faktur; sebelum dikirim barisnya masih bisa dibuang di sana."
            facts={[
                ["Pelanggan", `${order.outlet} · ${order.customer_no}`],
                ["Cabang", terakhir?.branch?.branchName ? `${terakhir.branch.branchName} · seri faktur cabang ini` : cekKini.status === "memuat" ? "memeriksa…" : "—"],
                ["Tanggal faktur", `${tanggalPendek(order.order_date)} (tanggal order; bisa diganti saat Kirim)`],
                ["Nilai", Number.isFinite(net) ? `Netto ${rupiah(net)} + PPN 11% = ${rupiah(Math.round(net * (1 + PPN)))} (estimasi)` : "—"],
                ["Harga", hargaBeda === null ? "harga master tidak terbaca" : hargaBeda === 0 ? "sama dengan master" : `${hargaBeda} barang beda dari master — tetap diantrekan hari ini`],
                ["Salesman", cekKini.status === "siap" && cekKini.data?.salesman ? `${cekKini.data.salesman.number} · ${cekKini.data.salesman.name} — di setiap baris faktur` : salesman ? "memeriksa…" : "belum dipilih"],
            ]}
            confirmLabel="Antrekan" confirmDisabled={tutupAlasan} onConfirm={antrekan}>
            <FormField label="Salesman" required help={`${cabangNama ? `Hanya salesman cabang ${cabangNama} (cabang pelanggan order ini). ` : ""}Satu salesman untuk seluruh order, disalin ke setiap baris faktur (Accurate menyimpan sales per baris).`}>
                {(a) => daftar.status === "memuat" ? <Skeleton rows={1} label="Memuat daftar salesman" /> : (
                    <select {...a} className="fi-input" value={salesman} disabled={daftar.status !== "siap"} onChange={(e) => setSalesman(e.target.value)}>
                        <option value="">Pilih salesman</option>
                        {(daftar.data ?? []).map((s) => <option key={s.number} value={s.number}>{s.number} · {s.name}</option>)}
                    </select>
                )}
            </FormField>
            {daftar.status === "galat" && <MessageStrip tone="neg" title="Daftar salesman gagal dimuat.">{daftar.error}{" "}{cabangId !== null && <Button variant="tertiary" onClick={() => setVersiDaftar((v) => v + 1)}>Coba lagi</Button>}</MessageStrip>}
            {daftar.status === "siap" && (daftar.data ?? []).length === 0 && (
                <MessageStrip tone="warn" title={cabangNama ? `Belum ada salesman aktif di cabang ${cabangNama}.` : "Belum ada salesman aktif di cabang pelanggan."}>
                    Faktur order ini harus memakai salesman cabang pelanggan. Tambahkan atau aktifkan karyawan salesman cabang itu di Accurate, lalu sinkronkan master pegawai.
                </MessageStrip>
            )}
            {cekKini.status === "galat" && (cek?.kode
                ? <MessageStrip tone="neg" title="Salesman ini ditolak server.">{cekKini.error}</MessageStrip>
                : <MessageStrip tone="neg" title="Payload faktur belum lulus pemeriksaan.">{cekKini.error}</MessageStrip>)}
            {hargaBeda !== null && hargaBeda > 0 && <VariantNote bl="BL-19">Harga beda master belum menahan antrean. Usulan: ditahan di sini sampai ditinjau.</VariantNote>}
            <VariantNote bl="BL-23">Limit kredit dan stok belum diperiksa sebelum antre; penolakannya baru ketahuan saat Kirim. Usulan: peringatan di dialog ini, tidak memblokir.</VariantNote>
            {terakhir && (
                <details className="fi-small">
                    <summary>Lihat payload teknis</summary>
                    <pre className="fi-mono" style={{ maxHeight: "16rem", overflow: "auto", whiteSpace: "pre", maxWidth: "100%" }}>{JSON.stringify(terakhir.payload, null, 2)}</pre>
                </details>
            )}
        </ConfirmDialog>
    );
}
