/*
 * Tujuan: Membedah item yang hanya punya Kode Barang Win + Nama Win menjadi kolom Form Fix
 *   (klp, sub klp, sub klp2, aroma, gramasi, isi/ctn, kemasan). Deterministik, tanpa AI.
 * Caller: lib/master-barang/legacy.ts dan jalur upload master yang sumbernya kode+nama saja.
 * Dependensi: tidak ada.
 *
 * Cara kerja: kode memberi KERANGKA (segmen mana yang terpakai), nama memberi LABEL-nya.
 *   Kode 14/15 digit: Pcpl(2) KLP(2) Sub(1) Sub2(1) Aroma(2) Gramasi(4) Kemasan(1) Promo(1) [Rev(1)]
 *   Nama Win       : <PCPL> <KLP> <SUB> <SUB2> <AROMA> <GRAMASI> X <ISI> <KEMASAN...>
 * Batas kata antara KLP dan AROMA tidak ada di kode, jadi disimpulkan lintas baris: semua baris
 * ber-kode KLP sama harus berawalan kata yang sama, dan awalan terpanjang itulah nama KLP.
 */

export type BreakdownInput = { kode: string; nama: string };
export type BreakdownResult = {
    klp: string;
    subKlp: string;
    subKlp2: string;
    aroma: string;
    gramasi: string;
    isiCtn: string;
    kemasan: string;
    notes: string[];
};

const SEG = { pcpl: [0, 2], klp: [2, 4], sub: [4, 5], sub2: [5, 6], aroma: [6, 8], gram: [8, 12], kemasan: [12, 13], promo: [13, 14] } as const;
const GRAM_TOKEN = /^\d+(?:[.,]\d+)?(?:KG|GR|G|ML|LTR|LT|L)$/;

const upper = (value: string) => (value ?? "").toString().toUpperCase().replace(/\s+/g, " ").trim();

/**
 * Kode Win = 2 karakter principal (diawali HURUF) + 12 digit (14), atau + digit revisi (15).
 * Huruf di depan wajib: tanpa itu barcode 14 digit ikut cocok dan strukturnya dibedah jadi sampah.
 */
export function isWinCode(kode: string): boolean {
    // Digit ke-15 boleh huruf: sebagian master memakai huruf sebagai penanda revisi (…5010B).
    return /^[A-Z][A-Z0-9]\d{12}[A-Z0-9]?$/.test(upper(kode));
}

function seg(kode: string, name: keyof typeof SEG): string {
    const [from, to] = SEG[name];
    return upper(kode).slice(from, to);
}

/**
 * Pisah nama Win jadi bagian tengah (label struktur) + gramasi + isi + kemasan.
 * "KNF SLEEK HAND WASH STRAWBERRY 4L X 4 JRG" -> middle=[SLEEK,HAND,WASH,STRAWBERRY] gram=4L isi=4 kemasan=JRG
 */
function splitName(nama: string, namaPcpl: string): { middle: string[]; gramasi: string; isiCtn: string; kemasan: string; bersih: boolean; notes: string[] } {
    const notes: string[] = [];
    // Sampah ekstraksi yang menempel di depan nama principal ("B>KNF SLEEK ...") dibuang dulu.
    const bersihkanAwalan = (value: string) => {
        const at = value.indexOf(upper(namaPcpl));
        return at > 0 && at <= 4 ? value.slice(at) : value;
    };
    let tokens = bersihkanAwalan(upper(nama)).split(" ").filter(Boolean);
    const pcplTokens = upper(namaPcpl).split(" ").filter(Boolean);
    let bersih = true;
    if (pcplTokens.every((token, i) => tokens[i] === token)) tokens = tokens.slice(pcplTokens.length);
    else if (pcplTokens.every((token, i) => tokens[i + 1] === token)) tokens = tokens.slice(pcplTokens.length + 1); // sampah 1 token di depan ("B> KNF ...")
    else { bersih = false; notes.push("Nama tidak diawali nama principal; awalan tidak dipotong."); }

    // "X" kadang menempel: "200G X12 JAR", "1MLX24 JAR". Dipecah HANYA bila tidak ada "X" berdiri
    // sendiri, supaya notasi isi bertingkat di tengah nama ("20X10X30GR") tidak ikut terpotong.
    if (!tokens.includes("X")) {
        const at = tokens.map((token) => /^(.*?)X(\d+)$/.exec(token)).findLastIndex(Boolean);
        if (at >= 0) {
            const [, head, isi] = /^(.*?)X(\d+)$/.exec(tokens[at]) as RegExpExecArray;
            tokens.splice(at, 1, ...[head, "X", isi].filter(Boolean));
        }
    }

    // " X <isi> <kemasan...>" — pakai pemisah X terakhir supaya "20X10X30GR" di tengah nama tidak ikut.
    let isiCtn = "";
    let kemasan = "";
    const xAt = tokens.lastIndexOf("X");
    if (xAt >= 0) {
        const tail = tokens.slice(xAt + 1);
        tokens = tokens.slice(0, xAt);
        if (tail.length && /^\d+$/.test(tail[0])) {
            isiCtn = tail[0];
            kemasan = tail.slice(1).join(" ");
        } else {
            kemasan = tail.join(" ");
            notes.push("Isi/CTN tidak ditemukan setelah 'X'.");
        }
    } else {
        notes.push("Nama tanpa pemisah 'X'; isi & kemasan tidak terbaca.");
    }

    let gramasi = "";
    if (tokens.length && GRAM_TOKEN.test(tokens[tokens.length - 1])) gramasi = tokens.pop() as string;
    return { middle: tokens, gramasi, isiCtn, kemasan, bersih, notes };
}

