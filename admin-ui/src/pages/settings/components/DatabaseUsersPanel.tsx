import { Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchJson } from "@/shared/api";
import { errorMessage } from "@/shared/lib/app-utils";

type DatabaseUserRole = "admin" | "user";

type DatabaseUser = {
  id: string;
  username: string;
  role: DatabaseUserRole;
  groupId?: string;
  groupName?: string;
  groupSortOrder?: number;
  groupImageLimitsDisabled?: boolean;
  disabled?: boolean;
  createdAt?: number | string;
  updatedAt?: number | string;
};

type DatabaseUserGroup = {
  id: string;
  name: string;
  sortOrder: number;
  imageLimitsDisabled: boolean;
  createdAt?: number | string;
  updatedAt?: number | string;
};

type UserDraft = {
  username: string;
  password: string;
  role: DatabaseUserRole;
  groupId: string;
};

type UserGroupDraft = {
  name: string;
  sortOrder: string;
  imageLimitsDisabled: boolean;
};

type ImageLimitOverrideDraft = {
  username: string;
  perUserDaily: string;
  perUserHourly: string;
  minIntervalSeconds: string;
};

type ImageLimitDefaults = {
  perUserDaily: string;
  perUserHourly: string;
  minIntervalSeconds: string;
};

type ActionState =
  | "load"
  | "create"
  | "create-group"
  | `group:${string}`
  | `user-group:${string}`
  | `role:${string}`
  | `toggle:${string}`
  | `reset:${string}`
  | `delete:${string}`
  | null;

