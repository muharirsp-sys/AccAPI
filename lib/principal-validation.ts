/*
 * Tujuan: Validasi tahap 1 baris laporan principal — item, harga, dan pecahan diskon.
 * Caller: app/api/principal-order/validate.
 * Dependensi: tidak ada. Main Functions: splitDiscounts, checkLine, TOLERANCE.
 * Side Effects: Tidak ada — murni, tanpa DB dan tanpa jaringan.
 *
 * Kembaran Python-nya `python_backend/kino_discount.py` menangani jalur promo/Summary.
 * Yang di sini hanya pecahan per POSISI, yang memang juga dibutuhkan tampilan; aturan promo
 * (aturan terbit dari surat) tetap tinggal di mesin Python dan dipanggil terpisah.
 */

/** Posisi kolom DISC_n menentukan siapa menanggung. Dibuktikan dari data ALFAMART 2026-09-03. */
export const OWNER: Record<number, "distributor" | "principal"> = { 1: "distributor", 2: "distributor", 3: "distributor", 4: "principal", 5: "principal" };

/** Rp 1 per baris; hanya menyerap pembulatan, bukan selisih aturan. Ditetapkan pengguna. */
export const TOLERANCE = 1;

/**
 * Toleransi POTONGAN TINGKAT NOTA: Rp 100 (keputusan pengguna 2026-09-16).
 *
 * Manfaat tingkat nota nominalnya bulat di surat (Rp 60.000), tetapi sampai ke faktur setelah
 * dibagi rata ke tiap baris, dibulatkan per baris, lalu dikalikan PPN. Sisa desimalnya menumpuk
 * dan berhenti di belasan rupiah — TK RAMADHANI COS: Rp 60.017,99 lawan Rp 60.000, selisih
 * Rp 17,99 dari nota Rp 4,2 juta.
 *
 * Toleransi Rp 1 per baris tidak cukup menampungnya dan menuduh klaim yang benar. Rp 100 masih
 * jauh di bawah beda tier terkecil (Rp 20.000), jadi ia tidak bisa menyembunyikan tier yang
 * salah — yang disembunyikannya hanya koma-koma pembulatan, dan itu memang yang dimaksud.
 */
export const TOLERANSI_NOTA = 100;

export type DiscountAt = {
    position: number;
    percent: number;
    /**
     * Rupiah asli bila kolom DISC_n memuat NOMINAL, bukan persen (potongan tingkat faktur yang
     * dibagi rata ke baris — program MSG). `percent` tetap diisi dengan nilai SETARA supaya
     * seluruh hitungan di hilir tidak berubah; `amount` yang dipakai saat menyusun faktur,
     * karena membulatkan ulang dari persen bisa meleset beberapa rupiah dari yang dilaporkan.
     */
    amount?: number;
    /**
     * Posisi yang DILAPORKAN principal, bila `position` sudah dipindah ke posisi tarif outlet
     * (lihat `keposisiTarif`). Kosong = posisinya memang apa adanya dari laporan.
     */
    reportPosition?: number;
};

export type Split = { distributor: number; principal: number; unowned: number; total: number };

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Diskon bertingkat: tiap posisi memotong SISA, bukan bruto.
 * Dibuktikan dengan ALFAMART: 4% lalu 2,25% atas Rp 345.945,95 = Rp 21.310,27, sama persis
 * dengan TOTAL_DISC yang dilaporkan Kino. Menjumlahkan 6,25% memberi Rp 21.621,62.
 */
export function splitDiscounts(gross: number, discounts: DiscountAt[]): Split {
    let remaining = gross;
    const bucket: Split = { distributor: 0, principal: 0, unowned: 0, total: 0 };
    for (const { position, percent } of [...discounts].sort((a, b) => a.position - b.position)) {
        const amount = cents(remaining * percent / 100);
        remaining -= amount;
        bucket[OWNER[position] ?? "unowned"] += amount;
        bucket.total += amount;
    }
    for (const key of Object.keys(bucket) as (keyof Split)[]) bucket[key] = cents(bucket[key]);
    return bucket;
}

export type LineInput = {
    productCode: string;
    itemCode: string | null;
    itemExists: boolean;
    customerCode: string;
    customerNo: string | null;
    customerExists: boolean;
    salesmanCode: string;
    salesmanInternal: string | null;
    unit: string;
    knownUnits: string[];
    price: number;
    expectedPrice: number | null;
    /**
     * Berapa satuan terkecil dalam satu baris faktur (ISI), bila barisnya dinaikkan ke KRT.
     * 1 = baris masih dalam satuan terkecil. Dipakai HANYA untuk toleransi harga.
     */
    unitRatio?: number;
    gross: number;
    reportDiscount: number;
    discounts: DiscountAt[];
    bonus: boolean;
    /** Aturan terbit yang berlaku untuk BARANG ini pada tanggal SO-nya. */
    rules: PublishedRule[];
    /**
     * Diisi bila klaim principal pada SO ini sudah dijelaskan aturan tingkat FAKTUR
     * (lihat checkSoPromo). Baris tidak perlu punya aturannya sendiri.
     */
    fakturPromo?: string;
    /**
     * Diisi bila baris BONUS ini melewati kuota kelompoknya (lihat `bonusQuota`). Isinya
     * kalimat sebabnya, dan barisnya ditahan — aturan bonus menyatakan "setiap 30 pcs", jadi
     * bonus yang tidak punya pembeliannya bukan bonus, ia barang yang keluar tanpa dasar.
     */
    bonusOverQuota?: string;
    /**
     * Channel outlet menurut MASTER Accurate (lihat `channelOutlet`). Kosong = kategorinya
     * belum diisi di master, dan aturan ber-channel tidak akan berlaku untuknya.
     */
    outletChannel?: string;
    /** Channel yang DIKATAKAN laporan principal ("General Trade"/"Modern Trade"). */
    reportChannel?: string;
    /**
     * Sebab-sebab aturan yang SEBENARNYA ADA untuk barang ini tidak ikut dinilai: channelnya
     * tidak cocok, atau daftar pesertanya kosong. Tanpa ini, barisnya tertahan dengan tuduhan
     * "potongan tidak punya aturan" — tuduhan yang salah alamat, karena aturannya ada.
     */
    terhalang?: string[];
};

export type LineCheck = { status: "ok" | "review"; findings: string[]; split: Split };

/**
 * Satu aturan promo terbit (`promo_rule`), sudah disaring per tanggal oleh pemanggil.
 * `itemCode` kosong = aturan tingkat FAKTUR (berlaku semua barang), mis. program MSG.
 */
export type PublishedRule = {
    suratProgram: string;
    promoGroup: string;
    itemCode: string;
    /** Kosong = berlaku semua pelanggan. Terisi = tarif Discount Reguler milik satu outlet. */
    customerCode: string;
    tierNo: number;
    /** Masa berlaku; kosong = berlaku kapan pun. Dibandingkan dengan tanggal SO barisnya. */
    periodStart?: string | null;
    periodEnd?: string | null;
    /** Ambang pemicu; `triggerUnit` RP = nilai belanja, selain itu jumlah barang. */
    triggerQty: number;
    triggerUnit: string;
    benefitType: string;
    benefitValue: string;
    benefitBeban: string;
    /** Daftar outlet peserta; kosong = berlaku semua outlet. Lihat `outletAllowed`. */
    outletList?: string;
    /**
     * Channel yang disebut surat: "GT", "MT", "ALL", atau kosong. Dicocokkan dengan channel
     * OUTLET yang diturunkan dari master Accurate — lihat `channelOutlet` dan `channelAllowed`.
     */
    channel?: string;
    /** INCLUDE = hanya peserta daftar; EXCLUDE = semua kecuali peserta. */
    outletListMode?: string;
};

