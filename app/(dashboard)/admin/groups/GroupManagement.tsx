"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PERMISSION_REGISTRY } from "@/lib/rbac/registry";

type Group = { id: string; name: string; description: string | null; isPreset: boolean | number; permCount: number; memberCount: number };
type Member = { userId: string; userName: string; userEmail: string; assignedAt: number };
type Detail = { group: Group; permissions: string[]; members: Member[] };
type UserRow = { id: string; name: string; email: string };

const MOD_LABELS: Record<string, string> = {
    dashboard: "Dashboard", api_wrapper: "API Wrapper", payments: "Payments",
    sppd: "SPPD", finance: "Finance", principles: "Principles", summary: "Summary",
    validator: "Validator", off_program_control: "OFF Program Control",
    claim_workflow: "Claim Workflow", users: "Users (Admin)",
    form_kontrol: "Form Kontrol", insentif_sales: "Insentif Sales",
};

const F: React.CSSProperties = { display: "flex" };
const COL: React.CSSProperties = { ...F, flexDirection: "column" };

export default function GroupManagement() {
    const [groups, setGroups] = useState<Group[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [allUsers, setAllUsers] = useState<UserRow[]>([]);
    const [editName, setEditName] = useState("");
    const [editDesc, setEditDesc] = useState("");
    const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
    const [addUserId, setAddUserId] = useState("");
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);

    const loadGroups = useCallback(async () => {
        const r = await fetch("/api/admin/groups", { credentials: "include" });
        const d = await r.json();
        setGroups(d.groups ?? []);
    }, []);

    const loadUsers = useCallback(async () => {
        const r = await fetch("/api/admin/users/permissions", { credentials: "include" });
        const d = await r.json();
        setAllUsers(d.users ?? []);
    }, []);

    useEffect(() => { loadGroups(); loadUsers(); }, [loadGroups, loadUsers]);

    const selectGroup = useCallback(async (id: string) => {
        setSelectedId(id);
        setDetail(null);
        const r = await fetch(`/api/admin/groups/${id}`, { credentials: "include" });
        const d = await r.json();
        setDetail(d);
        setEditName(d.group.name);
        setEditDesc(d.group.description ?? "");
        setEditPerms(new Set(d.permissions));
        setAddUserId("");
    }, []);

    async function apiFetch(url: string, body: object, method = "POST") {
        const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Gagal");
        return d;
    }

    async function saveInfo() {
        if (!selectedId) return;
        setBusy(true);
        try {
            await apiFetch(`/api/admin/groups/${selectedId}`, { name: editName, description: editDesc }, "PATCH");
            toast.success("Info group disimpan");
            await loadGroups();
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    async function savePerms() {
        if (!selectedId) return;
        setBusy(true);
        try {
            await apiFetch(`/api/admin/groups/${selectedId}`, { permissions: [...editPerms] }, "PATCH");
            toast.success("Permission disimpan");
            await loadGroups();
            await selectGroup(selectedId);
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    async function addMember() {
        if (!selectedId || !addUserId) return;
        setBusy(true);
        try {
            await apiFetch(`/api/admin/groups/${selectedId}/members`, { userId: addUserId });
            toast.success("Member ditambahkan");
            setAddUserId("");
            await selectGroup(selectedId);
            await loadGroups();
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    async function removeMember(userId: string) {
        if (!selectedId) return;
        setBusy(true);
        try {
            await apiFetch(`/api/admin/groups/${selectedId}/members`, { userId }, "DELETE");
            toast.success("Member dihapus");
            await selectGroup(selectedId);
            await loadGroups();
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    async function createGroup() {
        const name = newName.trim();
        if (!name) return;
        setBusy(true);
        try {
            await apiFetch("/api/admin/groups", { name });
            toast.success(`Group "${name}" dibuat`);
            setNewName("");
            await loadGroups();
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    async function deleteGroup() {
        if (!selectedId || !detail) return;
        if (!confirm(`Hapus group "${detail.group.name}"?`)) return;
        setBusy(true);
        try {
            const r = await fetch(`/api/admin/groups/${selectedId}`, { method: "DELETE", credentials: "include" });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error);
            toast.success("Group dihapus");
            setSelectedId(null); setDetail(null);
            await loadGroups();
        } catch (e) { toast.error(String(e)); }
        setBusy(false);
    }

    const togglePerm = (key: string) =>
        setEditPerms((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

    const toggleModule = (mod: string, actions: readonly string[]) => {
        const keys = actions.map((a) => `${mod}.${a}`);
        const allOn = keys.every((k) => editPerms.has(k));
        setEditPerms((p) => { const n = new Set(p); allOn ? keys.forEach((k) => n.delete(k)) : keys.forEach((k) => n.add(k)); return n; });
    };

    const nonMembers = allUsers.filter((u) => !detail?.members.some((m) => m.userId === u.id));

    return (
        <div style={{ ...F, gap: 24, padding: 24 }}>
            {/* Left: group list */}
            <div style={{ width: 260, flexShrink: 0, ...COL, gap: 8 }}>
                <div style={{ ...F, gap: 6 }}>
                    <input
                        placeholder="Nama group baru…"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && createGroup()}
                        style={{ flex: 1, padding: "5px 8px", fontSize: 13 }}
                    />
                    <button onClick={createGroup} disabled={!newName.trim() || busy} style={{ padding: "5px 10px" }}>＋</button>
                </div>
                {groups.map((g) => (
                    <div
                        key={g.id}
                        onClick={() => selectGroup(g.id)}
                        style={{
                            padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13,
                            background: selectedId === g.id ? "#e8f0fe" : "#f5f5f5",
                            border: `1px solid ${selectedId === g.id ? "#4285f4" : "transparent"}`,
                        }}
                    >
                        <div style={{ fontWeight: 600 }}>
                            {g.name}{g.isPreset ? <span style={{ fontSize: 10, color: "#888", fontWeight: 400 }}> PRESET</span> : null}
                        </div>
                        <div style={{ fontSize: 11, color: "#666" }}>{g.permCount} permission · {g.memberCount} member</div>
                    </div>
                ))}
            </div>

            {/* Right: detail */}
            <div style={{ flex: 1 }}>
                {!detail && <p style={{ color: "#888", fontSize: 13 }}>Pilih group di kiri untuk mengelola.</p>}
                {detail && (
                    <div style={{ ...COL, gap: 28 }}>
                        <section>
                            <h3 style={{ marginTop: 0, fontSize: 15 }}>Info Group</h3>
                            <div style={{ ...COL, gap: 8, maxWidth: 380 }}>
                                <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Nama" style={{ padding: "5px 8px" }} />
                                <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Deskripsi" style={{ padding: "5px 8px" }} />
                                <div style={{ ...F, gap: 8 }}>
                                    <button onClick={saveInfo} disabled={busy}>Simpan Info</button>
                                    {!detail.group.isPreset && (
                                        <button onClick={deleteGroup} disabled={busy} style={{ color: "red" }}>Hapus Group</button>
                                    )}
                                </div>
                            </div>
                        </section>

                        <section>
                            <h3 style={{ marginTop: 0, fontSize: 15 }}>
                                Permissions <span style={{ fontWeight: 400, fontSize: 12, color: "#666" }}>({editPerms.size} aktif)</span>
                            </h3>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 12 }}>
                                {Object.entries(PERMISSION_REGISTRY).map(([mod, actions]) => {
                                    const keys = (actions as readonly string[]).map((a) => `${mod}.${a}`);
                                    const allOn = keys.every((k) => editPerms.has(k));
                                    const someOn = keys.some((k) => editPerms.has(k));
                                    return (
                                        <div key={mod} style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 10 }}>
                                            <label style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", ...F, gap: 6, alignItems: "center" }}>
                                                <input
                                                    type="checkbox"
                                                    checked={allOn}
                                                    ref={(el) => { if (el) el.indeterminate = !allOn && someOn; }}
                                                    onChange={() => toggleModule(mod, actions as readonly string[])}
                                                />
                                                {MOD_LABELS[mod] ?? mod}
                                            </label>
                                            <div style={{ marginTop: 6, ...F, flexWrap: "wrap", gap: "3px 10px" }}>
                                                {(actions as readonly string[]).map((action) => {
                                                    const key = `${mod}.${action}`;
                                                    return (
                                                        <label key={key} style={{ fontSize: 12, cursor: "pointer", ...F, gap: 4, alignItems: "center" }}>
                                                            <input type="checkbox" checked={editPerms.has(key)} onChange={() => togglePerm(key)} />
                                                            {action}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <button onClick={savePerms} disabled={busy} style={{ marginTop: 12 }}>Simpan Permissions</button>
                        </section>

                        <section>
                            <h3 style={{ marginTop: 0, fontSize: 15 }}>Members ({detail.members.length})</h3>
                            <div style={{ ...F, gap: 8, marginBottom: 10 }}>
                                <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} style={{ flex: 1, maxWidth: 320, padding: "5px 8px", fontSize: 13 }}>
                                    <option value="">— Pilih user —</option>
                                    {nonMembers.map((u) => (
                                        <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                                    ))}
                                </select>
                                <button onClick={addMember} disabled={!addUserId || busy}>Tambah</button>
                            </div>
                            <div style={{ ...COL, gap: 4 }}>
                                {detail.members.length === 0 && <p style={{ color: "#888", fontSize: 13, margin: 0 }}>Belum ada member.</p>}
                                {detail.members.map((m) => (
                                    <div key={m.userId} style={{ ...F, justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "#f9f9f9", borderRadius: 4, fontSize: 13 }}>
                                        <span>{m.userName} <span style={{ color: "#888" }}>({m.userEmail})</span></span>
                                        <button onClick={() => removeMember(m.userId)} disabled={busy} style={{ color: "red", fontSize: 12 }}>Hapus</button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}
