"""Tujuan: Dashboard Laba Rugi Penjualan single-file dengan chart offline/self-contained.
Caller: app.Api.generate dan test_labarugi.py.
Dependensi: pandas, shared formatter/validasi, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

Laba = Nilai Jual - HPP - Biaya Lain; HPP boleh bernama "JUM HPP" atau "Nilai HPP".
Margin% = Laba/Nilai Jual*100.
RANKING WAJIB by Laba untuk Produk/Salesman/Customer (bukan by Nilai Jual) -- omzet besar
belum tentu untung besar. Kota tetap by nilai jual (ikuti reference, bukan salah satu yg wajib-laba).
Section "Produk Rugi" WAJIB tetap ada meski kosong (tampilkan pesan, jangan dihilangkan).
"""
import pandas as pd

from shared import safe_chart_column, fmt_rp, fmt_int, to_json, inline_echarts

OPTIONAL_COLS = ["Job", "Market", "Golongan Barang"]
TOPN = 15
HPP_COL = "JUM HPP"
HPP_ALIASES = ("JUM HPP", "Nilai HPP")


def _normalise_hpp_column(df: pd.DataFrame) -> pd.DataFrame:
    if HPP_COL in df.columns:
        return df
    for col in HPP_ALIASES:
        if col in df.columns:
            return df.rename(columns={col: HPP_COL})
    return df


def build_data(df: pd.DataFrame) -> dict:
    df = _normalise_hpp_column(df)
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})
    df = df.assign(Laba=df["Nilai Jual"] - df[HPP_COL] - df["Biaya Lain"])

    skipped_cols = [c for c in OPTIONAL_COLS if c in df.columns and not safe_chart_column(df, c)]

    jual_total = df["Nilai Jual"].sum()
    laba_total = df["Laba"].sum()

    ov = {
        "jual": jual_total,
        "hpp": df[HPP_COL].sum(),
        "laba": laba_total,
        "margin": round(laba_total / jual_total * 100, 1) if jual_total else 0.0,
        "nota": int(df["No.Nota"].nunique()),
        "cust": int(df["Kode Customer"].nunique()),
        "barang": int(df["Kode Barang"].nunique()),
        "sales": int(df["Kode Salesman"].nunique()),
        "ps": df["Tanggal"].min().strftime("%Y-%m-%d"),
        "pe": df["Tanggal"].max().strftime("%Y-%m-%d"),
    }

    def agg_laba(col, topn=None):
        g = df.groupby(col).agg(jual=("Nilai Jual", "sum"), laba=("Laba", "sum"), qty=("Qty", "sum"))
        g = g.sort_values("laba", ascending=False)
        if topn:
            g = g.head(topn)
        return {
            "labels": list(g.index),
            "jual": [round(v) for v in g["jual"]],
            "laba": [round(v) for v in g["laba"]],
            "qty": [round(v) for v in g["qty"]],
            "margin": [round(l / j * 100, 1) if j else 0.0 for l, j in zip(g["laba"], g["jual"])],
        }

    daily_g = df.groupby(df["Tanggal"].dt.date).agg(jual=("Nilai Jual", "sum"), laba=("Laba", "sum")).sort_index()
    daily = {
        "labels": [d.strftime("%m-%d") for d in daily_g.index],
        "jual": [round(v) for v in daily_g["jual"]],
        "laba": [round(v) for v in daily_g["laba"]],
    }

    barang_all = df.groupby("Nama Barang").agg(jual=("Nilai Jual", "sum"), laba=("Laba", "sum"))
    rugi_g = barang_all[barang_all["laba"] < 0].sort_values("laba")
    barang_rugi = {
        "labels": list(rugi_g.index),
        "jual": [round(v) for v in rugi_g["jual"]],
        "laba": [round(v) for v in rugi_g["laba"]],
    }

    barang_laba = agg_laba("Nama Barang", TOPN)
    salesman = agg_laba("Nama Salesman")
    customer = agg_laba("Nama Customer", TOPN)

    kota_g = df.groupby("Kota Customer").agg(jual=("Nilai Jual", "sum"), laba=("Laba", "sum"), qty=("Qty", "sum")).sort_values("jual", ascending=False)
    kota = {
        "labels": list(kota_g.index),
        "jual": [round(v) for v in kota_g["jual"]],
        "laba": [round(v) for v in kota_g["laba"]],
        "qty": [round(v) for v in kota_g["qty"]],
    }

    return {
        "ov": ov, "daily": daily, "barang_laba": barang_laba, "barang_rugi": barang_rugi,
        "salesman": salesman, "kota": kota, "customer": customer,
        "_meta": {"skipped_cols": skipped_cols, "rugi_count": len(barang_rugi["labels"])},
    }


