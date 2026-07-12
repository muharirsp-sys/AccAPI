"""Tujuan: Dashboard Posisi Stok per Gudang dengan chart offline/self-contained.
Caller: app.Api.generate dan test_stok.py.
Dependensi: pandas, shared formatter/validasi, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

CEK WAJIB sebelum bikin chart movement/dead-stock: kalau Debet=Kredit=0 dan Saldo Awal==Saldo Akhir
di semua baris, ini laporan SNAPSHOT bukan data pergerakan -- JANGAN bikin chart barang masuk/keluar
atau dead-stock, cukup catat di note. Expired Date sering placeholder ("01/01/0001") -> skip alert.
"""
import pandas as pd

from shared import safe_chart_column, fmt_int, to_json, inline_echarts

TOPN = 15


def build_data(df: pd.DataFrame) -> dict:
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})

    is_snapshot = bool(df["Debet"].sum() == 0 and df["Kredit"].sum() == 0 and (df["Saldo Awal"] == df["Saldo Akhir"]).all())
    has_expired = safe_chart_column(df, "Expired Date")
    has_kelompok = safe_chart_column(df, "Kelompok")

    ov = {
        "saldo": int(df["Saldo Akhir"].sum()),
        "sku": int(df["Kode"].nunique()),
        "baris": int(len(df)),
        "gudang": int(df["Kode Gudang"].nunique()),
        "principal": int(df["Principal"].nunique()),
        "golongan": int(df["Golongan"].nunique()),
        "jenis": int(df["Jenis Produk"].nunique()),
    }

    def agg_saldo(col, topn=None):
        g = df.groupby(col).agg(saldo=("Saldo Akhir", "sum"), sku=("Kode", "nunique")).sort_values("saldo", ascending=False)
        if topn:
            g = g.head(topn)
        return {"labels": list(g.index), "saldo": [int(v) for v in g["saldo"]], "sku": [int(v) for v in g["sku"]]}

    golongan = agg_saldo("Golongan", TOPN)
    jenis = agg_saldo("Jenis Produk", TOPN)
    principal = agg_saldo("Principal")
    gudang = agg_saldo("Nama Gudang")
    top_sku = agg_saldo("Nama Barang", TOPN)

    is_kanvas = df["Nama Gudang"].str.upper().str.contains("KANVAS")
    tipe_gudang = {
        "labels": ["Gudang Utama", "Kanvas (Mobile)"],
        "saldo": [int(df.loc[~is_kanvas, "Saldo Akhir"].sum()), int(df.loc[is_kanvas, "Saldo Akhir"].sum())],
    }

    return {
        "ov": ov, "golongan": golongan, "jenis": jenis, "principal": principal,
        "gudang": gudang, "tipe_gudang": tipe_gudang, "top_sku": top_sku,
        "_meta": {"is_snapshot": is_snapshot, "has_expired": has_expired, "has_kelompok": has_kelompok},
    }


def _kpi_html(ov: dict) -> str:
    return f"""<div class="kpi"><div class="k">TOTAL STOK</div><div class="v">{fmt_int(ov['saldo'])}</div><div class="d">unit (PCS)</div></div>
<div class="kpi"><div class="k">SKU AKTIF</div><div class="v">{fmt_int(ov['sku'])}</div><div class="d">{fmt_int(ov['baris'])} baris SKU&times;gudang</div></div>
<div class="kpi"><div class="k">GUDANG</div><div class="v">{fmt_int(ov['gudang'])}</div><div class="d">termasuk kanvas mobile</div></div>
<div class="kpi"><div class="k">PRINCIPAL</div><div class="v">{fmt_int(ov['principal'])}</div><div class="d">brand terdaftar</div></div>
<div class="kpi"><div class="k">GOLONGAN</div><div class="v">{fmt_int(ov['golongan'])}</div><div class="d">kategori produk</div></div>
<div class="kpi"><div class="k">JENIS PRODUK</div><div class="v">{fmt_int(ov['jenis'])}</div><div class="d">merek/varian</div></div>"""


