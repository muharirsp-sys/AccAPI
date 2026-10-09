"""Tujuan: Self-check parse_number_id (AM-018, hipotesis H07) — angka uang impor LPB/SPPD/keranjang.
Caller: `python test_parse_number_id.py` via run_checks.py. Dependensi: shared.parse_number_id.
Main Functions: main; tabel contoh format Indonesia, Inggris, sufiks ",-", dan nilai numerik asli.
Side Effects: tidak ada.
"""
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
]

# AM-044 (D.21-22): jalur UANG memakai parse_number_strict — nonempty invalid = galat, bukan 0.
# Kontrak sumber = rupiah Indonesia: satu pemisah + tepat 3 digit = ribuan (ditetapkan, bukan tebakan
# locale universal); "-" tunggal dan sel kosong = 0 (kebijakan blank lama).
STRICT_OK = [
    (0, 0.0), (0.0, 0.0), ("0", 0.0), ("", 0.0), (None, 0.0), (float("nan"), 0.0), ("-", 0.0),
    ("1.234", 1234.0), ("1,234", 1234.0), ("1,5", 1.5), ("1.5", 1.5),
    ("Rp 1.250.000,-", 1250000.0), ("IDR 250,000.00", 250000.0), ("1 250 000", 1250000.0), ("-1.000", -1000.0),
]
STRICT_BAD = ["abc", "NOT-A-NUMBER", "12abc", "1.2.3,4.5", "(1.000)", "-Rp-5", "--5", True, float("inf"), "1e5", "Rp"]


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
    # Longgar tetap longgar untuk read model (perilaku lama dipertahankan).
    assert shared.parse_number_id("abc") == 0.0
    print("OK test_parse_number_id")


if __name__ == "__main__":
    main()