def _kpi_html(ov: dict) -> str:
    laba_color = "#4ade80" if ov["laba"] >= 0 else "#f87171"
    return f"""<div class="kpi"><div class="k">NILAI JUAL</div><div class="v">{fmt_rp(ov['jual'])}</div><div class="d">{fmt_int(ov['nota'])} nota</div></div>
<div class="kpi"><div class="k">HPP</div><div class="v">{fmt_rp(ov['hpp'])}</div><div class="d">harga pokok penjualan</div></div>
<div class="kpi"><div class="k">LABA KOTOR</div><div class="v" style="color:{laba_color}">{fmt_rp(ov['laba'])}</div><div class="d g">margin {ov['margin']}%</div></div>
<div class="kpi"><div class="k">PRODUK RUGI</div><div class="v" style="color:#f87171">{ov['rugi_count']}</div><div class="d r">dari {fmt_int(ov['barang'])} produk terjual</div></div>
<div class="kpi"><div class="k">TOKO TERLAYANI</div><div class="v">{fmt_int(ov['cust'])}</div><div class="d">customer aktif</div></div>
<div class="kpi"><div class="k">SALESMAN</div><div class="v">{fmt_int(ov['sales'])}</div><div class="d">terlibat transaksi ini</div></div>"""


def _note_html(meta: dict) -> str:
    if not meta["skipped_cols"]:
        return ""
    cols = ", ".join(meta["skipped_cols"])
    return f"""<div class="note">
&#8505; <b>Catatan:</b> Kolom {cols} tidak terisi di file ini, jadi tidak dibuatkan chart.
</div>"""


def _rugi_html(barang_rugi: dict) -> str:
    if not barang_rugi["labels"]:
        return '<div class="s" style="padding:20px 0">&#9989; Tidak ada produk rugi pada periode ini &mdash; semua produk terjual di atas HPP + biaya lain.</div>'
    rows = ""
    for i, (nama, jual, laba) in enumerate(zip(barang_rugi["labels"], barang_rugi["jual"], barang_rugi["laba"]), start=1):
        rows += (f'<tr><td><span class="rank rr">{i}</span></td><td>{nama}</td>'
                 f'<td class="num">{fmt_rp(jual)}</td><td class="num rd">-{fmt_rp(abs(laba))}</td></tr>')
    return f"""<table><thead><tr><th>#</th><th>Produk</th><th class="num">Nilai Jual</th><th class="num">Kerugian</th></tr></thead><tbody>{rows}</tbody></table>"""


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Laba Rugi Penjualan</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#0f0d1a;--card:#1a1530;--card2:#150f26;--bd:#2a2148;--tx:#ede9fe;--mut:#a5a3c4;--dim:#6b6890;--ac:#f472b6;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#3d1a2e;color:var(--ac);border:1px solid #5c2645;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#1a0a14;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi .k{font-size:11px;color:var(--mut);margin-bottom:8px}
.kpi .v{font-size:24px;font-weight:800;color:#fff;line-height:1}
.kpi .d{font-size:11px;margin-top:6px;color:var(--dim)}
.kpi .d.g{color:var(--gr)} .kpi .d.r{color:var(--rd)}
.sec{margin-bottom:14px}
.sec-h{font-size:12px;letter-spacing:2px;color:var(--ac);text-transform:uppercase;font-weight:700;margin:26px 0 12px}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:1fr 1fr}
.g21{grid-template-columns:2fr 1fr}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
.card.warn{border-color:#7c2d12;background:linear-gradient(135deg,#2a1410,var(--card))}
.card h3{font-size:14px;font-weight:700;margin-bottom:4px}
.card .s{font-size:11px;color:var(--dim);margin-bottom:14px}
.chart{width:100%;height:300px}
.chart.tall{height:380px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;border-bottom:2px solid var(--bd)}
td{padding:10px 12px;border-bottom:1px solid var(--bd)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.rd{color:var(--rd);font-weight:700}
.rank{display:inline-flex;width:22px;height:22px;background:var(--bd);border-radius:6px;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--mut)}
.rank.rr{background:#4c1d1d;color:var(--rd)}
.note{background:#241c3d;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:20px;line-height:1.6}
.hidden{display:none}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--bd);color:var(--dim);font-size:11px;text-align:center}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Laba Rugi Penjualan</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="trend">Tren Harian</div>
<div class="chip on" data-t="produk">Produk Untung</div>
<div class="chip on" data-t="rugi">Produk Rugi</div>
<div class="chip on" data-t="salesman">Salesman</div>
<div class="chip on" data-t="kota">Per Kota</div>
<div class="chip on" data-t="customer">Customer</div>
</div>

__NOTE__

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="trend">
<div class="sec-h">&#9656; Tren Harian</div>
<div class="card"><h3>Nilai Jual vs Laba per Hari</h3><div class="s">Batang = nilai jual, garis = laba</div><div id="c_trend" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="produk">
<div class="sec-h">&#9656; Produk Paling Menguntungkan</div>
<div class="card"><h3>Top 15 Produk by Laba</h3><div class="s">Diurutkan dari laba tertinggi</div><div id="c_produk" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="rugi">
<div class="sec-h">&#9656; &#9888; Produk Merugi &mdash; Perlu Perhatian</div>
<div class="card warn"><h3>Produk dengan Laba Negatif</h3><div class="s">Jual di bawah HPP + biaya lain &mdash; pertimbangkan review harga/diskon</div>
__RUGI_TABLE__
</div>
</div>

<div class="sec" data-sec="salesman">
<div class="sec-h">&#9656; Kinerja Salesman</div>
<div class="card"><h3>Laba per Salesman</h3><div class="s">Kontribusi laba, bukan sekadar omzet</div><div id="c_sales" class="chart"></div></div>
</div>

<div class="sec" data-sec="kota">
<div class="sec-h">&#9656; Per Kota</div>
<div class="grid g21">
<div class="card"><h3>Nilai Jual per Kota</h3><div class="s">Kota terlayani</div><div id="c_kota" class="chart"></div></div>
<div class="card"><h3>Proporsi</h3><div class="s">% kontribusi</div><div id="c_kota_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="customer">
<div class="sec-h">&#9656; Top Customer</div>
<div class="card"><h3>15 Toko Paling Menguntungkan</h3><div class="s">by laba, bukan omzet</div><div id="c_cust" class="chart tall"></div></div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmt = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(1)+' jt':Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#a5a3c4'},axisLine:{lineStyle:{color:'#2a2148'}},splitLine:{lineStyle:{color:'#2a2148'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#150f26',borderColor:'#2a2148',textStyle:{color:'#ede9fe'}};
const PAL=['#f472b6','#a78bfa','#818cf8','#38bdf8','#22d3ee','#4ade80','#facc15','#fb923c'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_trend',{tooltip:tt,legend:{data:['Nilai Jual','Laba'],textStyle:{color:'#a5a3c4'},top:0},grid,
xAxis:{type:'category',data:D.daily.labels,...AX},
yAxis:[{type:'value',...AX,axisLabel:{color:'#a5a3c4',formatter:v=>fmtS(v)}},{type:'value',...AX,splitLine:{show:false}}],
series:[{name:'Nilai Jual',type:'bar',data:D.daily.jual,itemStyle:{color:'#a78bfa',borderRadius:[4,4,0,0]}},
{name:'Laba',type:'line',yAxisIndex:1,data:D.daily.laba,smooth:true,lineStyle:{color:'#4ade80',width:2},itemStyle:{color:'#4ade80'}}]});

