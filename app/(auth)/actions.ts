"use server";

import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function checkUserStatus(email: string) {
    try {
        const found = await db.select().from(user).where(eq(user.email, email.toLowerCase())).limit(1);
        
        if (found.length === 0) {
            return { exists: false, verified: false };
        }

        return { exists: true, verified: found[0].emailVerified };
    } catch (e) {
        console.error(e);
        return { exists: false, verified: false, error: true };
    }
}
