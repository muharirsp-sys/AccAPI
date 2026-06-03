"use client";

/*
 * Tujuan: UI admin untuk membuat user internal, reset password, role, dan permission RBAC per modul.
 * Caller: Route dashboard `/admin/users`.
 * Dependensi: Better Auth admin API, `/api/admin/users/permissions`, helper RBAC, sonner.
 * Main Functions: UserManagement, loadUsers, createUser, updateRole, savePermissions.
 * Side Effects: HTTP read/write ke API auth/admin dan update SQLite user.permissions.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    actionLabels,
    appModules,
    appRoles,
    moduleActions,
    moduleLabels,
    normalizePermissionMap,
    normalizeRole,
    permissionMapForUser,
    roleLabels,
    rolePermissionPresets,
    type AppModule,
    type AppRole,
    type PermissionAction,
    type PermissionMap,
} from "@/lib/rbac";

type UserRow = {
    id: string;
    name: string;
    email: string;
    role?: string | null;
    permissions?: string | null;
    emailVerified?: boolean;
    banned?: boolean | null;
};

const jsonHeaders = { "Content-Type": "application/json" };

async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
        ...init,
        credentials: "include",
        headers: {
            ...jsonHeaders,
            ...(init?.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.message || data?.error || "Request gagal");
    }
    return data as T;
}

function hasAction(map: PermissionMap, module: AppModule, action: PermissionAction) {
    return Boolean(map[module]?.includes(action));
}

function togglePermission(map: PermissionMap, module: AppModule, action: PermissionAction, checked: boolean): PermissionMap {
    const next = normalizePermissionMap(map);
    const actions = new Set<PermissionAction>(next[module] || []);
    if (checked) actions.add(action);
    else actions.delete(action);
    if (actions.size) next[module] = [...actions];
    else delete next[module];
    return next;
}

export default function UserManagement() {
    const [users, setUsers] = useState<UserRow[]>([]);
    const [permissionDrafts, setPermissionDrafts] = useState<Record<string, PermissionMap>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<AppRole>("viewer");

    const sortedUsers = useMemo(
        () => [...users].sort((a, b) => a.email.localeCompare(b.email)),
        [users]
    );

    async function loadUsers() {
        setLoading(true);
        try {
            const data = await authFetch<{ users: UserRow[] }>("/api/admin/users/permissions");
            const nextUsers = data.users || [];
            setUsers(nextUsers);
            setPermissionDrafts(Object.fromEntries(nextUsers.map((item) => [
                item.id,
                permissionMapForUser(item.role, item.permissions),
            ])));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat user");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void loadUsers();
    }, []);

    async function createUser(event: React.FormEvent) {
        event.preventDefault();
        setSaving(true);
        try {
            await authFetch("/api/auth/admin/create-user", {
                method: "POST",
                body: JSON.stringify({ name, email, password, role, data: { emailVerified: true } }),
            });
            toast.success("User dibuat.");
            setName("");
            setEmail("");
            setPassword("");
            setRole("viewer");
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal membuat user");
        } finally {
            setSaving(false);
        }
    }

    async function updateRole(userId: string, nextRole: AppRole) {
        try {
            await authFetch("/api/auth/admin/set-role", {
                method: "POST",
                body: JSON.stringify({ userId, role: nextRole }),
            });
            await authFetch("/api/admin/users/permissions", {
                method: "POST",
                body: JSON.stringify({ userId, useRolePreset: true }),
            });
            toast.success("Role diperbarui dan permission mengikuti preset role.");
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal update role");
        }
    }

    async function resetPassword(userId: string) {
        const newPassword = window.prompt("Password baru minimal 6 karakter:");
        if (!newPassword) return;
        if (newPassword.length < 6) {
            toast.error("Password minimal 6 karakter.");
            return;
        }
        try {
            await authFetch("/api/auth/admin/set-user-password", {
                method: "POST",
                body: JSON.stringify({ userId, newPassword }),
            });
            toast.success("Password user diperbarui.");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal reset password");
        }
    }

    function updateDraft(userId: string, module: AppModule, action: PermissionAction, checked: boolean) {
        setPermissionDrafts((prev) => ({
            ...prev,
            [userId]: togglePermission(prev[userId] || {}, module, action, checked),
        }));
    }

    async function savePermissions(userId: string) {
        try {
            await authFetch("/api/admin/users/permissions", {
                method: "POST",
                body: JSON.stringify({ userId, permissions: permissionDrafts[userId] || {} }),
            });
            toast.success("Permission user tersimpan.");
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyimpan permission");
        }
    }

    async function resetPermissionsToRole(userItem: UserRow) {
        const normalizedRole = normalizeRole(userItem.role);
        setPermissionDrafts((prev) => ({
            ...prev,
            [userItem.id]: rolePermissionPresets[normalizedRole],
        }));
        try {
            await authFetch("/api/admin/users/permissions", {
                method: "POST",
                body: JSON.stringify({ userId: userItem.id, useRolePreset: true }),
            });
            toast.success("Permission kembali mengikuti role.");
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal reset permission");
        }
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-white">User & RBAC</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Kelola akun internal, role, dan akses per halaman/modul.</p>
            </div>

            <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5 bg-white dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama" className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-white" />
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-white" />
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-white" />
                <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-white">
                    {appRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
                </select>
                <button disabled={saving} className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
                    {saving ? "Menyimpan..." : "Buat User"}
                </button>
            </form>

            <div className="bg-white dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                            <tr>
                                <th className="text-left px-4 py-3">Nama</th>
                                <th className="text-left px-4 py-3">Email</th>
                                <th className="text-left px-4 py-3">Role</th>
                                <th className="text-left px-4 py-3">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10 text-gray-800 dark:text-gray-200">
                            {loading ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500 dark:text-gray-400">Memuat...</td></tr>
                            ) : sortedUsers.length === 0 ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500 dark:text-gray-400">Belum ada user.</td></tr>
                            ) : sortedUsers.map((item) => {
                                const userRole = normalizeRole(item.role);
                                const draft = permissionDrafts[item.id] || permissionMapForUser(userRole, item.permissions);
                                return (
                                    <tr key={item.id} className="align-top">
                                        <td className="px-4 py-3">{item.name}</td>
                                        <td className="px-4 py-3">
                                            <div>{item.email}</div>
                                            <details className="mt-3 group">
                                                <summary className="cursor-pointer text-xs font-semibold text-brand-500 dark:text-brand-300 hover:text-indigo-200">Atur permission modul</summary>
                                                <div className="mt-3 grid gap-3 min-w-[760px]">
                                                    {appModules.map((module) => (
                                                        <div key={module} className="grid grid-cols-[150px_1fr] gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-black/25 p-3">
                                                            <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">{moduleLabels[module]}</div>
                                                            <div className="flex flex-wrap gap-2">
                                                                {moduleActions[module].map((action) => (
                                                                    <label key={action} className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-700 dark:text-gray-300">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={hasAction(draft, module, action)}
                                                                            onChange={(event) => updateDraft(item.id, module, action, event.target.checked)}
                                                                            className="accent-indigo-500"
                                                                        />
                                                                        {actionLabels[action]}
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))}
                                                    <div className="flex flex-wrap gap-2">
                                                        <button type="button" onClick={() => savePermissions(item.id)} className="rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-500">
                                                            Simpan Permission
                                                        </button>
                                                        <button type="button" onClick={() => resetPermissionsToRole(item)} className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.05]">
                                                            Ikuti Preset Role
                                                        </button>
                                                    </div>
                                                </div>
                                            </details>
                                        </td>
                                        <td className="px-4 py-3">
                                            <select
                                                value={userRole}
                                                onChange={(e) => updateRole(item.id, e.target.value as AppRole)}
                                                className="rounded bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-2 py-1 text-white"
                                            >
                                                {appRoles.map((roleItem) => <option key={roleItem} value={roleItem}>{roleLabels[roleItem]}</option>)}
                                            </select>
                                        </td>
                                        <td className="px-4 py-3">
                                            <button onClick={() => resetPassword(item.id)} className="text-brand-500 dark:text-brand-300 hover:text-indigo-200 font-medium">Reset Password</button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
