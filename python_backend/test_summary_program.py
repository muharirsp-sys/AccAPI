"""Self-check summary_program: aturan umum, penjaga, gabung, dan jalur ekstrak utuh dengan Mistral tiruan (tanpa jaringan).
Pakai: python test_summary_program.py (ikut run_checks.py). SQLite sementara lewat SUMMARY_STORE_PATH."""
import asyncio
import copy
import json
import os
import tempfile
from pathlib import Path

import fitz
import httpx

tmp = tempfile.mkdtemp()
os.environ["SUMMARY_STORE_PATH"] = str(Path(tmp) / "t.sqlite3")
os.environ["MISTRAL_API_KEY"] = "uji"
import summary_program as sp  # noqa: E402

MASTER = [{"kode_barang": k, "nama_barang": n, "kelompok_barang": "ANLENE", "variant": "", "gramasi": g} for k, n, g in
          [("A1", "ANLENE COKLAT 25GR X 12 SCH", "25GR"), ("A2", "ANLENE VANILA 25GR X 12 SCH", "25GR"),
           ("A3", "ANLENE COKLAT 230GR BOX", "230GR"), ("A1B", "B> ANLENE COKLAT 25GR X 12 SCH", "25GR")]]
M = sp.indeks_master(MASTER)


def rule(rid="R1", nama="ANLENE SACHET", kode=("A1", "A2"), mn=4, tipe="bonus_barang", komponen=(), bonus=(1, "RTG"), kutipan="BUY 4 CS FREE 1 RENCENG"):
    return {"rule_id": rid, "program_id": "P1", "section_id": "P1-S1", "kolom_id": "P1-S1-K1",
            "barang": {"nama_di_surat": nama, "kode_barang": list(kode), "kelompok_barang": "ANLENE", "gramasi": "25GR"},
            "ketentuan": {"min": mn, "max": None, "satuan": "CTN", "kelipatan": None},
            "benefit": {"tipe": tipe, "komponen": [{"nama": n, "nilai": v, "satuan": s, "beban": "principal"} for n, v, s in komponen],
                        "nominal_per": None, "teks_tampilan": "", "bonus": bonus and {"kode_barang": list(kode), "qty": bonus[0], "satuan": bonus[1]}},
            "sumber": {"halaman": 1, "kutipan": kutipan}}


def doc(*rules):
    return {"principal": "UJI", "programs": [{"program_id": "P1", "no_surat": "001", "syarat_claim": {"batas_klaim_tanggal": None},
                                             "sections": [{"section_id": "P1-S1", "kolom": [{"kolom_id": "P1-S1-K1"}]}]}],
            "item_rules": list(rules), "flags": [], "validasi": {"jumlah_baris_produk_di_surat": len(rules), "jumlah_item_rules": len(rules), "jumlah_rule_tanpa_kode": 0}}


# aturan umum: kode B keluar, CR bukan potongan, "28+8" mengisi minimum, voucher keluar tapi hanger tetap, kelipatan L08
d = sp.umum(doc(rule(kode=("A1", "A1B")),
                rule("R2", mn=None, komponen=[("CR", 22.2, "%")], bonus=(8, "PCS"), kutipan="Anlene Sachet | 28+8 | 22.2%"),
                rule("R3", tipe="voucher", komponen=[("Voucher", 3000, "RP")], bonus=None),
                rule("R4", tipe="sewa_display", komponen=[("Hanger", 25000, "RP")], bonus=None)), M)
r1, r2 = d["item_rules"][0], d["item_rules"][1]
assert r1["barang"]["kode_barang"] == ["A1"] and r1["benefit"]["bonus"]["kode_barang"] == ["A1"], r1
assert r2["ketentuan"]["min"] == 28 and r2["benefit"]["komponen"] == [] and r2["ketentuan"]["kelipatan"] is True, r2
assert [r["rule_id"] for r in d["item_rules"]] == ["R1", "R2", "R4"] and d["flags"][-1]["jenis"] == "di_luar_cakupan", d["flags"]

