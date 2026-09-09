"""Tujuan: Self-check aturan promo terbit dan kepemilikan draft Summary.
Caller: `python test_summary_rules.py` (tanpa framework). Dependensi: summary_rules, summary_store.
Main Functions: main; assert tier, mix, stacking, repeat, alokasi rupiah, owner, dan alur draft.
Side Effects: SQLite sementara di direktori temp; tidak memanggil Mistral/Accurate.
"""
import os
import tempfile
from decimal import Decimal

os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(prefix="summary-check-"), "summary.sqlite3")

from summary_rules import calculate, compile_programs, suggestions, validate_programs  # noqa: E402
from summary_store import create_draft, get_draft, identity  # noqa: E402

MASTER = {"A", "B", "C"}


def program(**overrides):
    base = dict(id="P1", name="Program", start="2026-01-01", end="2026-12-31", codes=["A"], channel="ALL",
                unit="PCS", priority=1, tiers=[dict(minimum="10", percentages=["5"])], source_page=1, source_quote="kutipan")
    return {**base, **overrides}


def run(raw, lines, channel="GT", when="2026-06-01", pages=1):
    return calculate(validate_programs(raw, MASTER, pages), lines, when, channel)


def line(code="A", qty="10", price="10000", unit="PCS"):
    return dict(code=code, unit=unit, quantity=qty, price=price)


def rejects(raw, note):
    try:
        validate_programs(raw, MASTER, 1)
    except Exception:
        return
    raise AssertionError(f"harus ditolak: {note}")


