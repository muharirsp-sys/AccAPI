"""Tujuan: Dashboard Analisa Stok nilai Rupiah dengan chart offline/self-contained.
Caller: app.Api.generate dan test_analisa.py.
Dependensi: pandas, shared formatter, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

Fokus ke NILAI total, BUKAN harga per unit -- kolom Satuan sering seragam "PCS" padahal
kemasan beda2 per SKU (dus isi beda-beda), jadi "harga rata-rata per unit" menyesatkan.
Banyak baris per Kode = legit beda No.Batch (produksi berbeda tanggal expired), JUMLAHKAN
saja, bukan dianggap duplikasi.
"""
import pandas as pd

from shared import fmt_rp, fmt_int, to_json, inline_echarts

TOPN = 15
TOPN_KONTRIBUSI = 10


def build_data(df: pd.DataFrame) -> dict:
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})

    satuan_uniform = df["Satuan"].nunique() <= 1
    multi_batch_sku = int((df.groupby("Kode").size() > 1).sum())

    nilai_total = df["Saldo Akhir Nilai"].sum()
    qty_total = df["Saldo Akhir Qty"].sum()

    ov = {
        "nilai": nilai_total,
        "qty": int(qty_total),
        "sku": int(df["Kode"].nunique()),
        "golongan": int(df["Golongan"].nunique()),
        "jenis": int(df["Jenis Produk"].nunique()),
        "principal": int(df["Principle"].nunique()),
    }

    def agg_nilai(col, topn=None):
        g = df.groupby(col).agg(nilai=("Saldo Akhir Nilai", "sum"), qty=("Saldo Akhir Qty", "sum"), sku=("Kode", "nunique"))
        g = g.sort_values("nilai", ascending=False)
        if topn:
            g = g.head(topn)
        return {
            "labels": list(g.index),
            "nilai": [round(v) for v in g["nilai"]],
            "qty": [round(v) for v in g["qty"]],
            "sku": [int(v) for v in g["sku"]],
        }

    golongan = agg_nilai("Golongan", TOPN)
    jenis = agg_nilai("Jenis Produk", TOPN)
    principal = agg_nilai("Principle")
    top_sku = agg_nilai("Nama Barang", TOPN)

    kontribusi_g = df.groupby("Golongan").agg(nilai=("Saldo Akhir Nilai", "sum"), qty=("Saldo Akhir Qty", "sum")).sort_values("nilai", ascending=False).head(TOPN_KONTRIBUSI)
    kontribusi = {
        "labels": list(kontribusi_g.index),
        "pct_nilai": [round(v / nilai_total * 100, 1) if nilai_total else 0.0 for v in kontribusi_g["nilai"]],
        "pct_qty": [round(v / qty_total * 100, 1) if qty_total else 0.0 for v in kontribusi_g["qty"]],
    }

    return {
        "ov": ov, "golongan": golongan, "jenis": jenis, "principal": principal,
        "kontribusi": kontribusi, "top_sku": top_sku,
        "_meta": {"satuan_uniform": satuan_uniform, "multi_batch_sku": multi_batch_sku},
    }


def _kpi_html(ov: dict) -> str:
    return f"""<div class="kpi"><div class="k">TOTAL NILAI STOK</div><div class="v">{fmt_rp(ov['nilai'])}</div><div class="d">seluruh gudang</div></div>
<div class="kpi"><div class="k">TOTAL QUANTITY</div><div class="v">{fmt_int(ov['qty'])}</div><div class="d">unit</div></div>
<div class="kpi"><div class="k">SKU AKTIF</div><div class="v">{fmt_int(ov['sku'])}</div><div class="d">kode barang</div></div>
<div class="kpi"><div class="k">PRINCIPAL</div><div class="v">{fmt_int(ov['principal'])}</div><div class="d">brand terdaftar</div></div>
<div class="kpi"><div class="k">GOLONGAN</div><div class="v">{fmt_int(ov['golongan'])}</div><div class="d">kategori produk</div></div>
<div class="kpi"><div class="k">JENIS PRODUK</div><div class="v">{fmt_int(ov['jenis'])}</div><div class="d">merek/varian</div></div>"""


