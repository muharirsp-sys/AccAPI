"""Tujuan: Dashboard cross-analysis multi-file untuk cek overlap antar laporan.
Caller: app.Api.generate_cross dan test_cross_analysis.py.
Dependensi: pandas DataFrame dari laporan terdeteksi, shared formatter Rupiah/angka, html.escape.
Main Functions: has_supported_pair, supported_pair_labels, build_data, render_html, generate_dashboard.
Side Effects: Tidak ada; fungsi hanya mengembalikan HTML string tanpa hardcoded nama perusahaan.
"""
from html import escape

import pandas as pd

from shared import fmt_int, fmt_rp

REPORT_LABELS = {
    "Penjualan": "Penjualan",
    "LabaRugi": "Laba Rugi Penjualan",
    "PosisiStokGudang": "Posisi Stok",
    "AnalisaStok": "Analisa Stok",
    "Retur": "Retur Penjualan",
    "OutstandingSO": "Outstanding SO",
    "UmurPiutang": "Umur Piutang",
}

TOP_STOCK = 12
TOP_RISK = 15
TOP_WALLET = 15

SUPPORTED_DETAIL_PAIRS = (
    ("PosisiStokGudang", "AnalisaStok"),
    ("Retur", "OutstandingSO"),
    ("Penjualan", "LabaRugi"),
)


def has_supported_pair(jenis_list) -> bool:
    available = set(jenis_list)
    return any({left, right} <= available for left, right in SUPPORTED_DETAIL_PAIRS)


def supported_pair_labels() -> list[str]:
    return [f"{REPORT_LABELS[left]} + {REPORT_LABELS[right]}" for left, right in SUPPORTED_DETAIL_PAIRS]


