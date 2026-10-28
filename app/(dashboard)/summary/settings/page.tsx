/** Tujuan: Pengaturan Summary (Fiori): koreksi detail program, strata, SKU, dan syarat outlet dari paket Summary, lalu terbitkan aturan untuk order lewat dialog.
 * Caller: halaman Summary (tombol Pengaturan Summary) dan halaman Realisasi program. Dependensi: FastAPI /summary/review (lib/apiBase, CSRF dari /api/me), komponen Fiori, lib/tampil.
 * Main Functions: SettingsPage, request, save, terbitkan, download; ringkasan singkat dan detail terpisah.
 * Side Effects: HTTP impor/koreksi/publikasi eksplisit dan unduh paket lokal.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, KeyValues, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { KOSONG, sebabHttp } from "@/lib/tampil";

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
type Pesan = { tone: "pos" | "warn" | "neg" | "info"; teks: string };
const base = resolveApiBase();

async function request(url: string, method = "GET", payload?: unknown) {
  const headers: Record<string,string> = { "Content-Type": "application/json" };
  if (method !== "GET") {
    const me = await fetch(`${base}/api/me`, { credentials: "include" }).catch(() => { throw new Error(sebabHttp(0)); });
    const auth = await me.json().catch(() => ({}));
    if (!me.ok) throw new Error("Sesi berakhir. Silakan login kembali.");
    if (auth.csrf_token) headers["X-CSRF-Token"] = auth.csrf_token;
  }
  const response = await fetch(`${base}/summary/review${url}`, {
    method, headers, credentials: "include", body: payload === undefined ? undefined : JSON.stringify(payload),
  }).catch(() => { throw new Error(sebabHttp(0)); });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.detail === "string" && result.detail ? result.detail : sebabHttp(response.status));
  return result;
}

/** Gulir halus hanya bila pengguna tidak meminta gerak berkurang. */
const keDetail = () => document.getElementById("program-detail")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

