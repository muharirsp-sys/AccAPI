/*
 * Tujuan: Kunjungan LUAR RUTE + konfirmasi masuk JKS (FK-MSM2, pilot Form Kontrol cabang, owner 12 Okt 2026): salesman menambah toko yang
 *   tidak ada di rute JKS hari ini (pelanggan Accurate cabangnya) ke kunjungan hari ini; di akhir sesi memutuskan per toko: masuk JKS
 *   miliknya (hari + pola minggu) / tidak / nanti (tetap `menunggu`). Baris JKS hasil konfirmasi berkode pelanggan Accurate LENGKAP.
 * Caller: app/api/form-kontrol/luar-rute/route.ts (GET daftar, POST tambah), app/api/form-kontrol/luar-rute/konfirmasi/route.ts.
 * Dependensi: db (kunjungan_luar_rute, jks_master, ao_control_daily, sales_profile, kontrol_audit_log), lib/order-cabang (cocokKodeRute,
 *   GalatOrder), ./constants (kunciHari, hariBaku, MINGGU_PATTERNS, DAY_TO_HARI, paritasMinggu), ./db (parseDateString).
 * Main Functions: periksaKeputusan (murni; kodeJksUntuk di ./constants agar dipakai layar); tambahLuarRute, daftarLuarRute, konfirmasiLuarRute,
 *   batalLuarRute (DB).
 * Side Effects: INSERT/UPDATE kunjungan_luar_rute, INSERT/UPDATE jks_master (konfirmasi), INSERT kontrol_audit_log. Tidak pernah DELETE: "Batalkan"
 *   = batal LUNAK (dibatalkan_pada/oleh); baris batal tidak dibaca rute/daftar/kunjungan/Dashboard SPV dan tidak menghalangi tambah ulang.
 *
 * Cakupan (cabang pelanggan, pemilik salesman, tanggal hari ini, principal) diperiksa route SEBELUM memanggil fungsi di sini.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { aoControlDaily, jksMaster, kontrolAuditLog, kunjunganLuarRute, merchandisingCheck, salesProfile } from "@/db/schema";
import { cocokKodeRute, type GalatOrder } from "@/lib/order-cabang";
import { DAY_TO_HARI, MINGGU_PATTERNS, hariBaku, kodeJksUntuk, kunciHari, paritasMinggu } from "./constants";
import { parseDateString } from "./db";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";

// ---------------------------------------------------------------- murni

export type Minggu = (typeof MINGGU_PATTERNS)[number];
export type Keputusan = { keputusan: "tidak" } | { keputusan: "jks"; hari: string; minggu: Minggu };

/** Isian konfirmasi → keputusan sah, atau kalimat penolakan. Hari Senin–Sabtu (bentuk baku); minggu ganjil/genap/all (= setiap minggu). */
export function periksaKeputusan(body: Record<string, unknown>): Keputusan | { error: string } {
    if (body.keputusan === "tidak") return { keputusan: "tidak" };
    if (body.keputusan !== "jks") return { error: "Pilih: masukkan ke JKS, atau jangan masukkan JKS." };
    const hari = hariBaku(body.hari);
    if (!hari) return { error: "Pilih hari kunjungan Senin–Sabtu." };
    const minggu = String(body.mingguPattern ?? "").trim().toLowerCase();
    if (!(MINGGU_PATTERNS as readonly string[]).includes(minggu)) return { error: "Pilih minggu: ganjil, genap, atau setiap minggu." };
    return { keputusan: "jks", hari, minggu: minggu as Minggu };
}

const labelMinggu = (m: string | null | undefined) => (m === "all" ? "setiap minggu" : m === "ganjil" ? "minggu ganjil" : m === "genap" ? "minggu genap" : m ?? "—");
const jadwal = (j: { hariKunjungan: string | null; mingguPattern: string | null }) => `${j.hariKunjungan || "hari belum diisi"} · ${labelMinggu(j.mingguPattern)}`;
const galat = (status: number, kode: string, error: string): { galat: GalatOrder } => ({ galat: { status, kode, error } });
const kodeBesar = sql`upper(trim(${jksMaster.custCode}))`;