def _clean_text_frame(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for col in out.select_dtypes(include="object").columns:
        out.loc[:, col] = out[col].map(lambda v: v.strip() if isinstance(v, str) else v)
    return out


def _key_series(series: pd.Series) -> pd.Series:
    return series.map(lambda v: "" if pd.isna(v) else str(v).strip())


def _value_set(df: pd.DataFrame, col: str) -> set[str]:
    if col not in df.columns:
        return set()
    vals = _key_series(df[col])
    vals = vals[~vals.str.lower().isin({"", "nan"})]
    return set(vals)


def _batch_count(series: pd.Series) -> int:
    vals = _key_series(series)
    vals = vals[~vals.str.lower().isin({"", "nan"})]
    return int(vals.nunique())


def _stock_analysis(posisi: pd.DataFrame, analisa: pd.DataFrame) -> dict:
    pos = posisi.assign(_kode=_key_series(posisi["Kode"]))
    ana = analisa.assign(_kode=_key_series(analisa["Kode"]))
    pos = pos[pos["_kode"] != ""]
    ana = ana[ana["_kode"] != ""]

    pos_g = pos.groupby("_kode").agg(nama=("Nama Barang", "first"), posisi_qty=("Saldo Akhir", "sum"))
    ana_g = ana.groupby("_kode").agg(
        nama_analisa=("Nama Barang", "first"),
        analisa_qty=("Saldo Akhir Qty", "sum"),
        batch=("No.Batch", _batch_count),
    )
    joined = pos_g.join(ana_g, how="inner")
    joined = joined.assign(diff=joined["analisa_qty"] - joined["posisi_qty"])
    ranked = joined.reindex(joined["diff"].abs().sort_values(ascending=False).index).head(TOP_STOCK)

    rows = [
        {
            "nama": row["nama"],
            "posisi_qty": int(round(row["posisi_qty"])),
            "analisa_qty": int(round(row["analisa_qty"])),
            "diff": int(round(row["diff"])),
            "batch": int(row["batch"]),
        }
        for _, row in ranked.iterrows()
    ]

    return {
        "total_posisi": int(round(posisi["Saldo Akhir"].sum())),
        "total_analisa": int(round(analisa["Saldo Akhir Qty"].sum())),
        "sku_total": int(max(pos_g.index.nunique(), ana_g.index.nunique())),
        "sku_overlap_name": len(_value_set(posisi, "Nama Barang") & _value_set(analisa, "Nama Barang")),
        "sku_selisih": int((joined["diff"] != 0).sum()),
        "rows": rows,
    }


def _risk_analysis(retur: pd.DataFrame, outstanding: pd.DataFrame) -> dict:
    ret = retur[retur["Nama Barang"].notna()].copy()
    out = outstanding[outstanding["Nama Barang"].notna()].copy()
    ret = ret.assign(_nama_barang=_key_series(ret["Nama Barang"]))
    out = out.assign(_nama_barang=_key_series(out["Nama Barang"]))

    ret_g = ret.groupby("_nama_barang").agg(retur_nilai=("Nilai Bruto", "sum"), retur_qty=("Qty", "sum"))
    out_g = out.groupby("_nama_barang").agg(outstanding_nilai=("Nilai", "sum"), outstanding_qty=("Qty", "sum"))
    joined = ret_g.join(out_g, how="inner")
    joined = joined.assign(total_risk=joined["retur_nilai"] + joined["outstanding_nilai"])
    ranked = joined.sort_values("total_risk", ascending=False).head(TOP_RISK)

    rows = [
        {
            "nama": nama,
            "retur_nilai": int(round(row["retur_nilai"])),
            "retur_qty": int(round(row["retur_qty"])),
            "outstanding_nilai": int(round(row["outstanding_nilai"])),
            "outstanding_qty": int(round(row["outstanding_qty"])),
        }
        for nama, row in ranked.iterrows()
    ]
    return {"overlap": int(len(joined)), "rows": rows}


def _wallet_analysis(penjualan: pd.DataFrame, labarugi: pd.DataFrame) -> dict:
    pen = penjualan.assign(
        _kode_customer=_key_series(penjualan["Kode Customer"]),
        _netto=penjualan["Nilai Bruto"] - penjualan["Nilai Disc"],
    )
    laba = labarugi.assign(_kode_customer=_key_series(labarugi["Kode Customer"]))
    pen = pen[pen["_kode_customer"] != ""]
    laba = laba[laba["_kode_customer"] != ""]

    pen_g = pen.groupby("_kode_customer").agg(nama=("Nama Customer", "first"), frisian_flag=("_netto", "sum"))
    laba_g = laba.groupby("_kode_customer").agg(nama_labarugi=("Nama Customer", "first"), softex=("Nilai Jual", "sum"))
    joined = pen_g.join(laba_g, how="inner")
    joined = joined.assign(total=joined["frisian_flag"] + joined["softex"])
    ranked = joined.sort_values("total", ascending=False).head(TOP_WALLET)

    rows = [
        {
            "nama": row["nama"],
            "frisian_flag": int(round(row["frisian_flag"])),
            "softex": int(round(row["softex"])),
            "total": int(round(row["total"])),
        }
        for _, row in ranked.iterrows()
    ]

    pen_keys = set(pen_g.index)
    laba_keys = set(laba_g.index)
    return {
        "both": int(len(joined)),
        "only_ff": int(len(pen_keys - laba_keys)),
        "only_sx": int(len(laba_keys - pen_keys)),
        "rows": rows,
    }


def _matrix_rows(reports: dict[str, pd.DataFrame], stock=None, risk=None, wallet=None) -> list[dict]:
    rows = []

    def add(label: str, overlap: int | str, unit: str, can_cross: str):
        if isinstance(overlap, int):
            overlap_text = f"{fmt_int(overlap)} {unit}"
        else:
            overlap_text = overlap
        rows.append({"label": label, "overlap": overlap_text, "can_cross": can_cross})

    if "PosisiStokGudang" in reports and "AnalisaStok" in reports:
        add(
            "Posisi Stok &times; Analisa Stok",
            f"{fmt_int(stock['sku_overlap_name'])}/{fmt_int(stock['sku_total'])} SKU",
            "",
            "YA" if stock["sku_overlap_name"] else "TIDAK",
        )

    if "Retur" in reports and "OutstandingSO" in reports:
        add("Retur Penjualan &times; Outstanding SO", risk["overlap"], "produk", "YA" if risk["overlap"] else "TIDAK")

    if "Penjualan" in reports and "LabaRugi" in reports:
        add("Penjualan &times; Laba Rugi Penjualan", wallet["both"], "customer", "YA" if wallet["both"] else "TIDAK")

    if "LabaRugi" in reports and "OutstandingSO" in reports:
        overlap = len(_value_set(reports["LabaRugi"], "Nama Barang") & _value_set(reports["OutstandingSO"], "Nama Barang"))
        add("Laba Rugi Penjualan &times; Outstanding SO", overlap, "produk", "YA (kecil)" if 0 < overlap <= 10 else ("YA" if overlap else "TIDAK"))

    if "Penjualan" in reports and ("PosisiStokGudang" in reports or "AnalisaStok" in reports):
        stock_names = _value_set(reports.get("PosisiStokGudang", pd.DataFrame()), "Nama Barang")
        stock_names |= _value_set(reports.get("AnalisaStok", pd.DataFrame()), "Nama Barang")
        overlap = len(_value_set(reports["Penjualan"], "Nama Barang") & stock_names)
        add("Penjualan &times; Posisi/Analisa Stok", overlap, "produk", "YA" if overlap else "TIDAK")

    if "LabaRugi" in reports and ("PosisiStokGudang" in reports or "AnalisaStok" in reports):
        stock_names = _value_set(reports.get("PosisiStokGudang", pd.DataFrame()), "Nama Barang")
        stock_names |= _value_set(reports.get("AnalisaStok", pd.DataFrame()), "Nama Barang")
        overlap = len(_value_set(reports["LabaRugi"], "Nama Barang") & stock_names)
        add("Laba Rugi Penjualan &times; Posisi/Analisa Stok", overlap, "produk", "YA" if overlap else "TIDAK")

    if "Penjualan" in reports and "Retur" in reports:
        overlap = len(_value_set(reports["Penjualan"], "Nama Barang") & _value_set(reports["Retur"], "Nama Barang"))
        add("Penjualan &times; Retur Penjualan (produk)", overlap, "produk", "YA" if overlap else "TIDAK")

    if "OutstandingSO" in reports and ("PosisiStokGudang" in reports or "AnalisaStok" in reports):
        stock_names = _value_set(reports.get("PosisiStokGudang", pd.DataFrame()), "Nama Barang")
        stock_names |= _value_set(reports.get("AnalisaStok", pd.DataFrame()), "Nama Barang")
        overlap = len(_value_set(reports["OutstandingSO"], "Nama Barang") & stock_names)
        add("Outstanding SO &times; Posisi/Analisa Stok", overlap, "produk", "YA" if overlap else "TIDAK")

    return rows


def build_data(reports: dict[str, pd.DataFrame]) -> dict:
    cleaned = {jenis: _clean_text_frame(df) for jenis, df in reports.items()}

    stock = None
    if "PosisiStokGudang" in cleaned and "AnalisaStok" in cleaned:
        stock = _stock_analysis(cleaned["PosisiStokGudang"], cleaned["AnalisaStok"])

    risk = None
    if "Retur" in cleaned and "OutstandingSO" in cleaned:
        risk = _risk_analysis(cleaned["Retur"], cleaned["OutstandingSO"])

    wallet = None
    if "Penjualan" in cleaned and "LabaRugi" in cleaned:
        wallet = _wallet_analysis(cleaned["Penjualan"], cleaned["LabaRugi"])

    return {
        "available": [REPORT_LABELS.get(jenis, jenis) for jenis in cleaned],
        "matrix": _matrix_rows(cleaned, stock=stock, risk=risk, wallet=wallet),
        "stock": stock,
        "risk": risk,
        "wallet": wallet,
    }


def _matrix_html(rows: list[dict]) -> str:
    if not rows:
        return '<div class="note no">Upload minimal 2 jenis laporan berbeda untuk mulai cek overlap.</div>'
    body = ""
    for row in rows:
        yes = row["can_cross"].startswith("YA")
        body += (
            f"<tr><td>{row['label']}</td><td class=\"num\">{row['overlap']}</td>"
            f"<td><span class=\"badge2 {'yes' if yes else 'no'}\">{row['can_cross']}</span></td></tr>"
        )
    return (
        '<table><thead><tr><th>Kombinasi Laporan</th><th class="num">Overlap</th>'
        f"<th>Bisa di-cross?</th></tr></thead><tbody>{body}</tbody></table>"
    )


def _stock_html(stock: dict) -> str:
    if not stock:
        return ""
    rows = ""
    for i, row in enumerate(stock["rows"], start=1):
        rows += (
            f'<tr><td><span class="rank">{i}</span></td><td>{escape(row["nama"])}</td>'
            f'<td class="num">{fmt_int(row["posisi_qty"])}</td>'
            f'<td class="num">{fmt_int(row["analisa_qty"])}</td>'
            f'<td class="num rd">{fmt_int(row["diff"])}</td>'
            f'<td class="num">{fmt_int(row["batch"])}</td></tr>'
        )

    return f"""
<div class="sec" data-sec="stok">
<div class="sec-h">&#9656; Rekonsiliasi: Posisi Stok vs Analisa Stok</div>
<div class="sec-desc">File Analisa Stok pecah per No.Batch, sementara Posisi Stok per Gudang adalah snapshot per gudang. Cross ini hanya dibuat karena SKU overlap nyata; selisih besar layak dicek ke parameter export Accurate.</div>
<div class="kpis">
<div class="kpi"><div class="k">TOTAL POSISI GUDANG</div><div class="v">{fmt_int(stock["total_posisi"])}</div><div class="d">unit dari laporan per-gudang</div></div>
<div class="kpi"><div class="k">TOTAL ANALISA STOK</div><div class="v">{fmt_int(stock["total_analisa"])}</div><div class="d">unit dari laporan per-batch</div></div>
<div class="kpi"><div class="k">SKU DENGAN SELISIH</div><div class="v" style="color:#f87171">{fmt_int(stock["sku_selisih"])}</div><div class="d">dari {fmt_int(stock["sku_total"])} total SKU</div></div>
</div>
<div class="card"><h3>Top {TOP_STOCK} SKU dengan Selisih Terbesar</h3><div class="s">Diurutkan by selisih absolut Qty Analisa vs Posisi</div>
<table><thead><tr><th>#</th><th>Produk</th><th class="num">Qty Gudang</th><th class="num">Qty Analisa</th><th class="num">Selisih</th><th class="num">Jml Batch</th></tr></thead><tbody>{rows}</tbody></table>
</div>
</div>"""


def _risk_html(risk: dict) -> str:
    if not risk:
        return ""
    rows = ""
    for i, row in enumerate(risk["rows"], start=1):
        rows += (
            f'<tr><td><span class="rank">{i}</span></td><td>{escape(row["nama"])}</td>'
            f'<td class="num rd">{fmt_rp(row["retur_nilai"])}</td>'
            f'<td class="num">{fmt_int(row["retur_qty"])}</td>'
            f'<td class="num">{fmt_rp(row["outstanding_nilai"])}</td>'
            f'<td class="num">{fmt_int(row["outstanding_qty"])}</td></tr>'
        )
    return f"""
<div class="sec" data-sec="risk">
<div class="sec-h">&#9656; Produk Risiko Ganda: Retur Penjualan &times; Outstanding SO</div>
<div class="sec-desc">{fmt_int(risk["overlap"])} produk muncul di kedua laporan. Produk ini sedang diretur customer dan masih punya order menggantung, jadi layak dicek sebagai sinyal kualitas/supply berulang.</div>
<div class="card"><h3>{TOP_RISK} Produk dengan Risiko Gabungan Terbesar</h3><div class="s">Diurutkan dari nilai retur + nilai outstanding</div>
<table><thead><tr><th>#</th><th>Produk</th><th class="num">Nilai Retur</th><th class="num">Qty Retur</th><th class="num">Nilai Outstanding</th><th class="num">Qty SO</th></tr></thead><tbody>{rows}</tbody></table>
</div>
</div>"""


def _wallet_html(wallet: dict) -> str:
    if not wallet:
        return ""
    rows = ""
    for i, row in enumerate(wallet["rows"], start=1):
        rows += (
            f'<tr><td><span class="rank">{i}</span></td><td>{escape(row["nama"])}</td>'
            f'<td class="num">{fmt_rp(row["frisian_flag"])}</td>'
            f'<td class="num">{fmt_rp(row["softex"])}</td>'
            f'<td class="num" style="font-weight:700">{fmt_rp(row["total"])}</td></tr>'
        )
    return f"""
<div class="sec" data-sec="wallet">
<div class="sec-h">&#9656; Wallet Share: Penjualan &times; Laba Rugi Penjualan per Customer</div>
<div class="sec-desc">Join memakai Kode Customer, bukan Nama Customer, supaya nama toko generik seperti TOKO/ACUN/AGUS tidak false-match. Nilai Penjualan memakai netto; Laba Rugi Penjualan memakai Nilai Jual.</div>
<div class="kpis">
<div class="kpi"><div class="k">TOKO BELI KEDUANYA</div><div class="v">{fmt_int(wallet["both"])}</div><div class="d">dual-category customer</div></div>
<div class="kpi"><div class="k">TOKO HANYA PENJUALAN</div><div class="v">{fmt_int(wallet["only_ff"])}</div><div class="d">ada di Penjualan, tidak di Laba Rugi</div></div>
<div class="kpi"><div class="k">TOKO HANYA LABA RUGI PENJUALAN</div><div class="v">{fmt_int(wallet["only_sx"])}</div><div class="d">ada di Laba Rugi Penjualan, tidak di Penjualan</div></div>
</div>
<div class="card"><h3>Top {TOP_WALLET} Toko Dual-Category by Total Belanja</h3><div class="s">Penjualan netto + Nilai Jual Laba Rugi dalam periode yang sama</div>
<table><thead><tr><th>#</th><th>Toko</th><th class="num">Penjualan</th><th class="num">Laba Rugi Penjualan</th><th class="num">Total</th></tr></thead><tbody>{rows}</tbody></table>
</div>
</div>"""


TEMPLATE = """<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cross-Dashboard Analysis</title>
<style>
:root{--bg:#0a0a12;--card:#16151f;--card2:#100f18;--bd:#2a2840;--tx:#eae8f5;--mut:#a8a3c9;--dim:#6b6690;--ac:#c084fc;--gr:#4ade80;--rd:#f87171;--am:#fbbf24;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px}
header{margin-bottom:8px}
h1{font-size:22px;font-weight:800}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:14px;background:var(--card2);border:1px solid var(--bd);border-radius:12px}
.toolbar .lbl{font-size:11px;color:var(--dim);width:100%;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}
.chip{background:var(--card);border:1px solid var(--bd);color:var(--mut);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;transition:.15s;user-select:none}
.chip:hover{border-color:var(--ac);color:var(--tx)}
.chip.on{background:var(--ac);color:#1a0a2b;border-color:var(--ac);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:16px}
.kpi{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--bd);border-radius:14px;padding:18px}
.kpi .k{font-size:11px;color:var(--mut);margin-bottom:8px}
.kpi .v{font-size:22px;font-weight:800;color:#fff;line-height:1}
.kpi .d{font-size:11px;margin-top:6px;color:var(--dim)}
.sec{margin-bottom:14px}
.sec-h{font-size:13px;letter-spacing:1px;color:var(--ac);text-transform:uppercase;font-weight:700;margin:28px 0 6px}
.sec-desc{font-size:12px;color:var(--dim);margin-bottom:14px;line-height:1.6}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
.card h3{font-size:14px;font-weight:700;margin-bottom:4px}
.card .s{font-size:11px;color:var(--dim);margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--mut);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:9px 10px;border-bottom:2px solid var(--bd)}
td{padding:9px 10px;border-bottom:1px solid var(--bd)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.rd{color:var(--rd);font-weight:700}
.rank{display:inline-flex;width:20px;height:20px;background:var(--bd);border-radius:5px;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--mut)}
.note{background:#1c1830;border-left:3px solid var(--am);padding:12px 14px;border-radius:8px;font-size:12px;color:var(--mut);margin-bottom:16px;line-height:1.6}
.note.no{border-left-color:var(--rd)}
.hidden{display:none}
.badge2{display:inline-block;font-size:10px;padding:3px 9px;border-radius:12px;font-weight:700;margin-left:6px}
.badge2.yes{background:#0e2a1a;color:var(--gr)}
.badge2.no{background:#2a1414;color:var(--rd)}
@media(max-width:820px){.wrap{padding:16px}table{font-size:11px}}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>Cross-Dashboard Analysis</h1>
<div class="sub">Analisa silang antar laporan - hanya pasangan dengan overlap nyata yang dibuat section-nya</div>
<div class="sub">File terbaca: __AVAILABLE__</div>
</header>

<div class="toolbar">
<div class="lbl">Tampilkan section</div>
__CHIPS__
</div>

<div class="sec" data-sec="matrix">
<div class="sec-h">&#9656; Matriks Overlap Data</div>
<div class="sec-desc">Cek kelayakan sebelum cross dipaksakan. Overlap 0 tidak dibuatkan section agar tidak menghasilkan insight palsu.</div>
<div class="card">__MATRIX__</div>
</div>

__SECTIONS__
</div>
<script>
document.querySelectorAll('.chip').forEach(c=>{c.onclick=()=>{c.classList.toggle('on');const sec=document.querySelector('[data-sec="'+c.dataset.t+'"]');if(sec)sec.classList.toggle('hidden');};});
</script>
</body>
</html>"""


def render_html(data: dict) -> str:
    chips = ['<div class="chip on" data-t="matrix">Matriks Overlap</div>']
    sections = ""
    if data["stock"]:
        chips.append('<div class="chip on" data-t="stok">Rekonsiliasi Stok</div>')
        sections += _stock_html(data["stock"])
    if data["risk"]:
        chips.append('<div class="chip on" data-t="risk">Retur Penjualan &times; Outstanding SO</div>')
        sections += _risk_html(data["risk"])
    if data["wallet"]:
        chips.append('<div class="chip on" data-t="wallet">Wallet Share Customer</div>')
        sections += _wallet_html(data["wallet"])
    if not sections:
        sections = '<div class="note no">Belum ada pasangan file dengan overlap yang layak dibuat section detail.</div>'

    html = TEMPLATE
    html = html.replace("__AVAILABLE__", ", ".join(escape(v) for v in data["available"]))
    html = html.replace("__CHIPS__", "\n".join(chips))
    html = html.replace("__MATRIX__", _matrix_html(data["matrix"]))
    html = html.replace("__SECTIONS__", sections)
    return html


def generate_dashboard(reports: dict[str, pd.DataFrame]) -> str:
    return render_html(build_data(reports))
