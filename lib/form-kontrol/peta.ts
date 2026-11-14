/*
 * Tujuan: Petunjuk arah toko untuk jadwal kunjungan harian (owner 14 Nov 2026, butir 1 "tiap toko ada tombol buka Google Maps … bisa dicetak atau
 *   dibagikan ke sales"): tautan Google Maps per toko, alamat ringkas, teks rute untuk WhatsApp, dan halaman cetak rute.
 *   Titik = toko_koordinat (GPS lapangan dari JKS Web-LL / unggahan Koordinat Toko). Toko tanpa titik = pencarian nama + alamat di Google Maps
 *   (titik perkiraan Web-LL sengaja tidak disimpan sebagai koordinat).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabAo.tsx, app/(dashboard)/form-kontrol/visit/[custCode]/Kunjungan.tsx; uji ./peta.test.ts.
 * Main Functions: punyaTitik, alamatRingkas, urlPeta, teksRute, htmlRute. Side Effects: tidak ada (murni, aman di klien).
 */

export type TokoPeta = {
    custCode: string; custName: string; market?: string | null; alamat?: string | null; kota?: string | null;
    lat?: number | null; lng?: number | null; urutan?: number | null; kelasA?: boolean | null; targetToko?: number | null; omzetRata?: number | null;
    /** Realisasi faktur Accurate bulan berjalan (termasuk PPN) + jumlah faktur; null = tidak diketahui. */
    realisasiBulan?: number | null; fakturBulan?: number | null;
};

export function punyaTitik(t: Pick<TokoPeta, "lat" | "lng">): t is { lat: number; lng: number } {
    return typeof t.lat === "number" && typeof t.lng === "number" && Number.isFinite(t.lat) && Number.isFinite(t.lng);
}

const rapi = (v?: string | null) => (v ?? "").replace(/\s+/g, " ").trim();

/** Alamat tanpa pengulangan: pasar/jalan dan kota dibuang bila sudah termuat di alamat. */
export function alamatRingkas(t: Pick<TokoPeta, "market" | "alamat" | "kota">): string {
    const alamat = rapi(t.alamat), market = rapi(t.market), kota = rapi(t.kota);
    const besar = alamat.toUpperCase();
    return [market && !besar.includes(market.toUpperCase()) ? market : "", alamat, kota && !besar.includes(kota.toUpperCase()) ? kota : ""]
        .filter(Boolean).join(", ");
}

/** Google Maps: ada titik = petunjuk arah dari posisi ponsel ke titik toko; tanpa titik = pencarian nama toko + alamat. */
export function urlPeta(t: TokoPeta): string {
    if (punyaTitik(t)) return `https://www.google.com/maps/dir/?api=1&destination=${t.lat.toFixed(6)},${t.lng.toFixed(6)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([rapi(t.custName), alamatRingkas(t)].filter(Boolean).join(", "))}`;
}

const ringkas = (n: number) => new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(n);
/**
 * Realisasi bulan berjalan: "realisasi 750 rb (3 faktur, 50% target)" / "belum ada faktur <bulan>"; tidak diketahui (null) = "".
 * `bulan` = nama bulan tanggal rute (bawaan "bulan ini") supaya tampilan tanggal lampau tidak menyebut "bulan ini".
 */
export function teksRealisasi(t: Pick<TokoPeta, "realisasiBulan" | "fakturBulan" | "targetToko">, bulan = "bulan ini"): string {
    if (t.realisasiBulan == null) return "";
    if (!t.fakturBulan && !t.realisasiBulan) return `belum ada faktur ${bulan}`;
    const persen = t.targetToko ? `, ${Math.round((t.realisasiBulan / t.targetToko) * 100)}% target` : "";
    return `realisasi ${ringkas(t.realisasiBulan)} (${t.fakturBulan ?? 0} faktur${persen})`;
}

const keterangan = (t: TokoPeta, bulan?: string) => [t.kelasA ? "Kelas A" : "", t.targetToko ? `target ${ringkas(t.targetToko)}/bln` : "",
    teksRealisasi(t, bulan), t.omzetRata ? `omzet ±${ringkas(t.omzetRata)}/bln` : ""].filter(Boolean).join(" · ");

/** Teks rute untuk WhatsApp / bagikan: judul lalu tiap toko sesuai urutan (nama, alamat, target/omzet/Kelas A, tautan peta). */
export function teksRute(judul: string, toko: TokoPeta[], bulan?: string): string {
    return [judul, ...toko.map((t, i) => [`${t.urutan ?? i + 1}. ${rapi(t.custName)} (${t.custCode})`,
        ...[alamatRingkas(t), keterangan(t, bulan)].filter(Boolean).map((x) => `   ${x}`),
        `   Peta: ${urlPeta(t)}${punyaTitik(t) ? "" : " (cari alamat)"}`].join("\n"))].join("\n\n");
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Halaman cetak rute (dibuka di jendela baru lalu window.print): tabel urutan, toko, alamat, target/omzet/Kelas A, tautan peta. */
export function htmlRute(judul: string, toko: TokoPeta[], bulan?: string): string {
    const baris = toko.map((t, i) => `<tr><td>${t.urutan ?? i + 1}</td><td><b>${esc(rapi(t.custName))}</b><br><small>${esc(t.custCode)}</small></td>`
        + `<td>${esc(alamatRingkas(t)) || "–"}</td><td>${esc(keterangan(t, bulan)) || "–"}</td>`
        + `<td><a href="${esc(urlPeta(t))}">${punyaTitik(t) ? "Buka peta" : "Cari alamat"}</a></td></tr>`).join("");
    return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(judul)}</title><style>`
        + "body{font:12px system-ui,sans-serif;margin:16px;color:#111}h1{font-size:15px;margin:0 0 8px}table{border-collapse:collapse;width:100%}"
        + "th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}small{color:#555}"
        + `</style></head><body><h1>${esc(judul)}</h1><table><thead><tr><th>#</th><th>Toko</th><th>Alamat</th><th>Keterangan</th><th>Peta</th></tr></thead>`
        + `<tbody>${baris}</tbody></table></body></html>`;
}
