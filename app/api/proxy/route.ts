import { NextRequest, NextResponse } from "next/server";
import { isAllowedAccurateHost, requireApiSession } from "@/lib/api-security";
import { getAccurateSession, redactAccurateSecrets } from "@/lib/accurate-session";
import { accurateTimeoutMessage, bacaAccurate, forwardAccurate, isAccurateRead, isCatalogWrite, isGuardedAccurateWrite, isSalesInvoiceWrite, isSalesReceiptWrite } from "@/lib/accurate-forward";
import { authorizeSalesReceiptWrite, checkSalesReceiptWrite, databaseLockBerbeda, sendSalesReceipt, type SalesReceiptDispatch } from "@/lib/sales-receipt-guard";
import { db } from "@/lib/db";
import { memuatPlaceholderAkun } from "@/lib/sales-receipt-upload";
import { periksaRiwayatAccurate, targetRiwayat } from "@/lib/pelunasan/pratinjau-ganda";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export async function POST(req: NextRequest) {
    let requestMethod = "";
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { endpointPath, method, payload } = body;
        requestMethod = typeof method === "string" ? method : "";
        if (typeof endpointPath !== "string" || typeof method !== "string") {
            return NextResponse.json({ error: "endpointPath dan method wajib teks" }, { status: 400 });
        }
        // AM-014 / C.14: tulis purchase-payment hanya lewat command server yang mengklaim attempt
        // sebelum kirim; lewat proxy generik guard pengiriman ganda bisa dilewati.
        if (endpointPath && isGuardedAccurateWrite(String(endpointPath))) {
            return NextResponse.json({
                error: "Posting purchase-payment hanya lewat halaman Finance (pencegahan posting ganda). Proxy generik menolak operasi ini.",
                code: "PURCHASE_PAYMENT_VIA_FINANCE", sent: false,
            }, { status: 403 });
        }
        // S6-0d E4 (owner 9 Okt): faktur penjualan hanya lewat Antrean Faktur (klaim + riwayat + pencarian
        // sebelum kirim ulang). Lewat proxy generik, faktur bisa tertulis tanpa jejak dan tanpa cek ganda.
        if (isSalesInvoiceWrite(String(endpointPath))) {
            return NextResponse.json({
                error: "Faktur penjualan hanya dikirim lewat Antrean Faktur (pencegahan faktur ganda dan riwayat kirim). "
                    + "Proxy generik menolak sales-invoice/save.do dan bulk-save.do.",
                code: "SALES_INVOICE_VIA_OUTBOX", sent: false,
            }, { status: 403 });
        }
        // AM-024 (owner D-18): tulis sales-receipt tidak boleh melewati idempotency — wajib lock milik user
        // ini yang mencakup setiap baris (atau override Finance tercatat). Pemeriksaan murni SEBELUM sesi & DB.
        const salesReceipt = isSalesReceiptWrite(endpointPath);
        const expectedDatabaseId = typeof body.expectedDatabaseId === "string" || typeof body.expectedDatabaseId === "number"
            ? String(body.expectedDatabaseId).trim() : "";
        const write = { lockId: body.idempotencyLockId, userId: String(authCheck.session.user.id), payload, endpointPath, method };
        if (salesReceipt) {
            const bad = checkSalesReceiptWrite(write);
            if (bad) return NextResponse.json({ error: bad, code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false }, { status: 409 });
            // S6e-2 butir 8: akun potongan belum dipilih (penanda alokasi.ts) tidak boleh sampai ke Accurate.
            if (memuatPlaceholderAkun(payload)) {
                return NextResponse.json({ error: "Akun potongan belum dipilih (ISI_KODE_AKUN_…) — pilih akun di langkah Akun. Tidak ada yang dikirim.", code: "PLACEHOLDER_AKUN", sent: false }, { status: 400 });
            }
            // S6e-2 (owner #5): kirim pelunasan = kunci `pelunasan.kirim`, ditegakkan di sini (bukan hanya UI).
            // Hanya cabang tulis sales-receipt — GET & tulis endpoint lain tidak berubah.
            const access = await resolveRequestPermissions(req);
            if (access.response) return access.response;
            if (!access.perms!.has("pelunasan.kirim")) {
                return NextResponse.json({ error: "Kirim pelunasan ke Accurate butuh izin pelunasan.kirim.", code: "PERMISSION_REQUIRED", sent: false }, { status: 403 });
            }
            // S6e-2 butir 2 (pola S6b A-1): kiriman membawa database yang DITAMPILKAN ke pengguna; dibandingkan
            // dengan database sesi di bawah, sebelum SENDING (sesi bisa berganti di tab lain).
            if (!expectedDatabaseId) {
                return NextResponse.json({ error: "expectedDatabaseId wajib (database Accurate tujuan yang ditampilkan). Tidak ada yang dikirim.", code: "DATABASE_REQUIRED", sent: false }, { status: 400 });
            }
        }
        // S7-1b (AM-024; owner PK-1..3 12 Okt): tulis NON-sales-receipt = kunci Konsol `api_wrapper.execute` + hanya save/bulk-save
        // katalog Konsol (delete.do & endpoint lain ditolak). Ditolak SEBELUM sesi Accurate, DB guard, dan jaringan = tidak terkirim.
        // Cabang sales-receipt di atas TIDAK memakai kunci ini (pelunasan.kirim). GET baca kanonik tetap cukup sesi app: Finance &
        // Pelunasan membaca lewat proxy tanpa api_wrapper.* (sengaja menyimpang dari kontrak AM-024 "GET: api_wrapper.view").
        const tulisKonsol = !salesReceipt && !isAccurateRead(endpointPath, method);
        if (tulisKonsol) {
            const access = await resolveRequestPermissions(req);
            if (access.response) return access.response;
            if (!access.perms!.has("api_wrapper.execute")) {
                return NextResponse.json({
                    error: "Tulis ke Accurate lewat Konsol butuh izin Konsol · Eksekusi (api_wrapper.execute). Tidak ada yang dikirim.",
                    code: "PERMISSION_REQUIRED", permission: "api_wrapper.execute", sent: false,
                }, { status: 403 });
            }
            if (!isCatalogWrite(endpointPath, method)) {
                return NextResponse.json({
                    error: "Endpoint ini tidak ada di katalog tulis Konsol (hanya save.do/bulk-save.do katalog; hapus dan endpoint lain ditolak). Tidak ada yang dikirim.",
                    code: "ENDPOINT_TIDAK_DIIZINKAN", sent: false,
                }, { status: 403 });
            }
        }
        const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
        const sessionHost = accurateSession?.sessionHost;
        const sessionId = accurateSession?.sessionId;
        const apiKey = accurateSession?.accessToken;

        if (!endpointPath || !method || !sessionHost || !sessionId || !apiKey || !isAllowedAccurateHost(sessionHost)) {
            // Tanpa sesi tidak ada yang dikirim: guard dinilai TANPA menulis (override & lock tidak hangus).
            if (salesReceipt) {
                const denied = await authorizeSalesReceiptWrite(db, write, { dryRun: true });
                if (typeof denied === "string") return NextResponse.json({ error: denied, code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false }, { status: 409 });
            }
            // S6e-2 butir 4 (C11): ditolak SEBELUM diteruskan = tidak terkirim (boleh diulang), bukan tidak pasti.
            return NextResponse.json({ error: sessionHost && !isAllowedAccurateHost(sessionHost)
                ? "Session host Accurate tidak diizinkan"
                : "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.",
            ...(salesReceipt || tulisKonsol ? { code: "ACCURATE_SESSION_INCOMPLETE", sent: false } : {}) }, { status: 400 });
        }
        if (salesReceipt && String(accurateSession?.databaseId ?? "") !== expectedDatabaseId) {
            return NextResponse.json({
                error: `Database Accurate sesi berubah (kini ${accurateSession?.databaseAlias || accurateSession?.databaseId || "tidak diketahui"}) — muat ulang lalu periksa tujuan. Tidak ada yang dikirim.`,
                code: "database_changed", sent: false,
                databaseId: accurateSession?.databaseId ?? null, databaseAlias: accurateSession?.databaseAlias ?? null,
            }, { status: 409 });
        }
        if (salesReceipt) {
            // S6e-2 butir 2: lock dibuat untuk database lain (atau sebelum database dicatat) = jangan kirim.
            const lockDb = await databaseLockBerbeda(db, String(write.lockId), write.userId, expectedDatabaseId);
            if (lockDb !== null) {
                return NextResponse.json({
                    error: `Lock dibuat untuk database Accurate ${lockDb}, bukan database sesi kini — ulangi dari Tinjau. Tidak ada yang dikirim.`,
                    code: "database_changed", sent: false, lockDatabaseId: lockDb,
                    databaseId: accurateSession?.databaseId ?? null, databaseAlias: accurateSession?.databaseAlias ?? null,
                }, { status: 409 });
            }
        }
        // Re-review d60433f2 MEDIUM: baris ditandai SENDING (dan override dihabiskan) sebelum kirim; hasilnya
        // dicatat server di bawah — kirim ulang dengan lock yang sama / laporan FAILED palsu tidak lolos lagi.
        let dispatch: SalesReceiptDispatch | null = null;
        if (salesReceipt) {
            // Lock dinilai DULU tanpa menulis: kiriman yang tak tercakup lock tidak memicu pembacaan riwayat ke Accurate.
            const pre = await authorizeSalesReceiptWrite(db, write, { dryRun: true });
            if (typeof pre === "string") return NextResponse.json({ error: pre, code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false }, { status: 409 });
            // S6e-2 (owner #6): baris identik KASAR dengan riwayat Accurate (pelanggan + tanggal + {faktur: nominal}, tanpa potongan —
            // orkestrator 11 Okt) ditahan di SERVER tiap paket, tepat sebelum kirim; riwayat yang gagal dibaca = ditahan (fail-closed).
            // Override Finance `ACCURATE_HISTORY` (lock allowHistoryKeys) membukanya.
            const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
            const riwayat = await periksaRiwayatAccurate(rows.map(targetRiwayat),
                bacaAccurate({ sessionHost, sessionId, accessToken: apiKey }));
            const r = await authorizeSalesReceiptWrite(db, write, { riwayat });
            if (typeof r === "string") return NextResponse.json({ error: r, code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false }, { status: 409 });
            if ("held" in r) {
                const tidakTerbaca = r.held.filter((h) => h.reason === "ACCURATE_HISTORY_UNREADABLE").length;
                return NextResponse.json({
                    error: `${r.held.length} baris ditahan: mirip pelunasan yang sudah ada di Accurate`
                        + (tidakTerbaca ? ` (${tidakTerbaca} karena riwayat Accurate gagal dibaca)` : "")
                        + " — butuh izin Finance (finance.override_duplicate) dengan alasan. Tidak ada yang dikirim.",
                    code: "ACCURATE_HISTORY", sent: false, rows: r.held,
                }, { status: 409 });
            }
            dispatch = r;
        }

        // Audit F5: log tanpa query string (bisa berisi data bisnis). S7-1b: tulis mencatat id pengguna (tanpa email/token/payload).
        console.log(`[PROXY FIRE] ${String(method).toUpperCase()} ${endpointPath}${salesReceipt || tulisKonsol ? ` user=${write.userId}` : ""}`);

        // Hasil per baris sales-receipt dicatat SERVER di sendSalesReceipt (timeout/non-JSON/5xx = UNKNOWN).
        const { status, text: rawText, json, data } = await sendSalesReceipt(db, dispatch,
            () => forwardAccurate({ sessionHost, sessionId, accessToken: apiKey }, endpointPath, method, payload));
        if (!json) {
            console.error("[ACCURATE API RETURNED NON-JSON]", redactAccurateSecrets(rawText));
            return NextResponse.json({ error: "Accurate mengembalikan respons non-JSON (Gagal)", detail: rawText.substring(0, 1000) }, { status: 502 });
        }

        // SERVER LOG FOR DEBUGGING
        const accurateResult = data as { s?: boolean };
        if (status < 200 || status >= 300 || !accurateResult.s) {
            console.error("[ACCURATE API ERROR FORMAT JSON]", redactAccurateSecrets(JSON.stringify(data, null, 2)));
        }

        return NextResponse.json(data);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return NextResponse.json({ error: accurateTimeoutMessage(requestMethod) }, { status: 504 });
        }
        console.error("[PROXY SERVER INTERNAL ERROR]", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy request failed" }, { status: 500 });
    }
}
