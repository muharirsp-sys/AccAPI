/*
 * Tujuan: Deteksi kandidat penggabungan sales — beberapa kode sales berbeda yang memakai
 *   prefiks rute/slot yang sama (mis. MS10_ISMAIL KADIR vs MS10_TANSI), yang biasanya berarti
 *   pergantian orang di tengah bulan. Pencapaian digabung ke kode yang dipilih user.
 * Caller: lib/insentif-sales (agregasi MTD), app/api/insentif-sales/code-merge.
 * Dependensi: tidak ada (pure).
 * Main Functions: namePrefix, groupByPrefix, applyMergeMap.
 * Side Effects: none.
 *
 * PENTING: penggabungan TIDAK PERNAH otomatis. Prefiks sama tidak selalu berarti orang yang
 * sama digantikan — contoh nyata FS1_GITO (GT) vs FS1_MT_SYAHRUL (MT): dua orang berbeda,
 * channel berbeda, nomor rute kebetulan sama. Karena itu hasil fungsi ini hanya KANDIDAT
 * yang harus dikonfirmasi user, bukan keputusan.
 */

/**
 * Prefiks rute/slot dari nama salesman di file closing.
 * "MS10_TANSI" → "MS10" | "M2_5_MT_YUANITA" → "M2_5" | "FS1_MT_SYAHRUL" → "FS1"
 * Penanda channel (_MT_) bukan bagian prefiks — supaya GT & MT dengan nomor sama tetap
 * terdeteksi sebagai kandidat dan bisa ditolak user secara sadar.
 * null kalau nama tidak berpola prefiks (mis. "SPV_SUMARTONO", "EN_OFFICE").
 */
export function namePrefix(salesName: string): string | null {
    const s = (salesName ?? "").trim().toUpperCase();
    // M2_5_MT_NAMA / M2_1_NAMA → M2_5 / M2_1
    const multi = s.match(/^([A-Z]+\d+_\d+)_/);
    if (multi) return multi[1];
    // MS10_NAMA / KN2_NAMA / FS1_MT_NAMA → MS10 / KN2 / FS1
    const single = s.match(/^([A-Z]+\d+)_/);
    if (single) return single[1];
    return null;
}

export interface CodeNamePair {
    salesCode: string;
    salesName: string;
}

export interface MergeCandidateGroup {
    prefix: string;
    members: CodeNamePair[];
}

/**
 * Kelompokkan pasangan kode+nama menurut prefiks. Hanya kelompok berisi >1 kode
 * yang dikembalikan (kelompok tunggal bukan kandidat).
 */
export function groupByPrefix(pairs: CodeNamePair[]): MergeCandidateGroup[] {
    const byPrefix = new Map<string, Map<string, string>>();
    for (const p of pairs) {
        const prefix = namePrefix(p.salesName);
        if (!prefix) continue;
        const inner = byPrefix.get(prefix) ?? new Map<string, string>();
        if (!inner.has(p.salesCode)) inner.set(p.salesCode, p.salesName);
        byPrefix.set(prefix, inner);
    }
    const out: MergeCandidateGroup[] = [];
    for (const [prefix, inner] of byPrefix) {
        if (inner.size < 2) continue;
        out.push({
            prefix,
            members: [...inner].map(([salesCode, salesName]) => ({ salesCode, salesName }))
                .sort((a, b) => a.salesCode.localeCompare(b.salesCode)),
        });
    }
    return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * Terjemahkan kode sales lewat peta merge (from → to). Rantai diikuti (A→B, B→C ⇒ A→C)
 * dengan batas iterasi supaya siklus data rusak tidak menggantung.
 */
export function applyMergeMap(salesCode: string, mergeMap: Map<string, string>): string {
    let code = salesCode;
    for (let i = 0; i < 10; i++) {
        const next = mergeMap.get(code);
        if (!next || next === code) return code;
        code = next;
    }
    return code; // ponytail: batas 10 hop; data siklik berhenti di sini, bukan hang.
}
