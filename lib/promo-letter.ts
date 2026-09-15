/*
 * Tujuan: Membaca LAMPIRAN "LIST OUTLET TERLAMPIR" pada surat program Kino menjadi daftar
 *         outlet peserta milik SATU distributor.
 * Caller: app/api/promo-outlet (unggah PDF surat).
 * Dependensi: tidak ada. Main Functions: readLetterOutlets. Murni — tanpa DB dan tanpa jaringan.
 *
 * Kenapa dibaca dari suratnya, bukan diketik ulang: daftar pesertanya MEMANG bagian dari surat
 * ("LIST OUTLET TERLAMPIR", halaman 2 dan seterusnya). Mengetik ulang dua outlet hari ini
 * memang cepat, tetapi surat berikutnya bisa memuat dua puluh, dan yang mengetiknya bukan
 * orang yang memegang suratnya.
 *
 * Yang TIDAK dilakukan di sini: menerjemahkan kode. Lampiran membawa kode pelanggan KINO
 * (`5191202075409`), sedangkan daftar peserta menyimpan kode internal Accurate. Penerjemahnya
 * `principal_mapping`, dan itu pekerjaan pemanggil yang punya database — modul ini hanya
 * membaca apa yang tercetak.
 *
 * `readLetterOutlets` membaca LAPISAN TEKS: surat Kino dicetak dari sistem mereka, jadi jalur
 * ini gratis dan paling tepat. Surat HASIL SCAN tidak punya lapisan teks dan akan menghasilkan
 * nol baris; untuk itu ada `fromOcrRows`, yang menerima hasil `lib/promo-letter-ocr` (Mistral
 * OCR 4.1) dan melewatkannya ke pemeriksaan bentuk yang SAMA. Dua sumber, satu gerbang bentuk.
 */

/** Satu baris lampiran, apa adanya. `label` hanya untuk dibaca manusia saat kodenya ditolak. */
export type LetterOutlet = { distCode: string; distName: string; outletCode: string; label: string };

export type LetterAttachment = {
    /** Nomor surat pada kop, mis. BP2609007909. Jadi nama daftar pesertanya. */
    kodeAju: string;
    program: string;
    /** Semua distributor yang muncul di lampiran — supaya kode yang salah ketik kelihatan. */
    distributors: { code: string; name: string; outlets: number }[];
    /** Outlet milik distributor yang diminta saja. */
    outlets: LetterOutlet[];
    /** Lampirannya tidak punya kolom distributor sama sekali — seluruh daftarnya milik kita. */
    tanpaKodeDist: boolean;
    /** Baris lampiran yang tidak terbaca sebagai baris outlet. Dilaporkan, bukan didiamkan. */
    skipped: number;
};

/**
 * Nilai sebuah label pada kop surat.
 *
 * Dua bentuk harus terbaca sama: lapisan teks menulis `Kode Aju : BP2609007909`, sedangkan
 * markdown hasil OCR menebalkan labelnya (`**Kode Aju** : ...`) atau menaruhnya di dalam tabel
 * (`| Kode Aju | BP2609007909 |`). Kalau hanya bentuk pertama yang dikenali, surat hasil scan
 * akan kehilangan nomor suratnya — dan nomor surat itulah nama daftar pesertanya.
 */
const field = (text: string, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp(`${escaped}[^:\\n]{0,8}:\\s*(.+)`, "i"),
        new RegExp(`${escaped}[^|\\n]{0,8}\\|\\s*([^|\\n]+)`, "i"),
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        const value = match ? match[1].replace(/[*|]/g, "").trim() : "";
        if (value) return value;
    }
    return "";
};

/**
 * Kode distributor: TEPAT tujuh angka. Diperiksa sebagai bentuk, bukan dicocokkan ke daftar,
 * supaya distributor yang belum pernah terlihat tetap terbaca dan bisa dilaporkan.
 */
const DIST = /^\d{7}$/;

/**
 * Kode outlet Kino: diawali angka, alfanumerik, minimal delapan karakter.
 *
 * Bentuknya jauh dari seragam — `5191202075409`, `1937JBD0123`, `232402LIA01`,
 * `35645191202067333` semuanya nyata pada satu lampiran yang sama. Karena itu ia dikenali dari
 * BENTUK dan LETAK (token pertama setelah nama distributor), bukan dari pola yang dikarang.
 *
 * ponytail: nama distributor tidak pernah diawali angka, dan kode distributornya sudah lewat
 * di kiri, jadi token pertama yang cocok memang kolom kode outlet. Kalau suatu saat Kino
 * memakai kode berstrip atau bertitik, barisnya akan terlewat dan masuk hitungan `skipped` —
 * terlihat sebagai lubang, bukan hilang diam-diam.
 */
const OUTLET = /^\d[0-9A-Z]{7,}$/;

/**
 * Bentuk kode outlet yang diterima dari OCR — jauh lebih longgar, dan memang harus.
 *
 * Lampiran surat principal LAIN tidak berbentuk seperti punya Kino: surat URC "PROMO TOKO
 * ONLINE SULAWESI 1" memakai kode Accurate langsung (`C-BRI002`, `C-ZEL790`) dan kode
 * distributor beraksara (`SUR030`), bukan tujuh angka. Di jalur teks, dua jangkar ketat itu
 * dipakai untuk MENEMUKAN kolomnya; di jalur OCR kolomnya sudah ditunjuk oleh modelnya, jadi
 * yang tersisa hanyalah menolak isi yang jelas bukan kode — kalimat, tanda tanya, sel kosong.
 *
 * Tetap ada gerbangnya: kode tidak boleh mengandung spasi. Yang gagal masuk hitungan `skipped`,
 * dan yang lolos tetap harus terbukti ada di master pelanggan sebelum dimuat.
 */
