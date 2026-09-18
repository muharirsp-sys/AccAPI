"""Tujuan: syarat klaim BAKU per principal, per jenis program — diisi sekali, dipakai tiap surat.
Caller: `routers/summary.py` (endpoint setelan + pengisian `pdf_meta` saat Form Summary dibuat).
Dependensi: `summary_store.JsonStore` (tabel `summary_kv`, tanpa migrasi).
Main Functions: ambil, simpan, untuk. Side Effects: menulis `summary_kv` namespace `syarat_claim`.

KENAPA ADA. Kolom "Syarat Claim" dicetak di SETIAP Form Summary dan tidak pernah ada isinya —
tidak ada satu pun tempat untuk mengisinya (cacat #14, 16 Sep 2026). Syaratnya sendiri hampir
selalu sama untuk satu principal dan satu jenis program ("saat ini disc. on faktur"), jadi yang
dibutuhkan bukan kolom yang diketik ulang 15 kali per surat, melainkan SATU setelan per principal
yang menempel sendiri ke tiap baris.

Baris yang SUDAH punya syarat klaimnya sendiri tidak pernah ditimpa: setelan ini baku, bukan
paksaan. Surat yang menyebut syarat berbeda tetap menang.
"""
from summary_store import JsonStore

# Jenis program = jenis benefit barisnya, nama yang sama dengan `promo_rule.benefit_type`.
# "" = baku untuk jenis yang tidak punya teksnya sendiri.
JENIS = ("DISC_PCT", "DISC_RP", "BONUS_QTY")

_STORE = JsonStore("syarat_claim")


def _kunci(principle) -> str:
    return " ".join(str(principle or "").strip().split()).upper()


def ambil(principle) -> dict:
    """Setelan satu principal: {"": baku, "DISC_PCT": ..., "DISC_RP": ..., "BONUS_QTY": ...}."""
    nama = _kunci(principle)
    if not nama:
        return {}
    tersimpan = _STORE.get(nama) or {}
    return {k: str(v or "").strip() for k, v in tersimpan.items() if str(v or "").strip()}


def simpan(principle, nilai: dict) -> dict:
    """Menulis setelan; kunci di luar `JENIS` dan "" DIBUANG, bukan disimpan diam-diam."""
    nama = _kunci(principle)
    if not nama:
        raise ValueError("Principal belum dipilih.")
    bersih = {}
    for kunci in ("",) + JENIS:
        teks = " ".join(str(nilai.get(kunci, "") or "").strip().split())
        if teks:
            bersih[kunci] = teks[:400]
    _STORE[nama] = bersih
    return bersih


def untuk(principle, benefit_type) -> str:
    """Syarat klaim untuk satu baris: jenisnya sendiri lebih dulu, lalu baku principalnya."""
    setelan = ambil(principle)
    if not setelan:
        return ""
    jenis = str(benefit_type or "").strip().upper()
    return setelan.get(jenis) or setelan.get("") or ""


def _self_check():
    import tempfile, os
    os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(), "uji.sqlite3")
    import importlib, summary_store
    importlib.reload(summary_store)
    global _STORE
    _STORE = summary_store.JsonStore("syarat_claim")

    assert untuk("KINO NON FOOD", "DISC_RP") == "", "principal tanpa setelan harus kosong"
    simpan("kino non food", {"": "Klaim on faktur, lampirkan copy faktur.",
                             "BONUS_QTY": "Bonus dilaporkan terpisah.", "NGAWUR": "dibuang"})
    # Nama principal dibandingkan tanpa peduli huruf besar/kecil dan spasi ganda.
    assert untuk("KINO  NON   FOOD", "BONUS_QTY") == "Bonus dilaporkan terpisah."
    # Jenis tanpa teksnya sendiri jatuh ke baku.
    assert untuk("KINO NON FOOD", "DISC_RP") == "Klaim on faktur, lampirkan copy faktur."
    assert untuk("KINO NON FOOD", "") == "Klaim on faktur, lampirkan copy faktur."
    # Kunci yang bukan jenis program tidak pernah tersimpan.
    assert "NGAWUR" not in ambil("KINO NON FOOD")
    # Principal lain tidak ikut kebagian.
    assert untuk("FONTERRA", "DISC_RP") == ""
    # Menyimpan peta kosong menghapus setelannya, bukan menyisakan sisa.
    simpan("KINO NON FOOD", {})
    assert ambil("KINO NON FOOD") == {}
    print("syarat_claim: 8/8 lulus")


if __name__ == "__main__":
    _self_check()
