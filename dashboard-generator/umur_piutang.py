"""Tujuan: Dashboard Umur Piutang untuk prioritas collection dan risiko overdue.
Caller: app.Api.generate dan test_umur_piutang.py.
Dependensi: pandas, shared formatter/JSON/inline ECharts.
Main Functions: build_data, render_html, generate_dashboard.
Side Effects: Membaca asset ECharts lokal saat render HTML; output tidak memakai hardcoded nama perusahaan.
"""
import pandas as pd

from shared import fmt_int, fmt_rp, inline_echarts, to_json

BUCKETS = [
    ("Nilai Belum JT", "Belum JT"),
    ("Nilai JT 1", "JT 1"),
    ("Nilai JT 2", "JT 2"),
    ("Nilai JT 3", "JT 3"),
    ("Nilai JT 4", "JT 4"),
]
OVERDUE_COLS = ["Nilai JT 1", "Nilai JT 2", "Nilai JT 3", "Nilai JT 4"]
SEVERE_COLS = ["Nilai JT 3", "Nilai JT 4"]
TOPN = 15


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for col in out.select_dtypes(include="object").columns:
        out.loc[:, col] = out[col].map(lambda v: v.strip() if isinstance(v, str) else v)
    return out


def _report_date(df: pd.DataFrame) -> str:
    dates = (df["Tgl JT"] + pd.to_timedelta(df["Umur"], unit="D")).dt.date
    if dates.nunique() == 1:
        return dates.iloc[0].strftime("%Y-%m-%d")
    return dates.mode().iloc[0].strftime("%Y-%m-%d")


def _bucket_label(df: pd.DataFrame, col: str, label: str) -> str:
    umur = df.loc[df[col] != 0, "Umur"]
    if umur.empty:
        return label
    mn, mx = int(umur.min()), int(umur.max())
    if mn == mx:
        return f"{label} ({mn} hari)"
    return f"{label} ({mn}-{mx} hari)"


def _bucket_of(row: pd.Series) -> str:
    for col, label in reversed(BUCKETS):
        if row[col] != 0:
            return label
    return "-"


def _group_rows(df: pd.DataFrame, by, name_col=None, topn=TOPN, sort_col="nilai") -> list[dict]:
    g = df.groupby(by, dropna=False).agg(
        nilai=("Nilai", "sum"),
        belum=("Nilai Belum JT", "sum"),
        jt1=("Nilai JT 1", "sum"),
        jt2=("Nilai JT 2", "sum"),
        jt3=("Nilai JT 3", "sum"),
        jt4=("Nilai JT 4", "sum"),
        n=("No.Jurnal", "nunique"),
        cust=("Kode Customer", "nunique"),
        max_umur=("Umur", "max"),
    )
    g = g.assign(overdue=g[["jt1", "jt2", "jt3", "jt4"]].sum(axis=1), severe=g[["jt3", "jt4"]].sum(axis=1))
    g = g.sort_values(sort_col, ascending=False).head(topn)

    rows = []
    for idx, row in g.iterrows():
        if isinstance(idx, tuple):
            label = idx[-1] if name_col else " - ".join(str(x) for x in idx)
            code = idx[0]
        else:
            label = idx
            code = idx
        rows.append(
            {
                "code": "" if pd.isna(code) else str(code),
                "label": "(Kosong)" if pd.isna(label) or str(label).strip() == "" else str(label),
                "nilai": round(row["nilai"]),
                "belum": round(row["belum"]),
                "overdue": round(row["overdue"]),
                "severe": round(row["severe"]),
                "jt4": round(row["jt4"]),
                "n": int(row["n"]),
                "cust": int(row["cust"]),
                "max_umur": int(row["max_umur"]),
                "overdue_pct": round(row["overdue"] / row["nilai"] * 100, 1) if row["nilai"] else 0,
            }
        )
    return rows


