/*
 * Tujuan: Baca & ubah setelan aturan insentif tanpa deploy: ambang Target AO skema GT,
 *   daftar cabang beracuan NILAI_JUAL, daftar SM yang ikut skema insentif SM, dan SELURUH
 *   konstanta uang (pool/bobot/ambang GT & MT, rate SPV, strata SM, tarif PPh).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (panel Admin).
 * Dependensi: lib/insentif-settings, lib/rbac/resolve.
 * Main Functions: GET mode aktif; PATCH ganti mode.
 * Side Effects: PATCH menulis app_setting dan MENGUBAH NOMINAL insentif GT/TT periode mana pun
 *   yang dihitung setelahnya — karena itu izinnya `manage`, bukan `input_support`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import {
    getGtAoTargetMode, setGtAoTargetMode, type GtAoTargetMode,
    getBranchNilaiJual, getSmBerhak, setDaftar,
    readKonstantaVersi, setKonstanta, KonstantaBerubahError,
    BRANCH_NILAI_JUAL_KEY, SM_BERHAK_KEY,
} from "@/lib/insentif-settings";
import { validateKonstanta, DEFAULT_KONSTANTA } from "@/lib/insentif-konstanta";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;
    // AM-020: tampilan boleh degraded (bawaan) bila setelan tak terbaca, tetapi DILABELI —
    // editor menolak menyimpan draf yang dasarnya fallback.
    const [gtAoMode, branchNilaiJual, smBerhak, [konstanta, konstantaSumber, konstantaVersi]] = await Promise.all([
        getGtAoTargetMode(), getBranchNilaiJual(), getSmBerhak(),
        readKonstantaVersi().then((r) => [r.konstanta, "tersimpan", r.versi] as const, () => [DEFAULT_KONSTANTA, "gagal_baca", null] as const),
    ]);
    return NextResponse.json({ gtAoMode, branchNilaiJual, smBerhak, konstanta, konstantaSumber, konstantaVersi, konstantaBawaan: DEFAULT_KONSTANTA });
}

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage");
    if (gate.response) return gate.response;

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) ?? {};
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // S6-0c 7b: SEMUA bagian divalidasi dulu, lalu konstanta (CAS, bisa 409) ditulis PERTAMA, baru penyebut AO/daftar. Dulu
    // penyebut AO/daftar sudah tertulis sebelum konstanta ditolak 400/409 — PATCH gabungan menulis sebagian.
    // ponytail: tanpa transaksi; galat DB di tengah (bukan penolakan) masih bisa menyisakan sebagian — penolakan tidak lagi.
    const mode = body.gtAoMode;
    // Nilai asing DITOLAK, bukan dijatuhkan ke default: "flie" yang salah ketik akan diam-diam
    // memakai ambang 240 dan penggunanya yakin sudah mengubah aturan.
    if ("gtAoMode" in body && mode !== "fixed240" && mode !== "file") {
        return NextResponse.json({ error: 'gtAoMode harus "fixed240" atau "file".' }, { status: 400 });
    }
    // Daftar sengaja divalidasi sebagai array string murni. Angka atau objek yang lolos akan
    // tersimpan sebagai "[object Object]" dan diam-diam tidak pernah cocok dengan cabang mana
    // pun — gejalanya "kok pencapaiannya turun", bukan pesan error.
    const daftar = ([["branchNilaiJual", BRANCH_NILAI_JUAL_KEY], ["smBerhak", SM_BERHAK_KEY]] as const).filter(([field]) => field in body);
    for (const [field] of daftar) {
        const nilai = body[field];
        if (!Array.isArray(nilai) || nilai.some((v) => typeof v !== "string")) {
            return NextResponse.json({ error: `${field} harus berupa array teks.` }, { status: 400 });
        }
    }
    // Konstanta uang: divalidasi dulu dan DITOLAK seluruhnya kalau ada satu angka aneh.
    // Menyimpan sebagian akan meninggalkan tabel rate setengah berubah — nominal yang keluar
    // bukan aturan lama maupun aturan baru.
    const adaKonstanta = "konstanta" in body;
    const versi = body.konstantaVersi;
    if (adaKonstanta) {
        const pesan = validateKonstanta(body.konstanta);
        if (pesan.length) return NextResponse.json({ error: pesan.join(" ") }, { status: 400 });
        // AM-045: tanpa versi yang dimuat, dua admin saling menimpa diam-diam. null = belum pernah disimpan.
        if (versi !== null && typeof versi !== "string") {
            return NextResponse.json({ error: "konstantaVersi wajib dikirim (muat ulang editor)." }, { status: 400 });
        }
        try {
            await setKonstanta(body.konstanta, gate.session.user.id, versi);
        } catch (e) {
            if (e instanceof KonstantaBerubahError) return NextResponse.json({ error: e.message, code: "KONSTANTA_BERUBAH" }, { status: 409 });
            throw e;
        }
    }
    if ("gtAoMode" in body) await setGtAoTargetMode(mode as GtAoTargetMode, gate.session.user.id);
    for (const [field, key] of daftar) await setDaftar(key, body[field] as string[], gate.session.user.id);

    // Review #3: bila konstanta ikut disimpan, jawaban ini menjadi dasar draf editor berikutnya -> baca STRICT. Tanpa konstanta
    // (penyebut AO/daftar saja) jawaban dilabeli seperti GET (S6-0c 7a): dulu konstanta tak terbaca = 500 padahal setelan sudah
    // tertulis, dan layar mengira gagal.
    const [gtAoMode, branchNilaiJual, smBerhak, [konstanta, konstantaSumber, konstantaVersi]] = await Promise.all([
        getGtAoTargetMode(), getBranchNilaiJual(), getSmBerhak(),
        readKonstantaVersi().then((r) => [r.konstanta, "tersimpan", r.versi] as const, (e) => {
            if (adaKonstanta) throw e;
            return [DEFAULT_KONSTANTA, "gagal_baca", null] as const;
        }),
    ]);
    return NextResponse.json({ gtAoMode, branchNilaiJual, smBerhak, konstanta, konstantaSumber, konstantaVersi, konstantaBawaan: DEFAULT_KONSTANTA });
}
