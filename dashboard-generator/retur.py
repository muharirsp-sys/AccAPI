"""Tujuan: Dashboard Retur Penjualan dengan chart offline/self-contained.
Caller: app.Api.generate dan test_retur.py.
Dependensi: pandas, shared formatter/validasi, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

Deskripsi Issue/Kode Issue (alasan retur) sering kosong (nunique<=1) -> JANGAN buat chart
"alasan retur", cukup catat di note. "Kode Jenis Produk" dipakai sbg Jenis Produk krn kolomnya
sudah berisi nama brand langsung (INDOMIE/SARIMIE/dll), bukan sekedar kode angka.
"""
import pandas as pd

from shared import safe_chart_column, fmt_rp, fmt_int, to_json, inline_echarts


def build_data(df: pd.DataFrame) -> dict:
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})

    has_issue = safe_chart_column(df, "Deskripsi Issue")

    ov = {
        "nilai": df["Nilai Bruto"].sum(),
        "qty": int(df["Qty"].sum()),
        "n": int(df["No.Retur"].nunique()),
        "principal": int(df["Kode Principal"].nunique()),
        "sales": int(df["Kode Salesman"].nunique()),
        "ps": df["Tanggal"].min().strftime("%Y-%m-%d"),
        "pe": df["Tanggal"].max().strftime("%Y-%m-%d"),
    }

    def agg_by(col, topn=None):
        g = df.groupby(col).agg(nilai=("Nilai Bruto", "sum"), qty=("Qty", "sum")).sort_values("nilai", ascending=False)
        if topn:
            g = g.head(topn)
        return {"labels": list(g.index), "nilai": [round(v) for v in g["nilai"]], "qty": [int(v) for v in g["qty"]]}

    principal = agg_by("Nama Principal")
    market = agg_by("Market")
    jenis = agg_by("Kode Jenis Produk", 15)
    kota = agg_by("Kota Customer")
    salesman = agg_by("Nama Salesman")
    gudang = agg_by("Nama Gudang")

    return {
        "ov": ov, "principal": principal, "market": market, "jenis": jenis,
        "kota": kota, "salesman": salesman, "gudang": gudang,
        "_meta": {"has_issue": has_issue, "total_baris": int(len(df))},
    }


def _kpi_html(ov: dict) -> str:
    return f"""<div class="kpi"><div class="k">TOTAL NILAI RETUR</div><div class="v">{fmt_rp(ov['nilai'])}</div><div class="d">{fmt_int(ov['n'])} transaksi</div></div>
<div class="kpi"><div class="k">TOTAL QTY RETUR</div><div class="v">{fmt_int(ov['qty'])}</div><div class="d">unit dikembalikan</div></div>
<div class="kpi"><div class="k">PRINCIPAL TERDAMPAK</div><div class="v">{fmt_int(ov['principal'])}</div><div class="d">brand terlibat retur</div></div>
<div class="kpi"><div class="k">SALESMAN TERDAMPAK</div><div class="v">{fmt_int(ov['sales'])}</div><div class="d">salesman terkait retur ini</div></div>"""


