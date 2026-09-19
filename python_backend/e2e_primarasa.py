"""Tujuan: Bukti ujung-ke-ujung parser BARU `primarasa_letter.py` atas surat Collins asli
-> Summary -> gerbang `promo_rule` (simulasi). Caller: `python e2e_primarasa.py`. Bukan gerbang CI.
Dependensi: primarasa_letter (baru), shared._parse_master_barang_xlsx (READ-ONLY),
summary_rules.compile_programs, master `MASTER BARANG PRIMARASA.xlsx`.

PEMASANGAN YANG BELUM DILAKUKAN (satu baris, diserahkan ke pengguna karena `routers/summary.py`
sedang diubah pengguna): lihat catatan yang sama di kepala `e2e_dahlia_sept.py`.

APA YANG TIDAK DILAKUKANNYA: TIDAK menulis ke `promo_rule`, TIDAK memanggil endpoint publish.
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SEPT = REPO / "reference_surat_program" / "sept26"
MASTER = REPO / "master_barang_principle" / "MASTER BARANG PRIMARASA.xlsx"
SURAT = "re-Surat Program Diskon Spesial Collins 06 Mei 2026.pdf"

sys.path.insert(0, str(BASE))

import shared  # noqa: E402
from primarasa_letter import parse_pdf, match_items  # noqa: E402
from summary_rules import compile_programs  # noqa: E402


def main():
    jalur = SEPT / SURAT
    if not (MASTER.is_file() and jalur.is_file()):
        print(f"LEWAT: berkas tidak ada ({MASTER if not MASTER.is_file() else jalur})")
        return 0
    kel, vmap, gmap, items = shared._parse_master_barang_xlsx(MASTER.read_bytes())
    print(f"master PRIMARASA: {len(items)} barang, {len(kel)} kelompok\n")

    hasil = parse_pdf(jalur.read_bytes())
    head = hasil["letter"]
    print(f"{SURAT}")
    print(f"  surat={head['surat_program']!r} program={head['nama_program']!r}")
    print(f"  periode={head['periode_start'] or '(kosong)'}..{head['periode_end'] or '(kosong)'} "
          f"channel={head['channel_gtmt'] or '(kosong)'}")
    for w in hasil["warnings"]:
        print(f"  PERINGATAN: {w}")
    rows = match_items(hasil["rows"], items)
    for r in rows:
        print(f"\n  baris {r['no']}: {r['kelompok']} | {r['ketentuan']} | {r['benefit_type']} {r['benefit']}")
        print(f"    gramasi : {r['gramasi'] or '-'}")
        print(f"    kode    : {r['kode_barangs'] or '(DITAHAN)'}")
        print(f"    catatan : {r['keterangan']}")

    print("\n" + "=" * 90)
    print("GERBANG promo_rule -- compile_programs (simulasi, TIDAK menulis DB)")
    print("=" * 90)
    programs, issues = compile_programs(rows)
    for p in programs:
        print(f"  PROGRAM {p.get('surat_program')} {p.get('kelompok')} kode={len(p.get('codes') or [])}")
    print(f"  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")
    for t in issues:
        print(f"    - {t}")
    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Endpoint publish tidak disentuh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
