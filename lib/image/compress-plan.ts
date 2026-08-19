/*
 * Tujuan: Logika keputusan murni untuk kompresi foto bukti — resize, tangga kualitas, dan gerbang keterbacaan.
 * Caller: lib/image/compress.ts (jalur browser). Dipisah agar bisa di-self-check di Node tanpa API browser.
 * Dependensi: Tidak ada. Pure function, zero import.
 * Main Functions: EVIDENCE_PROFILES, planResize, qualityLadder, isBelowReadableFloor, describePlan.
 * Side Effects: Tidak ada. Tidak menyentuh DOM, canvas, jaringan, maupun filesystem.
 *
 * PRINSIP: floor keras, ceiling lunak. Kalau file tidak bisa mengecil tanpa menembus
 * batas keterbacaan, file besar yang menang — bukti tidak terbaca lebih buruk daripada
 * bukti besar. Data ini dipakai untuk evaluasi dan jadi source of truth.
 */

export type EvidenceProfile = "dokumen" | "kondisi";

export interface ProfileSpec {
    /** Target sisi panjang (px). Tidak pernah di-upscale melewati sumber. */
    longEdge: number;
    /** Kualitas JPEG awal (percobaan pertama). */
    qualityStart: number;
    /** Kualitas JPEG terendah yang boleh dipakai. FLOOR KERAS. */
    qualityFloor: number;
    /** Batas byte yang diincar. CEILING LUNAK — boleh ditembus demi floor. */
    targetBytes: number;
    /** Keterangan untuk log/audit. */
    note: string;
}

/**
 * dokumen : nota, bukti bayar, faktur — ADA TEKS KECIL yang harus terbaca.
 *           2400 px sisi panjang = ~290 DPI pada A5 (sisi panjang 210mm),
 *           ~205 DPI pada A4 (297mm). Dipilih 2400 (bukan 2000 = 242 DPI A5)
 *           agar mendekati standar OCR 300 DPI, sehingga foto nota masih bisa
 *           di-OCR di kemudian hari lewat pipeline Mistral OCR existing.
 *           Biaya keputusan ini: ~+20 GB/tahun. Murah untuk source of truth.
 * kondisi : foto outlet, display, kondisi barang — tanpa teks kecil,
 *           yang dinilai bentuk/warna/kelengkapan, bukan huruf.
 */
export const EVIDENCE_PROFILES: Record<EvidenceProfile, ProfileSpec> = {
    dokumen: {
        longEdge: 2400,
        qualityStart: 0.92,
        qualityFloor: 0.85,
        targetBytes: 700 * 1024,
        note: "teks kecil harus terbaca; layak OCR (~290 DPI A5)",
    },
    kondisi: {
        longEdge: 1400,
        qualityStart: 0.88,
        qualityFloor: 0.80,
        targetBytes: 220 * 1024,
        note: "tanpa teks kecil; cukup untuk menilai kondisi",
    },
};

/**
 * Di bawah ini foto DITOLAK, bukan diterima diam-diam. Bukti yang tidak terbaca
 * memberi rasa aman palsu — lebih buruk daripada tidak ada bukti sama sekali.
 */
export const MIN_ACCEPTABLE_LONG_EDGE = 1000;

/** Langkah penurunan kualitas per iterasi encode. */
const QUALITY_STEP = 0.04;

export interface ResizePlan {
    width: number;
    height: number;
    /** true bila dimensi berubah dari sumber. */
    resized: boolean;
    /**
     * Rantai penurunan bertahap (stepwise halving) dari sumber ke target.
     * Downscale >2x dalam satu langkah merusak ketajaman huruf; turun bertahap
     * mempertahankan stroke teks jauh lebih baik.
     */
    steps: Array<{ width: number; height: number }>;
}

/** true bila sumber terlalu kecil untuk dijadikan bukti — minta foto ulang. */
export function isBelowReadableFloor(srcWidth: number, srcHeight: number): boolean {
    return Math.max(srcWidth, srcHeight) < MIN_ACCEPTABLE_LONG_EDGE;
}

/**
 * Hitung dimensi target + rantai langkah. NEVER UPSCALE: kalau sumber sudah
 * lebih kecil dari target profil, dimensi dibiarkan apa adanya.
 */
export function planResize(
    srcWidth: number,
    srcHeight: number,
    profile: EvidenceProfile,
): ResizePlan {
    const spec = EVIDENCE_PROFILES[profile];
    const srcLong = Math.max(srcWidth, srcHeight);

    // Sumber lebih kecil / sama dengan target -> jangan diperbesar, jangan diubah.
    if (srcLong <= spec.longEdge) {
        return {
            width: srcWidth,
            height: srcHeight,
            resized: false,
            steps: [{ width: srcWidth, height: srcHeight }],
        };
    }

    const scale = spec.longEdge / srcLong;
    const targetW = Math.max(1, Math.round(srcWidth * scale));
    const targetH = Math.max(1, Math.round(srcHeight * scale));

    // Bangun rantai halving selama rasio ke target masih > 2x.
    const steps: Array<{ width: number; height: number }> = [];
    let w = srcWidth;
    let h = srcHeight;
    while (w > targetW * 2 && h > targetH * 2) {
        w = Math.max(targetW, Math.round(w / 2));
        h = Math.max(targetH, Math.round(h / 2));
        steps.push({ width: w, height: h });
    }
    if (w !== targetW || h !== targetH) {
        steps.push({ width: targetW, height: targetH });
    }

    return { width: targetW, height: targetH, resized: true, steps };
}

