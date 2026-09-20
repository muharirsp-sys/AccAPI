"""Tujuan: Bukti ujung-ke-ujung DAHLIA LEWAT ENDPOINT-nya, bukan lewat parsernya saja.

Kenapa berkas ini ada, padahal `e2e_dahlia_sept.py` sudah memanggil `dahlia_letter.parse_pdf`:
pelajaran 19 September 2026 — `routers/summary.py` pernah hijau di seluruh uji sementara
endpointnya pasti `NameError` di produksi, karena SEMUA uji memanggil resolvernya langsung
dan tidak satu pun lewat endpoint HTTP-nya. Berkas ini memanggil
`summary_manual_parse_pdf_ai` dan `summary_manual_generate` — fungsi yang benar-benar
dipasang di rute — dengan `FakeRequest`, lalu membuat Form Summary + Dataset.

Caller: `python e2e_dahlia_endpoint.py` (manual). Bukan gerbang CI: butuh surat asli.
Dependensi: routers.summary (endpoint), shared._parse_master_barang_xlsx, summary_rules.
Side Effects: menulis draft ke SQLite TERPISAH (`data/e2e_dahlia.sqlite3`) dan berkas keluaran
di `data/e2e_dahlia_output/`. TIDAK menulis ke `promo_rule`, TIDAK memanggil endpoint publish,
TIDAK memanggil Mistral (surat DAHLIA berlapis teks; kalau sampai OCR dipanggil, itu justru
kegagalan yang dilaporkan berkas ini).
"""
import io
import json
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SURAT_DIR = REPO / "reference_surat_program" / "sept26"
MASTER = REPO / "master_barang_principle" / "MASTER BARANG DAHLIA.xlsx"
PRINCIPAL = "DAHLIA"
SURAT = [
    "542-11410 (C61) - PROMO TOKO ONLINE SEPTEMBER 2026 - SULAWESI 1.pdf",
    "570-11410 (C62) - PROMO NASIONAL GT GROSIR KHUSUS ITEM REJUVE SEPT 2026 - SULAWESI 1.pdf",
    "MT Pareto promo_letter_136_dist_882_1787377184 (1).pdf",
    "MT Silver promo_letter_139_dist_942_1787912657.pdf",
]

os.environ["SUMMARY_STORE_PATH"] = str(BASE / "data" / "e2e_dahlia.sqlite3")
# Sengaja TIDAK memuat MISTRAL_API_KEY: kalau jalur OCR sampai terpanggil, ia gagal dan
# terlihat, alih-alih diam-diam membayar OCR untuk surat yang lapisan teksnya utuh.
os.environ.pop("MISTRAL_API_KEY", None)
sys.path.insert(0, str(BASE))

import asyncio  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402
from routers import summary as backend, summary_library  # noqa: E402
import shared  # noqa: E402
from shared import MANUAL_MASTER_CACHE  # noqa: E402
from summary_rules import compile_programs  # noqa: E402
from summary_store import identity  # noqa: E402

PENGGUNA = "betterauth|admin|e2e@local"
TOKEN = "e2e-dahlia-tok"


class FakeRequest:
    headers = Headers({})
    cookies = {}


