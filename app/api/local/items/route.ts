import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { item } from '@/db/schema';
import { desc } from 'drizzle-orm';

export async function GET() {
    try {
        const items = await db.select().from(item).orderBy(desc(item.lastUpdate)).limit(500);
        
        // Transform shape to match the old API payload expectation
        const mapped = items.map(c => {
            const raw = c.rawData as any || {};
            return {
                id: c.id,
                no: c.no,
                name: c.name,
                itemType: c.itemType,
                unitPrice: c.unitPrice,
                suspended: raw.suspended || false
            };
        });

        return NextResponse.json({ ok: true, d: mapped });
    } catch (error: any) {
        console.error("Local DB Item Fetch Error:", error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