/**
 * PPN yang dipakai membandingkan potongan tingkat faktur. Surat program menulis manfaatnya
 * dalam rupiah TERMASUK PPN (Rp 20.000), sedangkan laporan principal membawa DPP (18.016,22).
 * Dibuktikan pengguna 2026-09-12: 18.016,22 x 1,11 = 19.998 — beda Rp 2 dari Rp 20.000.
 */
export const PPN = 0.11;

/**
 * Aturan per BARANG yang menjelaskan potongan pada satu baris, atau null.
 * Dipakai dua kali dan harus memberi jawaban yang sama di keduanya: oleh checkLine untuk
 * memutuskan barisnya, dan oleh pemanggil untuk menghitung SISA klaim yang belum dijelaskan
 * sebelum aturan tingkat faktur ditanya.
 *
 * Dicocokkan **per POSISI, bukan pada jumlahnya** — sama seperti tarif outlet. Menjumlahkan
 * lebih dulu membuat 3% di satu kolom plus 2% di kolom lain lolos hanya karena kebetulan ada
 * satu aturan bernilai 5%, padahal itu bisa dua program yang berbeda dan salah satunya tidak
 * punya dasar. Baris yang dipotong di dua kolom sementara hanya satu punya aturannya tetap
 * ditahan: separuh penjelasan bukan penjelasan.
 *
 * Dibandingkan pada PERSEN, bukan rupiahnya: rupiah ikut berubah oleh diskon yang memotong
 * lebih dulu di rantai yang sama.
 */
export function matchItemRule(
    discounts: DiscountAt[],
    rules: PublishedRule[],
    itemCode?: string | null,
    owner: "principal" | "distributor" = "principal",
): PublishedRule | null {
    const worn = discounts.filter((entry) => OWNER[entry.position] === owner && entry.percent > 0);
    if (worn.length === 0) return null;
    const beban = owner === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
    const cocok: PublishedRule[] = [];
    for (const entry of worn) {
        const rule = rules.find((candidate) => candidate.itemCode && candidate.benefitType === "DISC_PCT"
            // BEBAN ikut dicocokkan: aturan principal tidak boleh membenarkan potongan yang duduk
            // di posisi distributor, dan sebaliknya. Posisi menyatakan siapa yang DIMAKSUD
            // menanggung; aturan menyatakan apakah maksud itu sah.
            && candidate.benefitBeban === beban
            // Pemanggil memang sudah menyaring per barang, tetapi disaring lagi di sini: aturan
            // milik barang LAIN yang kebetulan ikut terbawa tidak boleh meloloskan baris ini.
            && (!itemCode || candidate.itemCode === itemCode)
            && Math.abs(cents(Number(candidate.benefitValue) - entry.percent)) <= 0.01);
        if (!rule) return null;
        cocok.push(rule);
    }
    return cocok[0];
}

/** Baris BONUS: TEPAT satu potongan, dan potongan itu 100%. Satu predikat untuk semua jalur. */
/**
 * Baris BONUS. Suratnya menulis "setiap pembelian 30 PCS mendapat BONUS 1 PCS produk dengan
 * harga yang sama" (`BONUS_QTY`), tetapi faktur maupun laporan principal mencatatnya sebagai
 * baris tambahan berharga penuh lalu DIPOTONG 100% — satu-satunya potongan pada baris itu.
 * Tidak ada pencocokan persen yang bisa menemukannya: manfaatnya "1 PCS", bukan "100%".
 *
 * Bebannya PRINCIPAL sesuai bunyi suratnya, MESKI 100%-nya duduk di posisi 1 alias kolom
 * distributor. Posisi hanya menyatakan siapa yang DIMAKSUD menanggung; di sini suratnya yang
 * menyatakannya, dan surat lebih kuat daripada letak kolom (keputusan pengguna 2026-09-15).
 *
 * Syaratnya sengaja sempit — TEPAT SATU potongan dan tepat 100%. Baris yang dipotong 100%
 * bersama potongan lain bukan baris bonus; itu keadaan yang belum pernah ada dan tidak boleh
 * lolos hanya karena mirip.
 *
 * Pemanggil WAJIB sudah menyaring `rules` ke tanggal barisnya.
 */
export function isBonusLine(discounts: DiscountAt[]): boolean {
    const worn = discounts.filter((entry) => entry.percent > 0);
    return worn.length === 1 && Math.abs(cents(worn[0].percent - 100)) <= 0.01;
}

export function matchBonusRule<T extends { itemCode: string; customerCode: string; benefitType: string }>(
    discounts: DiscountAt[], rules: T[], itemCode?: string | null,
): T | null {
    if (!isBonusLine(discounts)) return null;
    return rules.find((rule) => rule.benefitType === "BONUS_QTY" && !rule.customerCode
        && rule.itemCode && (!itemCode || rule.itemCode === itemCode)) ?? null;
}

/**
 * Outlet ini termasuk yang dimaksud aturannya?
 *
 * Surat program tidak hanya menyebut barang, ia juga menyebut PESERTA — dan menyebutnya ke
 * dua arah: BP2609007713 dan BP2609007664 berlaku "KHUSUS CHANNEL GT PESERTA LOYALTY",
 * sedangkan BP2609006016 (MSG) berlaku "EXCLUDE LOYALTY DAN CONTRACTUAL". Satu daftar yang
 * sama, dua arah. Karena itu aturan MENUNJUK daftar, tidak menyalin isinya.
 *
 * `lists`: nama daftar (huruf besar) -> kode internal anggotanya yang berlaku pada tanggal
 * baris ini. Pemanggil yang menyaring periodenya, sama seperti `berlakuPada` untuk aturan.
 *
 * Kode pada faktur membawa akhiran cabang (`C-WIN013-KN`) sedangkan daftarnya menyimpan kode
 * internal (`C-WIN013`), jadi dicocokkan dengan AWALAN yang dipenggal di tanda hubung —
 * bukan sembarang awalan: `C-WIN01` tidak boleh ikut mengesahkan `C-WIN013`.
 *
 * GAGAL TERTUTUP: daftar yang namanya tidak dikenali membuat aturannya TIDAK berlaku, bukan
 * berlaku untuk semua. Satu salah ketik nama daftar yang lalu menahan semuanya masih bisa
 * dilihat dan diperbaiki; satu salah ketik yang diam-diam meloloskan semuanya tidak.
 */
export function outletAllowed(
    rule: { outletList?: string; outletListMode?: string },
    customerNo: string | null | undefined,
    lists: Map<string, Set<string>>,
): boolean {
    const nama = String(rule.outletList ?? "").trim().toUpperCase();
    if (!nama) return true;
    // BEBERAPA DAFTAR SEKALIGUS, dipisah koma. Surat MSG berbunyi "EXCLUDE LOYALTY DAN
    // CONTRACTUAL" — dua kelas outlet, satu aturan. Sebelum ini `bridgeRows` menolak program
    // semacam itu karena satu baris `promo_rule` hanya punya satu `outlet_list`; kolomnya
    // sendiri teks, jadi gabungannya dibaca DI SINI dan tabelnya tidak perlu berubah.
    //
    // Gabungannya UNION: peserta salah satu daftar = peserta. Untuk EXCLUDE itu berarti
    // dikecualikan bila ia ada di daftar mana pun — persis arti "exclude A dan B".
    // DAFTAR YANG BELUM DIUNGGAH DILEWATI, SELAMA MASIH ADA YANG TERISI.
    //
    // Keputusan pengguna 18 Sep 2026: "kalau ada dua exclude, hanya exclude yang sudah ada
    // listnya saja". Surat MSG berbunyi "exclude LOYALTY DAN CONTRACTUAL" sementara CONTRACTUAL
    // belum pernah diunggah; menahan seluruh programnya berarti tidak seorang pun menerima
    // potongan yang memang dijanjikan surat, padahal LOYALTY-nya sudah diketahui.
    //
    // HARGANYA, dan ini disengaja: outlet CONTRACTUAL akan ikut menerima potongan sampai
    // daftarnya diunggah. Karena itu nama yang dilewati TIDAK didiamkan — `daftarKosong`
    // tetap melaporkannya supaya orang tahu daftar mana yang masih hilang.
    const daftar = nama.split(",").map((x) => x.trim()).filter(Boolean);
    const anggota = new Set<string>();
    for (const satu of daftar) {
        const isi = lists.get(satu);
        if (!isi || isi.size === 0) continue;
        for (const kode of isi) anggota.add(kode);
    }
    // DAFTAR KOSONG PADA TANGGAL ITU: aturannya tidak berlaku, apa pun arahnya.
    //
    // Untuk INCLUDE itu sudah jelas sejak awal — tidak ada peserta berarti tidak ada yang
    // berhak. Untuk EXCLUDE dulu justru sebaliknya: tidak ada yang dikecualikan dibaca sebagai
    // "berlaku untuk semua", dan itu GAGAL TERBUKA. Nama daftar yang salah ketik satu huruf,
    // atau keanggotaan kuartal berikutnya yang belum diunggah, akan memberi potongan kepada
    // outlet yang justru dikecualikan suratnya — tanpa galat apa pun.
    //
    // Daftar kosong bukan berarti "tidak ada yang dikecualikan"; ia berarti KITA TIDAK TAHU
    // siapa yang dikecualikan. Yang tidak diketahui ditahan, bukan diloloskan.
    if (anggota.size === 0) return false;
    const no = String(customerNo ?? "").trim().toUpperCase();
    const peserta = Boolean(no) && [...anggota].some((kode) => no === kode || no.startsWith(`${kode}-`));
    return String(rule.outletListMode ?? "").trim().toUpperCase() === "EXCLUDE" ? !peserta : peserta;
}

