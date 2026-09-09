/*
 * Tujuan: Menjalankan sync harga jual + satuan Accurate dari baris perintah.
 * Caller: manual. Pakai:
 *         npx tsx --env-file=.env.local scripts/sync-item-selling-price.ts [--limit=N] [--restart]
 * Dependensi: lib/item-price-sync (seluruh logikanya ada di sana).
 * Main Functions: run — parsing argumen + cetak progres.
 * Side Effects: lihat lib/item-price-sync.
 *
 * Logikanya sengaja TIDAK tinggal di sini: skrip tidak ikut ke image produksi (build standalone
 * hanya membawa .next), sedangkan produksi tetap perlu menjalankan sync yang sama lewat
 * app/api/cron/sync-item-prices. Satu sumber logika, dua pintu masuk.
 */
import { syncItemPrices } from "@/lib/item-price-sync";

async function run() {
    const args = process.argv.slice(2);
    const limitArg = args.find((a) => a.startsWith("--limit="));
    const result = await syncItemPrices({
        limit: limitArg ? Number(limitArg.slice(8)) : undefined,
        restart: args.includes("--restart"),
        log: (message) => console.log(message),
    });

    if (!result.ok) {
        console.error("Gagal:", result.error);
        process.exit(1);
    }
    console.log(`Selesai: ${result.processed} item diproses, ${result.priceRows} baris harga, `
        + `${result.skipped} item tanpa detail, ${(result.durationMs / 1000).toFixed(0)} detik.`
        + (result.done ? "" : ` Sisa ${result.remaining} item — jalankan lagi untuk melanjutkan.`));
    process.exit(0);
}

run();