def build_data(df: pd.DataFrame) -> dict:
    df = _clean(df)
    df = df.assign(
        _salesman=df["Nama Salesman"].fillna("(Belum ada salesman)").replace("", "(Belum ada salesman)"),
        _prefix=df["No.Jurnal"].astype(str).str.split("/").str[0],
        _overdue=df[OVERDUE_COLS].sum(axis=1),
        _severe=df[SEVERE_COLS].sum(axis=1),
    )

    total = df["Nilai"].sum()
    belum = df["Nilai Belum JT"].sum()
    overdue = df[OVERDUE_COLS].sum().sum()
    severe = df[SEVERE_COLS].sum().sum()
    credits = df.loc[df["Nilai"] < 0, "Nilai"].sum()
    debits = df.loc[df["Nilai"] > 0, "Nilai"].sum()

    bucket_rows = []
    for col, label in BUCKETS:
        nilai = df[col].sum()
        bucket_rows.append(
            {
                "label": _bucket_label(df, col, label),
                "short": label,
                "nilai": round(nilai),
                "n": int((df[col] != 0).sum()),
                "pct": round(nilai / total * 100, 1) if total else 0,
            }
        )

    ov = {
        "nilai": total,
        "debit": debits,
        "credit": credits,
        "belum": belum,
        "overdue": overdue,
        "severe": severe,
        "jt4": df["Nilai JT 4"].sum(),
        "doc": int(df["No.Jurnal"].nunique()),
        "cust": int(df["Kode Customer"].nunique()),
        "sales": int(df["Kode Salesman"].nunique(dropna=True)),
        "credit_rows": int((df["Nilai"] < 0).sum()),
        "overdue_pct": round(overdue / total * 100, 1) if total else 0,
        "severe_pct": round(severe / total * 100, 1) if total else 0,
        "ps": df["Tanggal"].min().strftime("%Y-%m-%d"),
        "pe": df["Tanggal"].max().strftime("%Y-%m-%d"),
        "due_min": df["Tgl JT"].min().strftime("%Y-%m-%d"),
        "due_max": df["Tgl JT"].max().strftime("%Y-%m-%d"),
        "report_date": _report_date(df),
        "max_umur": int(df["Umur"].max()),
    }

    customer = _group_rows(df, ["Kode Customer", "Nama Customer"], name_col="Nama Customer", sort_col="nilai")
    severe_customer = _group_rows(df, ["Kode Customer", "Nama Customer"], name_col="Nama Customer", sort_col="severe")
    salesman = _group_rows(df, "_salesman", sort_col="nilai")
    kota = _group_rows(df, "Kota Customer", sort_col="nilai")
    job = _group_rows(df, "Nama Job", sort_col="nilai")
    prefix = _group_rows(df, "_prefix", sort_col="nilai")

    detail_src = df[df["Nilai"] > 0].copy()
    detail_src = detail_src.sort_values(["_severe", "_overdue", "Umur", "Nilai"], ascending=[False, False, False, False]).head(20)
    detail = [
        {
            "jurnal": row["No.Jurnal"],
            "customer": row["Nama Customer"],
            "salesman": row["_salesman"],
            "due": row["Tgl JT"].strftime("%Y-%m-%d"),
            "umur": int(row["Umur"]),
            "bucket": _bucket_of(row),
            "nilai": round(row["Nilai"]),
            "overdue": round(row["_overdue"]),
            "severe": round(row["_severe"]),
        }
        for _, row in detail_src.iterrows()
    ]

    return {
        "ov": ov,
        "bucket": bucket_rows,
        "customer": customer,
        "severe_customer": severe_customer,
        "salesman": salesman,
        "kota": kota,
        "job": job,
        "prefix": prefix,
        "detail": detail,
        "_meta": {"baris": int(len(df)), "salesman_blank_nilai": round(df.loc[df["_salesman"] == "(Belum ada salesman)", "Nilai"].sum())},
    }


def _kpi_html(ov: dict) -> str:
    return f"""<div class="kpi"><div class="k">TOTAL PIUTANG NET</div><div class="v">{fmt_rp(ov['nilai'])}</div><div class="d">{fmt_int(ov['doc'])} dokumen, {fmt_int(ov['cust'])} customer</div></div>
<div class="kpi warn"><div class="k">SUDAH JATUH TEMPO</div><div class="v">{fmt_rp(ov['overdue'])}</div><div class="d r">{ov['overdue_pct']}% dari piutang</div></div>
<div class="kpi"><div class="k">BELUM JATUH TEMPO</div><div class="v">{fmt_rp(ov['belum'])}</div><div class="d">masih current</div></div>
<div class="kpi alert"><div class="k">RISIKO JT 3 + JT 4</div><div class="v">{fmt_rp(ov['severe'])}</div><div class="d r">{ov['severe_pct']}% butuh follow-up ketat</div></div>
<div class="kpi"><div class="k">KREDIT / RETUR</div><div class="v">{fmt_rp(abs(ov['credit']))}</div><div class="d">{fmt_int(ov['credit_rows'])} baris pengurang piutang</div></div>
<div class="kpi"><div class="k">UMUR TERTUA</div><div class="v">{fmt_int(ov['max_umur'])} hari</div><div class="d">as-of {ov['report_date']}</div></div>"""


