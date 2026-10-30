"""Tujuan: Form "Summary Program On Faktur" (ringkas, mengikuti contoh pemilik) dari summary_program JSON -> PDF.
Caller: router Summary (/summary/program/form). Dependensi: reportlab (Helvetica + Symbol, font standar PDF), PyMuPDF (gabung per principal).
Main Functions: form_pdf(daftar (doc, urut_master), dibuat) -> bytes; susun/baris_seksi (letak isi), jenis_beban (warna).
Side Effects: tidak ada; bytes PDF dikembalikan ke pemanggil.

Letak isi = prototipe tmp/summary_program_okt26/rakit_form.py (HTML + Edge) yang disetujui pemilik 29 Okt 2026; produksi tidak
punya browser, jadi tata letaknya digambar ulang dengan ReportLab:
- judul 5 baris + kepala kolom di SETIAP halaman, "Hal. x dari y" per principal (nomor mulai 1 tiap principal);
- warna kepala: COKLAT semua beban principal, PINK principal + distributor, MERAH semua beban distributor;
- satu blok program tidak dipotong antar halaman bila muat; tanda tangan ikut blok terakhir;
- catatan seksi, legenda CR, dan peringatan masuk kolom Update keterangan (bukan baris di bawah seksi);
- teks kiri/kanan yang lebih tinggi meregangkan baris barang (tanpa ruang kosong di bawah blok).
"""
import io
import os
import re
from collections import Counter, defaultdict
from datetime import date
from xml.sax.saxutils import escape

import fitz
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle

BULAN = "JAN FEB MAR APR MEI JUN JUL AGT SEP OKT NOV DES".split()
BULAN_PANJANG = "JANUARI FEBRUARI MARET APRIL MEI JUNI JULI AGUSTUS SEPTEMBER OKTOBER NOVEMBER DESEMBER".split()
SUB = 60  # area benefit = 60 sub-kolom, habis dibagi 1..6 kolom ketentuan
KRITIS = ("kritis", "perlu_cek")
WARNA = {"COKLAT": "#d2b48c", "PINK": "#f4b8c8", "MERAH": "#e88080"}
W_KIRI, W_BEN, W_KANAN = [2.4, 6.4, 6.4, 3.2, 5.4, 4.6, 7.0, 8.0, 4.2], 32.4, [10.0, 10.0]  # % lebar, TEMPLATE hal. 14
HAL = landscape(A4)
KIRI, KANAN, ATAS, BAWAH = 7 * mm, 7 * mm, 5 * mm, 7 * mm
LEBAR = HAL[0] - KIRI - KANAN
LEBAR_KOLOM = [LEBAR * w / 100 for w in W_KIRI] + [LEBAR * W_BEN / 100 / SUB] * SUB + [LEBAR * w / 100 for w in W_KANAN]
NK = len(LEBAR_KOLOM)  # 71
B0, B1 = len(W_KIRI), len(W_KIRI) + SUB  # kolom benefit = B0..B1-1
GRID, ABU, KUNING = colors.HexColor("#808080"), colors.HexColor("#e6e6e6"), colors.HexColor("#fff2cc")
PAD = 2.0


def gaya(ukuran=6.5, tebal=False, rata="LEFT"):
    return ParagraphStyle("f", fontName="Helvetica-Bold" if tebal else "Helvetica", fontSize=ukuran, leading=ukuran * 1.15,
                          alignment={"LEFT": 0, "CENTER": 1, "RIGHT": 2}[rata])


def rapikan(t):
    """Tanda & angka seragam di seluruh form (pemilik 29 Okt): '2.5%' -> '2,5%', '25.0%' -> '25%', '->' -> '→', '>=' -> '≥'."""
    t = re.sub(r",0+%", "%", re.sub(r"(\d)\.(\d+)%", r"\1,\2%", t))
    return t.replace("->", "→").replace(">=", "≥")


def e(s):
    """Helvetica (= Arial contoh pemilik) tak punya → dan ≥ (bukan WinAnsi); keduanya ada di font Symbol standar PDF, tanpa font tambahan."""
    t = escape(rapikan(str(s).replace("TIDAK_TERCANTUM", "TIDAK TERCANTUM")))
    return t.replace("→", '<font name="Symbol">→</font>').replace("≥", '<font name="Symbol">≥</font>')


