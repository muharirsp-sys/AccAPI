/*
 * Tujuan: Menjawab satu pertanyaan saja — "outlet ini channelnya apa menurut MASTER Accurate?"
 * Caller: FastAPI (`python_backend/outlet_channel.py`) saat menyimpan Order Sales / Order Masuk;
 *         boleh juga dipakai layar mana pun yang perlu memastikan kategori outlet.
 * Dependensi: db (customer), lib/principal-validation (channelOutlet), lib/api-security, rbac.
 * Main Functions: GET.
 * Side Effects: TIDAK ADA — hanya membaca.
 *
 * KENAPA ENDPOINT, BUKAN SALINAN DI SISI PYTHON.
 * Channel outlet adalah dasar keputusan gerbang: surat "KHUSUS CHANNEL GT" hanya boleh jatuh ke
 * outlet yang master kita sendiri menyebutnya TT. Kalau jawabannya diambil dari salinan lokal,
 * ia bisa BASI tepat di tempat yang paling berbahaya — seluruh guna fitur ini adalah menyuruh
 * admin MEMBETULKAN kategori di Accurate, jadi data yang paling mungkin berubah justru data yang
 * jadi dasar keputusannya. Bekasnya sudah ada di repo ini: `sync-item-prices` tidak pernah masuk
 * cron, dan akibatnya admin yang baru saja memperbaiki harga tetap melihat barisnya tertahan.
 *
 * Preseden yang sama sudah berjalan di produksi untuk sesi (`AUTH_VERIFY_URL`), dan catatan D4
 * pada `get_current_user` sudah memutuskan hal yang persis sama: kalau DB utama Postgres, JANGAN
 * jatuh ke salinan SQLite yang basi — tolak saja.
 *
 * KENAPA SATU FIELD SAJA. Yang dikembalikan hanya kode -> channel, untuk kode yang DITANYAKAN.
 * Bukan daftar pelanggan, bukan nama, bukan limit kredit. Pemanggilnya cuma perlu itu, dan
 * endpoint yang memberi lebih dari yang diperlukan adalah endpoint yang suatu hari dipakai untuk
 * hal lain tanpa ada yang memutuskannya.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer } from "@/db/schema";
import { channelOutlet } from "@/lib/principal-validation";
import { requireCronSecret } from "@/lib/api-security";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

/** Tetap jadi pencarian, bukan pengurasan tabel. Satu order tidak pernah menyentuh 200 outlet. */
const MAX_KODE = 200;

/**
 * Dua pintu, dan keduanya sudah ada — tidak ada kredensial baru yang dibuat untuk ini.
 *
 * `CRON_SECRET` dipakai layanan ke layanan (FastAPI, termasuk jalur cron Order Masuk yang memang
 * tidak punya cookie siapa pun). Secret itu sudah dipercaya memicu pengiriman faktur dan sync,
 * jadi menambahkan pembacaan satu kolom kategori TIDAK memperluas apa pun.
 * Sesi manusia tetap diterima, dengan izin yang sama dengan layar order.
 */
async function gate(request: NextRequest) {
    if (!requireCronSecret(request).response) return { response: null };
    const perm = await resolveRequestPermissionsH();
    if (perm.response) return { response: perm.response };
    if (!perm.perms?.has("order.view")) {
        return { response: NextResponse.json({ ok: false, error: "Akses data outlet tidak diizinkan" }, { status: 403 }) };
    }
    return { response: null };
}

export async function GET(request: NextRequest) {
    const izin = await gate(request);
    if (izin.response) return izin.response;

    const kode = [...new Set((request.nextUrl.searchParams.get("no") ?? "")
        .split(",").map((entry) => entry.trim()).filter(Boolean))];
    if (!kode.length) return NextResponse.json({ ok: false, error: "Parameter no wajib diisi" }, { status: 400 });
    if (kode.length > MAX_KODE) {
        return NextResponse.json({ ok: false, error: `Maksimal ${MAX_KODE} kode sekali tanya` }, { status: 400 });
    }

    const rows = await db.select({ no: customer.customerNo, categoryName: customer.categoryName })
        .from(customer).where(inArray(customer.customerNo, kode));

    // Kode yang TIDAK ADA di master sengaja tidak muncul di peta, bukan dijawab string kosong:
    // "tidak ada di master" dan "ada tapi kategorinya belum diisi" adalah dua masalah berbeda
    // dengan dua perbaikan berbeda, dan pemanggilnya harus bisa membedakannya.
    const channels: Record<string, string> = {};
    for (const row of rows) channels[row.no] = channelOutlet(row.categoryName);
    return NextResponse.json({
        ok: true, channels,
        tidakAdaDiMaster: kode.filter((satu) => !(satu in channels)),
    });
}