/** Baris JKS AKTIF salesman + principal ini untuk toko ini (kode pendek atau lengkap). */
async function jksMilik(salesCode: string, principle: string, customerNo: string, q: Pick<typeof db, "select"> = db) {
    const kandidat = kodeJksUntuk(customerNo);
    if (!kandidat.length) return [];
    const rows = await q.select({ id: jksMaster.id, custCode: jksMaster.custCode, hariKunjungan: jksMaster.hariKunjungan, mingguPattern: jksMaster.mingguPattern })
        .from(jksMaster).where(and(eq(jksMaster.salesCode, salesCode), eq(jksMaster.principle, principle), eq(jksMaster.isActive, true),
            inArray(kodeBesar, kandidat)));
    return rows.filter((j) => cocokKodeRute(j.custCode, customerNo));
}

/**
 * Catatan kunjungan toko baris luar rute ini pada tanggalnya. `hasil` = hanya kunjungan NYATA (check-in, hasil order/aktif/tidak order,
 * atau merchandising); tanpa `hasil` = baris AO APA PUN (juga "tidak dikunjungi"/prioritas dari Kirim status rute) atau merchandising.
 */
async function adaKunjungan(q: Pick<typeof db, "select">, k: BarisLuarRute, hasil: boolean): Promise<boolean> {
    const kunciAo = and(eq(aoControlDaily.salesCode, k.salesCode), eq(aoControlDaily.custCode, k.custCode), eq(aoControlDaily.principle, k.principle),
        eq(aoControlDaily.date, k.tanggal));
    const [ao] = await q.select({ id: aoControlDaily.id }).from(aoControlDaily).where(hasil
        ? and(kunciAo, or(isNotNull(aoControlDaily.checkinAt), inArray(aoControlDaily.status, ["ordered", "active", "not_order"]))) : kunciAo).limit(1);
    if (ao) return true;
    const [mc] = await q.select({ id: merchandisingCheck.id }).from(merchandisingCheck).where(and(eq(merchandisingCheck.salesCode, k.salesCode),
        eq(merchandisingCheck.custCode, k.custCode), eq(merchandisingCheck.principle, k.principle), eq(merchandisingCheck.date, k.tanggal))).limit(1);
    return Boolean(mc);
}

// ---------------------------------------------------------------- tambah

export type BarisLuarRute = typeof kunjunganLuarRute.$inferSelect;

/**
 * Tambah toko (pelanggan Accurate yang SUDAH diperiksa cabangnya oleh route) ke kunjungan salesman pada `tanggal`. Toko yang sudah ada di
 * rute JKS hari itu → 409 SUDAH_DI_RUTE (tidak ganda). Toko di JKS salesman ini pada hari lain → `sudah_jks` (tanpa keputusan JKS).
 * Menambah ulang toko yang sama = baris yang sama (`baru: false`), tidak ganda.
 */
