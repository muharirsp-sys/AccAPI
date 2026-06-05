/*
 * Tujuan: Fuzzy search utility ala Elasticsearch — match partial words, out-of-order tokens, dan typo-tolerant.
 * Caller: Semua filter/search di halaman dashboard (payments, finance, summary, off-program-control, DataTable).
 * Dependensi: Tidak ada (pure utility).
 * Main Functions: fuzzyMatch, fuzzyScore, tokenMatch.
 * Side Effects: Tidak ada.
 */

/**
 * Normalize string: lowercase, trim, collapse whitespace.
 */
function normalize(str: string): string {
    return str.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Check if `query` characters appear in order within `target` (subsequence match).
 * Example: "ptm" matches "PaTiMura" or "Payment"
 */
function subsequenceMatch(target: string, query: string): boolean {
    let qi = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) qi++;
    }
    return qi === query.length;
}

/**
 * Token-based matching: split query into words, each word must match (substring) at least one word in target.
 * Example: "uni indo" matches "PT Unilever Indonesia"
 */
function tokenMatch(target: string, query: string): boolean {
    const targetTokens = target.split(/[\s\-_./,;:]+/).filter(Boolean);
    const queryTokens = query.split(/[\s\-_./,;:]+/).filter(Boolean);

    if (queryTokens.length === 0) return true;

    return queryTokens.every((qt) =>
        targetTokens.some((tt) => tt.includes(qt) || subsequenceMatch(tt, qt))
    );
}

/**
 * Simple Levenshtein distance for short strings (typo tolerance).
 * Only used for individual tokens <= 8 chars to keep it fast.
 */
function levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    // Only compute for short strings
    if (m > 12 || n > 12) return Math.abs(m - n) + 1;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

/**
 * Check if any token in target is close enough to a query token (typo-tolerant).
 * Allowed edit distance: 1 for tokens 4-6 chars, 2 for tokens 7+ chars.
 */
function typoTolerantMatch(target: string, query: string): boolean {
    const targetTokens = target.split(/[\s\-_./,;:]+/).filter(Boolean);
    const queryTokens = query.split(/[\s\-_./,;:]+/).filter(Boolean);

    if (queryTokens.length === 0) return true;

    return queryTokens.every((qt) => {
        if (qt.length < 3) {
            // Too short for typo tolerance — require exact substring
            return targetTokens.some((tt) => tt.includes(qt));
        }
        const maxDist = qt.length <= 4 ? 1 : qt.length <= 6 ? 1 : 2;
        return targetTokens.some((tt) => {
            // Substring check first (fast path)
            if (tt.includes(qt)) return true;
            // Check beginning-of-token match (prefix fuzzy)
            const prefix = tt.slice(0, qt.length);
            if (levenshtein(prefix, qt) <= maxDist) return true;
            // For tokens of similar length, full comparison
            if (Math.abs(tt.length - qt.length) <= maxDist) {
                return levenshtein(tt, qt) <= maxDist;
            }
            return false;
        });
    });
}

/**
 * Main fuzzy match function — returns true if `query` fuzzy-matches `target`.
 * 
 * Match strategies (in order, first match wins):
 * 1. Exact substring (includes)
 * 2. Token-based matching (each query word matches a target word)
 * 3. Subsequence matching (characters appear in order)
 * 4. Typo-tolerant matching (Levenshtein distance)
 * 
 * Supports wildcard `%` for explicit pattern matching.
 * 
 * @example
 * fuzzyMatch("PT Unilever Indonesia Tbk", "uni indo")  // true — token match
 * fuzzyMatch("Payment #12345", "12345")                 // true — substring
 * fuzzyMatch("Indofood CBP Sukses", "indcbp")           // true — subsequence
 * fuzzyMatch("Unilever", "unilver")                     // true — typo tolerance
 */
export function fuzzyMatch(target: unknown, query: string): boolean {
    if (!query || !query.trim()) return true;
    if (target == null) return false;

    const t = normalize(String(target));
    const q = normalize(query);

    if (!t) return false;
    if (!q) return true;

    // Wildcard support (SQL-like %)
    if (q.includes("%")) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regexStr = escaped.replace(/%/g, ".*");
        try {
            return new RegExp(`^${regexStr}$`, "i").test(t);
        } catch {
            return false;
        }
    }

    // 1. Exact substring
    if (t.includes(q)) return true;

    // 2. Token-based matching
    if (tokenMatch(t, q)) return true;

    // 3. Subsequence (only if query is short enough relative to target)
    if (q.length >= 2 && q.length <= t.length * 0.7 && subsequenceMatch(t, q)) return true;

    // 4. Typo tolerance
    if (typoTolerantMatch(t, q)) return true;

    return false;
}

/**
 * Score a match (higher = better match). Useful for sorting results by relevance.
 * Returns 0 if no match.
 */
export function fuzzyScore(target: unknown, query: string): number {
    if (!query || !query.trim()) return 1;
    if (target == null) return 0;

    const t = normalize(String(target));
    const q = normalize(query);

    if (!t) return 0;
    if (!q) return 1;

    // Exact match
    if (t === q) return 100;

    // Starts with
    if (t.startsWith(q)) return 90;

    // Contains as substring
    if (t.includes(q)) return 80;

    // Token match
    if (tokenMatch(t, q)) return 60;

    // Subsequence
    if (q.length >= 2 && q.length <= t.length * 0.7 && subsequenceMatch(t, q)) return 40;

    // Typo tolerance
    if (typoTolerantMatch(t, q)) return 30;

    return 0;
}