def _note_html(meta: dict) -> str:
    parts = []
    if meta["satuan_uniform"]:
        parts.append(
            'Kolom Satuan tercatat "PCS" untuk semua baris, tapi ukuran kemasan berbeda antar SKU '
            "(dus 12x8, botol, single pack, dll). Karena itu, chart \"harga rata-rata per unit\" TIDAK "
            "dibuat &mdash; akan menyesatkan karena membandingkan kemasan yang tidak setara. Nilai Rupiah "
            "tetap valid dan sudah dalam skala total yang benar."
        )
    if meta["multi_batch_sku"]:
        parts.append(
            f"{meta['multi_batch_sku']} SKU tercatat di lebih dari 1 baris (beda No.Batch/tanggal produksi) "
            "&mdash; ini legit, semua baris dijumlahkan per SKU, bukan duplikasi data."
        )
    if not parts:
        return ""
    return f'<div class="note">&#8505; <b>Catatan:</b> {" ".join(parts)}</div>'


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Analisa Nilai Stok</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#12100a;--card:#221d13;--card2:#1a160f;--bd:#3d3420;--tx:#f5eede;--mut:#b8ac8f;--dim:#7a7057;--ac:#fbbf24;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#3d2e0e;color:var(--ac);border:1px solid #5c4519;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#1f1608;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi .k{font-size:11px;color:var(--mut);margin-bottom:8px}
.kpi .v{font-size:24px;font-weight:800;color:#fff;line-height:1}
.kpi .d{font-size:11px;margin-top:6px;color:var(--dim)}
.sec{margin-bottom:14px}
.sec-h{font-size:12px;letter-spacing:2px;color:var(--ac);text-transform:uppercase;font-weight:700;margin:26px 0 12px}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:1fr 1fr}
.g21{grid-template-columns:2fr 1fr}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
.card h3{font-size:14px;font-weight:700;margin-bottom:4px}
.card .s{font-size:11px;color:var(--dim);margin-bottom:14px}
.chart{width:100%;height:300px}
.chart.tall{height:400px}
.note{background:#241d0f;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:14px;line-height:1.6}
.note.warn{border-left-color:var(--rd)}
.hidden{display:none}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Analisa Nilai Stok</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="golongan">Per Golongan</div>
<div class="chip on" data-t="jenis">Per Jenis Produk</div>
<div class="chip on" data-t="principal">Per Principal</div>
<div class="chip on" data-t="kontribusi">Nilai vs Volume</div>
<div class="chip on" data-t="topsku">Top SKU by Nilai</div>
</div>

__NOTE__

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="golongan">
<div class="sec-h">&#9656; Nilai Stok per Golongan</div>
<div class="card"><h3>Top 15 Golongan by Nilai (Rupiah)</h3><div class="s">Kategori dengan modal tertahan terbesar</div><div id="c_golongan" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="jenis">
<div class="sec-h">&#9656; Nilai Stok per Jenis Produk</div>
<div class="card"><h3>Top 15 Jenis Produk by Nilai</h3><div class="s">Brand/varian dengan nilai stok terbesar</div><div id="c_jenis" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="principal">
<div class="sec-h">&#9656; Nilai Stok per Principal</div>
<div class="grid g21">
<div class="card"><h3>Total Nilai per Principal</h3><div class="s">Modal tertahan per brand principal</div><div id="c_principal" class="chart"></div></div>
<div class="card"><h3>Proporsi</h3><div class="s">% kontribusi nilai</div><div id="c_principal_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="kontribusi">
<div class="sec-h">&#9656; Kontribusi Nilai vs Volume</div>
<div class="card"><h3>% Nilai vs % Volume per Golongan (Top 10)</h3><div class="s">Golongan dgn % nilai jauh lebih besar dari % volume = kategori bernilai tinggi per kemasan; sebaliknya = kategori volume tinggi tapi nilai rendah</div><div id="c_kontribusi" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="topsku">
<div class="sec-h">&#9656; Top SKU by Nilai Stok</div>
<div class="card"><h3>15 Produk dengan Modal Tertahan Terbesar</h3><div class="s">Kandidat review: apakah perputarannya sepadan dengan modal yang tertanam</div><div id="c_topsku" class="chart tall"></div></div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(0)+' jt':Math.round(n).toLocaleString('id-ID');
const fmtR = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#b8ac8f'},axisLine:{lineStyle:{color:'#3d3420'}},splitLine:{lineStyle:{color:'#3d3420'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#1a160f',borderColor:'#3d3420',textStyle:{color:'#f5eede'}};
const PAL=['#fbbf24','#f59e0b','#fb923c','#f87171','#f472b6','#a78bfa','#818cf8','#38bdf8'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_golongan',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.golongan.labels].reverse(),...AX,axisLabel:{color:'#b8ac8f',fontSize:11,width:150,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#b8ac8f',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.golongan.nilai].reverse(),itemStyle:{color:'#fbbf24',borderRadius:[0,4,4,0]}}]});

mk('c_jenis',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.jenis.labels].reverse(),...AX,axisLabel:{color:'#b8ac8f',fontSize:11,width:130,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#b8ac8f',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.jenis.nilai].reverse(),itemStyle:{color:'#f59e0b',borderRadius:[0,4,4,0]}}]});

mk('c_principal',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:D.principal.labels,...AX,axisLabel:{color:'#b8ac8f',fontSize:11}},
yAxis:{type:'value',...AX,axisLabel:{color:'#b8ac8f',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.principal.nilai,itemStyle:{color:'#fbbf24',borderRadius:[4,4,0,0]}}]});
mk('c_principal_pie',{tooltip:{trigger:'item',backgroundColor:'#1a160f',borderColor:'#3d3420',textStyle:{color:'#f5eede'},formatter:p=>p.name+'<br>'+fmtR(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:['40%','70%'],data:D.principal.labels.map((l,i)=>({name:l,value:D.principal.nilai[i]})),label:{color:'#b8ac8f',fontSize:10},itemStyle:{borderColor:'#221d13',borderWidth:2},color:PAL}]});

mk('c_kontribusi',{tooltip:tt,legend:{data:['% Nilai','% Volume'],textStyle:{color:'#b8ac8f'},top:0},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.kontribusi.labels].reverse(),...AX,axisLabel:{color:'#b8ac8f',fontSize:11,width:150,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#b8ac8f',formatter:v=>v+'%'}},
series:[
{name:'% Nilai',type:'bar',data:[...D.kontribusi.pct_nilai].reverse(),itemStyle:{color:'#fbbf24',borderRadius:[0,4,4,0]}},
{name:'% Volume',type:'bar',data:[...D.kontribusi.pct_qty].reverse(),itemStyle:{color:'#7a7057',borderRadius:[0,4,4,0]}}
]});

mk('c_topsku',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.top_sku.labels].reverse(),...AX,axisLabel:{color:'#b8ac8f',fontSize:10,width:220,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#b8ac8f',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.top_sku.nilai].reverse(),itemStyle:{color:'#fb923c',borderRadius:[0,4,4,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    html = TEMPLATE
    html = html.replace("__SUBTITLE__", "Analisa Posisi Barang (Semua Gudang)")
    html = html.replace("__BADGE__", f"&#9679; {fmt_rp(ov['nilai'])} nilai stok")
    html = html.replace("__NOTE__", _note_html(data["_meta"]))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
