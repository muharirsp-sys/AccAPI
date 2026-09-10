"""Tujuan: Muat daftar outlet per kelas principal (hit list Kino) ke tabel outlet_class.
Caller: operator, manual: `python import_outlet_class.py LOYALTY <daftar.xlsx> --mapping <KINO.xlsx>`.
Dependensi: openpyxl, outlet_class. Main Functions: kino_codes, internal_codes, main.
Side Effects: Menulis outlet_class HANYA bila diberi --apply; tanpa itu cuma melaporkan.

Berkas hit list Kino adalah laporan ad hoc: judul kolomnya berubah-ubah dan kode outlet bisa
ada di kolom mana saja. Karena itu kolomnya TIDAK ditebak dari judul, melainkan dipilih dari
kolom yang isinya paling banyak cocok dengan tabel Mapping_Customer.
"""
import argparse
import sys

import outlet_class


def sheet_rows(path, sheet=None):
    import openpyxl

    book = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = book[sheet] if sheet else book[book.sheetnames[0]]
    return [tuple("" if cell is None else str(cell).strip() for cell in row) for row in ws.iter_rows(values_only=True)]


def mapping_of(path):
    """Mapping_Customer: Code Kino -> Code Internal."""
    rows = sheet_rows(path, "Mapping_Customer")
    return {row[0]: row[1] for row in rows[1:] if len(row) >= 2 and row[0] and row[1]}


def kino_codes(rows, mapping):
    """Kolom kode outlet = kolom dengan kecocokan terbanyak ke Mapping_Customer."""
    width = max((len(row) for row in rows), default=0)
    best, best_hits = -1, 0
    for column in range(width):
        hits = sum(1 for row in rows if column < len(row) and row[column] in mapping)
        if hits > best_hits:
            best, best_hits = column, hits
    if best_hits == 0:
        raise ValueError("Tidak ada satu pun kode outlet pada berkas ini yang ada di Mapping_Customer")
    values = [row[best] for row in rows if best < len(row) and row[best]]
    # Baris judul dibuang HANYA bila memang bukan kode; baris data yang tak terpetakan
    # tetap harus muncul sebagai temuan, bukan hilang diam-diam.
    if values and values[0] not in mapping and rows and rows[0][best] == values[0]:
        values = values[1:]
    return best, values


def internal_codes(codes, mapping):
    """Kode Kino -> kode internal. Yang tidak ada di mapping dilaporkan, bukan ditebak."""
    found, missing = [], []
    for code in codes:
        (found if code in mapping else missing).append(mapping.get(code, code))
    return found, missing


def main(argv=None):
    parser = argparse.ArgumentParser(description="Muat hit list outlet Kino ke satu kelas outlet.")
    parser.add_argument("klass", help="LOYALTY / HYBRID / CONTRACTUAL / MSG")
    parser.add_argument("source", nargs="?", default="", help="xlsx hit list; kosongkan bila memakai --empty")
    parser.add_argument("--mapping", default="", help="KINO.xlsx yang memuat sheet Mapping_Customer")
    parser.add_argument("--sheet", default="", help="nama sheet hit list (default: sheet pertama)")
    parser.add_argument("--empty", action="store_true",
                        help="nyatakan kelas ini KOSONG untuk cabang kita (bukan 'belum dimuat')")
    parser.add_argument("--extra", default="", help="kode internal tambahan, dipisah koma, untuk baris yang tak terpetakan")
    parser.add_argument("--force", action="store_true",
                        help="tetap muat walau ada baris tak terpetakan; wajib disebut sadar karena daftar exclude yang bolong memberi potongan ke outlet yang seharusnya dikecualikan")
    parser.add_argument("--apply", action="store_true", help="benar-benar tulis; tanpa ini hanya melaporkan")
    args = parser.parse_args(argv)

    if args.empty:
        codes, missing, column = [], [], -1
    else:
        if not args.source or not args.mapping:
            parser.error("butuh berkas hit list dan --mapping, atau pakai --empty")
        mapping = mapping_of(args.mapping)
        column, raw = kino_codes(sheet_rows(args.source, args.sheet or None), mapping)
        codes, missing = internal_codes(raw, mapping)
        print(f"Mapping_Customer: {len(mapping)} baris | kolom kode outlet: indeks {column}")

    codes = codes + [code.strip() for code in args.extra.split(",") if code.strip()]
    unique = sorted({outlet_class.base_code(code) for code in codes})
    print(f"{args.klass}: {len(codes)} baris -> {len(unique)} kode outlet unik")
    for code in unique[:10]:
        print("   ", code)
    if len(unique) > 10:
        print(f"    ... dan {len(unique) - 10} lagi")
    if missing:
        print(f"TIDAK TERPETAKAN ({len(missing)}): {', '.join(missing[:10])}")
        print("    Lengkapi Mapping_Customer, atau sebutkan kode internalnya lewat --extra.")
        if not args.force:
            print("    DITOLAK. Daftar kelas yang bolong lebih berbahaya daripada tidak dimuat sama sekali:")
            print("    outlet yang hilang dari daftar 'except' akan menerima potongan yang seharusnya tidak.")
            print("    Sudah ditangani lewat --extra? Ulangi dengan --force.")
            return 2
    if not args.apply:
        print("\n(dry-run) tambahkan --apply untuk benar-benar memuat.")
        return 0
    outlet_class.load(args.klass, unique, args.source or "dinyatakan kosong")
    print(f"\nDimuat. Kelas yang kini dikenal sistem: {', '.join(outlet_class.known()) or '(belum ada)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
