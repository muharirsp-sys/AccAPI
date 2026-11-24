/*
 * Tujuan: Keputusan owner 19 Nov 2026 — nota hit list (GT Hit List Massive Distribusi NPL, Kino) tidak boleh menahan order:
 *   order APA PUN (nota hit list atau bukan) untuk outlet hit list yang tertahan batas hari dan/atau limit KARENA nota hit list yang
 *   belum lunas tetap masuk — asal piutang di luar nota hit list + pesanan terbuka + order <= limit, dan tidak ada nota BUKAN hit list
 *   belum lunas yang sudah mencapai batas hari — syarat batas hari ini hanya untuk order BIASA: owner 24 Nov 2026, order NPL (nota hit
 *   list) tetap lolos walau nota biasa sudah lewat batas hari; limit tetap berlaku untuk keduanya.
 *   Selain itu tetap ditolak Accurate seperti biasa.
 * Caller: lib/invoice-sender (sesudah Accurate menolak satu faktur).
 * Dependensi: lib/accurate-forward (baca/tulis Accurate dengan sesi pengirim), lib/pelanggan-hendra, lib/pelanggan-terlindungi.
 * Main Functions: pelangganHitlist, notaGtHitlist, tolakBatas, putuskan, lolosBatasPiutang, pelangganAccurate, gtHitlistMati.
 * Side Effects: lolosBatasPiutang membaca pelanggan + nota belum lunas + pesanan penjualan terbuka (list.do/detail.do, berjeda: Accurate
 *   membatasi 8 request/detik per token) dan menulis customer/save.do (lepas lalu pulihkan centang batas) lewat penulis suntikan.
 *
 * Cara kerja: faktur dikirim seperti biasa. Bila Accurate menolak HANYA karena batas piutang (umur "Ada faktur yang belum dilunasi
 * lebih dari N hari" dan/atau nominal "Total piutang dan pesanan menjadi lebih dari Rp ...") untuk pelanggan outlet hit list, nota
 * belum lunasnya dibaca dan dipilah (nota hit list = semua barisnya SKU hit list), lalu `putuskan`. Boleh = centang batas yang disebut
 * Accurate dilepas sebentar (nilainya dibiarkan), faktur dikirim SEKALI lagi, centang + nilai asal dikembalikan dan dibaca ulang.
 * Toko hold (limit Rp 1 / 1 hari) tetap tertahan oleh limitnya. Pelanggan bercatatan Hendra dan toko NKA/DC terlindungi tidak disentuh.
 * Data: "GT - HITLIST MASSIVE DISTRIBUSI NPL.xlsx" sheet Master, distributor 1201671 (Surya Perkasa): 1.498 outlet -> 1.467 kode
 *   Accurate (Mapping Principal pelanggan KINO NON FOOD; sisanya kode di nama toko; 14 outlet tanpa kode tidak ikut). Sheet Mapping
 *   Fatah: 29 SKU berkategori -> kode barang Accurate lewat Mapping Principal barang (pasta gigi B&B tanpa kategori = bukan hit list).
 * Saklar darurat: env GT_HITLIST_LOLOS=mati.
 * ponytail: daftar ditanam di kode (tanpa tabel/unggahan) — hit list berganti = berkas ini diganti; bila sering berganti, pindah ke tabel.
 */
import { bacaAccurate, forwardAccurate, type AccurateTarget } from "@/lib/accurate-forward";
import { isCatatanHendra } from "@/lib/pelanggan-hendra";
import { isPelangganTerlindungi } from "@/lib/pelanggan-terlindungi";

/** Kode barang Accurate -> kategori hit list. */
export const GT_HITLIST_SKU: ReadonlyMap<string, string> = new Map([
    ["K1046012025020", "B&B Shampoo"], ["K1046010025020", "B&B Shampoo"], ["K1046011025020", "B&B Shampoo"],
    ["K1046012010020", "B&B Shampoo"], ["K1046010010020", "B&B Shampoo"], ["K1046011010020", "B&B Shampoo"],
    ["K1047018010010", "B&B Spray cologne"], ["K1047016010010", "B&B Spray cologne"], ["K1047017010010", "B&B Spray cologne"],
    ["K1045008015010", "B&B Powder"], ["K1045007015010", "B&B Powder"], ["K1045006015010", "B&B Powder"],
    ["K1055008006010", "B&B Powder"], ["K1045007006010", "B&B Powder"], ["K1065006006010", "B&B Powder"],
    ["K1041102030010", "B&B HBW"], ["K1041101030010", "B&B HBW"],
    ["K1041003025010", "B&B Shower Gel"], ["K1041004025010", "B&B Shower Gel"],
    ["K1100010004520", "Ellips HV Ultra light"],
    ["K1531001003011", "Sasha Shampoo color"], ["K1531002003011", "Sasha Shampoo color"],
    ["K1540002010010", "Resik v daily gentel fress"], ["K1540001010010", "Resik v daily gentel fress"],
    ["K1540003010010", "Resik v daily gentel fress"],
    ["K2521003004010", "Theory"], ["K3521004004010", "Theory"],
    ["K1090001010010", "Ellips Hair mist"], ["K1090002010010", "Ellips Hair mist"],
]);