/**
 * Nama daftar yang DITUNJUK aturan tetapi kosong pada tanggal itu.
 *
 * Dipakai memberi tahu manusia SEBABNYA, bukan sekadar menahan barisnya. Baris yang tertahan
 * karena daftarnya kosong akan terbaca sebagai "potongan tanpa aturan" — tuduhan yang salah
 * alamat, dan yang membacanya akan mencari kesalahan di tempat yang keliru.
 */
export function daftarKosong(
    rules: { outletList?: string; outletListMode?: string; suratProgram?: string }[],
    lists: Map<string, Set<string>>,
): string[] {
    // Akibatnya kini ADA DUA, dan pesannya harus menyebut yang benar. Bila aturan itu masih
    // punya daftar lain yang terisi, daftar yang kosong DILEWATI dan aturannya tetap berjalan —
    // menulis "barisnya ditahan" di situ akan menyuruh orang mencari masalah yang tidak ada,
    // dan menyembunyikan masalah yang nyata: ada outlet yang belum dikecualikan.
    const kurang = new Map<string, { surat: Set<string>; dilewati: boolean }>();
    for (const rule of rules) {
        const nama = String(rule.outletList ?? "").trim().toUpperCase();
        if (!nama) continue;
        const daftar = nama.split(",").map((x) => x.trim()).filter(Boolean);
        const adaYangTerisi = daftar.some((satu) => (lists.get(satu)?.size ?? 0) > 0);
        // Disebut SATU PER SATU: aturan yang menunjuk "LOYALTY,CONTRACTUAL" dan kehilangan
        // salah satunya harus menyebut yang HILANG, bukan pasangannya.
        for (const satu of daftar) {
            if ((lists.get(satu)?.size ?? 0) > 0) continue;
            if (!kurang.has(satu)) kurang.set(satu, { surat: new Set(), dilewati: false });
            const catatan = kurang.get(satu)!;
            catatan.surat.add(String(rule.suratProgram ?? "").trim() || "(tanpa surat)");
            if (adaYangTerisi) catatan.dilewati = true;
        }
    }
    return [...kurang].map(([nama, { surat, dilewati }]) =>
        `Daftar outlet "${nama}" tidak punya anggota pada tanggal ini, jadi aturan ${[...surat].sort().join(", ")} `
        + (dilewati
            ? "BERJALAN TANPA daftar itu — outlet yang seharusnya masuk daftar ini belum diperlakukan berbeda. "
            : "tidak berlaku untuk siapa pun dan barisnya ditahan. ")
        + "Muat daftarnya lewat Aturan Promo -> Daftar outlet peserta.");
}

/**
 * Channel outlet menurut MASTER ACCURATE, bukan menurut laporan principal dan bukan menurut
 * yang diketik pengirim order.
 *
 * Keputusan pengguna 15 Sep 2026: **GT = TT saja**. Kategori lain dipakai apa adanya, jadi
 * surat ber-"CHANNEL MT" hanya cocok dengan outlet berkategori MT, dan kategori yang belum
 * dirapikan (Umum, KANVAS, MOTORIST) tidak ikut mendapat promo GT sampai kategorinya dibetulkan
 * di Accurate. Itu disengaja: memperlebarnya di sini berarti menebak, dan yang ditebak di sini
 * berakhir sebagai potongan pada faktur.
 */
export function channelOutlet(categoryName: string | null | undefined): string {
    const kategori = String(categoryName ?? "").trim().toUpperCase();
    if (!kategori) return "";
    return kategori === "TT" ? "GT" : kategori;
}

/**
 * Apakah aturan ini boleh berlaku untuk outlet dengan channel tersebut.
 *
 * Aturan tanpa channel (atau "ALL") berlaku di mana saja — itu bentuk sebagian besar surat.
 * Outlet yang channelnya TIDAK DIKETAHUI (kategori kosong di master) tidak lolos aturan
 * ber-channel: yang tidak diketahui ditahan, sama seperti daftar peserta yang kosong.
 */
/**
 * Channel menurut LAPORAN principal ("General Trade" / "Modern Trade") -> kosakata surat.
 * Yang tidak dikenali dikembalikan kosong, bukan ditebak: menebak di sini berarti menuduh
 * outlet salah kategori hanya karena principal memakai istilah yang belum pernah kita lihat.
 */
export function channelLaporan(value: string | null | undefined): string {
    const teks = String(value ?? "").trim().toUpperCase();
    if (!teks) return "";
    if (teks.includes("GENERAL") || teks === "GT") return "GT";
    if (teks.includes("MODERN") || teks === "MT") return "MT";
    return "";
}

/**
 * Keluarga channel kategori master, HANYA untuk dibandingkan dengan channel laporan principal.
 * NKA (National Key Account) di master memuat Alfamart, Indomaret, Hero, Lotte, Hypermart —
 * semuanya disebut "Modern Trade" oleh Kino, jadi NKA lawan MT bukan selisih. Kelayakan promo
 * ber-channel TIDAK memakai ini: `channelAllowed` tetap membandingkan kategori apa adanya.
 */
const keluargaLaporan = (outletChannel: string) => (outletChannel === "NKA" ? "MT" : outletChannel);

export function channelAllowed(rule: { channel?: string }, outletChannel: string | null | undefined): boolean {
    const diminta = String(rule.channel ?? "").trim().toUpperCase();
    if (!diminta || diminta === "ALL") return true;
    return diminta === String(outletChannel ?? "").trim().toUpperCase();
}

/** Satu anggota daftar outlet, apa adanya dari `promo_outlet`. */
export type OutletMember = {
    listName: string;
    customerCode: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    active?: boolean;
};

/**
 * Anggota daftar yang BERLAKU pada satu tanggal -> bentuk yang dipakai `outletAllowed`.
 *
 * Periodenya disaring di sini dan bukan di SQL karena satu berkas batch bisa memuat lebih
 * dari satu tanggal SO — persis alasan yang sama dengan aturan promo. Keanggotaan loyalty
 * berganti tiap kuartal, jadi menyaring sekali di muka dengan periode batch berarti menilai
 * seluruh berkas dengan keanggotaan tanggal yang salah, diam-diam.
 */
