/** Tujuan: Cocokkan Origin dengan alamat publik server, termasuk saat memakai reverse proxy.
 * Caller: API realisasi program. Dependensi: URL bawaan JavaScript.
 * Main Functions: hasExpectedOrigin. Side Effects: tidak ada.
 */
export function hasExpectedOrigin(origin: string | null, publicUrl: string): boolean {
    try {
        const expected = new URL(publicUrl);
        return ["http:", "https:"].includes(expected.protocol) && origin === expected.origin;
    } catch {
        return false;
    }
}