/** Kode dasar outlet hit list (tanpa sufiks divisi). */
export const GT_HITLIST_OUTLET: ReadonlySet<string> = new Set([
    "BL-SOH001", "C-100001", "C-100002", "C-100005", "C-100015", "C-150001", "C-160004", "C-180001", "C-180002",
    "C-190002", "C-190006", "C-210001", "C-210002", "C-210020", "C-211001", "C-220001", "C-220011", "C-22M002",
    "C-250001", "C-250009", "C-260007", "C-270008", "C-290002", "C-300003", "C-300013", "C-330008", "C-350004",
    "C-380005", "C-386001", "C-390007", "C-500003", "C-500006", "C-500008", "C-530001", "C-540007", "C-590003",
    "C-5A0001", "C-660002", "C-780001", "C-790001", "C-800003", "C-800006", "C-880002", "C-990001", "C-990004",
    "C-999002", "C-A20003", "C-A30007", "C-AAR001", "C-AB0003", "C-AB0006", "C-AB0007", "C-AB0009", "C-AB0028",
    "C-AB0041", "C-AB0047", "C-AB0049", "C-ABD018", "C-ABE002", "C-ABE003", "C-ABI007", "C-ABI010", "C-AD0003",
    "C-AD0021", "C-AD0022", "C-AD0054", "C-ADA005", "C-ADA008", "C-ADA010", "C-ADA014", "C-ADE009", "C-ADE011",
    "C-ADI002", "C-ADI039", "C-ADI133", "C-ADI135", "C-ADI225", "C-ADI893", "C-ADR013", "C-ADR713", "C-AEM001",
    "C-AF0009", "C-AFA004", "C-AFD008", "C-AFI010", "C-AFI019", "C-AFN001", "C-AFR004", "C-AG0021", "C-AGA001",
    "C-AGA002", "C-AGA004", "C-AH0003", "C-AH0006", "C-AHD001", "C-AI0001", "C-AID005", "C-AID006", "C-AIN006",
    "C-AIN017", "C-AIN023", "C-AIQ001", "C-AIR011", "C-AIS020", "C-AIS022", "C-AIS026", "C-AIS132", "C-AK0010",
    "C-AK0013", "C-AK0032", "C-AK0041", "C-AKB017", "C-AKB025", "C-AKB102", "C-AKS005", "C-AL0014", "C-AL0017",
    "C-AL0018", "C-AL0033", "C-AL0034", "C-AL0111", "C-AL0517", "C-AL0538", "C-AL0541", "C-AL0544", "C-AL775",
    "C-ALA011", "C-ALF019", "C-ALF031", "C-ALF032", "C-ALF038", "C-ALF040", "C-ALI023", "C-ALI032", "C-ALI048",
    "C-ALI049", "C-ALI050", "C-ALK507", "C-ALL006", "C-ALM009", "C-ALM011", "C-ALN001", "C-ALT001", "C-ALU001",
    "C-ALV004", "C-ALY005", "C-ALY008", "C-AM0003", "C-AM0020", "C-AM0029", "C-AM0093", "C-AMA041", "C-AMA755",
    "C-AMB023", "C-AME007", "C-AMI023", "C-AMI120", "C-AMR005", "C-AMS001", "C-AMY005", "C-AN0005", "C-AN0016",
    "C-AN0031", "C-AN0049", "C-AN0056", "C-AN0064", "C-AN0072", "C-AN0111", "C-AN0124", "C-AN0141", "C-AN0183",
    "C-AN0211", "C-AN0250", "C-AN0267", "C-AN0271", "C-ANA005", "C-ANA025", "C-ANA029", "C-ANA034", "C-ANA038",
    "C-AND022", "C-AND036", "C-ANE036", "C-ANE043", "C-ANG018", "C-ANG034", "C-ANH002", "C-ANI026", "C-ANI045",
    "C-ANI774", "C-ANJ010", "C-ANN015", "C-ANN021", "C-ANN028", "C-ANN165", "C-ANN256", "C-ANR001", "C-ANS009",
    "C-ANT056", "C-ANT060", "C-ANT061", "C-ANT065", "C-ANU015", "C-ANU017", "C-ANU021", "C-ANU055", "C-ANU063",
    "C-APO042", "C-APO442", "C-APO779", "C-APT019", "C-APT060", "C-APT136", "C-APT144", "C-APT151", "C-AQI006",
    "C-AR0007", "C-AR0011", "C-AR0027", "C-AR0102", "C-AR0133", "C-AR0140", "C-AR0143", "C-AR0145", "C-AR0146",
    "C-ARA004", "C-ARA015", "C-ARD026", "C-ARF012", "C-ARH007", "C-ARI062", "C-ARI064", "C-ARK238", "C-ARL002",
    "C-ARM006", "C-ARM013", "C-ARN008", "C-ARN012", "C-ARS010", "C-ARS011", "C-ARS012", "C-ARU001", "C-ARU323",
    "C-ARY009", "C-ARY010", "C-AS0002", "C-AS0007", "C-AS0008", "C-AS0010", "C-AS0011", "C-AS0038", "C-AS0048",
    "C-AS0080", "C-AS0114", "C-AS0117", "C-AS0122", "C-AS0507", "C-ASI019", "C-ASK004", "C-ASM005", "C-ASM016",
    "C-ASM019", "C-ASN006", "C-ASR025", "C-ASR030", "C-ASR033", "C-ASR040", "C-ASS006", "C-AT0001", "C-AT0003",
    "C-ATH003", "C-ATI016", "C-ATT003", "C-AU0022", "C-AUB001", "C-AUL121", "C-AUR004", "C-AUR392", "C-AYR001",
    "C-AYU017", "C-AYU020", "C-AYU022", "C-AZ0026", "C-AZA002", "C-AZK001", "C-AZK003", "C-AZK004", "C-B20001",
    "C-BA0014", "C-BA0015", "C-BA0019", "C-BA0048", "C-BA0058", "C-BA0060", "C-BA0064", "C-BAB008", "C-BAH010",
    "C-BAH025", "C-BAH027", "C-BAK702", "C-BAL006", "C-BAR019", "C-BAR023", "C-BAR024", "C-BAR027", "C-BAR030",
    "C-BAR032", "C-BAR033", "C-BAS016", "C-BAT003", "C-BAW001", "C-BAW003", "C-BAY006", "C-BAY260", "C-BBM465",
    "C-BE0001", "C-BE0021", "C-BE0057", "C-BEA001", "C-BEA004", "C-BEA007", "C-BEL021", "C-BEN006", "C-BER007",
    "C-BER029", "C-BER030", "C-BER046", "C-BER047", "C-BER060", "C-BER062", "C-BER704", "C-BEW001", "C-BI0001",
    "C-BI0037", "C-BI0041", "C-BIL240", "C-BIM001", "C-BIN048", "C-BIN056", "C-BIN058", "C-BLES001", "C-BO0007",
    "C-BO0009", "C-BON010", "C-BON011", "C-BOR002", "C-BR0010", "C-BU0002", "C-BU0008", "C-BU0009", "C-BU0010",
    "C-BU0011", "C-BU0017", "C-BU0020", "C-BUA015", "C-BUD006", "C-BUD025", "C-BUG008", "C-BUN016", "C-BUN025",
    "C-BUN261", "C-BUN705", "C-BUN706", "C-BUR015", "C-C-SED010", "C-CA0001", "C-CA0011", "C-CA0014", "C-CA0026",
    "C-CA0031", "C-CA0034", "C-CA0047", "C-CA0074", "C-CA0100", "C-CA0131", "C-CA0134", "C-CA0139", "C-CA0163",
    "C-CA0188", "C-CA0196", "C-CA0235", "C-CA0241", "C-CAH040", "C-CAH048", "C-CAH070", "C-CAH075", "C-CAH104",
    "C-CAH137", "C-CAH177", "C-CAH189", "C-CAH192", "C-CAH196", "C-CAH208", "C-CAH213", "C-CAH239", "C-CAH281",
    "C-CAH323", "C-CAH524", "C-CAH704", "C-CAH707", "C-CAM003", "C-CAY004", "C-CC0001", "C-CEL004", "C-CEM001",
    "C-CHA010", "C-CHE004", "C-CHI005", "C-CHI007", "C-CHI008", "C-CI0011", "C-CI0014", "C-CIN003", "C-CIN005",
    "C-CIR001", "C-CIS001", "C-CIS002", "C-CIS003", "C-CIS004", "C-CIS760", "C-CIT037", "C-CIT045", "C-CL0002",
    "C-CL0004", "C-CM0005", "C-COS001", "C-CV0008", "C-CV0014", "C-CV0038", "C-CV0039", "C-DAF006", "C-DAM008",
    "C-DAM009", "C-DAR352", "C-DAS002", "C-DAV156", "C-DAW001", "C-DAW002", "C-DAY006", "C-DE0001", "C-DE0013",
    "C-DEL014", "C-DEL015", "C-DEP001", "C-DES006", "C-DES012", "C-DEW012", "C-DEW019", "C-DEW021", "C-DEW023",
    "C-DEW025", "C-DEW027", "C-DEW032", "C-DEW712", "C-DG0011", "C-DHI005", "C-DI0023", "C-DI0030", "C-DI0038",
    "C-DIA001", "C-DIA050", "C-DIA051", "C-DIL001", "C-DIN016", "C-DIN020", "C-DIV005", "C-DOM001", "C-DR0003",
    "C-DRA001", "C-DRE001", "C-DUA016", "C-DUA021", "C-DUA029", "C-DUA708", "C-DUN011", "C-DUN013", "C-DZ0001",
    "C-EA0002", "C-EDG201", "C-EK0011", "C-EKA006", "C-EL0021", "C-EL0032", "C-EM001", "C-EMS001", "C-END001",
    "C-END008", "C-ER0037", "C-ER0041", "C-ER0043", "C-ERB001", "C-ERD001", "C-ERN020", "C-ERS001", "C-ERV001",
    "C-ERW001", "C-ERY002", "C-FA0001", "C-FA0018", "C-FA0026", "C-FA0028", "C-FA0049", "C-FA0053", "C-FA0086",
    "C-FA0106", "C-FA0127", "C-FA0133", "C-FAD012", "C-FAD025", "C-FAD038", "C-FAD047", "C-FAD052", "C-FAD062",
    "C-FAE001", "C-FAE002", "C-FAE729", "C-FAI016", "C-FAI021", "C-FAI022", "C-FAI116", "C-FAJ017", "C-FAJ027",
    "C-FAJ043", "C-FAR033", "C-FAR101", "C-FAT024", "C-FAT026", "C-FAT032", "C-FAT036", "C-FAT037", "C-FAU020",
    "C-FAU023", "C-FE0019", "C-FEB011", "C-FEN002", "C-FER006", "C-FI0007", "C-FI0026", "C-FI0050", "C-FIF002",
    "C-FIK009", "C-FIK013", "C-FIN001", "C-FIN002", "C-FIR013", "C-FIR022", "C-FIR026", "C-FIR027", "C-FIT020",
    "C-FIT022", "C-FIT025", "C-FIT168", "C-FLA002", "C-FUJ0004", "C-G20001", "C-GA0003", "C-GA0011", "C-GAL001",
    "C-GAL006", "C-GAL007", "C-GAL008", "C-GAL009", "C-GAR010", "C-GE0004", "C-GEM008", "C-GI0012", "C-GL0002",
    "C-GLO007", "C-GLO239", "C-GR0004", "C-GRA010", "C-GRA020", "C-GUM001", "C-HA0004", "C-HA0022", "C-HA0028",
    "C-HA0031", "C-HA0052", "C-HA0054", "C-HA0061", "C-HA0094", "C-HA0096", "C-HA0132", "C-HA0251", "C-HAB010",
    "C-HAD006", "C-HAD010", "C-HAF003", "C-HAF007", "C-HAF008", "C-HAI013", "C-HAJ005", "C-HAJ007", "C-HAN009",
    "C-HAN013", "C-HAN015", "C-HAN016", "C-HAP008", "C-HAR024", "C-HAR078", "C-HAS067", "C-HAS069", "C-HAS087",
    "C-HAS109", "C-HE0003", "C-HEI001", "C-HEN013", "C-HER126", "C-HI0003", "C-HI0006", "C-HID013", "C-HID017",
    "C-HIJ009", "C-HIK015", "C-HIK016", "C-HIK024", "C-HIK029", "C-HIL009", "C-HIL010", "C-HIL012", "C-HIL014",
    "C-HJ0022", "C-HJ0029", "C-HJ0631", "C-HN0008", "C-HO0002", "C-HOK004", "C-HR0010", "C-HS0002", "C-HU0008",
    "C-HU0009", "C-HU0012", "C-HUD001", "C-I00001", "C-IBR001", "C-IC0003", "C-ICE001", "C-ICH008", "C-IDA027",
    "C-IDA031", "C-IFA007", "C-IH0001", "C-IIF001", "C-IKR004", "C-IKS001", "C-IL0003", "C-IL0006", "C-IL0039",
    "C-IL0050", "C-IMA001", "C-IMA007", "C-IMA008", "C-IN0006", "C-IN0012", "C-IN0060", "C-INA002", "C-INA123",
    "C-IND067", "C-IND070", "C-IND075", "C-IND434", "C-IND506", "C-INN002", "C-INN003", "C-INT009", "C-INT028",
    "C-INY001", "C-IQ0004", "C-IR0001", "C-IR0003", "C-IR0007", "C-IR0013", "C-IR0051", "C-IRA013", "C-IRE001",
    "C-IRH778", "C-IRI002", "C-IRW004", "C-IS0003", "C-ISH002", "C-ISM012", "C-ISM013", "C-ISR001", "C-IW0001",
    "C-IW0002", "C-IWA007", "C-IZA001", "C-JA0003", "C-JA0011", "C-JA0022", "C-JA0039", "C-JA0064", "C-JAF003",
    "C-JE0001", "C-JE0009", "C-JHO002", "C-JIH001", "C-JLO001", "C-JOH003", "C-JU0001", "C-JU0031", "C-JUF001",
    "C-JUM002", "C-JUM010", "C-JUM016", "C-JUM337", "C-JUR001", "C-JUZ001", "C-JY0001", "C-KA0001", "C-KA0005",
    "C-KA0009", "C-KA0011", "C-KA0019", "C-KA0022", "C-KA0059", "C-KAH003", "C-KAM021", "C-KAM022", "C-KAM024",
    "C-KAN004", "C-KAN122", "C-KAR021", "C-KAR030", "C-KAR036", "C-KAR056", "C-KAU005", "C-KAW003", "C-KAW007",
    "C-KDR001", "C-KE0015", "C-KEA001", "C-KEM016", "C-KEY004", "C-KHA003", "C-KHA025", "C-KHA028", "C-KHA029",
    "C-KHA191", "C-KHA203", "C-KI0036", "C-KIA001", "C-KID001", "C-KIM231", "C-KIO145", "C-KIO607", "C-KOP004",
    "C-KOP044", "C-KOP061", "C-KOP068", "C-KOP069", "C-KOP075", "C-KOP266", "C-KOS003", "C-KOS005", "C-KRI002",
    "C-KU0001", "C-KUA001", "C-KUR014", "C-LA0007", "C-LAD001", "C-LAR009", "C-LAT007", "C-LAU006", "C-LAY002",
    "C-LEE001", "C-LES008", "C-LI0010", "C-LI0049", "C-LI0053", "C-LIS011", "C-LIS015", "C-LIT004", "C-LIZ002",
    "C-LM0001", "C-LO0001", "C-LO0009", "C-LO0019", "C-LU", "C-LU0001", "C-LU0015", "C-LU0020", "C-LUM002", "C-LUM003",
    "C-LUM004", "C-LUT004", "C-LUV0001", "C-M20001", "C-MA0002", "C-MA0006", "C-MA0008", "C-MA0012", "C-MA0022",
    "C-MA0051", "C-MA0056", "C-MA0074", "C-MA0079", "C-MA0099", "C-MA0109", "C-MA0134", "C-MA0156", "C-MA0158",
    "C-MA0229", "C-MA0250", "C-MA0288", "C-MA0345", "C-MAB001", "C-MAC002", "C-MAD011", "C-MAD166", "C-MAI009",
    "C-MAI010", "C-MAI011", "C-MAI013", "C-MAJ001", "C-MAJ006", "C-MAJ010", "C-MAJ015", "C-MAJ016", "C-MAK013",
    "C-MAL010", "C-MAL015", "C-MAL016", "C-MAL023", "C-MAM065", "C-MAM075", "C-MAN001", "C-MAN004", "C-MAN007",
    "C-MAN015", "C-MAN026", "C-MAR017", "C-MAR065", "C-MAR072", "C-MAR078", "C-MAR099", "C-MAS028", "C-MAS099",
    "C-MAT019", "C-MAU003", "C-MAW011", "C-MAW014", "C-MAX003", "C-MAY005", "C-MAY008", "C-MAY017", "C-MAZ001",
    "C-MD0005", "C-ME0002", "C-ME0110", "C-ME0132", "C-MED008", "C-MED009", "C-MEG009", "C-MEG043", "C-MEG052",
    "C-MEI002", "C-MER002", "C-MER015", "C-MER100", "C-MI0002", "C-MI0013", "C-MI0018", "C-MI0019", "C-MI0042",
    "C-MI0045", "C-MI0046", "C-MIA007", "C-MIK002", "C-MIK004", "C-MIL006", "C-MIN007", "C-MIN011", "C-MIN013",
    "C-MIN273", "C-MIR001", "C-MIR009", "C-MIT034", "C-MIT035", "C-MIT037", "C-MIT042", "C-MM0001", "C-MO0015",
    "C-MOM002", "C-MU0013", "C-MU0047", "C-MU0051", "C-MU0132", "C-MU0185", "C-MUL001", "C-MUL013", "C-MUL043",
    "C-MUL062", "C-MUL064", "C-MUL068", "C-MUN010", "C-MUN017", "C-MUR034", "C-MUR035", "C-MUS009", "C-MUT013",
    "C-MUT018", "C-MUT020", "C-MYS001", "C-NA0001", "C-NA0118", "C-NAB011", "C-NAB014", "C-NAB015", "C-NAB019",
    "C-NAB632", "C-NAF006", "C-NAH002", "C-NAI006", "C-NAI009", "C-NAI016", "C-NAJ005", "C-NAJ008", "C-NAN022",
    "C-NAN028", "C-NAN029", "C-NAN033", "C-NAS023", "C-NAS024", "C-NAT003", "C-NAT101", "C-NAU003", "C-NAU011",
    "C-NAV001", "C-NAW003", "C-NE0003", "C-NG0001", "C-NI0008", "C-NI0011", "C-NI0021", "C-NIA019", "C-NIN001",
    "C-NIN009", "C-NIN213", "C-NIR026", "C-NIR029", "C-NIS005", "C-NIY001", "C-NO0003", "C-NON005", "C-NOV009",
    "C-NSP001", "C-NU0016", "C-NU0017", "C-NU0022", "C-NU0023", "C-NU0038", "C-NU0040", "C-NU0066", "C-NU0090",
    "C-NUN006", "C-NUN008", "C-NUR008", "C-NUR095", "C-NUR129", "C-NUR170", "C-NUR184", "C-NUR188", "C-NUR219",
    "C-NUR223", "C-NUR230", "C-NUR247", "C-NUR248", "C-NUR254", "C-NUR709", "C-NUS001", "C-NUS016", "C-NUS190",
    "C-OKT001", "C-OL0006", "C-OMN001", "C-ON0001", "C-ONE004", "C-OR0001", "C-OR0002", "C-ORA003", "C-OSI001",
    "C-PA0002", "C-PA0004", "C-PA0006", "C-PA0039", "C-PA0053", "C-PAK003", "C-PAL011", "C-PAM007", "C-PAM009",
    "C-PAN777", "C-PAR011", "C-PAR013", "C-PE0009", "C-PE0021", "C-PEL018", "C-PIN001", "C-PIN010", "C-PIN124",
    "C-PL0001", "C-PON005", "C-PR0009", "C-PR0015", "C-PRA004", "C-PRI030", "C-PU0007", "C-PU0010", "C-PUT030",
    "C-PUT040", "C-PUT054", "C-PUT062", "C-PUT070", "C-PUT073", "C-PUT074", "C-PUT662", "C-QOL001", "C-QUE003",
    "C-R S001", "C-RA0018", "C-RA0026", "C-RA0043", "C-RA0060", "C-RA0092", "C-RA0103", "C-RA0115", "C-RAD007",
    "C-RAD011", "C-RAF017", "C-RAF052", "C-RAH030", "C-RAH090", "C-RAH091", "C-RAH093", "C-RAH094", "C-RAH104",
    "C-RAH113", "C-RAH133", "C-RAH136", "C-RAH145", "C-RAH147", "C-RAH221", "C-RAH694", "C-RAH695", "C-RAI133",
    "C-RAJ015", "C-RAM033", "C-RAM041", "C-RAM044", "C-RAM046", "C-RAN017", "C-RAN772", "C-RAR004", "C-RAS009",
    "C-RAS012", "C-RAS013", "C-RAT020", "C-RE0002", "C-RE0018", "C-RE0020", "C-RE0035", "C-RE0068", "C-REF002",
    "C-REG001", "C-REJ003", "C-REJ010", "C-REJ011", "C-REJ015", "C-REJ185", "C-REK001", "C-REM011", "C-RES043",
    "C-RES044", "C-RES049", "C-RES072", "C-RES078", "C-RES084", "C-RES085", "C-RES088", "C-RES100", "C-RES383",
    "C-REY003", "C-REY268", "C-REZ049", "C-REZ050", "C-REZ064", "C-REZ071", "C-REZ072", "C-RHA001", "C-RI0003",
    "C-RI0013", "C-RI0029", "C-RI0060", "C-RI0084", "C-RI0088", "C-RI0145", "C-RIA001", "C-RIA039", "C-RIA040",
    "C-RIJ002", "C-RIK005", "C-RIN009", "C-RIN017", "C-RIS024", "C-RIS035", "C-RIS039", "C-RO0006", "C-ROB005",
    "C-ROR001", "C-ROS010", "C-ROS465", "C-RUM008", "C-RUM126", "C-RUS027", "C-S00001", "C-SA0002", "C-SA0006",
    "C-SA0008", "C-SA0019", "C-SA0020", "C-SA0021", "C-SA0022", "C-SA0030", "C-SA0031", "C-SA0038", "C-SA0054",
    "C-SA0061", "C-SA0072", "C-SA0075", "C-SA0082", "C-SA0100", "C-SA0120", "C-SA0122", "C-SA0128", "C-SA0142",
    "C-SA0194", "C-SA0220", "C-SA0242", "C-SAE002", "C-SAF001", "C-SAF0010", "C-SAF014", "C-SAF015", "C-SAF110",
    "C-SAH019", "C-SAH153", "C-SAH164", "C-SAH168", "C-SAH704", "C-SAH705", "C-SAL064B", "C-SAL068", "C-SAL943",
    "C-SAN005", "C-SAN019", "C-SAN033", "C-SAN037", "C-SAR031", "C-SAR032", "C-SAR050", "C-SAY002", "C-SAY004",
    "C-SAY713", "C-SC0004", "C-SD0001", "C-SE0016", "C-SE0035", "C-SE0095", "C-SE0096", "C-SE0131", "C-SED010",
    "C-SEH006", "C-SEJ018", "C-SEL014", "C-SEM023", "C-SEM032", "C-SEM034", "C-SEN033", "C-SEN040", "C-SER002",
    "C-SH0011", "C-SHA011", "C-SI0005", "C-SI0012", "C-SI0020", "C-SI0023", "C-SI0026", "C-SI0030", "C-SI0031",
    "C-SI0052", "C-SI0055", "C-SI0058", "C-SI0107", "C-SI0115", "C-SI0144", "C-SI0155", "C-SI0165", "C-SI0180",
    "C-SI0184", "C-SI0214", "C-SIF003", "C-SIJ001", "C-SIL009", "C-SIN053", "C-SIN132", "C-SIN164", "C-SIN202",
    "C-SIN215", "C-SIN236", "C-SIN701", "C-SIN702", "C-SIN713", "C-SIN714", "C-SIN716", "C-SIN717", "C-SP0001",
    "C-SP0006", "C-SR0026", "C-SS0006", "C-ST0009", "C-ST0028", "C-STA020", "C-STA021", "C-STA042", "C-STA049",
    "C-STA065", "C-STA1000", "C-STA132", "C-STA206", "C-STA467", "C-STA717", "C-STA940", "C-STA953", "C-STA954",
    "C-STE005", "C-SU0018", "C-SU0021", "C-SU0023", "C-SU0024", "C-SU0025", "C-SU0071", "C-SU0093", "C-SU0102",
    "C-SU0111", "C-SU0118", "C-SU0131", "C-SU0139", "C-SU0146", "C-SU0155", "C-SU0169", "C-SU0180", "C-SU0183",
    "C-SU0193", "C-SU0275", "C-SUB005", "C-SUC401", "C-SUK034", "C-SUK241", "C-SUL023", "C-SUM012", "C-SUM028",
    "C-SUM058", "C-SUM066", "C-SUM100", "C-SUM281", "C-SUN103", "C-SUR081", "C-SUR089", "C-SUR095", "C-SUR097",
    "C-SUR098", "C-SWI002", "C-SY0006", "C-SY0014", "C-SYA044", "C-SYA061", "C-SYA644", "C-SYU012", "C-SYU017",
    "C-TA0003", "C-TA0009", "C-TA0042", "C-TA0092", "C-TAK004", "C-TAK007", "C-TAK117", "C-TAM016", "C-TAN005",
    "C-TAN012", "C-TAN017", "C-TAN019", "C-TAQ190", "C-TAS012", "C-TAS110", "C-TER023", "C-TG0002", "C-THN001",
    "C-TI0001", "C-TI0003", "C-TI0010", "C-TI0012", "C-TI0015", "C-TI0036", "C-TIG006", "C-TIG018", "C-TIG022",
    "C-TIG027", "C-TIG100", "C-TIG124", "C-TIK003", "C-TIN005", "C-TIN008", "C-TIN009", "C-TK0005", "C-TK0006",
    "C-TK0022", "C-TK0084", "C-TK0092", "C-TK0099", "C-TK0100", "C-TK0341", "C-TK0361", "C-TK0367", "C-TK0368",
    "C-TO0014", "C-TOA002", "C-TOK015", "C-TOK019", "C-TOK024", "C-TOK031", "C-TOK033ENI", "C-TOK036", "C-TOK037",
    "C-TOK050", "C-TOK057", "C-TOK077", "C-TOK082", "C-TOK087", "C-TOK088", "C-TOK089", "C-TOK097", "C-TOK1000",
    "C-TOK104", "C-TOK113", "C-TOK125", "C-TOK194", "C-TOK214", "C-TOK217", "C-TOK224", "C-TOK262", "C-TOK298",
    "C-TOK304", "C-TOK326", "C-TOK347", "C-TOK356", "C-TOK396", "C-TOK402", "C-TOK543", "C-TOK721", "C-TOK733",
    "C-TOK803", "C-TOK806", "C-TOK842", "C-TOK886", "C-TOK941", "C-TRE001", "C-TRI013", "C-TRI029", "C-TRI031",
    "C-TRI212", "C-TUJ009", "C-TUL001", "C-TUR002", "C-UC0003", "C-UCH001", "C-UD0026", "C-UKM004", "C-UL0001",
    "C-ULI004", "C-UM0004", "C-UMI007", "C-UMM006", "C-UN0009", "C-UPI001", "C-UPP001", "C-UPY001", "C-US0012",
    "C-USM007", "C-UT0013", "C-UTA013", "C-VE0012", "C-VEN002", "C-VEN005", "C-VER007", "C-VI0001", "C-VI0005",
    "C-VI0022", "C-VI0026", "C-VIT001", "C-WA0003", "C-WA0013", "C-WA0023", "C-WA0085", "C-WAH027", "C-WAH029",
    "C-WAH030", "C-WAH031", "C-WAH035", "C-WAH051", "C-WAR008", "C-WAR034", "C-WAW004", "C-WI0001", "C-WI0022",
    "C-WID006", "C-WIL004", "C-WIN013", "C-WIR006", "C-WIS007", "C-YA0002", "C-YA0013", "C-YA0029", "C-YAS006",
    "C-YAS736", "C-YE0008", "C-YEN004", "C-YL0001", "C-YON003", "C-YOS002", "C-YSC001", "C-YU0031", "C-YU0054",
    "C-YUN007", "C-YUR002", "C-YUS015", "C-YUS026", "C-YUS032", "C-ZA0001", "C-ZAH562", "C-ZAK001", "C-ZAR003",
    "C-ZAS003", "C-ZAY001", "C-ZAZ001", "C-ZEB001", "C-ZEE001", "C-ZHA008", "C-ZI0002", "C-ZUH001", "C-ZUN443",
    "CA-APT071", "CA-APT073", "CA-BAJ006", "CA-HJ0019", "CA-LIS007", "CA-MM0014", "CA-SAM021", "CA-SIN141", "CA-SU0302",
    "CA-TK0101", "CA-TK0148", "CA-TK0163", "CA-TK0199", "CA-TK0209", "CA-TK0216", "CA-TK046", "CA-TOK038",
]);