def tgl(s, tahun=True):
    if not s:
        return None
    d = date.fromisoformat(s)
    return f"{d.day:02d} {BULAN[d.month - 1]}" + (f" {d.year}" if tahun else "")


def rentang(a, b, ringkas=False):
    if not (a and b):
        return tgl(a) or tgl(b)
    return f"{tgl(a, not (ringkas and a[:4] == b[:4]))} - {tgl(b)}"


def gabung(vals):
    """Gabung teks variant/gramasi dengan koma, buang duplikat (per potongan), urutan dipertahankan."""
    out = []
    for v in vals:
        for t in (v or "").split(","):
            if t.strip() and t.strip() not in out:
                out.append(t.strip())
    return ", ".join(out)


AKRONIM = {"EDT", "EDP", "EXDP", "PMD", "SR", "HM", "FM", "UHT", "MTC", "HER", "AS", "N", "BND", "GT", "MT", "J"}
CR = re.compile(r"^(\d+\+\d+),? \(?CR ([\d.,]+%)\)?$")  # "3+1 (CR 25.0%)" -> sel "3+1", CR ke keterangan (contoh pemilik)


def judul_kata(s):
    return " ".join(w if (w.upper() in AKRONIM or not re.search(r"[AEIOU]", w.upper())) else w.capitalize() for w in s.split())


def merek(kel):
    """'BLAGIO HM - ROLL ON' -> ('BLAGIO HM', 'ROLL ON'); kelompok gabungan 'A; B' / 'A, B' -> beberapa merek.
    ' & ' bukan pemisah: bagian dari nama ('PIATTOS - BIG & CRISPY')."""
    out, awal = [], set()
    for k in re.split(r";\s*|,\s*", kel or ""):
        m, _, sub = k.strip().partition(" - ")
        bag = sub.split(" - ")
        if len(bag) > 1 and bag[0] in awal:  # 'TOILET', 'TOILET - 3P' -> 'TOILET', '3P'
            sub = " - ".join(bag[1:])
        awal.add(bag[0])
        out.append((m.strip(), sub.strip()))
    return out


def sub_sebagian(b):
    """'KING BEEF, KING STICK, KING BALL - NET': sub-kelompok hanya milik sebagian merek -> tetap di Kelompok, bukan Variant."""
    ps = merek(b["kelompok_barang"])
    return len({m for m, _ in ps}) > 1 and len({bool(s) for _, s in ps}) > 1


def label_merek(kel_list):
    ms = []
    for kel in kel_list:
        for m, _ in merek(kel):
            if m not in ms:
                ms.append(m)
    if len(ms) > 1 and len({m.split()[0] for m in ms if m}) == 1:  # CSBNCA FM & CSBNCA HM -> CSBNCA FM & HM
        ms = [ms[0]] + [m.split(None, 1)[1] if " " in m else m for m in ms[1:]]
    return " & ".join(ms) if len(ms) <= 2 else ", ".join(ms[:-1]) + " & " + ms[-1]


def label_baris(b):
    """Kolom Kelompok: merek; rule lintas > 3 merek (mis. 'ALL PRODUK POWDER (BIB)') -> nama di surat, merek pindah ke Variant."""
    ms = list(dict.fromkeys(m for m, _ in merek(b["kelompok_barang"])))
    if len(ms) > 3:
        return re.sub(r"\(\s*(.*?)\s*\)", r"(\1)", b["nama_di_surat"].upper())
    if sub_sebagian(b):
        ps = list(dict.fromkeys(f"{m} - {s}" if s else m for m, s in merek(b["kelompok_barang"])))
        return ", ".join(ps[:-1]) + " & " + ps[-1]
    return label_merek([b["kelompok_barang"]])


def nama_variant(b):
    ms = list(dict.fromkeys(m for m, _ in merek(b["kelompok_barang"])))
    if len(ms) > 3:
        return ", ".join(judul_kata(m) for m in ms)
    subs = [] if sub_sebagian(b) else [judul_kata(s) for _, s in merek(b["kelompok_barang"]) if s]
    v = b["variant"] if b.get("variant") and b["variant"].strip().upper() not in ("ALL VARIANT", "SEMUA VARIAN") else ""
    if subs and not v and b.get("variant") and any(not s for _, s in merek(b["kelompok_barang"])):
        return "All variant, termasuk " + " & ".join(dict.fromkeys(subs))  # 'NDB, NDB - GURIMI' (ABCPI 29 Okt)
    if not subs and not v:
        return "All variant" if b.get("variant") else b["nama_di_surat"]
    return " ".join(x for x in [" & ".join(dict.fromkeys(subs)), judul_kata(v)] if x)


