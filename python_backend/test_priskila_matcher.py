import json

import pytest

import priskila_matcher as pm


@pytest.fixture(scope="module")
def master():
    d = json.load(open("data/manual_cache/master_cache.json", encoding="utf-8"))

    def fi(o):
        if isinstance(o, dict):
            if isinstance(o.get("items"), list):
                return o["items"]
            for v in o.values():
                r = fi(v)
                if r:
                    return r
        return None

    return fi(d) or []


def _codes(items):
    return {it["kode_barang"] for it in items}


def _norm(x):
    return " ".join(str(x or "").split()).upper()


def test_load_rules():
    r = pm.load_rules()
    assert r["brand_aliases"]["BELLAGIO"] == "BLAGIO"
    assert "SPORT" in r["variant_qualifiers"]


def test_extract_gramasi():
    assert pm.extract_gramasi("Casablanca Pomade 50gr") == "50GR"
    assert pm.extract_gramasi("Bellagio Eau de Toilette 100ml") == "100ML"


def test_candidate_pomade_is_hm(master):
    assert pm.candidate_kelompoks(
        "CASABLANCA", "Casablanca Pomade 50gr", master, pm.load_rules()
    ) == {"CSBNCA HM - PMD OIL BASED"}


def test_edp_prestige_split(master):
    r = pm.load_rules()
    assert pm.candidate_kelompoks(
        "BELLAGIO", "Bellagio Eau De Parfume Prestige 50ml", master, r
    ) == {"BLAGIO HM - EDP - PRESTIGE"}
    assert pm.candidate_kelompoks(
        "BELLAGIO", "Bellagio Eau de Parfume 50ml", master, r
    ) == {"BLAGIO HM - EDP"}


def test_all_variant_blagio_edt(master):
    res = pm.resolve_surat_line(
        "BELLAGIO", "Bellagio Eau de Toilette 100ml", master, pm.load_rules()
    )
    assert _codes(res["sku_list"]) == {
        "P2014001010010",
        "P2014002010010",
        "P2014003010010",
        "P2014004010010",
        "P2014005010010",
        "P2014006010010",
    }


def test_regazza_sport_partition(master):
    r = pm.load_rules()
    sport = pm.resolve_surat_line(
        "REGAZZA", "Regazza Eau de Toilette Sport 100ml", master, r
    )
    assert {it["variant"] for it in sport["sku_list"]} == {
        "AZZURO",
        "BIANCO",
        "NERO",
        "ROSSO",
    }
    reg = pm.resolve_surat_line("REGAZZA", "Regazza Eau de Toilette 100ml", master, r)
    assert "AZZURO" not in {it["variant"] for it in reg["sku_list"]}
    assert len(reg["sku_list"]) == 6


def test_banded_excluded(master):
    res = pm.resolve_surat_line(
        "CASABLANCA", "Casablanca Pomade 50gr", master, pm.load_rules()
    )
    assert all("BND" not in _norm(it["nama_barang"]).split() for it in res["sku_list"])
    assert len(res["sku_list"]) == 8


def test_spray_cologne_series(master):
    res = pm.resolve_surat_line(
        "CASABLANCA", "Casablanca Spray Cologne Series 100ml", master, pm.load_rules()
    )
    kels = {_norm(it["kelompok"]) for it in res["sku_list"]}
    assert kels == {
        "CSBNCA FM - SPRAY COL - WHITE SR",
        "CSBNCA HM - SPRAY COLG - BLACK SR",
    }
    assert len(res["sku_list"]) > 0


def test_no_sanitizer_leak(master):
    r = pm.load_rules()
    for line in [
        "Camellia Body Mist 100ml",
        "Camellia Body Mist Japanese 100ml",
        "Camellia Body Spray 100ml",
    ]:
        res = pm.resolve_surat_line("CAMELLIA", line, master, r)
        assert all(
            "SANITIZER" not in _norm(it["kelompok"]) for it in res["sku_list"]
        ), line


def test_unmatched_flagged(master):
    res = pm.resolve_surat_line(
        "CASABLANCA", "Casablanca Nonexistent Widget 999ml", master, pm.load_rules()
    )
    assert res["sku_list"] == [] and res["unmatched"]


def test_marie_jose_body_mist(master):
    assert len(pm.resolve_surat_line("MARIE JOSE", "Marie Jose Body Mist 100ml", master, pm.load_rules())["sku_list"]) == 8