/** Pelanggan divisi Kino ("-KN") yang kode dasarnya outlet hit list. Kode dasar tanpa sufiks atau divisi lain = bukan. */
export function pelangganHitlist(customerNo: unknown): boolean {
    const no = String(customerNo ?? "").trim().toUpperCase();
    return no.endsWith("-KN") && GT_HITLIST_OUTLET.has(no.slice(0, -3));
}

/** Kode barang baris faktur: payload antrean (`itemNo`) atau detail.do Accurate (`item.no`). */
const kodeBarang = (b: { itemNo?: unknown; item?: { no?: unknown } | null }) => String(b.itemNo ?? b.item?.no ?? "").trim().toUpperCase();

/** Isi nota hit list: minimal satu baris, dan SEMUA baris SKU hit list. */
export const isiHitlist = (baris: readonly { itemNo?: unknown; item?: { no?: unknown } | null }[]) =>
    baris.length > 0 && baris.every((b) => GT_HITLIST_SKU.has(kodeBarang(b)));

/** Nota hit list: pelanggan outlet hit list + SEMUA baris SKU hit list. */
export function notaGtHitlist(payload: { customerNo?: unknown; detailItem?: { itemNo?: unknown }[] }): boolean {
    return pelangganHitlist(payload.customerNo) && isiHitlist(payload.detailItem ?? []);
}