export function outletListsOn(members: OutletMember[], date: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const member of members) {
        if (member.active === false) continue;
        if (!berlakuPada({ periodStart: member.periodStart, periodEnd: member.periodEnd }, date)) continue;
        const nama = member.listName.trim().toUpperCase();
        if (!out.has(nama)) out.set(nama, new Set());
        out.get(nama)!.add(member.customerCode.trim().toUpperCase());
    }
    return out;
}

/** Belanja satu KELOMPOK aturan pada satu SO. Dipakai menilai ambang "beli minimal N". */
export type TriggerBuy = {
    /** Jumlah dalam satuan TERKECIL. 12 KRT isi 72 = 864, bukan 12. */
    qty: number;
    /** Nilai bruto laporan (DPP), sebelum PPN. */
    value: number;
};

/** Kunci kelompok ambang: satu surat, satu kelompok. Sama dengan kelompok mix pada `bonusQuota`. */
export const triggerGroupKey = (rule: { suratProgram?: string; promoGroup?: string }) =>
    `${String(rule.suratProgram ?? "")}|${String(rule.promoGroup ?? "")}`;

/**
 * Belanja per kelompok aturan pada SATU SO — bahan penilaian ambang "beli minimal N".
 *
 * KENAPA PER KELOMPOK, BUKAN PER BARANG. Suratnya sendiri berkata begitu: "SETIAP PEMBELIAN
 * 30 PCS ... MIX VARIANT". Memeriksanya per barang akan MENAHAN pembelian yang sah — 20 pcs
 * varian A ditambah 15 varian B memang memenuhi ambang 30. Aturan yang memang per barang tetap
 * terjaga: jembatan menulis satu kelompok per barang untuk program non-mix (`same_sku`), jadi
 * kelompoknya menyempit dengan sendirinya tanpa perlu kolom penanda baru.
 *
 * KENAPA PER SO, BUKAN PER BARIS. Satu SO bisa memuat barang yang sama pada beberapa baris
 * dengan satuan berbeda (KRT dan PCS), dan ambang surat berlaku untuk pembelian pada faktur itu
 * — bukan untuk tiap barisnya sendiri-sendiri.
 *
 * Baris BONUS tidak ikut dihitung sebagai pembelian: ia hadiahnya, bukan belanjanya. Kalau ikut,
 * bonus akan membantu memenuhi ambang yang justru menjadi syaratnya sendiri.
 */
export function purchaseByGroup(
    lines: { itemCode: string; quantity: number; gross: number; bonus?: boolean }[],
    rules: { itemCode: string; suratProgram?: string; promoGroup?: string }[],
): Map<string, TriggerBuy> {
    const groupsOfItem = new Map<string, Set<string>>();
    for (const rule of rules) {
        if (!rule.itemCode) continue;
        if (!groupsOfItem.has(rule.itemCode)) groupsOfItem.set(rule.itemCode, new Set());
        groupsOfItem.get(rule.itemCode)!.add(triggerGroupKey(rule));
    }
    const out = new Map<string, TriggerBuy>();
    for (const line of lines) {
        if (line.bonus) continue;
        for (const group of groupsOfItem.get(line.itemCode) ?? []) {
            const entry = out.get(group) ?? { qty: 0, value: 0 };
            entry.qty += Number(line.quantity) || 0;
            entry.value = cents(entry.value + (Number(line.gross) || 0));
            out.set(group, entry);
        }
    }
    return out;
}

/**
 * Apakah ambang "beli minimal N" aturan ini TERPENUHI oleh belanja kelompoknya.
 *
 * Sampai 2026-09-15 `trigger_qty` pada aturan per barang non-bonus hanyalah keterangan:
 * `matchItemRule` mencocokkan PERSENNYA saja. Jadi "beli 30 pcs dapat diskon 3%" yang diberikan
 * pada pembelian 5 pcs lolos dengan sempurna — barangnya benar, persennya benar, dan tidak ada
 * yang bertanya berapa yang dibeli.
 *
 * Tiga satuan, dan hanya dua yang bisa dinilai:
 *   PCS (atau kosong)  jumlah satuan terkecil lawan ambang. Bentuk seluruh aturan produksi.
 *   RP                 nilai belanja TERMASUK PPN, mengikuti keputusan yang sudah dibuktikan
 *                      pada program MSG: surat menulis nilai yang DIBAYAR outlet, sedangkan
 *                      laporan membawa DPP (15/15 faktur cocok dengan PPN, 10/15 tanpa).
 *   KRT                TIDAK BISA dinilai, dan sengaja tidak ditebak: isi karton berbeda tiap
 *                      barang, jadi mengubah "5 KRT" jadi angka satuan terkecil berarti
 *                      mengarang isi yang tidak tertulis di aturannya.
 *
 * Yang tidak bisa dinilai TIDAK dianggap terpenuhi. Ambang yang tidak terbaca adalah ambang yang
 * tidak menjaga apa pun, dan aturan yang tidak menjaga apa pun tidak boleh mengesahkan potongan.
 */
/**
 * Apakah ambang aturan ini memang urusan `triggerReached` — dan bukan urusan pemeriksa lain.
 *
 * Tiga jenis aturan punya ambang, dan hanya SATU yang belum dijaga:
 *   per barang non-bonus   BELUM dijaga sampai 2026-09-15 -> di sinilah lubangnya
 *   BONUS_QTY              sudah dijaga `bonusQuota`, lengkap dengan kuota kelipatannya
 *   tingkat faktur (MSG)   sudah dijaga `checkSoPromo`, dengan ambang termasuk PPN se-SO
 *
 * Kalau yang dua terakhir ikut disaring di sini, mereka akan HILANG dari daftar aturan sebelum
 * pemeriksanya sempat melihat — dan program MSG yang selama ini benar akan berhenti dikenali
 * tanpa satu pun galat. Itu sebabnya batasnya ditulis terang di satu tempat, bukan tersebar
 * sebagai syarat di tiap pemanggil.
 */
export function needsTriggerCheck(rule: { itemCode?: string; benefitType?: string; customerCode?: string }): boolean {
    if (!String(rule.itemCode ?? "").trim()) return false;
    if (String(rule.customerCode ?? "").trim()) return false;
    return String(rule.benefitType ?? "").trim().toUpperCase() !== "BONUS_QTY";
}

export function triggerReached(
    rule: { triggerQty?: number; triggerUnit?: string; suratProgram?: string; promoGroup?: string },
    bought: TriggerBuy | undefined,
): { ok: true } | { ok: false; reason: string } {
    const ambang = Number(rule.triggerQty) || 0;
    if (ambang <= 0) return { ok: true };
    const unit = String(rule.triggerUnit ?? "").trim().toUpperCase() || "PCS";
    const sebut = `${rule.suratProgram ?? ""} ${rule.promoGroup ?? ""}`.trim() || "aturan ini";
    const beli = bought ?? { qty: 0, value: 0 };

    if (unit === "KRT") {
        return { ok: false, reason: `Ambang ${sebut} tertulis ${ambang} KRT, dan isi karton berbeda tiap barang `
            + "jadi tidak bisa diubah ke satuan terkecil tanpa menebak. Tulis ambangnya dalam satuan terkecil (PCS) "
            + "di Aturan Promo supaya bisa ditegakkan." };
    }
    if (unit === "RP") {
        const denganPpn = cents(beli.value * (1 + PPN));
        if (denganPpn >= ambang) return { ok: true };
        return { ok: false, reason: `Belanja kelompok ${sebut} pada SO ini Rp ${beli.value.toLocaleString("id-ID")} `
            + `(Rp ${denganPpn.toLocaleString("id-ID")} dengan PPN), belum mencapai ambang Rp ${ambang.toLocaleString("id-ID")}.` };
    }
    if (beli.qty >= ambang) return { ok: true };
    return { ok: false, reason: `Belanja kelompok ${sebut} pada SO ini ${beli.qty.toLocaleString("id-ID")} ${unit}, `
        + `belum mencapai ambang ${ambang.toLocaleString("id-ID")} ${unit}.` };
}

