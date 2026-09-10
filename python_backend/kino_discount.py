"""Tujuan: Pilah diskon faktur Kino jadi tanggungan distributor, klaim principal, dan tak bertuan.
Caller: gerbang validasi data Kino vs aturan terbit (tahap 6 langkah 4).
Dependensi: Decimal stdlib. Main Functions: split, classify.
Side Effects: Tidak ada I/O; tidak memakai float untuk aritmetika uang.

POSISI kolom `DISC_n` pada ORDER_DETAIL adalah penanda SIAPA YANG MENANGGUNG, bukan sekadar
urutan. Dibuktikan 2026-09-10 dengan data nyata: ALFAMART punya `DISC_1=4` dan `DISC_4=2.25`,
persis kolom 1 (Distributor) dan kolom 4 (Principle) pada tabel "DISCON SUPER DEV. KINO NON
FOOD" (Makassar, Agustus 2026, berlaku 15-08-26 s/d 31-12-26).
"""
from decimal import Decimal, ROUND_HALF_UP

# Kolom 1-3 tanggungan distributor, 4-5 klaim ke principal. Posisi di luar itu TIDAK punya
# pemilik: kalau terisi, itu diskon tak bertuan — kesalahan yang wajib memunculkan peringatan.
OWNER = {1: "distributor", 2: "distributor", 3: "distributor", 4: "principal", 5: "principal"}
POSITIONS = 8  # ORDER_DETAIL menyediakan DISC_1..DISC_8
TOLERANCE = Decimal("1")  # Rp 1 per faktur; hanya untuk menyerap pembulatan, bukan selisih aturan


def money(value):
    return Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def split(gross, percentages):
    """Diskon bertingkat: tiap posisi memotong SISA, bukan gross.

    Dibuktikan dengan ALFAMART: 4% lalu 2,25% atas Rp 345.945,95 menghasilkan Rp 21.310,27,
    sama persis dengan TOTAL_DISC yang dilaporkan Kino. Menjumlahkan 6,25% langsung akan
    memberi Rp 21.621,62 dan setiap faktur akan tampak selisih.
    """
    remaining, parts = Decimal(gross), []
    for position, percent in percentages:
        amount = money(remaining * Decimal(str(percent)) / 100)
        remaining -= amount
        parts.append({"position": int(position), "percent": str(percent), "amount": amount,
                      "owner": OWNER.get(int(position), "")})
    return parts


def line_percentages(row):
    """Baris ORDER_DETAIL -> [(posisi, persen)] untuk posisi yang benar-benar terisi."""
    found = []
    for position in range(1, POSITIONS + 1):
        percent = row.get(f"DISC_{position}") or 0
        if Decimal(str(percent)) > 0:
            found.append((position, Decimal(str(percent))))
    return found


def classify(gross, percentages, expected_principal=None, expected_distributor=None,
             reported_total=None, tolerance=TOLERANCE):
    """Pilah satu baris jadi tiga ember, lalu laporkan yang tidak bisa dipertanggungjawabkan.

    `expected_principal` = rupiah menurut aturan promo terbit; None berarti belum ada aturan.
    `expected_distributor` = [(posisi, persen)] tarif yang disepakati pada tabel discon super
    dev; None berarti tarif outlet ini BELUM terdaftar — dan itu dilaporkan, bukan didiamkan,
    karena tanpa tarif rujukan diskon distributor yang salah tidak bisa dibedakan dari yang benar.
    """
    parts = split(gross, percentages)
    bucket = {"distributor": Decimal(0), "principal": Decimal(0), "unowned": Decimal(0)}
    findings = []
    for part in parts:
        bucket[part["owner"] or "unowned"] += part["amount"]
        if not part["owner"]:
            findings.append(f"Diskon tak bertuan: posisi DISC_{part['position']} terisi {part['percent']}% "
                            f"(Rp {part['amount']}), padahal posisi itu bukan tanggungan distributor maupun principal.")
    total = sum(bucket.values(), Decimal(0))

    if expected_principal is None:
        if bucket["principal"]:
            findings.append(f"Diskon tak bertuan: klaim principal Rp {bucket['principal']} tanpa aturan promo terbit yang menjelaskannya.")
    elif abs(bucket["principal"] - Decimal(expected_principal)) > tolerance:
        findings.append(f"Klaim principal Rp {bucket['principal']} tidak cocok dengan aturan terbit "
                        f"Rp {money(Decimal(expected_principal))} (selisih Rp {money(bucket['principal'] - Decimal(expected_principal))}).")

    if expected_distributor is None:
        if bucket["distributor"]:
            findings.append(f"Tanggungan distributor Rp {bucket['distributor']} belum bisa diperiksa: "
                            f"tarif discon super dev untuk outlet ini belum terdaftar.")
    else:
        agreed = {int(p): Decimal(str(v)) for p, v in expected_distributor}
        for part in parts:
            if part["owner"] != "distributor":
                continue
            if agreed.get(part["position"]) != Decimal(part["percent"]):
                findings.append(f"Tanggungan distributor posisi DISC_{part['position']} {part['percent']}% "
                                f"tidak sesuai kesepakatan ({agreed.get(part['position'], 'tidak ada')}%).")
        for position, percent in agreed.items():
            if percent and not any(p["position"] == position for p in parts):
                findings.append(f"Tanggungan distributor posisi DISC_{position} {percent}% disepakati tetapi tidak diberikan.")

    if reported_total is not None and abs(total - Decimal(reported_total)) > tolerance:
        findings.append(f"Total diskon hitungan kami Rp {money(total)} berbeda dari yang dilaporkan Kino "
                        f"Rp {money(Decimal(reported_total))}.")
    return {"parts": parts, "distributor": bucket["distributor"], "principal": bucket["principal"],
            "unowned": bucket["unowned"], "total": total, "findings": findings, "ok": not findings}
