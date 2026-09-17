"""Tujuan: Mencetak BAGAN ALIR "Alur Faktur Principal" bergaya SOP BP-008 (swimlane per PIC).
Caller: `python docs/alur_faktur_principal_flowchart.py`. Dependensi: reportlab.
Main Functions: bangun. Side Effects: satu PDF di docs/.

BEDANYA DENGAN `alur_faktur_principal_pdf.py`. Yang itu PROSA — menjelaskan kenapa alurnya begitu,
untuk orang yang belum tahu apa pun. Berkas ini BAGAN — memperlihatkan urutannya, siapa
mengerjakan apa, di mana keputusannya bercabang, dan berapa lama tiap langkah. Keduanya
dibutuhkan: prosa tanpa bagan membuat orang kehilangan urutan, bagan tanpa prosa membuat orang
menjalankan langkah tanpa tahu sebabnya.

Bentuknya mengikuti `BP-008 Penanganan Dokumen Klaim` milik principal: kop dokumen bernomor,
kolom per PIC, kotak langkah, belah ketupat keputusan, kolom waktu baku di kanan, dan kolom
dokumen. Tiap halaman punya kolom paraf OM; halaman terakhir punya blok pengesahan.
"""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as pdfcanvas

KELUARAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "BAGAN_ALUR_FAKTUR_PRINCIPAL.pdf")
L, T = landscape(A4)          # 29.7 x 21.0 cm
BIRU = colors.HexColor("#1F4E79")
BIRU_MUDA = colors.HexColor("#DEEAF6")
ABU = colors.HexColor("#F2F2F2")
GARIS = colors.HexColor("#808080")
HIJAU = colors.HexColor("#E2EFDA")
KUNING = colors.HexColor("#FFF2CC")
MERAH = colors.HexColor("#FCE4E4")

# Lajur (swimlane): (judul, x_kiri, lebar) dalam cm.
LAJUR = [
    ("SALES PABRIK\n(di luar sistem kita)", 1.2, 4.6),
    ("ADMIN\n(orang kita)", 6.0, 6.2),
    ("SISTEM WEB\n(otomatis)", 12.4, 8.6),
    ("OM / MANAJEMEN", 21.2, 4.4),
]
X_SLA = 25.9
X_DOK = 27.8


class Bagan:
    def __init__(self, c):
        self.c = c

    def teks(self, x, y, s, size=6.6, bold=False, warna=colors.black):
        self.c.setFillColor(warna)
        self.c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        baris = s.split("\n")
        for i, satu in enumerate(baris):
            yy = y + (len(baris) - 1) * size * 0.58 - i * size * 1.16
            self.c.drawCentredString(x, yy, satu)

    def kotak(self, x, y, w, h, isi, isian=colors.white, size=6.6):
        self.c.setFillColor(isian)
        self.c.setStrokeColor(GARIS)
        self.c.setLineWidth(0.7)
        self.c.rect(x - w / 2, y - h / 2, w, h, stroke=1, fill=1)
        self.teks(x, y, isi, size=size)

    def bulat(self, x, y, w, h, isi):
        self.c.setFillColor(BIRU_MUDA)
        self.c.setStrokeColor(GARIS)
        self.c.setLineWidth(0.9)
        self.c.roundRect(x - w / 2, y - h / 2, w, h, h / 2, stroke=1, fill=1)
        self.teks(x, y, isi, bold=True)

    def ketupat(self, x, y, w, h, isi):
        p = self.c.beginPath()
        p.moveTo(x, y + h / 2)
        p.lineTo(x + w / 2, y)
        p.lineTo(x, y - h / 2)
        p.lineTo(x - w / 2, y)
        p.close()
        self.c.setFillColor(KUNING)
        self.c.setStrokeColor(GARIS)
        self.c.setLineWidth(0.7)
        self.c.drawPath(p, stroke=1, fill=1)
        self.teks(x, y, isi, size=6.2, bold=True)

    def panah(self, x1, y1, x2, y2, label=""):
        import math
        self.c.setStrokeColor(BIRU)
        self.c.setFillColor(BIRU)
        self.c.setLineWidth(0.9)
        self.c.line(x1, y1, x2, y2)
        a = math.atan2(y2 - y1, x2 - x1)
        for s in (0.34, -0.34):
            self.c.line(x2, y2, x2 - 0.20 * cm * math.cos(a + s), y2 - 0.20 * cm * math.sin(a + s))
        if label:
            self.c.setFont("Helvetica-Bold", 5.8)
            self.c.setFillColor(colors.HexColor("#C00000"))
            self.c.drawString((x1 + x2) / 2 + 0.06 * cm, (y1 + y2) / 2 + 0.07 * cm, label)

    def siku(self, x1, y1, x2, y2, label=""):
        """Panah bersiku: turun/naik dulu di x1, lalu mendatar ke x2."""
        self.c.setStrokeColor(BIRU)
        self.c.setLineWidth(0.9)
        self.c.line(x1, y1, x1, y2)
        self.panah(x1, y2, x2, y2, label)

    def sla(self, y, s):
        self.teks(X_SLA * cm, y, s, size=6.4, bold=True, warna=colors.HexColor("#375623"))

    def dok(self, y, s):
        self.teks(X_DOK * cm, y, s, size=5.9, warna=colors.HexColor("#7F6000"))


