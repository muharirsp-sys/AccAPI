// ponytail: 500 dari server balasannya HTML/kosong, bukan JSON — r.json() langsung meledak jadi SyntaxError
export async function jsonOrThrow<T>(r: Response): Promise<T> {
    const text = await r.text();
    let d: unknown = null;
    try { d = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }
    if (!r.ok || d === null) {
        throw new Error((d as { error?: string } | null)?.error || `HTTP ${r.status}`);
    }
    return d as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
