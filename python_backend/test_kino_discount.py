"""Tujuan: Self-check pemilahan diskon faktur Kino (distributor / principal / tak bertuan).
Caller: `python test_kino_discount.py`. Dependensi: kino_discount.
Main Functions: main; assert diskon bertingkat, kepemilikan posisi, dan tiga jenis peringatan.
Side Effects: Tidak ada.
"""
import sys
from decimal import Decimal

sys.path.insert(0, ".")
from kino_discount import classify, line_percentages, split  # noqa: E402


def main():
    # Bentuk nyata ALFAMART: DISC_1 4% (distributor) lalu DISC_4 2,25% (klaim principal).
    # Bertingkat, bukan dijumlah: 4% dari 345.945,95 lalu 2,25% dari SISANYA.
    gross = Decimal("345945.95")
    parts = split(gross, [(1, Decimal("4")), (4, Decimal("2.25"))])
    assert [p["amount"] for p in parts] == [Decimal("13837.84"), Decimal("7472.43")], parts
    assert sum(p["amount"] for p in parts) == Decimal("21310.27"), "TOTAL_DISC nyata dari Kino"
    assert [p["owner"] for p in parts] == ["distributor", "principal"]
    # Dijumlah rata (6,25%) akan meleset dan membuat tiap faktur tampak selisih.
    assert split(gross, [(1, Decimal("6.25"))])[0]["amount"] != Decimal("21310.27")

    assert line_percentages({f"DISC_{i}": 0 for i in range(1, 9)}) == []
    assert line_percentages({"DISC_1": 4, "DISC_4": 2.25, "DISC_7": None}) == [(1, Decimal("4")), (4, Decimal("2.25"))]

    # Semua terjelaskan -> tidak ada temuan.
    bersih = classify(gross, [(1, Decimal("4")), (4, Decimal("2.25"))], expected_principal=Decimal("7472.43"),
                      expected_distributor=[(1, "4")], reported_total=Decimal("21310.27"))
    assert bersih["ok"], bersih["findings"]
    assert bersih["distributor"] == Decimal("13837.84") and bersih["principal"] == Decimal("7472.43")

    # 1. Klaim principal tanpa aturan terbit.
    tanpa_aturan = classify(gross, [(4, Decimal("2.25"))], expected_principal=None, expected_distributor=[])
    assert "tak bertuan" in tanpa_aturan["findings"][0] and "aturan promo terbit" in tanpa_aturan["findings"][0]

    # 2. Klaim principal ada tetapi tidak sebesar aturan; toleransi hanya Rp 1.
    meleset = classify(gross, [(4, Decimal("2.25"))], expected_principal=Decimal("5000"), expected_distributor=[])
    assert "tidak cocok dengan aturan terbit" in meleset["findings"][0], meleset["findings"]
    # Tanpa potongan distributor di depannya, 2,25% jatuh atas gross penuh = 7.783,78.
    pas = classify(gross, [(4, Decimal("2.25"))], expected_principal=Decimal("7783.00"), expected_distributor=[])
    assert pas["ok"], pas["findings"]

    # 3. Diskon pada posisi tanpa pemilik.
    liar = classify(gross, [(7, Decimal("5"))], expected_principal=Decimal("0"), expected_distributor=[])
    assert liar["unowned"] == Decimal("17297.30") and "posisi DISC_7" in liar["findings"][0]

    # Tarif distributor belum terdaftar -> dilaporkan, tidak didiamkan.
    belum = classify(gross, [(1, Decimal("4"))], expected_principal=Decimal("0"), expected_distributor=None)
    assert "belum terdaftar" in belum["findings"][0], belum["findings"]

    # Tarif tidak sesuai kesepakatan, dan kesepakatan yang tidak diberikan.
    salah = classify(gross, [(1, Decimal("5"))], expected_principal=Decimal("0"), expected_distributor=[(1, "4")])
    assert "tidak sesuai kesepakatan" in salah["findings"][0], salah["findings"]
    kurang = classify(gross, [], expected_principal=Decimal("0"), expected_distributor=[(1, "4")])
    assert "disepakati tetapi tidak diberikan" in kurang["findings"][0], kurang["findings"]

    # Total yang dilaporkan Kino tidak cocok dengan hitungan kami.
    beda = classify(gross, [(1, Decimal("4"))], expected_principal=Decimal("0"),
                    expected_distributor=[(1, "4")], reported_total=Decimal("20000"))
    assert "berbeda dari yang dilaporkan Kino" in beda["findings"][0], beda["findings"]

    print("kino discount check: OK")


if __name__ == "__main__":
    main()
