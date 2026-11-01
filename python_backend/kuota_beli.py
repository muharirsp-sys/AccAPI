"""Tujuan: Kuota promo SELL-IN (owner 1 Nov 2026, surat MSM Amago/Lervia/Medicare): diskon ke outlet dibatasi qty barang yang
  DIBELI dengan diskon surat itu, dikurangi yang SUDAH KELUAR ke outlet dengan diskon yang sama ("budget fix"), lalu dipotong tiap
  order yang dibekukan.
Caller: routers/orders (hitung_promo, store_order, /orders/kuota*). Dependensi: openpyxl, summary_rules (teks_kuota), summary_store.
Main Functions: rantai, cocok, pola_program, baca_rincian, hitung_budget, sisa_kuota, simpan_kuota.
Side Effects: SQLite baca/tulis tabel `promo_kuota` dan baca `sales_order`; tidak memanggil Accurate.

Kuota disimpan dalam SATUAN TERKECIL barang (PCS/BTL/PCH/PACK, dari nama "… X 72 PCS"), supaya order ber-KRT maupun ber-PCS
dihitung lewat `rasio` master Accurate tanpa pembulatan karton.
"""
import io
import json
import re
from datetime import datetime
from decimal import ROUND_DOWN, ROUND_UP, Decimal, InvalidOperation
from fractions import Fraction

import openpyxl

from summary_rules import number, teks_kuota

# Diskon yang tercetak di faktur Accurate ditulis tangan: "6,5", "10+", "6.75+1.5+1+1%", "1 + 2.49". Selisih kecil = pembulatan
# bonus yang dipersenkan (5+1 = 16,67% tercetak 16.70).
TOLERANSI = Decimal("0.05")
KARTON = {"KRT", "CTN", "DUS", "BOX"}
ISI_NAMA = re.compile(r"\bX\s*(\d+)\s*([A-Z]+)\b")


def rantai(teks):
    """'6,75+1.5+1%' -> (6.75, 1.5, 1); kosong/None -> ()."""
    hasil = []
    for bagian in str(teks or "").replace(",", ".").replace("%", "").split("+"):
        bagian = bagian.strip().rstrip(".")
        if not bagian or bagian.lower() == "none":
            continue
        try:
            hasil.append(Decimal(bagian))
        except InvalidOperation:
            return ()
    return tuple(hasil)


def cocok(baris, program, awal_saja=False):
    """Rantai program muncul BERURUTAN di rantai baris: surat 8+2 cocok dengan faktur 8+2+1, surat 10 dengan 1+10.

    `awal_saja` untuk faktur JUAL: potongan promo selalu di depan rantai kita ("10+0.5", "15+1"), sedangkan "6.5+3+1" adalah promo
    6,5% — angka 3 di tengahnya bukan strata 3% surat lain. Faktur BELI principal sering diawali 1% reguler ("1+10"), jadi di mana saja.
    ponytail: komponen tambahan di luar surat dibiarkan (8+2+1); peninjau melihat polanya di pratinjau sebelum menyimpan."""
    n = len(program)
    posisi = range(1 if awal_saja else len(baris) - n + 1)
    return bool(n) and len(baris) >= n and any(all(abs(baris[i + j] - program[j]) <= TOLERANSI for j in range(n)) for i in posisi)


def pola_program(programs, surat):
    """{kode: {"persen": [rantai...], "bonus": [porsi gratis...]}} dari program berkuota surat itu.

    Bonus "beli M gratis B" dipersenkan B/(M+B) (3+1 = 25%, 5+1 = 16,67%): pembelian yang bonusnya sudah dilebur ke diskon
    dikenali dari persen itu, dan kuotanya = porsi GRATIS-nya, karena yang dibatasi adalah barang gratis yang boleh keluar.
    """
    hasil = {}
    for program in programs:
        if not program.kuota or program.surat_program.strip().upper() != surat:
            continue
        for tier in program.tiers:
            for code in program.codes:
                pola = hasil.setdefault(code, {"persen": [], "bonus": []})
                if tier.percentages:
                    pola["persen"].append(tuple(Decimal(str(number(p))) for p in tier.percentages))
                if number(tier.bonus_quantity):
                    beli, gratis = number(tier.kelipatan) or number(tier.minimum), number(tier.bonus_quantity)
                    pola["bonus"].append(Fraction(gratis) / Fraction(beli + gratis))
    return hasil


ALIAS = {
    "kode": ("KODE BARANG", "KODE_BARANG", "Kode #"),
    "nama": ("NAMA BARANG", "NAMA_BARANG", "Nama Barang"),
    "qty": ("QTY", "Kuantitas"),
    "satuan": ("SATUAN", "Nama Satuan"),
    "diskon": ("Diskon %",),
    "tanggal": ("TANGGAL", "Tanggal"),
    "dokumen": ("NO. PEMBELIAN", "NO_NOTA", "Nomor #"),
    "qty_kecil": ("QTY_SATUANKECIL",),
    "satuan_kecil": ("SATUAN_KECIL",),
}