/** Satu pesan Accurate = satu klausul. */
const UMUR = /melewati batas piutang\. Ada faktur yang belum dilunasi lebih dari \d+ hari\.?$/;
const NOMINAL = /melewati batas piutang\. Total piutang dan pesanan menjadi lebih dari Rp [\d.,]+\.?$/;
export type TolakBatas = { umur: boolean; nominal: boolean };

/**
 * Penolakan Accurate (JSON daftar teks = `message` classifySaveResponse) yang SEMUA pesannya batas piutang — umur dan/atau nominal.
 * Ada pesan lain (harga, gudang, ...) atau bukan daftar JSON utuh (terpotong 500) = null: gagal-tertutup.
 */
export function tolakBatas(message: string): TolakBatas | null {
    let d: unknown;
    try { d = JSON.parse(message); } catch { return null; }
    if (!Array.isArray(d) || d.length === 0 || !d.every((x) => typeof x === "string")) return null;
    const umur = d.filter((x) => UMUR.test(x.trim())).length, nominal = d.filter((x) => NOMINAL.test(x.trim())).length;
    return umur + nominal === d.length ? { umur: umur > 0, nominal: nominal > 0 } : null;
}

export const gtHitlistMati = () => (process.env.GT_HITLIST_LOLOS || "").trim().toLowerCase() === "mati";