def ringkas_daftar(teks, subs, batas=180):
    """Daftar variant terlalu panjang -> sub-kelompok + 'all variant'; kode tetap lengkap di JSON."""
    if len(teks) <= batas:
        return teks
    subs = list(dict.fromkeys(judul_kata(s) for s in subs if s))
    return (", ".join(subs) + " - all variant") if subs else f"All variant ({len(teks.split(', '))} varian)"


def memuat(sel, t):  # sel = satu teks atau beberapa teks lapis digabung " + "
    return sel == t or f" + {t} + " in f" + {sel} + "


def kunci_barang(r):
    b = r["barang"]
    return tuple(sorted(b["kode_barang"])) or (b["kelompok_barang"], b["nama_di_surat"])


def baris_seksi(ds, urut_master):
    """Rule seksi tampilan -> baris: per barang (kode sama) -> vektor teks per kolom; gabung bila merek + vektor sama."""
    kol = [k for k, _ in ds["kolom"]]
    lines = []
    for r, k, lapis in sorted(ds["rules"], key=lambda x: not x[0]["barang"]["kode_barang"]):  # rule tanpa kode terakhir
        key, t = kunci_barang(r), r["benefit"]["teks_tampilan"]
        if not r["barang"]["kode_barang"]:  # rule tanpa kode ikut baris barang bernama sama, bila ada
            key = next((ln["key"] for ln in lines if (ln["barang"]["kelompok_barang"], ln["barang"]["nama_di_surat"])
                        == (r["barang"]["kelompok_barang"], r["barang"]["nama_di_surat"]) and k not in ln["sel"]), key)
        ln = next((x for x in lines if x["key"] == key and (k not in x["sel"] or x["sel"][k] == t or x["lapis"][k] != lapis)), None)
        if ln is None:
            ln = {"key": key, "barang": r["barang"], "sel": {}, "lapis": {}, "rules": []}
            lines.append(ln)
        if k in ln["sel"] and ln["lapis"][k] != lapis and not memuat(ln["sel"][k], t):
            ln["sel"][k] += " + " + t
        else:
            ln["sel"][k] = t
        ln["lapis"][k] = lapis
        ln["rules"].append((r, k))
    grup = {}  # (merek, vektor) -> baris barang; dict menjaga urutan surat
    for ln in lines:
        grup.setdefault((label_baris(ln["barang"]), tuple(ln["sel"].get(k) for k in kol)), []).append(ln)
    rows = []
    for (kel, vec), lns in grup.items():
        lns.sort(key=lambda x: min((urut_master.get(k, 1e9) for k in x["barang"]["kode_barang"]), default=1e9))
        gram = gabung(re.sub(r"(?i)(\d)gr\b", r"\1GR", x["barang"]["gramasi"] or "") for x in lns)
        rows.append({"kelompok": kel, "vec": vec, "rules": [rk for x in lns for rk in x["rules"]],
                     "variant": ringkas_daftar(gabung(nama_variant(x["barang"]) for x in lns),
                                               [s for x in lns for _, s in merek(x["barang"]["kelompok_barang"])]),
                     "gramasi": gram if len(gram.split(", ")) <= 5 else "All gramasi"})
    ids = [r["rule_id"] for row in rows for r, _ in row["rules"]]
    if Counter(ids) != Counter(r["rule_id"] for r, _, _ in ds["rules"]):
        raise ValueError(f"{ds['id']}: rule tidak masuk tepat satu baris tampilan")
    return rows


def kepala(label):
    return label.split(" - ")[0].strip()


