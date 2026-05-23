import { NextResponse } from "next/server";
import { offPrinciples } from "@/lib/off-program-control";

export async function GET() {
    return NextResponse.json({ ok: true, principles: offPrinciples });
}
