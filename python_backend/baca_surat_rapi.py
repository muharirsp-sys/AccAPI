"""Tujuan: Merapikan baris hasil baca surat supaya peninjau tidak mengoreksi yang sudah pasti.
Caller: routers/summary.py (`summary_manual_parse_pdf_ai`). Dependensi: stdlib. Tanpa I/O.
Main Functions: rapikan_baris. Side Effects: tidak ada — murni.

KENAPA ADA.
Sebelum ini tiap surat menuntut lima koreksi tangan, dan empat di antaranya jawabannya sudah
pasti sebelum siapa pun melihat suratnya:

  principle  -> orangnya SUDAH memilih principle-nya di layar sebelum mengunggah;
                menanyakannya lagi ke model hanya menambah cara untuk salah.
  variant    -> surat yang tidak menyebut varian tertentu berarti SEMUA varian.
  gramasi    -> surat yang tidak menyebut gramasi tertentu berarti SEMUA gramasi.
  kelompok   -> yang bukan kelompok master bukan "kelompok yang aneh", melainkan BUKAN
                kelompok. Menaruhnya di kolom kelompok membuat resolusi SKU tidak punya
                pegangan, dan orangnya harus membuangnya dulu sebelum bisa mengisi yang benar.

Yang TIDAK dilakukan di sini: menebak kelompok. Kalau frasa suratnya tidak cocok persis dengan
satu kelompok master, kolomnya DIKOSONGKAN dan frasanya dipindahkan ke keterangan — supaya
peninjau memilih dari daftar master yang bersih, tanpa kehilangan kata-kata suratnya. Menebak
kelompok berarti memilih barang mana yang dapat promo, dan itu bukan tebakan yang boleh
dilakukan mesin diam-diam.
"""


def _norm(teks):
    return " ".join(str(teks or "").strip().upper().split())


def rapikan_baris(rows, master_items, principle_name=""):
    """Kembalikan baris yang sudah dirapikan. Tidak mengubah `rows` aslinya."""
    kelompok_master = {_norm(it.get("kelompok")) for it in (master_items or []) if str(it.get("kelompok") or "").strip()}
    varian_master = {_norm(it.get("variant")) for it in (master_items or []) if str(it.get("variant") or "").strip()}
    principal = str(principle_name or "").strip()

    hasil = []
    for baris in rows or []:
        r = dict(baris)

        # 1. Principal: yang dipilih orang di layar menang atas tebakan model.
        if principal:
            r["principle"] = principal

        # 2. Nama program: badan surat sering ikut terbawa ("... Kepada Yth. Owner ...").
        #    Dipotong pada penanda pertama badan surat, bukan pada panjang tertentu —
        #    memotong pada panjang akan memenggal nama program yang memang panjang.
        nama = str(r.get("nama_program") or "").strip()
        for penanda in ("Kepada Yth", "Dengan hormat", "Sehubungan dengan", "Bersama ini"):
            potong = nama.find(penanda)
            if potong > 0:
                nama = nama[:potong]
        r["nama_program"] = " ".join(nama.split()).rstrip(" ,.:;-")

        # 3. Kelompok yang bukan kelompok master dikosongkan, katanya disimpan.
        kel = str(r.get("kelompok") or "").strip()
        if kel and _norm(kel) not in kelompok_master:
            cocok = [k for k in kelompok_master if k and k in _norm(kel)]
            if len(cocok) == 1:
                r["kelompok"] = cocok[0]
            else:
                r["kelompok"] = ""
                catatan = str(r.get("keterangan") or "").strip()
                r["keterangan"] = (catatan + "; " if catatan else "") + f"surat menyebut: {kel}"

        # 4 & 5. Tidak menyebut varian/gramasi tertentu = SEMUA. Nilai yang bukan varian master
        #        (mis. kalimat suratnya sendiri terbawa ke sini) juga berarti tidak menyebut.
        var = str(r.get("variant") or "").strip()
        if not var or (_norm(var) not in varian_master and _norm(var) != "ALL VARIANT"):
            r["variant"] = "ALL VARIANT"
        if not str(r.get("gramasi") or "").strip():
            r["gramasi"] = "ALL GRAMASI"

        hasil.append(r)
    return hasil
