"""Tujuan: Mencetak "ALUR FAKTUR PRINCIPAL" — panduan sekali-baca untuk orang yang belum tahu apa pun.
Caller: `python docs/alur_faktur_principal_pdf.py`. Dependensi: reportlab. Side Effects: satu PDF.
Main Functions: bangun. Self-check: jumlah halaman dan keberadaan kolom paraf diperiksa di akhir.

KENAPA PDF, BUKAN MARKDOWN. Dokumen ini DITANDATANGANI: tiap halaman punya kolom paraf OM dan
halaman terakhir punya blok tanda tangan. Halaman yang bisa bergeser membuat paraf kehilangan
artinya — paraf menyatakan "halaman INI sudah saya baca".

Ia BUKAN pengganti `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`. Checklist itu acuan teknik: 835
baris, per butir, untuk yang mengerjakan sistemnya. Berkas ini untuk orang yang baru pertama kali
mendengar semua ini dan harus paham tujuannya dalam sekali baca.
"""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

KELUARAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ALUR_FAKTUR_PRINCIPAL.pdf")
BIRU = colors.HexColor("#1F4E79")
ABU = colors.HexColor("#F2F2F2")
GARIS = colors.HexColor("#BFBFBF")
HIJAU = colors.HexColor("#E2EFDA")
KUNING = colors.HexColor("#FFF2CC")
MERAH = colors.HexColor("#FCE4E4")

S = getSampleStyleSheet()
JUDUL = ParagraphStyle("J", parent=S["Title"], fontSize=17, textColor=BIRU, spaceAfter=2, leading=21)
ANAK = ParagraphStyle("A", parent=S["Normal"], fontSize=9.5, textColor=colors.HexColor("#595959"),
                      alignment=TA_CENTER, spaceAfter=10)
BAB = ParagraphStyle("B", parent=S["Heading2"], fontSize=13, textColor=BIRU, spaceBefore=8, spaceAfter=5)
SUB = ParagraphStyle("S", parent=S["Heading3"], fontSize=10.5, textColor=colors.black, spaceBefore=6, spaceAfter=3)
TEKS = ParagraphStyle("T", parent=S["Normal"], fontSize=10, leading=14.5, spaceAfter=6)
KECIL = ParagraphStyle("K", parent=S["Normal"], fontSize=8.5, leading=11.5, spaceAfter=4)
SEL = ParagraphStyle("Sel", parent=S["Normal"], fontSize=8.8, leading=11.8)
SELB = ParagraphStyle("SelB", parent=SEL, fontName="Helvetica-Bold")
KOTAK = ParagraphStyle("Kotak", parent=S["Normal"], fontSize=8.6, leading=11.5, alignment=TA_CENTER)


def hiasan(canvas, doc):
    """Kepala, nomor halaman, dan KOLOM PARAF OM — di SETIAP halaman."""
    canvas.saveState()
    L, T = A4
    canvas.setFillColor(BIRU)
    canvas.rect(0, T - 1.25 * cm, L, 1.25 * cm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(2 * cm, T - 0.85 * cm, "ALUR FAKTUR PRINCIPAL")
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(L - 2 * cm, T - 0.85 * cm, "CV. SURYA PERKASA")

    # Kolom paraf: kotak nyata, bukan sekadar garis, supaya jelas harus diisi.
    y = 1.35 * cm
    canvas.setStrokeColor(GARIS)
    canvas.setLineWidth(0.6)
    canvas.rect(L - 2 * cm - 4.2 * cm, y - 0.15 * cm, 4.2 * cm, 1.15 * cm, stroke=1, fill=0)
    canvas.setFillColor(colors.HexColor("#595959"))
    canvas.setFont("Helvetica", 6.8)
    canvas.drawCentredString(L - 2 * cm - 2.1 * cm, y + 0.72 * cm, "Paraf OM - halaman ini")
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(2 * cm, y + 0.25 * cm, "Halaman %d" % doc.page)
    canvas.setFont("Helvetica-Oblique", 6.8)
    canvas.drawString(2 * cm, y - 0.15 * cm, "Paraf berarti: halaman ini sudah dibaca dan dipahami.")
    canvas.restoreState()


def tabel(baris, lebar, warna_kepala=BIRU, warna_baris=None):
    t = Table(baris, colWidths=lebar, repeatRows=1)
    gaya = [
        ("BACKGROUND", (0, 0), (-1, 0), warna_kepala),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.8),
        ("GRID", (0, 0), (-1, -1), 0.5, GARIS),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for i, w in enumerate(warna_baris or [], start=1):
        if w:
            gaya.append(("BACKGROUND", (0, i), (-1, i), w))
    t.setStyle(TableStyle(gaya))
    return t


def rantai(langkah):
    """Ilustrasi: kotak-kotak berurut dengan panah, dibaca kiri ke kanan."""
    isi, lebar = [], []
    for i, (atas, bawah) in enumerate(langkah):
        if i:
            isi.append(Paragraph("<font size=13 color='#1F4E79'><b>&rarr;</b></font>", KOTAK))
            lebar.append(0.75 * cm)
        isi.append(Paragraph("<b>%s</b><br/><font size=7.4 color='#595959'>%s</font>" % (atas, bawah), KOTAK))
        lebar.append(2.55 * cm)
    t = Table([isi], colWidths=lebar, rowHeights=[2.0 * cm])
    gaya = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 3)]
    for kolom in range(0, len(isi), 2):
        gaya += [("BOX", (kolom, 0), (kolom, 0), 0.8, BIRU),
                 ("BACKGROUND", (kolom, 0), (kolom, 0), ABU)]
    t.setStyle(TableStyle(gaya))
    return t


