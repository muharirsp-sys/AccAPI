/*
 * Tujuan: Potongan layar Supervisor Review yang dipakai tabel desktop dan kartu ponsel: label status, tombol WhatsApp, kepala salesman,
 *   dan rincian kunjungan salesman terpilih (tabel di desktop, daftar kartu di ponsel) + subtotal.
 * Caller: ./SupervisorReview.tsx.
 * Dependensi: components/fiori/core, lib/supervisor-review/kontrak (JARAK_JAUH_M), ./bersama, ../form-kontrol/shared (jamWita WITA).
 * Main Functions: LabelStatus, Wa, KepalaSalesman, DaftarKunjungan.
 * Side Effects: Tidak ada (tautan WhatsApp dibuka pengguna di tab baru).
 */
"use client";

import type { Ref } from "react";
import { MessageCircle } from "lucide-react";
import { Button, EmptyState, StatusBadge } from "@/components/fiori/core";
import { JARAK_JAUH_M, type BarisSalesman, type Kunjungan } from "@/lib/supervisor-review/kontrak";
import { jamWita } from "../form-kontrol/shared";
import { angka, namaBaris, rp, STATUS, TANPA_HP } from "./bersama";

export function LabelStatus({ status }: { status: BarisSalesman["status"] }) {
    const s = STATUS[status];
    return <span className="whitespace-nowrap"><span aria-hidden>{s.ikon}</span> {s.label}</span>;
}

/** Tautan wa.me (tab baru); tanpa nomor = tombol nonaktif berpetunjuk (`petunjuk` = petunjuk juga TERLIHAT, bukan hanya title). Baris "Tanpa salesman terpetakan" tak punya tombol. */
export function Wa({ b, petunjuk }: { b: BarisSalesman; petunjuk?: boolean }) {
    if (b.salesCode === "") return <span className="fi-subtle" aria-hidden>—</span>;
    const label = `WhatsApp ke ${namaBaris(b)}`;
    if (b.waUrl) return <a className="fi-btn fi-btn--secondary" href={b.waUrl} target="_blank" rel="noopener noreferrer" aria-label={label}><MessageCircle className="fi-icon" aria-hidden />WhatsApp</a>;
    return (
        <>
            <Button icon={<MessageCircle className="fi-icon" aria-hidden />} disabled disabledReason={TANPA_HP} aria-label={label}>WhatsApp</Button>
            {petunjuk && <span className="fi-small fi-why">{TANPA_HP}</span>}
        </>
    );
}

/** `judulRef` (opsional): pemanggil memfokuskan judul saat rincian dibuka (ponsel: pembaca layar + gulir ke atas). */
export function KepalaSalesman({ b, judulRef }: { b: BarisSalesman; judulRef?: Ref<HTMLHeadingElement> }) {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3">
            <h2 ref={judulRef} tabIndex={-1} style={{ font: "inherit", fontWeight: 700 }}>{namaBaris(b)}</h2>
            <LabelStatus status={b.status} />
            <span style={{ flex: 1 }} />
            <Wa b={b} petunjuk />
        </div>
    );
}

const jumlah = (rows: Kunjungan[], f: (k: Kunjungan) => number | null) => rows.reduce((a, k) => a + (f(k) ?? 0), 0);
const strip = (v: number | null, fmt: (n: number) => string = angka) => (v === null ? "—" : fmt(v));

function LabelKunjungan({ k }: { k: Kunjungan }) {
    const m = k.jarakKeTokoM;
    const jauh = m !== null && m > JARAK_JAUH_M;
    // Jarak tak boleh hilang diam-diam: ada jarak = "N m"; titik check-in ada tetapi toko tanpa koordinat; check-in tanpa GPS sama sekali.
    const tanpaKoordinat = k.lat !== null && m === null;
    const tanpaGps = k.jenis !== "tanpa_checkin" && k.lat === null;
    if (k.jenis === "rute" && !k.belumDifakturkan && m === null && !tanpaKoordinat && !tanpaGps) return null;
    return (
        <span className="mt-1 flex flex-wrap items-center gap-1">
            {k.jenis === "tanpa_checkin" && <StatusBadge tone="neu">tanpa check-in</StatusBadge>}
            {k.jenis === "luar_rute" && <StatusBadge tone="info">luar rute</StatusBadge>}
            {k.belumDifakturkan && <StatusBadge tone="warn">belum difakturkan</StatusBadge>}
            {jauh && <StatusBadge tone="warn">jauh dari toko ({angka(m)} m)</StatusBadge>}
            {m !== null && !jauh && <span className="fi-small fi-subtle">{angka(m)} m dari toko</span>}
            {tanpaKoordinat && <StatusBadge tone="neu">toko tanpa koordinat</StatusBadge>}
            {tanpaGps && <StatusBadge tone="neu">tanpa GPS</StatusBadge>}
        </span>
    );
}