def susun(doc):
    """Program/seksi JSON -> blok tampilan seperti contoh pemilik (28 Okt). Data rule tidak diubah, hanya letak:
    (a) seksi program sama + outlet_khusus sama + jumlah kolom sama -> ditumpuk (teks sel digabung ' + ');
    (b) satu surat, >=2 seksi berkolom tunggal (mis. per channel) -> satu seksi, tiap seksi jadi kolom;
    (c) seksi berkolom tunggal yang barangnya bagian dari seksi sebelumnya -> kolom tambahan (bila < 6 kolom)
        atau satu baris 'SEMUA SKU DI ATAS' (bila teksnya seragam)."""
    per_rule = defaultdict(list)
    for r in doc["item_rules"]:
        per_rule[r["section_id"]].append(r)
    grup = {}
    for p in doc["programs"]:
        grup.setdefault(p["no_surat"], []).append(p)
    blok = []
    for progs in grup.values():
        unit = []
        for p in progs:
            for s in p["sections"]:
                kol = [(k["kolom_id"], k["label"]) for k in s["kolom"]]
                rs = [(r, r["kolom_id"], s["section_id"]) for r in per_rule[s["section_id"]]]
                u = dict(p=p, label=s["label"], outlet=s["outlet_khusus"], kolom=kol, rules=rs, catatan=list(s["catatan"]), id=s["section_id"])
                prev = unit[-1] if unit else None
                if prev and prev["p"] is p and s["outlet_khusus"] and prev["outlet"] == s["outlet_khusus"] and len(prev["kolom"]) == len(kol):
                    peta = {k: pk for (k, _), (pk, _) in zip(kol, prev["kolom"])}
                    prev["rules"] += [(r, peta[k], lap) for r, k, lap in rs]
                    prev["catatan"] += [c for c in s["catatan"] if c not in prev["catatan"]]
                    if len(kol) > 1:
                        prev["kolom"] = [(pk, f"{pl} + {kepala(lb)}" if kepala(lb) not in pl else pl) for (pk, pl), (_, lb) in zip(prev["kolom"], kol)]
                    continue
                unit.append(u)
        tunggal = [u for u in unit if len(u["kolom"]) == 1]
        if len(tunggal) >= 2:
            tunggal.sort(key=lambda u: u["p"]["channel"] == "MT")
            mayor = Counter(u["kolom"][0][1] for u in tunggal).most_common(1)[0][0]
            gab = dict(p=tunggal[0]["p"], outlet=None, id=tunggal[0]["id"], catatan=[], kolom=[], rules=[],
                       label=(tunggal[0]["label"].split(" - ", 1)[-1] if " - " in tunggal[0]["label"] else tunggal[0]["label"]))
            for u in tunggal:
                key, lab = u["kolom"][0]
                head = u["outlet"] or kepala(u["label"])
                gab["kolom"].append((key, head if lab == mayor else f"{head}: {lab}"))
                gab["rules"] += u["rules"]
                gab["catatan"] += [c for c in u["catatan"] if c not in gab["catatan"]]
            pos = unit.index(tunggal[0])
            unit = [u for u in unit if u not in tunggal]
            unit.insert(min(pos, len(unit)), gab)
        for i in range(len(unit) - 1, 0, -1):
            u, prev = unit[i], unit[i - 1]
            kel_prev = {r["barang"]["kelompok_barang"] for r, _, _ in prev["rules"]}
            if len(u["kolom"]) != 1 or prev["p"] is not u["p"] or not {r["barang"]["kelompok_barang"] for r, _, _ in u["rules"]} <= kel_prev:
                continue
            teks = {r["benefit"]["teks_tampilan"] for r, _, _ in u["rules"]}
            if len(prev["kolom"]) < 6:
                prev["kolom"].append((u["kolom"][0][0], u["kolom"][0][1]))
                prev["rules"] += u["rules"]
            elif len(teks) == 1:
                prev["semua"] = (f"{u['label']}: {teks.pop()}", [r for r, _, _ in u["rules"]])
            else:
                continue
            prev["catatan"] += [c for c in u["catatan"] if c not in prev["catatan"]]
            del unit[i]
        blok.append((progs, unit))
    return blok


