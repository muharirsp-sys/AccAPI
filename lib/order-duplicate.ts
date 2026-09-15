/*
 * Tujuan: Mengenali ORDER YANG DIDUGA GANDA — outlet yang sama, barang yang MIRIP tetapi tidak
 *         persis sama. Order seperti itu wajib dikonfirmasi admin sebelum diproses.
 * Caller: app/api/principal-order/validate (Order Principal).
 * Dependensi: tidak ada. Main Functions: findDuplicate. Murni — tanpa DB dan tanpa jaringan.
 *
 * KEMBARAN `python_backend/order_duplicate.py`, yang menjaga Order Sales dan Order Masuk.
 * Keduanya WAJIB menjawab sama, dan itu dikunci dengan contoh angka yang SAMA PERSIS di kedua
 * berkas ujinya. Kalau aturannya berubah di satu sisi, ubah juga di sisi lain — dua jawaban
 * berbeda tentang "apakah order ini ganda" lebih buruk daripada tidak punya pemeriksaan.
 *
 * KENAPA "MIRIP", BUKAN "SAMA PERSIS".
 * Order ganda yang isinya identik masih mungkin ketahuan mata. Yang berbahaya justru yang
 * hampir sama: satu order diketik ulang karena yang pertama dikira gagal, lalu satu barang
 * ditambah atau jumlahnya diubah. Dua-duanya lalu terlihat sebagai order yang berbeda, dan
 * dua-duanya diproses. Barangnya keluar gudang dua kali.
 *
 * KENAPA CONTAINMENT, BUKAN JACCARD.
 * Order 3 barang yang seluruhnya ada di dalam order 10 barang punya Jaccard 0,3 — terlihat
 * tidak mirip — padahal ia justru bentuk ketikan ulang yang paling khas: sebagian isi order
 * pertama dimasukkan lagi. Containment (irisan dibagi yang TERKECIL) membacanya 1,0.
 *
 * YANG TIDAK DILAKUKAN DI SINI: memutuskan. Modul ini hanya menjawab "mirip dengan yang mana,
 * seberapa". Menahan atau meloloskan adalah wewenang pemanggil, dan konfirmasinya wewenang
 * manusia.
 */

/** Satu order yang dibandingkan. `key` dikembalikan apa adanya supaya ordernya bisa ditunjuk. */
export type OrderFingerprint = {
    key: string;
    outlet: string;
    /** yyyy-MM-dd. Jendela bandingnya tanggal yang SAMA; lihat catatan di `findDuplicate`. */
    orderDate: string;
    itemCodes: string[];
};

export type DuplicateHit = {
    /** Order lain yang mirip. */
    key: string;
    /** Kode barang yang sama-sama ada pada keduanya. */
    shared: string[];
    /** Irisan dibagi jumlah barang order TERKECIL. 1 = seluruh isi yang kecil ada di yang besar. */
    containment: number;
    /** Kedua order membawa barang yang persis sama. */
    identical: boolean;
};

/**
 * Ambang kemiripan bawaan.
 *
 * ponytail: satu angka, dan sengaja dijadikan parameter supaya bisa digeser tanpa membedah
 * logikanya. 0,5 berarti "setengah isi order yang lebih kecil sudah pernah diorder outlet ini
 * pada hari yang sama". Digeser naik = lebih sedikit yang ditahan dan lebih banyak yang lolos;
 * digeser turun = lebih banyak konfirmasi yang harus dikerjakan admin.
 */
export const DUPLICATE_THRESHOLD = 0.5;

const bersih = (value: string) => String(value ?? "").trim().toUpperCase();

const himpunan = (codes: string[]) => new Set(codes.map(bersih).filter(Boolean));

/**
 * Order lain yang PALING mirip dengan `candidate`, atau null.
 *
 * Jendela bandingnya TANGGAL YANG SAMA di outlet yang sama. Bukan tujuh hari: outlet memang
 * wajar memesan barang yang sama minggu depan, dan menahan pesanan rutin akan membuat
 * konfirmasinya kehilangan arti — yang ditahan terlalu sering akan dilewati tanpa dibaca.
 * Kalau suatu saat perlu lebih lebar, lebarkan di sini, bukan dengan menurunkan ambangnya.
 *
 * Yang dikembalikan adalah yang TERKUAT: containment tertinggi, lalu irisan terbanyak. Satu
 * order hanya perlu satu alasan untuk ditahan, dan alasan terkuat yang paling mudah diperiksa.
 */
export function findDuplicate(
    candidate: OrderFingerprint, existing: OrderFingerprint[], threshold = DUPLICATE_THRESHOLD,
): DuplicateHit | null {
    const aku = himpunan(candidate.itemCodes);
    if (aku.size === 0) return null;
    const outlet = bersih(candidate.outlet);
    const tanggal = String(candidate.orderDate ?? "").slice(0, 10);
    if (!outlet || !tanggal) return null;

    let terkuat: DuplicateHit | null = null;
    for (const lain of existing) {
        if (lain.key === candidate.key) continue;
        if (bersih(lain.outlet) !== outlet) continue;
        if (String(lain.orderDate ?? "").slice(0, 10) !== tanggal) continue;
        const dia = himpunan(lain.itemCodes);
        if (dia.size === 0) continue;
        const shared = [...aku].filter((code) => dia.has(code)).sort();
        if (!shared.length) continue;
        const containment = shared.length / Math.min(aku.size, dia.size);
        if (containment < threshold) continue;
        const hit: DuplicateHit = {
            key: lain.key, shared, containment,
            identical: aku.size === dia.size && shared.length === aku.size,
        };
        if (!terkuat || hit.containment > terkuat.containment
            || (hit.containment === terkuat.containment && hit.shared.length > terkuat.shared.length)) {
            terkuat = hit;
        }
    }
    return terkuat;
}

/**
 * Kalimat yang dibaca admin. Disusun di sini supaya kedua jalur (dan kembaran Python-nya)
 * menyebut hal yang sama dengan kata yang sama — yang membaca temuan ini bukan yang menulis
 * kodenya, dan ia harus bisa langsung tahu order mana yang harus dibuka untuk dibandingkan.
 */
export function duplicateFinding(hit: DuplicateHit, sebutan = "Order"): string {
    const persen = Math.round(hit.containment * 100);
    return hit.identical
        ? `${sebutan} ini membawa barang yang PERSIS SAMA dengan ${hit.key} pada outlet dan tanggal yang sama. `
            + "Pastikan ini bukan order ganda sebelum diproses."
        : `${sebutan} ini mirip ${persen}% dengan ${hit.key} pada outlet dan tanggal yang sama `
            + `(${hit.shared.length} barang sama: ${hit.shared.slice(0, 8).join(", ")}). `
            + "Mirip tetapi tidak sama persis justru bentuk ketikan ulang yang paling sering lolos — "
            + "konfirmasi dulu bahwa ini bukan order ganda.";
}
