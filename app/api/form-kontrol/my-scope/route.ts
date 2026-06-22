import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { resolveScope } from "@/lib/form-kontrol";

export async function GET() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const scope = await resolveScope(session);
        return NextResponse.json(scope);
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
