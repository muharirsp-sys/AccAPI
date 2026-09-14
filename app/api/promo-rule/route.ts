/*
 * Tujuan: Membuat, mengubah, dan menghapus aturan promo SATU PER SATU dari layar.
 * Caller: halaman Aturan Promo (/aturan-promo).
 * Dependensi: db (promo_rule), rbac. Main Functions: GET, POST, PATCH, DELETE.
 * Side Effects: menulis `promo_rule` — tabel yang dibaca gerbang validasi dan Rekap Promo.
 *
 * Kenapa ada di samping importir: impor berkas MENGGANTI seluruh irisannya, jadi ia tidak bisa
 * dipakai untuk satu perbaikan kecil — menambah satu outlet berarti menyusun ulang berkasnya
 * dan mempertaruhkan seluruh muatan. Dua jalur ini menulis tabel yang SAMA; tidak ada salinan
 * kedua, jadi tidak ada dua jawaban tentang aturan yang sama.
 *
 * Satu jebakan yang dijaga di sini: pada baris TARIF (outlet, semua barang, DISC_PCT),
 * `tier_no` berarti POSISI kolom diskon, dan posisi menentukan siapa menanggung. Beban yang
 * tidak sesuai posisinya menghasilkan aturan yang TIDAK PERNAH bisa cocok — aturan yang
 * kelihatan ada di layar tetapi diam-diam tidak menjelaskan apa pun.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoRule } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { OWNER } from "@/lib/principal-validation";

export const runtime = "nodejs";

const text = (value: unknown) => String(value ?? "").trim();
const BEBAN = new Set(["PRINCIPAL", "DISTRIBUTOR"]);
const JENIS = new Set(["DISC_PCT", "DISC_RP", "BONUS_QTY"]);

type Draft = typeof promoRule.$inferInsert;

/** Bentuk baris dari isian layar, atau pesan kenapa ia ditolak. Tidak ada jalan tengah. */
function draftOf(body: Record<string, unknown>, importedBy: string): { row: Draft } | { error: string } {
    const itemCode = text(body.itemCode);
    const customerCode = text(body.customerCode).toUpperCase();
    const benefitType = text(body.benefitType).toUpperCase();
    const benefitBeban = text(body.benefitBeban).toUpperCase() || "PRINCIPAL";
    const benefitValue = text(body.benefitValue).replace(",", ".");
    const tierNo = Number(body.tierNo) || 1;

    if (!text(body.principal)) return { error: "Principal wajib diisi" };
    if (!text(body.suratProgram)) return { error: "Surat/program wajib diisi — ia yang menjelaskan asal aturannya" };
    if (!JENIS.has(benefitType)) return { error: `Jenis manfaat harus salah satu dari ${[...JENIS].join(", ")}` };
    if (!BEBAN.has(benefitBeban)) return { error: "Beban harus PRINCIPAL atau DISTRIBUTOR" };
    if (benefitType !== "BONUS_QTY" && !Number.isFinite(Number(benefitValue))) {
        return { error: `Nilai manfaat "${benefitValue}" bukan angka` };
    }
    if (tierNo < 1) return { error: "Tingkat/posisi minimal 1" };

    // Baris TARIF: melekat outlet, berlaku semua barang, dan `tierNo` adalah POSISI diskon.
    if (customerCode && !itemCode && benefitType === "DISC_PCT") {
        if (tierNo > 5) return { error: "Posisi diskon hanya 1 sampai 5" };
        const seharusnya = OWNER[tierNo] === "principal" ? "PRINCIPAL" : "DISTRIBUTOR";
        if (benefitBeban !== seharusnya) {
            return { error: `Posisi ${tierNo} adalah beban ${seharusnya}. Aturan berbeban ${benefitBeban} `
                + "di posisi itu tidak akan pernah cocok dengan potongan mana pun — ia hanya terlihat ada." };
        }
    }

    return { row: {
        principal: text(body.principal), suratProgram: text(body.suratProgram),
        promoLabel: text(body.promoLabel), promoGroupId: text(body.promoGroupId),
        promoGroup: text(body.promoGroup), itemCode, itemName: text(body.itemName),
        prdId: text(body.prdId), customerCode,
        periodStart: text(body.periodStart).slice(0, 10) || null,
        periodEnd: text(body.periodEnd).slice(0, 10) || null,
        active: body.active !== false,
        tierNo, triggerQty: String(Number(body.triggerQty) || 0),
        triggerUnit: text(body.triggerUnit).toUpperCase() || "PCS",
        benefitType, benefitValue, benefitUnit: text(body.benefitUnit),
        benefitBeban, onFaktur: body.onFaktur !== false,
        note: text(body.note), importedBy,
    } };
}

async function gateOf(perlu: "summary.view" | "summary.edit") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses aturan promo tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