def P(teks, gaya=SEL):
    return Paragraph(teks, gaya)


def B(teks):
    return Paragraph(teks, SELB)


def bangun():
    doc = BaseDocTemplate(KELUARAN, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm,
                          topMargin=1.9 * cm, bottomMargin=2.9 * cm,
                          title="Alur Faktur Principal", author="CV. Surya Perkasa")
    doc.addPageTemplates([PageTemplate(id="isi", frames=[Frame(
        doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")], onPage=hiasan)])
    W = doc.width
    C = []

    # ---------------------------------------------------------------- HALAMAN 1
    C += [Paragraph("Alur Faktur Principal", JUDUL),
          Paragraph("Panduan untuk siapa pun yang baru pertama kali membacanya", ANAK),
          Paragraph("Apa yang sebenarnya sedang kita kerjakan?", BAB),
          Paragraph(
              "Kita ini <b>distributor</b>. Barang dibuat pabrik (kita sebut <b>principal</b>, "
              "misalnya Kino), lalu kita yang menjualnya ke toko-toko. Yang menerbitkan "
              "<b>faktur</b> - surat tagihan resmi ke toko - adalah <b>kita</b>, bukan pabrik.", TEKS),
          Paragraph(
              "Pabrik sering mengadakan <b>promo</b>: &#8220;beli 30 pcs dapat bonus 1 pcs&#8221;, "
              "&#8220;belanja Rp 1 juta potong Rp 20.000&#8221;. Promo itu diumumkan lewat "
              "<b>surat program</b>. Uang promonya bukan uang kita - nanti kita "
              "<b>tagihkan kembali ke pabrik</b>.", TEKS),
          Spacer(1, 4)]

    C += [Paragraph("Kenapa ini harus rapi? Dua hal yang bisa hilang.", BAB),
          tabel([
              [B("Kalau potongan diberikan TANPA surat"), B("Kalau potongan LUPA diberikan")],
              [P("Pabrik menolak membayarnya. Potongan itu jadi <b>beban kita sendiri</b> - uang "
                 "keluar dari kantong perusahaan, dan biasanya baru ketahuan berbulan-bulan kemudian "
                 "saat klaim ditolak."),
               P("Toko protes karena merasa dijanjikan. Kita harus membuat nota koreksi, meminta "
                 "maaf, dan <b>kepercayaan toko berkurang</b> - yang jauh lebih mahal daripada "
                 "nominal potongannya.")],
          ], [W / 2] * 2, warna_baris=[MERAH]),
          Spacer(1, 10)]

    C += [Paragraph("Jadi, tujuan sistem ini satu kalimat:", BAB),
          tabel([[P("<b>Setiap potongan yang muncul di faktur harus bisa ditunjuk surat programnya - "
                    "dan setiap potongan yang dijanjikan surat harus benar-benar muncul di faktur.</b>")]],
                [W], warna_kepala=colors.white, warna_baris=[KUNING]),
          Spacer(1, 10),
          Paragraph("Bagaimana dulu, sebelum ada sistem ini?", SUB),
          Paragraph(
              "Orang membandingkan laporan pabrik dengan surat program <b>satu per satu, memakai "
              "mata</b>. Satu hari bisa puluhan toko dan ratusan baris barang. Yang terlewat tidak "
              "pernah berteriak - ia cuma diam sampai klaim ditolak. Sistem ini menggantikan mata "
              "itu dengan pemeriksaan yang <b>tidak pernah lelah dan tidak pernah lupa</b>.", TEKS)]

    # ---------------------------------------------------------------- HALAMAN 2
    C += [PageBreak(), Paragraph("Peta besar: enam langkah", BAB),
          Paragraph("Baca dari kiri ke kanan. Setiap kotak dijelaskan di tabel bawahnya.", TEKS),
          Spacer(1, 4),
          rantai([("1. Toko<br/>pesan", "lewat sales pabrik"),
                  ("2. Tarik<br/>laporan", "file Excel"),
                  ("3. Unggah<br/>ke web", "satu file = satu batch"),
                  ("4. Web<br/>memeriksa", "empat pertanyaan"),
                  ("5. Kirim ke<br/>Accurate", "jadi faktur resmi"),
                  ("6. Tutup<br/>harian", "yang ditahan dibereskan")]),
          Spacer(1, 10)]

    C += [tabel([
        [B("Langkah"), B("Siapa"), B("Apa yang terjadi, dengan bahasa sehari-hari")],
        [P("<b>1.</b> Pesanan masuk"), P("Sales pabrik"),
         P("Toko memesan lewat sales Kino. Pesanannya tercatat di <b>sistem pabrik</b>, belum di "
           "sistem kita. Di titik ini kita belum tahu apa-apa.")],
        [P("<b>2.</b> Tarik laporan"), P("Admin"),
         P("Admin mengunduh laporan harian dari sistem pabrik. Bentuknya file Excel berisi semua "
           "pesanan hari itu: toko mana, barang apa, berapa banyak, dipotong berapa.")],
        [P("<b>3.</b> Unggah"), P("Admin"),
         P("File itu diunggah ke web kita. Satu file jadi satu <b>batch</b>. File yang sama "
           "diunggah dua kali <b>ditolak</b>, supaya tidak ada faktur dobel.")],
        [P("<b>4.</b> Validasi"), P("Sistem"),
         P("Inti pekerjaannya. Sistem mengajukan empat pertanyaan ke setiap baris (halaman 4). "
           "Tiap baris pulang membawa jawabannya sendiri.")],
        [P("<b>5.</b> Kirim"), P("Admin menekan tombol"),
         P("Yang lolos dikirim ke <b>Accurate</b> dan menjadi faktur resmi. Sistem <b>tidak "
           "pernah</b> mengirim sendiri - selalu ada orang yang menekannya.")],
        [P("<b>6.</b> Closing"), P("Admin + OM"),
         P("Yang ditahan diperbaiki hari itu juga: bisa datanya salah, bisa suratnya belum dimuat, "
           "bisa memang ada potongan yang tidak seharusnya.")],
    ], [3.1 * cm, 3.0 * cm, W - 6.1 * cm])]

    # ---------------------------------------------------------------- HALAMAN 3
    C += [PageBreak(), Paragraph("Dari mana &#8220;aturan&#8221; itu datang?", BAB),
          Paragraph(
              "Sistem tidak bisa membaca surat seperti manusia. Surat harus diubah dulu menjadi "
              "<b>aturan</b> - bentuk yang bisa dicocokkan mesin baris per baris. Ini perjalanannya:", TEKS),
          Spacer(1, 4),
          rantai([("Surat<br/>program", "PDF dari pabrik"),
                  ("Ekstrak", "disalin sistem"),
                  ("Periksa<br/>orang", "kelompok &amp; kode"),
                  ("Terbitkan", "dikunci"),
                  ("Muat", "jadi aturan"),
                  ("Gerbang", "memeriksa faktur")]),
          Spacer(1, 8)]

    C += [tabel([
        [B("Tahap"), B("Yang dikerjakan"), B("Kenapa begitu")],
        [P("<b>Ekstrak</b>"),
         P("Surat PDF diunggah. Sistem menyalin isinya menjadi baris-baris: nomor surat, periode, "
           "syarat beli, bonus, dan channel."),
         P("Sistem hanya <b>menyalin</b>, tidak menafsirkan. Menafsirkan berarti menebak, dan "
           "tebakan yang salah tidak pernah berbunyi.")],
        [P("<b>Periksa</b>"),
         P("Orang memilih <b>Kelompok Barang</b> untuk tiap baris, lalu menyimpan. Sistem "
           "menurunkan kode barangnya sendiri dari master."),
         P("Surat menulis &#8220;OVALE 2IN1 CLEANSER&#8221;; master kita menyebutnya &#8220;OVALE "
           "FACIAL LOTION&#8221;. Hanya orang yang tahu keduanya sama.")],
        [P("<b>Terbitkan</b>"),
         P("Summary dikunci. Sesudah ini isinya tidak bisa diubah diam-diam."),
         P("Yang dipakai memotong uang harus punya bentuk tetap yang bisa ditunjuk ulang kapan pun "
           "ada yang bertanya.")],
        [P("<b>Muat</b>"),
         P("Summary yang sudah terbit dimuat menjadi <b>aturan promo</b> yang dipakai gerbang."),
         P("Butuh catatan, unggahan surat bertanda tangan, dan pernyataan &#8220;program ini sudah "
           "benar&#8221;. Tiga gerbang, karena sesudah ini ia memotong uang.")],
    ], [2.5 * cm, (W - 2.5 * cm) / 2, (W - 2.5 * cm) / 2]),
        Spacer(1, 9),
        Paragraph("Surat yang SENGAJA ditolak sistem", SUB),
        Paragraph(
            "Tidak semua surat boleh jadi aturan faktur. Surat ber-mekanisme <b>rafaksi</b> atau "
            "<b>DISC ON PO</b> ditagihkan terpisah dan <b>tidak pernah muncul di faktur</b>. Kalau "
            "surat seperti itu dimuat, gerbang justru akan <i>membenarkan</i> potongan yang seharusnya "
            "tidak ada di sana - kebalikan dari gunanya gerbang. Sistem menolaknya sambil menyebut "
            "alasannya, dan penolakan itu <b>benar</b>, bukan kerusakan.", TEKS)]

    # ---------------------------------------------------------------- HALAMAN 4
    C += [PageBreak(), Paragraph("Empat pertanyaan gerbang", BAB),
          Paragraph("Setiap baris pesanan ditanyai empat hal. Kalau satu saja gagal, baris itu ditahan.", TEKS),
          Spacer(1, 4),
          tabel([
              [B("Pertanyaan"), B("Maksudnya"), B("Contoh yang bikin gagal")],
              [P("<b>1. Barangnya benar?</b>"),
               P("Kode barang pabrik diterjemahkan ke kode kita, lalu dipastikan ada di Accurate. "
                 "Satuannya juga: pabrik menulis PCS, faktur mungkin KARTON."),
               P("Barang baru yang belum pernah dimasukkan ke master kita.")],
              [P("<b>2. Harganya benar?</b>"),
               P("Harga di laporan dibandingkan dengan daftar harga Accurate untuk <b>pelanggan "
                 "itu</b> dan <b>cabang itu</b>. Beda Rp 1 masih ditoleransi."),
               P("Daftar harga baru sudah berlaku, tetapi laporan masih memakai harga lama.")],
              [P("<b>3. Potongannya ada suratnya?</b>"),
               P("Tiap potongan dicocokkan dengan aturan promo. <b>Posisi</b> potongan menyatakan "
                 "siapa yang menanggung: posisi 1-3 kita, posisi 4-5 pabrik."),
               P("Potongan 5% yang tidak ada di surat mana pun. Ia jadi <b>TAK BERTUAN</b>.")],
              [P("<b>4. Tokonya berhak?</b>"),
               P("Surat sering membatasi: hanya channel GT, atau hanya peserta LOYALTY. Channel toko "
                 "dibaca dari <b>master Accurate</b>."),
               P("Surat &#8220;khusus GT&#8221;, tetapi toko itu terdaftar MT di master.")],
          ], [3.5 * cm, (W - 3.5 * cm) * 0.55, (W - 3.5 * cm) * 0.45]),
          Spacer(1, 9),
          Paragraph("Kenapa channel toko dibaca dari master kita, bukan dari laporan pabrik?", SUB),
          Paragraph(
              "Karena laporan bisa keliru dan yang diketik orang bisa dikarang; <b>master adalah "
              "satu-satunya yang kita pegang sendiri</b>. Ini bukan kekhawatiran teoretis: pada satu "
              "batch nyata, toko <b>HINDA MART</b> disebut &#8220;General Trade&#8221; oleh laporan "
              "pabrik, sementara master kita menyimpannya sebagai <b>MT</b>. Kalau kita percaya "
              "laporan, promo khusus GT tadi terlanjur diberikan ke toko MT - dan pabrik tidak akan "
              "membayarnya.", TEKS),
          Paragraph(
              "Aturan yang sama berlaku untuk daftar peserta: <b>daftar kosong bukan berarti "
              "&#8220;tidak ada yang dikecualikan&#8221;</b>, melainkan <b>kita belum tahu siapa</b>. "
              "Yang tidak diketahui ditahan, tidak diloloskan.", TEKS)]

    # ---------------------------------------------------------------- HALAMAN 5
    C += [PageBreak(), Paragraph("Tiga jawaban, dan apa yang harus dilakukan", BAB),
          tabel([
              [B("Jawaban"), B("Artinya"), B("Tindakan")],
              [P("<b>LOLOS</b>"),
               P("Empat pertanyaan terjawab. Semua potongan punya surat."),
               P("Admin menekan <b>Kirim</b>. Jadi faktur di Accurate.")],
              [P("<b>DITINJAU</b>"),
               P("Ada yang belum cocok: harga, satuan, barang, atau toko."),
               P("Admin memperbaiki <b>sumbernya</b> - bukan mengubah angka di faktur.")],
              [P("<b>TAK BERTUAN</b>"),
               P("Ada potongan yang <b>tidak punya surat sama sekali</b>."),
               P("Naik ke OM. Bisa suratnya belum dimuat, bisa memang salah potong.")],
          ], [3.0 * cm, (W - 3.0 * cm) * 0.52, (W - 3.0 * cm) * 0.48],
              warna_baris=[HIJAU, KUNING, MERAH]),
          Spacer(1, 10),
          Paragraph("Kenapa &#8220;tak bertuan&#8221; tidak langsung dianggap beban kita saja?", SUB),
          Paragraph(
              "Karena keduanya sama-sama mengaku sesuatu yang belum terbukti. Mencatatnya sebagai "
              "<b>beban distributor</b> berarti mengaku menanggung uang yang belum jelas milik siapa. "
              "Mencatatnya sebagai <b>klaim principal</b> berarti mengaku berhak menagihnya. Keduanya "
              "bisa salah, jadi sistem menahannya dan meminta orang memutuskan.", TEKS),
          Spacer(1, 6),
          Paragraph("Satu hal yang sering disalahpahami", SUB),
          tabel([[P("Baris yang <b>ditahan bukan kerusakan sistem</b>. Justru sebaliknya: itu saat "
                    "sistem bekerja. Yang berbahaya adalah baris yang <b>lolos padahal seharusnya "
                    "ditahan</b> - dan itu tidak pernah terlihat sampai klaimnya ditolak pabrik.")]],
                [W], warna_kepala=colors.white, warna_baris=[KUNING])]

    # ---------------------------------------------------------------- HALAMAN 6
    C += [PageBreak(), Paragraph("Daftar istilah", BAB),
          tabel([
              [B("Istilah"), B("Artinya dengan bahasa sehari-hari")],
              [P("<b>Principal</b>"), P("Pabrik pemilik merek. Contoh: Kino, Priskila.")],
              [P("<b>Distributor</b>"), P("Kita. Yang membeli dari pabrik dan menjual ke toko.")],
              [P("<b>Surat program</b>"), P("Surat resmi pabrik yang mengumumkan promo: apa, untuk siapa, berapa lama.")],
              [P("<b>Summary</b>"), P("Ringkasan surat yang sudah dirapikan dan diperiksa orang, siap jadi aturan.")],
              [P("<b>Aturan promo</b>"), P("Bentuk surat yang bisa dibaca mesin, dipakai memeriksa faktur.")],
              [P("<b>Gerbang</b>"), P("Pemeriksaan otomatis sebelum faktur dikirim. Menahan yang belum jelas.")],
              [P("<b>Batch</b>"), P("Satu file laporan yang diunggah sekali. Isinya banyak pesanan.")],
              [P("<b>Accurate</b>"), P("Program akuntansi tempat faktur resmi kita dibuat dan disimpan.")],
              [P("<b>Channel</b>"), P("Jenis toko. GT = toko biasa/tradisional. MT = minimarket &amp; supermarket.")],
              [P("<b>Rafaksi</b>"), P("Promo yang ditagih terpisah, TIDAK memotong faktur.")],
              [P("<b>Tak bertuan</b>"), P("Potongan yang tidak punya surat. Belum jelas siapa yang menanggung.")],
              [P("<b>Master barang</b>"), P("Daftar resmi semua barang principal beserta kelompok dan kodenya.")],
          ], [3.6 * cm, W - 3.6 * cm]),
          Spacer(1, 9),
          Paragraph("Yang TIDAK dikerjakan sistem (dan memang tidak boleh)", SUB),
          tabel([
              [B("Hal"), B("Kenapa tetap di tangan orang")],
              [P("Menarik laporan dari sistem pabrik"),
               P("Masih diunduh manual oleh admin. Belum ada sambungan otomatis ke sistem pabrik.")],
              [P("Menekan tombol Kirim"),
               P("Faktur mengikat secara hukum. Harus ada orang yang bertanggung jawab menekannya.")],
              [P("Memilih Kelompok Barang"),
               P("Kata di surat sering berbeda dengan nama di master. Hanya orang yang tahu keduanya sama.")],
              [P("Memutuskan potongan tak bertuan"),
               P("Menebak di sini berarti salah mengakui uang. Naik ke OM.")],
          ], [5.2 * cm, W - 5.2 * cm])]

    # ---------------------------------------------------------------- HALAMAN 7
    C += [PageBreak(), Paragraph("Ringkasan sekali lihat", BAB),
          tabel([[P("<b>Faktur adalah janji tertulis kita kepada toko, dan tagihan kita kepada "
                    "pabrik. Sistem ini memastikan kedua sisi janji itu cocok - sebelum fakturnya "
                    "terbit, bukan sesudah uangnya hilang.</b>")]],
                [W], warna_kepala=colors.white, warna_baris=[KUNING]),
          Spacer(1, 8),
          Paragraph("Tiga kalimat yang perlu diingat", SUB),
          tabel([
              [B("1"), P("Tidak ada potongan tanpa surat. Kalau tidak ada suratnya, ia ditahan - bukan diloloskan.")],
              [B("2"), P("Yang tidak diketahui ditahan. Daftar kosong berarti &#8220;kita belum tahu&#8221;, bukan &#8220;tidak ada&#8221;.")],
              [B("3"), P("Baris ditahan = sistem bekerja. Yang berbahaya adalah yang lolos padahal seharusnya tidak.")],
          ], [1.0 * cm, W - 1.0 * cm], warna_kepala=colors.white),
          Spacer(1, 22)]

    ttd = Table([
        [B("Dibaca dan dipahami oleh"), B("Disetujui oleh")],
        [P("<br/><br/><br/><br/>______________________________<br/>"
           "Nama&nbsp;&nbsp;&nbsp;&nbsp;: ____________________<br/>"
           "Jabatan&nbsp;: ____________________<br/>"
           "Tanggal&nbsp;: ____________________"),
         P("<br/><br/><br/><br/>______________________________<br/>"
           "<b>Operational Manager (OM)</b><br/>"
           "Nama&nbsp;&nbsp;&nbsp;&nbsp;: ____________________<br/>"
           "Tanggal&nbsp;: ____________________")],
    ], colWidths=[W / 2] * 2)
    ttd.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ABU),
        ("GRID", (0, 0), (-1, -1), 0.5, GARIS),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 16),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
    ]))
    C += [KeepTogether([Paragraph("Tanda tangan", BAB), ttd, Spacer(1, 7),
                        Paragraph("Tanda tangan OM di halaman ini berlaku untuk SELURUH halaman "
                                  "dokumen. Paraf per halaman tetap wajib: ia yang menyatakan "
                                  "halaman itu benar-benar dibaca.", KECIL)])]

    doc.build(C)
    return KELUARAN


if __name__ == "__main__":
    jalur = bangun()
    ukuran = os.path.getsize(jalur)
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
    print("%s  (%.0f KB, %d halaman)" % (jalur, ukuran / 1024, halaman))
    gagal = 0
    if halaman > 0:
        if berparaf != halaman:
            gagal += 1
            print("GAGAL kolom paraf OM cuma di %d dari %d halaman - harus SEMUA" % (berparaf, halaman))
        else:
            print("OK    kolom paraf OM ada di %d/%d halaman" % (halaman, halaman))
        if not ttd_ada:
            gagal += 1
            print("GAGAL blok tanda tangan OM tidak ada di halaman terakhir")
        else:
            print("OK    blok tanda tangan OM ada di halaman terakhir")
    print("\nSEMUA LULUS" if not gagal else "\n%d GAGAL" % gagal)
    sys.exit(1 if gagal else 0)
