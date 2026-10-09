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
]


def main():
    bad = [(x, want, shared.parse_number_id(x)) for x, want in CASES if shared.parse_number_id(x) != want]
    assert not bad, "\n".join(f"parse_number_id({x!r}) = {got!r}, harus {want!r}" for x, want, got in bad)
    print("OK test_parse_number_id")


if __name__ == "__main__":
    main()