export async function GET(request: NextRequest) {
    const gate = await gateOf("summary.view");
    if (gate.response) return gate.response;

    const principal = (request.nextUrl.searchParams.get("principal") ?? "").trim();
    const jenis = (request.nextUrl.searchParams.get("jenis") ?? "").trim();
    const beban = (request.nextUrl.searchParams.get("beban") ?? "").trim().toUpperCase();
    const cari = (request.nextUrl.searchParams.get("q") ?? "").trim().toUpperCase();

    const rows = await db.select().from(promoRule)
        .where(principal ? eq(promoRule.principal, principal) : undefined)
        .orderBy(asc(promoRule.principal), asc(promoRule.suratProgram), asc(promoRule.customerCode),
            asc(promoRule.itemCode), asc(promoRule.tierNo));

    // Disaring di sini, bukan di SQL: daftarnya ratusan baris, dan menaruh "tarif outlet" vs
    // "aturan barang" sebagai syarat SQL berarti definisinya hidup di dua tempat.
    const isTarif = (r: typeof rows[number]) => Boolean(r.customerCode) && !r.itemCode;
    const disaring = rows.filter((row) => {
        if (jenis === "tarif" && !isTarif(row)) return false;
        if (jenis === "barang" && (isTarif(row) || !row.itemCode)) return false;
        if (jenis === "faktur" && (isTarif(row) || row.itemCode)) return false;
        if (beban && row.benefitBeban.toUpperCase() !== beban) return false;
        if (!cari) return true;
        return [row.suratProgram, row.promoGroup, row.promoLabel, row.itemCode, row.itemName, row.customerCode]
            .some((field) => String(field).toUpperCase().includes(cari));
    });

    return NextResponse.json({
        ok: true,
        principals: [...new Set(rows.map((row) => row.principal))].sort(),
        total: rows.length,
        rules: disaring.slice(0, 500),
        truncated: Math.max(disaring.length - 500, 0),
    });
}

export async function POST(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Isian tidak terbaca" }, { status: 400 });

    const draft = draftOf(body as Record<string, unknown>, gate.email!);
    if ("error" in draft) return NextResponse.json({ ok: false, error: draft.error }, { status: 422 });

    try {
        const [row] = await db.insert(promoRule).values(draft.row).returning({ id: promoRule.id });
        return NextResponse.json({ ok: true, id: row.id });
    } catch (error) {
        // Kunci uniknya (principal, surat, kelompok, barang, outlet, tingkat) memang menolak
        // kembar — itu penjaga, bukan gangguan. Dua aturan identik berarti dua jawaban.
        const pesan = error instanceof Error ? error.message : "gagal menyimpan";
        return NextResponse.json({ ok: false, error: /duplicate|unique/i.test(pesan)
            ? "Aturan dengan surat, kelompok, barang, outlet, dan tingkat yang sama sudah ada — ubah yang itu."
            : pesan }, { status: 409 });
    }
}

export async function PATCH(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.id);
    if (!body || !Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id wajib diisi" }, { status: 400 });

    const draft = draftOf(body, gate.email!);
    if ("error" in draft) return NextResponse.json({ ok: false, error: draft.error }, { status: 422 });

    const changed = await db.update(promoRule).set({ ...draft.row, importedAt: new Date() })
        .where(eq(promoRule.id, id)).returning({ id: promoRule.id });
    if (!changed.length) return NextResponse.json({ ok: false, error: "Aturan tidak ditemukan" }, { status: 404 });
    return NextResponse.json({ ok: true, id });
}

export async function DELETE(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    // Satu `id` atau banyak `ids`: membersihkan puluhan tarif yang salah posisi satu per satu
    // memakan waktu, dan setengah terhapus lebih berbahaya daripada tidak terhapus sama sekali.
    const satu = request.nextUrl.searchParams.get("id");
    const banyak = request.nextUrl.searchParams.get("ids");
    const ids = [...new Set([satu, ...(banyak ?? "").split(",")]
        .map((value) => Number(String(value ?? "").trim()))
        .filter((value) => Number.isFinite(value) && value > 0))];
    if (!ids.length) return NextResponse.json({ ok: false, error: "Sebutkan id aturan yang mau dihapus" }, { status: 400 });
    if (ids.length > 500) return NextResponse.json({ ok: false, error: "Maksimal 500 aturan sekali hapus" }, { status: 413 });

    const gone = await db.delete(promoRule).where(inArray(promoRule.id, ids)).returning({ id: promoRule.id });
    if (!gone.length) return NextResponse.json({ ok: false, error: "Tidak ada aturan yang cocok" }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: gone.length, diminta: ids.length });
}

/** Menyalin satu tarif ke beberapa outlet sekaligus — jawaban untuk baris ber-"GROUP". */
export async function PUT(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.id);
    const kode = String(body?.customerCodes ?? "").split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id wajib diisi" }, { status: 400 });
    if (!kode.length) return NextResponse.json({ ok: false, error: "Sebutkan kode outlet tujuannya" }, { status: 400 });

    const [sumber] = await db.select().from(promoRule).where(eq(promoRule.id, id));
    if (!sumber) return NextResponse.json({ ok: false, error: "Aturan sumber tidak ditemukan" }, { status: 404 });

    // Satu grup outlet berbagi tarif yang sama tetapi TETAP satu baris per kode: gerbang
    // mencocokkan per pelanggan, dan kode anggota grup tidak selalu punya awalan yang sama
    // (SATU SAMA JAYA: C-SA0269, C-SAT015, C-SAT016). Menebak dari nama akan meleset diam-diam.
    const isi = { ...sumber, id: undefined, importedAt: undefined };
    const baris = kode.map((customerCode) => ({ ...isi, customerCode, importedBy: gate.email! }));
    const ditulis = await db.insert(promoRule).values(baris)
        .onConflictDoUpdate({
            target: [promoRule.principal, promoRule.suratProgram, promoRule.promoGroup,
                promoRule.itemCode, promoRule.customerCode, promoRule.tierNo],
            set: { benefitValue: sql`excluded.benefit_value`, benefitBeban: sql`excluded.benefit_beban`,
                periodStart: sql`excluded.period_start`, periodEnd: sql`excluded.period_end`,
                active: sql`excluded.active`, note: sql`excluded.note`, importedBy: gate.email! },
        })
        .returning({ id: promoRule.id });
    return NextResponse.json({ ok: true, outlets: kode.length, rows: ditulis.length });
}
