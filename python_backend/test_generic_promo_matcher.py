"""
Self-check matcher generik (0 API, jalankan: python test_generic_promo_matcher.py).

Mengunci kasus NYATA dari surat FONTERRA/NATUR yang pernah salah UNMATCHED
padahal item-nya ADA di master (diagnosa 2026-07-19), + kasus yang memang
TIDAK ada di master dan WAJIB tetap UNMATCHED (jangan sampai fix bikin over-match).
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shared
from generic_promo_pipeline import RULES, prepare_items, match_line

RM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "rebuild_master")

# (principle, baris surat, potongan nama master yang WAJIB kena)
MUST_MATCH = [
    ("FONTERRA", "ANLENE GOLD HABBATUSAUDA 580 GR", "HABATUSSAUDA 580GR"),
    ("NATUR", "AZALEA ZAITUN OIL ROSEHIP 135ML", "ROSESHIP OIL 24 PCS X 150ML /135ML"),
    ("NATUR", "AZALEA SHAMPOO GINSENG 180 ML", "SHMP Z.OIL&G.EXRACT 48 PCS X 180ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM ALOEVERA 60ML", "H.RECOVERY A.VERA OIL 24 PCS X 60ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM OLIVEOIL 60ML", "H.RECOVERY OLIVE OIL 24 PCS X 60ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM GINSENG 60ML", "H.RECOVERY GINSENG OIL 24 PCS X 60ML"),
    ("NATUR", "HG FOR MEN F.WASH BRIGHT&DC 100ML 24'S", "HG F.WASH BRIGHTENGING & D.CLEANSING 24 PCS X 100ML"),
    ("NATUR", "HG FOR MEN FACIAL WASH BRIGHTENING & DEEP CLEANSING 100 ML", "HG F.WASH BRIGHTENGING & D.CLEANSING 24 PCS X 100ML"),
    ("NATUR", "HG FOR MEN F.WASH ACNE CR&OC 100ML 24'S", "HG F.WASH ACNE & OIL CONTROL 24 PCS X 100ML"),
    ("NATUR", "NATUR 2IN1 SHAMPOO & TONIC GINSENG", "NATUR 2IN1 GINSENG"),
    ("NATUR", "HG SHM FOR MEN 180ML", "HG SHAMPOO FOR MAN 48 PCS X 180ML"),
    ("NATUR", "HG - TONIC FOR MAN 90ML", "HG TONIC FOR MAN 48 PCS X 90ML"),
    # ADNA/Gumindo: "varian apa saja" -> semua varian pada gramasi itu; satu baris
    # surat boleh menyebut DUA gramasi ("150 gr/ 140 gr").
    ("ADNA", "Kuaci Rebo 70 gr", "KUACI ORIGINAL 70GR"),
    ("ADNA", "Kuaci Rebo 150 gr/ 140 gr", "KUACI ORIGINAL 150GR"),
    ("ADNA", "Kuaci Rebo 150 gr/ 140 gr", "KUACI CHEESE 140GR"),
    # FORISA: surat pakai nama Inggris, master pakai nama Indonesia.
    ("FORISA", "POP ICE UYU BANANA 240", "POP ICE UYU PISANG"),
    # OCR live membaca singkatan varian HG tidak konsisten ("&OC" vs "&DC");
    # keduanya harus jatuh ke satu-satunya F.WASH ber-ACNE di master.
    ("NATUR", "HG FOR MEN F. WASH ACNE CR&DC 100ML 24'S", "HG F.WASH ACNE & OIL CONTROL"),
    ("NATUR", "HG FOR MEN F.WASH ACNE CR&OC 100ML 24'S", "HG F.WASH ACNE & OIL CONTROL"),
    # Keputusan user: "H.VIT ALOVERA VIT E" (kombinasi yg tak ada di master) = OLIVE OIL VIT.E.
    ("NATUR", "NATUR HAIR VIT ALOVERA VIT E 80ML", "H.VIT OLIVE OIL VIT.E"),
    # ...tapi "ALOVERA VIT B5" yang sah TIDAK boleh ikut dialihkan ke Olive Oil.
    ("NATUR", "NATUR HAIR VIT ALOVERA VIT B5 80ML", "H.VIT ALOE VERA VIT.B5"),
]

# Baris yang master-nya MEMANG tak punya gramasi itu -> harus tetap 0 hit.
MUST_NOT_MATCH = [
    ("NATUR", "NATUR SHAMPOO ARGAN OIL 140ML"),      # master hanya 8ML
    ("NATUR", "NATUR COND. ARGAN OIL&OLIVE OIL 160ML"),  # master hanya 8ML/30ML
    ("NATUR", "NATUR HAIR MASK ARGAN OIL 15ML"),     # master hanya 25G
]

_cache = {}
def items_for(key):
    if key not in _cache:
        with open(os.path.join(RM, f"MASTER BARANG {key}.xlsx"), "rb") as f:
            _, _, _, master = shared._parse_master_barang_xlsx(f.read())
        _cache[key] = prepare_items(master, RULES[key])
    return _cache[key]


fail = 0
for key, line, expect in MUST_MATCH:
    hits = match_line(line, RULES[key], items_for(key))
    names = [str(h.get("nama_barang", "")) for h in hits]
    ok = any(expect.upper() in n.upper() for n in names)
    print(f"{'OK ' if ok else 'GAGAL'} [{key}] {line!r} -> {len(hits)} hit")
    if not ok:
        fail += 1
        print(f"       harusnya kena {expect!r}; dapat: {names[:5]}")

for key, line in MUST_NOT_MATCH:
    hits = match_line(line, RULES[key], items_for(key))
    ok = not hits
    print(f"{'OK ' if ok else 'GAGAL'} [{key}] (harus UNMATCHED) {line!r} -> {len(hits)} hit")
    if not ok:
        fail += 1
        print("       over-match:", [str(h.get('nama_barang', '')) for h in hits][:5])

# Cakupan lini: keputusan user 2026-07-19 -- "NUTRIJELL REGULER" = lini polos SAJA.
# Diuji dgn menyebut yang DILARANG ikut, bukan cuma jumlahnya, supaya tetap benar
# kalau master bertambah item.
_nutri = match_line("NUTRIJELL REGULER", RULES["FORISA"], items_for("FORISA"))
_names = [str(h.get("nama_barang", "")).upper() for h in _nutri]
_bocor = [n for n in _names if any(b in n for b in ("EKONOMI", "YOGHURT", "BALANCED", "COLOUR"))]
_ok = _nutri and not _bocor and all("NUTRIJELL" in n for n in _names)
print(f"{'OK ' if _ok else 'GAGAL'} [FORISA] 'NUTRIJELL REGULER' -> {len(_nutri)} SKU lini polos"
      + (f"; BOCOR lini lain: {_bocor[:3]}" if _bocor else ""))
if not _ok:
    fail += 1

# Guard over-match: baris "varian apa saja"/selini memang menyapu banyak varian --
# batasnya lebih longgar; baris ber-varian spesifik tetap ketat.
for key, line, _ in MUST_MATCH:
    n = len(match_line(line, RULES[key], items_for(key)))
    cap = {"ADNA": 12, "FORISA": 70}.get(key, 8)
    if n > cap:
        fail += 1
        print(f"GAGAL [{key}] {line!r} menyapu {n} SKU (indikasi over-match, batas {cap})")

print("\nSEMUA LULUS" if not fail else f"\n{fail} GAGAL")
sys.exit(1 if fail else 0)