const Toko = ({ k }: { k: Kunjungan }) => <><b className="fi-small">{k.namaToko}</b><span className="fi-codes">{k.custCode}</span><LabelKunjungan k={k} /></>;
const Ec = ({ k }: { k: Kunjungan }) => (k.ec ? <span role="img" aria-label="EC">✓</span> : <span className="fi-subtle">—</span>);

/** Rincian kunjungan satu salesman: tabel (desktop) atau kartu (ponsel) + subtotal. `rows` sudah disaring per salesCode. */
export function DaftarKunjungan({ rows, kartu }: { rows: Kunjungan[]; kartu: boolean }) {
    if (rows.length === 0) return <EmptyState title="Belum ada kunjungan" message="Salesman ini belum check-in dan tidak punya faktur pada tanggal ini." />;
    const sub: [string, string][] = [
        ["Kunjungan", angka(rows.length)],
        ["Menit di toko", angka(jumlah(rows, (k) => k.menitDiToko))],
        ["Waktu tempuh (mnt)", angka(jumlah(rows, (k) => k.menitTempuh))],
        ["Qty", angka(jumlah(rows, (k) => k.qty), 2)],
        ["Item", angka(jumlah(rows, (k) => k.item))],
        ["EC", angka(rows.filter((k) => k.ec).length)],
        ["Nilai", rp(jumlah(rows, (k) => k.nilai))],
    ];
    const kunci = (k: Kunjungan, i: number) => `${k.custCode}-${k.mulai ?? "x"}-${i}`;
    return (
        <>
            {kartu ? (
                <ul aria-label="Kunjungan" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {rows.map((k, i) => (
                        <li key={kunci(k, i)} className="fi-li" style={{ cursor: "default" }}>
                            <span className="fi-li-r1"><span><Toko k={k} /></span><Ec k={k} /></span>
                            <span className="fi-li-r3">
                                <span>{jamWita(k.mulai)}–{jamWita(k.selesai)} · {strip(k.menitDiToko)} mnt di toko · tempuh {strip(k.menitTempuh)} mnt</span>
                                <span>Qty {strip(k.qty, (n) => angka(n, 2))} · Item {strip(k.item)}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="fi-tablescroll">
                    <table className="fi-table">
                        <caption className="sr-only">Rincian kunjungan</caption>
                        <thead>
                            <tr>
                                <th scope="col">Toko</th><th scope="col">Mulai</th><th scope="col">Selesai</th>
                                <th scope="col" className="fi-end">Menit di toko</th><th scope="col" className="fi-end">Waktu tempuh (mnt)</th>
                                <th scope="col" className="fi-end">Qty</th><th scope="col" className="fi-end">Item</th><th scope="col">EC</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((k, i) => (
                                <tr key={kunci(k, i)}>
                                    <td><Toko k={k} /></td>
                                    <td className="fi-tnum">{jamWita(k.mulai)}</td><td className="fi-tnum">{jamWita(k.selesai)}</td>
                                    <td className="fi-end">{strip(k.menitDiToko)}</td><td className="fi-end">{strip(k.menitTempuh)}</td>
                                    <td className="fi-end">{strip(k.qty, (n) => angka(n, 2))}</td><td className="fi-end">{strip(k.item)}</td>
                                    <td><Ec k={k} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <div role="group" aria-label="Subtotal kunjungan" className="px-4 py-3">
                <dl className="fi-attrs">{sub.map(([t, v]) => <div key={t}><dt>{t}</dt><dd>{v}</dd></div>)}</dl>
            </div>
        </>
    );
}
