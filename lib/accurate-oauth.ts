/*
 * Tujuan: Bagian murni alur masuk Accurate (OAuth) yang dipakai server dan klien: scope (TETAP persis), URL authorize ber-`state`,
 *   daftar putih `returnTo`, halaman pendaratan callback, kode galat tetap + kalimatnya (AM-033, S7-sesi).
 * Caller: app/api/auth/accurate-login/route.ts, app/api/auth/callback/route.ts, components/accurate/SesiAccurate.tsx,
 *   app/(dashboard)/sesi-accurate/page.tsx.
 * Dependensi: tidak ada (tanpa env, tanpa node:crypto — aman di bundel klien).
 * Main Functions: urlAuthorize, returnToAman, halamanMendarat, kabarAccurate, ACCURATE_SCOPE, RETURN_TO, GALAT_ACCURATE, STATE_COOKIE.
 * Side Effects: Tidak ada.
 */

/** Scope OAuth Accurate — dipindah verbatim dari api-wrapper/page.tsx (zona OAuth: JANGAN diubah tanpa owner). */
export const ACCURATE_SCOPE = "auto_number_save auto_number_view branch_save branch_view currency_save currency_view customer_save customer_view customer_category_save customer_category_view customer_claim_save customer_claim_view delivery_order_save delivery_order_view department_save department_view employee_view employee_save finished_good_slip_save finished_good_slip_view item_save item_view item_adjustment_save item_adjustment_view item_category_save item_category_view item_transfer_save item_transfer_view job_order_save job_order_view material_adjustment_save material_adjustment_view payment_term_save payment_term_view project_save project_view purchase_invoice_save purchase_invoice_view purchase_order_save purchase_order_view purchase_payment_save purchase_payment_view purchase_requisition_save purchase_requisition_view purchase_return_save purchase_return_view receive_item_save receive_item_view sales_invoice_save sales_invoice_view sales_order_save sales_order_view sales_quotation_save sales_quotation_view sales_receipt_save sales_receipt_view sales_return_save sales_return_view stock_opname_order_save stock_opname_order_view stock_opname_result_save stock_opname_result_view tax_save tax_view vendor_save vendor_view vendor_category_save vendor_category_view vendor_claim_save vendor_claim_view vendor_price_save vendor_price_view warehouse_view warehouse_save bank_statement_view bank_statement_save";

/** Cookie httpOnly berisi `<state>:<returnTo>`; hanya dikirim ke callback (path) dan berumur pendek. */
export const STATE_COOKIE = "accurate_oauth_state";
export const STATE_COOKIE_PATH = "/api/auth/callback";
export const STATE_COOKIE_MAX_AGE = 600;

/** Daftar putih tujuan kembali: path relatif persis (tanpa query/hash), selain itu → bawaan `/sesi-accurate`. */
export const RETURN_TO = ["/sesi-accurate", "/api-wrapper", "/pelunasan", "/antrean-faktur", "/finance"] as const;
export type ReturnTo = (typeof RETURN_TO)[number];
export const LABEL_RETURN_TO: Record<ReturnTo, string> = {
    "/sesi-accurate": "Sesi Accurate", "/api-wrapper": "Konsol AOL", "/pelunasan": "Pelunasan", "/antrean-faktur": "Antrean Faktur", "/finance": "Finance",
};

export function returnToAman(raw: unknown): ReturnTo {
    return typeof raw === "string" && (RETURN_TO as readonly string[]).includes(raw) ? raw as ReturnTo : "/sesi-accurate";
}

export function urlAuthorize(clientId: string, redirectUri: string, state: string): string {
    const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: ACCURATE_SCOPE, state });
    return `https://account.accurate.id/oauth/authorize?${params.toString()}`;
}

/**
 * Halaman tempat callback mendarat. Setiap login mengosongkan database (upsert sesi), dan hanya halaman berkartu Sesi Accurate
 * (Konsol, /sesi-accurate) yang membaca `accurate=`/`alasan=` — jadi tujuan lain (Pelunasan/Antrean/Finance) mendarat di
 * /sesi-accurate dulu dengan `returnTo` diteruskan untuk tombol Kembali, bukan di halaman yang tidak menampilkan galat (K10).
 */
export function halamanMendarat(returnTo: ReturnTo, kabar: Record<string, string>): string {
    const halaman = returnTo === "/api-wrapper" ? "/api-wrapper" : "/sesi-accurate";
    const q = new URLSearchParams(kabar);
    if (halaman === "/sesi-accurate" && returnTo !== "/sesi-accurate") q.set("returnTo", returnTo);
    return `${halaman}?${q.toString()}`;
}

/** Kode galat callback/login (nilai `alasan=`) — tetap; layar memetakan kode, tidak pernah menampilkan teks mentah. */
export const GALAT_ACCURATE = {
    state_hilang: "Permintaan masuk sudah kedaluwarsa (lebih dari 10 menit) atau dibuka di alamat/peramban lain. Tekan Masuk Accurate lagi.",
    state_beda: "Permintaan masuk tidak dikenali (tidak dimulai dari aplikasi ini), jadi tidak dilanjutkan. Tekan Masuk Accurate lagi.",
    tanpa_kode: "Accurate tidak memberi kode izin — izin mungkin ditolak atau dibatalkan. Tekan Masuk Accurate lagi.",
    konfigurasi: "Pengaturan Accurate di server belum lengkap. Hubungi IT.",
    tukar_token_gagal: "Accurate menolak penukaran kode izin. Tekan Masuk Accurate lagi; bila berulang, hubungi IT.",
    galat_server: "Server gagal menyelesaikan masuk Accurate. Coba lagi; bila berulang, hubungi IT.",
} as const;
export type KodeGalatAccurate = keyof typeof GALAT_ACCURATE;

export type Kabar = { tone: "pos" | "neg" | "info"; title: string; text?: string };

/** `?accurate=connected|error&alasan=<kode>` → pesan layar; kode tak dikenal = kalimat umum (teks query tidak pernah ditampilkan). */
export function kabarAccurate(accurate: string | null | undefined, alasan: string | null | undefined): Kabar | null {
    if (accurate === "connected") return { tone: "pos", title: "Masuk Accurate berhasil.", text: "Pilih dan buka database untuk mulai bekerja." };
    if (accurate !== "error") return null;
    const text = alasan && Object.hasOwn(GALAT_ACCURATE, alasan)
        ? GALAT_ACCURATE[alasan as KodeGalatAccurate]
        : "Tekan Masuk Accurate lagi; bila berulang, hubungi IT.";
    return { tone: "neg", title: "Masuk Accurate gagal.", text };
}
