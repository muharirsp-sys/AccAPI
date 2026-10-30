"""Self-check rute Summary Program: gerbang setujui (0 peringatan), Form PDF, dan ingatan Summary yang disetujui ke ekstraksi berikutnya.
Pakai: python test_summary_program_router.py (ikut run_checks.py). Mistral tidak dipanggil (ekstrak ditiru)."""
import json
import os
import tempfile
from pathlib import Path

os.environ["SUMMARY_STORE_PATH"] = str(Path(tempfile.mkdtemp()) / "t.sqlite3")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import routers.summary_program as r  # noqa: E402
import summary_program as sp  # noqa: E402
from shared import MANUAL_MASTER_CACHE  # noqa: E402

r._user = lambda request, edit=False: "u|uji@x"  # sesi login ditiru; izin Summary diuji di summary_library
MANUAL_MASTER_CACHE["tok"] = {"owner": "uji@x", "items": [{"kode_barang": "A1", "nama_barang": "ANLENE 25GR SCH", "kelompok": "ANLENE",
                                                           "variant": "Coklat", "gramasi": "25GR"}]}
DOC = {"principal": "UJI", "periode_summary": {"mulai": "2026-10-01", "selesai": "2026-10-31"},
       "programs": [{"program_id": "P1", "no_surat": "001", "nama_program": "Promo", "channel": "GT", "keterangan": [],
                     "outlet": {"tipe": "tanpa_list", "kode_outlet": []}, "periode": {"mulai": "2026-10-01", "selesai": "2026-10-31"},
                     "syarat_claim": {"batas_klaim_tanggal": None, "batas_klaim_aturan": None, "ada_klaim": True, "dokumen": [], "dasar_nilai": []},
                     "sections": [{"section_id": "P1-S1", "label": "Strata", "outlet_khusus": None, "catatan": [],
                                   "kolom": [{"kolom_id": "P1-S1-K1", "label": "Min 4 CTN"}]}]}],
       "item_rules": [{"rule_id": "R1", "program_id": "P1", "section_id": "P1-S1", "kolom_id": "P1-S1-K1",
                       "barang": {"nama_di_surat": "Anlene", "kode_barang": ["A1"], "kelompok_barang": "ANLENE", "variant": "Coklat", "gramasi": "25GR"},
                       "ketentuan": {"min": 4, "max": None, "satuan": "CTN"},
                       "benefit": {"tipe": "diskon_persen", "teks_tampilan": "5%", "bonus": None,
                                   "komponen": [{"nama": "Disc", "nilai": 5, "satuan": "%", "beban": "principal"}]}}],
       "flags": [{"jenis": "anomali_angka", "tingkat": "perlu_cek", "program_id": "P1", "rule_id": "R1", "pesan": "cek"}],
       "validasi": {"jumlah_baris_produk_di_surat": 1, "jumlah_item_rules": 1, "jumlah_rule_tanpa_kode": 0}}

app = FastAPI()
app.include_router(r.router)
c = TestClient(app)
assert c.post("/summary/program/setujui", json={"doc": DOC, "token": "tok"}).status_code == 422, "masih ada peringatan: ditolak"
salah = json.loads(json.dumps(DOC))
salah["flags"], salah["item_rules"][0]["barang"]["kode_barang"] = [], ["ZZ"]
assert c.post("/summary/program/setujui", json={"doc": salah, "token": "tok"}).status_code == 422, "kode di luar master: ditolak"
bersih = {**DOC, "flags": []}
assert c.post("/summary/program/setujui", json={"doc": bersih, "token": "tok", "principal": "Uji"}).json() == {"ok": True}
pdf = c.post("/summary/program/form", json={"docs": [bersih], "token": "tok", "dibuat": "2026-10-28"})
assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF"), pdf.text[:200]

terima = {}


async def palsu(principal, berkas, master, tanggal, dikonfirmasi=frozenset(), client=None):
    terima.update(principal=principal, berkas=[n for n, _ in berkas], master=master, dikonfirmasi=dikonfirmasi)
    return bersih

sp.ekstrak = palsu
j = c.post("/summary/program/ekstrak", data={"token": "tok", "principal": "UJI", "tanggal": "2026-11-03"},
           files=[("surat", ("a.pdf", b"%PDF-1.4 uji", "application/pdf"))]).json()
assert j["ok"] and j["pembanding"]["pada"], j
assert terima["dikonfirmasi"] == frozenset(sp.fakta(bersih)), "Summary yang disetujui jadi ingatan ekstraksi berikutnya"
assert terima["master"][0]["kelompok_barang"] == "ANLENE", terima["master"]
assert c.post("/summary/program/ekstrak", data={"token": "lain", "principal": "UJI"},
              files=[("surat", ("a.pdf", b"%PDF-1.4", "application/pdf"))]).status_code == 422, "master milik orang lain / tidak ada"
print("summary_program_router ok")
