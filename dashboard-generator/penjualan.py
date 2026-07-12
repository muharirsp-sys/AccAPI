"""Tujuan: Dashboard Penjualan single-file dengan chart offline/self-contained.
Caller: app.Api.generate dan test_penjualan.py.
Dependensi: pandas, shared formatter/validasi, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

Kolom "Kolom TERISI" (No Invoice, Tanggal, Kota Customer, Kode/Nama Salesman, Kode/Nama Barang,
Qty, Nilai Bruto/Disc, Kode/Nama Principal, Jenis Produk, Nama Gudang) dianggap selalu terisi
sesuai spec Fase 2, jadi 9 section wajib TIDAK pakai safe_chart_column. Yang dicek cuma kolom
tambahan yang sering placeholder (Kecamatan/Desa/Region/Market/Golongan/dll) untuk catatan honesty.
"""
import pandas as pd

from shared import safe_chart_column, fmt_rp, fmt_int, to_json, inline_echarts

OPTIONAL_COLS = ["Kecamatan", "Desa", "Region", "Market", "Jenis Market", "Golongan", "Kelompok Barang"]
TOPN = 15


def build_data(df: pd.DataFrame) -> dict:
    # ponytail: beberapa kolom di export Accurate lama (mis. Jenis Produk) fixed-width dgn trailing
    # spasi ("SCM            ") -> strip semua kolom teks sekali di sini, bukan di tiap agregasi
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})
    df = df.assign(Netto=df["Nilai Bruto"] - df["Nilai Disc"])

    skipped_cols = [c for c in OPTIONAL_COLS if c in df.columns and not safe_chart_column(df, c)]
    principals = df["Nama Principal"].dropna().unique() if "Nama Principal" in df.columns else []
    principal_label = principals[0] if len(principals) == 1 else (f"{len(principals)} principal" if len(principals) > 1 else None)

    ov = {
        "netto": df["Netto"].sum(),
        "bruto": df["Nilai Bruto"].sum(),
        "disc": df["Nilai Disc"].sum(),
        "inv": int(df["No Invoice"].nunique()),
        "cust": int(df["Kode Customer"].nunique()),
        "sales": int(df["Kode Salesman"].nunique()),
        "barang": int(df["Kode Barang"].nunique()),
        "qty": df["Qty"].sum(),
        "ps": df["Tanggal"].min().strftime("%Y-%m-%d"),
        "pe": df["Tanggal"].max().strftime("%Y-%m-%d"),
    }

    def agg_by(col, topn=None):
        g = df.groupby(col).agg(
            netto=("Netto", "sum"), qty=("Qty", "sum"), inv=("No Invoice", "nunique")
        ).sort_values("netto", ascending=False)
        if topn:
            g = g.head(topn)
        return {
            "labels": list(g.index),
            "netto": [round(v) for v in g["netto"]],
            "qty": [round(v) for v in g["qty"]],
            "inv": [int(v) for v in g["inv"]],
        }

    daily_g = df.groupby(df["Tanggal"].dt.date).agg(netto=("Netto", "sum"), inv=("No Invoice", "nunique")).sort_index()
    daily = {
        "labels": [d.strftime("%m-%d") for d in daily_g.index],
        "netto": [round(v) for v in daily_g["netto"]],
        "inv": [int(v) for v in daily_g["inv"]],
    }

    kota = agg_by("Kota Customer")
    salesman = agg_by("Nama Salesman")
    barang = agg_by("Nama Barang", TOPN)
    jenis = agg_by("Jenis Produk")
    customer = agg_by("Nama Customer", TOPN)
    gudang = agg_by("Nama Gudang")

    disc_g = df.groupby("Nama Salesman").agg(bruto=("Nilai Bruto", "sum"), disc=("Nilai Disc", "sum"))
    disc_g = disc_g.reindex(salesman["labels"])  # urutan sama dgn ranking salesman by netto
    disc_sales = {
        "labels": salesman["labels"],
        "disc": [round(v) for v in disc_g["disc"]],
        "pct": [round(d / b * 100, 1) if b else 0.0 for d, b in zip(disc_g["disc"], disc_g["bruto"])],
    }

    tbl_g = df.groupby("Nama Salesman").agg(
        netto=("Netto", "sum"), inv=("No Invoice", "nunique"), cust=("Kode Customer", "nunique"), qty=("Qty", "sum")
    ).reindex(salesman["labels"])
    sales_tbl = [
        {
            "nama": nama,
            "netto": round(row["netto"]),
            "inv": int(row["inv"]),
            "cust": int(row["cust"]),
            "qty": round(row["qty"]),
            "avg": round(row["netto"] / row["inv"]) if row["inv"] else 0,
        }
        for nama, row in tbl_g.iterrows()
    ]

    return {
        "ov": ov, "daily": daily, "kota": kota, "salesman": salesman, "barang": barang,
        "jenis": jenis, "customer": customer, "gudang": gudang,
        "disc_sales": disc_sales, "sales_tbl": sales_tbl,
        "_meta": {"principal_label": principal_label, "skipped_cols": skipped_cols},
    }


