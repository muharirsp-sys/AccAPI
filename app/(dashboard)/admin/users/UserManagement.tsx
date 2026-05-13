"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { appRoles, roleLabels, type AppRole } from "@/lib/rbac";

type UserRow = {
    id: string;
    name: string;
    email: string;
    role?: string | null;
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

export default function UserManagement() {
    const [users, setUsers] = useState<UserRow[]>([]);
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
            const data = await authFetch<{ users: UserRow[] }>("/api/auth/admin/list-users?limit=100&sortBy=email&sortDirection=asc");
            setUsers(data.users || []);
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
            toast.success("Role diperbarui.");
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

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-white">User & RBAC</h1>
                <p className="text-sm text-slate-400 mt-1">Kelola akun internal dan role akses.</p>
            </div>

            <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5 bg-[#1a1c23]/70 border border-white/10 rounded-xl p-4">
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white" />
                <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white">
                    {appRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
                </select>
                <button disabled={saving} className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
                    {saving ? "Menyimpan..." : "Buat User"}
                </button>
            </form>

            <div className="bg-[#1a1c23]/70 border border-white/10 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-white/5 text-slate-300">
                            <tr>
                                <th className="text-left px-4 py-3">Nama</th>
                                <th className="text-left px-4 py-3">Email</th>
                                <th className="text-left px-4 py-3">Role</th>
                                <th className="text-left px-4 py-3">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10 text-slate-200">
                            {loading ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Memuat...</td></tr>
                            ) : sortedUsers.length === 0 ? (
                                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Belum ada user.</td></tr>
                            ) : sortedUsers.map((item) => (
                                <tr key={item.id}>
                                    <td className="px-4 py-3">{item.name}</td>
                                    <td className="px-4 py-3">{item.email}</td>
                                    <td className="px-4 py-3">
                                        <select
                                            value={(appRoles.includes(item.role as AppRole) ? item.role : "viewer") as AppRole}
                                            onChange={(e) => updateRole(item.id, e.target.value as AppRole)}
                                            className="rounded bg-black/30 border border-white/10 px-2 py-1 text-white"
                                        >
                                            {appRoles.map((roleItem) => <option key={roleItem} value={roleItem}>{roleLabels[roleItem]}</option>)}
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