export async function tambahLuarRute(d: {
    salesCode: string; principle: string; tanggal: string;
    pelanggan: { id: number; customerNo: string; name: string; alamat: string | null };
    aktorId: string; aktorNama: string | null;
}): Promise<{ row: BarisLuarRute; baru: boolean } | { galat: GalatOrder }> {
    const milik = await jksMilik(d.salesCode, d.principle, d.pelanggan.customerNo);
    const tgl = parseDateString(d.tanggal);
    const hari = DAY_TO_HARI[tgl.getDay()];
    const paritas = paritasMinggu(d.tanggal);
    // Sama dengan saringan SQL rute (db.ts hariIni/polaMinggu): kunci hari + pola minggu huruf kecil ter-trim.
    const diRute = hari ? milik.find((j) => kunciHari(j.hariKunjungan) === kunciHari(hari)
        && ["all", paritas].includes(String(j.mingguPattern ?? "").trim().toLowerCase())) : undefined;
    if (diRute) {
        return galat(409, "SUDAH_DI_RUTE", `${d.pelanggan.name} (${diRute.custCode}) sudah ada di rute Anda hari ini — buka dari daftar Toko di rute, tidak perlu ditambah.`);
    }
    const customerNo = d.pelanggan.customerNo.trim();
    const kunci = and(eq(kunjunganLuarRute.salesCode, d.salesCode), eq(kunjunganLuarRute.custCode, customerNo),
        eq(kunjunganLuarRute.principle, d.principle), eq(kunjunganLuarRute.tanggal, d.tanggal), isNull(kunjunganLuarRute.dibatalkanPada));
    return db.transaction(async (tx) => {
        const masuk = await tx.insert(kunjunganLuarRute).values({
            id: randomUUID(), salesCode: d.salesCode, principle: d.principle, tanggal: d.tanggal, custCode: customerNo,
            custName: d.pelanggan.name || customerNo, alamat: d.pelanggan.alamat, customerId: d.pelanggan.id,
            dibuatOleh: d.aktorId, dibuatOlehNama: d.aktorNama, konfirmasi: milik.length ? "sudah_jks" : "menunggu",
        }).onConflictDoNothing().returning({ id: kunjunganLuarRute.id });
        const [row] = await tx.select().from(kunjunganLuarRute).where(kunci).limit(1);
        if (masuk.length) {
            await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "luar_rute", entityId: row.id, action: "tambah",
                actorId: d.aktorId, actorName: d.aktorNama, createdAt: new Date(),
                payload: { salesCode: d.salesCode, principle: d.principle, tanggal: d.tanggal, custCode: customerNo, customerId: d.pelanggan.id } });
        }
        return { row, baru: masuk.length > 0 };
    });
}

// ---------------------------------------------------------------- daftar

export type JksTerkait = { salesCode: string; salesName: string; custCode: string; hariKunjungan: string | null; mingguPattern: string };

/**
 * Kunjungan luar rute salesman: SEMUA baris `tanggal` + baris tanggal lain yang masih `menunggu` dan SUDAH dikunjungi (check-in) — keputusan
 * "nanti" tetap terlihat sampai diputuskan. Per baris: status kunjungan (ao_control_daily), JKS salesman ini yang memuat toko itu (`jksSaya`)
 * dan JKS salesman LAIN principal sama (`jksLain`, peringatan sebelum konfirmasi).
 */
export async function daftarLuarRute(salesCode: string, tanggal: string) {
    const k = kunjunganLuarRute, ao = aoControlDaily;
    const rows = await db.select({
        k, status: ao.status, noOrderReasonCode: ao.noOrderReasonCode, checkinAt: ao.checkinAt, checkoutAt: ao.checkoutAt,
    }).from(k).leftJoin(ao, and(eq(ao.salesCode, k.salesCode), eq(ao.custCode, k.custCode), eq(ao.principle, k.principle), eq(ao.date, k.tanggal)))
        .where(and(eq(k.salesCode, salesCode), isNull(k.dibatalkanPada), or(eq(k.tanggal, tanggal),
            and(eq(k.konfirmasi, "menunggu"), isNotNull(ao.checkinAt), sql`${k.tanggal} < ${tanggal}`))))
        .orderBy(desc(k.tanggal), asc(k.custName));
    const kandidat = [...new Set(rows.flatMap((r) => kodeJksUntuk(r.k.custCode)))];
    const principals = [...new Set(rows.map((r) => r.k.principle))];
    const jks = kandidat.length ? await db.select({
        salesCode: jksMaster.salesCode, salesName: jksMaster.salesName, custCode: jksMaster.custCode, principle: jksMaster.principle,
        hariKunjungan: jksMaster.hariKunjungan, mingguPattern: jksMaster.mingguPattern,
    }).from(jksMaster).where(and(eq(jksMaster.isActive, true), inArray(jksMaster.principle, principals), inArray(kodeBesar, kandidat)))
        .orderBy(asc(jksMaster.salesCode)) : [];
    return rows.map(({ k: r, ...ao }) => {
        const cocok = jks.filter((j) => j.principle === r.principle && cocokKodeRute(j.custCode, r.custCode))
            .map(({ principle: _p, ...j }) => { void _p; return j; });
        return {
            id: r.id, tanggal: r.tanggal, custCode: r.custCode, custName: r.custName, alamat: r.alamat, principle: r.principle,
            konfirmasi: r.konfirmasi, hari: r.hari, mingguPattern: r.mingguPattern, jksId: r.jksId,
            dibuatPada: r.dibuatPada, dikonfirmasiOlehNama: r.dikonfirmasiOlehNama, dikonfirmasiPada: r.dikonfirmasiPada,
            status: ao.status ?? null, noOrderReasonCode: ao.noOrderReasonCode ?? null, checkinAt: ao.checkinAt ?? null, checkoutAt: ao.checkoutAt ?? null,
            jksSaya: cocok.filter((j) => j.salesCode === r.salesCode),
            jksLain: cocok.filter((j) => j.salesCode !== r.salesCode),
        };
    });
}