def kop(c, judul, halaman, total):
    """Kop dokumen bergaya SOP principal: bernomor, berdivisi, bertanggal."""
    c.setFillColor(BIRU)
    c.rect(0, T - 1.0 * cm, L, 1.0 * cm, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(1.2 * cm, T - 0.68 * cm, "CV. SURYA PERKASA")
    c.setFont("Helvetica", 8)
    c.drawCentredString(L / 2, T - 0.68 * cm, judul)
    c.drawRightString(L - 1.2 * cm, T - 0.68 * cm, "Halaman %d dari %d" % (halaman, total))

    y = T - 1.15 * cm
    kolom = [
        (1.2, 7.4, 1.85, [("No. Dokumen", "SP-BP-001/OPS/Rev.00"), ("Divisi", "Operasional / Keuangan")]),
        (8.8, 8.4, 1.75, [("Judul", "Alur Faktur Principal"), ("Departemen", "Admin Penjualan")]),
        (17.4, 5.0, 1.30, [("Revisi", "00"), ("Berlaku", "17 September 2026")]),
        (22.6, 5.9, 1.10, [("Terkait", "ALUR_FAKTUR_PRINCIPAL.pdf"), ("", "CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md")]),
    ]
    c.setStrokeColor(GARIS)
    c.setLineWidth(0.6)
    for x, w, tab, isi in kolom:
        c.setFillColor(ABU)
        c.rect(x * cm, y - 0.98 * cm, w * cm, 0.98 * cm, stroke=1, fill=1)
        c.setFillColor(colors.black)
        for i, (k, v) in enumerate(isi):
            yy = y - 0.32 * cm - i * 0.42 * cm
            c.setFont("Helvetica-Bold", 6.2)
            c.drawString(x * cm + 0.12 * cm, yy, (k + " :") if k else "")
            c.setFont("Helvetica", 6.0)
            c.drawString(x * cm + tab * cm, yy, v)
    return y - 1.1 * cm


def lajur(c, y_atas, y_bawah):
    """Kolom PIC. Judulnya di atas, garis pemisahnya menerus sampai bawah."""
    for judul, x, w in LAJUR:
        c.setFillColor(BIRU_MUDA)
        c.setStrokeColor(GARIS)
        c.setLineWidth(0.7)
        c.rect(x * cm, y_atas - 0.85 * cm, w * cm, 0.85 * cm, stroke=1, fill=1)
        c.setFillColor(BIRU)
        for i, baris in enumerate(judul.split("\n")):
            c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 7 if i == 0 else 5.8)
            c.drawCentredString((x + w / 2) * cm, y_atas - 0.34 * cm - i * 0.30 * cm, baris)
        c.setStrokeColor(colors.HexColor("#BFBFBF"))
        c.setLineWidth(0.4)
        c.setDash(2, 2)
        c.line(x * cm, y_bawah, x * cm, y_atas - 0.85 * cm)
        c.line((x + w) * cm, y_bawah, (x + w) * cm, y_atas - 0.85 * cm)
        c.setDash()
    for x, nama in ((X_SLA, "WAKTU"), (X_DOK, "DOKUMEN")):
        c.setFillColor(ABU)
        c.setStrokeColor(GARIS)
        c.setLineWidth(0.7)
        c.rect((x - 0.85) * cm, y_atas - 0.85 * cm, 1.7 * cm, 0.85 * cm, stroke=1, fill=1)
        c.setFillColor(BIRU)
        c.setFont("Helvetica-Bold", 6.4)
        c.drawCentredString(x * cm, y_atas - 0.55 * cm, nama)
    return y_atas - 0.85 * cm


