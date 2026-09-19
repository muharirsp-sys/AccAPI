"""Tujuan: Bukti ujung-ke-ujung parser BARU `dahlia_letter.py` atas 4 surat DAHLIA
(PT Unitama Sari Mas) asli September 2026 -> Summary -> gerbang `promo_rule` (simulasi).
Caller: `python e2e_dahlia_sept.py` (manual). Bukan gerbang CI.
Dependensi: dahlia_letter (baru), shared._parse_master_barang_xlsx (READ-ONLY),
summary_rules.compile_programs, master `MASTER BARANG DAHLIA.xlsx`.

PEMASANGAN YANG BELUM DILAKUKAN (satu baris, sengaja diserahkan ke pengguna karena
`routers/summary.py` sedang diubah pengguna di worktree utama):
    di `python_backend/routers/summary.py`, fungsi `summary_manual_parse_pdf_ai`, baris
        result = kino_extraction(raw, master) or await extract_mistral(...)
    menjadi
        result = kino_extraction(raw, master) or dahlia_extraction(raw, master) or await extract_mistral(...)
    dengan `dahlia_extraction` dibentuk meniru `kino_extraction` (try/except -> None supaya
    jalur OCR tetap jalan), memanggil `dahlia_letter.parse_pdf` lalu `dahlia_letter.match_items`.

APA YANG TIDAK DILAKUKANNYA: TIDAK menulis ke `promo_rule`, TIDAK memanggil endpoint publish.
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SEPT = REPO / "reference_surat_program" / "sept26"
MASTER = REPO / "master_barang_principle" / "MASTER BARANG DAHLIA.xlsx"
SURAT = [
    "542-11410 (C61) - PROMO TOKO ONLINE SEPTEMBER 2026 - SULAWESI 1.pdf",
    "570-11410 (C62) - PROMO NASIONAL GT GROSIR KHUSUS ITEM REJUVE SEPT 2026 - SULAWESI 1.pdf",
    "MT Pareto promo_letter_136_dist_882_1787377184 (1).pdf",
    "MT Silver promo_letter_139_dist_942_1787912657.pdf",
]

sys.path.insert(0, str(BASE))

import shared  # noqa: E402
from dahlia_letter import parse_pdf, match_items  # noqa: E402
from summary_rules import compile_programs  # noqa: E402


def main():
    if not MASTER.is_file():
        print(f"LEWAT: master tidak ada: {MASTER}")
        return 0
    kel, vmap, gmap, items = shared._parse_master_barang_xlsx(MASTER.read_bytes())
    print(f"master DAHLIA: {len(items)} barang, {len(kel)} kelompok\n")

    semua = []
    for nama in SURAT:
        jalur = SEPT / nama
        if not jalur.is_file():
            print(f"LEWAT (tidak ada): {jalur}\n")
            continue
        try:
            hasil = parse_pdf(jalur.read_bytes())
        except Exception as e:
            print(f"GAGAL PARSE {nama[:60]}: {e!r}\n")
            continue
        head = hasil["letter"]
        print("=" * 100)
        print(f"{nama[:80]}")
        print(f"  bentuk={hasil['format']}  surat={head['surat_program']!r}  "
              f"periode={head['periode_start']}..{head['periode_end']}  channel={head['channel_gtmt']!r}")
        print(f"  mekanisme tercetak (audit, BUKAN penyaring): {hasil.get('mechanism_printed') or '(tidak tercetak)'}")
        rows = match_items(hasil["rows"], items)
        for w in hasil["warnings"]:
            print(f"  PERINGATAN: {w}")
        for r in rows:
            tanda = "OK   " if (r.get("kode_barangs") and r.get("benefit_type")) else "TAHAN"
            print(f"    {tanda} baris {r['no']:>2} {str(r['kelompok'])[:34]:<36} "
                  f"{str(r.get('ketentuan',''))[:26]:<28} {r.get('benefit_type',''):<9} {r.get('benefit','')!r:<10} "
                  f"kode={(r.get('kode_barangs') or '-')[:46]}")
        semua.extend(rows)
        print()

    if not semua:
        print("Tidak ada baris sama sekali.")
        return 1

    for i, r in enumerate(semua, start=1):
        r.setdefault("id", f"dahlia-{i}")
        r["no"] = str(i)

    print("=" * 100)
    print("GERBANG promo_rule -- compile_programs (simulasi, TIDAK menulis DB)")
    print("=" * 100)
    programs, issues = compile_programs(semua)
    for p in programs:
        t = (p.get("tiers") or [{}])[0]
        benefit = []
        if t.get("percentages"):
            benefit.append("disc " + "+".join(t["percentages"]) + "%")
        if t.get("rupiah") not in ("0", 0, None):
            benefit.append(f"Rp {t['rupiah']}/{t.get('rupiah_mode')}")
        if t.get("bonus_quantity") not in ("0", 0, None):
            benefit.append(f"bonus {t['bonus_quantity']} {t.get('bonus_unit')}")
        print(f"  PROGRAM {str(p.get('surat_program','?')):<22} {str(p.get('kelompok',''))[:30]:<32} "
              f"kode={len(p.get('codes') or []):>2} {p.get('start')}..{p.get('end')} ch={p.get('channel','')[:12]:<12} "
              f"min={t.get('minimum')}{p.get('unit')} {', '.join(benefit)}")
    print(f"\n  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")
    for t in issues[:25]:
        print(f"    - {str(t)[:150]}")
    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Endpoint publish tidak disentuh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