def test_camellia_body_mist_regular(master):
    r = pm.load_rules()
    res = pm.resolve_surat_line("CAMELLIA", "Camellia Body Mist 100ml", master, r)
    assert {_norm(it["kelompok"]) for it in res["sku_list"]} == {"CAMELLIA - B. MIST"}
    assert len(res["sku_list"]) == 8


def test_camellia_body_mist_japanese(master):
    res = pm.resolve_surat_line("CAMELLIA", "Camellia Body Mist Japanese 100ml", master, pm.load_rules())
    assert {_norm(it["kelompok"]) for it in res["sku_list"]} == {"CAMELLIA - BODY MIST J SARIES"}
    assert len(res["sku_list"]) == 3


def test_regazza_fragrance_mist(master):
    assert len(pm.resolve_surat_line("REGAZZA", "Regazza Fragrance Mist 155ml", master, pm.load_rules())["sku_list"]) == 3


def test_brand_from_text_ignores_wrong_arg(master):
    # wrong brand arg, correct text -> must still resolve via text
    res = pm.resolve_surat_line("BELLAGIO", "Camellia Eau De Parfume 22ml", master, pm.load_rules())
    assert len(res["sku_list"]) == 6


def test_casablanca_body_spray_200_both(master):
    res = pm.resolve_surat_line("CASABLANCA", "Casablanca Body Spray 200ml", master, pm.load_rules())
    assert len(res["sku_list"]) == 12   # FM + HM both


def test_casablanca_rollon_deo(master):
    res = pm.resolve_surat_line("CASABLANCA", "Casablanca Roll On 50ml", master, pm.load_rules())
    assert len(res["sku_list"]) == 9    # FM(5)+HM(4) DEO ANTI P ROL/ROLL ON


def test_casablanca_deo_body_spray(master):
    res = pm.resolve_surat_line("CASABLANCA", "Casablanca Deo Body Spray 150ml", master, pm.load_rules())
    kels = {_norm(it["kelompok"]) for it in res["sku_list"]}
    assert kels == {"CSBNCA FM - P DEO B.SPRAY", "CSBNCA HM - P DEO B.SPRAY"}
    assert len(res["sku_list"]) == 6


# --- Regression: gaps surfaced by April/Juni surat generalization test (2026-07-15) ---

def test_ocr_typo_toilete_resolves(master):
    """OCR sometimes reads 'Toilette' as 'Toilete' (one t). Must still map to EDT."""
    r = pm.load_rules()
    assert len(pm.resolve_surat_line("", "Bellagio Eau de Toilete 100ml", master, r)["sku_list"]) == 6
    assert len(pm.resolve_surat_line("", "Regazza Eau de Toilete 100ml", master, r)["sku_list"]) == 6


def test_bellagio_sport_edt_separate_kelompok(master):
    """Bellagio Sport EDT lives in its OWN kelompok 'BLAGIO HM - SPORT EDT'
    (unlike Regazza where sport partitions inside 'REGAZZA FM - EDT')."""
    r = pm.load_rules()
    res = pm.resolve_surat_line("", "Bellagio Eau de Toilette Sport 100ml", master, r)
    assert {_norm(it["kelompok"]) for it in res["sku_list"]} == {"BLAGIO HM - SPORT EDT"}
    assert len(res["sku_list"]) >= 1
    # plain Bellagio EDT must still resolve to the non-sport kelompok
    plain = pm.resolve_surat_line("", "Bellagio Eau de Toilette 100ml", master, r)
    assert {_norm(it["kelompok"]) for it in plain["sku_list"]} == {"BLAGIO HM - EDT"}


def test_regazza_sport_still_partitions(master):
    """Regression guard: the two-phase candidate change must NOT break Regazza's
    within-kelompok Sport partition."""
    r = pm.load_rules()
    sport = pm.resolve_surat_line("", "Regazza Eau de Toilette Sport 100ml", master, r)
    assert {it["variant"] for it in sport["sku_list"]} == {"AZZURO", "BIANCO", "NERO", "ROSSO"}
    reg = pm.resolve_surat_line("", "Regazza Eau de Toilette 100ml", master, r)
    assert len(reg["sku_list"]) == 6 and "AZZURO" not in {it["variant"] for it in reg["sku_list"]}
