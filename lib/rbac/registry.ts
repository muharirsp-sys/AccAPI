/*
 * Tujuan: SUMBER TUNGGAL daftar permission key valid untuk Dynamic RBAC (Fase 2/4 — Opsi A).
 * Caller: lib/rbac/resolve.ts (guard route), UI admin RBAC (P6), registry.test.ts (guard test).
 * Main Functions: PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey, CAPABILITY_KEYS, moduleAllOn, toggleModuleKeys.
 * Side Effects: Tidak ada; pure registry permission in-memory.
 * Dependensi: TIDAK ADA (pure data) — sengaja bebas import agar bisa di-test di mana saja.
 * Catatan: permission baru = tambah action di sini → otomatis terbaca RBAC. Default-deny:
 *   key yang TIDAK ada di registry ditolak; test-guard gagal kalau route pakai key tak terdaftar.
 *   `moduleActions` di lib/rbac.ts tetap ada untuk preset legacy selama transisi.
 */

// module -> daftar action valid. Permission key = `${module}.${action}`.
export const PERMISSION_REGISTRY = {
    dashboard: ["view"],
    api_wrapper: ["view", "execute"],
    // Order Masuk internal. Tanpa pendaftaran di sini, Access Group TIDAK BISA memberi
    // izin ini (registry adalah satu-satunya daftar key yang boleh disimpan) — jadi
    // modulnya hanya bisa dipakai admin. Ketinggalan saat modul order dibuat.
    order: ["view", "create", "edit", "export"],
    // Order Sales (Web Sales). SENGAJA terpisah dari `order`: `order.create` membuka
    // POST /orders internal yang menerima harga dari klien, sedangkan sales hanya boleh
    // mengirim kode/satuan/jumlah. Akun sales cukup `websales.view` + `websales.create`.
    websales: ["view", "create"],
    payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
    sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
    // Aksi yang MEMBUKA kiriman ulang ke Accurate (owner D-14/D-15/D-18, 2026-09-30) = kewenangan Finance,
    //   satu kunci per kapabilitas (tidak saling menggantikan, ditegakkan backend):
    //   resolve_unknown    = selesaikan attempt purchase-payment sending/unknown (D-14);
    //   override_duplicate = override blok duplikat sales-receipt (D-18);
    //   repost_payment     = reopen/repost purchase-payment posted yang dihapus/void di Accurate (D-15,
    //                        belum ada route — menunggu ADR-004).
    //   retry_post = kunci lama; TIDAK memberi satu pun kapabilitas di atas (tidak ditegakkan, lihat D-01).
    finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update", "resolve_unknown", "override_duplicate", "repost_payment"],
    principles: ["view", "upload", "delete"],
    master_barang: ["view", "create", "upload", "edit", "generate", "export", "manage"],
    summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
    reconciliation: ["view", "run", "manage"],
    off_program_control: [
        "view", "create", "update", "approve", "export",
        // workflow granular (mirror OffAction) — chain SPV→SM→Claim→OM→Finance:
        "create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return",
        "claim_review", "claim_final", "om_approve", "om_cancel", "finance_payment",
        "submit_refund", "audit_read", "audit_export", "audit_correct", "period_close",
        "period_unlock", "discount_view", "discount_manage",
    ],
    claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
    users: ["view", "create_user", "edit_user", "delete_user", "set_role", "set_permission", "manage"],
    // Modul yang sebelumnya TIDAK terdaftar di RBAC (temuan Fase 3 — page-guard gap):
    form_kontrol: ["view", "submit", "manage"],
    // view          = boleh membuka halaman & membaca angkanya (dipakai semua GET modul ini)
    // view_dashboard= tab Dashboard SM. Terpisah dari `view` supaya Finance yang cuma
    //                 memverifikasi pembayaran tidak ikut melihat layar performa tim.
    // view_all      = lihat seluruh perusahaan tanpa identitas hierarki. Kodenya sudah
    //                 menerima key ini sejak 2026-08-29 (LIHAT_SEMUA_KEYS di
    //                 lib/insentif-hierarchy-scope) dan grup Manager sudah memakainya
    //                 di produksi; pendaftarannya di sini sempat tertunda.
    insentif_sales: [
        "view", "view_dashboard", "view_all", "manage", "upload_target", "upload_progress",
        "input_support", "manage_payment", "manage_hierarchy",
    ],
    // History Penjualan (cascade No Faktur -> Detail). manage = upload/import CSV e-Faktur.
    sales_history: ["view", "export", "manage"],
    // Laporan Harian per SPV/SM (upload FIX -> feed dashboard + email). send = kirim email (gated); manage = ubah mapping penerima.
    laporan_harian: ["view", "upload", "send", "manage"],
    // Rekapan Nota (wave-based picking). print = cetak lembar picking/TTF;
    // approve_takeout = melepas nota dari wave (butuh persetujuan gudang, Q9).
    rekapan_nota: ["view", "manage", "print", "approve_takeout"],
} as const;

export type PermissionModule = keyof typeof PERMISSION_REGISTRY;
export type PermissionKey = string; // "module.action"

export const PERMISSION_MODULES = Object.keys(PERMISSION_REGISTRY) as PermissionModule[];

export function allPermissionKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [moduleName, actions] of Object.entries(PERMISSION_REGISTRY)) {
        for (const action of actions) keys.add(`${moduleName}.${action}`);
    }
    return keys;
}

export function isValidPermissionKey(key: string): boolean {
    return allPermissionKeys().has(key);
}

/** Kunci kapabilitas yang membuka kiriman ulang ke Accurate (D-14/D-15/D-18). UI grup tidak menyalakannya
 * lewat centang modul — harus dicentang satu per satu (AM-057). UI bukan otoritas; backend tetap menegakkan. */
export const CAPABILITY_KEYS: ReadonlySet<string> = new Set(["finance.resolve_unknown", "finance.override_duplicate", "finance.repost_payment"]);

const moduleKeys = (mod: PermissionModule) => PERMISSION_REGISTRY[mod].map((a) => `${mod}.${a}`);

/** Status centang modul di UI grup: semua kunci NON-kapabilitas modul aktif. */
export function moduleAllOn(current: ReadonlySet<string>, mod: PermissionModule): boolean {
    return moduleKeys(mod).filter((k) => !CAPABILITY_KEYS.has(k)).every((k) => current.has(k));
}

/** Centang modul di UI grup: sudah `moduleAllOn` -> cabut SEMUA kunci modul (termasuk kapabilitas); selain itu
 * nyalakan kunci non-kapabilitas saja. */
export function toggleModuleKeys(current: ReadonlySet<string>, mod: PermissionModule): Set<string> {
    const keys = moduleKeys(mod);
    const next = new Set(current);
    if (moduleAllOn(current, mod)) keys.forEach((k) => next.delete(k));
    else keys.filter((k) => !CAPABILITY_KEYS.has(k)).forEach((k) => next.add(k));
    return next;
}
