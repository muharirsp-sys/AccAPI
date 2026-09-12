/*
 * Tujuan: Mengubah baris batch laporan principal yang SUDAH lolos validasi menjadi calon
 *         faktur — satu SO = satu faktur — dalam bentuk yang dimengerti buildInvoicePayload.
 * Caller: app/api/principal-order/queue.
 * Dependensi: lib/principal-validation (diskon bertingkat), lib/accurate-invoice-write (tipe).
 * Main Functions: invoiceKey, groupCandidates.
 * Side Effects: Tidak ada — murni, tanpa DB dan tanpa jaringan.
 *
 * Dua aturan yang menentukan bentuk berkas ini:
 *
 * 1. Satu SO ditolak UTUH begitu ada SATU barisnya yang belum lolos validasi. Faktur separuh
 *    isi adalah faktur salah, dan faktur yang terlanjur masuk Accurate tidak bisa ditarik.
 * 2. Kunci antrean adalah PRINCIPAL + NOMOR SO, bukan id batch. Berkas laporan bisa ditarik
 *    ulang kapan saja dan SO yang sama muncul lagi di batch lain; kalau kuncinya id batch,
 *    SO itu akan difakturkan dua kali. Dengan kunci SO, unggahan kedua langsung bentrok di
 *    primary key `invoice_outbox` dan dilewati.
 */
import { splitDiscounts, type DiscountAt } from "@/lib/principal-validation";
import type { InvoiceOrder } from "@/lib/accurate-invoice-write";

export type BatchLine = {
    rowNumber: number;
    soNo: string;
    soDate: string | null;
    customerNo: string | null;
    customerName: string;
    customerType: string;
    itemCode: string | null;
    unit: string;
    qty: string;
    price: string;
    discounts: DiscountAt[];
    status: string;
};

export type Candidate = {
    key: string;
    soNo: string;
    customerNo: string;
    orderDate: string;
    lineCount: number;
    gross: number;
    net: number;
    order: InvoiceOrder;
};

export type SkippedSo = { soNo: string; reason: string };

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Rantai persen yang POSISINYA terjaga: setiap slot sampai posisi terisi tertinggi diisi,
 * yang kosong jadi "0". Diskon yang di laporan berupa RUPIAH tidak punya tempat di rantai
 * persen — nominalnya dikirim terpisah — jadi slotnya tetap "0" dan rantainya boleh kosong.
 */
export function percentChain(discounts: DiscountAt[]): string[] {
    const byPercent = discounts.filter((entry) => entry.amount === undefined);
    if (byPercent.length === 0) return [];
    const last = Math.max(...byPercent.map((entry) => entry.position));
    const chain: string[] = [];
    for (let position = 1; position <= last; position += 1) {
        const found = byPercent.find((entry) => entry.position === position);
        chain.push(found ? String(found.percent) : "0");
    }
    return chain;
}

/** Kunci antrean; sengaja tidak memuat id batch (lihat catatan kepala berkas). */
export function invoiceKey(principal: string, soNo: string): string {
    return `${principal.trim().toUpperCase().replace(/\s+/g, "-")}:${soNo.trim()}`;
}

/**
 * Baris batch -> calon faktur per SO. Yang ditolak dikembalikan dengan ALASANNYA, bukan
 * dibuang diam-diam: admin harus tahu SO mana yang tidak ikut dan kenapa.
 */