/** Pemeriksaan per satu Kirim/cron: tiap pemeriksaan membaca pelanggan + nota belum lunas; sisanya tetap ditolak, bisa Antre ulang. */
export const MAKS_PERIKSA_PER_KIRIM = 10;
/** Pemeriksaan baru tidak dimulai lewat dari ini sejak Kirim/cron mulai: jendela lepas tidak boleh terpotong batas waktu route (600 dtk). */
export const BATAS_WAKTU_PERIKSA_MS = 240_000;
/** Pelepasan tidak dilakukan lewat dari ini sejak Kirim/cron mulai (pembacaan bisa lambat): sisa waktu cukup untuk kirim ulang + pulih. */
export const BATAS_WAKTU_LEPAS_MS = 420_000;
/** Nota belum lunas lebih dari ini = tidak diperiksa satu per satu (detail.do tiap nota): gagal-tertutup. */
export const MAKS_NOTA_BELUM_LUNAS = 30;

/**
 * Jeda antar-pelepasan: 1 pelepasan (+1 pemulihan) per 7 dtk ~ 17 simpanan pelanggan/menit, di bawah ambang impor massal pengamat
 * Hendra (20/menit, lib/pelanggan-hendra) — simpanan ini tidak boleh membuat edit tangan pelanggan Hendra di menit yang sama
 * dikira impor lalu dikembalikan.
 * ponytail: dicatat per proses Node; beberapa instans aplikasi masing-masing berjeda sendiri.
 */
