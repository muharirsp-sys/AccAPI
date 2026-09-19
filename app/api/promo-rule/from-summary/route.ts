/*
 * Tujuan: JEMBATAN publikasi Summary -> `promo_rule`. Surat yang sudah dibaca OCR, dikoreksi
 *         manusia, dan DITERBITKAN, menjadi aturan yang benar-benar menahan faktur.
 * Caller: halaman Aturan Promo (tombol "Muat dari Summary").
 * Dependensi: FastAPI /summary/review/published (sumber), db promo_rule + promo_outlet, rbac.
 * Main Functions: GET (daftar publikasi), POST (muat satu publikasi).
 * Side Effects: menulis `promo_rule` irisan `source='surat'` milik surat itu, dan `promo_outlet`
 *               bila publikasinya membawa daftar outlet khusus.
 *
 * KENAPA NEXT YANG MENULIS, BUKAN PYTHON.
 * `promo_rule` punya satu pemilik: sisi Next. Importir Excel, layar Aturan Promo, unggah surat,
 * dan jembatan ini semuanya menulis lewat Drizzle dengan bentuk baris yang sama. Membiarkan
 * Python ikut menulis berarti bentuk barisnya hidup di dua bahasa, dan suatu saat keduanya akan
 * berbeda tentang kolom yang sama.
 *
 * KENAPA SERVER YANG MENGAMBIL, BUKAN PERAMBAN.
 * Halaman Summary memang memanggil FastAPI langsung dari peramban. Tetapi kalau ISI aturan
 * dikirim dari peramban, gerbang "sudah diterbitkan" bisa dilewati dengan menyusun muatan
 * sendiri. Jadi yang dikirim peramban hanya ID publikasinya; isinya diambil server ke server,
 * dengan cookie pemakainya diteruskan supaya kepemilikan paketnya tetap diperiksa FastAPI.
 *
 * MUAT ULANG MENGGANTI IRISANNYA SENDIRI: `source='surat'` untuk surat itu saja. Aturan dari
 * Excel, tarif outlet, dan yang diketik tangan tidak tersentuh.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, item, principalMapping, principalOrderLine, promoLetterApproval, promoOutlet, promoRule } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { bridgeRows, type PublishedLetter, type SummaryProgram } from "@/lib/summary-bridge";
import { simulateLetter, type TrialLine } from "@/lib/summary-simulation";
import { type DiscountAt } from "@/lib/principal-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

const text = (value: unknown) => String(value ?? "").trim();

function backendBase() {
    return process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

async function gateOf(perlu: "summary.view" | "summary.edit") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses aturan promo tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

/**
 * Ambil dari FastAPI dengan cookie pemakainya diteruskan.
 *
 * Tanpa cookie, FastAPI menolak — dan itu memang benar: paket Summary milik PER PEMAKAI, jadi
 * jembatan ini tidak boleh bisa membaca paket orang lain hanya karena ia berjalan di server.
 */