def _kpi_html(ov: dict) -> str:
    avg = fmt_rp(ov["netto"] / ov["inv"]) if ov["inv"] else "Rp 0"
    disc_pct = round(ov["disc"] / ov["bruto"] * 100, 1) if ov["bruto"] else 0
    return f"""<div class="kpi"><div class="k">TOTAL PENJUALAN (NETTO)</div><div class="v">{fmt_rp(ov['netto'])}</div><div class="d">bruto {fmt_rp(ov['bruto'])}</div></div>
<div class="kpi"><div class="k">JUMLAH INVOICE</div><div class="v">{fmt_int(ov['inv'])}</div><div class="d">rata-rata {avg} / invoice</div></div>
<div class="kpi"><div class="k">TOKO AKTIF</div><div class="v">{fmt_int(ov['cust'])}</div><div class="d">customer aktif</div></div>
<div class="kpi"><div class="k">TOTAL DISKON</div><div class="v">{fmt_rp(ov['disc'])}</div><div class="d r">{disc_pct}% dari bruto</div></div>
<div class="kpi"><div class="k">TOTAL QTY</div><div class="v">{fmt_int(ov['qty'])}</div><div class="d">unit terjual</div></div>
<div class="kpi"><div class="k">SKU AKTIF</div><div class="v">{fmt_int(ov['barang'])}</div><div class="d">produk terjual</div></div>"""


def _note_html(meta: dict) -> str:
    if not meta["skipped_cols"]:
        return ""
    cols = ", ".join(meta["skipped_cols"])
    return f"""<div class="note">
&#8505; <b>Catatan kejujuran data:</b> Dashboard ini hanya menampilkan kolom yang <b>benar-benar terisi</b> di file Anda. Kolom {cols} di file ini kosong / tidak dipetakan (placeholder), jadi tidak dibuatkan chart agar tidak menyesatkan.
</div>"""


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Penjualan</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#0b1120;--card:#131c2e;--card2:#0f1826;--bd:#1e293b;--tx:#e2e8f0;--mut:#94a3b8;--dim:#64748b;--ac:#38bdf8;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#0e2a1a;color:var(--gr);border:1px solid #1a4d33;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#08131f;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi .k{font-size:11px;color:var(--mut);margin-bottom:8px}
.kpi .v{font-size:24px;font-weight:800;color:#fff;line-height:1}
.kpi .d{font-size:11px;margin-top:6px;color:var(--dim)}
.kpi .d.r{color:var(--rd)}
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
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;border-bottom:2px solid var(--bd)}
td{padding:10px 12px;border-bottom:1px solid var(--bd)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.rank{display:inline-flex;width:22px;height:22px;background:var(--bd);border-radius:6px;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--mut)}
.note{background:#1c2331;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:20px;line-height:1.6}
.hidden{display:none}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--bd);color:var(--dim);font-size:11px;text-align:center}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Penjualan</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="trend">Tren Harian</div>
<div class="chip on" data-t="wilayah">Per Kota</div>
<div class="chip on" data-t="salesman">Salesman</div>
<div class="chip on" data-t="produk">Produk</div>
<div class="chip on" data-t="jenis">Jenis Produk</div>
<div class="chip on" data-t="customer">Customer</div>
<div class="chip on" data-t="gudang">Gudang</div>
<div class="chip on" data-t="diskon">Diskon</div>
</div>