export function groupCandidates(
    principal: string,
    lines: BatchLine[],
    options: { fallbackDate: string; batchLabel?: string },
): { candidates: Candidate[]; skipped: SkippedSo[] } {
    const bySo = new Map<string, BatchLine[]>();
    for (const line of lines) {
        const so = line.soNo.trim();
        if (!bySo.has(so)) bySo.set(so, []);
        bySo.get(so)!.push(line);
    }

    const candidates: Candidate[] = [];
    const skipped: SkippedSo[] = [];

    for (const [soNo, rows] of bySo) {
        if (!soNo) { skipped.push({ soNo: "(tanpa nomor)", reason: `${rows.length} baris tanpa nomor SO` }); continue; }

        const notOk = rows.filter((row) => row.status !== "ok");
        if (notOk.length > 0) {
            skipped.push({ soNo, reason: `${notOk.length} dari ${rows.length} baris belum lolos validasi` });
            continue;
        }
        const customers = [...new Set(rows.map((row) => row.customerNo ?? ""))];
        if (customers.length !== 1 || !customers[0]) {
            skipped.push({ soNo, reason: `pelanggan tidak tunggal (${customers.filter(Boolean).join(", ") || "kosong"})` });
            continue;
        }
        const tanpaBarang = rows.filter((row) => !row.itemCode);
        if (tanpaBarang.length > 0) {
            skipped.push({ soNo, reason: `${tanpaBarang.length} baris tanpa kode barang internal` });
            continue;
        }
        const orderDate = rows.find((row) => row.soDate)?.soDate ?? options.fallbackDate;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
            // Tanggal faktur tidak boleh ditebak: salah tanggal = salah periode pembukuan.
            skipped.push({ soNo, reason: `tanggal SO tidak terbaca (${orderDate || "kosong"})` });
            continue;
        }

        let gross = 0;
        let net = 0;
        const resultLines = rows.map((row) => {
            const quantity = Number(row.qty);
            const price = Number(row.price);
            const rowGross = cents(quantity * price);
            // Diskon bertingkat, sama persis dengan yang dipakai gerbang validasi: tiap posisi
            // memotong SISA. Menjumlahkan persennya memberi angka yang berbeda.
            const split = splitDiscounts(rowGross, row.discounts);
            const rowNet = cents(rowGross - split.total);
            gross = cents(gross + rowGross);
            net = cents(net + rowNet);
            // Potongan yang di laporan memang berupa RUPIAH (potongan tingkat faktur yang
            // dibagi rata) dikirim sebagai rupiah, bukan dipaksa jadi persen: membulatkan ulang
            // dari persen hasil pembagian bisa meleset beberapa rupiah dari yang dilaporkan
            // principal, dan selisih itulah yang nanti ditandai verifikasi balik sebagai salah.
            const sorted = [...row.discounts].sort((a, b) => a.position - b.position);
            const cash = cents(sorted.reduce((total, entry) => total + (entry.amount ?? 0), 0));
            return {
                code: row.itemCode!,
                unit: row.unit,
                quantity: String(quantity),
                gross: rowGross.toFixed(2),
                net: rowNet.toFixed(2),
                // Rantai persen dikirim LENGKAP DENGAN NOLNYA ("0+0+0+3"), persis seperti
                // Power Query admin yang selama ini dipakai ("d1+d2+d3+d4+d5" digabung `+`).
                // POSISI menentukan siapa menanggung: 1-3 distributor, 4-5 klaim principal.
                // Memampatkan rantainya jadi "3" memindahkan klaim principal ke posisi 1, dan
                // faktur itu lalu terbaca sebagai tanggungan distributor oleh siapa pun yang
                // membacanya kembali — Rekap Promo, laporan klaim, maupun pemeriksa. Terbukti
                // pada INV/2609/KN00450 (12 Sep 2026): klaim Rp 28.921 tersimpan sebagai 3% di
                // posisi 1. Uang yang bisa ditagihkan berubah jadi biaya sendiri, tanpa galat.
                percents: percentChain(sorted),
                cash: String(cash),
                price: String(price),
            };
        });

        const key = invoiceKey(principal, soNo);
        candidates.push({
            key, soNo, customerNo: customers[0], orderDate, lineCount: rows.length, gross, net,
            order: {
                id: key,
                customer_no: customers[0],
                outlet: rows[0].customerName,
                channel: rows[0].customerType,
                order_date: orderDate,
                status: "validated",
                note: options.batchLabel ?? "",
                lines: rows.map((row) => ({ code: row.itemCode!, unit: row.unit, quantity: String(Number(row.qty)), price: String(Number(row.price)) })),
                sources: [],
                result: { lines: resultLines },
            },
        });
    }

    return { candidates, skipped };
}
