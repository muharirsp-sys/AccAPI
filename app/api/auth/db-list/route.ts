import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('access_token');

    if (!token) {
        return NextResponse.json({ error: "Missing access_token" }, { status: 400 });
    }

    try {
        const response = await fetch("https://account.accurate.id/api/db-list.do", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            return NextResponse.json({ error: "Failed to fetch db-list", details: errText }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);
    } catch (err: any) {
        return NextResponse.json({ error: "Internal Server Error", message: err.message }, { status: 500 });
    }
}
