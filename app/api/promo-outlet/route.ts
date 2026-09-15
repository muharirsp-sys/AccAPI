/*
 * Tujuan: Menyusun DAFTAR OUTLET peserta program — lihat isinya, tambah, ubah, hapus.
 * Caller: halaman Aturan Promo (/aturan-promo), panel "Daftar outlet peserta".
 * Dependensi: db (promo_outlet, principal_mapping, customer), rbac.
 * Main Functions: GET, POST, PATCH, DELETE.
 * Side Effects: menulis `promo_outlet` — tabel yang dibaca gerbang validasi dan Rekap Promo.
 *
 * Kenapa daftar ini ada: surat program menyebut PESERTA, bukan hanya barang. BP2609007713 dan
 * BP2609007664 berlaku "KHUSUS CHANNEL GT PESERTA LOYALTY"; BP2609006016 justru "EXCLUDE
 * LOYALTY". Selama daftarnya cuma hidup di Excel seorang admin, bonus Resik V sama sahnya di
 * outlet mana pun — dan tidak ada yang bisa menjawab "toko mana saja yang ikut?" tanpa
 * meminta berkasnya.
 *
 * Kenapa menerima DUA bentuk kode: yang memegang daftar loyalty adalah tim sales, dan yang
 * mereka punya adalah CUST_ID2 milik Kino (`2191200123589`) atau nama tokonya — bukan kode
 * internal Accurate. Kode principal diterjemahkan lewat `principal_mapping`, tabel yang sama
 * dengan yang dipakai jalur order; menebaknya dari nama tidak pernah dilakukan di sini.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, principalMapping, promoOutlet } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const text = (value: unknown) => String(value ?? "").trim();

async function gateOf(perlu: "summary.view" | "summary.edit") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses daftar outlet tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

/** Akhiran cabang Accurate milik principal ini; satu outlet punya satu customerNo per cabang. */
const BRANCH_SUFFIX: Record<string, string> = { "KINO NON FOOD": "-KN" };

/**
 * Satu kode yang diketik orang -> kode internal Accurate, atau alasan kenapa tidak bisa.
 *
 * Tiga bentuk yang diterima, dan ketiganya DIBUKTIKAN ke master, bukan diterima apa adanya:
 *   `C-WIN013`     kode internal — dicek ada di master pelanggan
 *   `C-WIN013-KN`  kode bercabang — akhirannya dibuang lalu dicek
 *   `22160031402`  CUST_ID2 principal — diterjemahkan lewat `principal_mapping`
 *
 * Kode yang tidak terbukti DITOLAK dengan sebabnya, tidak dimuat dengan harapan. Daftar
 * peserta yang memuat kode hantu lebih berbahaya daripada daftar yang kurang satu baris:
 * yang kurang akan terlihat sebagai baris tertahan, yang hantu tidak terlihat sama sekali.
 */
function resolverOf(
    mapping: Map<string, string>,
    internal: Map<string, string>,
): (raw: string) => { code: string; name: string; source: string } | { error: string } {
    return (raw: string) => {
        const kode = raw.trim().toUpperCase();
        if (!kode) return { error: "kosong" };
        // Kode principal (angka semua) -> kode internal lewat mapping.
        const lewatMapping = mapping.get(kode);
        if (lewatMapping) {
            const nama = internal.get(lewatMapping);
            return nama === undefined
                ? { error: `${kode} dipetakan ke ${lewatMapping}, tetapi ${lewatMapping} tidak ada di master pelanggan` }
                : { code: lewatMapping, name: nama, source: kode };
        }
        // Kode internal, dengan atau tanpa akhiran cabang.
        for (const calon of [kode, kode.replace(/-[A-Z0-9]+$/, "")]) {
            const nama = internal.get(calon);
            if (nama !== undefined) return { code: calon, name: nama, source: "" };
        }
        return { error: `${kode} bukan kode internal yang ada di master pelanggan, dan bukan kode principal yang sudah dipetakan` };
    };
}