__NOTE__

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="trend">
<div class="sec-h">&#9656; Tren Penjualan Harian</div>
<div class="card"><h3>Penjualan &amp; Jumlah Invoice per Hari</h3><div class="s">Netto (batang) vs jumlah invoice (garis)</div><div id="c_trend" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="wilayah">
<div class="sec-h">&#9656; Sebaran per Kota</div>
<div class="grid g21">
<div class="card"><h3>Penjualan per Kota</h3><div class="s">Kontribusi netto tiap kota</div><div id="c_kota_bar" class="chart"></div></div>
<div class="card"><h3>Proporsi</h3><div class="s">% kontribusi</div><div id="c_kota_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="salesman">
<div class="sec-h">&#9656; Kinerja Salesman</div>
<div class="grid g21">
<div class="card"><h3>Top Salesman by Netto</h3><div class="s">Peringkat kontribusi penjualan</div><div id="c_sales" class="chart tall"></div></div>
<div class="card"><h3>Detail Kinerja</h3><div class="s">Netto, invoice, toko, rata-rata</div>
<div style="max-height:340px;overflow:auto"><table id="t_sales"><thead><tr><th>#</th><th>Salesman</th><th class="num">Netto</th><th class="num">Inv</th><th class="num">Toko</th><th class="num">Avg</th></tr></thead><tbody></tbody></table></div>
</div></div>
</div>

<div class="sec" data-sec="produk">
<div class="sec-h">&#9656; Analisa Produk</div>
<div class="card"><h3>Top 15 Produk Terlaris</h3><div class="s">by netto penjualan</div><div id="c_produk" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="jenis">
<div class="sec-h">&#9656; Per Jenis Produk</div>
<div class="grid g2">
<div class="card"><h3>Netto per Jenis Produk</h3><div class="s">Distribusi kategori produk</div><div id="c_jenis_bar" class="chart"></div></div>
<div class="card"><h3>Proporsi Jenis</h3><div class="s">% kontribusi tiap kategori</div><div id="c_jenis_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="customer">
<div class="sec-h">&#9656; Top Customer</div>
<div class="card"><h3>15 Toko dengan Pembelian Terbesar</h3><div class="s">by netto</div><div id="c_cust" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="gudang">
<div class="sec-h">&#9656; Per Gudang</div>
<div class="card"><h3>Penjualan per Gudang</h3><div class="s">Distribusi dari tiap gudang</div><div id="c_gudang" class="chart"></div></div>
</div>

<div class="sec" data-sec="diskon">
<div class="sec-h">&#9656; Analisa Diskon</div>
<div class="grid g2">
<div class="card"><h3>Nilai Diskon per Salesman</h3><div class="s">Total rupiah diskon diberikan</div><div id="c_disc" class="chart"></div></div>
<div class="card"><h3>% Diskon per Salesman</h3><div class="s">Diskon relatif thd bruto (deteksi over-discount)</div><div id="c_discpct" class="chart"></div></div>
</div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmt = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(0)+' jt':Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#94a3b8'},axisLine:{lineStyle:{color:'#1e293b'}},splitLine:{lineStyle:{color:'#1e293b'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#0f1826',borderColor:'#1e293b',textStyle:{color:'#e2e8f0'}};
const PAL=['#38bdf8','#818cf8','#a78bfa','#c084fc','#e879f9','#f472b6','#fb7185','#4ade80','#facc15','#22d3ee'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_trend',{tooltip:tt,legend:{data:['Netto','Invoice'],textStyle:{color:'#94a3b8'},top:0},grid,
xAxis:{type:'category',data:D.daily.labels,...AX},
yAxis:[{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},{type:'value',...AX,splitLine:{show:false}}],
series:[{name:'Netto',type:'bar',data:D.daily.netto,itemStyle:{color:'#38bdf8',borderRadius:[4,4,0,0]}},
{name:'Invoice',type:'line',yAxisIndex:1,data:D.daily.inv,smooth:true,lineStyle:{color:'#fbbf24',width:2},itemStyle:{color:'#fbbf24'}}]});