def main():
    # Tier tertinggi yang terpenuhi, bukan tier pertama.
    result = run([program(tiers=[dict(minimum="10", percentages=["5"]), dict(minimum="20", percentages=["10"])])], [line(qty="25")])
    assert result["gross"] == "250000.00" and result["discount"] == "25000.00" and result["net"] == "225000.00", result

    # Di bawah minimum: tanpa diskon.
    assert run([program()], [line(qty="9")])["discount"] == "0.00"

    # Persen bertingkat berlipat pada nilai sisa, bukan dijumlahkan.
    result = run([program(tiers=[dict(minimum="1", percentages=["10", "5"])])], [line(qty="1", price="1000")])
    assert result["discount"] == "145.00", result  # 1000 -> 900 -> 855

    # Mix menggabungkan kuantitas dan mengalokasikan diskon tanpa kehilangan sen.
    result = run([program(codes=["A", "B"], mix=True)], [line("A", "6", "1000"), line("B", "5", "2000")])
    assert result["discount"] == "800.00", result  # (6000+10000) * 5%
    assert sum(Decimal(row["gross"]) - Decimal(row["net"]) for row in result["lines"]) == Decimal("800.00"), result

    # Tanpa mix, tiap baris dinilai sendiri dan keduanya belum memenuhi minimum.
    assert run([program(codes=["A", "B"])], [line("A", "6", "1000"), line("B", "5", "2000")])["discount"] == "0.00"

    # Stacking hanya berlaku bila kedua program mengizinkannya.
    stacked = [program(id="P1", priority=1, stacking=True, tiers=[dict(minimum="1", percentages=["10"])]),
               program(id="P2", priority=2, stacking=True, tiers=[dict(minimum="1", percentages=["10"])])]
    assert run(stacked, [line(qty="1", price="1000")])["discount"] == "190.00"
    single = [stacked[0], {**stacked[1], "stacking": False}]
    assert run(single, [line(qty="1", price="1000")])["discount"] == "100.00"

    # Paket berulang mengalikan bonus, bukan diskon persen.
    result = run([program(tiers=[dict(minimum="10", rupiah="1000", bonus_code="B", bonus_quantity="1", repeat=True)])], [line(qty="25")])
    assert result["bonuses"] == [dict(program_id="P1", code="B", unit="PCS", quantity="2")], result
    assert result["discount"] == "2000.00", result

    # Potongan per satuan mengikuti jumlah barang.
    result = run([program(tiers=[dict(minimum="1", rupiah="500", rupiah_mode="per_unit")])], [line(qty="4")])
    assert result["discount"] == "2000.00", result

    # Diskon tidak boleh melebihi nilai baris.
    assert run([program(tiers=[dict(minimum="1", rupiah="999999")])], [line(qty="1", price="1000")])["net"] == "0.00"

    # Batas nilai memakai nilai seluruh order bila diminta.
    value = program(threshold="value", value_scope="order", codes=["A"], tiers=[dict(minimum="50000", percentages=["10"])])
    assert run([value], [line("A", "1", "10000"), line("B", "1", "45000")])["discount"] == "1000.00"

    # Channel dan periode di luar cakupan tidak dihitung.
    assert run([program(channel="MT")], [line()])["discount"] == "0.00"
    assert run([program()], [line()], when="2027-01-01")["discount"] == "0.00"

    # Satuan berbeda tidak dikonversi diam-diam.
    assert run([program()], [line(unit="CTN")])["discount"] == "0.00"

    rejects([program(tiers=[dict(minimum="10")])], "tier tanpa benefit")
    rejects([program(tiers=[dict(minimum="20", percentages=["5"]), dict(minimum="10", percentages=["10"])])], "tier tidak urut")
    rejects([program(codes=["Z"])], "kode di luar master")
    rejects([program(end="2025-01-01")], "periode terbalik")
    rejects([program(source_page=2)], "halaman sumber di luar dokumen")
    rejects([program(), program(id="P2")], "prioritas duplikat")
    rejects([program(tiers=[dict(minimum="10", percentages=["5"], repeat=True)])], "persen diulang per paket")
    rejects([program(tiers=[dict(minimum="10", bonus_code="B")])], "bonus tanpa jumlah")
    rejects([program(tiers=[dict(minimum="10", bonus_code="B", bonus_quantity="1", bonus_scope="purchased")])], "bonus purchased dengan kode tunggal")
    rejects([program(tiers=[dict(minimum="10", bonus_scope="purchased")])], "bonus purchased tanpa jumlah")
    rejects([{**program(), "catatan": "x"}], "field tak dikenal")

    for bad, note in [([line(qty="0")], "kuantitas nol"), ([line(), line()], "baris duplikat"), ([], "order kosong")]:
        try:
            run([program()], bad)
            raise AssertionError(f"harus ditolak: {note}")
        except ValueError:
            pass

    # Draft hanya terbaca oleh pemiliknya; prefix sesi diabaikan saat membandingkan identitas.
    draft = create_draft("session|Ari@Example.com", "Surat", {"rows": []}, b"%PDF-1.4 dummy")
    assert identity("session|Ari@Example.com") == "ari@example.com"
    assert get_draft(draft["id"], "ari@example.com")["title"] == "Surat"
    assert get_draft(draft["id"], "lain@example.com") is None
    print("summary rules check: OK")
    check_compiler()
    check_codes()
    check_suggestions()
    check_flow()


def row(**overrides):
    base = dict(no="1", promo_group_id="", nama_program="Promo A", channel_gtmt="GT", periode_start="2026-06-01",
                periode_end="2026-06-30", kelompok="Kelompok A", ketentuan="Beli 10", benefit_type="DISC_PCT",
                benefit="5%", keterangan="", kode_barangs="A", source_page=1, source_quote="kutipan")
    return {**base, **overrides}


def compiled(rows, pages=1):
    programs, issues = compile_programs(rows)
    return validate_programs(programs, MASTER, pages), issues


