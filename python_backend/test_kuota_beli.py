"""Tujuan: Self-check kuota promo sell-in (owner 1 Nov 2026, MSM): diskon/bonus ke outlet berhenti saat qty beli berdiskon habis.
Caller: `python test_kuota_beli.py` (run_checks). Dependensi: summary_rules, kuota_beli, routers.orders, summary_store.
Main Functions: main; assert hitungan kuota (persen, bonus 100%, kelipatan), pembaca budget, simpan/pratinjau/simpan order, balapan simpan.
Side Effects: SQLite sementara di direktori temp; tidak memanggil Accurate maupun Next.
"""
import io
import os
import tempfile
from decimal import Decimal

os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(prefix="kuota-check-"), "summary.sqlite3")

import openpyxl  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import kuota_beli  # noqa: E402
import order_cabang  # noqa: E402
import outlet_channel  # noqa: E402
from routers import orders  # noqa: E402
from summary_rules import Program, calculate, compile_programs  # noqa: E402
from summary_store import connect, create_draft  # noqa: E402

SURAT = "168/MSM/MKT/VII/2026"
TIER = dict(rupiah="0", rupiah_mode="once", bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)


def program(**lain):
    isi = dict(id="P1", name="Promo", surat_program=SURAT, start="2026-11-01", end="2026-11-30", codes=["A", "B"], channel="ALL",
               unit="KRT", priority=1, source_page=1, source_quote="kutipan", kuota=True,
               tiers=[dict(TIER, minimum="1", percentages=["10"])])
    isi.update(lain)
    return Program.model_validate(isi)


def baris(code, unit, qty, price="1000"):
    return dict(code=code, unit=unit, quantity=qty, price=price, rasio={"PCS": 1, "KRT": 72})


def hitung(programs, lines, kuota):
    return calculate(programs, lines, "2026-11-05", "GT", kuota=kuota)


