import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { item } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { cookies } from "next/headers";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { id } = body;
        if (!id) return NextResponse.json({ ok: false, error: "Missing ID" }, { status: 400 });

        const cookieStore = await cookies();
        const token = cookieStore.get('accurate_token')?.value;
        const host = cookieStore.get('accurate_host')?.value;
        const sessionToken = cookieStore.get('accurate_session')?.value;

        if (!host || !sessionToken || !token) {
           throw new Error("Missing Accurate Session locally. Need to relogin via Dashboard.");
        }

        let queryParams = new URLSearchParams({
            access_token: token,
            "filter.id.op": "EQUAL",
            "filter.id.val": id.toString(),
            fields: "id,no,name,itemType,unitPrice"
        });

        const listUrl = new URL(`${host}/api/item/list.do?${queryParams.toString()}`);
        const listRes = await fetch(listUrl.toString(), {
            headers: { 'Authorization': `Bearer ${sessionToken}`, 'X-Session-ID': sessionToken }
        });
        const listData = await listRes.json();

        if (listData && listData.d && listData.d.length > 0) {
            const row = listData.d[0];
            
            // Detail Fetch
            let detailParams = new URLSearchParams({ access_token: token, id: id.toString() });
            const detailUrl = new URL(`${host}/api/item/detail.do?${detailParams.toString()}`);
            const detailResp = await fetch(detailUrl.toString(), {
                 headers: { 'Authorization': `Bearer ${sessionToken}`, 'X-Session-ID': sessionToken }
            });
            const detailJson = await detailResp.json();
            let rawData = row;
            if (detailJson && detailJson.d && detailJson.d.length > 0) rawData = detailJson.d[0];

            // Upsert SQLite
            await db.insert(item).values({
                id: row.id,
                no: row.no || "UNKNOWN",
                name: row.name || "Unnamed",
                itemType: row.itemType || "INVENTORY",
                unitPrice: row.unitPrice || 0,
                rawData: rawData,
                lastUpdate: new Date().toISOString()
            }).onConflictDoUpdate({
                target: item.id,
                set: {
                    no: row.no || "UNKNOWN",
                    name: row.name || "Unnamed",
                    itemType: row.itemType || "INVENTORY",
                    unitPrice: row.unitPrice || 0,
                    rawData: rawData,
                    lastUpdate: new Date().toISOString()
                }
            });

            return NextResponse.json({ ok: true });
        }
        
        return NextResponse.json({ ok: false, error: "Not found in Accurate after creation." });

    } catch (error: any) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
