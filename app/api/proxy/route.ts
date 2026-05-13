import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { endpointPath, method, payload, sessionHost, sessionId, apiKey } = body;

        if (!endpointPath || !method || !sessionHost || !sessionId || !apiKey) {
            return NextResponse.json({ error: "Missing required parameters for proxy" }, { status: 400 });
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
        const flattenPayload = (obj: any, prefix = ''): Record<string, any> => {
            let result: Record<string, any> = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const newKey = prefix ? (Array.isArray(obj) ? `${prefix}[${key}]` : `${prefix}.${key}`) : key;
                    if (typeof obj[key] === 'object' && obj[key] !== null && !(obj[key] instanceof Date)) {
                        Object.assign(result, flattenPayload(obj[key], newKey));
                    } else {
                        result[newKey] = obj[key];
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

        console.log(`\n\n[PROXY FIRE] Method: ${method.toUpperCase()} | Target URL: ${url}`);

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
        });

        const rawText = await response.text();
        let data: any;

        try {
            data = JSON.parse(rawText);
            if (url.includes('sales-return/list.do') && data && data.d && data.d.length > 0) {
                 console.log("=== SALES RETURN API FIELDS ===");
                 console.log(Object.keys(data.d[0]));
                 console.log("=== DATA ===");
                 console.log(data.d[0]);
            }
        } catch (e) {
            console.error("[ACCURATE API RETURNED NON-JSON]", rawText);
            return NextResponse.json({ error: "Accurate mengembalikan respons non-JSON (Gagal)", detail: rawText.substring(0, 1000) }, { status: 502 });
        }

        // SERVER LOG FOR DEBUGGING
        if (!response.ok || !data.s) {
            console.error("[ACCURATE API ERROR FORMAT JSON]", JSON.stringify(data, null, 2));
        }

        return NextResponse.json(data);
    } catch (error: any) {
        console.error("[PROXY SERVER INTERNAL ERROR]", error);
        return NextResponse.json({ error: error.message || "Proxy request failed" }, { status: 500 });
    }
}