def cek_hitungan():
    persen = [program()]
    # Muat: diskon + pemakaian dicatat dalam satuan kuota (PCS), dari baris KRT lewat rasio.
    hasil = hitung(persen, [baris("A", "KRT", "2")], {(SURAT, "A"): (Decimal(200), "PCS")})
    assert hasil["discount"] == "200.00" and hasil["kuota"] == [dict(surat_program=SURAT, code="A", quantity="144", unit="PCS")], hasil
    # Melebihi sisa: baris TANPA diskon, alasan tercatat, tidak ada pemakaian.
    hasil = hitung(persen, [baris("A", "KRT", "3")], {(SURAT, "A"): (Decimal(200), "PCS")})
    assert hasil["discount"] == "0.00" and "kuota" not in hasil and "tidak cukup" in hasil["blocked"][0]["reason"], hasil
    # Tanpa baris kuota = gagal tertutup.
    hasil = hitung(persen, [baris("B", "PCS", "1")], {(SURAT, "A"): (Decimal(200), "PCS")})
    assert hasil["discount"] == "0.00" and "belum diisi" in hasil["blocked"][0]["reason"], hasil
    # KRT + PCS kode sama memakai SATU sisa: 72 + 100 > 150 -> baris kedua ditolak, baris pertama tetap.
    hasil = hitung(persen, [baris("A", "KRT", "1", "72000"), baris("A", "PCS", "100")], {(SURAT, "A"): (Decimal(150), "PCS")})
    assert hasil["kuota"][0]["quantity"] == "72" and [l["percents"] for l in hasil["lines"]] == [["10"], []], hasil
    # Strata dari SELURUH qty order outlet (syarat surat ke outlet), diskon hanya untuk baris ber-kuota: A+B = 2 KRT -> 4% untuk A.
    strata = [program(mix=True, tiers=[dict(TIER, minimum="1", percentages=["3"]), dict(TIER, minimum="2", percentages=["4"])])]
    hasil = hitung(strata, [baris("A", "KRT", "1"), baris("B", "KRT", "1")], {(SURAT, "A"): (Decimal(72), "PCS")})
    assert hasil["lines"][0]["percents"] == ["4"] and hasil["lines"][1]["percents"] == [], hasil
    # Diskon + bonus satu tier: diskon memakai kuota dulu, bonus hanya dari sisanya (dulu pratinjau 78 > 75 lalu simpan 409 abadi).
    campur = [program(tiers=[dict(TIER, minimum="1", percentages=["10"], bonus_code="A", bonus_quantity="6")])]
    hasil = hitung(campur, [baris("A", "KRT", "1")], {(SURAT, "A"): (Decimal(75), "PCS")})
    assert hasil["discount"] == "100.00" and hasil["bonuses"] == [] and hasil["kuota"][0]["quantity"] == "72", hasil
    # Simulasi Summary (kuota=None) memperlihatkan isi surat tanpa pemeriksaan kuota.
    assert calculate(persen, [baris("A", "KRT", "3")], "2026-11-05", "GT")["discount"] == "300.00"
    # Program tanpa kuota tidak tersentuh dan hasilnya tanpa kunci `kuota` (sidik order lama tetap sama).
    biasa = hitung([program(kuota=False)], [baris("A", "KRT", "1")], {})
    assert biasa["discount"] == "100.00" and "kuota" not in biasa and biasa["blocked"] == [], biasa

    # Medicare 80 gr "3 DUS gratis 1 DUS", per kode: bonus otomatis = SKU yang dibeli, berharga per KRT, kuota = qty bonus.
    bonus = [program(mix=False, tiers=[dict(TIER, minimum="3", bonus_quantity="1", bonus_unit="KRT", bonus_scope="purchased",
                                            repeat=True)])]
    hasil = hitung(bonus, [baris("A", "PCS", "432", "1000")], {(SURAT, "A"): (Decimal(144), "PCS")})
    assert hasil["bonuses"] == [dict(program_id="P1", code="A", unit="KRT", quantity="2", eligible_codes=["A"], price="72000.00")], hasil
    assert hasil["kuota"][0]["quantity"] == "144", hasil
    # Bonus melebihi sisa: tidak diberikan sama sekali, baris beli tetap tanpa potongan.
    hasil = hitung(bonus, [baris("A", "KRT", "6")], {(SURAT, "A"): (Decimal(71), "PCS")})
    assert hasil["bonuses"] == [] and "tidak cukup" in hasil["blocked"][0]["reason"] and hasil["discount"] == "0.00", hasil
    # 85 ml "pengambilan >= 40 DUS, 5 DUS gratis 1": 39 tidak dapat, 45 dapat 9.
    kelipatan = [program(tiers=[dict(TIER, minimum="40", bonus_quantity="1", bonus_unit="KRT", bonus_code="A", repeat=True,
                                     kelipatan="5")])]
    besar = {(SURAT, "A"): (Decimal(10000), "PCS")}
    assert hitung(kelipatan, [baris("A", "KRT", "39")], besar)["bonuses"] == []
    assert hitung(kelipatan, [baris("A", "KRT", "45")], besar)["bonuses"][0]["quantity"] == "9"

    # Penanda di Summary: "kuota beli" di keterangan menyalakan kuota; "kelipatan 5" menjadi langkah bonus.
    rows = [dict(surat_program=SURAT, kode_barangs="A", ketentuan="Beli 40 KRT, kelipatan 5 KRT", benefit_type="BONUS_QTY",
                 benefit="1 KRT", keterangan="Kuota beli: sell-in", periode_start="2026-11-01", periode_end="2026-11-30")]
    programs, issues = compile_programs(rows)
    assert not issues and programs[0]["kuota"] is True and programs[0]["tiers"][0]["kelipatan"] == "5", (programs, issues)
    rows[0]["keterangan"] = "budget principal"
    assert compile_programs(rows)[0][0]["kuota"] is False, "kata 'budget' saja tidak menyalakan kuota"
    rows[0]["ketentuan"] = "Beli 40 KRT, kelipatan 5."
    assert compile_programs(rows)[0][0]["tiers"][0]["kelipatan"] == "5", "titik di akhir kalimat bukan bagian angka"
    rows[0]["ketentuan"] = "Beli 1 KRT, kelipatan 12 PCS"
    assert "kelipatan" not in compile_programs(rows)[0][0]["tiers"][0], "langkah beda satuan diabaikan, bukan 12 KRT"


