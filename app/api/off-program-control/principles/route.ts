import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-security";
import { offPrinciples } from "@/lib/off-program-control";

export async function GET(request: Request) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    return NextResponse.json({ ok: true, principles: offPrinciples });
}