def tanggal_iso(nilai, label, nomor):
    """Sel tanggal Accurate -> 'YYYY-MM-DD'. Teks yang tak terbaca DITOLAK: membandingkan 'dd/mm/yyyy' sebagai teks dengan batas
    program diam-diam melewatkan penjualan dan membesarkan budget."""
    if hasattr(nilai, "strftime"):
        return nilai.strftime("%Y-%m-%d")
    teks = str(nilai or "").strip()
    if not teks:
        return ""
    for pola in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime(teks, pola).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"{label}: tanggal '{teks[:20]}' di baris {nomor} tidak terbaca")


def angka_sel(nilai, label, kolom, nomor):
    try:
        hasil = Decimal(str(nilai if nilai not in (None, "") else 0).strip())
    except InvalidOperation:
        raise ValueError(f"{label}: {kolom} '{str(nilai)[:20]}' di baris {nomor} bukan angka") from None
    if not hasil.is_finite():
        raise ValueError(f"{label}: {kolom} di baris {nomor} bukan angka")
    return hasil


def baca_rincian(data, label):
    """Ekspor Accurate "Rincian Faktur Pembelian/Penjualan" -> daftar baris {kode, nama, qty, satuan, diskon, tanggal, ...}.

    Kolom Diskon % WAJIB: tanpa itu "diskon sesuai surat" tidak bisa dibuktikan, dan menebaknya berarti memberi budget kosong
    atau budget seluruh pembelian.
    """
    try:
        buku = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        raise ValueError(f"{label}: bukan berkas Excel (.xlsx) yang bisa dibaca") from None
    lembar = buku.worksheets[0]
    lembar.reset_dimensions()  # ekspor Accurate tidak menulis dimensi; tanpa ini read_only hanya melihat satu baris
    baris = lembar.iter_rows(values_only=True)
    indeks = None
    for _, kepala in zip(range(30), baris):
        nama = [str(sel).strip() if sel is not None else "" for sel in kepala]
        indeks = {kunci: next((nama.index(a) for a in alias if a in nama), None) for kunci, alias in ALIAS.items()}
        if indeks["kode"] is not None and indeks["qty"] is not None:
            break
    else:
        raise ValueError(f"{label}: kepala kolom KODE BARANG dan QTY tidak ditemukan")
    if indeks["diskon"] is None or indeks["satuan"] is None:
        raise ValueError(f"{label}: kolom 'Diskon %' dan SATUAN wajib ada; ekspor ulang dengan templat rincian yang memuat diskon")
    hasil = []
    for nomor, isi in enumerate(baris, start=2):
        ambil = lambda kunci: isi[indeks[kunci]] if indeks[kunci] is not None and indeks[kunci] < len(isi) else None
        kode = str(ambil("kode") or "").strip()
        if not kode:
            continue
        kecil = ambil("qty_kecil")
        hasil.append(dict(kode=kode, nama=str(ambil("nama") or ""), qty=angka_sel(ambil("qty"), label, "QTY", nomor),
                          satuan=str(ambil("satuan") or "").strip().upper(), diskon=rantai(ambil("diskon")),
                          tanggal=tanggal_iso(ambil("tanggal"), label, nomor), dokumen=str(ambil("dokumen") or ""),
                          qty_kecil=None if kecil in (None, "") else angka_sel(kecil, label, "QTY_SATUANKECIL", nomor),
                          satuan_kecil=str(ambil("satuan_kecil") or "").strip().upper()))
    return hasil


def isi_karton(nama):
    """'MSM MEDICARE SABUN BAR DEEP CLEAN 80GR X 72 PCS' -> (72, 'PCS'); tidak terbaca -> None."""
    temu = ISI_NAMA.findall(str(nama).upper())
    return (int(temu[-1][0]), temu[-1][1]) if temu else None


def qty_kecil(baris):
    """Qty baris dalam satuan terkecil; None bila satuannya tak bisa dibuktikan (dilaporkan, tidak dihitung)."""
    isi = isi_karton(baris["nama"])
    if baris["qty_kecil"] is not None and baris["satuan_kecil"]:
        return baris["qty_kecil"], baris["satuan_kecil"]
    if not isi:
        return None
    if baris["satuan"] == isi[1]:
        return baris["qty"], isi[1]
    return (baris["qty"] * isi[0], isi[1]) if baris["satuan"] in KARTON else None


