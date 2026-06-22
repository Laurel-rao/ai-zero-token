import { FileSpreadsheet, Loader2, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fetchJson } from "@/shared/api";
import { errorMessage } from "@/shared/lib/app-utils";

type DatabaseUserRole = "admin" | "user";

type DatabaseUser = {
  id: string;
  username: string;
  displayName?: string;
  role: DatabaseUserRole;
  groupId?: string;
  groupName?: string;
  groupSortOrder?: number;
  groupImageLimitsDisabled?: boolean;
  groupPerUserDaily?: number;
  groupPerUserHourly?: number;
  groupMinIntervalSeconds?: number;
  disabled?: boolean;
  createdAt?: number | string;
  updatedAt?: number | string;
};

type DatabaseUserGroup = {
  id: string;
  name: string;
  sortOrder: number;
  imageLimitsDisabled: boolean;
  perUserDaily?: number;
  perUserHourly?: number;
  minIntervalSeconds?: number;
  createdAt?: number | string;
  updatedAt?: number | string;
};

type UserDraft = {
  username: string;
  password: string;
  role: DatabaseUserRole;
  groupId: string;
};

type UserEditDraft = {
  role: DatabaseUserRole;
  groupId: string;
  password: string;
  perUserDaily: string;
  perUserHourly: string;
  minIntervalSeconds: string;
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

type UserListFilters = {
  keyword: string;
  role: "all" | DatabaseUserRole;
  status: "all" | "enabled" | "disabled";
  groupId: "all" | string;
};

type ActionState =
  | "load"
  | "import-wecom"
  | "create"
  | "batch-enable"
  | "batch-disable"
  | "batch-delete"
  | `edit:${string}`
  | `toggle:${string}`
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

function groupLimitLabel(value: number | undefined, globalValue: string): string {
  if (value !== undefined) {
    return String(value);
  }
  return inheritedLimitLabel(globalValue);
}

function userLabel(user: DatabaseUser): string {
  return user.displayName?.trim() || user.username;
}

type WecomContactImportRow = {
  userId: string;
  displayName: string;
};

function normalizeCell(value: unknown): string {
  return String(value ?? "").trim();
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseTextContacts(text: string): WecomContactImportRow[] {
  const rows = text
    .split(/\r?\n/g)
    .map((line) => parseCsvLine(line).map(normalizeCell))
    .filter((row) => row.some(Boolean));
  return parseContactRows(rows);
}

function parseContactRows(rows: string[][]): WecomContactImportRow[] {
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell === "姓名") && row.some((cell) => cell === "账号"));
  if (headerIndex < 0) {
    throw new Error("没有找到企业微信通讯录表头，请确认表格包含“姓名”和“账号”列。");
  }
  const headers = rows[headerIndex] ?? [];
  const nameIndex = headers.findIndex((cell) => cell === "姓名");
  const userIdIndex = headers.findIndex((cell) => cell === "账号");
  const contacts: WecomContactImportRow[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(headerIndex + 1)) {
    const displayName = normalizeCell(row[nameIndex]);
    const rawUserId = normalizeCell(row[userIdIndex]);
    const userId = rawUserId.includes(":") ? rawUserId.split(":").pop()?.trim() ?? "" : rawUserId;
    if (!displayName || !userId || seen.has(userId.toLowerCase())) {
      continue;
    }
    seen.add(userId.toLowerCase());
    contacts.push({ userId, displayName });
  }
  return contacts;
}

async function parseWecomContactFile(file: File): Promise<WecomContactImportRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "csv" || extension === "txt") {
    return parseTextContacts(await file.text());
  }
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const worksheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!worksheet) {
    throw new Error("没有读取到通讯录工作表。");
  }
  const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: "" });
  return parseContactRows(rows.map((row) => row.map(normalizeCell)));
}

