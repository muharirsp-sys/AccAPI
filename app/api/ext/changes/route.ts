/**
 * Tujuan: Delta feed satu-satunya dari Web Internal ke Web Sales — Sales menarik perubahan
 *         sejak cursor terakhir, bukan Internal yang push. Satu endpoint untuk semua entitas.
 * Caller: Web Sales (worker sync, interval 15-30s) via VPN antar server.
 * Dependensi: lib/api-security.ts (requireExtToken), lib/ext-sync.ts (cursor), db/schema.ts.
 * Main Functions: GET — keyset pagination atas (synced_at, id).
 * Side Effects: read-only.
 *
 * Kontrak: GET /api/ext/changes?entity=item&since=<cursor>&limit=500
 *          -> { ok, entity, items[], nextCursor, hasMore }
 * Sales simpan `nextCursor` dan kirim balik sebagai `since` di siklus berikutnya. Kalau Sales
 * mati seminggu, siklus pertama saat hidup lagi menyusul sendiri dari cursor lama — tanpa
 * outbox, tanpa retry queue, tanpa event yang hilang.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { item, customer, salesInvoiceCache, salesReturnCache } from "@/db/schema";
import { requireExtToken } from "@/lib/api-security";
import { clampLimit, formatCursor, parseCursor } from "@/lib/ext-sync";

// Whitelist eksplisit: mencegah entity= sembarang membocorkan tabel user/session, dan
// proyeksi kolom per entitas memastikan raw_data (payload Accurate utuh) TIDAK ikut keluar.
const ENTITIES = {
    item: {
        table: item,
        columns: {
            id: item.id, no: item.no, name: item.name, itemType: item.itemType, unitPrice: item.unitPrice,
            quantity: item.quantity, quantityInAllUnit: item.quantityInAllUnit,
        },
    },
    customer: {
        table: customer,
        columns: {
            id: customer.id, customerNo: customer.customerNo, name: customer.name, balance: customer.balance,
            creditLimitEnabled: customer.creditLimitEnabled, creditLimitAmount: customer.creditLimitAmount,
            creditAgeLimitEnabled: customer.creditAgeLimitEnabled, creditAgeLimitDays: customer.creditAgeLimitDays,
        },
    },
    sales_invoice: {
        table: salesInvoiceCache,
        columns: {
            id: salesInvoiceCache.id, number: salesInvoiceCache.number, transDate: salesInvoiceCache.transDate,
            dueDate: salesInvoiceCache.dueDate, customerNo: salesInvoiceCache.customerNo,
            customerName: salesInvoiceCache.customerName, totalAmount: salesInvoiceCache.totalAmount,
            // outstanding: SELALU null — Accurate list.do tidak mengekspos field ini (lihat db/schema.ts).
            status: salesInvoiceCache.status, age: salesInvoiceCache.age,
        },
    },
    sales_return: {
        table: salesReturnCache,
        columns: {
            id: salesReturnCache.id, number: salesReturnCache.number, transDate: salesReturnCache.transDate,
            customerNo: salesReturnCache.customerNo, totalAmount: salesReturnCache.totalAmount,
            status: salesReturnCache.status,
        },
    },
} as const;

type EntityName = keyof typeof ENTITIES;

export async function GET(request: NextRequest) {
    const gate = requireExtToken(request);
    if (gate.response) return gate.response;

    const params = new URL(request.url).searchParams;
    const entity = params.get("entity") as EntityName | null;
    if (!entity || !(entity in ENTITIES)) {
        return NextResponse.json(
            { ok: false, error: `entity wajib salah satu dari: ${Object.keys(ENTITIES).join(", ")}` },
            { status: 400 }
        );
    }

    const rawSince = params.get("since");
    const cursor = rawSince === null ? null : parseCursor(rawSince);
    if (rawSince !== null && cursor === null) {
        return NextResponse.json(
            { ok: false, error: "since tidak valid — format: <ISO8601>|<id>" },
            { status: 400 }
        );
    }

    const limit = clampLimit(params.get("limit"));
    const { table, columns } = ENTITIES[entity];

    // Ambil limit+1 baris untuk mendeteksi hasMore tanpa COUNT(*) terpisah.
    const rows = await db
        .select({ ...columns, syncedAt: table.syncedAt })
        .from(table)
        .where(cursor ? sql`(${table.syncedAt}, ${table.id}) > (${cursor.syncedAt}, ${cursor.id})` : sql`true`)
        .orderBy(asc(table.syncedAt), asc(table.id))
        .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return NextResponse.json({
        ok: true,
        entity,
        items: page.map(({ syncedAt: _syncedAt, ...rest }) => rest),
        nextCursor: last ? formatCursor({ syncedAt: last.syncedAt, id: Number(last.id) }) : rawSince,
        hasMore,
    });
}