def paraf(c):
    c.setStrokeColor(colors.HexColor("#BFBFBF"))
    c.setLineWidth(0.6)
    c.rect(L - 1.2 * cm - 4.0 * cm, 0.52 * cm, 4.0 * cm, 1.0 * cm, stroke=1, fill=0)
    c.setFillColor(colors.HexColor("#595959"))
    c.setFont("Helvetica", 6.4)
    c.drawCentredString(L - 1.2 * cm - 2.0 * cm, 1.30 * cm, "Paraf OM - halaman ini")
    c.setFont("Helvetica-Oblique", 6.2)
    c.drawString(1.2 * cm, 0.70 * cm,
                 "Paraf berarti: halaman ini sudah dibaca dan dipahami. "
                 "Tanda tangan OM di halaman terakhir berlaku untuk seluruh dokumen.")


def pusat(i):
    _, x, w = LAJUR[i]
    return (x + w / 2) * cm


# ====================================================================== HALAMAN 1
def halaman_faktur(c, total):
    y = lajur(c, kop(c, "BAGAN ALUR - FAKTUR PRINCIPAL", 1, total), 2.6 * cm)
    b = Bagan(c)
    xsales, xadmin, xsis, xom = (pusat(i) for i in range(4))

    def Y(n):
        return y - (0.70 + n * 1.24) * cm

    b.bulat(xsales, Y(0), 2.6 * cm, 0.62 * cm, "MULAI")
    b.kotak(xsales, Y(1), 4.2 * cm, 0.95 * cm,
            "Toko memesan lewat sales pabrik.\nPesanan tercatat di SISTEM PABRIK,\nbelum di sistem kita.")
    b.sla(Y(1), "Setiap\nhari")

    b.kotak(xadmin, Y(2), 5.6 * cm, 0.75 * cm,
            "Menarik laporan harian dari sistem pabrik\n(ORDER_DETAIL .xlsx)")
    b.sla(Y(2), "Same Day")
    b.dok(Y(2), "Laporan\nORDER_DETAIL")

    b.kotak(xadmin, Y(3), 5.6 * cm, 0.70 * cm, "Mengunggah laporan ke web\n(satu file = satu batch)")
    b.sla(Y(3), "Same Day")

    b.ketupat(xsis, Y(4), 3.8 * cm, 1.05 * cm, "File ini sudah\npernah diunggah?")
    b.kotak(xom, Y(4), 4.1 * cm, 0.90 * cm,
            "Unggahan DITOLAK (409).\nPakai file yang benar,\natau nyatakan GANTI.", MERAH)
    b.panah(xsis + 1.9 * cm, Y(4), xom - 2.05 * cm, Y(4), "YA")

    b.kotak(xsis, Y(5), 8.2 * cm, 0.95 * cm,
            "VALIDASI - empat pertanyaan per baris:\n"
            "1) barang & satuan benar?     2) harga sesuai daftar harga Accurate?\n"
            "3) tiap potongan ada suratnya?     4) toko berhak (channel & peserta)?", size=6.2)
    b.sla(Y(5), "Seketika")

    b.ketupat(xsis, Y(6), 3.6 * cm, 1.05 * cm, "Keempatnya\nterjawab?")

    b.kotak(xadmin, Y(7), 5.6 * cm, 0.85 * cm,
            "DITINJAU - memperbaiki SUMBERNYA:\nmapping barang, daftar harga, kategori outlet.\n"
            "BUKAN mengubah angka di faktur.", KUNING)
    b.siku(xsis - 1.8 * cm, Y(6), xadmin + 2.8 * cm, Y(7), "TIDAK")
    b.sla(Y(7), "Same Day")

    b.kotak(xom, Y(7), 4.1 * cm, 1.25 * cm,
            "TAK BERTUAN\nPotongan tanpa surat.\nOM memutuskan: suratnya\nbelum dimuat, atau\nmemang salah potong.", MERAH)
    b.siku(xsis + 1.8 * cm, Y(6), xom - 2.05 * cm, Y(7), "TIDAK")

    # Sesudah sumbernya dibetulkan, batch-nya diunggah ulang dan divalidasi lagi.
    c.setStrokeColor(BIRU)
    c.setLineWidth(0.9)
    c.setDash(3, 2)
    c.line(xadmin - 2.8 * cm, Y(7), 6.35 * cm, Y(7))
    c.line(6.35 * cm, Y(7), 6.35 * cm, Y(5))
    c.setDash()
    b.panah(6.35 * cm, Y(5), xsis - 4.1 * cm, Y(5), "diunggah ulang")

    b.kotak(xadmin, Y(8), 5.6 * cm, 0.70 * cm,
            "LOLOS - menekan tombol KIRIM.\nSistem tidak pernah mengirim sendiri.", HIJAU)
    b.siku(xsis, Y(6) - 0.53 * cm, xadmin + 2.8 * cm, Y(8), "YA")
    b.sla(Y(8), "Same Day")

    b.kotak(xsis, Y(9), 8.2 * cm, 0.70 * cm,
            "Mengirim ke ACCURATE, lalu MEMBACA KEMBALI fakturnya\n"
            "untuk memastikan isinya cocok baris per baris.")
    b.panah(xadmin + 2.8 * cm, Y(8), xsis - 4.1 * cm, Y(9))
    b.dok(Y(9), "Faktur\nPenjualan")

    b.kotak(xom, Y(10), 4.1 * cm, 0.85 * cm,
            "CLOSING HARIAN\nMemeriksa yang ditahan\nhari itu, lalu memaraf.")
    b.siku(xsis, Y(9) - 0.35 * cm, xom - 2.05 * cm, Y(10))
    b.sla(Y(10), "Same Day")

    b.bulat(xom, Y(11), 2.6 * cm, 0.62 * cm, "SELESAI")
    b.panah(xom, Y(10) - 0.43 * cm, xom, Y(11) + 0.31 * cm)

    b.panah(xsales, Y(0) - 0.31 * cm, xsales, Y(1) + 0.48 * cm)
    b.siku(xsales, Y(1) - 0.48 * cm, xadmin - 2.8 * cm, Y(2))
    b.panah(xadmin, Y(2) - 0.38 * cm, xadmin, Y(3) + 0.35 * cm)
    b.panah(xadmin + 2.8 * cm, Y(3), xsis - 1.9 * cm, Y(4))
    b.panah(xsis, Y(4) - 0.53 * cm, xsis, Y(5) + 0.48 * cm, "TIDAK")
    b.panah(xsis, Y(5) - 0.48 * cm, xsis, Y(6) + 0.53 * cm)

    c.setFillColor(colors.HexColor("#C00000"))
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(1.2 * cm, 2.0 * cm,
                 "Baris yang DITAHAN bukan kerusakan sistem - itu saat sistem bekerja. "
                 "Yang berbahaya adalah baris yang LOLOS padahal seharusnya ditahan.")
    paraf(c)


