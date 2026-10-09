"""Tujuan: Self-check parse_number_id (AM-018, hipotesis H07) — angka uang impor LPB/SPPD/keranjang.
Caller: `python test_parse_number_id.py` via run_checks.py. Dependensi: shared.parse_number_id.
Main Functions: main; tabel contoh format Indonesia, Inggris, sufiks ",-", dan nilai numerik asli.
Side Effects: tidak ada.
"""
import time

import shared

CASES = [
    # (input, expected) — sumber: konvensi yang sudah didukung (ID) + format Inggris dari Excel teks
    (1250000, 1250000.0),
    (1250000.5, 1250000.5),
    ("1.250.000", 1250000.0),       # ribuan Indonesia (sudah didukung)
    ("1.234,56", 1234.56),          # desimal Indonesia (sudah didukung)
    ("204,8", 204.8),
    ("250,000.00", 250000.0),       # Inggris: dulu 250.0 — nilai invoice ke SPPD 1000x lebih kecil
    ("1,250,000.00", 1250000.0),    # Inggris: dulu 0.0
    ("1.250.000,-", 1250000.0),     # tulisan rupiah ",-" (tanpa sen): dulu 0.0
    ("Rp 1.250.000,00", 1250000.0),
    ("", 0.0),                      # kosong = 0 (kebijakan blank existing)
    (None, 0.0),
    ("-1.000", -1000.0),            # dulu -1.0: grup "-1" gagal isdigit
    ("-1.250.000,50", -1250000.5),
    ("--5", 0.0),                   # review L1: dua tanda tak terbaca (sempat jadi +5)
    ("-" * 3000 + "5", 0.0),        # review L1: tanpa rekursi -> tidak RecursionError
    ("Rp.5000", 5000.0),            # review c4c11927: dulu 0.5 ("Rp." menyisakan ".5000")
    # S6-0c 7d: pemisah ribuan hanya bila kepala kelompoknya 1-3 digit tanpa nol depan (cermin lib/insentif-sales-excel.ts).
    ("1250000.000", 1250000.0),     # dulu 1.250.000.000 (1,25 miliar)
    ("0.125", 0.125),               # dulu 125
    ("0,125", 0.125),               # dulu 125
    ("533000000,50", 533000000.5),
]

# AM-044 (D.21-22): jalur UANG memakai parse_number_strict — nonempty invalid = galat, bukan 0.
# Kontrak sumber = rupiah Indonesia: satu pemisah + tepat 3 digit = ribuan (ditetapkan, bukan tebakan
# locale universal); "-" tunggal dan sel kosong = 0 (kebijakan blank lama).
STRICT_OK = [
    (0, 0.0), (0.0, 0.0), ("0", 0.0), ("", 0.0), (None, 0.0), (float("nan"), 0.0), ("-", 0.0),
    ("1.234", 1234.0), ("1,234", 1234.0), ("1,5", 1.5), ("1.5", 1.5),
    ("Rp 1.250.000,-", 1250000.0), ("IDR 250,000.00", 250000.0), ("1 250 000", 1250000.0), ("-1.000", -1000.0),
    # review c4c11927 (MEDIUM): prefix "Rp." dulu menggeser skala -> 0.5 / 0.15 / 0.1
    ("Rp.5000", 5000.0), ("Rp.150.000", 150000.0), ("Rp.1000,-", 1000.0), ("Rp-1.000", -1000.0),
    ("1250000.000", 1250000.0), ("250000000.000", 250000000.0), ("0.125", 0.125), ("0,125", 0.125), ("1,250,000", 1250000.0),
]
# "1２3"/"１.000": digit lebar-penuh dulu lolos regex (\d Unicode) lalu dibuang inti -> 13 / 0.0.
STRICT_BAD = ["abc", "NOT-A-NUMBER", "12abc", "1.2.3,4.5", "(1.000)", "-Rp-5", "--5", True, float("inf"), "1e5", "Rp",
              "1２3", "１.000", "12.34.567", "1234.567,89"]


def main():
    bad = [(x, want, shared.parse_number_id(x)) for x, want in CASES if shared.parse_number_id(x) != want]
    assert not bad, "\n".join(f"parse_number_id({x!r}) = {got!r}, harus {want!r}" for x, want, got in bad)
    bad = [(x, want, shared.parse_number_strict(x)) for x, want in STRICT_OK if shared.parse_number_strict(x) != want]
    assert not bad, "\n".join(f"parse_number_strict({x!r}) = {got!r}, harus {want!r}" for x, want, got in bad)
    for x in STRICT_BAD:
        try:
            got = shared.parse_number_strict(x, "Potongan")
        except ValueError as e:
            assert "Potongan" in str(e), e
        else:
            raise AssertionError(f"parse_number_strict({x!r}) = {got!r}, harus ValueError")
    # Review M1: upload Excel SPPD memakai strict untuk kolom uang.
    try:
        shared.normalize_sppd_excel_value("nilai_pembayaran", "NOT-A-NUMBER")
    except ValueError:
        pass
    else:
        raise AssertionError("SPPD Excel nilai_pembayaran 'NOT-A-NUMBER' diterima (dulu 0)")
    assert shared.normalize_sppd_excel_value("nilai_pembayaran", "Rp 1.000") == 1000.0
    # Review c4c11927 (LOW): sel SPPD berisi spasi / "-" = kosong (tidak diubah), dulu menimpa jadi 0.
    for blank in ("   ", "-", " - "):
        assert shared.normalize_sppd_excel_value("nilai_pembayaran", blank) is None, blank
    # ReDoS (peninjau A, S6-0c): `\s*` berdempetan di _STRICT_NUMBER = backtracking kubik — "-" + 800 spasi + "x"
    # dulu 1,3 detik per sel. Teks yang lebih panjang dari nominal mana pun ditolak SEBELUM regex.
    t0 = time.perf_counter()
    for x in ("-" + " " * 800 + "x", "Rp" + " " * 5000 + "-x", "1" * 41):
        try:
            got = shared.parse_number_strict(x, "Potongan")
        except ValueError:
            pass
        else:
            raise AssertionError(f"parse_number_strict({x[:20]!r}…) = {got!r}, harus ValueError")
    lama = time.perf_counter() - t0
    assert lama < 0.05, f"parse_number_strict teks panjang {lama:.3f} s (ReDoS)"
    assert shared.parse_number_strict("  Rp 1.250.000.000.000,-  ") == 1250000000000.0
    # Longgar tetap longgar untuk read model (perilaku lama dipertahankan).
    assert shared.parse_number_id("abc") == 0.0
    print("OK test_parse_number_id")


if __name__ == "__main__":
    main()