async function fromBackend(request: NextRequest, path: string) {
    const cookie = request.headers.get("cookie") ?? "";
    const url = `${backendBase()}/summary/review${path}`;
    let response: Response;
    try {
        response = await fetch(url, { headers: cookie ? { cookie } : {}, cache: "no-store" });
    } catch {
        // Sebabnya disebut, bukan "fetch failed": yang membaca pesan ini bukan yang menulis
        // kodenya, dan "mesin Summary tidak menyala" adalah sesuatu yang bisa ia tindak lanjuti.
        throw new Error(`Mesin Summary tidak menjawab di ${backendBase()}. Pastikan layanannya menyala.`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new Error("Sesi Anda tidak dikenali oleh mesin Summary. Buka halaman Summary sekali lalu coba lagi; pada mesin pengembang, jalur ini memang tidak bisa dipakai karena login dilewati.");
    }
    if (!response.ok) throw new Error(`Mesin Summary menolak permintaan (HTTP ${response.status})`);
    return await response.json() as Record<string, unknown>;
}


/**
 * Isi publikasi -> bentuk yang dibaca jembatan. SATU perata untuk simulasi maupun pemuatan.
 *
 * Kalau keduanya meratakan sendiri-sendiri, simulasi akan memperlihatkan aturan yang berbeda
 * dari yang benar-benar dimuat — dan simulasi yang berbohong lebih buruk daripada tidak punya
 * simulasi: ia membuat orang menandatangani sesuatu dengan percaya diri yang tidak berdasar.
 */
function letterOf(terbit: Record<string, unknown>, draftId: string, principalCadangan = ""): PublishedLetter {
    const content = (terbit.content ?? {}) as Record<string, unknown>;
    const detail = (content.review_detail ?? {}) as Record<string, unknown>;
    const settings = (detail.settings ?? {}) as Record<string, unknown>;
    const master = (content.master ?? {}) as Record<string, unknown>;
    const items = Array.isArray(master.items) ? master.items as Record<string, unknown>[] : [];

    // DUA BENTUK PUBLIKASI, dan keduanya sah.
    //
    // Paket review (`publish_detail`) menitipkan `review_detail`; pustaka Summary
    // (`summary_library.publish`) menitipkan `rows` — baris grid yang dikoreksi orang. Sampai
    // 2026-09-16 jembatan hanya mengenal yang pertama, jadi publikasi pustaka masuk ke sini
    // dengan principal KOSONG dan nomor surat KOSONG.
    //
    // Itu bukan cacat tampilan: `promo_rule` disaring gerbang PER PRINCIPAL, dan irisan milik
    // satu surat dikunci dengan nomornya. Aturan tanpa keduanya tersimpan rapi, terlihat benar
    // di layar, dan tidak pernah ditanyakan siapa pun. Nama kolomnya saja yang berbeda di dua
    // sisi; isinya sama-sama ada.
    const rows = Array.isArray(content.rows) ? content.rows as Record<string, unknown>[] : [];
    const baris = rows[0] ?? {};
    const ambil = (dariDetail: unknown, dariBaris: unknown) => text(dariDetail) || text(dariBaris);

    return {
        draftId,
        principal: ambil(detail.principal, baris.principle) || principalCadangan || "KINO NON FOOD",
        suratProgram: ambil(detail.document_id, baris.surat_program),
        promoLabel: ambil(detail.nama_program, baris.nama_program),
        promoGroup: ambil(detail.variant_barang, baris.kelompok),
        programs: (Array.isArray(content.programs) ? content.programs : []) as SummaryProgram[],
        itemNames: Object.fromEntries(items.map((entry) => [text(entry.kode_barang), text(entry.nama_barang)])),
        settlement: text(settings.settlement),
        beban: text(settings.beban) || text(settings.benefit_beban) || "PRINCIPAL",
        outletCodes: (Array.isArray(settings.outlet_codes) ? settings.outlet_codes : []).map(text).filter(Boolean),
    };
}

/**
 * Baris laporan principal NYATA yang memuat barang surat ini, untuk bahan simulasi.
 *
 * Dibatasi 2.000 baris terbaru: simulasi harus selesai selagi orang menunggunya di layar, dan
 * bukti atas dua ribu baris sudah jauh lebih meyakinkan daripada bukti atas nol baris. Yang
 * dicari baris yang BARANGNYA disebut surat — bukan yang periodenya cocok — karena surat baru
 * memang belum punya faktur pada periodenya sendiri.
 */
async function trialLinesFor(itemCodes: string[]): Promise<TrialLine[]> {
    if (!itemCodes.length) return [];
    const rows = await db.select({
        soNo: principalOrderLine.soNo, itemCode: principalOrderLine.itemCode,
        reportQty: principalOrderLine.reportQty, reportGross: principalOrderLine.reportGross,
        discounts: principalOrderLine.discounts, bonus: principalOrderLine.bonus,
    }).from(principalOrderLine)
        .where(inArray(principalOrderLine.itemCode, itemCodes))
        .limit(2000);
    return rows.map((row) => ({
        soNo: String(row.soNo), itemCode: String(row.itemCode ?? ""),
        quantity: Number(row.reportQty) || 0, gross: Number(row.reportGross) || 0,
        discounts: (row.discounts as DiscountAt[]) ?? [], bonus: Boolean(row.bonus),
    }));
}

export async function GET(request: NextRequest) {
    const gate = await gateOf("summary.view");
    if (gate.response) return gate.response;

    // MODE SIMULASI. Tidak menulis apa pun — ia membaca aturan yang BELUM ada dan menghitungnya
    // terhadap baris yang SUDAH ada. Simulasi yang bisa merusak akan berhenti dijalankan orang,
    // dan simulasi yang ditakuti sama saja tidak punya simulasi.
    const simulate = text(request.nextUrl.searchParams.get("simulate"));
    if (simulate) {
    let terbit: Record<string, unknown>;
        try {
            terbit = await fromBackend(request, `/published/${encodeURIComponent(simulate)}`);
        } catch (error) {
            return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "gagal" }, { status: 502 });
        }
        const letter = letterOf(terbit, simulate);
        const calon = bridgeRows(letter);
        const itemCodes = [...new Set(calon.rows.map((row) => row.itemCode).filter(Boolean))];
        const [uji, known, approval] = await Promise.all([
            trialLinesFor(itemCodes),
            itemCodes.length
                ? db.select({ no: item.no }).from(item).where(inArray(item.no, itemCodes))
                : Promise.resolve([] as { no: string }[]),
            db.select().from(promoLetterApproval).where(eq(promoLetterApproval.draftId, simulate)),
        ]);
        const hasil = simulateLetter(letter, uji);
        // Barang hantu diperiksa DI SINI juga, bukan hanya saat memuat: kalau orang baru tahu
        // kode barangnya tidak ada di master setelah menekan Muat, simulasinya tidak menjawab
        // pertanyaan yang seharusnya ia jawab.
        const ada = new Set(known.map((row) => row.no));
        const hilang = itemCodes.filter((code) => !ada.has(code));
        if (hilang.length) {
            hasil.warnings.unshift(`${hilang.length} kode barang TIDAK ADA di master Accurate dan tidak akan `
                + `dimuat: ${hilang.slice(0, 15).join(", ")}. Aturan untuk barang hantu tidak menahan apa pun.`);
        }
        const setuju = approval[0];
        return NextResponse.json({
            ok: true, simulasi: hasil, barangHilang: hilang,
            persetujuan: {
                dicentang: Boolean(setuju?.confirmed), dicentangOleh: setuju?.confirmedBy ?? "",
                dicentangPada: setuju?.confirmedAt ?? null, catatan: setuju?.note ?? "",
                buktiNama: setuju?.fileName ?? "", buktiUkuran: setuju?.fileSize ?? 0,
                buktiOleh: setuju?.uploadedBy ?? "", buktiPada: setuju?.uploadedAt ?? null,
            },
        });
    }

    try {
        const body = await fromBackend(request, "/published/list");
        const published = (body.published ?? []) as Record<string, unknown>[];
        // Yang SUDAH pernah dimuat ditandai, supaya "muat ulang" adalah keputusan sadar dan
        // bukan kebetulan. Dicari dari jejaknya, bukan dari ingatan layar.
        const dimuat = await db.select({ ref: promoRule.sourceRef, surat: promoRule.suratProgram })
            .from(promoRule).where(eq(promoRule.source, "surat"));
        const refs = new Set(dimuat.map((row) => row.ref));
        return NextResponse.json({
            ok: true,
            published: published.map((entry) => ({ ...entry, sudahDimuat: refs.has(String(entry.draft_id ?? "")) })),
        });
    } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "gagal" }, { status: 502 });
    }
}