/** Satu baris untuk pemeriksaan kuota bonus. `quantity` WAJIB dalam satuan TERKECIL. */
export type BonusLine = {
    /** Penanda baris pada pemanggilnya; dikembalikan apa adanya supaya barisnya bisa ditunjuk. */
    key: string;
    itemCode: string;
    /** Jumlah dalam satuan terkecil. 12 KRT isi 72 = 864, bukan 12. */
    quantity: number;
    /** Baris BONUS (potongan 100%), bukan baris pembelian. */
    bonus: boolean;
};

/** Aturan bonus yang menentukan kuotanya. Satu kelompok mix = satu (surat, kelompok). */
export type BonusQuotaRule = {
    itemCode: string;
    suratProgram: string;
    promoGroup: string;
    /** Ambang dalam satuan terkecil, mis. 30 PCS. */
    triggerQty: number;
    /** Berapa yang didapat tiap kelipatan ambang, mis. 1. */
    benefitValue: string;
};

export type BonusQuota = {
    group: string;
    suratProgram: string;
    promoGroup: string;
    trigger: number;
    benefit: number;
    /** Jumlah pembelian (satuan terkecil) pada kelompok ini. */
    purchased: number;
    /** Bonus yang BERHAK diterima: kelipatan penuh dari ambang. */
    entitled: number;
    /** Bonus yang benar-benar diberikan pada faktur/SO ini. */
    given: number;
    /** Baris bonus yang melewati kuota, dalam urutan munculnya. */
    overKeys: string[];
};

/**
 * Kuota bonus per KELOMPOK MIX, untuk satu faktur atau satu SO.
 *
 * Kenapa per kelompok dan bukan per barang: suratnya sendiri berkata begitu — "SETIAP PEMBELIAN
 * 30 PCS RESIK V KHASIAT MANJAKANI **MIX VARIANT** AKAN MENDAPATKAN BONUS 1 PCS". Memeriksanya
 * per barang akan menahan pembelian yang sah (20 pcs varian A + 15 varian B memang berhak satu
 * bonus), dan memeriksanya per faktur tanpa kelompok akan meloloskan bonus merek lain.
 *
 * Kenapa per FAKTUR/SO dan bukan per baris: baris bonus adalah baris TERSENDIRI berharga penuh
 * lalu dipotong 100%. Jumlah belinya ada di baris LAIN. Memeriksa baris bonus sendirian sama
 * saja tidak memeriksa apa pun — dan itulah lubang yang membuat "beli 10 pcs dapat bonus 1 pcs"
 * bisa lewat.
 *
 * Satuan WAJIB sudah diseragamkan ke satuan terkecil oleh pemanggil. Faktur nyata mencampur BTL
 * dan KRT pada barang yang sama (INV/2609/KN00453: beli 12 KRT isi 72, bonus 28 BTL); tanpa
 * penyeragaman, 12 akan dibandingkan dengan ambang 30 dan pembelian 864 pcs terbaca kurang.
 *
 * `overKeys` diisi dengan menelusuri baris bonus SESUAI URUTANNYA dan berhenti begitu kumulatifnya
 * melewati kuota. Baris tidak pernah dipecah: baris yang membuat kumulatif melewati kuota
 * dianggap melewati seluruhnya — menghitung sebagiannya sah berarti mengarang pembagian yang
 * tidak ada pada fakturnya.
 */
export function bonusQuota(lines: BonusLine[], rules: BonusQuotaRule[]): BonusQuota[] {
    const byItem = new Map<string, BonusQuotaRule>();
    for (const rule of rules) {
        if (!rule.itemCode) continue;
        if (!byItem.has(rule.itemCode)) byItem.set(rule.itemCode, rule);
    }
    const out = new Map<string, BonusQuota>();
    for (const line of lines) {
        const rule = byItem.get(line.itemCode);
        if (!rule) continue;
        const group = `${rule.suratProgram}|${rule.promoGroup}`;
        const entry = out.get(group) ?? {
            group, suratProgram: rule.suratProgram, promoGroup: rule.promoGroup,
            trigger: rule.triggerQty, benefit: Number(rule.benefitValue) || 0,
            purchased: 0, entitled: 0, given: 0, overKeys: [],
        };
        if (line.bonus) entry.given += line.quantity;
        else entry.purchased += line.quantity;
        out.set(group, entry);
    }
    for (const entry of out.values()) {
        // Ambang nol berarti surat tidak menyebut minimum pembelian; tidak ada kuota untuk
        // diperiksa, dan mengarang kuota dari angka nol akan menahan bonus yang memang berhak.
        entry.entitled = entry.trigger > 0 && entry.benefit > 0
            ? Math.floor(entry.purchased / entry.trigger) * entry.benefit
            : Number.POSITIVE_INFINITY;
    }
    // Penelusuran urutan baris bonus dilakukan setelah kuotanya diketahui.
    const berjalan = new Map<string, number>();
    for (const line of lines) {
        if (!line.bonus) continue;
        const rule = byItem.get(line.itemCode);
        if (!rule) continue;
        const group = `${rule.suratProgram}|${rule.promoGroup}`;
        const entry = out.get(group)!;
        const sebelum = berjalan.get(group) ?? 0;
        const sesudah = sebelum + line.quantity;
        berjalan.set(group, sesudah);
        if (sesudah > entry.entitled) entry.overKeys.push(line.key);
    }
    return [...out.values()];
}

/**
 * Rentang terbuka: kosong di salah satu ujung = tidak dibatasi di ujung itu.
 *
 * INI UNTUK KEANGGOTAAN DAFTAR OUTLET, BUKAN UNTUK ATURAN. Lampiran daftar outlet sebuah
 * surat memang tidak membawa tanggalnya sendiri — dua anggota daftar `BP2609007909` di
 * produksi berperiode kosong, dan itu benar: yang membatasi masa berlakunya adalah periode
 * ATURANnya, bukan keanggotaannya. Menutup ujung yang kosong di sini akan mencabut kedua
 * outlet itu dan membuat 123 aturan ON PO berhenti berlaku untuk siapa pun.
 *
 * Untuk aturan promo pakai `aturanBerlaku` — di sana tanggal yang hilang justru cacat.
 */
export function berlakuPada(rule: { periodStart?: string | null; periodEnd?: string | null }, date: string): boolean {
    return (!rule.periodStart || rule.periodStart <= date) && (!rule.periodEnd || date <= rule.periodEnd);
}

/**
 * Aturan promo berlaku pada tanggal itu — DAN periodenya lengkap.
 *
 * Aturan tanpa tanggal akhir tidak pernah kedaluwarsa, dan itu bukan keadaan yang sah:
 * setiap surat program punya masa berlaku. Sampai 20 September 2026 `berlakuPada` dipakai
 * langsung di sini, sehingga satu baris Excel dengan `PERIODE` salah ketik menghasilkan
 * aturan yang membenarkan potongan SELAMANYA, di tanggal mana pun.
 *
 * Mesin Python (`summary_rules.Program`) sudah menolaknya sejak awal — `start` dan `end`
 * wajib. Jalur inilah yang longgar, dan justru jalur ini yang membenarkan potongan pada
 * FAKTUR NYATA. Sekarang keduanya sama-sama fail-closed.
 */
export function aturanBerlaku(rule: { periodStart?: string | null; periodEnd?: string | null }, date: string): boolean {
    if (!rule.periodStart || !rule.periodEnd) return false;
    return rule.periodStart <= date && date <= rule.periodEnd;
}

/** Bentuk minimum satu baris tarif; dipakai gerbang validasi maupun Rekap Promo. */
export type TariffRule = {
    customerCode: string;
    itemCode: string;
    tierNo: number;
    benefitType: string;
    benefitValue: string;
    benefitBeban: string;
};