export default function SettingsPage() {
  const [list,setList] = useState<ListEntry[]>([]);
  const [daftarMuat,setDaftarMuat] = useState<"memuat" | "siap" | "galat">("memuat");
  const [pack,setPack] = useState<Package | null>(null);
  const [detail,setDetail] = useState<Detail | null>(null);
  const [search,setSearch] = useState("");
  const [busy,setBusy] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [pesan,setPesan] = useState<Pesan | null>(null);
  const [file,setFile] = useState<File | null>(null);
  const [reviewed,setReviewed] = useState(false);
  const [issues,setIssues] = useState<string[]>([]);
  const [aturanSiap,setAturanSiap] = useState<number | null>(null);
  const [dialogTerbit,setDialogTerbit] = useState(false);
  const ambilDaftar = useCallback(() => request("").then(r=>{setList(r.packages);setDaftarMuat("siap");}).catch(e=>{setDaftarMuat("galat");setPesan({tone:"neg",teks:e.message});}),[]);
  useEffect(() => { void ambilDaftar(); },[ambilDaftar]);

  function receive(value: Package, selected?: string) {
    setPack(value);setDirty(false);setReviewed(false);setIssues([]);setAturanSiap(null);
    const first = selected || value.content.summary[0]?.detail_ids[0];
    setDetail(structuredClone(value.content.details.find(r=>r.row_id===first) || value.content.details[0]));
    setList(old=>[{id:value.id,title:value.title,revision:value.revision},...old.filter(r=>r.id!==value.id)]);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);setPesan(null);
    try { await action(); } catch(error) { setPesan({tone:"neg",teks:error instanceof Error?error.message:"Terjadi kesalahan"}); }
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
    receive(r.package,detail.row_id);setPesan({tone:"pos",teks:"Koreksi tersimpan. Program tetap berstatus draf."});
  }
  async function terbitkan() {
    if (!pack || !detail) return;
    setBusy(true);
    try {
      receive((await request(`/${pack.id}/details/${detail.row_id}/publish`,'POST',{revision:pack.revision,reviewed:true})).package,detail.row_id);
      setDialogTerbit(false);setPesan({tone:"pos",teks:"Aturan diterbitkan. Order berikutnya memakai versi ini."});
    } finally { setBusy(false); }
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
  const labelStrata:Record<string,string>={minimum:'minimum',maximum:'maksimum',amount:'nilai'};
  const alasanBerpindah = busy ? undefined : dirty ? "Simpan atau batalkan perubahan dulu" : undefined;

  const kolomRingkasan: Column<Brief>[] = [
    { key: "program", header: "Principal dan produk", cell: (s) => <>{s.principal}<span className="fi-sub">{s.kelompok}</span></> },
    { key: "channel", header: "Channel", secondary: true, cell: (s) => s.channel },
    { key: "ketentuan", header: "Ketentuan", cell: (s) => s.ketentuan },
    { key: "benefit", header: "Benefit", cell: (s) => <b>{s.benefit}</b> },
    { key: "aksi", header: "Tindakan", cell: (s) => <Button variant="tertiary" disabled={dirty||busy} disabledReason={alasanBerpindah} aria-label={`Buka detail ${s.principal} ${s.kelompok}`} onClick={()=>bukaDetail(s)}>Buka detail</Button> },
  ];
  function bukaDetail(s: Brief) {
    if (!pack) return;
    const d=pack.content.details.find(r=>r.row_id===s.detail_ids[0]);
    if(d){setDetail(structuredClone(d));setReviewed(false);setIssues([]);setAturanSiap(null);setSearch(d.document_id);keDetail();}
  }

  return <FioriScope>
  <div className="fi-page">
    <header className="fi-page-head">
      <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><Link href="/summary">Summary Promo</Link></li><li><span aria-current="page">Pengaturan Summary</span></li></ol></nav>
      <div className="fi-page-bar">
        <h1>Pengaturan Summary</h1>
        <span className="fi-spacer" />
        <Link href="/summary" className="fi-btn fi-btn--tertiary"><ArrowLeft className="fi-icon" aria-hidden />Kembali ke Summary</Link>
        <Link href="/summary/realization" className="fi-btn fi-btn--secondary">Lihat realisasi order dan faktur</Link>
      </div>
      <p>Ringkasan untuk membaca program. Buka detail untuk mengatur dan menerbitkan aturan order.</p>
    </header>

    {pesan&&<MessageStrip tone={pesan.tone} title={pesan.teks} onClose={()=>setPesan(null)}>{daftarMuat==="galat"&&<Button variant="tertiary" onClick={()=>{setDaftarMuat("memuat");setPesan(null);void ambilDaftar();}}>Coba lagi</Button>}</MessageStrip>}

    <Section title="Buka paket hasil Summary" subtitle="pilih paket tersimpan, impor berkas pengaturan, atau buka paket rujukan">
      <div className="fi-sect-in">
        <div className="fi-formgrid">
          <FormField label="Paket tersimpan">{(a)=><select {...a} className="fi-input" value={pack?.id||""} disabled={busy||dirty||daftarMuat==="memuat"}
            onChange={e=>{if(e.target.value)void run(async()=>receive((await request(`/${e.target.value}`)).package));}}>
            <option value="">{daftarMuat==="memuat"?"Memuat paket...":"Pilih paket"}</option>{list.map(p=><option key={p.id} value={p.id}>{p.title}, revisi {p.revision}</option>)}</select>}</FormField>
          <FormField label="File pengaturan (JSON)">{(a)=><input {...a} className="fi-input" type="file" accept=".json,application/json" disabled={busy||dirty} onChange={e=>setFile(e.target.files?.[0]||null)}/>}</FormField>
        </div>
        <div className="fi-btnrow">
          <Button disabled={busy||dirty} disabledReason={alasanBerpindah} onClick={()=>void run(async()=>receive((await request('/reference/september','POST',{})).package))}>Buka paket rujukan September 2026</Button>
          <Button disabled={!file||busy||dirty} disabledReason={dirty?alasanBerpindah:"Pilih file pengaturan dulu"} onClick={()=>void run(async()=>{
            if(!file)return;if(file.size>8*1024*1024)throw new Error("File maksimal 8 MB");
            let isi: unknown;try{isi=JSON.parse(await file.text());}catch{throw new Error("Berkas bukan JSON yang valid.");}
            receive((await request('/import','POST',isi)).package);setPesan({tone:"pos",teks:"Paket dibuka. Impor berulang tidak menggandakan paket yang sama."});
          })}>Impor paket</Button>
        </div>
      </div>
    </Section>

    {pack&&<Section title="Ringkasan program" subtitle={`${pack.content.summary.length} program`}>
      <ResponsiveTable<Brief> title="Ringkasan program" columns={kolomRingkasan} rows={pack.content.summary} rowKey={(s)=>s.summary_id}
        empty={{title:"Paket ini belum punya ringkasan program"}}
        mobileItem={(s)=><ListItem doc={s.principal} title={s.ketentuan} meta={`${s.benefit} · ${s.kelompok} · ${s.channel}`} badge={<Button variant="tertiary" disabled={dirty||busy} disabledReason={alasanBerpindah} aria-label={`Buka detail ${s.principal} ${s.kelompok}`} onClick={()=>bukaDetail(s)}>Buka detail</Button>} />} />
    </Section>}

    {pack&&detail&&<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
      <Section title="Cari program" subtitle={`${filtered.length} detail, revisi ${pack.revision}`}>
        <div className="fi-sect-in">
          <FormField label="Cari program">{(a)=><input {...a} className="fi-input" type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Principal, produk, atau ID"/>}</FormField>
          {dirty&&<p className="fi-small fi-why">Simpan atau batalkan perubahan sebelum berpindah detail.</p>}
        </div>
        <ul className="fi-list" style={{display:"block",maxHeight:"70vh",overflowY:"auto"}} aria-label="Daftar detail program">{filtered.map(r=><li key={r.row_id}><button type="button" disabled={busy||dirty}
          onClick={()=>{setDetail(structuredClone(r));setReviewed(false);setIssues([]);setAturanSiap(null);}} className="fi-li" aria-current={detail.row_id===r.row_id?"true":undefined} style={busy||dirty?{opacity:.6,cursor:"not-allowed"}:undefined}>
          <span className="fi-li-r1"><span className="fi-li-doc">{r.row_id}</span></span><span className="fi-li-title">{r.variant_barang}</span><span className="fi-li-r3"><span>{r.principal}</span></span></button></li>)}</ul>
      </Section>
      <fieldset id="program-detail" disabled={busy||!!detail.publication} className="fi-sect" style={{border:0,margin:0,padding:0,minInlineSize:0}}>
        <legend className="sr-only">{`Detail program ${detail.row_id}`}</legend>
        <header><h2>{detail.row_id}, {detail.variant_barang}</h2><span>{detail.nama_program} / {detail.document_id}</span>{detail.publication&&<StatusBadge tone="pos">Sudah diterbitkan</StatusBadge>}</header>
        <div className="fi-sect-in">
        <KeyValues align="start" items={[["Ketentuan sumber",detail.ketentuan_pengambilan||KOSONG],["Benefit sumber",detail.benefit||KOSONG]]} />
        <div className="fi-formgrid">
          {(['start','end'] as const).map(k=><FormField key={k} label={k==='start'?'Mulai':'Selesai'}>{(a)=><input {...a} className="fi-input" type="date" value={detail[k]||""} onChange={e=>{setDetail({...detail,[k]:e.target.value||null});setDirty(true);}}/>}</FormField>)}
          {selects.map(([key,label,options])=><FormField key={key} label={label}>{(a)=><select {...a} className="fi-input" value={String(detail.settings[key]||'')} onChange={e=>update(key,e.target.value)}>{[...new Set([String(detail.settings[key]||''),...options])].map(o=><option key={o} value={o}>{labels[o]||o.replaceAll('_',' ')||'Belum ditentukan'}</option>)}</select>}</FormField>)}
          {numericFields.map(([key,label])=><FormField key={key} label={label}>{(a)=><input {...a} className="fi-input" type="number" min="0" step="any" value={detail.settings[key]===null?'':String(detail.settings[key]??'')} onChange={e=>update(key,e.target.value===''?null:Number(e.target.value))}/>}</FormField>)}
          {texts.map(([key,label])=><FormField key={key} label={label}>{(a)=><input {...a} className="fi-input" value={String(detail.settings[key]??'')} onChange={e=>update(key,e.target.value||null)}/>}</FormField>)}
          <FormField label="Kelipatan">{(a)=><select {...a} className="fi-input" value={detail.settings.repeat===null?'':String(detail.settings.repeat)} onChange={e=>update('repeat',e.target.value===''?null:e.target.value==='true')}><option value="">Belum ditentukan</option><option value="true">Ya</option><option value="false">Tidak</option></select>}</FormField>
        </div>
        <p className="fi-small fi-muted">Nilai persen ditulis sebagai angka persen, misalnya 5. Nilai yang kosong belum ditetapkan.</p>
        <div className="fi-formgrid">
          {([['outlet_codes','Kode outlet'],['include_tags','Peserta wajib'],['exclude_tags','Peserta dikecualikan'],['region','Wilayah'],['exclusive_with','Tidak boleh digabung dengan']] as const).map(([key,label])=><FormField key={key} label={`${label} (pisahkan koma)`}>{(a)=><input {...a} className="fi-input" value={(detail.settings[key] as string[]||[]).join(', ')} onChange={e=>update(key,e.target.value.split(',').map(v=>v.trim()).filter(Boolean))}/>}</FormField>)}
        </div>
        <div className="fi-btnrow">
          {([['outlet_list_required','Wajib daftar outlet'],['history_required','Memerlukan riwayat pembelian']] as const).map(([key,label])=><label key={key} className="fi-check"><input type="checkbox" checked={detail.settings[key]===true} onChange={e=>update(key,e.target.checked)}/>{label}</label>)}
        </div>
        <details><summary className="fi-title-3" style={{cursor:"pointer"}}>SKU terpilih ({detail.kode_barang.length})</summary>
          <div style={{display:"grid",gap:10,marginTop:10}}>
            <FormField label="Kode barang, pisahkan koma">{(a)=><textarea {...a} className="fi-input" rows={3} value={detail.kode_barang.join(', ')} onChange={e=>{setDetail({...detail,kode_barang:e.target.value.split(',').map(v=>v.trim()).filter(Boolean)});setDirty(true);}}/>}</FormField>
            <ul className="fi-small" style={{maxHeight:"14rem",overflowY:"auto",listStyle:"none",padding:0}}>{detail.kode_barang.map(c=><li key={c}><span className="fi-mono">{c}</span>: {pack.content.master[c]?.name||'Kode belum dikenali'}</li>)}</ul>
          </div>
        </details>
        {(detail.settings.tiers as Tier[]||[]).length>0&&<div style={{display:"grid",gap:6,minWidth:0}}><h3 className="fi-title-3">Strata</h3><div className="fi-tablescroll" tabIndex={0} style={{position:"relative"}}><table className="fi-table"><caption className="sr-only">Strata program</caption><thead><tr>{['Grade atau batas sumber','Minimum','Maksimum','Nilai'].map(v=><th key={v} scope="col">{v}</th>)}</tr></thead><tbody>
          {(detail.settings.tiers as Tier[]).map((t,i)=><tr key={i}><td>{String(t.grade||t.label||i+1)}</td>{['minimum','maximum','amount'].map(k=><td key={k}><input aria-label={`Strata ${i+1} ${labelStrata[k]}`} className="fi-input fi-cellin" type="number" min="0" step="any" value={t[k]===null||t[k]===undefined?'':String(t[k])} onChange={e=>update('tiers',(detail.settings.tiers as Tier[]).map((a,j)=>j===i?{...a,[k]:e.target.value===''?null:Number(e.target.value)}:a))}/></td>)}</tr>)}</tbody></table></div></div>}
        {detail.settings.threshold_metric==='assigned_grade'&&<MessageStrip tone="info" title="Grade ditetapkan HO.">Grade ditetapkan berdasarkan riwayat oleh HO, bukan minimum faktur berjalan. Rentang historis tetap tersimpan dalam paket dan Excel.</MessageStrip>}
        {Array.isArray(detail.settings.basket)&&<div style={{display:"grid",gap:6}}><h3 className="fi-title-3">Komposisi paket wajib</h3><ul className="fi-small" style={{paddingLeft:"1rem"}}>{(detail.settings.basket as Tier[]).map((v,i)=><li key={i}>{String(v.quantity)} PCS: {String(v.product)}</li>)}</ul></div>}
        <div style={{display:"grid",gap:6}}><h3 className="fi-title-3">Syarat dan hal yang perlu diperiksa</h3><ul className="fi-small" style={{paddingLeft:"1rem",display:"grid",gap:4}}>{[...new Set([...detail.conditions,...detail.warnings])].map((v,i)=><li key={i}>{v}</li>)}</ul></div>
        <FormField label="Koreksi Anda">{(a)=><textarea {...a} className="fi-input" rows={4} value={detail.correction||''} onChange={e=>{setDetail({...detail,correction:e.target.value});setDirty(true);}}/>}</FormField>
        <div className="fi-btnrow"><Button variant="primary" disabled={busy||!dirty} disabledReason="Belum ada perubahan" onClick={()=>void run(save)}>Simpan koreksi</Button>
          <Button disabled={busy||!dirty} disabledReason="Belum ada perubahan" onClick={()=>receive(pack,detail.row_id)}>Batalkan perubahan</Button>
          <Button disabled={busy||dirty} disabledReason="Simpan atau batalkan perubahan dulu" onClick={download}>Unduh paket terkoreksi</Button>
          {dirty&&<span className="fi-small fi-why">Simpan atau batalkan sebelum berpindah detail.</span>}</div>
        {detail.publication?<MessageStrip tone="pos" title="Sudah diterbitkan sebagai versi tetap untuk order.">Penarikan tersedia di pustaka Summary.</MessageStrip>:<div style={{display:"grid",gap:12,borderTop:"1px solid var(--line)",paddingTop:16}}>
          <div className="fi-btnrow"><Button disabled={busy||dirty} disabledReason="Simpan atau batalkan perubahan dulu" onClick={()=>void run(async()=>{const r=await request(`/${pack.id}/details/${detail.row_id}/readiness`);setIssues(r.issues);setAturanSiap(r.issues.length?null:r.programs.length);setPesan(r.issues.length?{tone:"warn",teks:"Lengkapi hal berikut sebelum menerbitkan."}:{tone:"pos",teks:`${r.programs.length} aturan siap ditinjau dan diterbitkan.`});})}>Periksa kelengkapan aturan</Button></div>
          {issues.length>0&&<ul className="fi-small" style={{paddingLeft:"1rem",display:"grid",gap:4}}>{issues.map(v=><li key={v}>{v}</li>)}</ul>}
          <label className="fi-check"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>Saya sudah memeriksa sumber, SKU, benefit, dan semua ketentuan.</label>
          <div className="fi-btnrow"><Button variant="primary" disabled={busy||dirty||!reviewed} disabledReason={dirty?"Simpan atau batalkan perubahan dulu":"Centang pernyataan pemeriksaan dulu"} onClick={()=>setDialogTerbit(true)}>Terbitkan untuk order…</Button></div>
        </div>}
        </div>
      </fieldset>
    </div>}

    <ConfirmDialog open={dialogTerbit&&Boolean(pack&&detail)} onClose={()=>setDialogTerbit(false)} tag="Terbit" title={`Terbitkan aturan ${detail?.row_id??""} untuk order?`} confirmLabel="Terbitkan untuk order" factsAlign="start"
      facts={[["Program",`${detail?.row_id??""}, ${detail?.variant_barang??""}`],["Surat",detail?.document_id??""],["Revisi paket",String(pack?.revision??"")],["Aturan siap",aturanSiap!==null?String(aturanSiap):issues.length?`${issues.length} hal belum lengkap`:"Belum diperiksa"],["Akibat","Order berikutnya memakai versi ini"]]}
      onConfirm={terbitkan} />
  </div>
  </FioriScope>;
}