def _note_html(meta: dict) -> str:
    if meta["has_issue"]:
        return ""
    return (f'<div class="note">&#8505; <b>Catatan:</b> Kolom "Deskripsi Issue" (alasan retur) kosong di seluruh '
            f'{meta["total_baris"]} baris data, dan "Kode Issue" hanya punya 1 nilai &mdash; jadi breakdown '
            f'"alasan retur" (rusak, salah kirim, kadaluarsa, dll) TIDAK bisa dibuat dari data ini. Jika kolom '
            f'itu diisi di sumbernya, chart alasan retur bisa ditambahkan.</div>')


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Retur Penjualan</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#170d0d;--card:#291616;--card2:#1f1010;--bd:#4a2020;--tx:#f5e6e6;--mut:#c49a9a;--dim:#8a5f5f;--ac:#fb7185;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#3d1518;color:var(--ac);border:1px solid #5c1f24;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#1f0a0c;border-color:var(--ac);font-weight:700}
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
.chart.tall{height:380px}
.note{background:#2b1414;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:20px;line-height:1.6}
.hidden{display:none}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Retur Penjualan</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="principal">Per Principal</div>
<div class="chip on" data-t="market">Per Market</div>
<div class="chip on" data-t="jenis">Per Jenis Produk</div>
<div class="chip on" data-t="kota">Per Kota</div>
<div class="chip on" data-t="salesman">Per Salesman</div>
<div class="chip on" data-t="gudang">Lokasi Penanganan</div>
</div>

__NOTE__

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="principal">
<div class="sec-h">&#9656; Retur per Principal</div>
<div class="card"><h3>Nilai Retur per Principal</h3><div class="s">Brand mana yang paling sering diretur customer</div><div id="c_principal" class="chart"></div></div>
</div>

<div class="sec" data-sec="market">
<div class="sec-h">&#9656; Retur per Segmen Market</div>
<div class="grid g21">
<div class="card"><h3>Nilai Retur per Market</h3><div class="s">RETAIL / WHOLESALER / HCO</div><div id="c_market" class="chart"></div></div>
<div class="card"><h3>Proporsi</h3><div class="s">% kontribusi</div><div id="c_market_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="jenis">
<div class="sec-h">&#9656; Retur per Jenis Produk</div>
<div class="card"><h3>Top 15 Jenis Produk yang Diretur</h3><div class="s">by nilai bruto retur</div><div id="c_jenis" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="kota">
<div class="sec-h">&#9656; Retur per Kota</div>
<div class="card"><h3>Distribusi Kota Asal Retur</h3><div class="s">Kota terlibat</div><div id="c_kota" class="chart"></div></div>
</div>

<div class="sec" data-sec="salesman">
<div class="sec-h">&#9656; Retur per Salesman</div>
<div class="card"><h3>Nilai Retur Terkait Tiap Salesman</h3><div class="s">Nilai tinggi bisa jadi sinyal review kualitas layanan/pengiriman di rute tsb</div><div id="c_salesman" class="chart"></div></div>
</div>

<div class="sec" data-sec="gudang">
<div class="sec-h">&#9656; Lokasi Penanganan Retur</div>
<div class="card"><h3>Retur per Lokasi/Status Penanganan</h3><div class="s">Termasuk status "Claim Principal" jika retur diteruskan ke principal</div><div id="c_gudang" class="chart"></div></div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(1)+' jt':Math.round(n).toLocaleString('id-ID');
const fmtR = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#c49a9a'},axisLine:{lineStyle:{color:'#4a2020'}},splitLine:{lineStyle:{color:'#4a2020'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#1f1010',borderColor:'#4a2020',textStyle:{color:'#f5e6e6'}};
const PAL=['#fb7185','#f87171','#fb923c','#fbbf24','#a3e635','#4ade80','#22d3ee','#818cf8'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_principal',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:D.principal.labels,...AX,axisLabel:{color:'#c49a9a',fontSize:10,rotate:15}},
yAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.principal.nilai,itemStyle:{color:'#fb7185',borderRadius:[4,4,0,0]}}]});

mk('c_market',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:[...D.market.labels].reverse(),...AX},
xAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.market.nilai].reverse(),itemStyle:{color:'#f87171',borderRadius:[0,4,4,0]}}]});
mk('c_market_pie',{tooltip:{trigger:'item',backgroundColor:'#1f1010',borderColor:'#4a2020',textStyle:{color:'#f5e6e6'},formatter:p=>p.name+'<br>'+fmtR(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:['40%','70%'],data:D.market.labels.map((l,i)=>({name:l,value:D.market.nilai[i]})),label:{color:'#c49a9a',fontSize:10},itemStyle:{borderColor:'#291616',borderWidth:2},color:PAL}]});

mk('c_jenis',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.jenis.labels].reverse(),...AX,axisLabel:{color:'#c49a9a',fontSize:11,width:130,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.jenis.nilai].reverse(),itemStyle:{color:'#fb923c',borderRadius:[0,4,4,0]}}]});

mk('c_kota',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:D.kota.labels,...AX,axisLabel:{color:'#c49a9a',fontSize:10,width:100,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.kota.nilai,itemStyle:{color:'#fbbf24',borderRadius:[4,4,0,0]}}]});

mk('c_salesman',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:[...D.salesman.labels].reverse(),...AX,axisLabel:{color:'#c49a9a',fontSize:11}},
xAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.salesman.nilai].reverse(),itemStyle:{color:'#f87171',borderRadius:[0,4,4,0]}}]});

mk('c_gudang',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:D.gudang.labels,...AX,axisLabel:{color:'#c49a9a',fontSize:9,rotate:15,width:120,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#c49a9a',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.gudang.nilai,itemStyle:{color:'#fb7185',borderRadius:[4,4,0,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    html = TEMPLATE
    html = html.replace("__SUBTITLE__", f"Periode {ov['ps']} s/d {ov['pe']}")
    html = html.replace("__BADGE__", f"&#9679; {fmt_int(ov['n'])} transaksi retur")
    html = html.replace("__NOTE__", _note_html(data["_meta"]))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
