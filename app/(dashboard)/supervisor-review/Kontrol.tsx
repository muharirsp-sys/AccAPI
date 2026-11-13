/*
 * Tujuan: Panel "Kontrol bulan ini" Supervisor Review (owner 13 Nov 2026): per salesman dalam cakupan + saringan, tanggal 1 s.d. tanggal tampilan —
 *   ORDER Form Kontrol vs faktur Accurate (dua tipe sales: AccAPI batas 1 hari, sistem principal batas 3 hari), toko pindahan / outlet potensi /
 *   kelas A yang sudah order, target toko vs omzet faktur, penawaran item super + alasan teratas, toko berlokasi perkiraan. Order lewat batas tanpa
 *   faktur dirinci per salesman.
 * Caller: ./SupervisorReview.tsx.
 * Dependensi: GET /api/supervisor-review/kontrol (lib/supervisor-review/kontrol.ts BarisKontrol), ../form-kontrol/shared (ambilFk), components/fiori.
 * Main Functions: Kontrol (default). Side Effects: fetch GET.
 */
"use client";

import { useCallback } from "react";
import { ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { useLoad } from "@/components/fiori/interactive";
import { BATAS_FAKTUR_HARI, type BarisKontrol } from "@/lib/supervisor-review/kontrol";
import { ambilFk } from "../form-kontrol/shared";
import { angka, rp, tanggalPanjang } from "./bersama";

type Jawaban = { tanggal: string; dari: string; salesman: BarisKontrol[]; pesan?: { kode: string; teks: string } };
const TIPE = { accapi: "Input AccAPI", principal: "Input sistem principal" } as const;
const persen = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

export default function Kontrol({ tanggal, cabang, principle }: { tanggal: string; cabang: string; principle: string }) {
    const [load, muatUlang] = useLoad(useCallback(() => {
        const p = new URLSearchParams({ tanggal });
        if (cabang) p.set("cabang", cabang);
        if (principle) p.set("principle", principle);
        return ambilFk(`/api/supervisor-review/kontrol?${p}`, (j) => j as unknown as Jawaban, "Kontrol bulan ini belum berhasil dimuat.");
    }, [tanggal, cabang, principle]), { pertahankan: true });
    const d = load.data;
    const rows = Array.isArray(d?.salesman) ? d!.salesman : [];
    const terlambat = rows.filter((r) => r.orderTerlambat.length > 0);

    const kolom: Column<BarisKontrol>[] = [
        { key: "s", header: "Salesman", cell: (r) => <><b>{r.nama}</b><span className="fi-codes">{r.salesCode} · {r.cabang}</span>
            <StatusBadge tone={r.sumberOrder === "principal" ? "info" : "neu"}>{TIPE[r.sumberOrder]}</StatusBadge></> },
        { key: "o", header: "ORDER Form Kontrol → faktur", cell: (r) => <span className="grid gap-1">
            <span className="fi-tnum">{angka(r.order.berfaktur)} dari {angka(r.order.dilaporkan)} berfaktur</span>
            {r.order.terlambat > 0 && <StatusBadge tone="neg">{`${angka(r.order.terlambat)} lewat ${BATAS_FAKTUR_HARI[r.sumberOrder]} hari tanpa faktur`}</StatusBadge>}
            {r.order.menunggu > 0 && <span className="fi-small fi-muted">{angka(r.order.menunggu)} menunggu faktur</span>}</span> },
        { key: "p", header: "Toko pindahan sudah order", align: "end", cell: (r) => <span className="fi-tnum">{r.pindahan.total ? `${angka(r.pindahan.order)} / ${angka(r.pindahan.total)}` : "–"}</span> },
        { key: "pt", header: "Outlet potensi (dikunjungi · order)", align: "end", cell: (r) => <span className="fi-tnum">{r.potensi.total
            ? `${angka(r.potensi.dikunjungi)} · ${angka(r.potensi.order)} / ${angka(r.potensi.total)}` : "–"}</span> },
        { key: "a", header: "Kelas A sudah order", align: "end", cell: (r) => <span className="fi-tnum">{r.kelasA.total ? `${angka(r.kelasA.order)} / ${angka(r.kelasA.total)}` : "–"}</span> },
        { key: "t", header: "Omzet faktur vs target toko", align: "end", cell: (r) => <span className="fi-tnum">{r.target.target
            ? <>{rp(r.target.realisasi)} / {rp(r.target.target)}<span className="fi-codes">{persen(r.target.realisasi, r.target.target)}</span></> : "–"}</span> },
        { key: "i", header: "Item super (ditawarkan · dipesan)", cell: (r) => r.itemSuper.saran ? <span className="grid gap-1">
            <span className="fi-tnum">{angka(r.itemSuper.ditawarkan)} · {angka(r.itemSuper.dipesan)} dari {angka(r.itemSuper.saran)} saran
                ({persen(r.itemSuper.ditawarkan, r.itemSuper.saran)} ditawarkan)</span>
            {r.itemSuper.alasan.length > 0 && <span className="fi-small fi-muted">Alasan: {r.itemSuper.alasan.map((a) => `${a.label} (${a.jumlah})`).join("; ")}</span>}
        </span> : "–" },
        { key: "l", header: "Lokasi perkiraan", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{r.lokasiPerkiraan ? angka(r.lokasiPerkiraan) : "–"}</span> },
    ];

    return (
        <Section title="Kontrol bulan ini" subtitle={d ? `${tanggalPanjang(d.dari)} s.d. ${tanggalPanjang(d.tanggal)} · JKS, order, dan item super` : undefined}>
            <div className="grid gap-3 px-4 py-3">
                <p className="fi-small fi-muted">
                    Sales &quot;Input AccAPI&quot; mengorder lewat AccAPI: ORDER di Form Kontrol harus berfaktur paling lambat {BATAS_FAKTUR_HARI.accapi} hari. Sales
                    &quot;Input sistem principal&quot; mengorder di sistem principal: fakturnya masuk sesudah admin menarik laporan principal, batas {BATAS_FAKTUR_HARI.principal} hari.
                    Omzet faktur = total faktur termasuk PPN, dibandingkan dengan target toko dari JKS.
                </p>
                {d?.pesan && <MessageStrip tone="warn">{d.pesan.teks}</MessageStrip>}
                {load.status === "galat" && d && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">Yang tampil adalah hasil sebelumnya.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button></MessageStrip>
                )}
            </div>
            <ResponsiveTable title="Kontrol per salesman" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => r.salesCode}
                status={d ? (load.status === "galat" ? "siap" : load.status) : load.status} error={load.error} onRetry={muatUlang}
                empty={{ title: "Tidak ada salesman", message: d?.pesan?.teks ?? "Tidak ada salesman dalam cakupan dan saringan ini." }}
                mobileItem={(r) => <ListItem doc={r.nama} title={`ORDER berfaktur ${angka(r.order.berfaktur)}/${angka(r.order.dilaporkan)} · item super ditawarkan ${angka(r.itemSuper.ditawarkan)}/${angka(r.itemSuper.saran)}`}
                    amount={r.target.target ? persen(r.target.realisasi, r.target.target) : undefined}
                    meta={[TIPE[r.sumberOrder], r.order.terlambat ? `${angka(r.order.terlambat)} order tanpa faktur` : "",
                        r.pindahan.total ? `pindahan ${angka(r.pindahan.order)}/${angka(r.pindahan.total)}` : "",
                        r.potensi.total ? `potensi order ${angka(r.potensi.order)}/${angka(r.potensi.total)}` : "",
                        r.lokasiPerkiraan ? `${angka(r.lokasiPerkiraan)} lokasi perkiraan` : ""].filter(Boolean).join(" · ")} />} />
            {terlambat.length > 0 && (
                <details className="px-4 py-3">
                    <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" }}>
                        <b>ORDER lewat batas tanpa faktur ({angka(terlambat.reduce((n, r) => n + r.order.terlambat, 0))})</b>
                    </summary>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {terlambat.map((r) => (
                            <li key={r.salesCode} className="py-2">
                                <b className="fi-small">{r.nama} · {TIPE[r.sumberOrder]}</b>
                                <ul className="list-disc pl-5">
                                    {r.orderTerlambat.map((o) => (
                                        <li key={`${o.custCode}|${o.tanggal}`} className="fi-small">
                                            {tanggalPanjang(o.tanggal)} · {o.namaToko} ({o.custCode}){o.nomorOrder ? ` · no. order principal ${o.nomorOrder}` : ""}
                                        </li>
                                    ))}
                                    {r.order.terlambat > r.orderTerlambat.length && <li className="fi-small fi-muted">dan {angka(r.order.terlambat - r.orderTerlambat.length)} lainnya</li>}
                                </ul>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </Section>
    );
}
