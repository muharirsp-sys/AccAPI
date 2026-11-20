"""Self-check Form Summary Program (ReportLab): judul + kepala kolom + 'Hal. x dari y' di tiap halaman, warna beban, isi sel.
Pakai: python test_summary_program_form.py (ikut run_checks.py)."""
from datetime import date

import fitz

import summary_program_form as f


def rule(rid, sid, kid, teks, beban="principal", kode=("A1",)):
    return {"rule_id": rid, "program_id": sid.split("-")[0], "section_id": sid, "kolom_id": kid,
            "barang": {"nama_di_surat": "Anlene Sachet", "kode_barang": list(kode), "kelompok_barang": "ANLENE - SACHET", "variant": "Coklat",
                       "gramasi": "25gr"},
            "benefit": {"teks_tampilan": teks, "komponen": [{"beban": beban}]}}


def doc(n_program=1, beban="principal"):
    programs, rules = [], []
    for i in range(1, n_program + 1):
        programs.append({"program_id": f"P{i}", "no_surat": f"00{i}/UJI", "nama_program": f"Promo {i}", "channel": "GT",
                         "outlet": {"tipe": "tanpa_list", "kode_outlet": []}, "periode": {"mulai": "2026-10-01", "selesai": "2026-10-31"},
                         "syarat_claim": {"batas_klaim_tanggal": "2026-12-15", "batas_klaim_aturan": None, "ada_klaim": True,
                                          "dokumen": ["copy faktur"], "dasar_nilai": ["DBP"]},
                         "keterangan": ["Kelipatan"],
                         "sections": [{"section_id": f"P{i}-S1", "label": "Strata", "outlet_khusus": None, "catatan": [],
                                       "kolom": [{"kolom_id": f"P{i}-S1-K1", "label": "2 - 9 CTN"}, {"kolom_id": f"P{i}-S1-K2", "label": ">= 10 CTN"}]}]})
        rules += [rule(f"R{i}a", f"P{i}-S1", f"P{i}-S1-K1", "2.5%", beban, (f"A{i}",)), rule(f"R{i}b", f"P{i}-S1", f"P{i}-S1-K2", "5.0%", beban, (f"A{i}",))]
    return {"principal": "UJI", "periode_summary": {"mulai": "2026-10-01", "selesai": "2026-10-31"}, "programs": programs, "item_rules": rules,
            "flags": [{"jenis": "anomali_angka", "tingkat": "perlu_cek", "program_id": "P1", "rule_id": "R1a", "pesan": "cek angka"}]}


assert [f.jenis_beban(d)[1] for d in (doc(), doc(beban="distributor"))] == ["COKLAT", "MERAH"]
assert f.rapikan("2.5% -> 25.0% >= 3") == "2,5% → 25% ≥ 3"
pdf = f.form_pdf([(doc(1), {}), (doc(40, "distributor"), {})], date(2026, 10, 28))
with fitz.open(stream=pdf, filetype="pdf") as d:
    hal = [" ".join(p.get_text().split()) for p in d]  # sel sempit membungkus baris
assert len(hal) >= 3, len(hal)  # 1 halaman principal pertama + >= 2 halaman principal kedua (40 program)
for i, t in enumerate(hal):
    assert "SUMMARY PROGRAM ON FAKTUR" in t and "Update keterangan" in t, f"hal {i + 1}: judul/kepala kolom hilang"
assert "Hal. 1 dari 1" in hal[0] and "BEBAN PRINCIPLE (COKLAT)" in hal[0]
n2 = len(hal) - 1
assert all(f"Hal. {i} dari {n2}" in hal[i] and "BEBAN DISTRIBUTOR (MERAH)" in hal[i] for i in range(1, len(hal))), "nomor halaman per principal"
assert "2,5%" in hal[0] and "≥ 10 CTN" in hal[0] and "→" in hal[0], hal[0][:400]       # angka seragam, panah & ≥ tampil
assert "PERLU CEK: cek angka" in hal[0] and "(!)" in hal[0]                               # flag -> keterangan + sel bertanda
assert "Direktur" in hal[-1] and "Direktur" not in hal[1]                                 # tanda tangan ikut blok terakhir
assert "Operational Manager" in hal[0] and "Operational Manager" not in hal[-1]          # beban distributor -> Direktur (2 Nov 2026)

