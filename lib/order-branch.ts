/*
 * Tujuan: Menentukan cabang Accurate dan seri penomoran Faktur Penjualan untuk satu order.
 * Caller: app/api/orders/[id]/invoice (payload + dry-run), jalur faktur berikutnya.
 * Dependensi: db/schema (customer, branch).
 * Main Functions: resolveOrderBranch.
 * Side Effects: DB read-only.
 *
 * Cabangnya diambil dari PELANGGAN, bukan dari perangkat sales dan bukan dari satu nilai env.
 * Alasannya dibuktikan live 2026-09-09: di Accurate ini satu outlet fisik punya customerNo
 * BERBEDA per cabang (`C-100005-RB` untuk RECKITT, `C-100005-VIN` untuk VINDA), jadi cabang
 * sudah melekat pada kode pelanggan yang dipilih. Konsekuensinya penting: nilai ini tidak bisa
 * dipalsukan klien, karena tidak pernah dibaca dari permintaan.
 *
 * `typeAutoNumber` menentukan nomor faktur akan masuk seri cabang yang mana. Salah seri berarti
 * nomor faktur nyasar ke pembukuan cabang lain dan tidak bisa ditarik kembali — jadi setiap
 * ketidakpastian di sini WAJIB menolak, bukan memakai nilai default.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer } from "@/db/schema";

export type OrderBranch = {
    branchId: number;
    branchName: string;
    autoNumberId: number;
    autoNumberName: string;
};

export type OrderBranchResult = { branch: OrderBranch; error?: undefined } | { branch?: undefined; error: string };

export async function resolveOrderBranch(customerNo: string): Promise<OrderBranchResult> {
    const code = customerNo.trim();
    if (!code) return { error: "Order tanpa kode pelanggan Accurate tidak bisa difakturkan" };

    const [row] = await db
        .select({
            branchId: customer.branchId,
            branchName: customer.branchName,
            autoNumberId: branch.siAutoNumberId,
            autoNumberName: branch.name,
        })
        .from(customer)
        .leftJoin(branch, eq(branch.id, customer.branchId))
        .where(eq(customer.customerNo, code))
        .limit(1);

    if (!row) return { error: `Pelanggan ${code} tidak ada di master Accurate hasil sync` };
    if (!row.branchId) {
        // 424 dari 32.456 pelanggan produksi memang tanpa cabang (2026-09-09). Menebak cabang
        // default untuk mereka berarti menomori faktur pada seri yang salah tanpa peringatan.
        return { error: `Pelanggan ${code} belum punya cabang di Accurate; cabang faktur tidak dapat ditentukan` };
    }
    if (!row.autoNumberId) {
        // Terjadi nyata: Kantor Pusat tidak punya seri Faktur Penjualan, dan seri URC suspended.
        return {
            error: `Cabang ${row.branchName || row.branchId} tidak punya seri penomoran Faktur Penjualan yang aktif`,
        };
    }

    return {
        branch: {
            branchId: row.branchId,
            branchName: row.branchName ?? "",
            autoNumberId: row.autoNumberId,
            autoNumberName: row.autoNumberName ?? "",
        },
    };
}
