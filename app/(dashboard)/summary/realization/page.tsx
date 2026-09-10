/** Tujuan: Lihat rencana potongan dan benefit yang terverifikasi pada faktur Accurate.
 * Caller: Summary/settings. Dependensi: API summary/realization, sesi dashboard.
 * Main Functions: RealizationPage, load, verify. Side Effects: HTTP baca/verifikasi; unduh CSV.
 */
"use client";
import { useState } from "react";
import Link from "next/link";
import type { Realization } from "@/lib/program-realization";
type Row = { orderId: string; customer: string; date: string; state: string; invoiceId: string; invoiceNumber: string;
    plannedDiscount: string | null; plannedPrograms: { name: string; discount: string }[]; realization: Realization | null; checkedAt: string | null };
const rp = (n: string | number | null) => n === null ? "Belum tersedia" : new Intl.NumberFormat("id-ID", { style:"currency", currency:"IDR", maximumFractionDigits:2 }).format(Number(n));
export default function RealizationPage() {
    const today = new Date().toLocaleDateString("en-CA"), [from,setFrom] = useState(today.slice(0,7)+"-01"), [to,setTo] = useState(today);
    const [rows,setRows] = useState<Row[]>([]), [next,setNext] = useState<{afterDate:string;afterId:string}|null>(null);
    const [busy,setBusy] = useState(false), [message,setMessage] = useState("Pilih periode lalu tampilkan laporan.");
    async function load(append = false) {
        setBusy(true);
        try {
            const q = new URLSearchParams({from,to,...(append && next ? next : {})});
            const r = await fetch(`/api/summary/realization?${q}`,{cache:"no-store"}), b = await r.json();
            if (!r.ok) throw new Error(b.error);
            setRows(old=>append?[...old,...b.rows]:b.rows);setNext(b.next);setMessage(b.rows.length?"":"Belum ada order yang masuk antrean faktur pada periode ini.");
        } catch(e) { setMessage(e instanceof Error?e.message:"Laporan gagal dibaca"); }
        finally {setBusy(false);}
    }
    async function verify(id:string) {
        setBusy(true);
        try {
            const r = await fetch("/api/summary/realization",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:id})}), b=await r.json();
            if (!r.ok) throw new Error(b.error);
            setRows(old=>old.map(row=>row.orderId===id?{...row,realization:b.realization,checkedAt:new Date().toISOString()}:row));setMessage(b.realization?.reason || "Selesai diperiksa");
        } catch(e) {setMessage(e instanceof Error?e.message:"Pemeriksaan gagal");}
        finally {setBusy(false);}
    }
    const totals = new Map<string,{name:string;discount:number;bonus:string[]}>();
    for (const row of rows) if(row.realization?.status==="verified") for(const p of row.realization.programs) {
        const old=totals.get(p.id)||{name:p.name,discount:0,bonus:[]};old.discount+=p.discount;
        old.bonus.push(...row.realization.bonuses.filter(b=>b.programId===p.id).map(b=>`${b.code}: ${b.quantity} ${b.unit}`));totals.set(p.id,old);
    }
    function download() {
        const cell=(x:unknown)=>`"${String(x??"").replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
        const table=[["Order","Pelanggan","Tanggal","Faktur","Status","Rencana diskon","Realisasi diskon sebelum retur","Diperiksa"],...rows.map(r=>[r.orderId,r.customer,r.date,r.invoiceNumber,r.realization?.status||r.state,r.plannedDiscount,r.realization?.discount,r.checkedAt])];
        const url=URL.createObjectURL(new Blob(["\ufeff"+table.map(r=>r.map(cell).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"}));
        const a=document.createElement("a");a.href=url;a.download=`Realisasi Program ${from} ${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    return <main className="mx-auto max-w-7xl space-y-5 p-5">
        <Link href="/summary/settings" className="underline">Pengaturan program</Link>
        <h1 className="text-2xl font-semibold">Realisasi program</h1>
        <p className="text-sm">Rencana berasal dari order. Realisasi diakui setelah isi faktur Accurate cocok. Angka ditampilkan sebelum retur; biaya barang bonus belum dihitung.</p>
        <div className="flex flex-wrap items-end gap-3"><label>Dari<input aria-label="Dari tanggal" className="block rounded border p-2" type="date" value={from} onChange={e=>{setFrom(e.target.value);setRows([]);setNext(null);}} /></label>
        <label>Sampai<input aria-label="Sampai tanggal" className="block rounded border p-2" type="date" value={to} onChange={e=>{setTo(e.target.value);setRows([]);setNext(null);}} /></label>
        <button disabled={busy} onClick={()=>load()} className="rounded bg-emerald-700 px-4 py-2 text-white">Tampilkan</button>
        <button disabled={busy||!rows.length||!!next} onClick={download} className="rounded border px-4 py-2">Unduh CSV</button></div>
        <p role="status" className="text-sm">{busy?"Memeriksa…":message}</p>
        <p className="text-sm">{rows.length} order dimuat{next?" — muat halaman berikutnya untuk total lengkap":""}. Pemeriksaan ulang membaca Accurate dan tidak mengirim faktur.</p>
        {totals.size>0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-3 text-left">Program</th><th className="p-3 text-left">Potongan terverifikasi</th><th className="p-3 text-left">Barang bonus</th></tr></thead>
        <tbody>{[...totals].map(([id,p])=><tr key={id} className="border-t"><td className="p-3">{p.name}</td><td className="p-3">{rp(p.discount)}</td><td className="p-3">{p.bonus.join("; ")||"—"}</td></tr>)}</tbody></table></div>}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{["Order / pelanggan","Faktur","Rencana","Realisasi","Pemeriksaan"].map(t=><th key={t} className="p-3 text-left">{t}</th>)}</tr></thead>
        <tbody>{rows.map(r=><tr key={r.orderId} className="border-t align-top"><td className="p-3">{r.customer}<div>{r.date}</div><div className="text-xs">{r.orderId}</div></td>
        <td className="p-3">{r.invoiceNumber?<Link className="underline" href={`/faktur/${encodeURIComponent(r.invoiceId)}`}>{r.invoiceNumber}</Link>:"Belum terbit"}<div>{r.state}</div></td>
        <td className="p-3">{rp(r.plannedDiscount)}<div className="text-xs">{r.plannedPrograms.map(p=>p.name).join("; ")}</div></td>
        <td className="p-3">{rp(r.realization?.discount??null)}<div>{r.realization?.reason||"Belum diperiksa"}</div></td>
        <td className="p-3">{r.checkedAt&&<div>{new Date(r.checkedAt).toLocaleString("id-ID")}</div>}<button disabled={busy||r.state!=="posted"} onClick={()=>verify(r.orderId)} className="mt-2 rounded border px-3 py-2 disabled:opacity-40">Periksa Accurate</button></td></tr>)}</tbody></table></div>
        {next&&<button disabled={busy} onClick={()=>load(true)} className="rounded border px-4 py-2">Muat berikutnya</button>}
    </main>;
}
