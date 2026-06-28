/*
 * Tujuan: Pencocokan nama produk toleran-typo TANPA Elasticsearch/spellfix1.
 *   Fuzzy edit-distance hanya jalan di kamus nama unik (~11rb), bukan 4.5jt baris.
 *   Damerau-Levenshtein menghitung transposisi huruf (mis. "marei"↔"marie" = 1 langkah),
 *   sehingga typo ketukar-huruf tetap ketemu — yang gagal di FTS5 trigram.
 * Caller: lib/sales-history/service.ts (resolveFuzzyProduct → IN-clause ke index nama_produk).
 * Dependensi: lib/sales-history/db.ts (salesClient) untuk muat kamus.
 * Main Functions: damerau, wordMatches, matchVocabulary, resolveFuzzyProduct, runFuzzySelfCheck.
 * Side Effects: cache kamus in-memory (TTL), refresh saat stale.
 * Catatan perf: kamus ~11rb nama × early-exit DL < 1ms per kata (Int16Array, no heap alloc).
 */
import { salesClient } from "@/lib/sales-history/db";

const VOCAB_TTL_MS = 10 * 60 * 1000; // ponytail: import batch & jarang → refresh 10 menit cukup
const MAX_NAME_MATCHES = 500;
const MAX_OBJ_MATCHES = 200;

// Ambang edit-distance gaya Elasticsearch "fuzziness: AUTO", tapi Damerau (transposisi = 1).
function maxEditsFor(len: number): number {
    if (len <= 2) return 0;
    if (len <= 5) return 1;
    return 2;
}

// ponytail: module-level typed rows — Node.js single-threaded, aman tanpa lock; max 512 char/kata
const _MAX_DL = 512;
const _ra = new Int16Array(_MAX_DL + 1);
const _rb = new Int16Array(_MAX_DL + 1);
const _rc = new Int16Array(_MAX_DL + 1);

