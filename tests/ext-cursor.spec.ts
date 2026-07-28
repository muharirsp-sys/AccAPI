import { expect, test } from "@playwright/test";
import { clampLimit, formatCursor, parseCursor, EXT_DEFAULT_LIMIT, EXT_MAX_LIMIT } from "../lib/ext-sync";

test.describe("cursor delta feed Web Sales", () => {
  test("roundtrip mempertahankan timestamp dan id", () => {
    const c = { syncedAt: new Date("2026-07-25T03:11:22.123Z"), id: 1042 };
    expect(parseCursor(formatCursor(c))).toEqual(c);
  });

  test("id ikut dibaca, bukan cuma timestamp", () => {
    // Ini inti keyset-nya: satu batch upsert = satu now(), jadi banyak baris punya
    // synced_at identik. Kalau id hilang, sisa baris di timestamp itu terlewat permanen.
    const a = parseCursor("2026-07-25T03:11:22.123Z|7")!;
    const b = parseCursor("2026-07-25T03:11:22.123Z|8")!;
    expect(a.syncedAt.getTime()).toBe(b.syncedAt.getTime());
    expect(a.id).toBe(7);
    expect(b.id).toBe(8);
  });

  test("cursor rusak ditolak, tidak diam-diam jadi full resync", () => {
    for (const bad of ["", "|", "1042", "bukan-tanggal|1", "2026-07-25T03:11:22Z|abc", "2026-07-25T03:11:22Z|-1", "|5"]) {
      expect(parseCursor(bad), `harus null: ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  test("limit dijepit ke rentang aman", () => {
    expect(clampLimit(null)).toBe(EXT_DEFAULT_LIMIT);
    expect(clampLimit("0")).toBe(EXT_DEFAULT_LIMIT);
    expect(clampLimit("abc")).toBe(EXT_DEFAULT_LIMIT);
    expect(clampLimit("50")).toBe(50);
    expect(clampLimit("999999")).toBe(EXT_MAX_LIMIT);
  });
});
