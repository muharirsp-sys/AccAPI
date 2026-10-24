"""Tujuan: Mengunci C9 `tools/verify_form_summary.py` — surat program adalah acuannya — dan
C7/C8/C12 atas sel format ringkas (lihat `semantik`).

Caller: `python test_verify_form_summary.py` (ikut `run_checks.py`). Dependensi: openpyxl (lewat
verifier). pdfplumber TIDAK dibutuhkan: yang diuji logika murni `coverage_findings` dan
`check_semantics`, bukan pembacaan PDF.

Kasus yang dikunci, semuanya dari DAHLIA September 2026:
- `F601A` tidak boleh dinyatakan tercetak hanya karena `F601AH` tercetak (dulu substring);
- `BC002`/`LT122N` di surat = `BC-002`/`LT122-N` di master;
- kode toko lampiran dan potongan nomor proposal (`SUR030`) bukan kode barang;
- kode surat 083 yang hanya tercetak di baris surat LAIN tidak terwakili (dulu lolos);
- "surat menyebut: F601TK" di keterangan baris yang TIDAK ditahan tidak mewakili apa pun;
- `--strict-kelompok` mengubah perwakilan lewat kelompok dari PERINGATAN jadi FAIL.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import verify_form_summary as v  # noqa: E402


def master() -> v.Master:
    m = v.Master(has_short_codes=True)
    for code, group, gram in [
        ("F601AH", "DH AIR F", "225ML"), ("F601A", "DH AIR F", "225ML"), ("F601TK", "DH AIR F - HER", "225ML"),
        ("BC-002", "DH BLUE CLEAN - PEMBRSH CLOSET", "750ML"), ("LT122-N", "KIRIKO - LEM PERANGKAP", ""),
        ("F610CP", "DH AIR F - RD DIFSR", "50ML"),
    ]:
        m.codes.add(code)
        m.groups.add(group)
        m.code_to_kelompok[code] = group
        if gram:
            m.code_to_gramasi[code] = gram
            m.kelompok_to_gramasi.setdefault(group, set()).add(gram)
    return m


def row(program: str, codes: list[str], held: bool = False, ket: str = "", kelompok: str = "DH AIR F",
        gramasi: str = "225ML", ditahan: list[str] | None = None) -> dict:
    return {"surat_program": program, "kode_barangs": codes, "kode_ditahan": ditahan or [], "held": held,
            "keterangan": ket, "kelompok": kelompok, "gramasi": gramasi}


def main() -> None:
    m = master()

    # Token utuh, tanda hubung diabaikan.
    assert "F601A" not in v.tokens("KODE F601AH SAJA")
    assert v.code_key("LT122-N") == "LT122N" and "LT122N" in v.tokens("LT122-N")
    assert v.family("F601LB") == "F601" and v.family("K24SGRA") == "K24"

    # Kode surat: yang di master, atau keluarganya di master. Kode toko & nomor proposal tidak.
    surat = "No. Proposal : 083/TMDH2/08/26#SUR030 F601AH F601LB BC002 LT122N F610 ALL T022175 JK00026377"
    assert v.letter_codes(surat, m) == {"F601AH", "F601LB", "BC002", "LT122N", "F610"}, v.letter_codes(surat, m)

    # PER SURAT: kode yang tercetak hanya di baris surat LAIN tidak mewakili surat ini.
    rows = [row("083/TMDH2/08/26#", ["F601AH"]), row("570/TMDH1/8/26#", ["F601TK"], kelompok="DH AIR F - HER")]
    fails, _, total, covered = v.coverage_findings("083", "083/TMDH2/08/26# F601AH F601TK", m, rows, "", False)
    assert (total, covered) == (2, 1), (total, covered)
    assert any("'F601TK'" in f for f in fails), fails

    # Substring: F601AH di baris TIDAK mewakili F601A.
    fails, _, _, covered = v.coverage_findings("083", "083/TMDH2/08/26# F601A", m,
                                               [row("083/TMDH2/08/26#", ["F601AH"], kelompok="DH AIR F - HER")], "", False)
    assert covered == 0 and fails, fails

    # Keterangan baris BIASA yang menyebut kodenya tidak mewakili; keterangan baris TERTAHAN mewakili.
    biasa = [row("083/TMDH2/08/26#", ["F601AH"], ket="surat menyebut: F601TK")]
    assert v.coverage_findings("083", "083/TMDH2/08/26# F601TK", m, biasa, "", False)[0]
    tahan = [row("083/TMDH2/08/26#", [], held=True, ket="DITAHAN: surat menyebut: F601LB", kelompok="")]
    assert not v.coverage_findings("083", "083/TMDH2/08/26# F601LB", m, tahan, "", False)[0]

    # Kode keluarga ("F610 ALL") terwakili bila ada kode keluarga itu di baris surat itu.
    difsr = [row("542/TMDH1/8/26#", ["F610CP"], kelompok="DH AIR F - RD DIFSR", gramasi="50ML")]
    assert not v.coverage_findings("542", "542/TMDH1/8/26# F610 ALL", m, difsr, "", False)[0]

    # Hanya lewat kelompok+gramasi: PERINGATAN biasanya, FAIL dengan --strict-kelompok.
    lewat = [row("542/TMDH1/8/26#", ["F601AH"])]
    fails, notes, _, covered = v.coverage_findings("542", "542/TMDH1/8/26# F601A", m, lewat, "", False)
    assert not fails and covered == 1 and any(n.startswith("PERINGATAN") for n in notes), (fails, notes)
    fails, _, _, covered = v.coverage_findings("542", "542/TMDH1/8/26# F601A", m, lewat, "", True)
    assert covered == 0 and any("--strict-kelompok" in f for f in fails), fails

    # Nomor surat yang tidak ada di baris Form mana pun: seluruh kodenya tidak terwakili.
    fails, _, total, covered = v.coverage_findings("234", "234/TMDH1/08/26# F601AH", m, rows, "", False)
    assert (total, covered) == (1, 0) and "tidak ada di baris Form" in fails[0], fails

    print("OK test_verify_form_summary: 10 kasus C9")
    semantik()


def master_ringkas() -> v.Master:
    """Master gaya rebuild_master: kode di kolom 'Kode Barang', 'Nama Barang' diawali merek."""
    m = v.Master()
    for code, group, gram in [
        ("GT330", "NU - GTEA", "330ML"), ("GT450", "NU - GTEA", "450ML"), ("GT310", "NU - GTEA", "310ML"),
        ("MT330", "NU - MTEA", "330ML"), ("ZZ200", "NU - ZUZU", "200ML"),
        ("TE330", "NU - TEA", "330ML"), ("TE450", "NU - TEA", "450ML"), ("KD200", "KIN - DAIRY", "200ML"),
        ("ND65", "NDB", "65GR"), ("ND70", "NDB", "70GR"), ("GU60", "NDB - GURIMI", "60GR"),
        ("BB38", "B&B - POWDER", "3,8GR"), ("BB100", "B&B - POWDER", "100GR"), ("BL200", "B&B - LIQUID SOAP", "200ML"),
        ("HR1", "DH AEROSOL - MTC - HER", "200ML"), ("AE1", "DH AEROSOL - MTC - AER", "300ML"),
        ("PT35", "PIATTOS", "35GR"), ("PB68", "PIATTOS - BIG & CRISPY", "68GR"),
    ]:
        m.groups.add(group)
        m.kelompok.add(group.split(" - ")[0])
        m.code_to_kelompok[code] = group
        m.code_to_gramasi[code] = gram
        m.kelompok_to_gramasi.setdefault(group, set()).add(gram)
    return m


def semantik() -> None:
    """C7/C8/C12 atas sel format ringkas (owner 14 Okt 2026: satu baris = surat x channel x merek x
    ketentuan x benefit, jadi satu sel memuat beberapa kelompok master SATU merek), dicetak persis
    seperti `format_kelompoks_human_readable` dan gramasi per kelompok (',' di dalam, ', '/' & ' antar)."""
    m = master_ringkas()

    def cek(kelompok: str, gramasi: str, codes: list[str]) -> dict[str, str]:
        hasil = v.check_semantics([{"no": "1", "kelompok": kelompok, "gramasi": gramasi, "kode_barangs": codes}], m)
        return {c.id[:3].rstrip("_"): c.status for c in hasil}

    lulus = {"C7": "PASS", "C8": "PASS", "C12": "PASS"}
    nu = ["GT330", "GT450", "GT310", "MT330", "ZZ200", "TE330", "TE450"]
    assert cek("NU - GTEA, MTEA, ZUZU & TEA", "330ML,450ML,310ML, 330ML, 200ML & 330ML,450ML", nu) == lulus
    # Kelompok datar di samping komposit merek yang sama, dan kelompok datar sesudah induk lain.
    assert cek("NDB & NDB - GURIMI", "65GR,70GR & 60GR", ["ND65", "ND70", "GU60"]) == lulus
    assert cek("NU - TEA & NDB", "330ML,450ML & 65GR", ["TE330", "TE450", "ND65"]) == lulus
    # '&' di dalam nama master dan koma desimal di gramasi bukan pemisah.
    assert cek("B&B - POWDER & LIQUID SOAP", "3,8GR,100GR & 200ML", ["BB38", "BB100", "BL200"]) == lulus
    # Nama master yang sendiri memuat ' & ' (URC) tidak dipecah.
    assert cek("PIATTOS, PIATTOS - BIG & CRISPY", "35GR & 68GR", ["PT35", "PB68"]) == lulus
    # Bentuk lama tiga tingkat tetap.
    assert cek("DH AEROSOL - MTC - HER & AER", "200ML & 300ML", ["HR1", "AE1"]) == lulus

    # Label pemilik (sidecar "label") dan penanda seluruh katalog generator bukan nama kelompok master: dilewati.
    hasil = v.check_semantics([{"no": "1", "kelompok": "ALL KELOMPOK BARANG POWDER BOX, KECUALI SACHET",
                                "gramasi": "ALL GRAMASI, KECUALI SACHET", "kode_barangs": ["GT330"], "label": True}], m)
    assert {c.id[:3].rstrip("_"): c.status for c in hasil} == lulus, [(c.id, c.status) for c in hasil]
    assert cek("ALL KELOMPOK BARANG", "ALL GRAMASI", ["GT330", "ND65"]) == lulus

    # Kegagalan nyata tetap tertangkap.
    assert cek("NU - GTEA, MTEA & KOPI", "330ML, 330ML & 200ML", ["GT330", "MT330"])["C7"] == "FAIL"
    assert cek("NU - GTEA & TEA", "330ML & 330ML", ["GT330", "KD200"])["C12"] == "FAIL"
    assert cek("NU - GTEA & TEA", "330ML & 330ML", ["GT330", "ND65X"])["C12"] == "FAIL"
    assert cek("NDB & NDB - GURIMI", "60GR & 65GR,70GR", ["ND65", "GU60"])["C8"] == "FAIL"   # tertukar
    assert cek("NDB & NDB - GURIMI", "65GR,70GR,60GR", ["ND65", "GU60"])["C8"] == "FAIL"     # satu entri
    assert cek("NU - ZUZU", "330ML", ["ZZ200"])["C8"] == "FAIL"

    # load_master membaca kolom 'Kode Barang' bila 'Nama Barang' diawali merek (ABCPI/PRISKILA).
    import tempfile
    from openpyxl import Workbook
    wb = Workbook()
    wb.active.append(["Nama Barang Principle", "Kode Barang", "Nama Barang", "Nama KLP", "Nama Sub KLP",
                      "Nama Sub KLP2", "Nama Gramasi atau Jumlah Pack per CTN"])
    wb.active.append([None, "26010010065010", "NDB AYAM BAWANG 40BAG X 65GR", "NDB", None, None, "65GR"])
    wb.active.append([None, "26011010060010", "NDB GURIMI 40BAG X 60GR", "NDB", "GURIMI", None, "60GR"])
    with tempfile.TemporaryDirectory() as d:
        wb.save(Path(d) / "m.xlsx")
        lm = v.load_master([Path(d) / "m.xlsx"])
    assert lm.code_to_kelompok == {"26010010065010": "NDB", "26011010060010": "NDB - GURIMI"}, lm.code_to_kelompok
    assert not lm.has_short_codes and not lm.codes, "kode internal tidak boleh ikut kosakata kode surat (C9)"

    print("OK test_verify_form_summary: 13 kasus C7/C8/C12 format ringkas")


if __name__ == "__main__":
    main()