// Damerau-Levenshtein (optimal string alignment) dengan early-exit pada ambang `max`.
// Transposisi huruf bersebelahan dihitung 1 operasi (inti kemampuan "marei"→"marie").
// Row buffer di-rotate via swap pointer — tidak ada heap alloc per panggilan.
export function damerau(a: string, b: string, max: number): number {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    if (la === 0) return lb;
    if (lb === 0) return la;

    let r0 = _ra, r1 = _rb, r2 = _rc; // r1=prev, r0=curr, r2=prev2
    for (let j = 0; j <= lb; j++) r1[j] = j;

    for (let i = 1; i <= la; i++) {
        r0[0] = i;
        let rowMin = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            let v = Math.min(
                r1[j] + 1,        // hapus
                r0[j - 1] + 1,    // sisip
                r1[j - 1] + cost, // ganti
            );
            if (i > 1 && j > 1 &&
                ca === b.charCodeAt(j - 2) &&
                a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
                v = Math.min(v, r2[j - 2] + 1);
            }
            r0[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
        const tmp = r2; r2 = r1; r1 = r0; r0 = tmp; // rotate: prev2←prev, prev←curr, curr←scratch
    }
    return r1[lb];
}

// Satu kata query cocok dgn satu kata nama bila: exact, prefix (segala panjang, mirror ES bool_prefix),
// substring/infix (≥3 char), ATAU edit-distance ≤ ambang (typo/transposisi).
export function wordMatches(queryWord: string, nameWord: string): boolean {
    if (!queryWord) return true;
    if (nameWord === queryWord) return true;
    if (nameWord.startsWith(queryWord)) return true;                        // prefix: "nu"→"numtea", "hazel"→"hazeltea"
    if (queryWord.length >= 3 && nameWord.includes(queryWord)) return true; // substring/infix
    return damerau(queryWord, nameWord, maxEditsFor(queryWord.length)) <= maxEditsFor(queryWord.length);
}

function tokenize(value: string): string[] {
    return value.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

// Sebuah entri kamus cocok bila SETIAP kata query punya padanan kata di entri (semantik AND, mirror ES operator:"and").
function entryMatches(queryWords: string[], entryWords: string[]): boolean {
    for (const qw of queryWords) {
        let hit = false;
        for (const ew of entryWords) {
            if (wordMatches(qw, ew)) { hit = true; break; }
        }
        if (!hit) return false;
    }
    return true;
}

type Vocab = {
    names: string[];
    nameWords: string[][];
    objs: string[];
    objWords: string[][];
    loadedAt: number;
};

let cache: Vocab | null = null;
let loading: Promise<Vocab> | null = null;

async function loadVocab(): Promise<Vocab> {
    const [namesRes, objsRes] = await Promise.all([
        salesClient.execute("SELECT DISTINCT nama_produk FROM sales_history_item WHERE nama_produk <> ''"),
        salesClient.execute("SELECT DISTINCT kode_objek FROM sales_history_item WHERE kode_objek <> ''"),
    ]);
    const names = namesRes.rows.map((r) => String(r.nama_produk));
    const objs = objsRes.rows.map((r) => String(r.kode_objek));
    return {
        names,
        nameWords: names.map(tokenize),
        objs,
        objWords: objs.map(tokenize),
        loadedAt: Date.now(),
    };
}

async function getVocab(): Promise<Vocab> {
    if (cache && Date.now() - cache.loadedAt < VOCAB_TTL_MS) return cache;
    if (!loading) {
        loading = loadVocab().then((v) => { cache = v; loading = null; return v; })
            .catch((e) => { loading = null; throw e; });
    }
    return loading;
}

// Paksa muat ulang kamus (panggil setelah import data baru bila ingin langsung tercermin).
export function invalidateProductVocabulary(): void {
    cache = null;
}

// Panaskan kamus di background saat server start — agar query pertama tidak kena cold-start.
export async function initProductVocabulary(): Promise<void> {
    await getVocab();
}

export type FuzzyProductMatch = { names: string[]; objs: string[]; capped: boolean };

// Resolusi query produk → daftar nama_produk & kode_objek persis yang cocok (untuk IN-clause berindeks).
export async function resolveFuzzyProduct(product: string): Promise<FuzzyProductMatch> {
    const queryWords = tokenize(product);
    if (queryWords.length === 0) return { names: [], objs: [], capped: false };
    const vocab = await getVocab();

    const names: string[] = [];
    for (let i = 0; i < vocab.names.length && names.length < MAX_NAME_MATCHES; i++) {
        if (entryMatches(queryWords, vocab.nameWords[i])) names.push(vocab.names[i]);
    }
    const objs: string[] = [];
    for (let i = 0; i < vocab.objs.length && objs.length < MAX_OBJ_MATCHES; i++) {
        if (entryMatches(queryWords, vocab.objWords[i])) objs.push(vocab.objs[i]);
    }
    const capped = names.length >= MAX_NAME_MATCHES || objs.length >= MAX_OBJ_MATCHES;
    return { names, objs, capped };
}

// ponytail: self-check runnable — `node --experimental-strip-types lib/sales-history/fuzzy.ts`
export function runFuzzySelfCheck(): void {
    const ok = (c: boolean, msg: string) => { if (!c) throw new Error("FAIL: " + msg); };
    // Kasus inti user: transposisi i<->e harus ketemu.
    ok(damerau("marei", "marie", 2) === 1, "marei~marie harus DL=1 (transposisi)");
    ok(wordMatches("marei", "marie"), "'marei' harus cocok 'marie'");
    ok(entryMatches(["marei", "susu"], tokenize("Marie Susu Coklat 200g")), "'marei susu' harus cocok nama lengkap");
    // Partial multi-kata: "nu hazel" → "Nu Mtea Hazeltea" (prefix "nu" + prefix "hazel").
    ok(entryMatches(tokenize("nu hazel"), tokenize("Nu Mtea Hazeltea")), "'nu hazel' harus cocok 'Nu Mtea Hazeltea'");
    ok(entryMatches(tokenize("nu hazel"), tokenize("NUMTEA HAZELTEA RTD 250ML")), "'nu hazel' harus cocok varian token tergabung");
    // Negatif: kata yang jauh tidak boleh cocok.
    ok(!wordMatches("xyzzy", "marie"), "'xyzzy' tidak boleh cocok 'marie'");
    ok(!entryMatches(["kopi"], tokenize("Marie Susu Coklat")), "'kopi' tidak boleh cocok 'Marie Susu Coklat'");
    // Substring/prefix.
    ok(wordMatches("sus", "susu"), "prefix 'sus' harus cocok 'susu'");
    // Ambang panjang: kata pendek ketat.
    ok(maxEditsFor(2) === 0 && maxEditsFor(5) === 1 && maxEditsFor(6) === 2, "ambang AUTO");
    console.log("fuzzy self-check OK");
}

if (import.meta.url === `file://${process.argv[1]}`) runFuzzySelfCheck();