# ====================================================================== HALAMAN 2
def halaman_aturan(c, total):
    y = lajur(c, kop(c, "BAGAN ALUR - SURAT PROGRAM MENJADI ATURAN", 2, total), 2.6 * cm)
    b = Bagan(c)
    xsales, xadmin, xsis, xom = (pusat(i) for i in range(4))

    def Y(n):
        return y - (0.70 + n * 1.24) * cm

    b.bulat(xsales, Y(0), 2.6 * cm, 0.62 * cm, "MULAI")
    b.kotak(xsales, Y(1), 4.2 * cm, 0.75 * cm, "Pabrik menerbitkan\nSURAT PROGRAM (PDF)")
    b.dok(Y(1), "Surat\nProgram")
    b.panah(xsales, Y(0) - 0.31 * cm, xsales, Y(1) + 0.38 * cm)

    b.kotak(xadmin, Y(2), 5.6 * cm, 0.70 * cm,
            "Mengunggah surat ke menu Summary Promo,\nlalu menekan EKSTRAK")
    b.siku(xsales, Y(1) - 0.38 * cm, xadmin - 2.8 * cm, Y(2))
    b.sla(Y(2), "Same Day")

    b.kotak(xsis, Y(3), 8.2 * cm, 0.90 * cm,
            "MENYALIN isi surat apa adanya: nomor, periode, syarat beli,\n"
            "bonus, channel, peserta. Sistem TIDAK menafsirkan - menafsirkan\n"
            "berarti menebak, dan tebakan tidak berbunyi saat salah.", size=6.2)
    b.panah(xadmin + 2.8 * cm, Y(2), xsis - 4.1 * cm, Y(3))

    b.ketupat(xsis, Y(4), 4.4 * cm, 1.05 * cm, "Mekanismenya\nON FAKTUR?")
    b.panah(xsis, Y(3) - 0.45 * cm, xsis, Y(4) + 0.53 * cm)
    b.kotak(xom, Y(4), 4.1 * cm, 1.05 * cm,
            "DITOLAK, dan itu BENAR.\nRafaksi / DISC ON PO ditagih\nTERPISAH dan tidak pernah\nmemotong faktur.", MERAH)
    b.panah(xsis + 2.2 * cm, Y(4), xom - 2.05 * cm, Y(4), "TIDAK")

    b.kotak(xadmin, Y(5), 5.6 * cm, 0.85 * cm,
            "MEMERIKSA - memilih Kelompok Barang tiap baris.\n"
            "Kata di surat sering beda dengan nama di master\n"
            "(\"OVALE 2IN1 CLEANSER\" jadi \"OVALE FACIAL\").", KUNING, size=6.2)
    b.siku(xsis, Y(4) - 0.53 * cm, xadmin + 2.8 * cm, Y(5), "YA")

    b.kotak(xsis, Y(6), 8.2 * cm, 0.70 * cm,
            "SIMPAN - sistem menurunkan KODE BARANG-nya sendiri\ndari master principal.")
    b.panah(xadmin + 2.8 * cm, Y(5), xsis - 4.1 * cm, Y(6))

    b.ketupat(xsis, Y(7), 4.4 * cm, 1.05 * cm, "Semua baris sudah\nberkode & berperiode?")
    b.panah(xsis, Y(6) - 0.35 * cm, xsis, Y(7) + 0.53 * cm)
    c.setStrokeColor(BIRU)
    c.setLineWidth(0.9)
    c.setDash(3, 2)
    c.line(xsis - 2.2 * cm, Y(7), xadmin + 3.4 * cm, Y(7))
    c.line(xadmin + 3.4 * cm, Y(7), xadmin + 3.4 * cm, Y(5))
    c.setDash()
    b.panah(xadmin + 3.4 * cm, Y(5), xadmin + 2.81 * cm, Y(5), "TIDAK - dibetulkan")

    b.kotak(xadmin, Y(8), 5.6 * cm, 0.70 * cm,
            "TERBITKAN - Summary dikunci,\nisinya tidak bisa diubah diam-diam.", HIJAU)
    b.siku(xsis, Y(7) - 0.53 * cm, xadmin + 2.8 * cm, Y(8), "YA")

    b.kotak(xom, Y(9), 4.1 * cm, 1.05 * cm,
            "MUAT - tiga gerbang:\ncatatan, unggahan surat bertanda\ntangan, dan pernyataan\n\"program ini sudah benar\".",
            BIRU_MUDA, size=6.2)
    b.siku(xadmin, Y(8) - 0.35 * cm, xom - 2.05 * cm, Y(9))
    b.sla(Y(9), "1 hari")
    b.dok(Y(9), "Surat ttd\n+ catatan")

    b.kotak(xsis, Y(10), 8.2 * cm, 0.70 * cm,
            "ATURAN PROMO TERBIT\ndipakai gerbang Validasi di halaman 1, pertanyaan ke-3.", HIJAU)
    b.siku(xom, Y(9) - 0.53 * cm, xsis + 4.1 * cm, Y(10))

    b.bulat(xsis, Y(11), 2.6 * cm, 0.62 * cm, "SELESAI")
    b.panah(xsis, Y(10) - 0.35 * cm, xsis, Y(11) + 0.31 * cm)

    c.setFillColor(colors.HexColor("#C00000"))
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(1.2 * cm, 2.0 * cm,
                 "Yang tidak diketahui DITAHAN, bukan diloloskan. Daftar peserta yang kosong berarti "
                 "\"kita belum tahu siapa\" - bukan \"tidak ada yang dikecualikan\".")
    paraf(c)