# penjaga
assert [sp.ada_di_teks(x, "Disc 15.0% / Rp 3.000 / 2,5%") for x in (15, 3000, 2.5, 1, 150)] == [True, True, True, False, False]
d = doc(rule(bonus=(1, "PCS"), kode=("A1", "A3")), rule("R2", nama="ANLENE SACHET", kode=("A1",), mn=None, bonus=(1, "RTG")))
jenis = [(f["rule_id"], f["tingkat"], f["pesan"].split(":")[1].split()[0]) for f in sp.jaga(d, "BUY 4 CS FREE 1 RENCENG", M, "2026-10-28")]
assert ("R1", "kritis", "satuan") in jenis, jenis                 # G2: 1 PCS padahal surat 1 RENCENG
assert ("R1", "perlu_cek", "surat") in jenis, jenis               # G4: A3 kemasan BOX di program SACHET
assert ("R2", "kritis", "bonus") in jenis, jenis                  # G3: bonus tanpa minimum
assert sum(1 for x in jenis if x[2] == "'ANLENE") == 2, jenis     # G8: nama sama, kode beda
d = doc(rule(), rule("R2", kode=("A2",), bonus=(2, "RTG")))
benar, beda = doc(rule(), rule("R2", kode=("A2",), bonus=(1, "RTG"))), doc(rule(kode=("A1", "A2", "A3")))
f = sp.jaga(d, "BUY 4 CS FREE 1 2 RENCENG", M, "2026-10-28", [benar, beda])
assert [x["rule_id"] for x in f if "pembaca lain" in x["pesan"]] == ["R2"], f  # G7: R1 didukung, R2 (bonus 2) tidak
assert not [x for x in f if "semua pembaca" in x["pesan"]], f                  # A3 hanya di satu pemeriksa: bukan mayoritas
assert not sp.jaga(copy.deepcopy(d), "", M, "2026-10-28", [benar], frozenset(sp.fakta(d))), "fakta yang sudah disetujui tidak ditanya lagi"
lalu = copy.deepcopy(d)
lalu["flags"] = [{"jenis": "ambigu", "tingkat": "perlu_cek", "program_id": "P1", "rule_id": "R1", "pesan": "model ragu"}]
assert not sp.jaga(lalu, "", M, "2026-10-28", [beda, beda], frozenset(sp.fakta(d))) and not lalu["flags"],     "flag model di baris yang disetujui dan kode yang dulu juga diputuskan keluar (A3) tidak ditanya lagi"
assert any("A3" in f["pesan"] for f in sp.jaga(copy.deepcopy(d), "", M, "2026-10-28", [beda, beda], frozenset(sp.fakta(beda)))),     "kode yang dulu disetujui lalu hilang tetap ditanya"

# gabung + rapikan
g = sp.gabung([doc(rule()), doc(rule(kode=("A9",)))])
assert [r["rule_id"] for r in g["item_rules"]] == ["R1", "R2"] and g["item_rules"][1]["section_id"] == "P2-S1", g["item_rules"][1]
assert sp.validasi(g, {"A1", "A2"}) == ["R2: kode A9 tidak ada di master", "R2: kode A9 tidak ada di master"]
sp.rapikan(g, {"A1", "A2"})
assert g["item_rules"][1]["barang"]["kode_barang"] == [] and g["validasi"]["jumlah_rule_tanpa_kode"] == 1 and g["flags"][0]["rule_id"] == "R2"

# perintah: referensi lintas + bagian principal, blok prompt terbaca, mode per halaman hanya membawa gambar halamannya
ref = sp.referensi("ABCPI")
assert "## Lintas principal" in ref and "### ABC PI" in ref and "### DAHLIA" not in ref
s, isi = sp.pesan("ABCPI", MASTER, "2026-10-28", [("a.pdf", ["hal 1", "hal 2"])], ["g1"], 2)
assert "{{" not in s + isi[0]["text"] and "HANYA HALAMAN 2" in isi[0]["text"] and len(isi) == 2


# jalur utuh dengan Mistral tiruan: 1 surat kecil (sekaligus) + 1 surat 4 halaman (per halaman) x 3 pembaca
def pdf(n):
    with fitz.open() as x:
        for i in range(n):
            x.new_page().insert_text((72, 72), f"halaman {i + 1}")
        return x.tobytes()


panggilan = []


def tiruan(req):
    body = json.loads(req.content)
    if req.url.path.endswith("/ocr"):
        return httpx.Response(200, json={"pages": [{"markdown": "BUY 4 CS FREE 1 RENCENG"}]})
    panggilan.append(body["model"])
    teks = json.dumps(body["messages"][1]["content"])
    bonus = 2 if body["model"] == "mistral-large-latest" and "HALAMAN 3" in teks else 1  # pemeriksa membaca beda di halaman 3
    d = doc(rule(bonus=(bonus, "RTG")))
    d["flags"] = [{"jenis": "tenggat_dekat", "tingkat": "kritis", "program_id": "P1", "rule_id": None, "pesan": "model salah hitung hari"}]
    isi = json.dumps(d)  # tenggat dihitung kode (G6): flag tenggat model harus hilang di hasil akhir
    if body["model"] == "mistral-large-4":
        isi = [{"type": "thinking", "thinking": []}, {"type": "text", "text": isi}]
    return httpx.Response(200, json={"choices": [{"message": {"content": isi}}]})


async def jalan():
    async with httpx.AsyncClient(transport=httpx.MockTransport(tiruan)) as c:
        return await sp.ekstrak("UJI", [("kecil.pdf", pdf(1)), ("besar.pdf", pdf(4))], MASTER, "2026-10-28", client=c)

hasil = asyncio.run(jalan())
assert len(panggilan) == 15 and panggilan.count("mistral-large-4") == 5, panggilan  # (1 + 4 halaman) x 3 pembaca
assert [r["rule_id"] for r in hasil["item_rules"]] == ["R1", "R2", "R3", "R4", "R5"], [r["rule_id"] for r in hasil["item_rules"]]
assert not [f for f in hasil["flags"] if f["tingkat"] != "info"], hasil["flags"]  # satu pemeriksa sepakat di semua halaman
asyncio.run(jalan())
assert len(panggilan) == 15, "unggah ulang surat yang sama memakai cache, tidak membayar lagi"
print("summary_program ok")