export const JEDA_LEPAS_MS = 7_000;
let lepasTerakhir = 0;
/** Giliran DIPESAN sebelum menunggu: Kirim dan cron yang bersamaan di satu proses mendapat giliran berbeda, bukan jeda yang sama. */
const jedaLepas = async () => {
    const giliran = Math.max(Date.now(), lepasTerakhir + JEDA_LEPAS_MS);
    lepasTerakhir = giliran;
    const tunggu = giliran - Date.now();
    if (tunggu > 0) await new Promise((r) => setTimeout(r, tunggu));
};

export type PelangganBatas = {
    id: number; customerNo: string; notes: string;
    umurAktif: boolean; umur: number | null; nominalAktif: boolean; nominal: number | null;
};
/** Nota belum lunas pelanggan: tanggal yyyy-MM-dd, sisa = primeOwing (termasuk PPN), hitlist = semua barisnya SKU hit list. */
export type NotaBelumLunas = { nomor: string; tanggal: string; sisa: number; hitlist: boolean };
/** Beban piutang pelanggan: nota belum lunas + total pesanan penjualan Accurate yang belum ditutup (dihitung penuh, semuanya bukan hit list). */
export type Beban = { nota: NotaBelumLunas[]; pesanan: number };
export type Order = { customerNo: string; hitlist: boolean; total: number };
export type Keputusan = { boleh: boolean; alasan: string; lepas: TolakBatas };

const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const umurHari = (tanggal: string, hariIni: string) => Math.floor((Date.parse(`${hariIni}T00:00:00Z`) - Date.parse(`${tanggal}T00:00:00Z`)) / 86_400_000);

/**
 * Keputusan owner 19 Nov 2026 (murni). Nota hit list belum lunas TIDAK ikut menahan, untuk order apa pun:
 * - batas hari (hanya order biasa; order NPL tidak diperiksa — owner 24 Nov 2026): tidak boleh ada nota NON-hit-list belum lunas yang
 *   umurnya (dari tanggal faktur, >= N hari — lebih ketat dari Accurate) sudah mencapai batas;
 * - batas nominal: piutang NON-hit-list + pesanan terbuka + order <= limit. Angka yang tidak terbaca (NaN) = ditahan.
 * Yang dilepas hanya batas yang disebut Accurate; batas lain tetap diperiksa Accurate sendiri saat kirim ulang.
 */
export function putuskan(p: PelangganBatas, beban: Beban, order: Order, tolak: TolakBatas, hariIni: string): Keputusan {
    const { nota, pesanan } = beban;
    const tidak = (alasan: string) => ({ boleh: false, alasan, lepas: tolak });
    if (tolak.umur && !p.umurAktif) return tidak("Accurate menolak batas hari, tetapi batas hari pelanggan terbaca tidak tercentang");
    if (tolak.nominal && !p.nominalAktif) return tidak("Accurate menolak batas nominal, tetapi limit piutang terbaca tidak tercentang");
    // Owner 24 Nov 2026: order NPL (nota hit list) tidak ditahan batas hari sama sekali, walau nota biasa sudah lewat; order biasa tetap.
    if (p.umurAktif && !order.hitlist) {
        const lewat = nota.filter((n) => !n.hitlist && !(umurHari(n.tanggal, hariIni) < (p.umur ?? 0)));
        if (lewat.length) return tidak(`nota bukan hit list belum lunas sudah ${p.umur} hari: ${lewat.map((n) => n.nomor).join(", ")}`);
    }
    if (p.nominalAktif) {
        const piutang = nota.filter((n) => !n.hitlist).reduce((s, n) => s + n.sisa, 0);
        if (!(piutang + pesanan + order.total <= (p.nominal ?? 0))) {
            return tidak(`piutang di luar hit list ${rupiah(piutang)}${pesanan ? ` + pesanan terbuka ${rupiah(pesanan)}` : ""} + order ${rupiah(order.total)}`
                + ` melewati limit ${rupiah(p.nominal ?? 0)}`);
        }
    }
    const hl = nota.filter((n) => n.hitlist);
    return { boleh: true, lepas: tolak, alasan: `batas ${[tolak.umur && "hari", tolak.nominal && "nominal"].filter(Boolean).join(" + ")} dilepas sementara`
        + ` (${order.hitlist ? "nota hit list, batas hari tidak berlaku" : "nota bukan hit list"}; ${hl.length} nota hit list belum lunas ${rupiah(hl.reduce((s, n) => s + n.sisa, 0))} tidak dihitung)` };
}