/**
 * Tarif **Discount Reguler (Tanggungan Distributor)**: satu baris aturan per (outlet x POSISI),
 * berlaku untuk SEMUA barang yang dibeli outlet itu. Terbukti pada ORDER_DETAIL 12 September
 * 2026 — SS DIAPERS MESJID RAYA memotong 2% di posisi 1 pada delapan barang yang berbeda.
 *
 * Dicocokkan **per POSISI, bukan pada jumlahnya**: posisi menyatakan siapa menanggung, jadi 4%
 * di posisi 1 dan 4% di posisi 2 adalah dua hal berbeda meski totalnya sama. Ini bug yang sama
 * dengan rantai persen yang dimampatkan (2026-09-12): begitu posisi hilang, potongan berpindah
 * penanggung tanpa ada yang tahu.
 *
 * Mengembalikan aturan yang menjelaskan SELURUH potongan beban itu pada baris tersebut, atau null
 * bila ada SATU posisi saja yang tidak punya tarifnya — separuh penjelasan bukan penjelasan.
 *
 * Tabel yang sama juga memuat tarif PRINCIPAL di posisi 4-5 (PT SUPRA BOGA 0,5% di posisi 4).
 * Sampai 2026-09-24 hanya sisi distributor yang dicocokkan, sehingga tarif principal yang
 * dimuat pengguna tidak pernah bisa menjelaskan apa pun dan barisnya ditahan dengan pesan
 * "0,5% tidak sama dengan ... posisi 4 0,5%". `owner` memilih sisinya.
 *
 * Pemanggil WAJIB sudah menyaring `rules` ke outlet baris ini (dan, untuk rekap, ke periodenya).
 * Yang dijaga di sini: `customerCode` harus terisi, supaya aturan yang berlaku umum tidak
 * pernah ikut membenarkan tarif outlet.
 */
export function matchTariff<T extends TariffRule>(
    discounts: DiscountAt[], rules: T[], owner: "distributor" | "principal" = "distributor",
): T[] | null {
    const worn = discounts.filter((entry) => OWNER[entry.position] === owner && entry.percent > 0);
    if (worn.length === 0) return null;
    const beban = owner === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
    const matched: T[] = [];
    for (const entry of worn) {
        const rule = rules.find((candidate) => candidate.customerCode && !candidate.itemCode
            && candidate.benefitBeban === beban && candidate.benefitType === "DISC_PCT"
            && candidate.tierNo === entry.position
            && Math.abs(cents(Number(candidate.benefitValue) - entry.percent)) <= 0.01);
        if (!rule) return null;
        matched.push(rule);
    }
    return matched;
}

/**
 * Jaringan yang POSISI diskonnya dimaklumi, dicocokkan pada NAMA pelanggan di master Accurate.
 * Keputusan pengguna 2026-09-24: Kino melaporkan tarif jaringan ini di posisi yang salah
 * (2,25% Alfamart di DISC_4, padahal tarifnya tanggungan distributor di posisi 2), jadi posisinya
 * dinormalisasi mengikuti tarif. Outlet lain tetap dinilai per posisi apa adanya.
 */
export const JARINGAN_POSISI_BEBAS = /\b(INDOMARET|ALFAMART|INDOGROSIR|ALFAMIDI)\b/i;

export type Normalisasi = { discounts: DiscountAt[]; finding?: string };

const rantai = (values: number[]) => values.map((value) => String(value)).join(" + ");

/**
 * Diskon jaringan (`JARINGAN_POSISI_BEBAS`) -> posisi menurut TARIF outletnya.
 *
 * Aturan pengguna: posisi yang salah DIMAKLUMI, nilai yang berbeda DITOLAK. Setiap persen pada
 * laporan dipasangkan dengan satu posisi tarif yang nilainya sama — yang sudah di posisinya tetap,
 * yang salah posisi dipindah. Persen yang tidak punya pasangan hanya boleh tinggal bila surat
 * principal untuk barang itu membenarkannya; selain itu SELURUH barisnya dikembalikan apa adanya
 * dengan temuan, mis. laporan 3,96 + 3,1 + 3,1 lawan tarif 3,96 + 3,1: kelebihan 3,1-nya tidak
 * punya dasar, dan outlet tidak boleh menerima lebih dari tarifnya.
 *
 * Yang TIDAK disentuh: potongan rupiah (MSG) dan baris bonus. Outlet tanpa tarif juga tidak —
 * tanpa tarif tidak ada yang bisa dijadikan acuan posisi, jadi pemeriksaan biasa yang menilainya.
 *
 * Selalu dihitung ulang dari posisi LAPORAN (`reportPosition`): baris yang divalidasi ulang
 * sesudah tarifnya berubah dinilai dengan tarif baru, bukan tertinggal di posisi lama.
 * Pemanggil WAJIB sudah menyaring `rules` ke outlet, barang, dan tanggal baris ini.
 */
export function normalisasiJaringan(discounts: DiscountAt[], rules: PublishedRule[], itemCode?: string | null): Normalisasi {
    const asli = discounts.map(({ reportPosition, ...entry }) => ({ ...entry, position: reportPosition ?? entry.position }))
        .sort((a, b) => a.position - b.position);
    const tarif = rules.filter((rule) => rule.customerCode && !rule.itemCode && rule.benefitType === "DISC_PCT")
        .sort((a, b) => a.tierNo - b.tierNo);
    if (tarif.length === 0 || isBonusLine(asli)) return { discounts: asli };
    const sama = (rule: PublishedRule, percent: number) => Math.abs(cents(Number(rule.benefitValue) - percent)) <= 0.01;
    const persen = (entry: DiscountAt) => entry.amount === undefined && entry.percent > 0;

    const terpakai = new Set<PublishedRule>();
    const hasil: DiscountAt[] = asli.filter((entry) => !persen(entry));
    const salahPosisi: DiscountAt[] = [];
    for (const entry of asli.filter(persen)) {
        const tepat = tarif.find((rule) => !terpakai.has(rule) && rule.tierNo === entry.position && sama(rule, entry.percent));
        if (tepat) { terpakai.add(tepat); hasil.push(entry); } else salahPosisi.push(entry);
    }
    const tanpaPasangan: DiscountAt[] = [];
    for (const entry of salahPosisi) {
        const slot = tarif.find((rule) => !terpakai.has(rule) && sama(rule, entry.percent));
        if (slot) { terpakai.add(slot); hasil.push({ ...entry, position: slot.tierNo, reportPosition: entry.position }); }
        else if (matchItemRule([entry], rules, itemCode, "principal")) hasil.push(entry);
        else tanpaPasangan.push(entry);
    }
    const posisi = hasil.map((entry) => entry.position);
    if (tanpaPasangan.length === 0 && new Set(posisi).size === posisi.length) {
        return { discounts: hasil.sort((a, b) => a.position - b.position) };
    }
    const lebih = tanpaPasangan.map((entry) => `${entry.percent}% di DISC_${entry.position}`).join(", ") || "posisinya bertabrakan";
    return {
        discounts: asli,
        finding: `Diskon laporan ${rantai(asli.filter(persen).map((entry) => entry.percent))} tidak sama dengan tarif outlet ini `
            + `(${rantai(tarif.map((rule) => Number(rule.benefitValue)))}): ${lebih} tidak punya pasangan di tarif maupun surat. `
            + "Posisi yang salah dimaklumi untuk jaringan ini, nilai yang berbeda tidak.",
    };
}

export type SoPromo = {
    /** Kosong bila klaim principal pada SO ini TIDAK dijelaskan aturan tingkat faktur. */
    explained: string;
    /** Temuan tingkat SO; menahan seluruh barisnya, sama seperti temuan per baris. */
    findings: string[];
};

