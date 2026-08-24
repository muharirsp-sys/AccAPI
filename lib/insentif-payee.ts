/*
 * Tujuan: Satu sumber kebenaran untuk "siapa yang dibayar" di tabel incentive_payments —
 *         Sales, SPV, atau SM — tanpa menambah kolom/tabel baru.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (FinanceView), app/api/insentif-sales/payments.
 * Dependensi: none (pure).
 * Main Functions: payeeCode (bikin kode sentinel), parsePayee (baca balik peran + nama).
 * Side Effects: none (pure).
 *
 * ponytail: SPV & SM dititipkan ke tabel incentive_payments yang sudah ada lewat prefiks pada
 * sales_code ("SPV:ANI", "SM:HENDRIK") — bukan tabel baru dan bukan migrasi DB. Kunci upsert
 * tabel itu (sales_code + principle + periode) tetap unik karena kode sales asli tidak pernah
 * memakai ":" dan principle-nya diisi PAYEE_PRINCIPLE_ALL. Pindah ke kolom `role` sendiri kalau
 * suatu saat butuh query/laporan per peran di sisi DB.
 */

export type PayeeRole = "sales" | "spv" | "sm";

/** Insentif SPV & SM tidak per-principal, jadi kolom principle diisi penanda ini. */
export const PAYEE_PRINCIPLE_ALL = "-";

const PREFIX: Record<Exclude<PayeeRole, "sales">, string> = { spv: "SPV:", sm: "SM:" };

/** Kode untuk kolom sales_code. Sales dipakai apa adanya; SPV/SM diberi prefiks. */
export function payeeCode(role: PayeeRole, name: string): string {
    return role === "sales" ? name : PREFIX[role] + name.trim();
}

/** Baca balik peran + nama dari sales_code. Kode tanpa prefiks dianggap sales. */
export function parsePayee(salesCode: string): { role: PayeeRole; name: string } {
    for (const [role, prefix] of Object.entries(PREFIX) as [Exclude<PayeeRole, "sales">, string][]) {
        if (salesCode.startsWith(prefix)) return { role, name: salesCode.slice(prefix.length) };
    }
    return { role: "sales", name: salesCode };
}