export function DatabaseUsersPanel({
  currentUser,
  imageLimitDefaults,
  imageLimitOverrides,
  onImageLimitOverridesChange,
  onSaveImageLimitOverrides,
  setStatus,
}: {
  currentUser: string | null;
  imageLimitDefaults: ImageLimitDefaults;
  imageLimitOverrides: ImageLimitOverrideDraft[];
  onImageLimitOverridesChange: (overrides: ImageLimitOverrideDraft[]) => void;
  onSaveImageLimitOverrides?: (overrides: ImageLimitOverrideDraft[]) => Promise<void>;
  setStatus: (message: string) => void;
}) {
  const [users, setUsers] = useState<DatabaseUser[]>([]);
  const [userGroups, setUserGroups] = useState<DatabaseUserGroup[]>([]);
  const [draft, setDraft] = useState<UserDraft>({ username: "", password: "", role: "user", groupId: "" });
  const [filterDraft, setFilterDraft] = useState<UserListFilters>({ keyword: "", role: "all", status: "all", groupId: "all" });
  const [filters, setFilters] = useState<UserListFilters>({ keyword: "", role: "all", status: "all", groupId: "all" });
  const [selectedUserIds, setSelectedUserIds] = useState<Record<string, boolean>>({});
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUserDraft, setEditUserDraft] = useState<UserEditDraft | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [action, setAction] = useState<ActionState>("load");
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const sortedUsers = useMemo(
    () => [...users].sort((first, second) => userLabel(first).localeCompare(userLabel(second), "zh-CN") || first.username.localeCompare(second.username, "zh-CN")),
    [users],
  );

  const sortedGroups = useMemo(
    () => [...userGroups].sort((first, second) => second.sortOrder - first.sortOrder || first.name.localeCompare(second.name, "zh-CN")),
    [userGroups],
  );

  const filteredUsers = useMemo(() => {
    const keyword = filters.keyword.trim().toLowerCase();
    return sortedUsers.filter((user) => {
      const haystack = [user.username, user.displayName || "", user.groupName || ""].join(" ").toLowerCase();
      if (keyword && !haystack.includes(keyword)) {
        return false;
      }
      if (filters.role !== "all" && user.role !== filters.role) {
        return false;
      }
      if (filters.status === "enabled" && !isUserEnabled(user)) {
        return false;
      }
      if (filters.status === "disabled" && isUserEnabled(user)) {
        return false;
      }
      if (filters.groupId !== "all" && user.groupId !== filters.groupId) {
        return false;
      }
      return true;
    });
  }, [filters, sortedUsers]);

  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const pagedUsers = useMemo(() => filteredUsers.slice((page - 1) * pageSize, page * pageSize), [filteredUsers, page, pageSize]);
  const selectedUsers = useMemo(() => users.filter((user) => selectedUserIds[user.id]), [selectedUserIds, users]);
  const selectablePagedUsers = useMemo(() => pagedUsers.filter((user) => user.username !== currentUser), [currentUser, pagedUsers]);
  const allPagedSelected = selectablePagedUsers.length > 0 && selectablePagedUsers.every((user) => selectedUserIds[user.id]);
  const detailUser = useMemo(() => users.find((user) => user.id === detailUserId) ?? null, [detailUserId, users]);
  const editingUser = detailUser;

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  useEffect(() => {
    setSelectedUserIds((current) => {
      const valid = new Set(users.map((user) => user.id));
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => valid.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    if (detailUserId && !users.some((user) => user.id === detailUserId)) {
      setDetailUserId(null);
    }
  }, [detailUserId, users]);

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
      setPage(1);
      setCreateUserOpen(false);
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

  function openEditUser(user: DatabaseUser) {
    const imageLimit = imageLimitOverrideFor(user.username);
    setDetailUserId(user.id);
    setEditUserDraft({
      role: user.role,
      groupId: user.groupId || sortedGroups[sortedGroups.length - 1]?.id || "",
      password: "",
      perUserDaily: imageLimit?.perUserDaily || "",
      perUserHourly: imageLimit?.perUserHourly || "",
      minIntervalSeconds: imageLimit?.minIntervalSeconds || "",
    });
  }

  function closeEditUser() {
    setDetailUserId(null);
    setEditUserDraft(null);
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

  async function saveUserEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingUser || !editUserDraft) {
      return;
    }
    const isSelf = currentUser === editingUser.username;
    const password = editUserDraft.password.trim();
    if (password && password.length < 6) {
      setError("新密码至少需要 6 位。");
      return;
    }

    const nextOverride: ImageLimitOverrideDraft = {
      username: editingUser.username,
      perUserDaily: editUserDraft.perUserDaily.trim(),
      perUserHourly: editUserDraft.perUserHourly.trim(),
      minIntervalSeconds: editUserDraft.minIntervalSeconds.trim(),
    };
    const nextOverrides = imageLimitOverrides.filter((item) => item.username !== editingUser.username);
    if (nextOverride.perUserDaily || nextOverride.perUserHourly || nextOverride.minIntervalSeconds) {
      nextOverrides.push(nextOverride);
    }

    setAction(`edit:${editingUser.id}`);
    try {
      await fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(editingUser.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isSelf ? {} : { role: editUserDraft.role }),
          groupId: editUserDraft.groupId || null,
          ...(password ? { password } : {}),
        }),
      });
      if (onSaveImageLimitOverrides) {
        await onSaveImageLimitOverrides(nextOverrides);
      } else {
        onImageLimitOverridesChange(nextOverrides);
      }
      await loadUsers({ silent: true });
      closeEditUser();
      setStatus(`数据库用户 ${editingUser.username} 已保存。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`保存用户失败：${message}`);
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

  async function importWecomContacts(file: File | undefined) {
    if (!file) {
      return;
    }
    setAction("import-wecom");
    try {
      const contacts = await parseWecomContactFile(file);
      if (contacts.length === 0) {
        throw new Error("没有解析到可导入的通讯录成员。");
      }
      const payload = await fetchJson<{ result?: { total: number; created: number; updated: number; skipped: number }; users?: DatabaseUser[] }>("/_gateway/admin/users/import-wecom-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacts, groupId: draft.groupId || undefined }),
      });
      if (payload.users) {
        setUsers(payload.users);
      } else {
        await loadUsers({ silent: true });
      }
      setPage(1);
      const result = payload.result;
      setStatus(result
        ? `通讯录导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}。`
        : `通讯录导入完成，共处理 ${contacts.length} 人。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`通讯录导入失败：${message}`);
    } finally {
      setAction(null);
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  }

  const loading = action === "load";
  const batchBusy = action === "batch-enable" || action === "batch-disable" || action === "batch-delete";

  function applyUserFilters(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setFilters({
      ...filterDraft,
      keyword: filterDraft.keyword.trim(),
    });
    setPage(1);
    setSelectedUserIds({});
  }

  function resetUserFilters() {
    const next: UserListFilters = { keyword: "", role: "all", status: "all", groupId: "all" };
    setFilterDraft(next);
    setFilters(next);
    setPage(1);
    setSelectedUserIds({});
  }

  function toggleSelectUser(user: DatabaseUser, checked: boolean) {
    setSelectedUserIds((current) => {
      const next = { ...current };
      if (checked) {
        next[user.id] = true;
      } else {
        delete next[user.id];
      }
      return next;
    });
  }

  function toggleSelectPage(checked: boolean) {
    setSelectedUserIds((current) => {
      const next = { ...current };
      for (const user of selectablePagedUsers) {
        if (checked) {
          next[user.id] = true;
        } else {
          delete next[user.id];
        }
      }
      return next;
    });
  }

  async function batchToggleUsers(disabled: boolean) {
    const targets = selectedUsers.filter((user) => user.username !== currentUser && isUserEnabled(user) === disabled);
    if (targets.length === 0) {
      setError(`请选择可${disabled ? "禁用" : "启用"}的用户。`);
      return;
    }
    if (disabled && !window.confirm(`确认批量禁用 ${targets.length} 个用户？`)) {
      return;
    }
    setAction(disabled ? "batch-disable" : "batch-enable");
    try {
      await Promise.all(targets.map((user) => fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled }),
      })));
      setSelectedUserIds({});
      await loadUsers({ silent: true });
      setStatus(`已批量${disabled ? "禁用" : "启用"} ${targets.length} 个用户。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`批量${disabled ? "禁用" : "启用"}失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function batchDeleteUsers() {
    const targets = selectedUsers.filter((user) => user.username !== currentUser);
    if (targets.length === 0) {
      setError("请选择可删除的用户。");
      return;
    }
    if (!window.confirm(`确认删除 ${targets.length} 个数据库用户？此操作不可恢复。`)) {
      return;
    }
    setAction("batch-delete");
    try {
      await Promise.all(targets.map((user) => fetchJson<{ ok: boolean }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" })));
      setSelectedUserIds({});
      await loadUsers({ silent: true });
      setStatus(`已批量删除 ${targets.length} 个用户。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setStatus(`批量删除失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  function imageLimitOverrideFor(username: string): ImageLimitOverrideDraft | undefined {
    return imageLimitOverrides.find((item) => item.username === username);
  }

  return (
    <section className="settings-section database-users-section">
      <input
        ref={importInputRef}
        className="database-user-import-input"
        type="file"
        accept=".xlsx,.xls,.csv,.txt"
        onChange={(event) => void importWecomContacts(event.currentTarget.files?.[0])}
      />

      {error ? <div className="database-users-error">{error}</div> : null}

      <form className="database-users-query database-users-toolbar" onSubmit={applyUserFilters}>
        <div className="database-users-filter-grid">
          <label className="field database-users-keyword">
            <span>搜索</span>
            <div className="database-users-search-control">
              <Search size={16} />
              <input
                className="input"
                value={filterDraft.keyword}
                onChange={(event) => setFilterDraft((current) => ({ ...current, keyword: event.target.value }))}
                placeholder="姓名、用户名、用户组"
              />
            </div>
          </label>
          <label className="field">
            <span>角色</span>
            <select className="control" value={filterDraft.role} onChange={(event) => setFilterDraft((current) => ({ ...current, role: event.target.value as UserListFilters["role"] }))}>
              <option value="all">全部角色</option>
              <option value="admin">管理员</option>
              <option value="user">普通用户</option>
            </select>
          </label>
          <label className="field">
            <span>状态</span>
            <select className="control" value={filterDraft.status} onChange={(event) => setFilterDraft((current) => ({ ...current, status: event.target.value as UserListFilters["status"] }))}>
              <option value="all">全部状态</option>
              <option value="enabled">启用</option>
              <option value="disabled">禁用</option>
            </select>
          </label>
          <label className="field">
            <span>用户组</span>
            <select className="control" value={filterDraft.groupId} onChange={(event) => setFilterDraft((current) => ({ ...current, groupId: event.target.value }))}>
              <option value="all">全部用户组</option>
              {sortedGroups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="database-users-toolbar-actions">
          <button className="btn-primary" type="submit">
            查询
          </button>
          <button className="btn-secondary" type="button" onClick={resetUserFilters}>
            重置
          </button>
          <button className="btn-secondary" type="button" onClick={() => void loadUsers()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新
          </button>
          <button className="btn-primary" type="button" onClick={() => setCreateUserOpen(true)}>
            <Plus size={16} />
            新增用户
          </button>
          <button className="btn-secondary" type="button" onClick={() => importInputRef.current?.click()} disabled={action === "import-wecom"}>
            {action === "import-wecom" ? <Loader2 className="spin" size={16} /> : <FileSpreadsheet size={16} />}
            导入通讯录
          </button>
          {selectedUsers.length > 0 ? (
            <>
              <span className="database-users-count">已选 {selectedUsers.length} 条</span>
              <button className="btn-secondary" type="button" onClick={() => void batchToggleUsers(false)} disabled={batchBusy}>
                批量启用
              </button>
              <button className="btn-secondary" type="button" onClick={() => void batchToggleUsers(true)} disabled={batchBusy}>
                批量禁用
              </button>
              <button className="btn-secondary danger-action" type="button" onClick={() => void batchDeleteUsers()} disabled={batchBusy}>
                批量删除
              </button>
            </>
          ) : null}
        </div>
      </form>

      <div className="database-users-table-wrap">
        <table className="database-users-table">
          <thead>
            <tr>
              <th>
                <input
                  aria-label="选择当前页用户"
                  type="checkbox"
                  checked={allPagedSelected}
                  disabled={selectablePagedUsers.length === 0}
                  onChange={(event) => toggleSelectPage(event.target.checked)}
                />
              </th>
              <th>用户</th>
              <th>角色</th>
              <th>用户组</th>
              <th>状态</th>
              <th>生图限额</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="database-users-empty" colSpan={8}>
                  正在读取数据库用户...
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td className="database-users-empty" colSpan={8}>
                  没有匹配的数据库用户。
                  <button className="btn-secondary" type="button" onClick={resetUserFilters}>重置筛选</button>
                </td>
              </tr>
            ) : (
              pagedUsers.map((user) => {
                const isSelf = currentUser === user.username;
                const toggleBusy = action === `toggle:${user.id}`;
                const editBusy = action === `edit:${user.id}`;
                const deleteBusy = action === `delete:${user.id}`;
                const enabled = isUserEnabled(user);
                const imageLimit = imageLimitOverrideFor(user.username);
                return (
                  <tr key={user.id} className="database-user-row" onClick={() => openEditUser(user)}>
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        aria-label={`选择 ${userLabel(user)}`}
                        type="checkbox"
                        checked={Boolean(selectedUserIds[user.id])}
                        disabled={isSelf}
                        onChange={(event) => toggleSelectUser(user, event.target.checked)}
                      />
                    </td>
                    <td>
                      <strong>{user.displayName || user.username}</strong>
                      {user.displayName ? <span className="database-user-username">{user.username}</span> : null}
                      {isSelf ? <span className="database-user-self">当前登录</span> : null}
                    </td>
                    <td>{user.role === "admin" ? "管理员" : "普通用户"}</td>
                    <td>
                      {user.groupName || sortedGroups.find((group) => group.id === user.groupId)?.name || "-"}
                      {user.groupImageLimitsDisabled ? <span className="database-user-vip-note">免限额</span> : null}
                    </td>
                    <td>
                      <span className={`database-user-status ${enabled ? "is-enabled" : "is-disabled"}`}>{enabled ? "启用" : "禁用"}</span>
                    </td>
                    <td>
                      <div className="database-user-limit-summary">
                        <span>24h {imageLimit?.perUserDaily || groupLimitLabel(user.groupPerUserDaily, imageLimitDefaults.perUserDaily)}</span>
                        <span>1h {imageLimit?.perUserHourly || groupLimitLabel(user.groupPerUserHourly, imageLimitDefaults.perUserHourly)}</span>
                        <span>间隔 {imageLimit?.minIntervalSeconds || groupLimitLabel(user.groupMinIntervalSeconds, imageLimitDefaults.minIntervalSeconds)}</span>
                      </div>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div className="database-user-actions">
                        <button className="btn-secondary" type="button" onClick={() => openEditUser(user)} disabled={editBusy}>
                          {editBusy ? <Loader2 className="spin" size={16} /> : <Pencil size={16} />}
                          编辑
                        </button>
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
      <div className="database-users-pagination">
        <span>
          共 {filteredUsers.length} 条，第 {page} / {pageCount} 页
        </span>
        <label>
          每页
          <select className="control" value={pageSize} onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <div className="database-users-page-buttons">
          <button className="btn-secondary" type="button" onClick={() => setPage(1)} disabled={page <= 1}>首页</button>
          <button className="btn-secondary" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>上一页</button>
          <button className="btn-secondary" type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>下一页</button>
          <button className="btn-secondary" type="button" onClick={() => setPage(pageCount)} disabled={page >= pageCount}>末页</button>
        </div>
      </div>
      {createUserOpen ? (
        <div className="database-user-modal-backdrop" role="presentation" onClick={() => setCreateUserOpen(false)}>
          <form className="database-user-modal-panel" role="dialog" aria-modal="true" aria-label="新增用户" onSubmit={createUser} onClick={(event) => event.stopPropagation()}>
            <div className="database-user-modal-head">
              <div>
                <h5>新增用户</h5>
                <p>创建数据库登录用户，后续可在列表里编辑角色、用户组和限额。</p>
              </div>
              <button className="btn-secondary icon-action" type="button" onClick={() => setCreateUserOpen(false)} title="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="database-user-modal-grid">
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
            </div>
            <div className="database-user-modal-actions">
              <button className="btn-secondary" type="button" onClick={() => setCreateUserOpen(false)}>取消</button>
              <button className="btn-primary" type="submit" disabled={action === "create"}>
                {action === "create" ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                新增用户
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {editingUser && editUserDraft ? (
        <div className="database-user-modal-backdrop" role="presentation" onClick={closeEditUser}>
          <form className="database-user-modal-panel" role="dialog" aria-modal="true" aria-label="编辑用户" onSubmit={saveUserEdit} onClick={(event) => event.stopPropagation()}>
            <div className="database-user-modal-head">
              <div>
                <h5>{userLabel(editingUser)}</h5>
                <p>{editingUser.username}</p>
              </div>
              <button className="btn-secondary icon-action" type="button" onClick={closeEditUser} title="关闭">
                <X size={16} />
              </button>
            </div>
            <dl className="database-user-detail-list">
              <div><dt>状态</dt><dd>{isUserEnabled(editingUser) ? "启用" : "禁用"}</dd></div>
              <div><dt>创建时间</dt><dd>{formatDate(editingUser.createdAt)}</dd></div>
              <div><dt>更新时间</dt><dd>{formatDate(editingUser.updatedAt)}</dd></div>
            </dl>
            <div className="database-user-modal-grid">
              <label className="field">
                <span>角色</span>
                <select
                  className="control"
                  value={editUserDraft.role}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, role: event.target.value as DatabaseUserRole } : current)}
                  disabled={editingUser.username === currentUser}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <label className="field">
                <span>用户组</span>
                <select
                  className="control"
                  value={editUserDraft.groupId}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, groupId: event.target.value } : current)}
                >
                  {sortedGroups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
              <label className="field database-user-modal-wide">
                <span>新密码</span>
                <input
                  className="input"
                  type="password"
                  value={editUserDraft.password}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, password: event.target.value } : current)}
                  placeholder="留空则不修改"
                />
              </label>
            </div>
            <div className="database-user-modal-subtitle">生图限额覆盖</div>
            <div className="database-user-modal-grid three">
              <label className="field">
                <span>24 小时上限</span>
                <input
                  className="input"
                  inputMode="numeric"
                  min={0}
                  type="number"
                  value={editUserDraft.perUserDaily}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, perUserDaily: event.target.value } : current)}
                  placeholder={`继承：${groupLimitLabel(editingUser.groupPerUserDaily, imageLimitDefaults.perUserDaily)}`}
                />
              </label>
              <label className="field">
                <span>1 小时上限</span>
                <input
                  className="input"
                  inputMode="numeric"
                  min={0}
                  type="number"
                  value={editUserDraft.perUserHourly}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, perUserHourly: event.target.value } : current)}
                  placeholder={`继承：${groupLimitLabel(editingUser.groupPerUserHourly, imageLimitDefaults.perUserHourly)}`}
                />
              </label>
              <label className="field">
                <span>最小间隔秒数</span>
                <input
                  className="input"
                  inputMode="numeric"
                  max={86400}
                  min={0}
                  type="number"
                  value={editUserDraft.minIntervalSeconds}
                  onChange={(event) => setEditUserDraft((current) => current ? { ...current, minIntervalSeconds: event.target.value } : current)}
                  placeholder={`继承：${groupLimitLabel(editingUser.groupMinIntervalSeconds, imageLimitDefaults.minIntervalSeconds)}`}
                />
              </label>
            </div>
            <div className="database-user-modal-actions">
              <button className="btn-secondary" type="button" onClick={closeEditUser}>取消</button>
              <button className="btn-secondary" type="button" onClick={() => void toggleUser(editingUser)} disabled={editingUser.username === currentUser || action === `toggle:${editingUser.id}`}>
                {action === `toggle:${editingUser.id}` ? <Loader2 className="spin" size={16} /> : null}
                {isUserEnabled(editingUser) ? "禁用用户" : "启用用户"}
              </button>
              <button className="btn-secondary danger-action" type="button" onClick={() => void deleteUser(editingUser)} disabled={editingUser.username === currentUser || action === `delete:${editingUser.id}`}>
                {action === `delete:${editingUser.id}` ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                删除用户
              </button>
              <button className="btn-primary" type="submit" disabled={action === `edit:${editingUser.id}`}>
                {action === `edit:${editingUser.id}` ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
