"""Tujuan: Mengunci perbaikan surat DAHLIA MT -- 083 (MT Pareto) dan 234 (MT Silver), 24 Sep 2026.

Empat cacat yang membuat Form tidak lagi sesuai surat, masing-masing dijaga di sini:
1. `append_rows` membuang baris "kembar" yang jati dirinya TANPA barang: tujuh kode 083
   berafaksi Rp 1.000 dianggap satu baris; enam grup 234 dianggap satu baris.
2. Pemekaran "ALL VARIANT" se-kelompok memberi rafaksi kepada barang yang TIDAK disebut surat
   083 (K31CV, K31GL, LT121, ...) -- kolom matriks MT adalah satu barang, bukan wakil keluarga.
3. Kunci lebur Form menyamakan `DH AIR F` dengan induk `DH AIR F - HER`: F601AH tercetak Heritage.
4. Barang banded bertanda `BDD` (F601TK-BND) lolos penyaring yang hanya mengenal `BND`.
Plus: baris tertahan tanpa benefit dan tanpa kode tidak dilebur jadi satu sel setinggi halaman.

Caller: `python test_surat_mt_dahlia.py`, dan run_checks.py.
Side Effects: SQLite & PDF sementara; tidak menyentuh produksi, tidak memanggil AI.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
_TMP = tempfile.mkdtemp(prefix="uji_mt_dahlia_")
os.environ["SUMMARY_STORE_PATH"] = str(Path(_TMP) / "uji.sqlite3")
sys.path.insert(0, str(BASE))

from starlette.datastructures import Headers  # noqa: E402
from dahlia_letter import match_items, parse_text  # noqa: E402
from routers import summary as backend  # noqa: E402
from shared import MANUAL_MASTER_CACHE, MANUAL_OUTPUTS, _apply_native_kelompok  # noqa: E402
from summary_store import append_rows, create_draft, identity  # noqa: E402

PENGGUNA = "betterauth|admin|uji@local"


def it(kode, nama, kelompok, variant, gramasi):
    return {"kode_barang": kode, "nama_barang": nama, "kelompok": kelompok, "variant": variant,
            "gramasi": gramasi, "principle": "DAHLIA"}


MASTER = [
    it("U3020003005511", "F601AH DH AIR F APPLE HARMONY 55GRX24PCS", "DH AIR F", "APPLE HARMONY", "55GR"),
    it("U3020013005510", "F601JO DH AIR F JOLLY ORANGE 55GRX24PCS", "DH AIR F", "JOLLY ORANGE", "55GR"),
    it("U3020012005510", "F601TM DH AIR F TROPICAL MANGO 55GRX24PCS", "DH AIR F", "TROPICAL MANGO", "55GR"),
    it("U3020202007510", "F601TK DH AIR F HER TEH KERATON 75GRX72PCS", "DH AIR F - HER", "TEH KERATON", "75GR"),
    it("U3020202007599", "F601TK-BND DH AIR F HER TEH KERATON 75GRX72PCS BDD", "DH AIR F - HER", "TEH KERATON", "75GR"),
    it("U3020201007510", "F601CP DH AIR F HER CENDANA PADI 75GRX72PCS", "DH AIR F - HER", "CENDANA PADI", "75GR"),
    # Banded yang HANYA bertanda "BDD" di ekor namanya, tanpa "-BND" pada kodenya.
    it("U3020201007598", "F601CPB DH AIR F HER CENDANA PADI 75GRX72PCS BDD", "DH AIR F - HER", "CENDANA PADI", "75GR"),
]

MT_PARETO = """PROMO NASIONAL MT SEPTEMBER 2026
JENIS PROGRAM : Rafraksi Nasional MT
CHANNEL : MT PARETO
NO. PROPOSAL : 083/TMDH2/08/26#SUR030
PERIODE PROP : 01-Sep-2026 – 30-Sep-2026
BATAS KLAIM : 31-Dec-2026
Strata Account F601AH F601JO F601TK
(1-30) (1-30) (1-30)
Diamond Independent 1.000 1.000 1.000
Gold Independent 1.000 1.000 1.000
"""

# Dipangkas dari lapisan teks pypdf surat 234 yang asli (MT Silver, September 2026).
MT_SILVER = """PROMO NASIONAL MT SILVER SEPTEMBER 2026
JENIS PROGRAM : Promo MT Silver Nasional
CHANNEL : MT PARETO
NO. PROPOSAL : 234/TMDH1/08/26#SUR030
PERIODE PROP : 01-Sep-2026 – 30-Sep-2026
BATAS KLAIM : 31-Dec-2026
Mekanisme Program
No Grup Produk Strata / Min Order Disc Reguler Distributor Add. Discount (On Faktur) Add. Promo Extra Discount (Off Faktur)
1 AF Gel - Heritage
* Sesuai Min. Qty Pembelian terlampir
   (Tidak Boleh Campur - Sesuai target item terlampir)