def cek_posisi():
    """Owner 1 Nov 2026: sell-in di depan; bukan sell-in + tambahan distributor di belakang; Kino/Dahlia/Forisa tetap."""
    from summary_rules import rantai_posisi
    rows = [dict(surat_program="110", kode_barangs="A", ketentuan="Setiap pengambilan, tidak ada minimum", benefit_type="DISC_PCT",
                 benefit="8+3+1.5D", principle="MSM", periode_start="2026-11-01", periode_end="2026-11-30")]
    amago = [Program.model_validate(x) for x in compile_programs(rows)[0]]
    assert amago[0].tiers[0].beban == ["P", "P", "D"] and amago[0].principal == "MSM"
    hasil = calculate(amago, [baris("A", "KRT", "1")], "2026-11-05", "GT", kuota={})
    assert hasil["lines"][0]["percents"] == ["0", "0", "1.5", "8", "3"], hasil
    sellin = program(principal="MSM", codes=["A"], tiers=[dict(TIER, minimum="1", percentages=["3"])])
    hasil = hitung([sellin], [baris("A", "KRT", "1")], {(SURAT, "A"): (Decimal(100), "PCS")})
    assert hasil["lines"][0]["percents"] == ["3"], hasil
    assert rantai_posisi([("3", "depan"), ("8", "prin"), ("1.5", "dist")]) == ["3", "0", "0", "1.5", "8"]
    assert rantai_posisi([("8", "prin"), ("2", "asli")]) == ["8", "2"], "ada bentuk lama = urutan lama"
    kino = program(principal="KINO NON FOOD", kuota=False, codes=["A"], tiers=[dict(TIER, minimum="1", percentages=["5"])])
    assert hitung([kino], [baris("A", "KRT", "1")], {})["lines"][0]["percents"] == ["5"]


def xlsx(kepala, isi):
    buku = openpyxl.Workbook()
    lembar = buku.active
    lembar.append(kepala)
    for row in isi:
        lembar.append(row)
    keluar = io.BytesIO()
    buku.save(keluar)
    return keluar.getvalue()


def cek_budget():
    assert kuota_beli.rantai("6,75+1.5+1%") == (Decimal("6.75"), Decimal("1.5"), Decimal("1"))
    assert kuota_beli.rantai("10+") == (Decimal(10),) and kuota_beli.rantai(None) == ()
    assert kuota_beli.cocok(kuota_beli.rantai("8+2+1"), (Decimal(8), Decimal(2)))
    assert kuota_beli.cocok(kuota_beli.rantai("1+10"), (Decimal(10),))
    assert not kuota_beli.cocok(kuota_beli.rantai("6+1+0.27"), (Decimal(8), Decimal("4.75")))
    assert not kuota_beli.cocok(kuota_beli.rantai("6.5+3+1"), (Decimal(3),), awal_saja=True), "jual: promo di depan rantai"
    assert kuota_beli.cocok(kuota_beli.rantai("10+0.5"), (Decimal(10),), awal_saja=True)
    pola = kuota_beli.pola_program([program(codes=["A"]), program(id="P2", codes=["B"], tiers=[
        dict(TIER, minimum="40", bonus_quantity="1", bonus_unit="KRT", bonus_code="B", repeat=True, kelipatan="5")])], SURAT)
    kepala = ["NO. PEMBELIAN", "TANGGAL", "KODE BARANG", "NAMA BARANG", "QTY", "SATUAN", "Diskon %"]
    beli = kuota_beli.baca_rincian(xlsx(kepala, [
        ["LPB1", "2026-10-05", "A", "MSM X 80GR X 72 PCS", 10, "KRT", "1+10"],   # cocok 10%
        ["LPB2", "2026-10-06", "A", "MSM X 80GR X 72 PCS", 5, "KRT", "6"],       # bukan diskon surat
        ["LPB3", "2026-10-07", "B", "MSM Y 85ML X 48 PCH", 12, "KRT", "16.70"],  # bonus 5+1 yang dipersenkan: porsi gratis 1/6
        ["LPB4", "2026-10-08", "Z", "MSM Z X 6 PCH", 9, "KRT", "10"],            # bukan barang surat
    ]), "beli")
    jual = kuota_beli.baca_rincian(xlsx(["NO_NOTA", "TANGGAL", "KODE_BARANG", "NAMA_BARANG", "QTY", "SATUAN", "Diskon %",
                                         "QTY_SATUANKECIL", "SATUAN_KECIL"], [
        ["INV1", "2026-10-20", "A", "MSM X 80GR X 72 PCS", 100, "PCS", "10+0.5", 100, "PCS"],
        ["INV2", "2026-11-02", "A", "MSM X 80GR X 72 PCS", 50, "PCS", "10", 50, "PCS"],     # sesudah program mulai: milik order web
        ["INV3", "21/10/2026", "B", "MSM Y 85ML X 48 PCH", 1, "KRT", "100", 48, "PCH"],     # bonus keluar; tanggal teks dd/mm/yyyy
    ]), "jual")
    hasil = {item["kode"]: item for item in kuota_beli.hitung_budget(pola, beli, jual, "2026-11-01")}
    assert (hasil["A"]["beli"], hasil["A"]["keluar"], hasil["A"]["budget"], hasil["A"]["satuan"]) == (720, 100, 620, "PCS"), hasil["A"]
    assert hasil["B"]["beli"] == 96 and hasil["B"]["keluar"] == 48 and hasil["B"]["budget"] == 48, hasil["B"]
    for kepala_salah, isi_salah, pesan in ((["KODE BARANG", "QTY"], [["A", 1]], "Diskon %"),
                                            (kepala, [["L", "31-Okt", "A", "N", 1, "KRT", "10"]], "tanggal"),
                                            (kepala, [["L", "2026-10-01", "A", "N", "1,5", "KRT", "10"]], "bukan angka")):
        try:
            kuota_beli.baca_rincian(xlsx(kepala_salah, isi_salah), "beli")
            raise AssertionError(f"harus ditolak: {pesan}")
        except ValueError as error:
            assert pesan in str(error), error


