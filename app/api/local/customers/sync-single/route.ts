import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { customer } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { cookies } from "next/headers";

function extractErrorMessage(err: any): string {
    if (err?.response?.data?.d?.[0]) return err.response.data.d[0];
    if (err?.message) return err.message;
    return "Terjadi kesalahan pada server Accurate";
}

async function accurateFetchServer(path: string, method: string, payload: any) {
    const cookieStore = await cookies();
    const token = cookieStore.get('accurate_token')?.value;
    const host = cookieStore.get('accurate_host')?.value;
    const sessionToken = cookieStore.get('accurate_session')?.value;

    if (!host || !sessionToken || !token) {
       throw new Error("Missing Accurate Session locally. Need to relogin via Dashboard.");
    }

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${host}${cleanPath}`);
    
    // Add OAuth auth
    url.searchParams.append('access_token', token);

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${sessionToken}`,
        'X-Session-ID': sessionToken
    };

    if (method === 'GET') {
        if (payload) {
            for (const key in payload) {
                if (payload.hasOwnProperty(key)) {
                    url.searchParams.append(key, String(payload[key]));
                }
            }
        }
        const res = await fetch(url.toString(), { method: 'GET', headers });
        const data = await res.json();
        if (!data.s) throw new Error(extractErrorMessage({response: {data}}));
        return data;
    }
    return null;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { id } = body;
        if (!id) return NextResponse.json({ ok: false, error: "Missing ID" }, { status: 400 });

        // Force fetch single customer from Accurate API
        const payload = {
            fields: "id,customerNo,name,balance", // Base required fields for table
            "filter.id.op": "EQUAL",
            "filter.id.val": id
        };

        const response = await accurateFetchServer("/api/customer/list.do", "GET", payload);
        
        if (response && response.d && response.d.length > 0) {
            const row = response.d[0];
            
            // Re-fetch detail for raw data
            const detailRes = await accurateFetchServer("/api/customer/detail.do", "GET", { id });
            let rawData = row;
            if (detailRes && detailRes.d && detailRes.d.length > 0) {
                 rawData = detailRes.d[0];
            }

            // Upsert SQLite
            await db.insert(customer).values({
                id: row.id,
                customerNo: row.customerNo || "UNKNOWN",
                name: row.name || "Unnamed",
                balance: row.balance || 0,
                rawData: rawData,
                lastUpdate: new Date().toISOString()
            }).onConflictDoUpdate({
                target: customer.id,
                set: {
                    customerNo: row.customerNo || "UNKNOWN",
                    name: row.name || "Unnamed",
                    balance: row.balance || 0,
                    rawData: rawData,
                    lastUpdate: new Date().toISOString()
                }
            });

            return NextResponse.json({ ok: true });
        }
        
        return NextResponse.json({ ok: false, error: "Not found in Accurate after creation." });

    } catch (error: any) {
        console.error("Single Sync Customer Error:", error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
