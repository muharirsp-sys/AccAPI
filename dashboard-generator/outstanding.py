"""Tujuan: Dashboard Outstanding Sales Order dengan chart offline/self-contained.
Caller: app.Api.generate dan test_outstanding.py.
Dependensi: pandas, shared formatter, assets/echarts.min.js via inline_echarts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.

AGING (hari menggantung) = tanggal_report - Tanggal_order, bucket 0-7/8-30/31-90/>90 hari.
tanggal_report dipakai max(Tanggal) di file (bukan tanggal sistem) -- itu tanggal SO paling
baru = proxy tanggal laporan digenerate. Satuan campur (CTN/PCS/RCG/BTL) -> Qty JANGAN
dijumlahkan lintas satuan, tampil per baris di tabel detail saja; agregat pakai Nilai Rupiah.
"""
import pandas as pd

from shared import fmt_rp, fmt_int, to_json, inline_echarts

BUCKETS = ["0-7 hari", "8-30 hari", "31-90 hari", ">90 hari"]


def _bucket(days: int) -> str:
    if days <= 7:
        return BUCKETS[0]
    if days <= 30:
        return BUCKETS[1]
    if days <= 90:
        return BUCKETS[2]
    return BUCKETS[3]


def build_data(df: pd.DataFrame) -> dict:
    str_cols = df.select_dtypes(include="object").columns
    df = df.assign(**{c: df[c].str.strip() for c in str_cols})

    report_date = df["Tanggal"].max()
    aging_days = (report_date - df["Tanggal"]).dt.days
    df = df.assign(_aging=aging_days, _bucket=aging_days.apply(_bucket))

    over90 = df[df["_aging"] > 90]

    ov = {
        "nilai": df["Nilai"].sum(),
        "so": int(df["No.SO"].nunique()),
        "cust": int(df["Nama Customer"].nunique()),
        "kota": int(df["Kota"].nunique()),
        "ps": df["Tanggal"].min().strftime("%Y-%m-%d"),
        "pe": df["Tanggal"].max().strftime("%Y-%m-%d"),
        "report_date": report_date.strftime("%Y-%m-%d"),
        "over90_n": int(len(over90)),
        "over90_nilai": round(over90["Nilai"].sum()),
    }

    aging_g = df.groupby("_bucket").agg(nilai=("Nilai", "sum"), n=("Nilai", "size")).reindex(BUCKETS).fillna(0)
    aging = {"labels": BUCKETS, "nilai": [round(v) for v in aging_g["nilai"]], "n": [int(v) for v in aging_g["n"]]}

    def agg_by(col, topn=None):
        g = df.groupby(col).agg(nilai=("Nilai", "sum"), qty=("Qty", "sum")).sort_values("nilai", ascending=False)
        if topn:
            g = g.head(topn)
        return {"labels": list(g.index), "nilai": [round(v) for v in g["nilai"]], "qty": [round(v) for v in g["qty"]]}

    job = agg_by("Nama Job")
    kota = agg_by("Kota")
    customer = agg_by("Nama Customer", 15)

    top_g = df.sort_values("Nilai", ascending=False).head(15)
    top_so = [
        {
            "so": r["No.SO"], "cust": r["Nama Customer"], "barang": r["Nama Barang"],
            "nilai": round(r["Nilai"]), "aging": int(r["_aging"]), "satuan": r["Satuan"], "qty": round(r["Qty"]),
        }
        for _, r in top_g.iterrows()
    ]

    return {
        "ov": ov, "aging": aging, "job": job, "kota": kota, "customer": customer, "top_so": top_so,
        "_meta": {},
    }


def _kpi_html(ov: dict) -> str:
    return f"""<div class="kpi"><div class="k">TOTAL NILAI OUTSTANDING</div><div class="v">{fmt_rp(ov['nilai'])}</div><div class="d">{fmt_int(ov['so'])} SO belum terpenuhi</div></div>
<div class="kpi"><div class="k">CUSTOMER MENUNGGU</div><div class="v">{fmt_int(ov['cust'])}</div><div class="d">di {fmt_int(ov['kota'])} kota</div></div>
<div class="kpi alert"><div class="k">&#9888; ORDER &gt;90 HARI</div><div class="v" style="color:#f87171">{fmt_int(ov['over90_n'])}</div><div class="d r">senilai {fmt_rp(ov['over90_nilai'])}</div></div>
<div class="kpi"><div class="k">PERIODE ORDER</div><div class="v" style="font-size:15px">{ov['ps']} &ndash; {ov['pe']}</div><div class="d">rentang tanggal order asli</div></div>"""