def main():
    kurang = [n for n in SURAT if not (SURAT_DIR / n).is_file()]
    if kurang or not MASTER.is_file():
        print("LEWAT: berkas tidak ada di mesin ini:")
        for n in kurang:
            print(f"  - {SURAT_DIR / n}")
        if not MASTER.is_file():
            print(f"  - {MASTER}")
        return 0

    backend.get_current_user = lambda request: PENGGUNA
    backend.user_has_permission = lambda *a, **k: True
    backend.validate_csrf_request = lambda request, token: True

    # Endpointnya tidak mengembalikan `model`, jadi siapa yang benar-benar membaca surat
    # tidak bisa dibaca dari responsnya. Dua penyadap ini menjawabnya tanpa menebak:
    # yang satu merekam parser deterministik mana yang dipakai, yang satu membuat
    # pemanggilan OCR mustahil lewat tanpa terlihat.
    jejak = {"deterministik": [], "ocr": 0}
    asli_det = backend.deterministic_extraction

    def det_tersadap(raw, master_):
        hasil = asli_det(raw, master_)
        jejak["deterministik"].append(hasil["model"] if hasil else None)
        return hasil

    async def ocr_tersadap(*a, **k):
        jejak["ocr"] += 1
        raise AssertionError("jalur OCR terpanggil untuk surat DAHLIA yang lapisan teksnya utuh")

    backend.deterministic_extraction = det_tersadap
    backend.extract_mistral = ocr_tersadap
    summary_library.get_current_user = lambda request: PENGGUNA
    summary_library.user_has_permission = lambda *a, **k: True
    summary_library.validate_csrf_request = lambda request, token: True

    kel, vmap, gmap, items = shared._parse_master_barang_xlsx(MASTER.read_bytes())
    MANUAL_MASTER_CACHE[TOKEN] = {"owner": identity(PENGGUNA), "kelompok": kel, "variant_map": vmap,
                                  "gramasi_map": gmap, "items": items, "customers": []}
    print(f"master {PRINCIPAL}: {len(items)} barang, {len(kel)} kelompok\n")

    from summary_store import connect
    with connect() as db:
        db.execute("DELETE FROM summary_draft")

    rows = []
    print("=" * 78)
    print("UNGGAH LEWAT ENDPOINT — summary_manual_parse_pdf_ai (fungsi yang dipasang di rute)")
    print("=" * 78)
    for nama in SURAT:
        jalur = SURAT_DIR / nama
        berkas = UploadFile(filename=jalur.name, file=io.BytesIO(jalur.read_bytes()))
        hasil = asyncio.run(backend.summary_manual_parse_pdf_ai(
            FakeRequest(), token=TOKEN, pdf=berkas, principle_name=PRINCIPAL))
        if not hasil.get("ok"):
            print(f"GAGAL PARSE {nama}: {hasil}")
            return 1
        model = jejak["deterministik"][-1] if jejak["deterministik"] else None
        baris = hasil.get("rows") or []
        tanda = "OK " if model == "deterministic:dahlia_letter" else "!! "
        print(f"{tanda}{nama[:52]:<54} dibaca={str(model):<32} baris={len(baris)}")
        if model != "deterministic:dahlia_letter":
            print("    ^ BUKAN parser DAHLIA. Penyambung deterministik tidak dipakai endpoint ini.")
            return 1
        for r in baris:
            r.setdefault("principle", PRINCIPAL)
        rows.extend(baris)

    assert jejak["ocr"] == 0, "jalur OCR terpanggil; parser deterministik tidak dipakai"
    print(f"\nTotal {len(rows)} baris dari {len(SURAT)} surat — OCR dipanggil {jejak['ocr']}x")
    berkode = [r for r in rows if str(r.get("kode_barangs", "")).strip()]
    print(f"  {len(berkode)} baris punya kode barang, {len(rows) - len(berkode)} ditahan\n")

    print("=" * 78)
    print("GERBANG promo_rule — compile_programs, gerbang yang sama dengan tombol Muat")
    print("=" * 78)
    programs, issues = compile_programs(rows)
    for p in programs[:20]:
        t = (p.get("tiers") or [{}])[0]
        print(f"  surat={str(p.get('surat_program','?')):<28} {str(p.get('kelompok',''))[:24]:<26} "
              f"kode={len(p.get('codes') or []):>3} ch={p.get('channel','') or '(kosong)':<4} "
              f"min={t.get('minimum','?')} benefit={t.get('discount_percent', t.get('bonus_quantity',''))}")
    if len(programs) > 20:
        print(f"  ... dan {len(programs) - 20} program lagi")
    if issues:
        print(f"\n  {len(issues)} baris DITAHAN (tidak ditebak):")
        for t in issues[:25]:
            print(f"    - {t}")
    print(f"\n  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")

    print("\n" + "=" * 78)
    print("FORM SUMMARY + DATASET — lewat jalur yang sama dengan tombol di layar")
    print("=" * 78)
    hasil_gen = backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(rows))
    if not hasil_gen.get("ok"):
        print("GAGAL membuat Form Summary:", hasil_gen)
        return 1
    from shared import MANUAL_OUTPUTS
    keluaran = MANUAL_OUTPUTS[hasil_gen["file_id"]]
    tujuan = BASE / "data" / "e2e_dahlia_output"
    tujuan.mkdir(parents=True, exist_ok=True)
    import shutil
    form = tujuan / "Form_Summary_DAHLIA_SEPT2026.pdf"
    dataset = tujuan / "Dataset_Summary_DAHLIA_SEPT2026.xlsx"
    # Keluaran lama DIHAPUS lebih dulu. Kalau run ini gagal di tengah, yang tertinggal harus
    # TIDAK ADA BERKAS, bukan berkas run sebelumnya — berkas usang tidak kelihatan usang, dan
    # 19 September 2026 satu berkas hasil run yang sengaja disabotase sempat terkirim ke
    # pengguna sebagai "hasil perbaikan". Tidak ada berkas jauh lebih jujur daripada itu.
    for lama in (form, dataset):
        lama.unlink(missing_ok=True)
    sidecar = tujuan / "Form_Summary_DAHLIA_SEPT2026.rows.json"
    for lama2 in (sidecar,): lama2.unlink(missing_ok=True)
    shutil.copy2(keluaran["rows"], sidecar)
    shutil.copy2(keluaran["form"], form)
    shutil.copy2(keluaran["dataset"], dataset)
    print(f"\nForm Summary : {form}")
    print(f"Dataset      : {dataset}")

    print("\n" + "=" * 78)
    print("LEBAR KOLOM — tiap kolom harus memuat KATA TERPANJANG yang masuk ke situ")
    print("=" * 78)
    if audit_lebar(rows) != 0:
        return 1

    print("\n" + "=" * 78)
    print("PAGINASI — tiap halaman badan harus membawa identitasnya sendiri")
    print("=" * 78)
    if audit_halaman(form) != 0:
        return 1

    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Endpoint publish tidak disentuh.")
    return 0