def _note_html(ov: dict, meta: dict) -> str:
    parts = [
        f'Tanggal aging dihitung dari <b>Tgl JT + Umur</b>; seluruh baris konsisten as-of <b>{ov["report_date"]}</b>. Nama file/export boleh berbeda, jadi dashboard memakai tanggal aging internal ini.',
        f'Baris DK=K/nilai negatif diperlakukan sebagai pengurang piutang; total kredit/retur {fmt_rp(abs(ov["credit"]))}.',
    ]
    if meta["salesman_blank_nilai"]:
        parts.append(f'Nilai tanpa Nama Salesman tetap ditampilkan sebagai "(Belum ada salesman)": {fmt_rp(meta["salesman_blank_nilai"])}.')
    return f'<div class="note">&#8505; <b>Catatan data:</b> {" ".join(parts)}</div>'


def _summary_table(rows: list[dict], mode: str = "customer") -> str:
    if not rows:
        return '<div class="empty">Tidak ada data untuk section ini.</div>'
    label = "Customer" if mode == "customer" else "Nama"
    body = ""
    for i, row in enumerate(rows, start=1):
        body += (
            f'<tr><td><span class="rank">{i}</span></td><td>{row["label"]}</td>'
            f'<td class="num">{fmt_rp(row["nilai"])}</td><td class="num rd">{fmt_rp(row["overdue"])}</td>'
            f'<td class="num">{fmt_rp(row["severe"])}</td><td class="num">{fmt_int(row["n"])}</td>'
            f'<td class="num">{fmt_int(row["max_umur"])}</td></tr>'
        )
    return f'<table><thead><tr><th>#</th><th>{label}</th><th class="num">Piutang</th><th class="num">Overdue</th><th class="num">JT3+JT4</th><th class="num">Dok</th><th class="num">Max Umur</th></tr></thead><tbody>{body}</tbody></table>'


def _detail_rows(rows: list[dict]) -> str:
    body = ""
    for i, row in enumerate(rows, start=1):
        cls = "rd" if row["severe"] > 0 else ""
        body += (
            f'<tr><td><span class="rank">{i}</span></td><td>{row["jurnal"]}</td><td>{row["customer"]}</td>'
            f'<td>{row["salesman"]}</td><td>{row["due"]}</td><td class="num {cls}">{fmt_int(row["umur"])} hari</td>'
            f'<td>{row["bucket"]}</td><td class="num">{fmt_rp(row["nilai"])}</td><td class="num rd">{fmt_rp(row["overdue"])}</td></tr>'
        )
    return body


