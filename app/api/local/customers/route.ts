import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { customer } from '@/db/schema';
import { desc } from 'drizzle-orm';

export async function GET() {
    try {
        const customers = await db.select().from(customer).orderBy(desc(customer.lastUpdate)).limit(500);
        
        // Transform shape to match the old external API payload expectation for seamless table hydration
        const mapped = customers.map(c => {
            const raw = c.rawData as any || {};
            return {
                id: c.id,
                no: c.customerNo,
                name: c.name,
                email: raw.email || null,
                workPhone: raw.workPhone || null,
                balance: c.balance,
                suspended: raw.suspended || false
            };
        });

        return NextResponse.json({ ok: true, d: mapped });
    } catch (error: any) {
        console.error("Local DB Customer Fetch Error:", error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
}