function formatDate(value?: number | string | null): string {
  if (!value) {
    return "-";
  }
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

function normalizeUsers(payload: { data?: DatabaseUser[]; users?: DatabaseUser[] } | DatabaseUser[]): DatabaseUser[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.data ?? payload.users ?? [];
}

function normalizeGroups(payload: { data?: DatabaseUserGroup[]; groups?: DatabaseUserGroup[] } | DatabaseUserGroup[]): DatabaseUserGroup[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.data ?? payload.groups ?? [];
}

function isUserEnabled(user: DatabaseUser): boolean {
  return !user.disabled;
}

function inheritedLimitLabel(value: string): string {
  return value === "0" || !value ? "继承：不限" : `继承：${value}`;
}

export function DatabaseUsersPanel({
  currentUser,
  imageLimitDefaults,
  imageLimitOverrides,
  onImageLimitOverridesChange,
  setStatus,
}: {
  currentUser: string | null;
  imageLimitDefaults: ImageLimitDefaults;
  imageLimitOverrides: ImageLimitOverrideDraft[];
  onImageLimitOverridesChange: (overrides: ImageLimitOverrideDraft[]) => void;
  setStatus: (message: string) => void;
}) {
  const [users, setUsers] = useState<DatabaseUser[]>([]);
  const [userGroups, setUserGroups] = useState<DatabaseUserGroup[]>([]);
  const [draft, setDraft] = useState<UserDraft>({ username: "", password: "", role: "user", groupId: "" });
  const [groupDraft, setGroupDraft] = useState<UserGroupDraft>({ name: "", sortOrder: "0", imageLimitsDisabled: false });
  const [groupEdits, setGroupEdits] = useState<Record<string, UserGroupDraft>>({});
  const [newPasswordByUserId, setNewPasswordByUserId] = useState<Record<string, string>>({});
  const [action, setAction] = useState<ActionState>("load");
  const [error, setError] = useState<string | null>(null);

  const sortedUsers = useMemo(
    () => [...users].sort((first, second) => first.username.localeCompare(second.username, "zh-CN")),
    [users],
  );

  const sortedGroups = useMemo(
    () => [...userGroups].sort((first, second) => second.sortOrder - first.sortOrder || first.name.localeCompare(second.name, "zh-CN")),
    [userGroups],
  );

  async function loadUsers(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setAction("load");
    }
    try {
      const payload = await fetchJson<{ data?: DatabaseUser[]; users?: DatabaseUser[] } | DatabaseUser[]>("/_gateway/admin/users");
      setUsers(normalizeUsers(payload));
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`数据库用户读取失败：${message}`);
    } finally {
      if (!options?.silent) {
        setAction(null);
      }
    }
  }

  async function loadUserGroups(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setAction("load");
    }
    try {
      const payload = await fetchJson<{ data?: DatabaseUserGroup[]; groups?: DatabaseUserGroup[] } | DatabaseUserGroup[]>("/_gateway/admin/user-groups");
      const groups = normalizeGroups(payload);
      setUserGroups(groups);
      setGroupEdits({});
      setError(null);
      setDraft((current) => current.groupId || groups.length === 0 ? current : { ...current, groupId: groups[groups.length - 1]?.id ?? "" });
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`用户组读取失败：${message}`);
    } finally {
      if (!options?.silent) {
        setAction(null);
      }
    }
  }

  async function loadAll(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setAction("load");
    }
    try {
      const [usersPayload, groupsPayload] = await Promise.all([
        fetchJson<{ data?: DatabaseUser[]; users?: DatabaseUser[] } | DatabaseUser[]>("/_gateway/admin/users"),
        fetchJson<{ data?: DatabaseUserGroup[]; groups?: DatabaseUserGroup[] } | DatabaseUserGroup[]>("/_gateway/admin/user-groups"),
      ]);
      const groups = normalizeGroups(groupsPayload);
      setUsers(normalizeUsers(usersPayload));
      setUserGroups(groups);
      setGroupEdits({});
      setDraft((current) => current.groupId || groups.length === 0 ? current : { ...current, groupId: groups[groups.length - 1]?.id ?? "" });
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`用户管理数据读取失败：${message}`);
    } finally {
      if (!options?.silent) {
        setAction(null);
      }
    }
  }

  useEffect(() => {
    loadAll().catch(() => undefined);
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = draft.username.trim();
    const password = draft.password;
    if (!username || password.length < 6) {
      setError("请填写用户名和至少 6 位初始密码。");
      return;
    }

    setAction("create");
    try {
      await fetchJson<{ user?: DatabaseUser }>("/_gateway/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role: draft.role, groupId: draft.groupId || undefined }),
      });
      setDraft((current) => ({ username: "", password: "", role: "user", groupId: current.groupId }));
      await loadUsers({ silent: true });
      setStatus(`数据库用户 ${username} 已新增。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`新增用户失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = groupDraft.name.trim();
    const sortOrder = Number.parseInt(groupDraft.sortOrder || "0", 10);
    if (!name) {
      setError("请填写用户组名称。");
      return;
    }
    if (!Number.isInteger(sortOrder)) {
      setError("用户组排序必须是整数。");
      return;
    }

    setAction("create-group");
    try {
      await fetchJson<{ group?: DatabaseUserGroup; groups?: DatabaseUserGroup[] }>("/_gateway/admin/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sortOrder, imageLimitsDisabled: groupDraft.imageLimitsDisabled }),
      });
      setGroupDraft({ name: "", sortOrder: "0", imageLimitsDisabled: false });
      await loadUserGroups({ silent: true });
      setStatus(`用户组 ${name} 已新增。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`新增用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  function groupEditFor(group: DatabaseUserGroup): UserGroupDraft {
    return groupEdits[group.id] ?? {
      name: group.name,
      sortOrder: String(group.sortOrder),
      imageLimitsDisabled: group.imageLimitsDisabled,
    };
  }

  function updateGroupDraft(group: DatabaseUserGroup, field: keyof UserGroupDraft, value: string | boolean) {
    setGroupEdits((current) => ({
      ...current,
      [group.id]: {
        ...groupEditFor(group),
        [field]: value,
      },
    }));
  }

  function hasGroupEdit(group: DatabaseUserGroup): boolean {
    const edit = groupEdits[group.id];
    if (!edit) {
      return false;
    }
    return edit.name.trim() !== group.name || Number.parseInt(edit.sortOrder || "0", 10) !== group.sortOrder || edit.imageLimitsDisabled !== group.imageLimitsDisabled;
  }

  async function saveGroup(group: DatabaseUserGroup) {
    const edit = groupEditFor(group);
    const name = edit.name.trim();
    const sortOrder = Number.parseInt(edit.sortOrder || "0", 10);
    if (!name || !Number.isInteger(sortOrder)) {
      setError("用户组名称不能为空，排序必须是整数。");
      return;
    }

    setAction(`group:${group.id}`);
    try {
      await fetchJson<{ group?: DatabaseUserGroup }>(`/_gateway/admin/user-groups/${encodeURIComponent(group.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sortOrder, imageLimitsDisabled: edit.imageLimitsDisabled }),
      });
      await loadAll({ silent: true });
      setStatus(`用户组 ${name} 已保存。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`保存用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function deleteGroup(group: DatabaseUserGroup) {
    if (!window.confirm(`确认删除用户组 ${group.name}？该组下用户会自动移动到排序最低的剩余分组。`)) {
      return;
    }

    setAction(`group:${group.id}`);
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/admin/user-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
      await loadAll({ silent: true });
      setStatus(`用户组 ${group.name} 已删除。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`删除用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function toggleUser(user: DatabaseUser) {
    const nextEnabled = !isUserEnabled(user);
    setAction(`toggle:${user.id}`);
    try {
      await fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !nextEnabled }),
      });
      await loadUsers({ silent: true });
      setStatus(`数据库用户 ${user.username} 已${nextEnabled ? "启用" : "禁用"}。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`更新用户状态失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function updateUserRole(user: DatabaseUser, role: DatabaseUserRole) {
    if (role === user.role) {
      return;
    }

    setAction(`role:${user.id}`);
    try {
      await fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await loadUsers({ silent: true });
      setStatus(`数据库用户 ${user.username} 已调整为${role === "admin" ? "管理员" : "普通用户"}。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`调整用户角色失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function updateUserGroup(user: DatabaseUser, groupId: string) {
    if (groupId === user.groupId) {
      return;
    }

    setAction(`user-group:${user.id}`);
    try {
      await fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      await loadUsers({ silent: true });
      const groupName = userGroups.find((group) => group.id === groupId)?.name ?? "未分组";
      setStatus(`数据库用户 ${user.username} 已移动到 ${groupName}。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`调整用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function resetPassword(user: DatabaseUser) {
    const password = (newPasswordByUserId[user.id] || "").trim();
    if (!password) {
      setError(`请先填写 ${user.username} 的新密码。`);
      return;
    }

    setAction(`reset:${user.id}`);
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setNewPasswordByUserId((current) => ({ ...current, [user.id]: "" }));
      await loadUsers({ silent: true });
      setStatus(`数据库用户 ${user.username} 的密码已重置。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`重置密码失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function deleteUser(user: DatabaseUser) {
    if (!window.confirm(`确认删除数据库用户 ${user.username}？`)) {
      return;
    }

    setAction(`delete:${user.id}`);
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      await loadUsers({ silent: true });
      setStatus(`数据库用户 ${user.username} 已删除。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`删除用户失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  const loading = action === "load";

  function imageLimitOverrideFor(username: string): ImageLimitOverrideDraft | undefined {
    return imageLimitOverrides.find((item) => item.username === username);
  }

  function updateUserImageLimit(username: string, field: keyof Omit<ImageLimitOverrideDraft, "username">, value: string) {
    const normalizedValue = value.trim();
    const nextOverrides = [...imageLimitOverrides];
    const index = nextOverrides.findIndex((item) => item.username === username);
    const current = index >= 0
      ? nextOverrides[index] as ImageLimitOverrideDraft
      : {
          username,
          perUserDaily: "",
          perUserHourly: "",
          minIntervalSeconds: "",
        };
    const next = {
      ...current,
      [field]: normalizedValue,
    };
    if (!next.perUserDaily && !next.perUserHourly && !next.minIntervalSeconds) {
      if (index >= 0) {
        nextOverrides.splice(index, 1);
      }
    } else if (index >= 0) {
      nextOverrides.splice(index, 1, next);
    } else {
      nextOverrides.push(next);
    }
    onImageLimitOverridesChange(nextOverrides);
  }

  return (
    <section className="settings-section database-users-section">
      <div className="database-users-head">
        <div>
          <h4>数据库用户</h4>
          <p className="hint">管理员可新增普通用户，或禁用、启用、重置密码、删除用户，并直接配置该用户的生图限额覆盖。</p>
        </div>
        <button className="btn-secondary" type="button" onClick={() => void loadUsers()} disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          刷新
        </button>
      </div>

      <div className="database-user-groups">
        <div className="database-user-groups-head">
          <div>
            <h5>用户组</h5>
            <p className="hint">排序越高，生图排队优先级越高；开启免限额后不受本地生图频率和次数限制。</p>
          </div>
        </div>
        <form className="database-user-group-create" onSubmit={createGroup}>
          <label className="field">
            <span>分组名称</span>
            <input className="input" value={groupDraft.name} onChange={(event) => setGroupDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如 SVIP 用户组" />
          </label>
          <label className="field">
            <span>排序</span>
            <input className="input" type="number" value={groupDraft.sortOrder} onChange={(event) => setGroupDraft((current) => ({ ...current, sortOrder: event.target.value }))} />
          </label>
          <label className="switch-line database-user-group-switch">
            <input type="checkbox" checked={groupDraft.imageLimitsDisabled} onChange={(event) => setGroupDraft((current) => ({ ...current, imageLimitsDisabled: event.target.checked }))} />
            <span>免生图限额</span>
          </label>
          <button className="btn-secondary database-user-create-button" type="submit" disabled={action === "create-group"}>
            {action === "create-group" ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            新增分组
          </button>
        </form>

        <div className="database-user-groups-table-wrap">
          <table className="database-user-groups-table">
            <thead>
              <tr>
                <th>分组</th>
                <th>排序</th>
                <th>生图限额</th>
                <th>用户数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map((group) => {
                const edit = groupEditFor(group);
                const groupBusy = action === `group:${group.id}`;
                const userCount = users.filter((user) => user.groupId === group.id).length;
                return (
                  <tr key={group.id}>
                    <td>
                      <input className="input" value={edit.name} onChange={(event) => updateGroupDraft(group, "name", event.target.value)} />
                    </td>
                    <td>
                      <input className="input database-user-group-order" type="number" value={edit.sortOrder} onChange={(event) => updateGroupDraft(group, "sortOrder", event.target.value)} />
                    </td>
                    <td>
                      <label className="switch-line database-user-group-switch">
                        <input type="checkbox" checked={edit.imageLimitsDisabled} onChange={(event) => updateGroupDraft(group, "imageLimitsDisabled", event.target.checked)} />
                        <span>{edit.imageLimitsDisabled ? "免限额" : "继承限额"}</span>
                      </label>
                    </td>
                    <td>{userCount}</td>
                    <td>
                      <div className="database-user-actions">
                        <button className="btn-secondary icon-action" type="button" onClick={() => void saveGroup(group)} disabled={groupBusy || !hasGroupEdit(group)} title="保存用户组">
                          {groupBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                        </button>
                        <button className="btn-secondary danger-action icon-action" type="button" onClick={() => void deleteGroup(group)} disabled={groupBusy || sortedGroups.length <= 1} title="删除用户组">
                          {groupBusy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <form className="database-user-create" onSubmit={createUser}>
        <label className="field">
          <span>用户名</span>
          <input className="input" value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} placeholder="例如 alice" />
        </label>
        <label className="field">
          <span>初始密码</span>
          <input className="input" type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} placeholder="至少 6 位" />
        </label>
        <label className="field">
          <span>角色</span>
          <select className="control" value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value as DatabaseUserRole }))}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label className="field">
          <span>用户组</span>
          <select className="control" value={draft.groupId} onChange={(event) => setDraft((current) => ({ ...current, groupId: event.target.value }))}>
            {sortedGroups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </label>
        <button className="btn-primary database-user-create-button" type="submit" disabled={action === "create"}>
          {action === "create" ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
          新增用户
        </button>
      </form>

      {error ? <div className="database-users-error">{error}</div> : null}

      <div className="database-users-table-wrap">
        <table className="database-users-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>用户组</th>
              <th>状态</th>
              <th>生图限额</th>
              <th>创建时间</th>
              <th>重置密码</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.length === 0 ? (
              <tr>
                <td className="database-users-empty" colSpan={8}>
                  {loading ? "正在读取数据库用户..." : "暂无数据库用户。"}
                </td>
              </tr>
            ) : (
              sortedUsers.map((user) => {
                const isSelf = currentUser === user.username;
                const roleBusy = action === `role:${user.id}`;
                const userGroupBusy = action === `user-group:${user.id}`;
                const toggleBusy = action === `toggle:${user.id}`;
                const resetBusy = action === `reset:${user.id}`;
                const deleteBusy = action === `delete:${user.id}`;
                const enabled = isUserEnabled(user);
                const imageLimit = imageLimitOverrideFor(user.username);
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.username}</strong>
                      {isSelf ? <span className="database-user-self">当前登录</span> : null}
                    </td>
                    <td>
                      <div className="database-user-role-control">
                        <select
                          className="control"
                          value={user.role}
                          onChange={(event) => void updateUserRole(user, event.target.value as DatabaseUserRole)}
                          disabled={roleBusy || isSelf}
                          title={isSelf ? "不能调整当前登录用户的角色" : "调整用户角色"}
                        >
                          <option value="user">普通用户</option>
                          <option value="admin">管理员</option>
                        </select>
                        {roleBusy ? <Loader2 className="spin" size={16} /> : null}
                      </div>
                    </td>
                    <td>
                      <div className="database-user-role-control">
                        <select
                          className="control"
                          value={user.groupId || ""}
                          onChange={(event) => void updateUserGroup(user, event.target.value)}
                          disabled={userGroupBusy || sortedGroups.length === 0}
                          title="调整用户组"
                        >
                          {sortedGroups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                        {userGroupBusy ? <Loader2 className="spin" size={16} /> : null}
                      </div>
                      {user.groupImageLimitsDisabled ? <span className="database-user-vip-note">免限额</span> : null}
                    </td>
                    <td>
                      <span className={`database-user-status ${enabled ? "is-enabled" : "is-disabled"}`}>{enabled ? "启用" : "禁用"}</span>
                    </td>
                    <td>
                      <div className="database-user-image-limits">
                        <label>
                          <span>24h</span>
                          <input
                            className="input"
                            inputMode="numeric"
                            min={0}
                            type="number"
                            value={imageLimit?.perUserDaily || ""}
                            onChange={(event) => updateUserImageLimit(user.username, "perUserDaily", event.target.value)}
                            placeholder={inheritedLimitLabel(imageLimitDefaults.perUserDaily)}
                          />
                        </label>
                        <label>
                          <span>1h</span>
                          <input
                            className="input"
                            inputMode="numeric"
                            min={0}
                            type="number"
                            value={imageLimit?.perUserHourly || ""}
                            onChange={(event) => updateUserImageLimit(user.username, "perUserHourly", event.target.value)}
                            placeholder={inheritedLimitLabel(imageLimitDefaults.perUserHourly)}
                          />
                        </label>
                        <label>
                          <span>间隔</span>
                          <input
                            className="input"
                            inputMode="numeric"
                            max={86400}
                            min={0}
                            type="number"
                            value={imageLimit?.minIntervalSeconds || ""}
                            onChange={(event) => updateUserImageLimit(user.username, "minIntervalSeconds", event.target.value)}
                            placeholder={inheritedLimitLabel(imageLimitDefaults.minIntervalSeconds)}
                          />
                        </label>
                      </div>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>
                      <div className="database-user-password">
                        <input
                          className="input"
                          type="password"
                          value={newPasswordByUserId[user.id] || ""}
                          onChange={(event) => setNewPasswordByUserId((current) => ({ ...current, [user.id]: event.target.value }))}
                          placeholder="新密码"
                        />
                        <button className="btn-secondary icon-action" type="button" onClick={() => void resetPassword(user)} disabled={resetBusy} title="重置密码">
                          {resetBusy ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="database-user-actions">
                        <button className="btn-secondary" type="button" onClick={() => void toggleUser(user)} disabled={toggleBusy || isSelf}>
                          {toggleBusy ? <Loader2 className="spin" size={16} /> : enabled ? "禁用" : "启用"}
                        </button>
                        <button className="btn-secondary danger-action icon-action" type="button" onClick={() => void deleteUser(user)} disabled={deleteBusy || isSelf} title="删除用户">
                          {deleteBusy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