def meta_blok(progs):
    """Sel kiri/kanan blok: ringkas seperti contoh pemilik; isi lengkap tetap di JSON."""
    p0 = progs[0]
    nama = os.path.commonprefix([p["nama_program"] for p in progs]).rstrip(" -(") if len(progs) > 1 else p0["nama_program"]
    nama = re.sub(r"\s*-\s*Channel$", "", nama) or p0["nama_program"]
    chan = " & ".join(dict.fromkeys(c for p in progs for c in re.split(r"\s*&\s*", p["channel"] or "") if c))

    def outlet_teks(p):
        o = p["outlet"]
        if o["tipe"] == "tanpa_list":
            return "Tanpa list"
        return f"Hanya list ({len(o['kode_outlet'])} toko)" if o["kode_outlet"] else "Hanya list (belum diunggah)"
    tipe = Counter(outlet_teks(p) for p in progs).most_common(1)[0][0]
    beda = [f"{kepala(p['sections'][0]['label'])}: {outlet_teks(p).lower()}" for p in progs if p["sections"] and outlet_teks(p) != tipe]
    pers = list(dict.fromkeys(rentang(p["periode"]["mulai"], p["periode"]["selesai"], ringkas=True) or "TIDAK TERCANTUM" for p in progs))
    batas = list(dict.fromkeys(tgl(p["syarat_claim"]["batas_klaim_tanggal"])
                               or re.sub(r"^Tidak tercantum di surat - ikut ketentuan klaim principal$", "tidak tercantum (ikut ketentuan principal)",
                                         p["syarat_claim"]["batas_klaim_aturan"] or "")
                               or ("tidak tercantum" if p["syarat_claim"]["ada_klaim"] else "- (tanpa klaim)") for p in progs))
    dok = list(dict.fromkeys(d for p in progs for d in p["syarat_claim"]["dokumen"]))
    dasar = list(dict.fromkeys(x for p in progs for x in p["syarat_claim"]["dasar_nilai"] if x != "TIDAK_TERCANTUM"))
    klaim = ", ".join(dok) + (f". Nilai klaim: {'/'.join(dasar)}." if dasar else "")
    ket = list(dict.fromkeys(k for p in progs for k in p["keterangan"]))
    return nama, chan, (tipe, "; ".join(beda)), " / ".join(pers), ("Batas: " + "; ".join(batas), klaim), ket


def jenis_beban(doc):
    """Pemilik 29 Okt: semua beban principal -> COKLAT; principal + distributor -> PINK; semua beban distributor -> MERAH.
    Rule tanpa komponen (bonus barang) dihitung beban principal: bonusnya diklaim ke principal."""
    dist = {k["beban"] == "distributor" for r in doc["item_rules"] for k in r["benefit"]["komponen"] or [{"beban": "principal"}]}
    if dist == {True}:
        return "BEBAN DISTRIBUTOR", "MERAH"
    return ("BEBAN PRINCIPLE DAN DISTRIBUTOR", "PINK") if True in dist else ("BEBAN PRINCIPLE", "COKLAT")


# ---------------------------------------------------------------- gambar

def P(teks, **kw):
    return Paragraph(teks, gaya(**kw))


def _lebar(c0, c1):
    return sum(LEBAR_KOLOM[c0:c1 + 1])


def _tinggi(sel, c0, c1):
    return (sel.wrap(_lebar(c0, c1) - 2 * PAD, 10000)[1] if isinstance(sel, Paragraph) else 0) + 2 * PAD


