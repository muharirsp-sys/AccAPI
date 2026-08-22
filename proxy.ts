/*
 * Tujuan: Menyediakan path request saat ini ke server layout untuk guard RBAC per halaman.
 * Caller: Next.js proxy runtime sebelum route dashboard/render.
 * Dependensi: NextRequest dan NextResponse.
 * Main Functions: proxy, config.matcher.
 * Side Effects: Menambah header internal `x-current-path` pada request downstream.
 */
import { NextRequest, NextResponse } from "next/server";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";

export function proxy(request: NextRequest) {
    if (request.nextUrl.pathname === "/login" && isLocalAuthBypassEnabled(request.headers)) {
        return NextResponse.redirect(new URL("/", request.url));
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-current-path", request.nextUrl.pathname);
    return NextResponse.next({
        request: {
            headers: requestHeaders,
        },
    });
}

export const config = {
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sw.js|manifest.json).*)"],
};
