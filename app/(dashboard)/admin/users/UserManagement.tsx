"use client";

/*
 * Tujuan: UI admin untuk membuat user internal, reset password, dan pilih Access Group.
 * Caller: Route dashboard `/admin/users`.
 * Dependensi: Better Auth admin API, `/api/admin/users/permissions`, `/api/admin/users/[id]/group`,
 *   `/api/admin/groups`, sonner.
 * Main Functions: UserManagement, loadUsers, loadGroups, createUser, setUserGroup, resetPassword.
 * Side Effects: HTTP read/write ke API auth/admin.
 * Catatan: permission granular SATU PINTU dari Access Group. Dropdown "Access Group" di sini
 *   MENGGANTIKAN dropdown role lama — memilih group otomatis set membership + role identity
 *   (server-side, lihat app/api/admin/users/[id]/group/route.ts) dan menghapus permission
 *   legacy per-user, agar tidak ada dua sumber permission yang tumpang tindih.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type UserRow = {
    id: string;
    name: string;
    email: string;
    role?: string | null;
    permissions?: string | null;
    emailVerified?: boolean;
    banned?: boolean | null;
    groupId?: string | null;
    groupName?: string | null;
};

type GroupOption = { id: string; name: string };

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

export default function UserManagement() {
    const [users, setUsers] = useState<UserRow[]>([]);
    const [groups, setGroups] = useState<GroupOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [groupId, setGroupId] = useState("");

    const sortedUsers = useMemo(
        () => [...users].sort((a, b) => a.email.localeCompare(b.email)),
        [users]
    );

    async function loadUsers() {
        setLoading(true);
        try {
            const data = await authFetch<{ users: UserRow[] }>("/api/admin/users/permissions");
            setUsers(data.users || []);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat user");
        } finally {
            setLoading(false);
        }
    }

    async function loadGroups() {
        try {
            const data = await authFetch<{ groups: GroupOption[] }>("/api/admin/groups");
            const list = data.groups || [];
            setGroups(list);
            setGroupId((current) => current || list[0]?.id || "");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat daftar group");
        }
    }

    useEffect(() => {
        void loadUsers();
        void loadGroups();
    }, []);

    async function createUser(event: React.FormEvent) {
        event.preventDefault();
        if (!groupId) {
            toast.error("Pilih Access Group untuk user baru.");
            return;
        }
        setSaving(true);
        try {
            const created = await authFetch<{ user?: { id?: string } }>("/api/auth/admin/create-user", {
                method: "POST",
                body: JSON.stringify({ name, email, password, role: "viewer", data: { emailVerified: true } }),
            });
            const newUserId = created.user?.id;
            if (newUserId) {
                await authFetch(`/api/admin/users/${newUserId}/group`, {
                    method: "POST",
                    body: JSON.stringify({ groupId }),
                });
            }
            toast.success("User dibuat.");
            setName("");
            setEmail("");
            setPassword("");
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal membuat user");
        } finally {
            setSaving(false);
        }
    }

    async function setUserGroup(userId: string, userName: string, currentGroupName: string | null | undefined, nextGroupId: string) {
        if (!nextGroupId) return;
        const nextGroupName = groups.find((g) => g.id === nextGroupId)?.name ?? nextGroupId;
        const confirmed = window.confirm(
            `Ubah Access Group "${userName}" dari "${currentGroupName || "(belum ada)"}" ke "${nextGroupName}"?\n\nPermission user akan langsung mengikuti group baru ini.`
        );
        if (!confirmed) return;
        try {
            await authFetch(`/api/admin/users/${userId}/group`, {
                method: "POST",
                body: JSON.stringify({ groupId: nextGroupId }),
            });
            toast.success(`Access Group "${userName}" diperbarui ke "${nextGroupName}".`);
            await loadUsers();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal update Access Group");
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

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-white">User & RBAC</h1>
                <p className="text-sm text-slate-400 mt-1">
                    Kelola akun internal, Access Group, dan reset password. Edit permission tiap group di{" "}
                    <a href="/admin/groups" className="text-indigo-300 hover:text-indigo-200 underline">Kelola Akses Group</a>.
                </p>
            </div>

            <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5 bg-[#1a1c23]/70 border border-white/10 rounded-lg p-4">
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white">
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <button disabled={saving} className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
                    {saving ? "Menyimpan..." : "Buat User"}
                </button>
            </form>

            <div className="bg-[#1a1c23]/70 border border-white/10 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-white/5 text-slate-300">
                            <tr>
                                <th className="text-left px-4 py-3">Nama</th>
                                <th className="text-left px-4 py-3">Email</th>
                                <th className="text-left px-4 py-3">Access Group</th>
                                <th className="text-left px-4 py-3">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10 text-slate-200">
                            {loading ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Memuat...</td></tr>
                            ) : sortedUsers.length === 0 ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Belum ada user.</td></tr>
                            ) : sortedUsers.map((item) => (
                                <tr key={item.id} className="align-top">
                                    <td className="px-4 py-3">{item.name}</td>
                                    <td className="px-4 py-3">{item.email}</td>
                                    <td className="px-4 py-3">
                                        <select
                                            value={item.groupId ?? ""}
                                            onChange={(e) => setUserGroup(item.id, item.name, item.groupName, e.target.value)}
                                            className="rounded bg-black/30 border border-white/10 px-2 py-1 text-white"
                                        >
                                            <option value="" disabled>— pilih group —</option>
                                            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-4 py-3">
                                        <button onClick={() => resetPassword(item.id)} className="text-indigo-300 hover:text-indigo-200 font-medium">Reset Password</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