def _row_html(i: int, r: dict) -> str:
    aging_html = (f'<span style="color:#f87171;font-weight:700">&#9888; {r["aging"]} hari</span>'
                  if r["aging"] > 90 else f'{r["aging"]} hari')
    return (f'<tr><td><span class="rank">{i}</span></td><td>{r["so"]}</td><td>{r["cust"]}</td><td>{r["barang"]}</td>'
            f'<td class="num">{fmt_int(r["qty"])} {r["satuan"]}</td><td class="num">{fmt_rp(r["nilai"])}</td>'
            f'<td class="num">{aging_html}</td></tr>')


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Outstanding Sales Order</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#0d1420;--card:#16213a;--card2:#101a2e;--bd:#22335a;--tx:#e6ecf7;--mut:#9badd6;--dim:#5c74a3;--ac:#60a5fa;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#132549;color:var(--ac);border:1px solid #1e3a6e;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#08152b;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi.alert{border-color:#7c2d2d;background:linear-gradient(135deg,#2a1414,var(--card))}
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
.card.warn{border-color:#7c2d2d;background:linear-gradient(135deg,#251414,var(--card))}
.card h3{font-size:14px;font-weight:700;margin-bottom:4px}
.card .s{font-size:11px;color:var(--dim);margin-bottom:14px}
.chart{width:100%;height:300px}
.chart.tall{height:380px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:2px solid var(--bd)}
td{padding:8px 10px;border-bottom:1px solid var(--bd)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.rank{display:inline-flex;width:20px;height:20px;background:var(--bd);border-radius:5px;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--mut)}
.note{background:#101f38;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:14px;line-height:1.6}
.note.crit{border-left-color:var(--rd)}
.hidden{display:none}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Outstanding Sales Order</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="aging">&#9888; Aging Analysis</div>
<div class="chip on" data-t="job">Per Divisi/Job</div>
<div class="chip on" data-t="kota">Per Kota</div>
<div class="chip on" data-t="customer">Per Customer</div>
<div class="chip on" data-t="detail">Detail Order</div>
</div>

<div class="note">
&#8505; <b>Catatan satuan:</b> Qty di laporan ini pakai satuan campur (CTN, PCS, RCG, BTL) antar baris &mdash; total Qty TIDAK dijumlahkan langsung karena tidak setara. Nilai Rupiah tetap agregat yang valid; Qty ditampilkan per baris dengan satuannya di tabel detail.
</div>

<div class="sec" data-sec="overview">
<div class="kpis">
__KPIS__
</div>
</div>

<div class="sec" data-sec="aging">
<div class="sec-h">&#9656; &#9888; Aging Analysis &mdash; Paling Kritis</div>
<div class="card warn"><h3>Distribusi Umur Order Outstanding</h3><div class="s">Perhatikan pola fresh-vs-stuck di rentang tengah</div><div id="c_aging" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="job">
<div class="sec-h">&#9656; Per Divisi/Job</div>
<div class="card"><h3>Nilai Outstanding per Divisi</h3><div class="s">Job/divisi terlibat</div><div id="c_job" class="chart"></div></div>
</div>

<div class="sec" data-sec="kota">
<div class="sec-h">&#9656; Per Kota</div>
<div class="card"><h3>Nilai Outstanding per Kota</h3><div class="s">Kota terlibat</div><div id="c_kota" class="chart"></div></div>
</div>

<div class="sec" data-sec="customer">
<div class="sec-h">&#9656; Per Customer</div>
<div class="card"><h3>Top 15 Customer dengan Order Menggantung Terbesar</h3><div class="s">by nilai outstanding</div><div id="c_customer" class="chart tall"></div></div>
</div>

<div class="sec" data-sec="detail">
<div class="sec-h">&#9656; Detail 15 Order Terbesar</div>
<div class="card"><h3>Daftar Order Perlu Follow-up</h3><div class="s">Diurutkan by nilai &mdash; order &gt;90 hari ditandai merah</div>
<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>No SO</th><th>Customer</th><th>Barang</th><th class="num">Qty</th><th class="num">Nilai</th><th class="num">Umur</th></tr></thead><tbody>__ROWS__</tbody></table></div>
</div>
</div>

</div>

<script>
const D = __DATA_JSON__;
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(1)+' jt':Math.round(n).toLocaleString('id-ID');
const fmtR = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#9badd6'},axisLine:{lineStyle:{color:'#22335a'}},splitLine:{lineStyle:{color:'#22335a'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#101a2e',borderColor:'#22335a',textStyle:{color:'#e6ecf7'}};
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}

mk('c_aging',{tooltip:{...tt,formatter:p=>{const d=p[0];return d.name+'<br>'+fmtR(d.value)+' &middot; '+D.aging.n[d.dataIndex]+' order';}},grid,
xAxis:{type:'category',data:D.aging.labels,...AX},
yAxis:{type:'value',...AX,axisLabel:{color:'#9badd6',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.aging.nilai,itemStyle:{color:(p)=>p.dataIndex===3?'#f87171':'#60a5fa',borderRadius:[4,4,0,0]},barWidth:'55%'}]});

mk('c_job',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:[...D.job.labels].reverse(),...AX,axisLabel:{color:'#9badd6',fontSize:10,width:200,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#9badd6',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.job.nilai].reverse(),itemStyle:{color:'#818cf8',borderRadius:[0,4,4,0]}}]});

mk('c_kota',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:D.kota.labels,...AX,axisLabel:{color:'#9badd6',fontSize:10,width:100,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#9badd6',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:D.kota.nilai,itemStyle:{color:'#60a5fa',borderRadius:[4,4,0,0]}}]});

mk('c_customer',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid:{...grid,left:12},
yAxis:{type:'category',data:[...D.customer.labels].reverse(),...AX,axisLabel:{color:'#9badd6',fontSize:10,width:180,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#9badd6',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:[...D.customer.nilai].reverse(),itemStyle:{color:'#a78bfa',borderRadius:[0,4,4,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    html = TEMPLATE
    html = html.replace("__SUBTITLE__", f"Order Belum Terpenuhi &middot; per {ov['report_date']}")
    html = html.replace("__BADGE__", f"&#9679; {fmt_int(ov['so'])} SO outstanding")
    html = html.replace("__KPIS__", _kpi_html(ov))
    rows = "".join(_row_html(i, r) for i, r in enumerate(data["top_so"], start=1))
    html = html.replace("__ROWS__", rows)
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