// ---------------------------------------------------------------- konfirmasi

/**
 * Keputusan salesman untuk satu kunjungan luar rute MILIKNYA. "tidak" = jangan masukkan JKS (boleh diubah lagi ke JKS). "jks" = tulis baris
 * JKS salesman ini (kode pelanggan LENGKAP, principal kunjungan, hari + pola minggu; frekuensi 4 untuk setiap minggu, 2 untuk ganjil/genap;
 * channel = channel JKS salesman yang paling banyak, atau profilnya). Baris yang sudah `jks`/`sudah_jks`/batal tidak diputuskan ulang (409).
 * Peninjau A 13 Okt: toko yang SUDAH di JKS salesman ini (unggahan kode pendek/lengkap, atau baris luar rute LAIN toko sama yang sudah
 * dikonfirmasi — juga yang menang saat serentak) → baris ini menjadi `sudah_jks` (jejak + audit `konfirmasi_sudah_jks`) lalu 409 SUDAH_DI_JKS,
 * untuk "jks" maupun "tidak" (bukan menunggu selamanya, bukan 'tidak' palsu). "jks" mensyaratkan toko benar DIKUNJUNGI pada tanggal baris
 * (check-in / hasil kunjungan / merchandising) → selain itu 409 BELUM_DIKUNJUNGI. Satu transaksi + kunci baris + jejak audit.
 * `jksLain` (JKS salesman lain, principal sama) dikembalikan sebagai peringatan, tidak menolak.
 */
