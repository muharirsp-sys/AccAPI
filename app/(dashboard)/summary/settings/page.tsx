/** Tujuan: Koreksi detail program, tier, SKU dan syarat outlet dari paket Summary.
 * Caller: halaman Summary. Dependensi: /summary/review, auth/CSRF, resolveApiBase.
 * Main Functions: SettingsPage, request, save, publish, download; ringkasan singkat dan detail terpisah.
 * Side Effects: HTTP impor/koreksi/publikasi eksplisit dan unduh paket lokal.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { resolveApiBase } from "@/lib/apiBase";

type Tier = Record<string, string | number | boolean | null>;
type Settings = Record<string, string | number | boolean | null | string[] | number[] | Tier[]>;
type Detail = {
  row_id: string; document_id: string; principal: string; nama_program: string;
  variant_barang: string; benefit: string; ketentuan_pengambilan: string;
  start: string | null; end: string | null; kode_barang: string[]; conditions: string[];
  warnings: string[]; settings: Settings; correction: string; publication?: {draft_id:string;revision:number};
};
type Brief = {summary_id:string;principal:string;kelompok:string;channel:string;ketentuan:string;benefit:string;detail_ids:string[]};
type Package = { id: string; title: string; revision: number; content: {
  details: Detail[]; summary: Brief[]; master: Record<string, {name: string}>; [key: string]: unknown;
}};
type ListEntry = Pick<Package, "id" | "title" | "revision">;
const base = resolveApiBase();
const input = "w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
const button = "rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

async function request(url: string, method = "GET", payload?: unknown) {
  const headers: Record<string,string> = { "Content-Type": "application/json" };
  if (method !== "GET") {
    const me = await fetch(`${base}/api/me`, { credentials: "include" });
    const auth = await me.json();
    if (!me.ok) throw new Error("Sesi berakhir. Silakan login kembali.");
    if (auth.csrf_token) headers["X-CSRF-Token"] = auth.csrf_token;
  }
  const response = await fetch(`${base}/summary/review${url}`, {
    method, headers, credentials: "include", body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || "Permintaan gagal");
  return result;
}

export default function SettingsPage() {
  const [list,setList] = useState<ListEntry[]>([]);
  const [pack,setPack] = useState<Package | null>(null);
  const [detail,setDetail] = useState<Detail | null>(null);
  const [search,setSearch] = useState("");
  const [busy,setBusy] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [message,setMessage] = useState("");
  const [file,setFile] = useState<File | null>(null);
  const [reviewed,setReviewed] = useState(false);
  const [issues,setIssues] = useState<string[]>([]);
  useEffect(() => { request("").then(r=>setList(r.packages)).catch(e=>setMessage(e.message)); },[]);

  function receive(value: Package, selected?: string) {
    setPack(value);setDirty(false);setReviewed(false);setIssues([]);
    const first = selected || value.content.summary[0]?.detail_ids[0];
    setDetail(structuredClone(value.content.details.find(r=>r.row_id===first) || value.content.details[0]));
    setList(old=>[{id:value.id,title:value.title,revision:value.revision},...old.filter(r=>r.id!==value.id)]);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);setMessage("");
    try { await action(); } catch(error) { setMessage(error instanceof Error?error.message:"Terjadi kesalahan"); }
    finally { setBusy(false); }
  }
  const update = (key: string, value: Settings[string]) => {
    if (!detail) return;
    setDetail({...detail,settings:{...detail.settings,[key]:value}});setDirty(true);
  };
  async function save() {
    if (!pack || !detail) return;
    const {start,end,kode_barang,settings,correction} = detail;
    const r=await request(`/${pack.id}/details/${detail.row_id}`,"PUT",{
      revision:pack.revision,patch:{start,end,kode_barang,settings,correction},
    });
    receive(r.package,detail.row_id);setMessage("Koreksi tersimpan. Program tetap draft.");
  }
  function download() {
    if (!pack) return;
    const a=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(pack.content,null,2)],{type:"application/json"}));
    a.href=url;a.download="Detail Pengaturan Program - Koreksi.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const filtered=pack?.content.details.filter(r=>`${r.row_id} ${r.document_id} ${r.principal} ${r.nama_program} ${r.variant_barang}`.toLowerCase().includes(search.toLowerCase())) || [];
  const numericFields=[['minimum','Minimum pembelian'],['amount','Nilai benefit'],['max_per_invoice','Maksimum per faktur']] as const;
  const texts=[['unit','Satuan pembelian'],['benefit_unit','Satuan benefit'],['max_per_period','Batas per periode'],['price_basis','Dasar harga'],['bonus_selection','Pemilihan barang bonus']] as const;
  const selects: [string,string,string[]][] = [
    ['threshold_metric','Ambang berdasarkan',['quantity','value','assigned_grade','fixed_basket']],
    ['aggregation','Akumulasi',['invoice','calendar_month','first_order_in_month']],
    ['mix_scope','Cakupan mix',['unspecified','same_sku','same_master_group_and_size','same_product_family','Piattos_Poppins_King_HET2K','Cloud9_HET1K','Piattos_Medium_Big']],
    ['benefit_type','Jenis benefit',['unresolved','bonus','bonus_per_ctn','percentage','rupiah_per_unit','rupiah_per_invoice','package_price','net_price']],
    ['settlement','Cara penyelesaian',['on_invoice','rafaksi','choose_rafaksi_or_on_invoice']],
  ];
  const labels:Record<string,string>={quantity:'Kuantitas',value:'Nilai pembelian',assigned_grade:'Grade tetap',fixed_basket:'Komposisi paket',invoice:'Per faktur',calendar_month:'Kumulatif bulanan',first_order_in_month:'Order pertama bulan',unspecified:'Belum ditentukan',same_sku:'SKU sama',same_master_group_and_size:'Kelompok dan gramasi sama',same_product_family:'Keluarga produk sama',unresolved:'Perlu koreksi',bonus:'Bonus barang',bonus_per_ctn:'Bonus per karton',percentage:'Persen',rupiah_per_unit:'Rupiah per unit',rupiah_per_invoice:'Rupiah per faktur',package_price:'Harga paket',net_price:'Harga nett',on_invoice:'On faktur',rafaksi:'Rafaksi',choose_rafaksi_or_on_invoice:'Pilih rafaksi atau on faktur'};

  return <main className="mx-auto max-w-7xl space-y-6 p-4 text-slate-900">
    <header><Link href="/summary" className="text-sm underline">Kembali ke Summary</Link>
      <h1 className="mt-3 text-2xl font-semibold">Detail pengaturan program</h1>
      <p className="mt-2 text-sm">Ringkasan untuk membaca program. Buka detail untuk mengatur dan menerbitkan aturan order.</p>
      <Link className="mt-2 inline-block underline" href="/summary/realization">Lihat realisasi order dan faktur</Link>
    </header>
    <section className="space-y-3 rounded border bg-white p-5">
      <h2 className="font-semibold">Buka paket hasil Summary</h2>
      <button className={button} disabled={busy||dirty} onClick={()=>void run(async()=>receive((await request('/reference/september','POST',{})).package))}>Buka program September 2026</button>
      <div className="flex flex-wrap gap-3">
        <label className="flex-1 text-sm">Paket tersimpan<select aria-label="Paket tersimpan" className={input} value={pack?.id||""} disabled={busy||dirty}
          onChange={e=>{if(e.target.value)void run(async()=>receive((await request(`/${e.target.value}`)).package));}}>
          <option value="">Pilih paket</option>{list.map(p=><option key={p.id} value={p.id}>{p.title} - revisi {p.revision}</option>)}</select></label>
        <label className="text-sm">File pengaturan<input className={input} type="file" accept=".json,application/json" disabled={busy||dirty} onChange={e=>setFile(e.target.files?.[0]||null)}/></label>
        <button className={button} disabled={!file||busy||dirty} onClick={()=>void run(async()=>{
          if(!file)return;if(file.size>8*1024*1024)throw new Error("File maksimal 8 MB");
          receive((await request('/import','POST',JSON.parse(await file.text()))).package);setMessage("Paket dibuka. Impor berulang tidak menggandakan paket yang sama.");
        })}>Impor paket</button>
      </div>
    </section>
    {message&&<p role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">{message}</p>}
    {pack&&<details open className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Ringkasan program ({pack.content.summary.length})</summary>
      <div className="mt-3 max-h-96 overflow-auto"><table className="w-full text-sm"><thead className="sticky top-0 bg-slate-100"><tr>{['Principal / Produk','Channel','Ketentuan','Benefit',''].map((h,i)=><th key={i} className="p-3 text-left">{h}</th>)}</tr></thead><tbody>
      {pack.content.summary.map(s=><tr key={s.summary_id} className="border-t"><td className="p-3">{s.principal}<div>{s.kelompok}</div></td><td className="p-3">{s.channel}</td><td className="p-3">{s.ketentuan}</td><td className="p-3 font-medium">{s.benefit}</td><td className="p-3"><button disabled={dirty||busy} className="underline" onClick={()=>{const d=pack.content.details.find(r=>r.row_id===s.detail_ids[0]);if(d){setDetail(structuredClone(d));setReviewed(false);setIssues([]);setSearch(d.document_id);document.getElementById('program-detail')?.scrollIntoView({behavior:'smooth'});}}}>Detail</button></td></tr>)}</tbody></table></div>
    </details>}
    {pack&&detail&&<div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
      <aside className="rounded border bg-white p-4">
        <label className="text-sm">Cari program<input className={input} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Principal, produk, atau ID"/></label>
        <p className="my-2 text-xs">{filtered.length} detail - revisi {pack.revision}</p>
        <div className="max-h-[70vh] overflow-y-auto">{filtered.map(r=><button disabled={busy||dirty} key={r.row_id}
          onClick={()=>{setDetail(structuredClone(r));setReviewed(false);setIssues([]);}} className={`mb-2 w-full rounded border p-3 text-left text-sm disabled:opacity-60 ${detail.row_id===r.row_id?'border-emerald-600 bg-emerald-50':''}`}>
          <strong>{r.row_id} - {r.principal}</strong><span className="mt-1 block">{r.variant_barang}</span></button>)}</div>
      </aside>
      <fieldset id="program-detail" disabled={busy||!!detail.publication} className="min-w-0 space-y-5 rounded border bg-white p-5">
        <header><h2 className="text-lg font-semibold">{detail.row_id} - {detail.variant_barang}</h2><p className="text-sm">{detail.nama_program} / {detail.document_id}</p></header>
        <div className="rounded bg-slate-50 p-3 text-sm"><p><strong>Ketentuan sumber:</strong> {detail.ketentuan_pengambilan}</p><p><strong>Benefit sumber:</strong> {detail.benefit}</p></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(['start','end'] as const).map(k=><label key={k} className="text-sm">{k==='start'?'Mulai':'Selesai'}<input className={input} type="date" value={detail[k]||""} onChange={e=>{setDetail({...detail,[k]:e.target.value||null});setDirty(true);}}/></label>)}
          {selects.map(([key,label,options])=><label key={key} className="text-sm">{label}<select className={input} value={String(detail.settings[key]||'')} onChange={e=>update(key,e.target.value)}>{[...new Set([String(detail.settings[key]||''),...options])].map(o=><option key={o} value={o}>{labels[o]||o||'Belum ditentukan'}</option>)}</select></label>)}
          {numericFields.map(([key,label])=><label key={key} className="text-sm">{label}<input className={input} type="number" min="0" step="any" value={detail.settings[key]===null?'':String(detail.settings[key]??'')} onChange={e=>update(key,e.target.value===''?null:Number(e.target.value))}/></label>)}
          {texts.map(([key,label])=><label key={key} className="text-sm">{label}<input className={input} value={String(detail.settings[key]??'')} onChange={e=>update(key,e.target.value||null)}/></label>)}
          <label className="text-sm">Kelipatan<select className={input} value={detail.settings.repeat===null?'':String(detail.settings.repeat)} onChange={e=>update('repeat',e.target.value===''?null:e.target.value==='true')}><option value="">Belum ditentukan</option><option value="true">Ya</option><option value="false">Tidak</option></select></label>
        </div>
        <p className="text-xs">Nilai persen ditulis sebagai angka persen, misalnya 5. Nilai yang kosong belum ditetapkan.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {([['outlet_codes','Kode outlet'],['include_tags','Peserta wajib'],['exclude_tags','Peserta dikecualikan'],['region','Wilayah'],['exclusive_with','Tidak boleh digabung dengan']] as const).map(([key,label])=><label key={key} className="text-sm">{label} (pisahkan koma)<input className={input} value={(detail.settings[key] as string[]||[]).join(', ')} onChange={e=>update(key,e.target.value.split(',').map(v=>v.trim()).filter(Boolean))}/></label>)}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {([['outlet_list_required','Wajib daftar outlet'],['history_required','Memerlukan riwayat pembelian']] as const).map(([key,label])=><label key={key} className="flex items-center gap-2"><input type="checkbox" checked={detail.settings[key]===true} onChange={e=>update(key,e.target.checked)}/>{label}</label>)}
        </div>
        <details><summary className="cursor-pointer font-medium">SKU terpilih ({detail.kode_barang.length})</summary>
          <label className="mt-3 block text-sm">Kode barang, pisahkan koma<textarea className={input} rows={3} value={detail.kode_barang.join(', ')} onChange={e=>{setDetail({...detail,kode_barang:e.target.value.split(',').map(v=>v.trim()).filter(Boolean)});setDirty(true);}}/></label>
          <ul className="max-h-56 overflow-y-auto text-sm">{detail.kode_barang.map(c=><li key={c}>{c} - {pack.content.master[c]?.name||'Kode belum dikenali'}</li>)}</ul>
        </details>
        {(detail.settings.tiers as Tier[]||[]).length>0&&<div className="overflow-x-auto"><h3 className="mb-2 font-medium">Strata</h3><table className="w-full text-sm"><thead><tr>{['Grade / batas sumber','Minimum','Maksimum','Nilai'].map(v=><th key={v} className="p-2 text-left">{v}</th>)}</tr></thead><tbody>
          {(detail.settings.tiers as Tier[]).map((t,i)=><tr key={i}><td className="p-2">{String(t.grade||t.label||i+1)}</td>{['minimum','maximum','amount'].map(k=><td key={k} className="p-2"><input aria-label={`Tier ${i+1} ${k}`} className={input} type="number" min="0" step="any" value={t[k]===null||t[k]===undefined?'':String(t[k])} onChange={e=>update('tiers',(detail.settings.tiers as Tier[]).map((a,j)=>j===i?{...a,[k]:e.target.value===''?null:Number(e.target.value)}:a))}/></td>)}</tr>)}</tbody></table></div>}
        {detail.settings.threshold_metric==='assigned_grade'&&<p className="text-sm">Grade ditetapkan berdasarkan riwayat oleh HO, bukan minimum faktur berjalan. Rentang historis tetap tersimpan dalam paket dan Excel.</p>}
        {Array.isArray(detail.settings.basket)&&<div><h3 className="font-medium">Komposisi paket wajib</h3><ul className="text-sm">{(detail.settings.basket as Tier[]).map((v,i)=><li key={i}>{String(v.quantity)} PCS - {String(v.product)}</li>)}</ul></div>}
        <div><h3 className="font-medium">Syarat dan hal yang perlu diperiksa</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{[...new Set([...detail.conditions,...detail.warnings])].map((v,i)=><li key={i}>{v}</li>)}</ul></div>
        <label className="block text-sm">Koreksi Anda<textarea className={input} rows={4} value={detail.correction||''} onChange={e=>{setDetail({...detail,correction:e.target.value});setDirty(true);}}/></label>
        <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={busy||!dirty} onClick={()=>void run(save)}>Simpan koreksi</button>
          <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={busy||!dirty} onClick={()=>receive(pack,detail.row_id)}>Batalkan perubahan</button>
          <button className="rounded border px-4 py-2 text-sm disabled:opacity-50" disabled={busy||dirty} onClick={download}>Unduh paket terkoreksi</button>
          {dirty&&<span className="text-sm">Simpan atau batalkan sebelum berpindah detail.</span>}</div>
        {detail.publication?<p className="text-sm">Sudah diterbitkan sebagai versi tetap untuk order. Penarikan tersedia di pustaka Summary.</p>:<div className="space-y-3 border-t pt-4">
          <button className="rounded border px-4 py-2 text-sm" disabled={busy||dirty} onClick={()=>void run(async()=>{const r=await request(`/${pack.id}/details/${detail.row_id}/readiness`);setIssues(r.issues);setMessage(r.issues.length?'Lengkapi hal berikut sebelum menerbitkan.':`${r.programs.length} aturan siap ditinjau dan diterbitkan.`);})}>Periksa kelengkapan aturan</button>
          {issues.length>0&&<ul className="list-disc pl-5 text-sm">{issues.map(v=><li key={v}>{v}</li>)}</ul>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>Saya sudah memeriksa sumber, SKU, benefit, dan semua ketentuan.</label>
          <button className={button} disabled={busy||dirty||!reviewed} onClick={()=>void run(async()=>{receive((await request(`/${pack.id}/details/${detail.row_id}/publish`,'POST',{revision:pack.revision,reviewed:true})).package,detail.row_id);setMessage('Aturan diterbitkan. Order berikutnya memakai versi ini.');})}>Terbitkan untuk order</button>
        </div>}
      </fieldset>
    </div>}
  </main>;
}