def publish(**lain):
    isi = program(**lain).model_dump(mode="json")
    draft = create_draft("admin@surya.local", "Surat", {"rows": [], "programs": [isi]}, None)
    with connect() as db:
        db.execute("UPDATE summary_draft SET status='published' WHERE id=?", (draft["id"],))


def cek_alur():
    outlet_channel.verify = lambda customer_no, channel: channel
    order_cabang.periksa = lambda customer_no, order_date, lines, cookie=None: [{**line, "price": "1000", "sumber_harga": "master"}
                                                                              for line in lines]
    order_cabang.periksa_bonus = lambda *args, **kwargs: None
    orders.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    orders.user_has_permission = lambda user, area, action: area != "summary" or user == "admin@surya.local"
    orders.validate_csrf_request = lambda request, token: True
    app = FastAPI()
    app.include_router(orders.router)
    client = TestClient(app)
    admin, sales = {"X-Test-User": "admin@surya.local"}, {"X-Test-User": "sales@surya.local"}
    publish(unit="PCS")

    kuota = [{"code": "A", "quantity": "30", "unit": "PCS"}]
    ditolak = client.post("/orders/kuota", headers=sales, json={"surat_program": SURAT, "rows": kuota})
    assert ditolak.status_code == 403, ditolak.text
    asing = client.post("/orders/kuota", headers=admin, json={"surat_program": SURAT, "rows": [{"code": "X", "quantity": "1", "unit": "PCS"}]})
    assert asing.status_code == 400, asing.text
    simpan = client.post("/orders/kuota", headers=admin, json={"surat_program": SURAT.lower(), "rows": kuota, "sumber": "uji"})
    assert simpan.status_code == 200 and simpan.json()["kuota"][0]["sisa"] == "30", simpan.text

    def order(qty, outlet):
        body = dict(outlet=outlet, channel="GT", order_date="2026-11-05", customer_no="C-" + outlet,
                    lines=[dict(code="A", unit="PCS", quantity=qty, price="1000")])
        lihat = client.post("/orders/preview", headers=sales, json=body).json()
        return lihat, client.post("/orders", headers=sales, json={**body, "sidik": lihat["sidik"]})

    lihat, jadi = order("20", "T1")
    assert jadi.status_code == 200 and lihat["result"]["discount"] == "2000.00" and lihat["kuota_sisa"][0]["sisa"] == "30", lihat
    lihat, jadi = order("20", "T2")
    assert jadi.status_code == 200 and lihat["result"]["discount"] == "0.00", "sisa 10 < 20: tanpa diskon, order tetap jalan"
    assert client.get("/orders/kuota", headers=sales).json()["kuota"][0]["sisa"] == "10"

    # Balapan: dua pratinjau melihat sisa 10, yang kedua disimpan sesudah yang pertama memakainya -> ditolak, tidak lewat budget.
    body = dict(outlet="T3", channel="GT", order_date="2026-11-05", customer_no="C-T3", lines=[dict(code="A", unit="PCS", quantity="10", price="1000")])
    asli = orders.hitung_order
    beku = asli("C-T3", "GT", "2026-11-05", [dict(code="A", unit="PCS", quantity="10", price="1000")])
    assert order("10", "T4")[1].status_code == 200
    orders.hitung_order = lambda *args, **kwargs: beku
    try:
        balap = client.post("/orders", headers=sales, json={**body, "sidik": beku["sidik"]})
    finally:
        orders.hitung_order = asli
    assert balap.status_code == 409 and balap.json()["kode"] == "KUOTA_BERUBAH", balap.text
    assert client.get("/orders/kuota", headers=sales).json()["kuota"][0]["sisa"] == "0"


if __name__ == "__main__":
    cek_hitungan()
    cek_posisi()
    cek_budget()
    cek_alur()
    print("test_kuota_beli: OK")