def _note_html(meta: dict) -> str:
    parts = []
    if meta["is_snapshot"]:
        parts.append(
            "Ini laporan <b>snapshot posisi akhir</b> &mdash; kolom Debet/Kredit (pergerakan stok) semuanya "
            "nol dan Saldo Awal = Saldo Akhir di seluruh baris, jadi chart \"barang masuk/keluar\" atau "
            "\"dead stock\" TIDAK dibuat karena akan menyesatkan (100% item akan terlihat \"tidak bergerak\" "
            "padahal itu keterbatasan laporan ini, bukan data pergerakan aktual)."
        )
    extra_skip = []
    if not meta["has_kelompok"]:
        extra_skip.append("Kelompok")
    if not meta["has_expired"]:
        extra_skip.append("Expired Date")
    if extra_skip:
        parts.append(f"Kolom {' dan '.join(extra_skip)} juga tidak terisi (placeholder), begitu juga tidak dibuatkan chart.")
    if not parts:
        return ""
    return f'<div class="note">&#8505; <b>Catatan kejujuran data:</b> {" ".join(parts)}</div>'


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Posisi Stok</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#08140f;--card:#0f2019;--card2:#0b1a14;--bd:#1a3a2c;--tx:#e7f5ee;--mut:#8fb5a3;--dim:#5c8271;--ac:#2dd4bf;--ac2:#34d399;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#0e2e26;color:var(--ac);border:1px solid #1a4d3f;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#052018;border-color:var(--ac);font-weight:700}
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
.note{background:#132921;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:20px;line-height:1.6}
.hidden{display:none}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Posisi Stok</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="golongan">Per Golongan</div>
<div class="chip on" data-t="jenis">Per Jenis Produk</div>
<div class="chip on" data-t="principal">Per Principal</div>
<div class="chip on" data-t="gudang">Per Gudang</div>
<div class="chip on" data-t="tipe">Utama vs Kanvas</div>
<div class="chip on" data-t="topsku">Top SKU</div>
</div>

__NOTE__

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="golongan">
<div class="sec-h">&#9656; Stok per Golongan</div>
<div class="card"><h3>Top 15 Golongan by Total Stok</h3><div class="s">Kategori dgn stok terbanyak</div><div id="c_golongan" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="jenis">
<div class="sec-h">&#9656; Stok per Jenis Produk</div>
<div class="card"><h3>Top 15 Jenis Produk by Total Stok</h3><div class="s">Brand/varian dgn stok terbanyak</div><div id="c_jenis" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="principal">
<div class="sec-h">&#9656; Stok per Principal</div>
<div class="grid g21">
<div class="card"><h3>Total Stok per Principal</h3><div class="s">Distribusi stok per brand</div><div id="c_principal" class="chart"></div></div>
<div class="card"><h3>Proporsi</h3><div class="s">% kontribusi stok</div><div id="c_principal_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="gudang">
<div class="sec-h">&#9656; Stok per Gudang</div>
<div class="card"><h3>Distribusi Gudang</h3><div class="s">Gudang standar vs gudang lain + kanvas mobile</div><div id="c_gudang" class="chart"></div></div>
</div>

<div class="sec" data-sec="tipe">
<div class="sec-h">&#9656; Gudang Utama vs Kanvas (Mobile)</div>
<div class="card"><h3>Stok Statis (Gudang) vs Stok Bergerak (Kendaraan Sales)</h3><div class="s">Berapa stok "terkunci" di gudang vs sudah ada di lapangan siap jual</div><div id="c_tipe" class="chart"></div></div>
</div>

<div class="sec" data-sec="topsku">
<div class="sec-h">&#9656; Top SKU by Volume Stok</div>
<div class="card"><h3>15 Produk dengan Stok Terbanyak</h3><div class="s">Kandidat review: apakah ini overstock atau memang fast-moving</div><div id="c_topsku" class="chart tall"></div></div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmtS = n => Math.abs(n)>=1e6?(n/1e6).toFixed(1)+' jt':Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#8fb5a3'},axisLine:{lineStyle:{color:'#1a3a2c'}},splitLine:{lineStyle:{color:'#1a3a2c'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#0b1a14',borderColor:'#1a3a2c',textStyle:{color:'#e7f5ee'}};
const PAL=['#2dd4bf','#34d399','#4ade80','#a3e635','#facc15','#fb923c','#f472b6','#38bdf8'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_golongan',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value.toLocaleString('id-ID')+' unit'},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.golongan.labels].reverse(),...AX,axisLabel:{color:'#8fb5a3',fontSize:11,width:150,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#8fb5a3',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.golongan.saldo].reverse(),itemStyle:{color:'#2dd4bf',borderRadius:[0,4,4,0]}}]});

mk('c_jenis',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value.toLocaleString('id-ID')+' unit'},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.jenis.labels].reverse(),...AX,axisLabel:{color:'#8fb5a3',fontSize:11,width:130,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#8fb5a3',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.jenis.saldo].reverse(),itemStyle:{color:'#34d399',borderRadius:[0,4,4,0]}}]});

mk('c_principal',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value.toLocaleString('id-ID')+' unit'},grid,
xAxis:{type:'category',data:D.principal.labels,...AX,axisLabel:{color:'#8fb5a3',fontSize:11}},
yAxis:{type:'value',...AX,axisLabel:{color:'#8fb5a3',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.principal.saldo,itemStyle:{color:'#2dd4bf',borderRadius:[4,4,0,0]}}]});
mk('c_principal_pie',{tooltip:{trigger:'item',backgroundColor:'#0b1a14',borderColor:'#1a3a2c',textStyle:{color:'#e7f5ee'},formatter:p=>p.name+'<br>'+p.value.toLocaleString('id-ID')+' unit ('+p.percent+'%)'},
series:[{type:'pie',radius:['40%','70%'],data:D.principal.labels.map((l,i)=>({name:l,value:D.principal.saldo[i]})),label:{color:'#8fb5a3',fontSize:10},itemStyle:{borderColor:'#0f2019',borderWidth:2},color:PAL}]});