const OCR_OUTLET = /^[0-9A-Z][0-9A-Z._/-]{3,}$/;

/**
 * Halaman-halaman surat (teks per halaman) -> outlet peserta milik `distCode`.
 *
 * Halaman pertama adalah kop surat; lampirannya mulai halaman kedua. Barisnya berbentuk
 * `REGION | KODE DIST | NAMA DIST | KODE OUTLET | NAMA OUTLET | NAMA BM | KIBAS | SKP | MEKANISME`,
 * tetapi kolom kosong di tengah membuat pemisahan per spasi tidak bisa diandalkan. Yang dipakai
 * karena itu bukan posisi kolom melainkan dua jangkar yang selalu ada: kode distributor dan
 * kode outlet.
 *
 * `distCode` WAJIB diisi: satu lampiran memuat outlet SELURUH distributor nasional, dan memuat
 * semuanya berarti memberi program ini kepada outlet milik distributor lain.
 */
export function readLetterOutlets(pages: string[], distCode: string): LetterAttachment {
    const head = pages[0] ?? "";
    const baris: LetterOutlet[] = [];
    let skipped = 0;

    for (const page of pages.slice(1)) {
        for (const line of page.split(/\r?\n/)) {
            const tokens = line.trim().split(/\s+/).filter(Boolean);
            if (tokens.length < 4) continue;
            const distAt = tokens.findIndex((token) => DIST.test(token));
            if (distAt < 0) continue;
            const outletAt = tokens.findIndex((token, index) => index > distAt && OUTLET.test(token));
            if (outletAt < 0) { skipped += 1; continue; }

            baris.push({
                distCode: tokens[distAt],
                distName: tokens.slice(distAt + 1, outletAt).join(" "),
                outletCode: tokens[outletAt],
                label: tokens.slice(outletAt + 1).join(" "),
            });
        }
    }

    return attachmentFrom(baris, {
        kodeAju: field(head, "Kode Aju"), program: field(head, "Nama Program Promo"),
    }, distCode, skipped);
}

/** Kop surat: nomor dan nama programnya. Dipakai jalur teks maupun jalur OCR. */
export function letterHead(text: string): { kodeAju: string; program: string } {
    return { kodeAju: field(text, "Kode Aju"), program: field(text, "Nama Program Promo") };
}

/**
 * Baris hasil OCR -> bentuk baku, dengan BENTUK KODENYA DIPERIKSA ULANG.
 *
 * Model bisa salah membaca satu karakter pada hasil scan, dan kode yang bentuknya salah lebih
 * berbahaya daripada baris yang hilang: kode hantu tidak akan cocok dengan pelanggan mana pun,
 * lalu diam-diam berakhir sebagai "outlet ini bukan peserta". Yang bentuknya tidak lolos
 * DIHITUNG sebagai `skipped` supaya kelihatan sebagai lubang, bukan sebagai jawaban.
 */
export function fromOcrRows(
    rows: { kode_dist: string; nama_dist: string; kode_outlet: string; nama_outlet: string }[],
    head: { kodeAju: string; program: string }, distCode: string,
): LetterAttachment {
    const baik: LetterOutlet[] = [];
    let skipped = 0;
    for (const row of rows) {
        const outlet = String(row.kode_outlet ?? "").trim().toUpperCase();
        if (!OCR_OUTLET.test(outlet)) { skipped += 1; continue; }
        baik.push({
            distCode: String(row.kode_dist ?? "").trim(),
            distName: String(row.nama_dist ?? "").trim(),
            outletCode: outlet, label: String(row.nama_outlet ?? "").trim(),
        });
    }
    return attachmentFrom(baik, head, distCode, skipped);
}

/**
 * Baris lampiran (dari lapisan teks MAUPUN dari OCR) -> bentuk baku yang dipakai pemanggil.
 *
 * Satu bentuk untuk kedua sumber, disusun di satu tempat: kalau jalur OCR menyusunnya sendiri,
 * suatu saat keduanya akan menjawab berbeda tentang lampiran yang sama — dan yang berbeda itu
 * adalah "outlet siapa yang berhak", bukan sekadar bentuk data.
 */
export function attachmentFrom(
    rows: LetterOutlet[], head: { kodeAju: string; program: string }, distCode: string, skipped = 0,
): LetterAttachment {
    const wanted = distCode.trim().toUpperCase();
    const perDist = new Map<string, { code: string; name: string; outlets: number }>();
    for (const row of rows) {
        if (!row.distCode) continue;
        const code = row.distCode.toUpperCase();
        const entry = perDist.get(code) ?? { code: row.distCode, name: row.distName, outlets: 0 };
        entry.outlets += 1;
        perDist.set(code, entry);
    }
    // Lampiran TANPA kolom distributor berarti daftarnya memang sudah khusus untuk kita —
    // surat seperti itu memang dikirim per distributor (URC "PROMO TOKO ONLINE ... SULAWESI 1"
    // sudah menyebut CV. SURYA PERKASA di kopnya). Yang punya kolom distributor WAJIB disaring:
    // di sana satu lampiran memuat outlet seluruh Indonesia.
    const tanpaKodeDist = perDist.size === 0;
    const outlets = tanpaKodeDist ? [...rows] : rows.filter((row) => row.distCode.toUpperCase() === wanted);
    return {
        kodeAju: head.kodeAju,
        program: head.program,
        distributors: [...perDist.values()].sort((a, b) => b.outlets - a.outlets || a.code.localeCompare(b.code)),
        outlets,
        tanpaKodeDist,
        skipped,
    };
}
