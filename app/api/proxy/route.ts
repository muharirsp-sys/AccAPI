import { NextRequest, NextResponse } from "next/server";
import { isAllowedAccurateHost, requireApiSession } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";

export async function POST(req: NextRequest) {
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { endpointPath, method, payload } = body;
        const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
        const sessionHost = accurateSession?.sessionHost;
        const sessionId = accurateSession?.sessionId;
        const apiKey = accurateSession?.accessToken;

        if (!endpointPath || !method || !sessionHost || !sessionId || !apiKey) {
            return NextResponse.json({ error: "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu." }, { status: 400 });
        }
        if (!isAllowedAccurateHost(sessionHost)) {
            return NextResponse.json({ error: "Session host Accurate tidak diizinkan" }, { status: 400 });
        }

        // Berdasarkan Swagger, Base URL Accurate adalah https://{host}/accurate
        const baseUrl = `${sessionHost}/accurate/api`;
        let url = `${baseUrl}${endpointPath.replace("/api", "")}`;

        // Handle GET method query strings
        if (method.toUpperCase() === "GET" && payload) {
            const query = new URLSearchParams();
            Object.keys(payload as Record<string, unknown>).forEach((key) => {
                const val = (payload as Record<string, unknown>)[key];
                if (val !== undefined && val !== null) {
                    query.append(key, String(val));
                }
            });
            // Accurate API doesn't parse %2C properly for comma-separated fields, it expects literal commas
            url = `${url}?${query.toString().replace(/%2C/g, ',')}`;
        }

        // Helper untuk nge-flatten JSON bersarang atau array ke dalam format properti dot/bracket (data[0].key)
        const flattenPayload = (obj: unknown, prefix = ''): Record<string, unknown> => {
            const result: Record<string, unknown> = {};
            if (typeof obj !== "object" || obj === null) return result;
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const source = obj as Record<string, unknown>;
                    const newKey = prefix ? (Array.isArray(obj) ? `${prefix}[${key}]` : `${prefix}.${key}`) : key;
                    if (typeof source[key] === 'object' && source[key] !== null && !(source[key] instanceof Date)) {
                        Object.assign(result, flattenPayload(source[key], newKey));
                    } else {
                        result[newKey] = source[key];
                    }
                }
            }
            return result;
        };

        let finalBody: string | undefined = undefined;

        if (method.toUpperCase() !== "GET" && payload) {
            // Jika payload adalah Array (misal hasil Excel) dan endpoint adalah bulk-save,
            // Accurate memaksa bentuk { "data[0].field": "value", "data[1].field": "value" }
            if (endpointPath.includes("bulk-save.do") && Array.isArray(payload)) {
                 const flatObj = flattenPayload(payload, 'data');
                 finalBody = JSON.stringify(flatObj);
            } else {
                 finalBody = JSON.stringify(payload);
            }
        }

        // Audit F5: log tanpa query string (bisa berisi data bisnis); timeout 30s agar
        // request menggantung ke Accurate tidak menahan koneksi tanpa batas.
        console.log(`[PROXY FIRE] ${method.toUpperCase()} ${endpointPath}`);

        const response = await fetch(url, {
            method: method.toUpperCase(),
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Authorization": `Bearer ${apiKey}`,
                "X-Session-ID": sessionId,
            },
            body: finalBody,
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
        });

        const rawText = await response.text();
        let data: unknown;

        try {
            data = JSON.parse(rawText);
        } catch (e) {
            console.error("[ACCURATE API RETURNED NON-JSON]", rawText);
            return NextResponse.json({ error: "Accurate mengembalikan respons non-JSON (Gagal)", detail: rawText.substring(0, 1000) }, { status: 502 });
        }

        // SERVER LOG FOR DEBUGGING
        const accurateResult = data as { s?: boolean };
        if (!response.ok || !accurateResult.s) {
            console.error("[ACCURATE API ERROR FORMAT JSON]", JSON.stringify(data, null, 2));
        }

        return NextResponse.json(data);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return NextResponse.json({ error: "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi." }, { status: 504 });
        }
        console.error("[PROXY SERVER INTERNAL ERROR]", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy request failed" }, { status: 500 });
    }
}