mk('c_gudang',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value.toLocaleString('id-ID')+' unit'},grid,
xAxis:{type:'category',data:D.gudang.labels,...AX,axisLabel:{color:'#8fb5a3',fontSize:9,rotate:30,width:100,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#8fb5a3',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.gudang.saldo,itemStyle:{color:'#4ade80',borderRadius:[4,4,0,0]}}]});

mk('c_tipe',{tooltip:{trigger:'item',backgroundColor:'#0b1a14',borderColor:'#1a3a2c',textStyle:{color:'#e7f5ee'},formatter:p=>p.name+'<br>'+p.value.toLocaleString('id-ID')+' unit ('+p.percent+'%)'},
series:[{type:'pie',radius:['45%','72%'],data:D.tipe_gudang.labels.map((l,i)=>({name:l,value:D.tipe_gudang.saldo[i]})),label:{color:'#e7f5ee',fontSize:13,formatter:'{b}\n{d}%'},itemStyle:{borderColor:'#0f2019',borderWidth:3},color:['#2dd4bf','#fbbf24']}]});

mk('c_topsku',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value.toLocaleString('id-ID')+' unit'},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.top_sku.labels].reverse(),...AX,axisLabel:{color:'#8fb5a3',fontSize:10,width:220,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#8fb5a3',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.top_sku.saldo].reverse(),itemStyle:{color:'#a3e635',borderRadius:[0,4,4,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    html = TEMPLATE
    html = html.replace("__SUBTITLE__", "Posisi Barang per Gudang")
    html = html.replace("__BADGE__", f"&#9679; {fmt_int(ov['sku'])} SKU aktif")
    html = html.replace("__NOTE__", _note_html(data["_meta"]))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
