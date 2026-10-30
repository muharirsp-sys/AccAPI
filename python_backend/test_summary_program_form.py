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
assert "Operational Manager" in hal[-1] and "Operational Manager" not in hal[1]           # tanda tangan ikut blok terakhir
print("summary_program_form ok")