def hitung_budget(pola, beli, jual, sebelum):
    """Budget per kode = qty DIBELI berdiskon surat - qty yang SUDAH KELUAR ke outlet berdiskon sama sebelum `sebelum`.

    Persen: baris yang rantainya `cocok` dihitung penuh. Bonus: baris beli berdiskon setara porsi gratis dihitung porsi gratisnya,
    baris 100% (barang gratis) dihitung penuh; keluarnya = baris jual 100%. Semua dalam satuan terkecil.
    """
    hasil = {kode: dict(kode=kode, nama="", satuan="", isi=None, beli=Fraction(0), keluar=Fraction(0), pola_beli={}, pola_keluar={},
                        tak_terhitung=[]) for kode in pola}

    def jatah(baris, sisi):
        """Bagian qty baris yang termasuk program, atau None bila bukan diskon surat."""
        p = pola[baris["kode"]]
        if any(cocok(baris["diskon"], r, awal_saja=sisi == "jual") for r in p["persen"]):
            return Fraction(1)
        if p["bonus"] and baris["diskon"] == (Decimal(100),):
            return Fraction(1)
        if sisi == "beli" and len(baris["diskon"]) == 1:
            return next((porsi for porsi in p["bonus"] if abs(Fraction(baris["diskon"][0]) - porsi * 100) <= Fraction(TOLERANSI)), None)
        return None

    for sisi, daftar in (("beli", beli), ("keluar", jual)):
        for baris in daftar:
            if baris["kode"] not in pola or (sisi == "keluar" and baris["tanggal"] >= sebelum):
                continue
            porsi = jatah(baris, "beli" if sisi == "beli" else "jual")
            if porsi is None:
                continue
            item = hasil[baris["kode"]]
            item["nama"] = item["nama"] or baris["nama"]
            kecil = qty_kecil(baris)
            if kecil is None or (item["satuan"] and kecil[1] != item["satuan"]):
                item["tak_terhitung"].append(f"{sisi} {baris['dokumen']} {baris['tanggal']}: {baris['qty']} {baris['satuan']}")
                continue
            item["satuan"] = kecil[1]
            item["isi"] = item["isi"] or (isi_karton(baris["nama"]) or (None,))[0]
            item[sisi] += Fraction(kecil[0]) * porsi
            teks = "+".join(format(d.normalize(), "f") for d in baris["diskon"]) or "-"
            item[f"pola_{sisi}"][teks] = item[f"pola_{sisi}"].get(teks, Fraction(0)) + Fraction(kecil[0]) * porsi
    # Pembulatan selalu memihak budget yang LEBIH KECIL: beli turun, keluar naik.
    desimal = lambda nilai, arah: (Decimal(nilai.numerator) / Decimal(nilai.denominator)).quantize(Decimal("0.000001"), rounding=arah)
    for item in hasil.values():
        item["beli"], item["keluar"] = desimal(item["beli"], ROUND_DOWN), desimal(item["keluar"], ROUND_UP)
        item["pola_beli"] = {k: desimal(v, ROUND_DOWN) for k, v in item["pola_beli"].items()}
        item["pola_keluar"] = {k: desimal(v, ROUND_UP) for k, v in item["pola_keluar"].items()}
        item["budget"] = max(Decimal(0), item["beli"] - item["keluar"])
    return list(hasil.values())


def sisa_kuota(db, surat, sejak=""):
    """{(SURAT, kode): (sisa, satuan)} = kuota tersimpan - pemakaian order yang sudah dibekukan (status apa pun selain batal).

    Pemakaian dibaca dari `result.kuota` order beku, bukan dari faktur: order yang sudah dihitung tetap memegang kuotanya walau
    fakturnya belum terkirim. Satuan pemakaian beda dari satuan kuota (kuota disimpan ulang dengan satuan lain) = sisa 0, gagal tertutup.
    `sejak` = awal program berkuota paling dini: order sebelumnya tidak mungkin memakai kuota, jadi tidak dipindai.
    ponytail: pindaian penuh `sales_order` sejak tanggal itu per pratinjau; buku besar (surat, kode, order) bila order bertambah banyak.
    """
    surat = {s.strip().upper() for s in surat}
    if not surat:
        return {}
    kuota = {}
    for s, kode, qty, unit in db.execute("SELECT surat_program,code,quantity,unit FROM promo_kuota").fetchall():
        if s in surat:
            kuota[(s, kode)] = (Fraction(Decimal(qty)), unit)
    pakai, satuan_lain = {}, set()
    for (teks,) in db.execute("SELECT result FROM sales_order WHERE status<>'cancelled' AND order_date>=? AND instr(result,'\"kuota\"')>0",
                              (sejak,)).fetchall():
        for entri in json.loads(teks).get("kuota") or []:
            key = (entri["surat_program"], entri["code"])
            if key not in kuota:
                continue
            if entri["unit"] != kuota[key][1]:
                satuan_lain.add(key)
            pakai[key] = pakai.get(key, 0) + Fraction(Decimal(entri["quantity"]))
    return {key: (Fraction(0) if key in satuan_lain else max(Fraction(0), qty - pakai.get(key, 0)), unit)
            for key, (qty, unit) in kuota.items()}


def simpan_kuota(db, surat, baris, oleh, sumber):
    """Ganti SELURUH kuota satu surat (unggahan ulang = budget baru, bukan tambahan)."""
    surat = surat.strip().upper()
    db.execute("DELETE FROM promo_kuota WHERE surat_program=?", (surat,))
    for item in baris:
        db.execute("INSERT INTO promo_kuota(surat_program,code,quantity,unit,isi,sumber,updated_by) VALUES(?,?,?,?,?,?,?)",
                   (surat, item["code"], teks_kuota(Fraction(Decimal(str(item["quantity"])))), item["unit"],
                    str(item.get("isi") or ""), sumber[:300], oleh[:160]))