export async function konfirmasiLuarRute(d: {
    id: string; salesCode: string; keputusan: Keputusan; aktorId: string; aktorNama: string | null;
}): Promise<{ row: BarisLuarRute; jksLain: JksTerkait[] } | { galat: GalatOrder }> {
    return db.transaction(async (tx) => {
        const [k] = await tx.select().from(kunjunganLuarRute)
            .where(and(eq(kunjunganLuarRute.id, d.id), eq(kunjunganLuarRute.salesCode, d.salesCode))).for("update").limit(1);
        if (!k) return galat(404, "LUAR_RUTE_TIDAK_ADA", "Kunjungan luar rute ini tidak ditemukan untuk kode sales Anda; muat ulang daftarnya.");
        if (k.dibatalkanPada) return galat(409, "SUDAH_DIBATALKAN", `Kunjungan ${k.custName} sudah dibatalkan; muat ulang daftarnya.`);
        if (k.konfirmasi === "jks") return galat(409, "SUDAH_DIKONFIRMASI", `${k.custName} sudah masuk JKS Anda (${jadwal({ hariKunjungan: k.hari, mingguPattern: k.mingguPattern })}).`);
        if (k.konfirmasi === "sudah_jks") return galat(409, "SUDAH_DI_JKS", `${k.custName} sudah ada di JKS Anda pada hari lain; tidak perlu dikonfirmasi.`);
        const now = new Date();
        const jejak = { dikonfirmasiOleh: d.aktorId, dikonfirmasiOlehNama: d.aktorNama, dikonfirmasiPada: now };
        const audit = (action: string, payload: Record<string, unknown>) => tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "luar_rute",
            entityId: k.id, action, actorId: d.aktorId, actorName: d.aktorNama, createdAt: now,
            payload: { salesCode: k.salesCode, principle: k.principle, tanggal: k.tanggal, custCode: k.custCode, sebelum: k.konfirmasi, ...payload } });

        const lainSemua = await tx.select({ salesCode: jksMaster.salesCode, salesName: jksMaster.salesName, custCode: jksMaster.custCode,
            hariKunjungan: jksMaster.hariKunjungan, mingguPattern: jksMaster.mingguPattern }).from(jksMaster)
            .where(and(eq(jksMaster.isActive, true), eq(jksMaster.principle, k.principle), ne(jksMaster.salesCode, k.salesCode),
                inArray(kodeBesar, kodeJksUntuk(k.custCode))));
        const jksLain = lainSemua.filter((j) => cocokKodeRute(j.custCode, k.custCode));
        const sudahJks = async (j: { custCode: string; hariKunjungan: string | null; mingguPattern: string | null }) => {
            await tx.update(kunjunganLuarRute).set({ konfirmasi: "sudah_jks", hari: null, mingguPattern: null, jksId: null, ...jejak })
                .where(eq(kunjunganLuarRute.id, k.id));
            await audit("konfirmasi_sudah_jks", { jks: j.custCode });
            return galat(409, "SUDAH_DI_JKS", `${k.custName} sudah ada di JKS Anda (${j.custCode}: ${jadwal(j)}); tidak ditambahkan lagi — kunjungan ini ditandai "sudah di JKS".`);
        };
        const [ada] = await jksMilik(k.salesCode, k.principle, k.custCode, tx);
        if (ada) return sudahJks(ada);

        if (d.keputusan.keputusan === "tidak") {
            const [row] = await tx.update(kunjunganLuarRute).set({ konfirmasi: "tidak", hari: null, mingguPattern: null, jksId: null, ...jejak })
                .where(eq(kunjunganLuarRute.id, k.id)).returning();
            await audit("konfirmasi_tidak", {});
            return { row, jksLain };
        }

        const { hari, minggu } = d.keputusan;
        if (!await adaKunjungan(tx, k, true)) {
            return galat(409, "BELUM_DIKUNJUNGI", `${k.custName} belum dikunjungi pada ${tanggalPanjang(k.tanggal)} (belum ada check-in, hasil kunjungan, atau merchandising); kunjungi dulu sebelum memasukkan ke JKS.`);
        }
        const [prof] = await tx.select({ salesName: salesProfile.salesName, channel: salesProfile.channel }).from(salesProfile)
            .where(eq(salesProfile.salesCode, k.salesCode)).limit(1);
        const [kanal] = await tx.select({ channel: jksMaster.channel }).from(jksMaster)
            .where(and(eq(jksMaster.salesCode, k.salesCode), eq(jksMaster.principle, k.principle), eq(jksMaster.isActive, true)))
            .groupBy(jksMaster.channel).orderBy(sql`count(*) desc`, asc(jksMaster.channel)).limit(1);
        const freq = minggu === "all" ? 4 : 2;
        const [jks] = await tx.insert(jksMaster).values({
            id: randomUUID(), salesCode: k.salesCode, salesName: prof?.salesName ?? k.salesCode, custCode: k.custCode, custName: k.custName,
            market: null, alamat: k.alamat, kota: null, hariKunjungan: hari, mingguPattern: minggu, area: null, rayon: null, principle: k.principle,
            channel: kanal?.channel || prof?.channel || "TT", visitFrequency: freq, isActive: true, createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
            // Kunci sama yang NONAKTIF (pernah digantikan unggahan) dihidupkan lagi dengan jadwal baru. Yang AKTIF = konfirmasi lain toko sama
            // baru saja menang (serentak; INSERT menunggu transaksinya) → tidak ditimpa, baris ini menjadi sudah_jks.
            target: [jksMaster.salesCode, jksMaster.custCode, jksMaster.principle],
            set: { custName: k.custName, alamat: k.alamat, hariKunjungan: hari, mingguPattern: minggu, visitFrequency: freq, isActive: true, updatedAt: now },
            setWhere: sql`${jksMaster.isActive} = false`,
        }).returning({ id: jksMaster.id });
        if (!jks) {
            const [menang] = await jksMilik(k.salesCode, k.principle, k.custCode, tx);
            return sudahJks(menang ?? { custCode: k.custCode, hariKunjungan: null, mingguPattern: null });
        }
        const [row] = await tx.update(kunjunganLuarRute).set({ konfirmasi: "jks", hari, mingguPattern: minggu, jksId: jks.id, ...jejak })
            .where(eq(kunjunganLuarRute.id, k.id)).returning();
        await audit("konfirmasi_jks", { jksId: jks.id, hari, mingguPattern: minggu, jksLain: jksLain.map((j) => j.salesCode) });
        return { row, jksLain };
    });
}