# ====================================================================== HALAMAN 3
def halaman_ttd(c, total):
    y = kop(c, "KETERANGAN, WAKTU BAKU, DAN PENGESAHAN", 3, total)
    b = Bagan(c)

    c.setFillColor(BIRU)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.2 * cm, y - 0.45 * cm, "Arti bentuk pada bagan")
    yy = y - 1.45 * cm
    x = 2.5 * cm
    b.bulat(x, yy, 2.4 * cm, 0.6 * cm, "MULAI")
    b.kotak(x + 3.6 * cm, yy, 2.4 * cm, 0.6 * cm, "Langkah")
    b.ketupat(x + 7.2 * cm, yy, 2.6 * cm, 0.9 * cm, "Ya / Tidak")
    c.setFillColor(colors.black)
    c.setFont("Helvetica", 6.6)
    for dx, nama in ((0, "Mulai / Selesai"), (3.6, "Langkah dikerjakan"), (7.2, "Keputusan bercabang")):
        c.drawCentredString(x + dx * cm, yy - 0.78 * cm, nama)
    x += 10.4 * cm
    for warna, nama in ((HIJAU, "LOLOS"), (KUNING, "DITINJAU"), (MERAH, "DITAHAN / DITOLAK")):
        c.setFillColor(warna)
        c.setStrokeColor(GARIS)
        c.setLineWidth(0.7)
        c.rect(x, yy - 0.3 * cm, 2.6 * cm, 0.6 * cm, stroke=1, fill=1)
        c.setFillColor(colors.black)
        c.setFont("Helvetica", 6.6)
        c.drawCentredString(x + 1.3 * cm, yy - 0.78 * cm, nama)
        x += 3.4 * cm

    c.setFillColor(BIRU)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.2 * cm, y - 3.2 * cm, "Waktu baku (SLA)")
    baris = [
        ("Tarik laporan pabrik, lalu unggah ke web", "Same Day", "Laporan hari ini diunggah hari ini juga."),
        ("Validasi otomatis", "Seketika", "Berjalan begitu batch selesai diunggah."),
        ("Perbaikan baris DITINJAU", "Same Day", "Perbaiki SUMBERNYA, lalu unggah ulang batch-nya."),
        ("Keputusan TAK BERTUAN oleh OM", "1 hari kerja", "Menebak di sini berarti salah mengakui uang."),
        ("Kirim ke Accurate", "Same Day", "Ditekan orang, bukan otomatis."),
        ("Surat program menjadi aturan terbit", "1 hari kerja", "Dihitung sejak surat diterima admin."),
        ("Closing harian dan paraf OM", "Same Day", "Yang ditahan tidak boleh menginap tanpa catatan."),
    ]
    yy = y - 3.75 * cm
    c.setStrokeColor(GARIS)
    c.setLineWidth(0.6)
    c.setFillColor(BIRU)
    c.rect(1.2 * cm, yy - 0.5 * cm, 27.3 * cm, 0.5 * cm, stroke=1, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 6.8)
    for tx, lab in ((1.35, "Langkah"), (12.0, "Waktu baku"), (15.4, "Catatan")):
        c.drawString(tx * cm, yy - 0.34 * cm, lab)
    yy -= 0.5 * cm
    for i, (a, t, k) in enumerate(baris):
        c.setFillColor(ABU if i % 2 else colors.white)
        c.setStrokeColor(GARIS)
        c.rect(1.2 * cm, yy - 0.48 * cm, 27.3 * cm, 0.48 * cm, stroke=1, fill=1)
        c.setFillColor(colors.black)
        c.setFont("Helvetica", 6.6)
        c.drawString(1.35 * cm, yy - 0.32 * cm, a)
        c.setFont("Helvetica-Bold", 6.6)
        c.drawString(12.0 * cm, yy - 0.32 * cm, t)
        c.setFont("Helvetica", 6.6)
        c.drawString(15.4 * cm, yy - 0.32 * cm, k)
        yy -= 0.48 * cm

    yy -= 1.0 * cm
    c.setFillColor(BIRU)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(1.2 * cm, yy, "Pengesahan")
    yy -= 0.4 * cm
    kolom = [("Dibuat oleh", "Admin Penjualan"), ("Diperiksa oleh", "Supervisor"),
             ("Disetujui oleh", "Operational Manager (OM)"), ("Diketahui oleh", "Direktur")]
    w = 27.3 / len(kolom)
    for i, (peran, jabatan) in enumerate(kolom):
        x = 1.2 * cm + i * w * cm
        c.setFillColor(ABU)
        c.setStrokeColor(GARIS)
        c.setLineWidth(0.7)
        c.rect(x, yy - 0.45 * cm, w * cm, 0.45 * cm, stroke=1, fill=1)
        c.setFillColor(colors.black)
        c.setFont("Helvetica-Bold", 7)
        c.drawCentredString(x + w * cm / 2, yy - 0.31 * cm, peran)
        c.setFillColor(colors.white)
        c.rect(x, yy - 2.85 * cm, w * cm, 2.40 * cm, stroke=1, fill=1)
        c.setFillColor(colors.black)
        c.setFont("Helvetica", 6.6)
        c.drawCentredString(x + w * cm / 2, yy - 2.00 * cm, "______________________")
        c.setFont("Helvetica-Bold", 6.6)
        c.drawCentredString(x + w * cm / 2, yy - 2.32 * cm, jabatan)
        c.setFont("Helvetica", 6.2)
        c.drawCentredString(x + w * cm / 2, yy - 2.65 * cm, "Nama : _____________    Tanggal : __________")
    paraf(c)


