"""
Tujuan: Self-check matcher generik, termasuk alias OCR Natur (0 API).
Caller: developer/CI manual dengan ``python test_generic_promo_matcher.py``.
Dependensi: ``generic_promo_pipeline`` dan master barang lokal.
Main Functions: eksekusi daftar ``MUST_MATCH``/``MUST_NOT_MATCH``.
Side Effects: membaca master XLSX dan mencetak hasil pemeriksaan.

Mengunci kasus NYATA dari surat FONTERRA/NATUR yang pernah salah UNMATCHED
padahal item-nya ADA di master (diagnosa 2026-07-19), + kasus yang memang
TIDAK ada di master dan WAJIB tetap UNMATCHED (jangan sampai fix bikin over-match).
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shared
from generic_promo_pipeline import RULES, _ket_ben, build_row, prepare_items, match_line

RM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "rebuild_master")

# (principle, baris surat, potongan nama master yang WAJIB kena)
MUST_MATCH = [
    ("FONTERRA", "ANLENE GOLD HABBATUSAUDA 580 GR", "HABATUSSAUDA 580GR"),
    ("NATUR", "AZALEA ZAITUN OIL ROSEHIP 135ML", "ROSESHIP OIL 24 PCS X 150ML /135ML"),
    ("NATUR", "AZALEA ZAITUN OIL ROSENIP 135ML", "ROSESHIP OIL 24 PCS X 150ML /135ML"),
    ("NATUR", "AZALEA ZAITUN OIL HABBATS 130ML", "HABBATUSSAUDA 24 PCS X 150/135ML"),
    ("NATUR", "AZALEA ZAITUN OIL ROOFHP 150ML", "ROSESHIP OIL 48 PCS X 150ML"),
    ("NATUR", "AZALEA SMOOTH FOOT CREAM 350R", "SMOOTH FOOT CREAM 48 PCS X 35GR"),
    ("NATUR", "AZALEA SHAMPOO ANTIDANORUFF 180 ML", "AZALEA SHMP A.DANDRUFF"),
    ("NATUR", "NATUR SHAMPOO ANTIDANORUFF 140ML", "SHMP ANTI DANDRUFF"),
    ("NATUR", "AZALEA SHAMPOO GINSENG 180 ML", "SHMP Z.OIL&G.EXRACT 48 PCS X 180ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM ALOEVERA 60ML", "H.RECOVERY A.VERA OIL 24 PCS X 60ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM OLIVEOIL 60ML", "H.RECOVERY OLIVE OIL 24 PCS X 60ML"),
    ("NATUR", "NATUR HAIR RECOVERY SERUM GINSENG 60ML", "H.RECOVERY GINSENG OIL 24 PCS X 60ML"),
    ("NATUR", "HG FOR MEN F.WASH BRIGHT&DC 100ML 24'S", "HG F.WASH BRIGHTENGING & D.CLEANSING 24 PCS X 100ML"),
    ("NATUR", "HG FOR MEN FACIAL WASH BRIGHTENING & DEEP CLEANSING 100 ML", "HG F.WASH BRIGHTENGING & D.CLEANSING 24 PCS X 100ML"),
    ("NATUR", "HG FOR MEN F.WASH ACNE CR&OC 100ML 24'S", "HG F.WASH ACNE & OIL CONTROL 24 PCS X 100ML"),
    ("NATUR", "NATUR 2IN1 SHAMPOO & TONIC GINSENG", "NATUR 2IN1 GINSENG"),
    ("NATUR", "NATUR ZINJ SHAMPOO & TONIC GINSENG", "NATUR 2IN1 GINSENG"),
    ("NATUR", "AZALEA HAIR VIT ZAITUN OIL&ALDE 80 ML", "H.VIT ZAITUN OIL & A.VERA EXT"),
    ("NATUR", "NATUR SHAMPOO ANTI DANORUFF 140ML", "SHMP ANTI DANDRUFF"),
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
    ("NATUR", "NATUR HAIR VIT ALOVERA VIT 85 80ML", "H.VIT ALOE VERA VIT.B5"),
]

# Baris yang master-nya MEMANG tak punya gramasi itu -> harus tetap 0 hit.
MUST_NOT_MATCH = [
    ("NATUR", "NATUR SHAMPOO ARGAN OIL 140ML"),      # master hanya 8ML
    ("NATUR", "NATUR COND. ARGAN OIL&OLIVE OIL 160ML"),  # master hanya 8ML/30ML
    ("NATUR", "NATUR HAIR MASK ARGAN OIL 15ML"),     # master hanya 25G
    ("NATUR", "NATUR HAIR RECOVERY SERUM ARGAN OIL 60ML"),  # master hanya Almond+Argan 8ML
]

_cache = {}
def items_for(key):
    if key not in _cache:
        with open(os.path.join(RM, f"MASTER BARANG {key}.xlsx"), "rb") as f:
            _, _, _, master = shared._parse_master_barang_xlsx(f.read())
        _cache[key] = prepare_items(master, RULES[key])
    return _cache[key]


fail = 0

_bonus_ket, _bonus_ben = _ket_ben({"minimal_order": "", "discount": "24+1"})
if (_bonus_ket, _bonus_ben) != ("Min 24 pcs", "24+1"):
    fail += 1
    print("GAGAL [NATUR] benefit X+Y tanpa minimal_order harus memakai X sebagai trigger")
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

# Gramasi surat hanya untuk matching; label output wajib mengikuti master.
for _line in ("AZALEA ZAITUN OIL ROSEHIP 135ML", "AZALEA ZAITUN OIL HABBATUSSAUDA 135ML"):
    _hits = match_line(_line, RULES["NATUR"], items_for("NATUR"))
    _row = build_row(1, {}, _line, _hits, "Min 12 pcs", "Add disc 5%+3%")
    _master_ok = bool(_hits) and _row["gramasi"] == "150ML"
    print(f"{'OK ' if _master_ok else 'GAGAL'} [NATUR] label master {_line!r} -> {_row['gramasi']}")
    if not _master_ok:
        fail += 1

_alias_expected = {
    "AZALEA ZAITUN OIL ROSEHIP 135ML": {"19022020150000", "19022020150000N"},
    "AZALEA ZAITUN OIL HABBATUSSAUDA 135ML": {"19022020150000B", "19022010150000", "19022010150000N"},
}
for _line, _expected_codes in _alias_expected.items():
    _actual_codes = {str(h.get("kode_barang", "")) for h in match_line(_line, RULES["NATUR"], items_for("NATUR"))}
    _alias_ok = _actual_codes == _expected_codes
    print(f"{'OK ' if _alias_ok else 'GAGAL'} [NATUR] ekspansi master {_line!r} -> {sorted(_actual_codes)}")
    if not _alias_ok:
        fail += 1

_mask_codes = {str(h.get("kode_barang", "")) for h in
               match_line("NATUR HAIR MASK OLIVEOIL VITE 15ML", RULES["NATUR"], items_for("NATUR"))}
if "19015040025000B" in _mask_codes or "19015030015000" not in _mask_codes:
    fail += 1
    print(f"GAGAL [NATUR] gramasi master 25G bocor ke surat Hair Mask 15ML: {sorted(_mask_codes)}")

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