export async function POST(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const draftId = text(body?.draftId);
    if (!draftId) return NextResponse.json({ ok: false, error: "Sebutkan publikasi yang mau dimuat" }, { status: 400 });

    // GERBANG PERSETUJUAN. Menerbitkan di Summary saja tidak cukup lagi (permintaan pengguna
    // 2026-09-15): aturan yang lahir dari sini menahan faktur sungguhan dan mengesahkan potongan
    // sungguhan, jadi ia menuntut dua pernyataan manusia yang sistem tidak bisa buat sendiri —
    // CENTANG bahwa programnya benar dan bisa berjalan, dan BUKTI surat bertanda tangan.
    //
    // Diperiksa SEBELUM apa pun dihitung: menolak di akhir berarti orang menunggu proses panjang
    // untuk sesuatu yang sejak awal tidak akan tersimpan.
    const [setuju] = await db.select().from(promoLetterApproval)
    .where(eq(promoLetterApproval.draftId, draftId));
    if (!setuju?.confirmed) {
    return NextResponse.json({
        ok: false,
        error: "Publikasi ini belum dinyatakan benar. Jalankan simulasinya dulu, periksa hasilnya, "
            + "lalu centang \u201cprogram ini sudah benar dan bisa berjalan\u201d.",
    }, { status: 409 });
    }
    if (!setuju.fileSize) {
    return NextResponse.json({
        ok: false,
        error: "Bukti surat bertanda tangan belum diunggah. Sistem bisa menilai apakah aturannya "
            + "terbaca, tetapi tidak bisa menilai apakah programnya memang disetujui OM dan tim \u2014 "
            + "jadi buktinya wajib ada sebelum aturannya berlaku.",
    }, { status: 409 });
    }

    let terbit: Record<string, unknown>;
    try {
        terbit = await fromBackend(request, `/published/${encodeURIComponent(draftId)}`);
    } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "gagal" }, { status: 502 });
    }

    const letter = letterOf(terbit, draftId, text(body?.principal));

    const hasil = bridgeRows(letter);
    if (!hasil.rows.length) {
        return NextResponse.json({
            ok: false,
            error: "Tidak ada satu pun aturan yang bisa dinyatakan dari publikasi ini",
            ditolak: hasil.refused, catatan: hasil.notes,
        }, { status: 422 });
    }

    // Barang yang tidak ada di master Accurate DITAHAN di sini, bukan dibiarkan jadi aturan yang
    // tidak akan pernah cocok. Aturan untuk barang hantu tidak menahan apa pun; ia hanya
    // membuat layar terlihat penuh.
    const itemCodes = [...new Set(hasil.rows.map((row) => row.itemCode).filter(Boolean))];
    const catatan = [...hasil.notes];
    const ditolak = [...hasil.refused];
    const known = itemCodes.length
        ? new Set((await db.select({ no: item.no }).from(item).where(inArray(item.no, itemCodes))).map((row) => row.no))
        : new Set<string>();
    const hilang = itemCodes.filter((code) => !known.has(code));
    if (hilang.length) {
        ditolak.push(`${hilang.length} kode barang tidak ada di master Accurate dan tidak dimuat: ${hilang.slice(0, 15).join(", ")}`);
    }
    const rows = hasil.rows.filter((row) => !row.itemCode || known.has(row.itemCode));
    if (!rows.length) {
        return NextResponse.json({ ok: false, error: "Semua barang pada publikasi ini tidak ada di master Accurate", ditolak, catatan }, { status: 422 });
    }

    // Daftar outlet khusus ikut dimuat kalau publikasinya membawanya. Kodenya diterjemahkan
    // lewat `principal_mapping`/master pelanggan — tidak pernah ditebak.
    let outletDimuat = 0;
    if (letter.outletCodes.length) {
        const [maps, pelanggan] = await Promise.all([
            db.select({ source: principalMapping.sourceCode, target: principalMapping.targetCode })
                .from(principalMapping).where(eq(principalMapping.kind, "customer")),
            db.select({ no: customer.customerNo, name: customer.name }).from(customer),
        ]);
        const mapping = new Map(maps.map((row) => [row.source.trim().toUpperCase(), row.target.trim().toUpperCase()]));
        const internal = new Map<string, string>();
        for (const row of pelanggan) {
            const no = row.no.trim().toUpperCase();
            const base = no.split("-").length >= 3 ? no.slice(0, no.lastIndexOf("-")) : no;
            if (!internal.has(base)) internal.set(base, row.name);
        }
        // Satu daftar PER SURAT, dengan nama yang persis dipakai aturannya. Publikasi yang
        // menumpuk beberapa surat menghasilkan beberapa nama; menulis semuanya di bawah satu
        // nama saja membuat aturan surat lain menunjuk daftar yang tidak pernah ada — dan
        // daftar yang tidak ada MENAHAN semuanya.
        const anggota: (typeof promoOutlet.$inferInsert)[] = [];
        for (const listName of hasil.outletLists) {
            for (const kode of letter.outletCodes) {
                const atas = kode.toUpperCase();
                const code = mapping.get(atas) ?? (internal.has(atas) ? atas : "");
                if (!code || !internal.has(code)) { ditolak.push(`Outlet ${kode} pada daftar publikasi tidak ada di master pelanggan`); continue; }
                anggota.push({
                    listName, customerCode: code, customerName: internal.get(code) ?? "",
                    sourceCode: mapping.has(atas) ? atas : "", periodStart: null, periodEnd: null, active: true,
                    note: `dari publikasi Summary ${draftId.slice(0, 8)}`, importedBy: gate.email!,
                });
            }
        }
        if (anggota.length) {
            const ditulis = await db.insert(promoOutlet).values(anggota)
                .onConflictDoUpdate({
                    target: [promoOutlet.listName, promoOutlet.customerCode],
                    set: { customerName: sql`excluded.customer_name`, sourceCode: sql`excluded.source_code`,
                        active: sql`excluded.active`, note: sql`excluded.note`, importedBy: gate.email!, importedAt: new Date() },
                })
                .returning({ id: promoOutlet.id });
            outletDimuat = ditulis.length;
        }
    }

    // Irisan yang diganti: aturan `source='surat'` milik SURAT INI pada principal ini. Muat
    // ulang publikasi yang sama harus menghasilkan keadaan yang sama, bukan menumpuk.
    // Irisan yang diganti dikunci per PRINCIPAL + NOMOR SURAT, bukan per publikasi
    // (keputusan pengguna 2026-09-16).
    //
    // Summary kini MENUMPUK: surat kedua menyusul ke grid yang sama, lalu seluruhnya
    // diterbitkan sebagai publikasi baru. Kalau irisannya dikunci per publikasi, memuat
    // Summary v2 tidak mencabut apa pun dari v1 — surat pertama akan punya DUA set aturan yang
    // sama-sama hidup, dan gerbang akan melihat keduanya. Itu persis yang hendak dihindari
    // pengguna dengan "satu summary saja, surat lama tidak berlaku lagi".
    //
    // Konsekuensinya ditulis terang supaya tidak mengejutkan: satu surat harus dimuat
    // SEKALIGUS. Memuat sebagian barangnya saja akan mencabut sisanya. Dalam bentuk Summary
    // yang menumpuk itu memang selalu terjadi sekaligus, karena seluruh baris surat itu ada di
    // grid yang sama.
    const suratDimuat = [...new Set(rows.map((row) => row.suratProgram).filter(Boolean))];
    if (!suratDimuat.length) {
        return NextResponse.json({ ok: false, error: "Publikasi ini tidak menyebut nomor surat; aturan tanpa asal tidak boleh masuk gerbang", ditolak, catatan }, { status: 422 });
    }

    const ditulis = await db.transaction(async (tx) => {
        await tx.delete(promoRule).where(and(
            eq(promoRule.source, "surat"),
            eq(promoRule.principal, letter.principal),
            inArray(promoRule.suratProgram, suratDimuat),
        ));
        const values = rows.map((row) => ({
            ...row, importedBy: gate.email!, source: "surat", sourceRef: draftId,
        }));
        for (let start = 0; start < values.length; start += 500) {
            await tx.insert(promoRule).values(values.slice(start, start + 500));
        }
        return values.length;
    });

    return NextResponse.json({
        ok: true, suratProgram: suratDimuat.join(", "), principal: letter.principal,
        aturan: ditulis, outlet: outletDimuat,
        program: (letter.programs ?? []).length,
        ditolak, catatan,
    });
}