mk('c_produk',{tooltip:{...tt,formatter:p=>p[0].name+'<br>Laba: '+fmt(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.barang_laba.labels].reverse(),...AX,axisLabel:{color:'#a5a3c4',fontSize:10,width:220,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#a5a3c4',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.barang_laba.laba].reverse(),itemStyle:{color:'#f472b6',borderRadius:[0,4,4,0]}}]});

mk('c_sales',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
xAxis:{type:'category',data:D.salesman.labels,...AX,axisLabel:{color:'#a5a3c4',fontSize:10,rotate:25}},
yAxis:{type:'value',...AX,axisLabel:{color:'#a5a3c4',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.salesman.laba,itemStyle:{color:'#a78bfa',borderRadius:[4,4,0,0]}}]});

mk('c_kota',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmt(p[0].value)},grid,
yAxis:{type:'category',data:[...D.kota.labels].reverse(),...AX,axisLabel:{color:'#a5a3c4',fontSize:11}},
xAxis:{type:'value',...AX,axisLabel:{color:'#a5a3c4',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.kota.jual].reverse(),itemStyle:{color:'#38bdf8',borderRadius:[0,4,4,0]}}]});
mk('c_kota_pie',{tooltip:{trigger:'item',backgroundColor:'#150f26',borderColor:'#2a2148',textStyle:{color:'#ede9fe'},formatter:p=>p.name+'<br>'+fmt(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:['40%','70%'],data:D.kota.labels.map((l,i)=>({name:l,value:D.kota.jual[i]})),label:{color:'#a5a3c4',fontSize:10},itemStyle:{borderColor:'#1a1530',borderWidth:2},color:PAL}]});

mk('c_cust',{tooltip:{...tt,formatter:p=>p[0].name+'<br>Laba: '+fmt(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.customer.labels].reverse(),...AX,axisLabel:{color:'#a5a3c4',fontSize:10,width:150,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#a5a3c4',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.customer.laba].reverse(),itemStyle:{color:'#4ade80',borderRadius:[0,4,4,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    meta = data["_meta"]
    ov = {**ov, "rugi_count": meta["rugi_count"]}
    sub = f"Periode {ov['ps']} s/d {ov['pe']}"

    html = TEMPLATE
    html = html.replace("__SUBTITLE__", sub)
    html = html.replace("__BADGE__", f"&#9679; Data aktual &mdash; {fmt_int(ov['nota'])} nota")
    html = html.replace("__NOTE__", _note_html(meta))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__RUGI_TABLE__", _rugi_html(data["barang_rugi"]))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