async function lookups(principal: string) {
    const suffix = BRANCH_SUFFIX[principal] ?? "";
    const [maps, pelanggan] = await Promise.all([
        db.select({ source: principalMapping.sourceCode, target: principalMapping.targetCode })
            .from(principalMapping).where(eq(principalMapping.kind, "customer")),
        db.select({ no: customer.customerNo, name: customer.name }).from(customer),
    ]);
    const mapping = new Map(maps.map((row) => [row.source.trim().toUpperCase(), row.target.trim().toUpperCase()]));
    // Master pelanggan berisi kode BERCABANG (C-WIN013-KN); daftar peserta menyimpan kode
    // internalnya. Akhiran cabang principal dibuang supaya keduanya bicara dalam kode yang sama.
    const internal = new Map<string, string>();
    for (const row of pelanggan) {
        const no = row.no.trim().toUpperCase();
        const base = suffix && no.endsWith(suffix) ? no.slice(0, -suffix.length) : no;
        if (!internal.has(base)) internal.set(base, row.name);
    }
    return { mapping, internal };
}

export async function GET(request: NextRequest) {
    const gate = await gateOf("summary.view");
    if (gate.response) return gate.response;

    const list = text(request.nextUrl.searchParams.get("list")).toUpperCase();
    const cari = text(request.nextUrl.searchParams.get("q")).toUpperCase();

    const rows = await db.select().from(promoOutlet)
        .orderBy(asc(promoOutlet.listName), asc(promoOutlet.customerCode));

    const disaring = rows.filter((row) => {
        if (list && row.listName.toUpperCase() !== list) return false;
        if (!cari) return true;
        return [row.customerCode, row.customerName, row.tier, row.sourceCode, row.note]
            .some((field) => String(field).toUpperCase().includes(cari));
    });

    // Ringkasan per daftar supaya "berapa toko yang ikut" terjawab tanpa menghitung sendiri.
    const lists = new Map<string, { name: string; members: number; tiers: Record<string, number> }>();
    for (const row of rows) {
        const entry = lists.get(row.listName) ?? { name: row.listName, members: 0, tiers: {} };
        entry.members += 1;
        const tier = row.tier || "(tanpa tingkat)";
        entry.tiers[tier] = (entry.tiers[tier] ?? 0) + 1;
        lists.set(row.listName, entry);
    }

    return NextResponse.json({
        ok: true,
        lists: [...lists.values()].sort((a, b) => a.name.localeCompare(b.name)),
        total: rows.length,
        members: disaring.slice(0, 1000),
        truncated: Math.max(disaring.length - 1000, 0),
    });
}

/**
 * Menambah anggota, SATU ATAU BANYAK SEKALIGUS.
 *
 * Borongan memang bentuk kerjanya: daftar loyalty datang sebagai satu kolom berisi puluhan
 * kode, dan menambahkannya satu per satu adalah cara terbaik untuk berhenti di tengah. Yang
 * tidak terbaca dikembalikan dengan alasannya masing-masing — bukan menggagalkan seluruhnya,
 * karena satu kode salah ketik tidak boleh membatalkan tiga puluh yang benar, dan bukan pula
 * dibuang diam-diam.
 */