# Kolom yang lebih sempit daripada satu kata di dalamnya akan MEMATAHKAN kata itu di tengah:
# "TOKO ONLINE" tercetak "TOK O ON LINE". Itu tidak terlihat dari uji parser mana pun dan tidak
# menggagalkan apa pun -- ia hanya membuat Form yang ditandatangani OM jadi sulit dibaca. Jadi
# lebarnya diperiksa di sini, terhadap baris SUNGGUHAN, bukan diingat-ingat.
KOLOM_TEKS = [
    (1, "Surat Program", "surat_program"), (2, "Nama Program", "nama_program"),
    (3, "GT / MT", "channel_gtmt"), (5, "Periode", "periode"), (6, "Kelompok", "kelompok"),
    (7, "Variant", "variant"), (8, "Gramasi", "gramasi"), (9, "Ketentuan", "ketentuan"),
    (11, "Syarat Claim", "syarat_claim"), (13, "Keterangan", "keterangan"),
]


def audit_lebar(rows):
    import re
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import cm
    from reportlab.pdfbase.pdfmetrics import stringWidth

    from routers.summary import LEBAR_KOLOM

    assert abs(sum(LEBAR_KOLOM) - 1.0) < 1e-9, f"pecahan lebar kolom berjumlah {sum(LEBAR_KOLOM)}, wajib 1.0"
    usable = landscape(A4)[0] - (1 * cm)
    sempit = 0
    for indeks, nama, kunci in KOLOM_TEKS:
        tersedia = usable * LEBAR_KOLOM[indeks] - 6  # padding kiri + kanan
        terburuk, lebar_terburuk = "", 0.0
        for row in rows:
            for kata in re.split(r"[\s,]+", str(row.get(kunci, "") or "")):
                pt = stringWidth(kata, "Helvetica", 6)
                if pt > lebar_terburuk:
                    terburuk, lebar_terburuk = kata, pt
        muat = lebar_terburuk <= tersedia
        sempit += 0 if muat else 1
        print(f"  {'OK ' if muat else '!! '}{nama:<16} punya {tersedia:>5.0f}pt  "
              f"butuh {lebar_terburuk:>5.0f}pt  {terburuk[:30]}")
    if sempit:
        print(f"\n  {sempit} kolom lebih sempit daripada kata di dalamnya -- kata akan dipatahkan di tengah.")
    return sempit


def audit_halaman(form):
    """Halaman yang memuat baris program WAJIB menyebut nomor suratnya sendiri.

    Nilai identitas (Surat Program, Nama Program, Channel, Periode) digabung ke bawah lewat
    `SPAN`, dan ReportLab merender sel pertama sebuah span lalu menyembunyikan sisanya. Kalau
    span itu terpotong batas halaman, halaman berikutnya mencetak kolom-kolom itu KOSONG dan
    pembaca lembar yang ditandatangani OM tidak bisa tahu baris itu milik surat yang mana.
    Halaman terakhir boleh tanpa surat -- itu lembar tanda tangan.
    """
    import re

    import pypdf

    halaman = pypdf.PdfReader(str(form)).pages
    teks = [re.sub(r"\s+", " ", (h.extract_text() or "")).strip() for h in halaman]
    tanpa_identitas = []
    for nomor, isi in enumerate(teks, 1):
        ada_badan = "Kelompok" in isi and "Benefit" in isi and "(...." not in isi
        surat = sorted(set(re.findall(r"\d+/[A-Z]+\d*/\d+/\d+#\S*", isi)))
        if ada_badan and not surat:
            tanpa_identitas.append(nomor)
        print(f"  {'!! ' if ada_badan and not surat else 'OK '}HAL {nomor}: "
              f"{'badan' if ada_badan else 'tanda tangan'}  surat={surat or '-'}")
    if tanpa_identitas:
        print(f"\n  halaman {tanpa_identitas} memuat baris program tanpa nomor surat -- "
              "sel gabungan terpotong batas halaman.")
    return len(tanpa_identitas)


if __name__ == "__main__":
    raise SystemExit(main())