def check_compiler():
    # Satu baris menjadi satu program persen dengan minimum dari ketentuan.
    programs, issues = compiled([row()])
    assert issues == [] and len(programs) == 1, (programs, issues)
    assert programs[0].tiers[0].minimum == "10" and programs[0].tiers[0].percentages == ["5"], programs[0]

    # Beda ketentuan pada barang/periode/channel sama digabung menjadi tier bertingkat dan diurutkan.
    programs, issues = compiled([row(no="1", ketentuan="Beli 20", benefit="10"), row(no="2", ketentuan="Beli 10", benefit="5")])
    assert issues == [] and len(programs) == 1, (programs, issues)
    assert [tier.minimum for tier in programs[0].tiers] == ["10", "20"], programs[0]

    # Trigger sama dengan dua jenis benefit digabung dalam satu tier.
    programs, issues = compiled([row(no="1"), row(no="2", benefit_type="DISC_RP", benefit="4.700")])
    assert issues == [] and programs[0].tiers[0].rupiah == "4700" and programs[0].tiers[0].percentages == ["5"], programs[0]

    # Barang berbeda menjadi program terpisah dengan prioritas unik.
    programs, issues = compiled([row(no="1"), row(no="2", kode_barangs="B", nama_program="Promo B")])
    assert issues == [] and [p.priority for p in programs] == [1, 2] and len(programs) == 2, programs

    # "X+Y" sudah dipisah hulu: bonus butuh satu kode dan mengambil satuan dari benefit.
    programs, issues = compiled([row(ketentuan="Beli 7 CTN", benefit_type="BONUS_QTY", benefit="1 PCS")])
    assert issues == [] and programs[0].unit == "CTN", programs[0]
    assert programs[0].tiers[0].bonus_code == "A" and programs[0].tiers[0].bonus_quantity == "1", programs[0]
    # Bonus atas kelompok multi-kode: hak bonus tetap sah, SKU-nya dipilih saat order.
    programs, issues = compiled([row(kode_barangs="A,B", benefit_type="BONUS_QTY", benefit="1 PCS")])
    assert issues == [] and programs[0].tiers[0].bonus_scope == "purchased" and programs[0].tiers[0].bonus_code == "", programs[0]
    result = calculate(programs, [line("A", "10", "1000"), line("B", "10", "1000")], "2026-06-15", "GT")
    assert result["bonuses"] == [dict(program_id="P1", code="", unit="PCS", quantity="1", eligible_codes=["A"]),
                                 dict(program_id="P1", code="", unit="PCS", quantity="1", eligible_codes=["B"])], result["bonuses"]

    # Sel PAKET mentah "22+2" = beli 22 gratis 2, bukan beli 24; CR bukan benefit.
    programs, issues = compiled([row(ketentuan="22+2", benefit_type="CR", benefit="8%")])
    assert issues == [] and programs[0].tiers[0].minimum == "22", (programs, issues)
    assert programs[0].tiers[0].bonus_quantity == "2" and programs[0].tiers[0].bonus_code == "A", programs[0]
    assert programs[0].tiers[0].percentages == [] and programs[0].tiers[0].rupiah == "0", programs[0]
    programs, issues = compiled([row(ketentuan="10+2", kode_barangs="A,B")])
    assert issues == [] and programs[0].tiers[0].bonus_scope == "purchased", programs[0]
    programs, issues = compile_programs([row(benefit_type="CR", benefit="13%")])
    assert programs == [] and "CR" in issues[0], issues

    # Penanda mix dan stacking hanya diambil dari teks eksplisit.
    programs, _ = compiled([row(ketentuan="Beli 10 Boleh Mix Kelompok dan Gramasi Barang Sama", kode_barangs="A,B")])
    assert programs[0].mix is True and programs[0].stacking is False, programs[0]
    programs, _ = compiled([row(keterangan="Dapat digabung dengan promo lain")])
    assert programs[0].stacking is True, programs[0]

    # Nilai rupiah minimum menjadi batas nilai, bukan kuantitas.
    programs, _ = compiled([row(ketentuan="Pembelian Rp 5.000.000", benefit_type="DISC_RP", benefit="100000")])
    assert programs[0].threshold == "value" and programs[0].tiers[0].minimum == "5000000", programs[0]

    # Pernyataan eksplisit "tidak ada pembatasan pembelian" berarti minimum 1, bukan tebakan.
    for text in ("Setiap pembelian all produk", "Tidak Ada Pembatasan Kelipatan Pembelian dan Bonus Produk", "Tanpa minimum pembelian"):
        programs, issues = compiled([row(ketentuan=text)])
        assert issues == [] and programs[0].tiers[0].minimum == "1", (text, issues)

    # Periode draft dipakai bila surat hanya mencetak periode di kepala; periode baris tetap menang.
    programs, issues = compile_programs([row(periode_start="", periode_end="")])
    assert programs == [] and len(issues) == 1, issues
    programs, issues = compile_programs([row(periode_start="", periode_end="")], period=("2026-03-01", "2026-03-31"))
    assert issues == [] and (programs[0]["start"], programs[0]["end"]) == ("2026-03-01", "2026-03-31"), (programs, issues)
    programs, _ = compile_programs([row()], period=("2026-03-01", "2026-03-31"))
    assert (programs[0]["start"], programs[0]["end"]) == ("2026-06-01", "2026-06-30"), programs
    # Periode draft yang tidak baku tidak menyelamatkan baris tanpa tanggal.
    programs, issues = compile_programs([row(periode_start="", periode_end="")], period=("Maret 2026", ""))
    assert programs == [] and len(issues) == 1, issues

    # Baris tidak lengkap dilaporkan, tidak ditebak, dan tidak menghasilkan program.
    for bad, note in [
        (row(kode_barangs=""), "kode kosong"),
        (row(periode_start="Juni 2026"), "periode tidak baku"),
        (row(ketentuan="Berlaku untuk semua outlet channel MTI lokal"), "tanpa trigger pembelian"),
        (row(benefit="lima persen"), "persen tidak terbaca"),
        (row(benefit_type="CR", benefit="13"), "benefit_type asing"),
        (row(benefit_type="DISC_RP", benefit="Cut Price 4.700"), "rupiah bercampur teks"),
    ]:
        programs, issues = compile_programs([bad])
        assert programs == [] and len(issues) == 1, (note, programs, issues)

    # Angka ambigu tidak dipaksa menjadi nilai apa pun.
    assert compile_programs([row(benefit_type="DISC_RP", benefit="4,7000")])[0] == []
    print("summary compiler check: OK")