export async function POST(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, error: "Isian tidak terbaca" }, { status: 400 });

    const listName = text(body.listName).toUpperCase();
    if (!listName) return NextResponse.json({ ok: false, error: "Nama daftar wajib diisi" }, { status: 422 });
    const principal = text(body.principal) || "KINO NON FOOD";
    const kode = String(body.codes ?? body.customerCode ?? "").split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
    if (!kode.length) return NextResponse.json({ ok: false, error: "Sebutkan kode outletnya" }, { status: 422 });
    if (kode.length > 1000) return NextResponse.json({ ok: false, error: "Maksimal 1000 kode sekali tambah" }, { status: 413 });

    const { mapping, internal } = await lookups(principal);
    const resolve = resolverOf(mapping, internal);

    const rows: typeof promoOutlet.$inferInsert[] = [];
    const ditolak: string[] = [];
    const sudahAda = new Set<string>();
    for (const satu of kode) {
        const hasil = resolve(satu);
        if ("error" in hasil) { ditolak.push(hasil.error); continue; }
        // Kembar di dalam satu kiriman diselesaikan di sini: menyerahkannya ke kunci unik
        // berarti seluruh kiriman gagal gara-gara satu kode yang tertulis dua kali.
        if (sudahAda.has(hasil.code)) continue;
        sudahAda.add(hasil.code);
        rows.push({
            listName, customerCode: hasil.code, customerName: hasil.name,
            tier: text(body.tier).toUpperCase(), sourceCode: hasil.source,
            periodStart: text(body.periodStart).slice(0, 10) || null,
            periodEnd: text(body.periodEnd).slice(0, 10) || null,
            active: body.active !== false, note: text(body.note), importedBy: gate.email!,
        });
    }
    if (!rows.length) {
        return NextResponse.json({ ok: false, error: `Tidak ada kode yang bisa dipakai. ${ditolak.join("; ")}` }, { status: 422 });
    }

    // `excluded.*` supaya TIAP baris memperbarui dirinya sendiri: menulis nilai satu baris ke
    // seluruh kembar akan menyeragamkan nama dan kode principal yang justru berbeda per outlet.
    const ditulis = await db.insert(promoOutlet).values(rows)
        .onConflictDoUpdate({
            target: [promoOutlet.listName, promoOutlet.customerCode],
            set: {
                customerName: sql`excluded.customer_name`, tier: sql`excluded.tier`,
                sourceCode: sql`excluded.source_code`,
                periodStart: sql`excluded.period_start`, periodEnd: sql`excluded.period_end`,
                active: sql`excluded.active`, note: sql`excluded.note`,
                importedBy: gate.email!, importedAt: new Date(),
            },
        })
        .returning({ id: promoOutlet.id });

    return NextResponse.json({
        ok: true, listName, ditambah: ditulis.length, diminta: kode.length,
        ditolak: ditolak.slice(0, 50),
    });
}

/** Mengubah satu anggota — tingkat, periode, aktif, catatan. Kode outletnya tidak diubah di sini. */
export async function PATCH(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.id);
    if (!body || !Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id wajib diisi" }, { status: 400 });

    const changed = await db.update(promoOutlet).set({
        tier: text(body.tier).toUpperCase(),
        periodStart: text(body.periodStart).slice(0, 10) || null,
        periodEnd: text(body.periodEnd).slice(0, 10) || null,
        active: body.active !== false,
        note: text(body.note),
        importedBy: gate.email!, importedAt: new Date(),
    }).where(eq(promoOutlet.id, id)).returning({ id: promoOutlet.id });
    if (!changed.length) return NextResponse.json({ ok: false, error: "Anggota tidak ditemukan" }, { status: 404 });
    return NextResponse.json({ ok: true, id });
}

export async function DELETE(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const satu = request.nextUrl.searchParams.get("id");
    const banyak = request.nextUrl.searchParams.get("ids");
    const ids = [...new Set([satu, ...(banyak ?? "").split(",")]
        .map((value) => Number(String(value ?? "").trim()))
        .filter((value) => Number.isFinite(value) && value > 0))];
    if (!ids.length) return NextResponse.json({ ok: false, error: "Sebutkan id anggota yang mau dihapus" }, { status: 400 });
    if (ids.length > 1000) return NextResponse.json({ ok: false, error: "Maksimal 1000 anggota sekali hapus" }, { status: 413 });

    const gone = await db.delete(promoOutlet).where(inArray(promoOutlet.id, ids)).returning({ id: promoOutlet.id });
    if (!gone.length) return NextResponse.json({ ok: false, error: "Tidak ada anggota yang cocok" }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: gone.length, diminta: ids.length });
}