export type DepsLolos<T> = {
    /** Pelanggan dengan customerNo PERSIS; null = tidak ada atau lebih dari satu. Melempar = tidak terbaca. */
    baca(customerNo: string): Promise<PelangganBatas | null>;
    /** Nota belum lunas + pesanan terbuka pelanggan; null = terlalu banyak / terpotong. Melempar = tidak terbaca. */
    beban(customerId: number): Promise<Beban | null>;
    /** customer/save.do; melempar bila Accurate tidak menjawab s:true. */
    tulis(payload: Record<string, unknown>): Promise<void>;
    /** Kirim ulang faktur yang sama (satu kali). */
    kirimUlang(): Promise<T>;
    /** Jeda sebelum melepas (bawaan: JEDA_LEPAS_MS antar-pelepasan). */
    jeda?(): Promise<void>;
    /** Tanggal hari ini yyyy-MM-dd (bawaan: WITA). */
    hariIni?: string;
    /** Tenggat pelepasan (epoch ms): lewat = tidak dilepas, order tetap ditolak. */
    tenggatLepas?: number;
};
export type HasilLolos<T> = {
    dicoba: boolean; alasan: string; hasil?: T; lepas?: TolakBatas; asal?: Pick<PelangganBatas, "umur" | "nominal">;
    dipulihkan?: boolean; galatPulih?: string;
};

const pesan = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hariIniWita = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

/**
 * Baca pelanggan + nota belum lunas -> putuskan -> lepas batas yang disebut Accurate -> kirim ulang SEKALI -> pulihkan. Pemulihan
 * BACA DULU: sudah tercentang (oleh kita, alat luar, atau petugas — nilainya tidak ditimpa) = selesai; belum = tulis centang + nilai
 * asal, baca lagi; maksimal dua tulisan. Pelepasan yang gagal di tengah (timeout = MUNGKIN diterapkan belakangan) dipulihkan dengan
 * MENULIS dulu. Log `[gt-hitlist]` SEBELUM melepas: proses yang mati di jendela itu tetap meninggalkan jejak di log container (tabel
 * event sengaja tidak diberi jenis baru — itu migrasi skema).
 */
export async function lolosBatasPiutang<T>(order: Order, tolak: TolakBatas, deps: DepsLolos<T>): Promise<HasilLolos<T>> {
    const no = order.customerNo;
    if (isPelangganTerlindungi(no)) return { dicoba: false, alasan: "toko NKA/DC terlindungi tidak disentuh" };
    let p: PelangganBatas | null;
    try { p = await deps.baca(no); } catch (e) { return { dicoba: false, alasan: `pelanggan tidak terbaca: ${pesan(e)}` }; }
    if (!p) return { dicoba: false, alasan: "pelanggan tidak ditemukan tepat satu" };
    if (isCatatanHendra(p.notes)) return { dicoba: false, alasan: "catatan Hendra: sistem tidak mengubah pelanggan ini" };
    let beban: Beban | null;
    try { beban = await deps.beban(p.id); } catch (e) { return { dicoba: false, alasan: `nota/pesanan belum lunas tidak terbaca: ${pesan(e)}` }; }
    if (!beban) return { dicoba: false, alasan: `nota belum lunas lebih dari ${MAKS_NOTA_BELUM_LUNAS} atau pesanan terlalu banyak; tidak diperiksa` };
    const k = putuskan(p, beban, order, tolak, deps.hariIni ?? hariIniWita());
    if (!k.boleh) return { dicoba: false, alasan: k.alasan };
    const asal = p, lepas = k.lepas;

    const tercentang = (c: PelangganBatas) => (!lepas.umur || c.umurAktif) && (!lepas.nominal || c.nominalAktif);
    const pulihkan = async (tulisDulu: boolean) => {
        let galat = "";
        for (let tulisan = 0; ; tulisan++) {
            if (!tulisDulu || tulisan > 0) {
                try {
                    const cek = await deps.baca(no);
                    if (cek && tercentang(cek)) return { ok: true, galat: "" };
                    galat = cek ? "batas masih tidak tercentang" : "pelanggan tidak terbaca ulang";
                } catch (e) {
                    galat = pesan(e);
                }
                if (tulisan === 2) break;
            }
            try {
                await deps.tulis({
                    id: asal.id,
                    ...(lepas.umur ? { customerLimitAge: true, ...(asal.umur === null ? {} : { customerLimitAgeValue: asal.umur }) } : {}),
                    ...(lepas.nominal ? { customerLimitAmount: true, ...(asal.nominal === null ? {} : { customerLimitAmountValue: asal.nominal }) } : {}),
                });
            } catch (e) {
                galat = pesan(e);
            }
        }
        console.error(`[gt-hitlist] ${no}: batas (hari ${asal.umur ?? "-"}, limit ${asal.nominal ?? "-"}) GAGAL dipulihkan (${galat}) — centang ulang di Accurate`);
        return { ok: false, galat };
    };

    const hasilDasar = { lepas, asal: { umur: asal.umur, nominal: asal.nominal } };
    await (deps.jeda ?? jedaLepas)();
    if (deps.tenggatLepas !== undefined && Date.now() > deps.tenggatLepas) {
        return { dicoba: false, alasan: "waktu kiriman ini hampir habis sebelum batas dilepas; Antre ulang lalu Kirim lagi" };
    }
    console.warn(`[gt-hitlist] ${no}: ${k.alasan}`);
    try {
        await deps.tulis({ id: asal.id, ...(lepas.umur ? { customerLimitAge: false } : {}), ...(lepas.nominal ? { customerLimitAmount: false } : {}) });
    } catch (e) {
        const pulih = await pulihkan(true);
        return { dicoba: false, alasan: `gagal melepas batas: ${pesan(e)}`, ...hasilDasar, dipulihkan: pulih.ok, galatPulih: pulih.galat };
    }
    let hasil: T | undefined;
    let galatKirim: unknown;
    try { hasil = await deps.kirimUlang(); } catch (e) { galatKirim = e ?? new Error("kirim ulang gagal"); }
    const pulih = await pulihkan(false);
    if (pulih.ok) console.warn(`[gt-hitlist] ${no}: batas dipulihkan`);
    if (galatKirim !== undefined) throw galatKirim;
    return { dicoba: true, alasan: k.alasan, hasil, ...hasilDasar, dipulihkan: pulih.ok, galatPulih: pulih.galat };
}

const angka = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const benar = (v: unknown) => v === true || v === "true";
/** "19/11/2026" -> "2026-11-19"; bentuk lain = melempar (umur nota tidak boleh ditebak). */
const tanggalIso = (v: unknown) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? "").trim());
    if (!m) throw new Error(`tanggal faktur tidak terbaca: ${String(v)}`);
    return `${m[3]}-${m[2]}-${m[1]}`;
};

/**
 * Jeda antar-baca Accurate jalur ini: Accurate menolak lebih dari 8 request/detik per token ("Jumlah request API melebihi toleransi"),
 * dan token yang sama dipakai halaman lain. Penolakan itu = s:false = tidak terbaca = gagal-tertutup (order tetap ditolak), jadi jeda
 * hanya mencegah penahanan yang tidak perlu. ponytail: per proses; lalu lintas lain dengan token yang sama tidak ikut dihitung.
 */
