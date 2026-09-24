"""Tujuan: Mengunci C9 `tools/verify_form_summary.py` — surat program adalah acuannya.

Caller: `python test_verify_form_summary.py` (ikut `run_checks.py`). Dependensi: openpyxl (lewat
verifier). pdfplumber TIDAK dibutuhkan: yang diuji logika murni `coverage_findings`, bukan
pembacaan PDF.

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


if __name__ == "__main__":
    main()