/**
 * Potongan tingkat FAKTUR (program MSG): satu nominal untuk SELURUH SO, dibagi rata ke tiap
 * barisnya. Tidak bisa diperiksa per baris — barang yang sama sekali tidak masuk program pun
 * ikut kebagian potongannya, jadi pencocokan per barang akan menuduh baris yang benar.
 *
 * Yang dicocokkan: SISA klaim principal se-SO — bagian yang BELUM dijelaskan aturan per barang
 * — dikembalikan ke nilai TERMASUK PPN, lawan manfaat tier tertinggi yang ambangnya terlampaui
 * oleh bruto SO. Memakai total klaim mentah akan menuduh SO yang klaimnya sudah beres per
 * barang: SO 1671-SOP-260013044 (12 Sep 2026) brutonya 3 juta sehingga menyentuh tier 3, padahal
 * seluruh klaimnya adalah promo 3% per barang yang sudah cocok dan tidak ada urusan dengan MSG.
 */
export function checkSoPromo(
    input: { gross: number; principalClaim: number; lineCount: number },
    rules: PublishedRule[],
): SoPromo {
    if (input.principalClaim <= 0) return { explained: "", findings: [] };
    const tiers = rules
        .filter((rule) => !rule.itemCode && rule.benefitType === "DISC_RP" && rule.triggerUnit.toUpperCase() === "RP")
        .sort((a, b) => b.triggerQty - a.triggerQty);
    // AMBANGNYA juga TERMASUK PPN, bukan hanya manfaatnya. Surat MSG menulis "MINIMAL
    // TRANSAKSI 1JT - 1.99JT" — nilai yang dibayar outlet, sedangkan laporan membawa DPP.
    // Membandingkan DPP dengan ambang bruto menjatuhkan SO ke tier di bawahnya dan menuduh
    // klaim yang sebenarnya benar. Dibuktikan atas 15 faktur September di produksi: tier yang
    // benar-benar diberi Kino cocok 15/15 dengan ambang termasuk PPN, dan hanya 10/15 dengan
    // DPP (TK. SAWI 12, TK. ASMA, NOVA COSMETIK, APOTEK HUSADA FARMA, TRIPLE M meleset).
    const grossWithTax = cents(input.gross * (1 + PPN));
    const reached = tiers.find((tier) => grossWithTax >= tier.triggerQty);
    if (!reached) return { explained: "", findings: [] };

    const expected = Number(reached.benefitValue);
    if (!Number.isFinite(expected)) return { explained: "", findings: [] };
    const claimWithTax = cents(input.principalClaim * (1 + PPN));
    // Toleransi Rp 1 PER BARIS, dengan lantai Rp 100: nominalnya dibagi rata lalu dibulatkan di
    // tiap baris, jadi sisa pembulatannya menumpuk sebanyak barisnya — dan sesudah dikalikan PPN
    // sisa itu berhenti di belasan rupiah meski barisnya sedikit. Lihat `TOLERANSI_NOTA`.
    const tolerance = Math.max(TOLERANCE * Math.max(input.lineCount, 1), TOLERANSI_NOTA);
    if (Math.abs(claimWithTax - expected) > tolerance) {
        return {
            explained: "",
            findings: [`Potongan faktur ${reached.suratProgram} tier ${reached.tierNo}: klaim principal `
                + `Rp ${input.principalClaim.toLocaleString("id-ID")} (Rp ${claimWithTax.toLocaleString("id-ID")} dengan PPN) `
                + `berbeda dari manfaat terbit Rp ${expected.toLocaleString("id-ID")}.`],
        };
    }
    return {
        explained: `${reached.suratProgram} tier ${reached.tierNo} (belanja dengan PPN >= Rp ${reached.triggerQty.toLocaleString("id-ID")} -> Rp ${expected.toLocaleString("id-ID")})`,
        findings: [],
    };
}

/**
 * Satu baris -> status + temuan. Setiap temuan menahan barisnya; tidak ada yang "cuma warning",
 * karena semua yang diperiksa di sini berakhir sebagai angka pada faktur.
 */