/** Awalan kata terpanjang yang sama di semua baris; disisakan minimal `keepAtLeast` kata per baris. */
function commonPrefix(groups: string[][], keepAtLeast: number): number {
    if (!groups.length) return 0;
    const limit = Math.min(...groups.map((tokens) => Math.max(0, tokens.length - keepAtLeast)));
    let n = 0;
    while (n < limit && groups.every((tokens) => tokens[n] === groups[0][n])) n++;
    return n;
}

/**
 * Bedah sekumpulan item sekaligus — perlu satu batch penuh karena batas KLP/aroma disimpulkan
 * lintas baris. Item tanpa kode Win yang sah dikembalikan apa adanya dengan catatan.
 */
export function breakdownByCode(items: BreakdownInput[], namaPcpl: string): BreakdownResult[] {
    const parsed = items.map((item) => ({
        kode: upper(item.kode),
        valid: isWinCode(item.kode),
        ...splitName(item.nama, namaPcpl),
    }));

    // Batas label disimpulkan bertingkat: KLP dulu (kelompok = kode KLP), lalu Sub, lalu Sub2.
    // Sisa kata setelah ketiganya = aroma. Aroma wajib kebagian >=1 kata bila kode aroma bukan "00".
    const cut = (level: "klp" | "sub" | "sub2", scopeOf: (i: number) => string, offset: number[]): number[] => {
        const buckets = new Map<string, number[]>();
        parsed.forEach((row, i) => {
            if (!row.valid) return;
            const code = seg(row.kode, level === "klp" ? "klp" : level === "sub" ? "sub" : "sub2");
            if (level !== "klp" && code === "0") return; // segmen tak terpakai -> label kosong
            const key = `${scopeOf(i)}|${code}`;
            const bucket = buckets.get(key) ?? [];
            bucket.push(i);
            buckets.set(key, bucket);
        });
        const out = new Array(parsed.length).fill(0);
        for (const idx of buckets.values()) {
            // Kelompok satu baris tidak punya pembanding: awalan = seluruh sisa dikurangi jatah aroma.
            // Hanya baris ber-awalan bersih yang boleh menentukan panjang awalan: satu nama kotor
            // (tanpa nama principal di depan) menggeser semua token dan menihilkan awalan sekelompok.
            const needAroma = idx.some((i) => seg(parsed[i].kode, "aroma") !== "00") ? 1 : 0;
            const dasar = idx.filter((i) => parsed[i].bersih);
            const n = commonPrefix((dasar.length ? dasar : idx).map((i) => parsed[i].middle.slice(offset[i])), needAroma);
            for (const i of idx) out[i] = n;
        }
        return out;
    };

    const afterKlp = cut("klp", () => "", new Array(parsed.length).fill(0));
    const subLen = cut("sub", (i) => seg(parsed[i].kode, "klp"), afterKlp);
    const afterSub = afterKlp.map((n, i) => n + subLen[i]);
    const sub2Len = cut("sub2", (i) => `${seg(parsed[i].kode, "klp")}|${seg(parsed[i].kode, "sub")}`, afterSub);
    const afterSub2 = afterSub.map((n, i) => n + sub2Len[i]);

    return parsed.map((row, i) => {
        const notes = [...row.notes];
        if (!row.valid) {
            notes.push(`Kode "${row.kode}" bukan Kode Barang Win; struktur tidak dibedah.`);
            return { klp: row.middle.join(" "), subKlp: "", subKlp2: "", aroma: "", gramasi: row.gramasi, isiCtn: row.isiCtn, kemasan: row.kemasan, notes };
        }
        let klp = row.middle.slice(0, afterKlp[i]).join(" ");
        const subKlp = row.middle.slice(afterKlp[i], afterSub[i]).join(" ");
        const subKlp2 = row.middle.slice(afterSub[i], afterSub2[i]).join(" ");
        let aroma = row.middle.slice(afterSub2[i]).join(" ");
        if (seg(row.kode, "aroma") !== "00" && !aroma) notes.push("Kode aroma terisi tapi nama tidak menyisakan kata untuk aroma.");
        // Kode aroma "00" = baris ini memang tanpa aroma; sisa kata milik KLP. Terjadi bila baris
        // lain sekelompok punya aroma, sehingga awalan bersama berhenti lebih awal.
        if (seg(row.kode, "aroma") === "00" && aroma && !subKlp && !subKlp2) {
            klp = [klp, aroma].filter(Boolean).join(" ");
            aroma = "";
        }
        if (!klp) notes.push("Nama KLP tidak dapat disimpulkan dari baris sekelompok.");
        return { klp, subKlp, subKlp2, aroma, gramasi: row.gramasi, isiCtn: row.isiCtn, kemasan: row.kemasan, notes };
    });
}
