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
 * Suratnya berlapis teks (dicetak dari sistem Kino, bukan scan), jadi tidak ada OCR di sini.
 * Surat hasil scan tidak akan menghasilkan baris apa pun, dan itu dilaporkan sebagai lampiran
 * kosong — bukan sebagai "tidak ada peserta", karena keduanya jauh berbeda artinya.
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
    /** Baris lampiran yang tidak terbaca sebagai baris outlet. Dilaporkan, bukan didiamkan. */
    skipped: number;
};

const field = (text: string, label: string) => {
    const match = new RegExp(`${label}\\s*:\\s*(.+)`, "i").exec(text);
    return match ? match[1].trim() : "";
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
    const wanted = distCode.trim();
    const head = pages[0] ?? "";
    const perDist = new Map<string, { code: string; name: string; outlets: number }>();
    const outlets: LetterOutlet[] = [];
    let skipped = 0;

    for (const page of pages.slice(1)) {
        for (const line of page.split(/\r?\n/)) {
            const tokens = line.trim().split(/\s+/).filter(Boolean);
            if (tokens.length < 4) continue;
            const distAt = tokens.findIndex((token) => DIST.test(token));
            if (distAt < 0) continue;
            const outletAt = tokens.findIndex((token, index) => index > distAt && OUTLET.test(token));
            if (outletAt < 0) { skipped += 1; continue; }

            const code = tokens[distAt];
            const distName = tokens.slice(distAt + 1, outletAt).join(" ");
            const entry = perDist.get(code) ?? { code, name: distName, outlets: 0 };
            entry.outlets += 1;
            perDist.set(code, entry);
            if (code !== wanted) continue;
            outlets.push({
                distCode: code, distName, outletCode: tokens[outletAt],
                label: tokens.slice(outletAt + 1).join(" "),
            });
        }
    }

    return {
        kodeAju: field(head, "Kode Aju"),
        program: field(head, "Nama Program Promo"),
        distributors: [...perDist.values()].sort((a, b) => b.outlets - a.outlets || a.code.localeCompare(b.code)),
        outlets,
        skipped,
    };
}
