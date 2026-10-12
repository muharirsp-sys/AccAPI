/*
 * Tujuan: Izin + peran hierarki akun yang membuka halaman Insentif Sales (server). Peran menentukan halaman yang tampil:
 *   SPV/SM tertaut tetap mendapat Dashboard walau grupnya hanya `insentif_sales.view` (perilaku lama: jatuh ke Dashboard SM),
 *   salesman tertaut mendapat Insentif saya.
 * Caller: app/(dashboard)/insentif-sales/**\/page.tsx.
 * Dependensi: lib/rbac/resolve, lib/db, db/schema (user.hierarchyRole/hierarchyName).
 * Main Functions: aksesInsentif.
 * Side Effects: Membaca session, permission, dan satu baris user.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import type { PeranHierarki } from "@/lib/insentif-ui";

export async function aksesInsentif(): Promise<{ permKeys: string[]; peran: PeranHierarki }> {
    const { session, perms } = await resolveRequestPermissionsH();
    let peran: PeranHierarki = null;
    if (session?.user?.id) {
        try {
            const [row] = await db.select({ role: user.hierarchyRole, name: user.hierarchyName }).from(user).where(eq(user.id, session.user.id)).limit(1);
            // Sama dengan getScopeForUser: identitas berlaku hanya bila peran DAN nama terisi.
            if (row?.name && (row.role === "sales" || row.role === "spv" || row.role === "sm")) peran = row.role;
        } catch {
            // ponytail: gagal baca identitas = navigasi dari izin saja; data tetap dijaga endpoint.
        }
    }
    return { permKeys: [...(perms ?? [])], peran };
}