export const JEDA_BACA_MS = 200;
let bacaTerakhir = 0;
/** Jawaban batas laju Accurate (s:false): permintaan TIDAK diproses — aman diulang sekali sesudah jeda. Terbukti 19 Nov 2026. */
export const KENA_BATAS_LAJU = /melebihi toleransi/i;
const JEDA_ULANG_MS = 1_500;
const tidur = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pembaca + penulis Accurate dengan sesi pengirim faktur (pelanggan: list.do kode persis -> detail.do; nota & pesanan: list.do + detail.do). */
export function pelangganAccurate(target: AccurateTarget): Pick<DepsLolos<unknown>, "baca" | "beban" | "tulis"> {
    const bacaLangsung = bacaAccurate(target);
    const baca: typeof bacaLangsung = async (...arg) => {
        const giliran = Math.max(Date.now(), bacaTerakhir + JEDA_BACA_MS);
        bacaTerakhir = giliran;
        if (giliran > Date.now()) await tidur(giliran - Date.now());
        const r = await bacaLangsung(...arg);
        if (r?.s !== false || !KENA_BATAS_LAJU.test(JSON.stringify(r.d ?? ""))) return r;
        await tidur(JEDA_ULANG_MS);
        return bacaLangsung(...arg);
    };
    /** Satu halaman list.do yang LENGKAP: pageCount wajib angka; lebih dari satu halaman = null (tidak ditebak). */
    const satuHalaman = async (path: string, query: Record<string, unknown>) => {
        const r = await baca(path, "GET", { ...query, "sp.pageSize": 100 });
        const halaman = Number(r?.sp?.pageCount), baris = Number(r?.sp?.rowCount);
        if (r?.s !== true || !Array.isArray(r.d) || !Number.isFinite(halaman)) throw new Error(`${path} gagal atau tanpa jumlah halaman`);
        if (halaman > 1 || (Number.isFinite(baris) && baris !== r.d.length)) return null;
        return r.d as Record<string, unknown>[];
    };
    return {
        baca: async (customerNo) => {
            const no = customerNo.trim().toUpperCase();
            const r = await baca("/api/customer/list.do", "GET", {
                fields: "id,customerNo", "filter.keywords.op": "CONTAIN", "filter.keywords.val[0]": no, "sp.pageSize": 100,
            });
            if (r?.s !== true || !Array.isArray(r.d)) throw new Error("customer/list.do gagal");
            const cocok = (r.d as Record<string, unknown>[]).filter((x) => String(x?.customerNo ?? "").trim().toUpperCase() === no);
            if (cocok.length !== 1) return null;
            const det = await baca("/api/customer/detail.do", "GET", { id: cocok[0].id });
            const d = det?.d as Record<string, unknown> | undefined;
            if (det?.s !== true || !d || String(d.customerNo ?? "").trim().toUpperCase() !== no) throw new Error("customer/detail.do gagal");
            const id = Number(d.id);
            if (!Number.isInteger(id) || id <= 0 || id !== Number(cocok[0].id)) throw new Error("customer/detail.do: id tidak cocok");
            return {
                id, customerNo: String(d.customerNo), notes: String(d.notes ?? ""),
                umurAktif: benar(d.customerLimitAge), umur: angka(d.customerLimitAgeValue),
                nominalAktif: benar(d.customerLimitAmount), nominal: angka(d.customerLimitAmountValue),
            };
        },
        // Bentuk kueri sama dengan lib/form-kontrol/nota-db (filter.customerId EQUAL + outstandingFilter terbukti di produksi). Retur (RJN,
        // primeOwing minus) tidak dikurangkan: piutang terhitung lebih besar = lebih ketat.
        beban: async (customerId) => {
            const milik = (x: Record<string, unknown>) => {
                const c = x.customer as { id?: unknown } | null | undefined;
                return c?.id == null || Number(c.id) === customerId;
            };
            const faktur = await satuHalaman("/api/sales-invoice/list.do", {
                fields: "id,number,transDate,primeOwing,customer", "filter.customerId.op": "EQUAL", "filter.customerId.val": customerId,
                outstandingFilter: "true",
            });
            if (!faktur) return null;
            const baris = faktur.filter(milik).filter((x) => {
                const sisa = Number(x.primeOwing);
                if (x.primeOwing === null || x.primeOwing === undefined || x.primeOwing === "" || !Number.isFinite(sisa)) {
                    throw new Error(`sisa faktur ${String(x.number)} tidak terbaca: ${String(x.primeOwing)}`);
                }
                return sisa > 0.5;
            });
            if (baris.length > MAKS_NOTA_BELUM_LUNAS) return null;
            const nota: NotaBelumLunas[] = [];
            for (const x of baris) {
                const det = await baca("/api/sales-invoice/detail.do", "GET", { id: x.id });
                const items = det?.d?.detailItem;
                if (det?.s !== true || !Array.isArray(items)) throw new Error(`sales-invoice/detail.do ${String(x.number)} gagal`);
                nota.push({ nomor: String(x.number ?? x.id), tanggal: tanggalIso(x.transDate), sisa: Number(x.primeOwing), hitlist: isiHitlist(items) });
            }
            // Pesanan penjualan Accurate yang belum ditutup ikut "Total piutang dan pesanan"; dihitung PENUH (yang sudah sebagian
            // difakturkan ikut terhitung dua kali = lebih ketat). Status selain CLOSED dianggap terbuka.
            const pesanan = await satuHalaman("/api/sales-order/list.do", {
                fields: "id,number,status,totalAmount,customer", "filter.customerId.op": "EQUAL", "filter.customerId.val": customerId,
                "filter.status.op": "NOT_EQUAL", "filter.status.val": "CLOSED",
            });
            if (!pesanan) return null;
            let totalPesanan = 0;
            for (const x of pesanan.filter(milik)) {
                if (String(x.status ?? "").toUpperCase() === "CLOSED") continue;
                const nilai = Number(x.totalAmount);
                if (x.totalAmount === null || x.totalAmount === undefined || x.totalAmount === "" || !Number.isFinite(nilai)) {
                    throw new Error(`nilai pesanan ${String(x.number)} tidak terbaca: ${String(x.totalAmount)}`);
                }
                totalPesanan += nilai;
            }
            return { nota, pesanan: totalPesanan };
        },
        tulis: async (payload) => {
            for (let coba = 0; ; coba++) {
                const r = await forwardAccurate(target, "/api/customer/save.do", "POST", payload);
                let s: unknown;
                try { s = (JSON.parse(r.text) as { s?: unknown })?.s; } catch { /* bukan JSON = gagal */ }
                if (r.status >= 200 && r.status < 300 && s === true) return;
                // Hanya penolakan batas laju (s:false, tidak diproses) yang diulang; jawaban lain = melempar seperti biasa.
                if (coba === 0 && s === false && KENA_BATAS_LAJU.test(r.text)) { await tidur(JEDA_ULANG_MS); continue; }
                throw new Error(`customer/save.do HTTP ${r.status}: ${r.text.slice(0, 200)}`);
            }
        },
    };
}