TEMPLATE = r"""<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Umur Piutang</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
:root{--bg:#0b1117;--card:#121d26;--card2:#0d1720;--bd:#203243;--tx:#e7edf3;--mut:#9fb3c8;--dim:#60758c;--ac:#38bdf8;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.badge{background:#0f2a38;color:var(--ac);border:1px solid #1d4c63;font-size:11px;padding:5px 12px;border-radius:20px;font-weight:600}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#07141f;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi.warn{border-color:#63481d;background:linear-gradient(135deg,#211b0e,var(--card))}
.kpi.alert{border-color:#733232;background:linear-gradient(135deg,#241414,var(--card))}
.kpi .k{font-size:11px;color:var(--mut);margin-bottom:8px}
.kpi .v{font-size:23px;font-weight:800;color:#fff;line-height:1}
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
.chart{width:100%;height:320px}
.chart.tall{height:410px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:9px 10px;border-bottom:2px solid var(--bd)}
td{padding:9px 10px;border-bottom:1px solid var(--bd)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.rd{color:var(--rd);font-weight:700}
.rank{display:inline-flex;width:20px;height:20px;background:var(--bd);border-radius:5px;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--mut)}
.note{background:#10212e;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:18px;line-height:1.6}
.empty{color:var(--dim);font-size:12px;padding:12px 0}
.hidden{display:none}
@media(max-width:820px){.g2,.g21{grid-template-columns:1fr}.wrap{padding:16px}}
</style>
</head>
<body>
<div class="wrap">
<header>
<div><h1>Dashboard Umur Piutang</h1><div class="sub">__SUBTITLE__</div></div>
<div class="badge">__BADGE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section (klik untuk sembunyikan / tampilkan)</div>
<div class="chip on" data-t="overview">Ringkasan</div>
<div class="chip on" data-t="aging">Aging Bucket</div>
<div class="chip on" data-t="customer">Customer</div>
<div class="chip on" data-t="collection">Prioritas Tagih</div>
<div class="chip on" data-t="salesman">Salesman</div>
<div class="chip on" data-t="wilayah">Wilayah/Job</div>
<div class="chip on" data-t="dokumen">Tipe Dokumen</div>
<div class="chip on" data-t="detail">Detail Follow-up</div>
</div>

__NOTE__

<div class="sec" data-sec="overview"><div class="kpis">__KPIS__</div></div>

<div class="sec" data-sec="aging">
<div class="sec-h">&#9656; Aging Bucket</div>
<div class="grid g21">
<div class="card"><h3>Nilai Piutang per Bucket Umur</h3><div class="s">Bucket memakai kolom aging dari laporan Accurate</div><div id="c_bucket" class="chart"></div></div>
<div class="card"><h3>Proporsi Bucket</h3><div class="s">Komposisi net outstanding</div><div id="c_bucket_pie" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="customer">
<div class="sec-h">&#9656; Customer Exposure</div>
<div class="grid g2">
<div class="card"><h3>Top 15 Customer by Total Piutang</h3><div class="s">Customer dengan nominal outstanding terbesar</div><div id="c_customer" class="chart tall"></div></div>
<div class="card"><h3>Top 15 Customer by JT3+JT4</h3><div class="s">Prioritas risiko umur piutang lebih tua</div><div id="c_severe_customer" class="chart tall"></div></div>
</div>
<div class="card" style="margin-top:14px"><h3>Ringkasan Customer Terbesar</h3><div class="s">Termasuk overdue dan umur maksimum per customer</div>__CUSTOMER_TABLE__</div>
</div>

<div class="sec" data-sec="collection">
<div class="sec-h">&#9656; Prioritas Collection</div>
<div class="card"><h3>Customer dengan Nilai JT3+JT4 Tertinggi</h3><div class="s">Jika kosong berarti tidak ada piutang di bucket tua</div>__SEVERE_TABLE__</div>
</div>

<div class="sec" data-sec="salesman">
<div class="sec-h">&#9656; Follow-up per Salesman</div>
<div class="card"><h3>Piutang per Salesman</h3><div class="s">Baris tanpa salesman tetap terlihat sebagai "(Belum ada salesman)"</div><div id="c_salesman" class="chart"></div></div>
</div>

<div class="sec" data-sec="wilayah">
<div class="sec-h">&#9656; Wilayah dan Job</div>
<div class="grid g2">
<div class="card"><h3>Piutang per Kota</h3><div class="s">Distribusi geografis customer</div><div id="c_kota" class="chart"></div></div>
<div class="card"><h3>Piutang per Job/Principal</h3><div class="s">Mayoritas nilai biasanya terkonsentrasi pada job tertentu</div><div id="c_job" class="chart"></div></div>
</div>
</div>

<div class="sec" data-sec="dokumen">
<div class="sec-h">&#9656; Tipe Dokumen</div>
<div class="card"><h3>Net Piutang per Prefix Dokumen</h3><div class="s">INV/SAP/RJN membantu membedakan invoice, saldo awal, dan retur/kredit</div><div id="c_prefix" class="chart"></div></div>
</div>

<div class="sec" data-sec="detail">
<div class="sec-h">&#9656; Detail Dokumen untuk Follow-up</div>
<div class="card"><h3>20 Dokumen Prioritas</h3><div class="s">Diurutkan by JT3+JT4, overdue, umur, lalu nilai</div>
<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>No Jurnal</th><th>Customer</th><th>Salesman</th><th>Tgl JT</th><th class="num">Umur</th><th>Bucket</th><th class="num">Nilai</th><th class="num">Overdue</th></tr></thead><tbody>__DETAIL_ROWS__</tbody></table></div>
</div>
</div>

</div>
<script>
const D = __DATA_JSON__;
const fmtS = n => Math.abs(n)>=1e9?(n/1e9).toFixed(2)+' M':Math.abs(n)>=1e6?(n/1e6).toFixed(1)+' jt':Math.round(n).toLocaleString('id-ID');
const fmtR = n => 'Rp '+Math.round(n).toLocaleString('id-ID');
const AX={axisLabel:{color:'#9fb3c8'},axisLine:{lineStyle:{color:'#203243'}},splitLine:{lineStyle:{color:'#203243'}}};
const grid={left:12,right:20,top:30,bottom:20,containLabel:true};
const tt={trigger:'axis',backgroundColor:'#0d1720',borderColor:'#203243',textStyle:{color:'#e7edf3'}};
const colors=['#38bdf8','#fbbf24','#fb923c','#f87171','#ef4444'];
const charts=[];
function mk(id,opt){const e=document.getElementById(id);if(!e)return;const c=echarts.init(e);c.setOption(opt);charts.push(c);}
function labels(rows){return rows.map(r=>r.label)}
function values(rows,key){return rows.map(r=>r[key])}

mk('c_bucket',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)+' &middot; '+D.bucket[p[0].dataIndex].pct+'%'},grid,
xAxis:{type:'category',data:labels(D.bucket),...AX,axisLabel:{color:'#9fb3c8',fontSize:10,rotate:15}},
yAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.bucket,'nilai'),itemStyle:{color:p=>colors[p.dataIndex]||'#38bdf8',borderRadius:[4,4,0,0]}}]});

mk('c_bucket_pie',{tooltip:{trigger:'item',backgroundColor:'#0d1720',borderColor:'#203243',textStyle:{color:'#e7edf3'},formatter:p=>p.name+'<br>'+fmtR(p.value)+' ('+p.percent+'%)'},
series:[{type:'pie',radius:['42%','72%'],data:D.bucket.map(r=>({name:r.short,value:r.nilai})),label:{color:'#9fb3c8',fontSize:10},itemStyle:{borderColor:'#121d26',borderWidth:2},color:colors}]});

mk('c_customer',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:labels(D.customer).reverse(),...AX,axisLabel:{color:'#9fb3c8',fontSize:10,width:170,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.customer,'nilai').reverse(),itemStyle:{color:'#38bdf8',borderRadius:[0,4,4,0]}}]});

mk('c_severe_customer',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:labels(D.severe_customer).reverse(),...AX,axisLabel:{color:'#9fb3c8',fontSize:10,width:170,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.severe_customer,'severe').reverse(),itemStyle:{color:'#f87171',borderRadius:[0,4,4,0]}}]});

mk('c_salesman',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
yAxis:{type:'category',data:labels(D.salesman).reverse(),...AX,axisLabel:{color:'#9fb3c8',fontSize:11,width:170,overflow:'truncate'}},
xAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.salesman,'nilai').reverse(),itemStyle:{color:'#22d3ee',borderRadius:[0,4,4,0]}}]});

mk('c_kota',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:labels(D.kota),...AX,axisLabel:{color:'#9fb3c8',fontSize:10,width:120,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.kota,'nilai'),itemStyle:{color:'#4ade80',borderRadius:[4,4,0,0]}}]});

mk('c_job',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:labels(D.job),...AX,axisLabel:{color:'#9fb3c8',fontSize:10,width:150,overflow:'truncate'}},
yAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.job,'nilai'),itemStyle:{color:'#a78bfa',borderRadius:[4,4,0,0]}}]});

mk('c_prefix',{tooltip:{...tt,formatter:p=>p[0].name+'<br>'+fmtR(p[0].value)},grid,
xAxis:{type:'category',data:labels(D.prefix),...AX},
yAxis:{type:'value',...AX,axisLabel:{color:'#9fb3c8',formatter:v=>fmtS(v)}},
series:[{type:'bar',data:values(D.prefix,'nilai'),itemStyle:{color:p=>p.value<0?'#f87171':'#38bdf8',borderRadius:[4,4,0,0]}}]});

document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec){sec.classList.toggle('hidden');setTimeout(()=>charts.forEach(ch=>ch.resize()),50);}};});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    ov = data["ov"]
    html = TEMPLATE
    html = html.replace("__SUBTITLE__", f"Aging as-of {ov['report_date']} &middot; Transaksi {ov['ps']} s/d {ov['pe']}")
    html = html.replace("__BADGE__", f"&#9679; {fmt_int(ov['doc'])} dokumen piutang")
    html = html.replace("__NOTE__", _note_html(ov, data["_meta"]))
    html = html.replace("__KPIS__", _kpi_html(ov))
    html = html.replace("__CUSTOMER_TABLE__", _summary_table(data["customer"], "customer"))
    html = html.replace("__SEVERE_TABLE__", _summary_table(data["severe_customer"], "customer"))
    html = html.replace("__DETAIL_ROWS__", _detail_rows(data["detail"]))
    html = html.replace("__DATA_JSON__", to_json({k: v for k, v in data.items() if k != "_meta"}))
    return inline_echarts(html)


def generate_dashboard(df: pd.DataFrame) -> str:
    return render_html(build_data(df))