def _blok_tabel(progs, unit, urut_master, kuning_rule, catatan_flag, nomor):
    """Satu blok program -> Table 71 kolom. Sel kiri (surat..periode) dan kanan (syarat, keterangan) merentang seluruh baris blok."""
    rows, span, gaya_t, item = [], [], [], []
    catatan = []
    for ds in unit:
        kol, n = [k for k, _ in ds["kolom"]], len(ds["kolom"])
        if not 1 <= n <= 6:
            raise ValueError(f"{ds['id']}: {n} kolom ketentuan (maks. 6)")
        w = SUB // n
        r0 = len(rows)
        baris = [""] * NK
        baris[6] = P(e(ds["label"]) + ' <font name="Symbol">→</font>'
                     + (f'<br/><font size="6">Outlet: {e(ds["outlet"])}</font>' if ds.get("outlet") else ""), tebal=True)
        span.append(((6, r0), (8, r0)))
        for j, (_, lab) in enumerate(ds["kolom"]):
            baris[B0 + j * w] = P(e(lab), tebal=True, rata="CENTER")
            span.append(((B0 + j * w, r0), (B0 + (j + 1) * w - 1, r0)))
        gaya_t += [("BACKGROUND", (0, r0), (0, r0), ABU), ("BACKGROUND", (6, r0), (B1 - 1, r0), ABU)]
        rows.append(baris)
        cr = {}
        data = baris_seksi(ds, urut_master)
        for i, row in enumerate(data):
            nomor += 1
            ri = len(rows)
            item.append(ri)
            baris = [""] * NK
            baris[0] = P(str(nomor), rata="CENTER")
            if i == 0 or data[i - 1]["kelompok"] != row["kelompok"]:
                lagi = next((j for j in range(i + 1, len(data)) if data[j]["kelompok"] != row["kelompok"]), len(data)) - i
                baris[6] = P(e(row["kelompok"]))
                if lagi > 1:
                    span.append(((6, ri), (6, ri + lagi - 1)))
            baris[7], baris[8] = P(e(row["variant"])), P(e(row["gramasi"]), rata="CENTER")
            kuning = {k for r, k in row["rules"] if r["rule_id"] in kuning_rule}
            vec = []
            for v in row["vec"]:
                m = CR.match(v or "")
                if m:
                    cr.setdefault(m[1], m[2])
                vec.append(m[1] if m else v)
            isi = lambda v, ks: e(v if v is not None else "-") + (" (!)" if kuning & ks else "")
            uk = 6.1 if n >= 5 else 6.5
            if n > 1 and vec[0] is not None and len(set(vec)) == 1:  # benefit sama di semua kolom -> satu sel
                baris[B0] = P(isi(vec[0], set(kol)), rata="CENTER", ukuran=uk)
                span.append(((B0, ri), (B1 - 1, ri)))
                if kuning:
                    gaya_t.append(("BACKGROUND", (B0, ri), (B1 - 1, ri), KUNING))
            else:
                for j, (k, v) in enumerate(zip(kol, vec)):
                    baris[B0 + j * w] = P(isi(v, {k}), rata="CENTER", ukuran=uk)
                    span.append(((B0 + j * w, ri), (B0 + (j + 1) * w - 1, ri)))
                    if k in kuning:
                        gaya_t.append(("BACKGROUND", (B0 + j * w, ri), (B0 + (j + 1) * w - 1, ri), KUNING))
            rows.append(baris)
        if ds.get("semua"):  # seksi ikutan bertekst seragam -> satu baris lintas kolom (lock volume Vinda)
            teks, rs = ds["semua"]
            nomor += 1
            ri = len(rows)
            item.append(ri)
            baris = [""] * NK
            baris[0], baris[6] = P(str(nomor), rata="CENTER"), P("SEMUA SKU DI ATAS")
            baris[7], baris[8] = P(e(gabung(nama_variant(r["barang"]) for r in rs))), P("Semua gramasi", rata="CENTER")
            baris[B0] = P(e(teks), rata="CENTER")
            span.append(((B0, ri), (B1 - 1, ri)))
            rows.append(baris)
        # pemilik 29 Okt: catatan seksi, legenda CR, peringatan -> kolom Update keterangan, bukan baris di bawah seksi
        catatan += ds["catatan"] + (["CR paket: " + " · ".join(f"{k} = {v}" for k, v in cr.items())] if cr else [])
        catatan += [f"PERLU CEK: {m}" for m in catatan_flag[ds["id"]]]
    nama, chan, (tipe, beda), per, (batas, klaim), ket = meta_blok(progs)
    ket = " ".join(k if k.endswith(".") else k + "." for k in dict.fromkeys(ket + catatan))
    L = len(rows)
    kiri = [P(e(progs[0]["no_surat"])), P(e(nama)), P(e(chan), rata="CENTER"),
            P(f"<b>{e(tipe)}</b>" + (f'<br/><font size="6">({e(beda)})</font>' if beda else ""), rata="CENTER"), P(e(per), rata="CENTER")]
    for c, sel in enumerate(kiri, 1):
        rows[0][c] = sel
        span.append(((c, 0), (c, L - 1)))
    rows[0][B1], rows[0][B1 + 1] = P(f"<b>{e(batas)}</b><br/>{e(klaim)}"), P(e(ket))
    span += [((B1, 0), (B1, L - 1)), ((B1 + 1, 0), (B1 + 1, L - 1))]
    # tinggi baris: isi sel biasa; bila sel rentang (kiri/kanan/kelompok) lebih tinggi, selisihnya dibagi ke baris barang
    tinggi = [max([_tinggi(rows[r][c], c, c) for c in range(NK) if not any(a[1] <= r <= b[1] and a[0] <= c <= b[0] for a, b in span)]
                  + [_tinggi(rows[r][a[0]], a[0], b[0]) for a, b in span if a[1] == b[1] == r] + [8]) for r in range(L)]
    for (c0, r0), (c1, r1) in span:
        if r1 > r0 and rows[r0][c0]:
            kurang = _tinggi(rows[r0][c0], c0, c1) - sum(tinggi[r0:r1 + 1])
            dalam = [r for r in item if r0 <= r <= r1] or list(range(r0, r1 + 1))
            if kurang > 0:
                for r in dalam:
                    tinggi[r] += kurang / len(dalam)
    t = Table(rows, colWidths=LEBAR_KOLOM, rowHeights=tinggi)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, GRID), ("LINEABOVE", (0, 0), (-1, 0), 1.6, colors.black),
                           ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), PAD),
                           ("RIGHTPADDING", (0, 0), (-1, -1), PAD), ("TOPPADDING", (0, 0), (-1, -1), PAD),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), PAD)] + [("SPAN", a, b) for a, b in span] + gaya_t))
    return t, nomor