export function checkLine(line: LineInput): LineCheck {
    const findings: string[] = [];
    const split = splitDiscounts(line.gross, line.discounts);

    if (!line.itemCode) findings.push(`Kode produk ${line.productCode} belum ada di mapping principal.`);
    else if (!line.itemExists) findings.push(`Kode barang ${line.itemCode} tidak ada di master Accurate.`);

    if (!line.customerNo) findings.push(`Kode outlet ${line.customerCode} belum ada di mapping principal.`);
    else if (!line.customerExists) findings.push(`Pelanggan ${line.customerNo} tidak ada di master Accurate.`);

    if (!line.salesmanInternal) findings.push(`Kode salesman ${line.salesmanCode} belum ada di mapping principal.`);

    // Satuan yang tidak dikenal daftar harga berarti nilai barisnya tidak bisa dipercaya:
    // satu item bisa berselisih 72x antar satuan.
    if (line.knownUnits.length > 0 && !line.knownUnits.includes(line.unit.toUpperCase())) {
        findings.push(`Satuan ${line.unit} tidak ada pada daftar harga Accurate (yang ada: ${line.knownUnits.join(", ")}).`);
    }

    // Baris bonus memang berharga penuh lalu dipotong 100%; harganya tetap wajib benar.
    if (line.expectedPrice === null) {
        findings.push(`Harga Accurate untuk ${line.itemCode ?? line.productCode} ${line.unit} tidak ditemukan.`);
    } else {
        const gap = cents(line.price - line.expectedPrice);
        // Toleransi Rp 1 berlaku pada SATUAN TERKECIL, tempat pembulatannya benar-benar terjadi:
        // Accurate menyimpan harga per satuan terkecil dalam rupiah bulat (BTL 29.189) sementara
        // laporan principal membawa desimal DPP (29.189,1892 = 32.400 / 1,11). Beda Rp 0,19 per
        // botol itu menjadi Rp 4,54 begitu baris dinaikkan ke KRT isi 24 — pembulatan yang sama,
        // hanya dikali ISI. Salah harga yang sungguhan besarnya ratusan rupiah per satuan
        // terkecil, jadi tetap tertahan.
        const ratio = line.unitRatio && line.unitRatio > 0 ? line.unitRatio : 1;
        const gapPerSmallest = cents(gap / ratio);
        if (Math.abs(gapPerSmallest) > TOLERANCE) {
            findings.push(`Harga laporan ${line.price.toLocaleString("id-ID")} berbeda ${gap > 0 ? "lebih tinggi" : "lebih rendah"} `
                + `${Math.abs(gap).toLocaleString("id-ID")} dari harga Accurate ${line.expectedPrice.toLocaleString("id-ID")}`
                + (ratio > 1 ? ` (setara ${Math.abs(gapPerSmallest).toLocaleString("id-ID")} per satuan terkecil dari ${ratio}).` : "."));
        }
    }

    if (split.unowned > 0) {
        const posisi = line.discounts.filter((entry) => !OWNER[entry.position]).map((entry) => `DISC_${entry.position}`);
        findings.push(`Diskon tak bertuan Rp ${split.unowned.toLocaleString("id-ID")} pada ${posisi.join(", ")}; `
            + "posisi itu bukan tanggungan distributor maupun klaim principal.");
    }
    // Klaim principal wajib PUNYA PENJELASAN. Sebelumnya setiap klaim ditahan tanpa kecuali
    // karena gerbang ini tidak pernah membaca aturan terbit — termasuk klaim yang sudah punya
    // aturannya. Sekarang aturannya dibaca, dan yang ditahan hanya yang benar-benar tidak
    // cocok. Uang yang tidak bisa dipertanggungjawabkan tetap tidak boleh lewat.
    // TIDAK ADA potongan yang boleh tembus ke faktur tanpa aturannya (keputusan pengguna
    // 2026-09-12). Berlaku untuk KEDUA beban: klaim principal maupun tanggungan distributor.
    // Sebelumnya posisi 1-3 lolos begitu saja karena "toh beban sendiri" — tetapi potongan yang
    // tidak punya aturan bukan beban sendiri, ia potongan yang belum jelas milik siapa, dan
    // memberikannya lebih dulu lalu bertanya kemudian adalah cara kehilangan uang tanpa jejak.
    // Baris bonus diputuskan lebih dulu dan SEKALIGUS: 100%-nya satu potongan utuh yang
    // dijelaskan satu aturan, jadi memecahnya per beban hanya akan menuduh separuhnya.
    //
    // KUOTA diperiksa sebelum aturannya: bonus yang melewati kuota TIDAK dijelaskan aturan mana
    // pun, betapapun benar barang dan persennya. Kuotanya dihitung pemanggil karena jumlah
    // BELINYA ada di baris lain pada SO yang sama.
    const bonusRule = line.bonusOverQuota ? null : matchBonusRule(line.discounts, line.rules, line.itemCode);
    if (line.bonusOverQuota) findings.push(line.bonusOverQuota);
    if (bonusRule) {
        // Beban dipindahkan ke principal supaya gerbang dan Rekap Promo memberi jawaban yang
        // sama. Tanpa ini baris bonus tercatat beban distributor — mengaku menanggung barang
        // yang menurut suratnya diberikan principal. `unowned` sengaja TIDAK ikut dipindah:
        // bonus di posisi di luar 1-5 belum pernah ada, dan kalau muncul ia harus tetap
        // tertahan, bukan disahkan oleh aturan yang kebetulan ada.
        split.principal = cents(split.principal + split.distributor);
        split.distributor = 0;
    }

    let adaYangTakBertuan = false;
    for (const owner of bonusRule ? [] : (["distributor", "principal"] as const)) {
        const amount = owner === "principal" ? split.principal : split.distributor;
        if (amount <= 0) continue;
        const beban = owner === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
        const sebutan = owner === "principal" ? "Klaim principal" : "Potongan tanggungan distributor";

        if (matchItemRule(line.discounts, line.rules, line.itemCode, owner)) continue;
        // Tarif Discount Reguler: melekat pada OUTLET dan berlaku semua barang, jadi tidak
        // pernah ketemu lewat aturan per barang di atas. Kedua sisi: tabelnya memuat keduanya.
        if (matchTariff(line.discounts, line.rules, owner)) continue;
        // Potongan tingkat faktur: nominalnya milik SELURUH SO dan sudah diperiksa di sana.
        if (owner === "principal" && line.fakturPromo) continue;

        const percentRules = line.rules.filter((rule) => rule.benefitType === "DISC_PCT"
            && rule.benefitBeban === beban
            // Aturan per barang, ATAU tarif outlet (berlaku semua barang).
            && (rule.itemCode ? (!line.itemCode || rule.itemCode === line.itemCode) : Boolean(rule.customerCode)));
        const actual = cents(line.discounts
            .filter((entry) => OWNER[entry.position] === owner)
            .reduce((total, entry) => total + entry.percent, 0));
        // TIDAK PUNYA ATURAN = TAK BERTUAN, di posisi mana pun (keputusan pengguna 2026-09-15).
        // Peta posisi 1-3/4-5 hanya berlaku bagi potongan yang aturannya ADA; ia menyatakan
        // siapa yang DIMAKSUD menanggung, bukan siapa yang terbukti menanggung. Selama belum
        // ada aturannya, mencatatnya sebagai "beban distributor" berarti mengaku menanggung
        // uang yang belum jelas milik siapa, dan sebagai "klaim principal" berarti mengaku
        // berhak menagihnya. Dua-duanya salah dengan cara yang berbeda.
        split[owner] = cents(split[owner] - amount);
        split.unowned = cents(split.unowned + amount);
        adaYangTakBertuan = true;

        if (percentRules.length > 0) {
            // Posisi ikut disebut: tarif yang benar nilainya tetapi salah posisi berarti
            // penanggungnya berpindah, dan itu tidak akan terlihat dari persennya saja.
            const daftar = percentRules.map((rule) => (rule.customerCode
                ? `posisi ${rule.tierNo} ${rule.benefitValue}% (${rule.suratProgram})`
                : `${rule.benefitValue}% (${rule.suratProgram} ${rule.promoGroup})`)).join(", ");
            const lawan = percentRules.some((rule) => rule.customerCode) ? "aturan terbit" : "aturan terbit untuk barang ini";
            findings.push(`${sebutan} ${actual}% tidak sama dengan ${lawan}: ${daftar} — jadi tak bertuan.`);
        } else {
            findings.push(`${sebutan} Rp ${amount.toLocaleString("id-ID")} tidak punya aturan promo terbit, `
                + `jadi dihitung tak bertuan sampai aturannya ada.`);
        }
    }

    // Kalau ada potongan yang dinyatakan tak bertuan padahal aturannya SEBENARNYA ADA — hanya
    // tersaring channel atau daftar peserta — sebabnya disebut di sini. Tanpa itu, yang membaca
    // temuan akan mencari aturan yang hilang, padahal yang salah justru kategori outletnya.
    if (adaYangTakBertuan) for (const sebab of line.terhalang ?? []) findings.push(sebab);

    // CHANNEL LAPORAN LAWAN MASTER. Laporan principal menyebut channelnya sendiri; master
    // Accurate menyebut kategorinya. Kalau keduanya berbeda, salah satu salah — dan yang
    // dipakai memutuskan promo adalah MASTER, jadi selisihnya harus terlihat, bukan didiamkan.
    // Sudah ada contohnya di produksi: HINDA MART (C-HIL009) disebut General Trade oleh Kino
    // sedangkan master kita menyimpannya MT.
    if (split.total > 0 && line.outletChannel && line.reportChannel
        && channelLaporan(line.reportChannel) && channelLaporan(line.reportChannel) !== keluargaLaporan(line.outletChannel)) {
        findings.push(`Laporan principal menyebut outlet ini ${line.reportChannel} (${channelLaporan(line.reportChannel)}), `
            + `sedangkan master Accurate menyimpannya ${line.outletChannel}. Promo per channel diputuskan dari MASTER, `
            + "jadi betulkan kategorinya di Accurate atau tanyakan ke principal mana yang benar.");
    }

    // BARIS BONUS TIDAK DIBANDINGKAN, dan itu bukan kelonggaran (keputusan pengguna 2026-09-16).
    //
    // Bonus barang masuk faktur Accurate sebagai baris berharga PENUH lalu dipotong 100% —
    // itulah satu-satunya cara mencatat barang gratis di sana. Laporan principal menyebutnya
    // BONUS, bukan diskon, jadi kolom diskonnya nol. Keduanya benar; yang berbeda cuma cara
    // menuliskannya. Membandingkan keduanya berarti menuduh setiap baris bonus salah.
    //
    // Contoh dari batch 15 September: ALUBI KOSMETIK membeli 396 PCS OVALE FACIAL LOTION,
    // berhak 13,2 bonus, menerima 13 (0,2 PCS tidak mungkin diberikan). Potongan principal
    // memang Rp 0 — wajar, karena yang diberikan barang, bukan uang.
    //
    // Yang TIDAK dilonggarkan: kalau principal justru MELAPORKAN potongan pada baris bonus,
    // salah satu pihak salah dan itu tetap harus terlihat. Yang dilewati hanya baris bonus yang
    // laporannya memang nol — dan kuota bonusnya tetap diperiksa `bonusQuota` seperti biasa.
    const barisBonusTanpaLaporan = isBonusLine(line.discounts)
        && Math.abs(cents(line.reportDiscount)) <= TOLERANCE;

    // Angka kita harus sama dengan yang dilaporkan principal; beda berarti salah satu salah baca.
    if (!barisBonusTanpaLaporan && Math.abs(cents(split.total - line.reportDiscount)) > TOLERANCE) {
        findings.push(`Total diskon hitungan kami Rp ${split.total.toLocaleString("id-ID")} berbeda dari laporan principal `
            + `Rp ${line.reportDiscount.toLocaleString("id-ID")}.`);
    }

    return { status: findings.length ? "review" : "ok", findings, split };
}