// ---------------------------------------------------------------- batal (owner 13 Okt)

/**
 * "Batalkan" kunjungan luar rute yang SALAH TAMBAH — batal LUNAK (dibatalkan_pada/oleh; accapi_app tanpa DELETE). Hanya baris MILIK `salesCode`
 * (sesi; selain itu 403 BUKAN_MILIK), tanggal = `hariIni` WITA server (409 BUKAN_HARI_INI), belum batal (409 SUDAH_DIBATALKAN), bukan `jks`
 * (409 SUDAH_DIKONFIRMASI), dan BELUM ada catatan apa pun untuk toko itu hari itu: baris ao_control_daily apa pun (check-in, status, atau
 * "tidak dikunjungi" dari Kirim status rute) atau merchandising (409 SUDAH_DIKUNJUNGI) — jadi baris batal tidak pernah terhitung di Dashboard
 * SPV/laporan. Kunci baris FOR UPDATE: dua batal serentak = satu 200, satu 409. Jejak: kolom batal + audit `luar_rute/batal`.
 * ponytail: check-in yang SERENTAK dengan batal tidak dikunci (ao_control_daily tidak memegang kunci baris ini) — baris AO bisa tercatat
 *   untuk kunjungan yang baru dibatalkan; jendela milidetik dari satu salesman di satu ponsel. Penutupnya: check-in memeriksa rute.
 */
export async function batalLuarRute(d: {
    id: string; salesCode: string; hariIni: string; aktorId: string; aktorNama: string | null;
}): Promise<{ row: BarisLuarRute } | { galat: GalatOrder }> {
    return db.transaction(async (tx) => {
        const [k] = await tx.select().from(kunjunganLuarRute).where(eq(kunjunganLuarRute.id, d.id)).for("update").limit(1);
        if (!k) return galat(404, "LUAR_RUTE_TIDAK_ADA", "Kunjungan luar rute ini tidak ditemukan; muat ulang rute.");
        if (k.salesCode !== d.salesCode) return galat(403, "BUKAN_MILIK", "Kunjungan luar rute ini milik salesman lain; hanya pemiliknya yang bisa membatalkan.");
        if (k.dibatalkanPada) return galat(409, "SUDAH_DIBATALKAN", `Kunjungan ${k.custName} sudah dibatalkan; muat ulang rute.`);
        if (k.tanggal !== d.hariIni) return galat(409, "BUKAN_HARI_INI", `Hanya kunjungan luar rute hari ini (${d.hariIni}) yang bisa dibatalkan; ini kunjungan ${k.tanggal}.`);
        if (k.konfirmasi === "jks") return galat(409, "SUDAH_DIKONFIRMASI", `${k.custName} sudah masuk JKS Anda; kunjungannya tidak bisa dibatalkan.`);
        if (await adaKunjungan(tx, k, false)) {
            return galat(409, "SUDAH_DIKUNJUNGI", `${k.custName} sudah punya status hari ini (check-in, status rute — termasuk "tidak dikunjungi" dari Kirim status rute — atau merchandising); kunjungannya tidak bisa dibatalkan.`);
        }
        const now = new Date();
        const [row] = await tx.update(kunjunganLuarRute).set({ dibatalkanPada: now, dibatalkanOleh: d.aktorId })
            .where(eq(kunjunganLuarRute.id, k.id)).returning();
        await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "luar_rute", entityId: k.id, action: "batal", actorId: d.aktorId,
            actorName: d.aktorNama, createdAt: now, payload: { salesCode: k.salesCode, principle: k.principle, tanggal: k.tanggal, custCode: k.custCode, konfirmasi: k.konfirmasi } });
        return { row };
    });
}