def _kepala_kolom(warna):
    h = [""] * NK
    h[0], h[1], h[2], h[3], h[5], h[6], h[B0], h[B1], h[B1 + 1] = (P(x, tebal=True, rata="CENTER") for x in (
        "No.", "Surat program", "Nama program", "Channel outlet", "Periode", "Barang",
        'Ketentuan pengambilan <font name="Symbol">→</font> benefit', "Syarat claim", "Update keterangan"))
    h2 = [""] * NK
    h2[3], h2[4], h2[6], h2[7], h2[8] = (P(x, tebal=True, rata="CENTER") for x in ("GT / MT", "Daftar outlet", "Kelompok barang", "Variant barang", "Gramasi barang"))
    h2[B0] = P("<i>Judul kolom ada di baris abu-abu tiap program</i>", rata="CENTER", ukuran=6)
    t = Table([h, h2], colWidths=LEBAR_KOLOM)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, GRID), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(WARNA[warna])),
                           ("LINEBELOW", (0, 1), (-1, 1), 1.6, colors.black), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                           ("LEFTPADDING", (0, 0), (-1, -1), PAD), ("RIGHTPADDING", (0, 0), (-1, -1), PAD),
                           ("TOPPADDING", (0, 0), (-1, -1), PAD), ("BOTTOMPADDING", (0, 0), (-1, -1), PAD)]
                          + [("SPAN", (c, 0), (c, 1)) for c in (0, 1, 2, 5, B1, B1 + 1)]
                          + [("SPAN", (3, 0), (4, 0)), ("SPAN", (6, 0), (8, 0)), ("SPAN", (B0, 0), (B1 - 1, 0)), ("SPAN", (B0, 1), (B1 - 1, 1))]))
    return t


class _Kanvas(canvas.Canvas):
    """Dua lintasan: halaman disimpan dulu, lalu 'Hal. x dari y' ditulis saat jumlah halaman sudah diketahui."""
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._hal = []

    def showPage(self):
        self._hal.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        for st in self._hal:
            self.__dict__.update(st)
            self.setFont("Helvetica", 6)
            self.drawRightString(HAL[0] - KANAN, BAWAH / 2, f"Hal. {self._pageNumber} dari {len(self._hal)}")
            super().showPage()
        super().save()


