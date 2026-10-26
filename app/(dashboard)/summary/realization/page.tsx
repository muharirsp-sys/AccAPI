/** Tujuan: Realisasi program (Fiori): rencana potongan dan benefit dari order lawan potongan yang terverifikasi pada faktur Accurate.
 * Caller: Pengaturan Summary (tautan Lihat realisasi order dan faktur). Dependensi: API summary/realization (GET daftar, POST periksa ulang), sesi dashboard, komponen Fiori, lib/tampil.
 * Main Functions: RealizationPage, load, verify, download (CSV), tautan faktur dengan database+ID.
 * Side Effects: HTTP baca/verifikasi (pemeriksaan ulang membaca Accurate dan tidak mengirim faktur); unduh CSV di peramban.
 */
"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column, type Tone } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import type { Realization } from "@/lib/program-realization";
import { KOSONG, hariIniWita, sebabHttp, tanggalWita, waktuWita } from "@/lib/tampil";
type Row = { orderId: string; customer: string; date: string; state: string; invoiceId: string; invoiceNumber: string;
    databaseId: string;
    plannedDiscount: string | null; plannedPrograms: { name: string; discount: string }[]; realization: Realization | null; checkedAt: string | null };
type Total = { id: string; name: string; discount: number; bonus: string[] };
type Pesan = { tone: "pos" | "warn" | "neg" | "info"; teks: string };
const rp = (n: string | number | null) => n === null ? "Belum tersedia" : new Intl.NumberFormat("id-ID", { style:"currency", currency:"IDR", maximumFractionDigits:2 }).format(Number(n));
// Status faktur di antrean (bukan kode mentah) dan hasil pemeriksaan: ikon + label + nada.
const STATUS_FAKTUR: Record<string, { label: string; tone: Tone }> = {
    queued: { label: "Antre", tone: "info" }, sending: { label: "Mengirim", tone: "neu" }, posted: { label: "Terposting", tone: "pos" },
    unknown: { label: "Tidak pasti", tone: "warn" }, rejected: { label: "Ditolak", tone: "neg" },
};
const statusFaktur = (state: string) => STATUS_FAKTUR[state] ?? { label: "Status tidak dikenal", tone: "neu" as Tone };
const STATUS_REALISASI: Record<Realization["status"], { label: string; tone: Tone }> = {
    verified: { label: "Cocok dengan faktur", tone: "pos" }, mismatch: { label: "Tidak cocok", tone: "warn" }, unavailable: { label: "Belum tersedia", tone: "neu" },
};
export default function RealizationPage() {
    const [from,setFrom] = useState(() => hariIniWita().slice(0,7)+"-01"), [to,setTo] = useState(() => hariIniWita());
    const [rows,setRows] = useState<Row[]>([]), [next,setNext] = useState<{afterDate:string;afterId:string}|null>(null);
    const [busy,setBusy] = useState(false), [pesan,setPesan] = useState<Pesan | null>({ tone: "info", teks: "Pilih periode lalu tampilkan laporan." });
    const [galatMuat,setGalatMuat] = useState<string | null>(null), [sudahMuat,setSudahMuat] = useState(false);
    async function load(append = false) {
        setBusy(true);setGalatMuat(null);
        try {
            const q = new URLSearchParams({from,to,...(append && next ? next : {})});
            const r = await fetch(`/api/summary/realization?${q}`,{cache:"no-store"}).catch(() => { throw new Error(sebabHttp(0)); }), b = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(b.error || sebabHttp(r.status));
            setRows(old=>append?[...old,...b.rows]:b.rows);setNext(b.next);setSudahMuat(true);setPesan(null);
        } catch(e) { setGalatMuat(e instanceof Error?e.message:"Laporan gagal dibaca"); }
        finally {setBusy(false);}
    }
    async function verify(id:string) {
        setBusy(true);
        try {
            const r = await fetch("/api/summary/realization",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:id})}).catch(() => { throw new Error(sebabHttp(0)); }), b=await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(b.error || sebabHttp(r.status));
            setRows(old=>old.map(row=>row.orderId===id?{...row,realization:b.realization,checkedAt:new Date().toISOString()}:row));
            const st = b.realization?.status as Realization["status"] | undefined;
            setPesan({ tone: st === "verified" ? "pos" : st === "mismatch" ? "warn" : "info", teks: b.realization?.reason || "Selesai diperiksa" });
        } catch(e) {setPesan({ tone: "neg", teks: e instanceof Error?e.message:"Pemeriksaan gagal" });}
        finally {setBusy(false);}
    }
    const totals = new Map<string,{name:string;discount:number;bonus:string[]}>();
    for (const row of rows) if(row.realization?.status==="verified") for(const p of row.realization.programs) {
        const old=totals.get(p.id)||{name:p.name,discount:0,bonus:[]};old.discount+=p.discount;
        old.bonus.push(...row.realization.bonuses.filter(b=>b.programId===p.id).map(b=>`${b.code}: ${b.quantity} ${b.unit}`));totals.set(p.id,old);
    }
    const barisTotal: Total[] = [...totals].map(([id,p]) => ({ id, ...p }));
    function download() {
        const cell=(x:unknown)=>`"${String(x??"").replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
        const table=[["Order","Pelanggan","Tanggal","Faktur","Status","Rencana diskon","Realisasi diskon sebelum retur","Diperiksa"],...rows.map(r=>[r.orderId,r.customer,r.date,r.invoiceNumber,r.realization?.status||r.state,r.plannedDiscount,r.realization?.discount,r.checkedAt])];
        const url=URL.createObjectURL(new Blob(["﻿"+table.map(r=>r.map(cell).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"}));
        const a=document.createElement("a");a.href=url;a.download=`Realisasi Program ${from} ${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    const tombolPeriksa = (r: Row) => <Button variant="tertiary" disabled={busy||r.state!=="posted"} disabledReason={busy?undefined:"Faktur belum terposting"} aria-label={`Periksa ${r.orderId} di Accurate`} onClick={()=>verify(r.orderId)}>Periksa Accurate</Button>;
    const lencanaRealisasi = (r: Row) => { const s = r.realization ? STATUS_REALISASI[r.realization.status] : { label: "Belum diperiksa", tone: "neu" as Tone }; return <StatusBadge tone={s.tone} wrap>{s.label}</StatusBadge>; };
    const kolomTotal: Column<Total>[] = [
        { key: "program", header: "Program", cell: (p) => p.name },
        { key: "diskon", header: "Potongan terverifikasi", align: "end", cell: (p) => rp(p.discount) },
        { key: "bonus", header: "Barang bonus", cell: (p) => p.bonus.join("; ") || KOSONG },
    ];
    const kolom: Column<Row>[] = [
        { key: "order", header: "Order dan pelanggan", cell: (r) => <>{r.customer}<span className="fi-sub">{tanggalWita(r.date)}</span><span className="fi-codes">{r.orderId}</span></> },
        { key: "faktur", header: "Faktur", cell: (r) => <>{r.invoiceNumber?<Link href={`/faktur?invoiceId=${encodeURIComponent(r.invoiceId)}&databaseId=${encodeURIComponent(r.databaseId)}`}>{r.invoiceNumber}</Link>:"Belum terbit"}<span className="fi-sub">{statusFaktur(r.state).label}</span></> },
        { key: "rencana", header: "Rencana", align: "end", cell: (r) => <>{rp(r.plannedDiscount)}<span className="fi-sub">{r.plannedPrograms.map(p=>p.name).join("; ")}</span></> },
        { key: "realisasi", header: "Realisasi", cell: (r) => <><span className="fi-tnum">{rp(r.realization?.discount??null)}</span>{lencanaRealisasi(r)}<span className="fi-sub">{r.realization?.reason||"Belum diperiksa"}</span></> },
        { key: "periksa", header: "Pemeriksaan", cell: (r) => <>{r.checkedAt&&<span className="fi-small fi-tnum">{waktuWita(r.checkedAt)}</span>}{tombolPeriksa(r)}</> },
    ];
    return <FioriScope>
    <div className="fi-page">
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><Link href="/summary">Summary Promo</Link></li><li><span aria-current="page">Realisasi program</span></li></ol></nav>
            <div className="fi-page-bar">
                <h1>Realisasi program</h1>
                <span className="fi-spacer" />
                <Link href="/summary/settings" className="fi-btn fi-btn--tertiary"><ArrowLeft className="fi-icon" aria-hidden />Pengaturan Summary</Link>
            </div>
            <p>Rencana berasal dari order. Realisasi diakui setelah isi faktur Accurate cocok. Angka ditampilkan sebelum retur; biaya barang bonus belum dihitung.</p>
        </header>

        <Section title="Periode" subtitle="pemeriksaan ulang membaca Accurate dan tidak mengirim faktur">
            <div className="fi-sect-in">
                <div className="fi-formgrid">
                    <FormField label="Dari tanggal">{(a)=><input {...a} className="fi-input" type="date" value={from} onChange={e=>{setFrom(e.target.value);setRows([]);setNext(null);setSudahMuat(false);}} />}</FormField>
                    <FormField label="Sampai tanggal">{(a)=><input {...a} className="fi-input" type="date" value={to} onChange={e=>{setTo(e.target.value);setRows([]);setNext(null);setSudahMuat(false);}} />}</FormField>
                </div>
                <div className="fi-btnrow">
                    <Button variant="primary" busy={busy} onClick={()=>load()}>Tampilkan</Button>
                    <Button icon={<Download className="fi-icon" aria-hidden />} disabled={busy||!rows.length||!!next} disabledReason={busy?undefined:!rows.length?"Tampilkan laporan dulu":"Muat semua halaman dulu supaya total lengkap"} onClick={download}>Unduh CSV</Button>
                </div>
            </div>
        </Section>

        {pesan&&<MessageStrip tone={pesan.tone} title={pesan.teks} onClose={()=>setPesan(null)} />}
        {galatMuat&&rows.length>0&&<MessageStrip tone="neg" title="Laporan gagal dimuat ulang. Yang tampil adalah hasil sebelumnya.">{galatMuat}</MessageStrip>}
        {sudahMuat&&<p className="fi-small fi-muted" role="status">{rows.length} order dimuat{next?". Muat halaman berikutnya untuk total lengkap.":"."}</p>}

        {barisTotal.length>0 && <Section title="Total per program" subtitle="hanya order yang sudah diperiksa dan cocok">
            <ResponsiveTable<Total> title="Total per program" columns={kolomTotal} rows={barisTotal} rowKey={(p)=>p.id} empty={{title:"Belum ada total"}}
                mobileItem={(p)=><ListItem doc={p.name} amount={rp(p.discount)} meta={p.bonus.join("; ")||undefined} />} />
        </Section>}

        {(sudahMuat || busy || galatMuat) && <Section title="Order dan faktur" subtitle={sudahMuat?`${rows.length} order`:undefined}>
            <ResponsiveTable<Row> title="Order dan faktur" columns={kolom} rows={rows} rowKey={(r)=>r.orderId} status={busy&&!rows.length?"memuat":galatMuat?"galat":"siap"} error={galatMuat??undefined} onRetry={()=>void load()}
                empty={{title:"Belum ada order di periode ini",message:"Belum ada order yang masuk antrean faktur pada periode ini."}}
                mobileItem={(r)=><ListItem doc={r.orderId} amount={rp(r.realization?.discount??null)} title={r.customer} meta={`${tanggalWita(r.date)} · ${r.invoiceNumber||"Belum terbit"} · ${statusFaktur(r.state).label}`}
                    badge={<span className="fi-btnrow">{lencanaRealisasi(r)}{tombolPeriksa(r)}</span>} />} />
        </Section>}
        {next&&<div className="fi-btnrow"><Button disabled={busy} onClick={()=>load(true)}>Muat berikutnya</Button></div>}
    </div>
    </FioriScope>;
}
