/*
 * Tujuan: Membagi baris TTF menjadi halaman kertas, di server.
 * Caller: app/(cetak)/rekapan-nota/wave/[id]/ttf/page.tsx.
 * Dependensi: tidak ada (pure).
 * Main Functions: bagiHalamanTtf.
 * Side Effects: Tidak ada.
 *
 * Dipisah dari komponen halaman semata supaya bisa diuji tanpa menyentuh DB. Angkanya
 * DIUKUR dari render nyata, bukan ditebak: tebakan yang meleset membuat browser memecah
 * halaman lagi dan nomor "Halaman X dari Y" jadi bohong -- persis cacat yang sedang ditutup.
 *
 * Tinggi baris terukur 10,98mm HANYA KARENA nama outlet dipaksa satu baris (.ttf .outlet
 * white-space: nowrap). Tanpa itu nama panjang membungkus dan baris jadi 14,4mm -- tinggi
 * baris berhenti seragam, dan seluruh perhitungan di file ini kehilangan dasarnya. Kalau
 * suatu saat nama outlet boleh dua baris, angka di bawah WAJIB diukur ulang, bukan ditawar.
 *
 * Sisa ruang per halaman (mm), diukur pada A4 (273mm bersih setelah margin @page 12mm):
 *   halaman 2+ : 273 - kop 14,4 - thead 8,4 - tfoot 8,7 - jejak 10,4 = 231  -> anggaran 217
 *   halaman 1  : 265 - kop 26,3 - thead 8,4 - tfoot 8,7 - jejak 10,4 = 211  -> anggaran 203
 * Selisihnya sengaja disisakan: font di mesin lain bisa sedikit lebih tinggi.
 */
export const TINGGI_BARIS_MM = 11;
export const RUANG_ISI_MM = 217;        // halaman 2 dst
export const RUANG_ISI_HAL1_MM = 203;   // halaman 1 membawa blok angka besar
export const TINGGI_PARAF_MM = 21;      // blok tanda tangan, hanya di halaman terakhir

/**
 * Halaman terakhir harus muat blok paraf. Halaman mana yang terakhir baru diketahui SETELAH
 * membagi, jadi ruangnya tidak bisa dianggarkan di muka; barisnya digeser ke halaman baru
 * kalau tidak muat. Halaman baru itu pasti muat -- isinya sedikit.
 */
export function bagiHalamanTtf<T>(baris: T[]): T[][] {
    const halaman: T[][] = [];
    for (const r of baris) {
        const anggaran = halaman.length <= 1 ? RUANG_ISI_HAL1_MM : RUANG_ISI_MM;
        const akhir = halaman[halaman.length - 1];
        if (!akhir || (akhir.length + 1) * TINGGI_BARIS_MM > anggaran) halaman.push([r]);
        else akhir.push(r);
    }
    if (!halaman.length) return [[]];

    const anggaranAkhir = halaman.length === 1 ? RUANG_ISI_HAL1_MM : RUANG_ISI_MM;
    const akhir = halaman[halaman.length - 1];
    const sisaUntukParaf = anggaranAkhir - TINGGI_PARAF_MM;
    if (akhir.length * TINGGI_BARIS_MM > sisaUntukParaf) {
        const muat = Math.max(1, Math.floor(sisaUntukParaf / TINGGI_BARIS_MM));
        halaman.push(akhir.splice(muat));
    }
    return halaman;
}