def _principal_pdf(doc, urut_master, dibuat):
    beban, warna = jenis_beban(doc)
    blok = susun(doc)
    seksi_rule = {r["rule_id"]: ds["id"] for _, unit in blok for ds in unit for r, _, _ in ds["rules"]}
    seksi_prog = {p["program_id"]: unit[-1]["id"] for progs, unit in blok for p in progs}
    kuning, catatan_flag, umum = set(), defaultdict(list), []
    for f in doc["flags"]:
        if f["tingkat"] not in KRITIS:
            continue
        if f["rule_id"] in seksi_rule:
            kuning.add(f["rule_id"])
            catatan_flag[seksi_rule[f["rule_id"]]].append(f["pesan"])
        elif f["program_id"] in seksi_prog:
            catatan_flag[seksi_prog[f["program_id"]]].append(f["pesan"])
        else:
            umum.append(f["pesan"])
    tabel, nomor = [], 0
    for progs, unit in blok:
        t, nomor = _blok_tabel(progs, unit, urut_master, kuning, catatan_flag, nomor)
        tabel.append(t)
    if umum:
        t = Table([[P(e("PERLU CEK: " + m))] for m in umum], colWidths=[LEBAR])
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, GRID), ("BACKGROUND", (0, 0), (-1, -1), KUNING)]))
        tabel.append(t)
    ttd = [("Dibuat oleh,", "Admin"), ("Diketahui oleh,", "SM"), ("Diketahui oleh,", "Kepala Accounting"),
           ("Diperiksa oleh,", "Claim"), ("Disetujui oleh,", "Operational Manager")]
    kota = f"Makassar, {dibuat.day:02d} {BULAN_PANJANG[dibuat.month - 1]} {dibuat.year}"
    tt = Table([[P(kota)] + [""] * 4, [P(a, rata="CENTER") for a, _ in ttd], [""] * 5, [P("(.............................)", rata="CENTER")] * 5,
                [P(b, tebal=True, rata="CENTER") for _, b in ttd]], colWidths=[LEBAR / 5] * 5, rowHeights=[None, None, 6 * mm, None, None])
    tt.setStyle(TableStyle([("SPAN", (0, 0), (-1, 0))]))
    akhir = tabel.pop() if tabel else Spacer(1, 1)
    isi = tabel + [KeepTogether([akhir, Spacer(1, 1.5 * mm), tt])]  # tanda tangan tak pernah sendirian di halaman
    ps = doc["periode_summary"]
    kepala_t = _kepala_kolom(warna)
    tinggi_kepala = kepala_t.wrap(LEBAR, 1000)[1]
    tinggi_judul = 46

    def halaman(c, _doc):  # judul + kepala kolom di setiap halaman (pemilik 16 & 29 Okt)
        y = HAL[1] - ATAS
        c.setFont("Helvetica", 6)
        c.drawRightString(HAL[0] - KANAN, y - 6, f"Di print tgl : {dibuat.strftime('%d/%m/%Y')}")
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(HAL[0] / 2, y - 14, f"SUMMARY PROGRAM ON FAKTUR {beban} ({warna})")
        c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(HAL[0] / 2, y - 25, f"PRINCIPLE {doc['principal']}   PERIODE {rentang(ps['mulai'], ps['selesai']) or 'TIDAK TERCANTUM'}")
        c.drawCentredString(HAL[0] / 2, y - 35, "CV. SURYA PERKASA")
        c.setFont("Helvetica", 7)
        c.drawString(KIRI, y - 44, f"Dibuat tanggal : {dibuat.day:02d} {BULAN_PANJANG[dibuat.month - 1]} {dibuat.year} (ON PRINCIPLE {warna})")
        kepala_t.drawOn(c, KIRI, y - tinggi_judul - tinggi_kepala)

    out = io.BytesIO()
    dok = BaseDocTemplate(out, pagesize=HAL, leftMargin=KIRI, rightMargin=KANAN, topMargin=ATAS, bottomMargin=BAWAH,
                          title=f"Summary Program {doc['principal']}")
    frame = Frame(KIRI, BAWAH, LEBAR, HAL[1] - ATAS - BAWAH - tinggi_judul - tinggi_kepala, id="isi", leftPadding=0, rightPadding=0,
                  topPadding=0, bottomPadding=0)
    dok.addPageTemplates([PageTemplate(id="form", frames=[frame], onPage=halaman)])
    dok.build(isi, canvasmaker=_Kanvas)
    return out.getvalue()


def form_pdf(daftar, dibuat=None):
    """daftar = [(doc summary_program, {kode_barang: urutan master})]. Satu PDF; nomor halaman mulai 1 tiap principal."""
    dibuat = dibuat or date.today()
    with fitz.open() as gab:
        for doc, urut in daftar:
            with fitz.open(stream=_principal_pdf(doc, urut, dibuat), filetype="pdf") as bag:
                gab.insert_pdf(bag)
        return gab.tobytes(garbage=4, deflate=True)