def bangun():
    c = pdfcanvas.Canvas(KELUARAN, pagesize=landscape(A4))
    c.setTitle("Bagan Alur Faktur Principal")
    c.setAuthor("CV. Surya Perkasa")
    halaman_faktur(c, 3)
    c.showPage()
    halaman_aturan(c, 3)
    c.showPage()
    halaman_ttd(c, 3)
    c.showPage()
    c.save()
    return KELUARAN


if __name__ == "__main__":
    jalur = bangun()
    halaman = berparaf = -1
    ttd_ada = True
    try:
        import fitz
        d = fitz.open(jalur)
        halaman = d.page_count
        berparaf = sum(1 for p in d if "Paraf OM" in p.get_text())
        ttd_ada = "Operational Manager (OM)" in d[-1].get_text()
        d.close()
    except ImportError:
        print("CATATAN: PyMuPDF tidak ada, isi PDF tidak diperiksa.")
    print("%s  (%.0f KB, %d halaman)" % (jalur, os.path.getsize(jalur) / 1024, halaman))
    gagal = 0
    if halaman > 0:
        if berparaf != halaman:
            gagal += 1
            print("GAGAL kolom paraf OM cuma di %d dari %d halaman" % (berparaf, halaman))
        else:
            print("OK    kolom paraf OM ada di %d/%d halaman" % (halaman, halaman))
        if not ttd_ada:
            gagal += 1
            print("GAGAL blok tanda tangan OM tidak ada di halaman terakhir")
        else:
            print("OK    blok tanda tangan OM ada di halaman terakhir")
    print("\nSEMUA LULUS" if not gagal else "\n%d GAGAL" % gagal)
    sys.exit(1 if gagal else 0)