/**
 * Tangga kualitas dari qualityStart turun ke qualityFloor. Encode berhenti pada
 * nilai pertama yang muat di targetBytes; kalau tidak ada yang muat, nilai
 * terakhir (floor) dipakai dan hasilnya tetap diterima.
 */
export function qualityLadder(profile: EvidenceProfile): number[] {
    const { qualityStart, qualityFloor } = EVIDENCE_PROFILES[profile];
    const ladder: number[] = [];
    for (let q = qualityStart; q > qualityFloor + 1e-9; q -= QUALITY_STEP) {
        ladder.push(Number(q.toFixed(2)));
    }
    ladder.push(Number(qualityFloor.toFixed(2)));
    return ladder;
}

/** Ringkasan satu baris untuk log audit. */
export function describePlan(
    srcWidth: number,
    srcHeight: number,
    profile: EvidenceProfile,
): string {
    const plan = planResize(srcWidth, srcHeight, profile);
    const ladder = qualityLadder(profile);
    return `${profile} ${srcWidth}x${srcHeight} -> ${plan.width}x${plan.height}` +
        ` (${plan.steps.length} langkah, q ${ladder[0]}..${ladder[ladder.length - 1]})`;
}

/* -------------------------------------------------------------------------- */
/* Self-check: node --experimental-strip-types lib/image/compress-plan.ts     */
/* -------------------------------------------------------------------------- */

function selfCheck(): void {
    let failed = 0;
    const check = (name: string, cond: boolean, extra = "") => {
        if (!cond) { failed++; console.error(`  FAIL ${name} ${extra}`); }
        else console.log(`  ok   ${name}`);
    };

    // 1. Tidak pernah upscale.
    const small = planResize(800, 600, "dokumen");
    check("sumber 800x600 tidak di-upscale", small.width === 800 && small.height === 600 && !small.resized);

    // 2. Foto galeri besar turun ke floor profil, aspect ratio terjaga.
    const big = planResize(4032, 3024, "dokumen");
    check("4032x3024 -> sisi panjang 2400", big.width === 2400, `dapat ${big.width}`);
    check("aspect ratio terjaga (4:3)", Math.abs(big.width / big.height - 4032 / 3024) < 0.01);
    // 4032->2400 hanya 1.68x, jadi 1 langkah memang BENAR (tidak perlu halving).
    check("downscale <2x cukup 1 langkah", big.steps.length === 1, `steps=${big.steps.length}`);
    // Rasio >2x baru wajib bertahap: 6000->2400 = 2.5x.
    const huge = planResize(6000, 4500, "dokumen");
    check("downscale >2x pakai langkah bertahap", huge.steps.length >= 2, `steps=${huge.steps.length}`);
    check("langkah bertahap tidak pernah di bawah target", huge.steps.every(s => s.width >= huge.width));

    // 3. Profil kondisi lebih agresif daripada dokumen.
    const doc = planResize(4032, 3024, "dokumen");
    const kon = planResize(4032, 3024, "kondisi");
    check("kondisi lebih kecil daripada dokumen", kon.width < doc.width);

    // 4. Gerbang keterbacaan.
    check("640x480 ditolak", isBelowReadableFloor(640, 480));
    check("1280x720 diterima", !isBelowReadableFloor(1280, 720));
    check("portrait 720x1280 diterima", !isBelowReadableFloor(720, 1280));

    // 5. Tangga kualitas menghormati floor dan menurun monoton.
    for (const p of ["dokumen", "kondisi"] as EvidenceProfile[]) {
        const l = qualityLadder(p);
        const spec = EVIDENCE_PROFILES[p];
        check(`${p}: tangga mulai di qualityStart`, l[0] === spec.qualityStart, `dapat ${l[0]}`);
        check(`${p}: tangga berakhir di qualityFloor`, l[l.length - 1] === spec.qualityFloor, `dapat ${l[l.length - 1]}`);
        check(`${p}: tidak ada nilai di bawah floor`, l.every(q => q >= spec.qualityFloor));
        check(`${p}: menurun monoton`, l.every((q, i) => i === 0 || q < l[i - 1]));
    }

    // 6. Langkah terakhir selalu tepat di dimensi target.
    const last = big.steps[big.steps.length - 1];
    check("langkah terakhir == dimensi target", last.width === big.width && last.height === big.height);

    // 7. DPI sanity. A5 sisi panjang 210mm = 8.27in; A4 297mm = 11.69in.
    //    Ambang 285 DPI = "mendekati standar OCR 300 DPI" secara sadar,
    //    bukan angka yang dikarang untuk lulus test.
    const dpiA5 = EVIDENCE_PROFILES.dokumen.longEdge / 8.27;
    const dpiA4 = EVIDENCE_PROFILES.dokumen.longEdge / 11.69;
    check("dokumen A5 >= 285 DPI (mendekati grade OCR)", dpiA5 >= 285, `dapat ${dpiA5.toFixed(0)} DPI`);
    check("dokumen A4 >= 200 DPI (terbaca manusia)", dpiA4 >= 200, `dapat ${dpiA4.toFixed(0)} DPI`);
    // Tinggi huruf: body nota ~10pt, cap-height ~0.097in.
    const capPx = 0.097 * dpiA5;
    check("cap-height 10pt >= 20px (andal utk OCR)", capPx >= 20, `dapat ${capPx.toFixed(0)} px`);

    console.log(`\n${failed === 0 ? "SEMUA CHECK LULUS" : `${failed} CHECK GAGAL`}`);
    console.log(describePlan(4032, 3024, "dokumen"));
    console.log(describePlan(1280, 720, "kondisi"));
}

if (typeof process !== "undefined" && process.argv?.[1]?.includes("compress-plan")) {
    selfCheck();
}
