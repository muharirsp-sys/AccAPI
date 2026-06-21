/*
 * Tujuan: Seed demo Form Kontrol SUPER — akun login (salesman/spv/sm), sales_profile,
 *   master alasan, JKS, dan AO harian Juni 2026 — dalam satu panggilan.
 * Caller: operator via `GET /api/seed/form-kontrol?secret=<CRON_SECRET>` (sekali jalan).
 * Kenapa endpoint (bukan script libsql): butuh runtime Next untuk hash password
 *   better-auth (auth.$context.password.hash) yang tidak bisa direplikasi di SQL biasa.
 * Idempotent: upsert by email / unique key. Aman dipanggil ulang.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { user, account, salesProfile, jksMaster, aoControlDaily, noOrderReason } from "@/db/schema";
import { NO_ORDER_REASONS } from "@/lib/form-kontrol/constants";

// Password demo — sengaja sederhana, ini data test. Ganti di produksi.
const SALESMAN_PW = "salesman123";
const SPV_PW = "spv12345";
const SM_PW = "sm123456";

const SALESMEN = [
    { code: "SLS-001", name: "Andi Pratama",   email: "sls001@super.test", principle: "GODREJ",       branch: "BANDUNG",  spv: "Budi Santoso", sm: "Hendra Wijaya" },
    { code: "SLS-002", name: "Siti Rahmawati", email: "sls002@super.test", principle: "MONTISS",      branch: "BANDUNG",  spv: "Budi Santoso", sm: "Hendra Wijaya" },
    { code: "SLS-003", name: "Rudi Hartono",   email: "sls003@super.test", principle: "MUSTIKA RATU", branch: "CIMAHI",   spv: "Dewi Lestari", sm: "Hendra Wijaya" },
    { code: "SLS-004", name: "Maya Anggraini", email: "sls004@super.test", principle: "SOFTEX",       branch: "CIMAHI",   spv: "Dewi Lestari", sm: "Hendra Wijaya" },
    { code: "SLS-005", name: "Fajar Nugroho",  email: "sls005@super.test", principle: "GODREJ",       branch: "SUMEDANG", spv: "Eko Saputra",  sm: "Hendra Wijaya" },
    { code: "SLS-006", name: "Lina Marlina",   email: "sls006@super.test", principle: "MONTISS",      branch: "SUMEDANG", spv: "Eko Saputra",  sm: "Hendra Wijaya" },
];

const HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];
const STORE_NAMES = ["Toko Maju", "Warung Jaya", "Minimart Berkah", "Toko Makmur", "Warung Sejahtera",
                     "Toko Barokah", "Kios Mandiri", "Toko Harapan", "Warung Rezeki", "Toko Abadi"];
const KOTA_MAP = { BANDUNG: "Bandung", CIMAHI: "Cimahi", SUMEDANG: "Sumedang" };
const RAYON_MAP = { BANDUNG: ["Rayon A", "Rayon B"], CIMAHI: ["Rayon C"], SUMEDANG: ["Rayon D"] };

// 5 toko/hari × 5 hari (pattern all, 4x/bln) + 3 Senin-ganjil + 2 Senin-genap (2x/bln)
function buildJksRows(s: typeof SALESMEN[number]) {
    const rows = [];
    let idx = 1;
    const kota = KOTA_MAP[s.branch as keyof typeof KOTA_MAP];
    const rayon = RAYON_MAP[s.branch as keyof typeof RAYON_MAP];
    for (const hari of HARI) {
        for (let i = 0; i < 5; i++, idx++) {
            rows.push({
                custCode: `${s.code}-T${String(idx).padStart(3, "0")}`,
                custName: `${STORE_NAMES[idx % STORE_NAMES.length]} ${idx}`,
                market: idx % 4 === 0 ? "MT" : "TT",
                alamat: `Jl. Demo No.${idx * 7}, ${kota}`,
                kota, hariKunjungan: hari, mingguPattern: "all",
                area: s.branch, rayon: rayon[idx % rayon.length], visitFrequency: 4,
            });
        }
    }
    for (let i = 0; i < 3; i++, idx++) {
        rows.push({ custCode: `${s.code}-T${String(idx).padStart(3, "0")}`, custName: `${STORE_NAMES[idx % STORE_NAMES.length]} ${idx}`,
            market: "TT", alamat: `Jl. Demo No.${idx * 7}, ${kota}`, kota, hariKunjungan: "Senin", mingguPattern: "ganjil", area: s.branch, rayon: rayon[0], visitFrequency: 2 });
    }
    for (let i = 0; i < 2; i++, idx++) {
        rows.push({ custCode: `${s.code}-T${String(idx).padStart(3, "0")}`, custName: `${STORE_NAMES[idx % STORE_NAMES.length]} ${idx}`,
            market: "TT", alamat: `Jl. Demo No.${idx * 7}, ${kota}`, kota, hariKunjungan: "Senin", mingguPattern: "genap", area: s.branch, rayon: rayon[0], visitFrequency: 2 });
    }
    return rows;
}

// Kalender Juni 2026: 1 Juni = Senin. Parity = ISO week (sama dgn getWeekParity di db.ts):
// minggu 23 (1-5 Jun)=ganjil, minggu 24 (8-12)=genap, minggu 25 (15-19)=ganjil.
const JUNI_WORKDAYS = [
    { date: "2026-06-01", hari: "Senin",  parity: "ganjil" }, { date: "2026-06-02", hari: "Selasa", parity: "ganjil" },
    { date: "2026-06-03", hari: "Rabu",   parity: "ganjil" }, { date: "2026-06-04", hari: "Kamis",  parity: "ganjil" },
    { date: "2026-06-05", hari: "Jumat",  parity: "ganjil" },
    { date: "2026-06-08", hari: "Senin",  parity: "genap"  }, { date: "2026-06-09", hari: "Selasa", parity: "genap"  },
    { date: "2026-06-10", hari: "Rabu",   parity: "genap"  }, { date: "2026-06-11", hari: "Kamis",  parity: "genap"  },
    { date: "2026-06-12", hari: "Jumat",  parity: "genap"  },
    { date: "2026-06-15", hari: "Senin",  parity: "ganjil" }, { date: "2026-06-16", hari: "Selasa", parity: "ganjil" },
    { date: "2026-06-17", hari: "Rabu",   parity: "ganjil" }, { date: "2026-06-18", hari: "Kamis",  parity: "ganjil" },
    { date: "2026-06-19", hari: "Jumat",  parity: "ganjil" },
];
const STATUSES = ["ordered", "ordered", "ordered", "active", "not_order", "not_order", "not_visited"];
const REASON_CODES = ["R01", "R02", "R07", "R09", "R14"];

export async function GET(req: Request) {
    const secret = new URL(req.url).searchParams.get("secret");
    if (!secret || secret !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ctx = await auth.$context;
    const now = new Date();
    const summary = { reasons: 0, users: 0, profiles: 0, jks: 0, ao: 0 };

    async function ensureUser(email: string, name: string, password: string, role: string) {
        const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
        if (existing.length) {
            await db.update(user).set({ role, emailVerified: true, updatedAt: now }).where(eq(user.id, existing[0].id));
            return existing[0].id;
        }
        const id = randomUUID();
        await db.insert(user).values({
            id, name, email, emailVerified: true, role,
            permissions: "{}", banned: false, createdAt: now, updatedAt: now,
        });
        const hash = await ctx.password.hash(password);
        await db.insert(account).values({
            id: randomUUID(), accountId: id, providerId: "credential", userId: id,
            password: hash, createdAt: now, updatedAt: now,
        });
        summary.users++;
        return id;
    }

    try {
        // 1) Master alasan tidak-order
        for (const r of NO_ORDER_REASONS) {
            await db.insert(noOrderReason).values({
                id: r.id, reasonCode: r.reasonCode, label: r.label,
                category: r.category, sortOrder: r.sortOrder, isActive: r.isActive,
            }).onConflictDoNothing();
            summary.reasons++;
        }

        // 2) Akun SPV & SM (login-able, tanpa sales_profile)
        await ensureUser("spv@super.test", "Budi Santoso (SPV)", SPV_PW, "spv");
        await ensureUser("sm@super.test", "Hendra Wijaya (SM)", SM_PW, "sm");

        // 3) Salesmen: user + account + sales_profile + JKS + AO
        for (const s of SALESMEN) {
            const userId = await ensureUser(s.email, s.name, SALESMAN_PW, "staff");

            await db.insert(salesProfile).values({
                id: randomUUID(), userId, salesCode: s.code, salesName: s.name,
                principle: s.principle, branch: s.branch, channel: "TT",
                spvName: s.spv, smName: s.sm, createdAt: now, updatedAt: now,
            }).onConflictDoUpdate({
                target: salesProfile.userId,
                set: { salesCode: s.code, salesName: s.name, principle: s.principle, branch: s.branch, spvName: s.spv, smName: s.sm, updatedAt: now },
            });
            summary.profiles++;

            const jksRows = buildJksRows(s);
            for (const t of jksRows) {
                await db.insert(jksMaster).values({
                    id: randomUUID(), salesCode: s.code, salesName: s.name,
                    custCode: t.custCode, custName: t.custName, market: t.market,
                    alamat: t.alamat, kota: t.kota, hariKunjungan: t.hariKunjungan,
                    mingguPattern: t.mingguPattern, area: t.area, rayon: t.rayon,
                    principle: s.principle, channel: t.market === "MT" ? "MT" : "TT",
                    visitFrequency: t.visitFrequency, isActive: true, createdAt: now, updatedAt: now,
                }).onConflictDoUpdate({
                    target: [jksMaster.salesCode, jksMaster.custCode, jksMaster.principle],
                    set: { custName: t.custName, hariKunjungan: t.hariKunjungan, mingguPattern: t.mingguPattern, visitFrequency: t.visitFrequency, isActive: true, updatedAt: now },
                });
                summary.jks++;
            }

            for (let di = 0; di < JUNI_WORKDAYS.length; di++) {
                const { date, hari, parity } = JUNI_WORKDAYS[di];
                const tokoHariIni = jksRows.filter(t => t.hariKunjungan === hari && (t.mingguPattern === "all" || t.mingguPattern === parity));
                for (let i = 0; i < tokoHariIni.length; i++) {
                    const t = tokoHariIni[i];
                    const status = STATUSES[(di + i) % STATUSES.length];
                    const reason = status === "not_order" ? REASON_CODES[i % REASON_CODES.length] : null;
                    const visited = status !== "not_visited";
                    await db.insert(aoControlDaily).values({
                        id: randomUUID(), salesCode: s.code, custCode: t.custCode, principle: s.principle,
                        date, periodMonth: 6, periodYear: 2026, status,
                        isVisited: visited,
                        noOrderReasonCode: reason, noOrderNote: reason ? "Demo data" : null,
                        checkinAt: visited ? new Date(`${date}T08:30:00.000Z`) : null,
                        checkoutAt: (status === "ordered" || status === "active") ? new Date(`${date}T09:00:00.000Z`) : null,
                        autoMatched: false, source: "seed", createdAt: now, updatedAt: now,
                    }).onConflictDoNothing();
                    summary.ao++;
                }
            }
        }

        return NextResponse.json({
            ok: true, summary,
            logins: {
                salesman: SALESMEN.map(s => ({ email: s.email, sales: s.code, principle: s.principle })),
                spv: "spv@super.test", sm: "sm@super.test",
                passwords: { salesman: SALESMAN_PW, spv: SPV_PW, sm: SM_PW },
            },
        });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
}