mk('c_kota_bar',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
yAxis:{type:'category',data:[...D.kota.labels].reverse(),...AX},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.kota.netto].reverse(),itemStyle:{color:'#38bdf8',borderRadius:[0,4,4,0]}}]});
mk('c_kota_pie',{tooltip:{trigger:'item',backgroundColor:'#0f1826',borderColor:'#1e293b',textStyle:{color:'#e2e8f0'},formatter:p=>p.name+'<br>'+fmt(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:['40%','70%'],data:D.kota.labels.map((l,i)=>({name:l,value:D.kota.netto[i]})),label:{color:'#94a3b8',fontSize:10},itemStyle:{borderColor:'#131c2e',borderWidth:2},color:PAL}]});

mk('c_sales',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
yAxis:{type:'category',data:[...D.salesman.labels].reverse(),...AX,axisLabel:{color:'#94a3b8',fontSize:11}},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.salesman.netto].reverse(),itemStyle:{color:'#818cf8',borderRadius:[0,4,4,0]}}]});
const tb=document.querySelector('#t_sales tbody');
D.sales_tbl.forEach((r,i)=>{tb.innerHTML+='<tr><td><span class="rank">'+(i+1)+'</span></td><td>'+r.nama+'</td><td class="num">'+fmt(r.netto)+'</td><td class="num">'+r.inv+'</td><td class="num">'+r.cust+'</td><td class="num">'+fmt(r.avg)+'</td></tr>';});

mk('c_produk',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.barang.labels].reverse(),...AX,axisLabel:{color:'#94a3b8',fontSize:10,width:180,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.barang.netto].reverse(),itemStyle:{color:'#a78bfa',borderRadius:[0,4,4,0]}}]});

mk('c_jenis_bar',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
xAxis:{type:'category',data:D.jenis.labels,...AX},
yAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.jenis.netto,itemStyle:{color:'#4ade80',borderRadius:[4,4,0,0]}}]});
mk('c_jenis_pie',{tooltip:{trigger:'item',backgroundColor:'#0f1826',borderColor:'#1e293b',textStyle:{color:'#e2e8f0'},formatter:p=>p.name+'<br>'+fmt(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:'65%',data:D.jenis.labels.map((l,i)=>({name:l,value:D.jenis.netto[i]})),label:{color:'#94a3b8',fontSize:11},itemStyle:{borderColor:'#131c2e',borderWidth:2},color:PAL}]});

mk('c_cust',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.customer.labels].reverse(),...AX,axisLabel:{color:'#94a3b8',fontSize:10,width:150,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.customer.netto].reverse(),itemStyle:{color:'#38bdf8',borderRadius:[0,4,4,0]}}]});

mk('c_gudang',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
xAxis:{type:'category',data:D.gudang.labels,...AX,axisLabel:{color:'#94a3b8',fontSize:9,rotate:30}},
yAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.gudang.netto,itemStyle:{color:'#c084fc',borderRadius:[4,4,0,0]}}]});

mk('c_disc',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
yAxis:{type:'category',data:[...D.disc_sales.labels].reverse(),...AX,axisLabel:{color:'#94a3b8',fontSize:11}},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.disc_sales.disc].reverse(),itemStyle:{color:'#f87171',borderRadius:[0,4,4,0]}}]});
mk('c_discpct',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+p[0].value+'%'},grid,
yAxis:{type:'category',data:[...D.disc_sales.labels].reverse(),...AX,axisLabel:{color:'#94a3b8',fontSize:11}},
xAxis:{type:'value',...AX,axisLabel:{color:'#94a3b8',formatter:v=>v+'%'}},
series:[{type:'bar',data:[...D.disc_sales.pct].reverse(),itemStyle:{color:'#fbbf24',borderRadius:[0,4,4,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    meta = data["_meta"]
    sub = "Analisa laporan penjualan"
    if meta["principal_label"]:
        sub += f" &middot; Principal: {meta['principal_label']}"
    sub += f" &middot; Periode {ov['ps']} s/d {ov['pe']}"

    html = TEMPLATE
    html = html.replace("__SUBTITLE__", sub)
    html = html.replace("__BADGE__", f"&#9679; Data aktual &mdash; {fmt_int(ov['inv'])} invoice")
    html = html.replace("__NOTE__", _note_html(meta))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
