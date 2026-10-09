/*
 * Tujuan: BL-39 — isi dialog "Kirim N faktur ke Accurate?": database tujuan + kecocokan sesi
 *         penekan, jumlah (maks. 50 per tekan), rincian per principal, DPP + PPN, tanggal faktur,
 *         dan daftar order yang AKAN dikirim — kueri & urutan yang sama dengan tombol Kirim.
 * Caller: halaman Antrean Faktur (dialog `kirim`, S6c — belum ada UI).
 * Dependensi: lib/invoice-sender (pratinjauKirim = rencanaKirim yang dipakai Kirim, cekTanggalFaktur),
 *   lib/accurate-session (database sesi penekan), rbac.
 * Main Functions: GET ?orderIds=a,b&invoiceDate=yyyy-MM-dd.
 * Side Effects: BACA SAJA. Tidak menyapu, tidak mengklaim, tidak memanggil Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { cekTanggalFaktur, MAKS_PER_TEKAN, pratinjauKirim } from "@/lib/invoice-sender";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    // Sama dengan tombol Kirim: dialog ini hanya untuk yang boleh mengirim.
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh mengirim faktur ke Accurate" }, { status: 403 });
    }
    const params = request.nextUrl.searchParams;
    const orderIds = (params.get("orderIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const invoiceDate = (params.get("invoiceDate") ?? "").trim() || undefined;
    const tanggalSalah = cekTanggalFaktur(invoiceDate);
    if (tanggalSalah) return NextResponse.json({ ok: false, error: tanggalSalah }, { status: 400 });

    // AM-031 belum ada: database tujuan = env, BUKAN diikat saat antre. Label wajib tampil di dialog.
    const targetDb = String(process.env.ACCURATE_INVOICE_DB_ID || "").trim();
    const sesi = await getAccurateSession(String(gate.session?.user?.id ?? "")).catch(() => null);
    const sesiDb = sesi?.databaseId ? String(sesi.databaseId) : "";
    const cocok = Boolean(targetDb) && sesiDb === targetDb && Boolean(sesi?.sessionHost && sesi.sessionId && sesi.accessToken);

    const lihat = await pratinjauKirim(db, { limit: MAKS_PER_TEKAN, orderIds: orderIds.length ? orderIds : undefined, invoiceDate });
    const [antre] = await db.select({ total: sql<number>`count(*)::int` }).from(invoiceOutbox).where(eq(invoiceOutbox.state, "queued"));

    return NextResponse.json({
        ok: !lihat.error && cocok && lihat.orders.length > 0,
        database: {
            tujuan: targetDb,
            label: "database dari env (AM-031)",
            sesiPenekan: { id: sesiDb, alias: sesi?.databaseAlias ?? "" },
            cocok,
            ...(cocok ? {} : {
                pesan: !targetDb
                    ? "ACCURATE_INVOICE_DB_ID belum di-set — Kirim akan ditolak."
                    : !sesiDb
                        ? "Sesi Accurate Anda tidak lengkap — login Accurate dulu di /api-wrapper."
                        : `Sesi Accurate Anda terbuka pada database ${sesiDb}, bukan ${targetDb} — Kirim akan ditolak.`,
            }),
        },
        maksPerTekan: MAKS_PER_TEKAN,
        jumlah: lihat.orders.length,
        antreanMenunggu: antre?.total ?? 0,
        tanggalFaktur: invoiceDate ?? null,
        nilaiPerkiraan: "DPP + PPN 11% dari payload yang akan dikirim; Accurate membulatkan PPN sendiri (bisa selisih sen).",
        ...(lihat.error ? { ditolak: lihat.error } : {}),
        perPrincipal: lihat.perPrincipal,
        total: lihat.total,
        orders: lihat.orders,
    });
}