def check_flow():
    """Alur draft -> tinjau -> terbit lewat HTTP, tanpa memanggil Mistral atau Accurate."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import summary_library as library
    import summary_store

    library.get_current_user = lambda request: request.headers.get("X-Test-User") or None
    library.user_has_permission = lambda user, area, level: user != "tamu@example.com"
    library.validate_csrf_request = lambda request, token: True
    app = FastAPI()
    app.include_router(library.router)
    client = TestClient(app)
    owner = {"X-Test-User": "ari@example.com"}
    other = {"X-Test-User": "budi@example.com"}

    content = {"rows": [row()], "master": {"items": [{"kode_barang": code} for code in sorted(MASTER)]},
               "extraction": {"page_count": 1, "model": "mistral-ocr-4-1"}}
    draft = summary_store.create_draft("ari@example.com", "Surat Program", content, b"%PDF-1.4 dummy")
    draft_id = draft["id"]

    assert client.get(f"/summary/library/{draft_id}").status_code == 401
    assert client.get(f"/summary/library/{draft_id}", headers=other).status_code == 404
    assert client.get(f"/summary/library/{draft_id}", headers={"X-Test-User": "tamu@example.com"}).status_code == 403
    assert client.get(f"/summary/library/{draft_id}/source", headers=other).status_code == 404
    assert client.get(f"/summary/library/{draft_id}/source", headers=owner).content.startswith(b"%PDF-")

    detail = client.get(f"/summary/library/{draft_id}", headers=owner).json()
    assert detail["issues"] == [] and len(detail["programs"]) == 1, detail

    # Revisi basi ditolak; baris tak lengkap menghasilkan issue, bukan aturan diam-diam.
    stale = client.put(f"/summary/library/{draft_id}", headers=owner, json={"title": "Surat", "rows": [row()], "revision": 99})
    assert stale.status_code == 409, stale.text
    saved = client.put(f"/summary/library/{draft_id}", headers=owner,
                       json={"title": "Surat", "rows": [row(kode_barangs="")], "revision": detail["draft"]["revision"]}).json()
    assert saved["programs"] == [] and len(saved["issues"]) == 1, saved

    # Publikasi ditolak selama masih ada issue, walau sudah ditandai ditinjau.
    revision = saved["draft"]["revision"]
    blocked = client.post(f"/summary/library/{draft_id}/publish", headers=owner, json={"reviewed": True, "revision": revision})
    assert blocked.status_code == 400 and "kode barang" in blocked.json()["detail"], blocked.text

    saved = client.put(f"/summary/library/{draft_id}", headers=owner, json={"title": "Surat", "rows": [row()], "revision": revision}).json()
    revision = saved["draft"]["revision"]
    assert client.post(f"/summary/library/{draft_id}/publish", headers=owner, json={"revision": revision}).status_code == 400
    published = client.post(f"/summary/library/{draft_id}/publish", headers=owner, json={"reviewed": True, "revision": revision})
    assert published.status_code == 200 and published.json()["draft"]["status"] == "published", published.text
    # Panel tinjauan tidak boleh kosong setelah terbit: aturan beku ikut dikembalikan.
    assert len(published.json()["programs"]) == 1 and published.json()["issues"] == [], published.text

    # Setelah terbit: baris beku, aturan beku, dan perhitungan deterministik.
    revision = published.json()["draft"]["revision"]
    assert client.put(f"/summary/library/{draft_id}", headers=owner, json={"title": "Surat", "rows": [row()], "revision": revision}).status_code == 409
    simulated = client.post(f"/summary/library/{draft_id}/simulate", headers=owner,
                            json={"date": "2026-06-15", "channel": "GT", "lines": [{"code": "A", "unit": "PCS", "quantity": "10", "price": "10000"}]})
    assert simulated.json()["result"]["discount"] == "5000.00", simulated.text
    feed = client.get("/summary/library/published", headers=owner).json()
    assert any(item["id"] == draft_id and item["rules"] for item in feed["programs"]), feed
    pulled = client.post(f"/summary/library/{draft_id}/withdraw", headers=owner, json={"revision": revision})
    assert pulled.status_code == 200 and len(pulled.json()["programs"]) == 1, pulled.text
    feed = client.get("/summary/library/published", headers=owner).json()
    assert all(item["rules"] == [] for item in feed["programs"] if item["id"] == draft_id), feed
    print("summary flow check: OK")


def check_codes():
    """Pencocokan kode hanya lewat nama master utuh; merek saja tidak pernah menghasilkan kode."""
    from summary_mistral import attach_codes

    catalog = [{"code": "BLA-EDT-100", "name": "Bella Eau de Toilette 100ml", "group": ""},
               {"code": "BLA-ROL-050", "name": "Bella Roll On 50ml", "group": ""},
               {"code": "BLA-ROL-050X", "name": "Bella Roll On 50ml Extra", "group": ""},
               {"code": "BLA-EDT-100B", "name": "Bella Eau de Toilette 100ml", "group": ""},
               {"code": "CAM-BDL-100", "name": "Camel Body Lotion 100ml", "group": ""}]

    def code_row(**overrides):
        base = dict(no="1", kode_barangs="", kelompok="", variant="", gramasi="", ketentuan="", keterangan="", source_quote="")
        return {**base, **overrides}

    warnings, rows = [], [
        code_row(no="1", kelompok="Bella Eau de Toilette 100ml", source_quote="Beli 10 diskon 5%"),
        code_row(no="2", source_quote="Bella Roll On 50ml Extra 4+1"),
        code_row(no="3", kelompok="BELLA", source_quote="| BELLA | - | - |"),
        code_row(no="4", kelompok="Bella Roll On 50ml dan Camel Body Lotion 100ml boleh mix"),
        code_row(no="5", kode_barangs="CAM-BDL-100", kelompok="Bella Roll On 50ml"),
    ]
    attach_codes(rows, catalog, warnings)
    # Satu nama dengan dua pecahan kode: keduanya diisi.
    assert rows[0]["kode_barangs"] == "BLA-EDT-100,BLA-EDT-100B", rows[0]
    # Nama panjang tidak menarik nama yang menjadi bagiannya.
    assert rows[1]["kode_barangs"] == "BLA-ROL-050X", rows[1]
    # Merek saja tetap kosong; manusia yang memilih.
    assert rows[2]["kode_barangs"] == "", rows[2]
    # Dua produk pada baris mix menghasilkan dua kode.
    assert rows[3]["kode_barangs"] == "BLA-ROL-050,CAM-BDL-100", rows[3]
    # Kode yang sudah dipilih manusia tidak ditimpa.
    assert rows[4]["kode_barangs"] == "CAM-BDL-100", rows[4]
    assert len(warnings) == 3, warnings
    print("summary code-match check: OK")


def check_suggestions():
    """Saran "kurang berapa lagi" yang dilihat sales harus sama dasarnya dengan kalkulator."""
    def advise(raw, lines, channel="GT", when="2026-06-15"):
        return suggestions(validate_programs(raw, MASTER, 1), lines, when, channel)

    # Kasus 12+1: toko order 10, kurang 2 untuk bonus 1 PCS.
    paket = program(tiers=[dict(minimum="12", bonus_code="A", bonus_quantity="1", bonus_unit="PCS")])
    advice = advise([paket], [line("A", "10", "5000")])
    assert len(advice) == 1 and advice[0]["gap"] == "2", advice
    assert advice[0]["message"] == "Tambah 2 PCS lagi untuk bonus 1 PCS A", advice[0]["message"]

    # Tier tertinggi sudah tercapai: tidak ada saran yang dipaksakan.
    assert advise([paket], [line("A", "12", "5000")]) == []

    # Batas nilai: order 800rb dari minimum 1jt -> kurang Rp 200.000.
    nilai = program(threshold="value", tiers=[dict(minimum="1000000", percentages=["2"])])
    advice = advise([nilai], [line("A", "8", "100000")])
    assert advice[0]["message"] == "Tambah Rp 200.000 lagi untuk diskon 2%", advice[0]["message"]

    # Tier bertingkat: yang disarankan tier berikutnya, bukan tier tertinggi.
    bertingkat = program(tiers=[dict(minimum="10", percentages=["5"]), dict(minimum="20", percentages=["10"])])
    advice = advise([bertingkat], [line("A", "12", "1000")])
    assert len(advice) == 1 and advice[0]["minimum"] == "20" and advice[0]["gap"] == "8", advice

    # Saran diurutkan dari yang paling mudah dicapai.
    dua = [program(id="P1", priority=1, tiers=[dict(minimum="30", percentages=["5"])]),
           program(id="P2", priority=2, tiers=[dict(minimum="12", percentages=["5"])])]
    advice = advise(dua, [line("A", "10", "1000")])
    assert [item["gap"] for item in advice] == ["2", "20"], advice

    # Program di luar channel atau periode tidak memunculkan saran palsu.
    assert advise([program(channel="MT", tiers=[dict(minimum="99", percentages=["5"])])], [line("A", "1", "1000")]) == []
    assert advise([bertingkat], [line("A", "1", "1000")], when="2027-01-01") == []

    # Mix menjumlahkan kelompok; tanpa mix tiap baris dihitung sendiri.
    mixed = program(codes=["A", "B"], mix=True, tiers=[dict(minimum="12", percentages=["5"])])
    assert advise([mixed], [line("A", "5", "1000"), line("B", "5", "1000")])[0]["gap"] == "2"
    solo = program(codes=["A", "B"], tiers=[dict(minimum="12", percentages=["5"])])
    assert [item["gap"] for item in advise([solo], [line("A", "5", "1000"), line("B", "5", "1000")])] == ["7", "7"]

    # Angka yang dijanjikan cocok dengan hasil kalkulator setelah ditambah.
    valid = validate_programs([paket], MASTER, 1)
    after = calculate(valid, [line("A", "12", "5000")], "2026-06-15", "GT")
    assert after["bonuses"][0]["quantity"] == "1", after["bonuses"]
    print("summary suggestion check: OK")


if __name__ == "__main__":
    main()