* Bonus Berlaku Kelipatan, sesuai strata min. order
3% - 5% - 12 bonus 1 -
2 AF Refill Matic - Heritage * Sesuai Min. Qty Pembelian terlampir
* Add Disc Tidak Berlaku Kelipatan 3% - 5% 0.05 - -
3 AF Refill Matic - Heritage (F617TK) * Sesuai Min. Qty Pembelian terlampir
* Bonus Berlaku Kelipatan, sesuai strata min. order3% - 5% - 12 bonus 1 -
4 Dahlia Kamper Ruangan
* Sesuai Min. Qty Pembelian terlampir
   (Boleh Campur - Bonus SKU Sejenis)
* WAJIB ada item K316EU
* Bonus Berlaku Kelipatan, sesuai strata min. order
8% - 10% - 24 bonus 1 -
Detail Item per Distributor / Account
MIN. QTY PEMBELIAN BONUS PEMBELIAN
F601AD F601TK
(F617TK)
LT122N LT123 Min
CV SURYA
PERKASA
C-
BEN007
MART {C-BEN007} Independent INDEPENDENT 0 72 12 24 120 12 12 - 6 1 1 5 1 1 24 0.05
CV.TOP MURAH {C-
TOP005} Independent INDEPENDENT 12 24 12 0 48 12 0 1 2 1 - 2 1 - 0 -
"""


class FakeRequest:
    headers = Headers({})
    cookies = {}


def sidecar(rows, token):
    hasil = backend.summary_manual_generate(FakeRequest(), token=token, rows_json=json.dumps(rows))
    assert hasil.get("ok"), hasil
    return json.loads(Path(MANUAL_OUTPUTS[hasil["file_id"]]["rows"]).read_text(encoding="utf-8"))["rows"]


def main():
    # --- 2. Bentuk B: kolom matriks = SATU barang, dengan kelompok/varian/gramasi masternya.
    mt = match_items(parse_text(MT_PARETO)["rows"], MASTER)
    assert [r["kode_barangs"] for r in mt] == ["U3020003005511", "U3020013005510", "U3020202007510"], mt
    ah = mt[0]
    assert (ah["kelompok"], ah["variant"], ah["gramasi"]) == ("DH AIR F", "APPLE HARMONY", "55GR"), ah
    # ... dan karenanya TIDAK dimekarkan: F601TM (se-kelompok, se-gramasi) tidak disebut surat.
    mekar = _apply_native_kelompok([dict(ah)], MASTER)
    assert mekar[0]["kode_barangs"] == "U3020003005511", mekar[0]["kode_barangs"]
    # Pembanding: baris yang sama dengan ALL VARIANT memang dimekarkan -- penjaganya nyata.
    semua = _apply_native_kelompok([dict(ah, variant="ALL VARIANT", gramasi="ALL GRAMASI")], MASTER)
    assert "U3020012005510" in semua[0]["kode_barangs"], semua[0]["kode_barangs"]

    # --- 4. Banded `BDD` tidak ikut dimekarkan (dulu hanya `BND` yang dikenali).
    her = _apply_native_kelompok([{"kelompok": "DH AIR F - HER", "variant": "ALL VARIANT", "gramasi": "ALL GRAMASI",
                                   "kode_barangs": "U3020202007510"}], MASTER)
    assert "U3020201007510" in her[0]["kode_barangs"], her[0]["kode_barangs"]
    assert "U3020202007599" not in her[0]["kode_barangs"], "barang -BND ikut dimekarkan"
    assert "U3020201007598" not in her[0]["kode_barangs"], "barang bertanda BDD ikut dimekarkan"

    # --- Bentuk C: satu baris per grup, SEMUA ditahan, kode surat dan outlet lampiran tercatat.
    silver = parse_text(MT_SILVER)
    grup = silver["rows"]
    assert len(grup) == 5, [r["keterangan"][:40] for r in grup]  # 4 grup + 1 baris lampiran
    assert all(r["benefit"] == "" and r["kelompok"] == "" for r in grup), grup
    assert "12 bonus 1" in grup[0]["keterangan"] and "Tidak Boleh Campur" in grup[0]["keterangan"], grup[0]
    assert "Add. Disc (On Faktur) 0.05" in grup[1]["keterangan"], grup[1]
    assert "kode 'F617TK'" in grup[2]["keterangan"], grup[2]
    assert "kode 'K316EU'" in grup[3]["keterangan"] and "24 bonus 1" in grup[3]["keterangan"], grup[3]
    lampiran = grup[4]["keterangan"]
    for kode in ("F601AD", "F601TK", "LT122N", "LT123"):
        assert f"kode '{kode}'" in lampiran, (kode, lampiran)
    assert "BEN007'" not in lampiran and "C-BEN007" in lampiran and "C-TOP005" in lampiran, lampiran
    assert "kode 'F617TK'" not in lampiran, "kode yang sudah disebut grupnya tidak diulang"

    # --- 1. Jati diri `append_rows` memuat BARANG: kode berbeda tidak dibuang sebagai kembar.
    def baris(kode, kutipan):
        return {"surat_program": "083/TMDH2/08/26#SUR030", "ketentuan": "Tidak ada minimum pembelian",
                "benefit_type": "DISC_RP", "benefit": "1000", "kode_barangs": kode, "source_quote": kutipan,
                "kelompok": "", "keterangan": ""}
    draft = create_draft(PENGGUNA, "UJI MT", {"rows": [baris("U3020003005511", "Strata Account F601AH: ...")]})
    sesudah = append_rows(draft["id"], PENGGUNA, [
        baris("U3020013005510", "Strata Account F601JO: ..."),
        baris("U3020003005511", "Strata Account F601AH: ..."),  # surat yang sama diunggah ulang
    ])
    kode = [r["kode_barangs"] for r in sesudah["content"]["rows"]]
    assert kode == ["U3020003005511", "U3020013005510"], kode

    # --- 3 + baris tertahan: Form lewat endpoint sungguhan.
    backend.get_current_user = lambda request: PENGGUNA
    backend.user_has_permission = lambda *a, **k: True
    backend.validate_csrf_request = lambda request, token: True
    token = "uji-mt-dahlia"
    MANUAL_MASTER_CACHE[token] = {"owner": identity(PENGGUNA), "kelompok": [], "variant_map": {},
                                  "gramasi_map": {}, "items": MASTER, "customers": [], "principle_name": "DAHLIA"}
    umum = {"principle": "DAHLIA", "surat_program": "083/TMDH2/08/26#SUR030", "nama_program": "PROMO MT",
            "channel_gtmt": "MT PARETO", "periode_start": "2026-09-01", "periode_end": "2026-09-30",
            "ketentuan": "Tidak ada minimum pembelian", "benefit_type": "DISC_RP", "benefit": "1000",
            "syarat_claim": "", "keterangan": "", "outlet_classes": "", "outlet_mode": "", "channel_list": "",
            "source_page": 1}
    rows = [dict(umum, no=str(i + 1), **{k: r[k] for k in ("kelompok", "variant", "gramasi", "kode_barangs", "source_quote")})
            for i, r in enumerate(mt)]
    cetak = sidecar(rows, token)
    kelompok = {r["kelompok"]: r["kode_barangs"] for r in cetak}
    assert kelompok.get("DH AIR F") == ["F601AH", "F601JO"], cetak
    assert kelompok.get("DH AIR F - HER") == ["F601TK"], cetak

    tahan = [dict(umum, no=str(i + 1), kelompok="", variant="", gramasi="", kode_barangs="", benefit="", benefit_type="",
                  source_quote=f"{i + 1} grup {i + 1}", keterangan=f"DITAHAN: grup {i + 1}") for i in range(3)]
    cetak = sidecar(tahan, token)
    assert len(cetak) == 3, [r["keterangan"] for r in cetak]

    print("OK test_surat_mt_dahlia: bentuk B/C, jati diri append, kunci lebur, banded BDD")


if __name__ == "__main__":
    main()
