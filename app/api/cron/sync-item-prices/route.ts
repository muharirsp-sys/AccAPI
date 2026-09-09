/*
 * Tujuan: Menjalankan sync harga jual + satuan Accurate di produksi, berbatch.
 * Caller: /usr/local/bin/accapi-cron.sh (Bearer CRON_SECRET), manual saat harga berubah.
 * Dependensi: lib/item-price-sync, lib/api-security (gerbang cron).
 * Main Functions: GET.
 * Side Effects: Tulis item_selling_price + kolom satuan item + sync_state.
 *
 * Kenapa berbatch: sync penuh 4.182 item butuh ~21 menit, dan satu request HTTP sepanjang itu
 * rapuh (proxy, restart container, timeout). Default 600 item per panggilan; checkpoint di
 * `sync_state` membuat panggilan berikutnya melanjutkan, bukan mengulang. Respons memberi
 * `done` dan `remaining` supaya pemanggil tahu perlu memanggil lagi atau tidak.
 */
import { NextResponse } from "next/server";
import { syncItemPrices } from "@/lib/item-price-sync";
import { requireCronSecret } from "@/lib/api-security";

export const runtime = "nodejs";
export const maxDuration = 3000;

const DEFAULT_BATCH = 600;

export async function GET(request: Request) {
    const gate = requireCronSecret(request);
    if (gate.response) return gate.response;

    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : DEFAULT_BATCH;
    const restart = url.searchParams.get("restart") === "1";

    const result = await syncItemPrices({ limit, restart });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