# Pemilik 10 Nov 2026: principal + dana marketing / SDS / Selmar (tanpa beban distributor) -> HIJAU, disetujui Operational Manager.
hijau = doc()
hijau["item_rules"][0]["benefit"]["komponen"].append({"beban": "dana_marketing"})
assert f.jenis_beban(hijau) == ("BEBAN PRINCIPLE & DANA MARKETING / SDS / SELMAR", "HIJAU")
campur = doc(beban="distributor")
campur["item_rules"][0]["benefit"]["komponen"].append({"beban": "dana_marketing"})
assert f.jenis_beban(campur)[1] == "PINK"                                                # ada beban distributor tetap PINK
with fitz.open(stream=f.form_pdf([(hijau, {})], date(2026, 11, 10)), filetype="pdf") as d:
    t = " ".join(d[0].get_text().split())
assert "BEBAN PRINCIPLE & DANA MARKETING / SDS / SELMAR (HIJAU)" in t and "(ON PRINCIPLE HIJAU)" in t, t[:300]
assert "Operational Manager" in t and "Direktur" not in t


def test_daftar_panjang_tidak_jadi_all_variant():
    """Pengguna 20 Nov 2026, Gondowangi PROID-TP/ONLINE/26110002 Existing Outlet: 9 SKU Natur 24+1 tercetak
    'Cond, Hair Tonic, H.recovery, H.vit, SHMP - all variant | All gramasi' (daftar gabungan > 180 huruf). Form hanya boleh
    menulis all variant / all gramasi bila data rule memang begitu; daftar panjang dipecah per sub-kelompok, tidak diringkas."""
    natur = [("19013010165000", "COND", "ALOE VERA", "165ML"), (None, "COND", "ARGAN OIL & OLIVE OIL", "160ML"),
             ("19012020090000", "HAIR TONIC", "GINSENG", "90ML"), ("19016010060000", "H.RECOVERY", "A.VERA OIL", "60ML"),
             ("19014020080000N", "H.VIT", "ARGAN OIL&OLIVE OIL", "80ML"), ("19011040140000", "SHMP", "ARGAN OLIVE OIL", "140ML"),
             ("19011030140000", "SHMP", "ANTI DANDRUFF", "140ML"), ("19011050140000", "SHMP", "MORINGA", "140ML"),
             ("19011020270000", "SHMP", "GINSENG EXT", "270ML")]
    vinda = [(f"V{i:02d}", None, f"TISU WAJAH VARIAN PANJANG NOMOR {i}", f"{i}0SHEET") for i in range(1, 21)]  # tanpa sub-kelompok
    d = doc()
    d["flags"] = []
    s = d["programs"][0]["sections"][0]
    s["kolom"] = s["kolom"][:1]
    d["item_rules"] = []
    for i, (kode, sub, var, gram) in enumerate(natur + vinda + [("N99", None, "ALL VARIANT", "All gramasi")]):
        r = rule(f"N{i}", "P1-S1", "P1-S1-K1", "12+1" if kode == "N99" else "24+1", kode=(kode,) if kode else ())
        nama = "VINDA" if (kode or "").startswith("V") else "NATUR"
        r["barang"].update(kelompok_barang=f"{nama} - {sub}" if sub else nama, variant=var, gramasi=gram, nama_di_surat=f"{nama} {var}")
        d["item_rules"].append(r)
    rows = f.baris_seksi(f.susun(d)[0][1][0], {})
    teks = [(row["variant"], row["gramasi"]) for row in rows]
    klaim = [(v, g) for v, g in teks if "all variant" in v.lower() or "all gramasi" in g.lower()]
    assert klaim == [("All variant", "All gramasi")], teks                                       # hanya rule yang datanya 'all'
    semua = " | ".join(v + " | " + g for v, g in teks)
    for _, _, var, gram in natur + vinda:
        assert f.judul_kata(var) in semua and gram in semua, (var, teks)                         # tiap SKU tertulis
    assert all(len(v) <= 180 and len(g) <= 180 for v, g in teks), teks                          # satu baris tetap pendek
    assert [row["kelompok"] for row in rows][:5] == ["NATUR"] * 5, teks                         # Natur: 5 sub-kelompok -> 5 baris
    assert sum(row["kelompok"] == "VINDA" for row in rows) > 1, teks                             # tanpa sub: dipotong, tak diringkas
    with fitz.open(stream=f.form_pdf([(d, {})], date(2026, 11, 20)), filetype="pdf") as pdf:
        t = " ".join(" ".join(p.get_text().split()) for p in pdf)
    assert t.count("All variant") == t.count("All gramasi") == 1 and "Anti Dandruff" in t and "270ML" in t, t[:600]


if __name__ == "__main__":
    test_daftar_panjang_tidak_jadi_all_variant()
    print("summary_program_form ok")
