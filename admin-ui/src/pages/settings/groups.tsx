import { Loader2, Pencil, Plus, RefreshCw, Search, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { fetchJson } from "@/shared/api";
import { errorMessage } from "@/shared/lib/app-utils";

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

type DatabaseUser = {
  id: string;
  username: string;
  displayName?: string;
  role: "admin" | "user";
  groupId?: string;
  groupName?: string;
  disabled?: boolean;
  createdAt?: number | string;
};

type GroupDraft = {
  name: string;
  sortOrder: string;
  imageLimitsDisabled: boolean;
  perUserDaily: string;
  perUserHourly: string;
  minIntervalSeconds: string;
};

type ActionState = "load" | "save" | `delete:${string}` | `move:${string}` | null;

function blankDraft(): GroupDraft {
  return {
    name: "",
    sortOrder: "0",
    imageLimitsDisabled: false,
    perUserDaily: "",
    perUserHourly: "",
    minIntervalSeconds: "",
  };
}

function draftFromGroup(group: DatabaseUserGroup): GroupDraft {
  return {
    name: group.name,
    sortOrder: String(group.sortOrder),
    imageLimitsDisabled: group.imageLimitsDisabled,
    perUserDaily: group.perUserDaily === undefined ? "" : String(group.perUserDaily),
    perUserHourly: group.perUserHourly === undefined ? "" : String(group.perUserHourly),
    minIntervalSeconds: group.minIntervalSeconds === undefined ? "" : String(group.minIntervalSeconds),
  };
}

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

function parseOptionalLimit(value: string, label: string, max = 100_000): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${label}必须是 0 到 ${max} 之间的整数。`);
  }
  return parsed;
}

function normalizeGroups(payload: { data?: DatabaseUserGroup[]; groups?: DatabaseUserGroup[] } | DatabaseUserGroup[]): DatabaseUserGroup[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.data ?? payload.groups ?? [];
}

function normalizeUsers(payload: { data?: DatabaseUser[]; users?: DatabaseUser[] } | DatabaseUser[]): DatabaseUser[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.data ?? payload.users ?? [];
}

function limitSummary(group: DatabaseUserGroup): string {
  if (group.imageLimitsDisabled) {
    return "免限额";
  }
  const values = [
    group.perUserDaily === undefined ? null : `24h ${group.perUserDaily}`,
    group.perUserHourly === undefined ? null : `1h ${group.perUserHourly}`,
    group.minIntervalSeconds === undefined ? null : `间隔 ${group.minIntervalSeconds}`,
  ].filter(Boolean);
  return values.length > 0 ? values.join(" / ") : "继承全局";
}

function userLabel(user: DatabaseUser): string {
  return user.displayName?.trim() || user.username;
}

function isUserEnabled(user: DatabaseUser): boolean {
  return !user.disabled;
}

export function SettingsGroupsPage(props: {
  setStatus: Dispatch<SetStateAction<string>>;
}) {
  const [groups, setGroups] = useState<DatabaseUserGroup[]>([]);
  const [users, setUsers] = useState<DatabaseUser[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<DatabaseUserGroup | null>(null);
  const [memberGroupId, setMemberGroupId] = useState<string | null>(null);
  const [memberKeywordDraft, setMemberKeywordDraft] = useState("");
  const [memberKeyword, setMemberKeyword] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [draft, setDraft] = useState<GroupDraft>(blankDraft);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [action, setAction] = useState<ActionState>("load");
  const [error, setError] = useState<string | null>(null);

  const sortedGroups = useMemo(
    () => [...groups].sort((first, second) => second.sortOrder - first.sortOrder || first.name.localeCompare(second.name, "zh-CN")),
    [groups],
  );
  const filteredGroups = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return sortedGroups.filter((group) => !text || group.name.toLowerCase().includes(text) || String(group.sortOrder).includes(text));
  }, [keyword, sortedGroups]);
  const pageCount = Math.max(1, Math.ceil(filteredGroups.length / pageSize));
  const pagedGroups = useMemo(() => filteredGroups.slice((page - 1) * pageSize, page * pageSize), [filteredGroups, page, pageSize]);
  const userCountByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of users) {
      if (user.groupId) {
        counts.set(user.groupId, (counts.get(user.groupId) ?? 0) + 1);
      }
    }
    return counts;
  }, [users]);
  const memberGroup = useMemo(() => groups.find((group) => group.id === memberGroupId) ?? null, [groups, memberGroupId]);
  const memberUsers = useMemo(
    () => users
      .filter((user) => user.groupId === memberGroupId)
      .sort((first, second) => userLabel(first).localeCompare(userLabel(second), "zh-CN") || first.username.localeCompare(second.username, "zh-CN")),
    [memberGroupId, users],
  );
  const memberSearchText = memberKeyword.trim().toLowerCase();
  const filteredMemberUsers = useMemo(
    () => memberUsers.filter((user) => {
      const haystack = [userLabel(user), user.username, user.groupName || ""].join(" ").toLowerCase();
      return !memberSearchText || haystack.includes(memberSearchText);
    }),
    [memberSearchText, memberUsers],
  );
  const memberPageSize = 12;
  const memberPageCount = Math.max(1, Math.ceil(filteredMemberUsers.length / memberPageSize));
  const pagedMemberUsers = useMemo(() => filteredMemberUsers.slice((memberPage - 1) * memberPageSize, memberPage * memberPageSize), [filteredMemberUsers, memberPage]);
  const candidateUsers = useMemo(
    () => users
      .filter((user) => user.groupId !== memberGroupId)
      .filter((user) => {
        const haystack = [userLabel(user), user.username, user.groupName || ""].join(" ").toLowerCase();
        return !memberSearchText || haystack.includes(memberSearchText);
      })
      .sort((first, second) => userLabel(first).localeCompare(userLabel(second), "zh-CN") || first.username.localeCompare(second.username, "zh-CN"))
      .slice(0, 8),
    [memberGroupId, memberSearchText, users],
  );

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  useEffect(() => {
    if (memberPage > memberPageCount) {
      setMemberPage(memberPageCount);
    }
  }, [memberPage, memberPageCount]);

  async function loadAll(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setAction("load");
    }
    try {
      const [groupsPayload, usersPayload] = await Promise.all([
        fetchJson<{ data?: DatabaseUserGroup[]; groups?: DatabaseUserGroup[] } | DatabaseUserGroup[]>("/_gateway/admin/user-groups"),
        fetchJson<{ data?: DatabaseUser[]; users?: DatabaseUser[] } | DatabaseUser[]>("/_gateway/admin/users"),
      ]);
      setGroups(normalizeGroups(groupsPayload));
      setUsers(normalizeUsers(usersPayload));
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      props.setStatus(`用户组读取失败：${message}`);
    } finally {
      if (!options?.silent) {
        setAction(null);
      }
    }
  }

  useEffect(() => {
    loadAll().catch(() => undefined);
  }, []);

  function openCreateModal() {
    setEditingGroup(null);
    setDraft(blankDraft());
    setGroupModalOpen(true);
  }

  function openEditModal(group: DatabaseUserGroup) {
    setEditingGroup(group);
    setDraft(draftFromGroup(group));
    setGroupModalOpen(true);
  }

  function openMembersModal(group: DatabaseUserGroup) {
    setMemberGroupId(group.id);
    setMemberKeywordDraft("");
    setMemberKeyword("");
    setMemberPage(1);
  }

  function closeModal() {
    setGroupModalOpen(false);
    setEditingGroup(null);
    setDraft(blankDraft());
  }

  function closeMembersModal() {
    setMemberGroupId(null);
    setMemberKeywordDraft("");
    setMemberKeyword("");
    setMemberPage(1);
  }

  function applyFilters(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setKeyword(keywordDraft.trim());
    setPage(1);
  }

  function resetFilters() {
    setKeywordDraft("");
    setKeyword("");
    setPage(1);
  }

  function applyMemberFilters(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setMemberKeyword(memberKeywordDraft.trim());
    setMemberPage(1);
  }

  function resetMemberFilters() {
    setMemberKeywordDraft("");
    setMemberKeyword("");
    setMemberPage(1);
  }

  async function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    const sortOrder = Number.parseInt(draft.sortOrder || "0", 10);
    if (!name) {
      setError("请填写用户组名称。");
      return;
    }
    if (!Number.isInteger(sortOrder)) {
      setError("用户组排序必须是整数。");
      return;
    }
    try {
      const payload = {
        name,
        sortOrder,
        imageLimitsDisabled: draft.imageLimitsDisabled,
        perUserDaily: parseOptionalLimit(draft.perUserDaily, "24 小时生图上限"),
        perUserHourly: parseOptionalLimit(draft.perUserHourly, "1 小时生图上限"),
        minIntervalSeconds: parseOptionalLimit(draft.minIntervalSeconds, "最小间隔秒数", 86_400),
      };
      setAction("save");
      if (editingGroup) {
        await fetchJson(`/_gateway/admin/user-groups/${encodeURIComponent(editingGroup.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        props.setStatus(`用户组 ${name} 已保存。`);
      } else {
        await fetchJson("/_gateway/admin/user-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        props.setStatus(`用户组 ${name} 已新增。`);
      }
      closeModal();
      await loadAll({ silent: true });
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      props.setStatus(`保存用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function deleteGroup(group: DatabaseUserGroup) {
    if (!window.confirm(`确认删除用户组 ${group.name}？该组下用户会自动移动到排序最低的剩余分组。`)) {
      return;
    }
    setAction(`delete:${group.id}`);
    try {
      await fetchJson<{ ok: boolean }>(`/_gateway/admin/user-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
      await loadAll({ silent: true });
      props.setStatus(`用户组 ${group.name} 已删除。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      props.setStatus(`删除用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  async function addUserToGroup(user: DatabaseUser) {
    if (!memberGroup) {
      return;
    }
    setAction(`move:${user.id}`);
    try {
      const payload = await fetchJson<{ user?: DatabaseUser }>(`/_gateway/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: memberGroup.id }),
      });
      if (payload.user) {
        setUsers((current) => current.map((item) => item.id === payload.user?.id ? payload.user : item));
      } else {
        await loadAll({ silent: true });
      }
      props.setStatus(`${userLabel(user)} 已加入 ${memberGroup.name}。`);
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      props.setStatus(`添加用户到用户组失败：${message}`);
    } finally {
      setAction(null);
    }
  }

  const loading = action === "load";

  return (
    <section className="settings-page settings-groups-page">
      {error ? <div className="database-users-error">{error}</div> : null}

      <form className="database-users-query database-users-query-compact" onSubmit={applyFilters}>
        <label className="field database-users-keyword">
          <div className="database-users-search-control">
            <Search size={16} />
            <input className="input" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} placeholder="用户组名称、排序" />
          </div>
        </label>
        <div className="database-users-query-actions">
          <button className="btn-primary" type="submit">查询</button>
          <button className="btn-secondary" type="button" onClick={resetFilters}>重置</button>
          <button className="btn-secondary" type="button" onClick={() => void loadAll()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新
          </button>
          <button className="btn-primary" type="button" onClick={openCreateModal}>
            <Plus size={16} />
            新增用户组
          </button>
        </div>
      </form>

      <div className="database-users-table-wrap">
        <table className="database-users-table database-groups-table">
          <thead>
            <tr>
              <th>用户组</th>
              <th>排序</th>
              <th>用户数</th>
              <th>限额策略</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="database-users-empty" colSpan={6}>正在读取用户组...</td></tr>
            ) : filteredGroups.length === 0 ? (
              <tr><td className="database-users-empty" colSpan={6}>没有匹配的用户组。</td></tr>
            ) : (
              pagedGroups.map((group) => (
                <tr key={group.id} className="database-user-row" onClick={() => openEditModal(group)}>
                  <td><strong>{group.name}</strong></td>
                  <td>{group.sortOrder}</td>
                  <td>
                    <button className="btn-linklike" type="button" onClick={(event) => {
                      event.stopPropagation();
                      openMembersModal(group);
                    }}>
                      {userCountByGroup.get(group.id) ?? 0}
                    </button>
                  </td>
                  <td>{limitSummary(group)}</td>
                  <td>{formatDate(group.updatedAt)}</td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="database-user-actions">
                      <button className="btn-secondary" type="button" onClick={() => openMembersModal(group)}>
                        <UsersRound size={16} />
                        成员
                      </button>
                      <button className="btn-secondary" type="button" onClick={() => openEditModal(group)}>
                        <Pencil size={16} />
                        编辑
                      </button>
                      <button className="btn-secondary danger-action icon-action" type="button" onClick={() => void deleteGroup(group)} disabled={action === `delete:${group.id}` || groups.length <= 1} title="删除用户组">
                        {action === `delete:${group.id}` ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filteredGroups.length > pageSize ? (
        <div className="database-users-pagination">
          <span>第 {page} / {pageCount} 页，显示 {pagedGroups.length} 条</span>
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
      ) : null}

      {groupModalOpen ? (
        <div className="database-user-modal-backdrop" role="presentation" onClick={closeModal}>
          <form className="database-user-modal-panel" role="dialog" aria-modal="true" aria-label={editingGroup ? "编辑用户组" : "新增用户组"} onSubmit={saveGroup} onClick={(event) => event.stopPropagation()}>
            <div className="database-user-modal-head">
              <div>
                <h5>{editingGroup ? "编辑用户组" : "新增用户组"}</h5>
                <p>组级限额仅在用户没有单独限额覆盖时生效；留空表示继承全局限制。</p>
              </div>
              <button className="btn-secondary icon-action" type="button" onClick={closeModal} title="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="database-user-modal-grid">
              <label className="field">
                <span>用户组名称</span>
                <input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如 VIP 用户组" />
              </label>
              <label className="field">
                <span>排序</span>
                <input className="input" type="number" value={draft.sortOrder} onChange={(event) => setDraft((current) => ({ ...current, sortOrder: event.target.value }))} />
              </label>
              <label className="switch-line database-user-modal-wide">
                <input type="checkbox" checked={draft.imageLimitsDisabled} onChange={(event) => setDraft((current) => ({ ...current, imageLimitsDisabled: event.target.checked }))} />
                <span>免生图限额</span>
              </label>
            </div>
            <div className="database-user-modal-subtitle">组级生图限额</div>
            <div className="database-user-modal-grid three">
              <label className="field">
                <span>24 小时上限</span>
                <input className="input" inputMode="numeric" min={0} type="number" value={draft.perUserDaily} onChange={(event) => setDraft((current) => ({ ...current, perUserDaily: event.target.value }))} placeholder="继承全局" />
              </label>
              <label className="field">
                <span>1 小时上限</span>
                <input className="input" inputMode="numeric" min={0} type="number" value={draft.perUserHourly} onChange={(event) => setDraft((current) => ({ ...current, perUserHourly: event.target.value }))} placeholder="继承全局" />
              </label>
              <label className="field">
                <span>最小间隔秒数</span>
                <input className="input" inputMode="numeric" max={86400} min={0} type="number" value={draft.minIntervalSeconds} onChange={(event) => setDraft((current) => ({ ...current, minIntervalSeconds: event.target.value }))} placeholder="继承全局" />
              </label>
            </div>
            <div className="database-user-modal-actions">
              <button className="btn-secondary" type="button" onClick={closeModal}>取消</button>
              <button className="btn-primary" type="submit" disabled={action === "save"}>
                {action === "save" ? <Loader2 className="spin" size={16} /> : null}
                保存
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {memberGroup ? (
        <div className="database-user-modal-backdrop" role="presentation" onClick={closeMembersModal}>
          <div className="database-user-modal-panel database-group-members-panel" role="dialog" aria-modal="true" aria-label={`${memberGroup.name} 成员`} onClick={(event) => event.stopPropagation()}>
            <div className="database-user-modal-head">
              <div>
                <h5>{memberGroup.name}</h5>
                <p>{memberUsers.length} 个用户</p>
              </div>
              <button className="btn-secondary icon-action" type="button" onClick={closeMembersModal} title="关闭">
                <X size={16} />
              </button>
            </div>
            <form className="database-group-members-query" onSubmit={applyMemberFilters}>
              <div className="database-users-search-control">
                <Search size={16} />
                <input className="input" value={memberKeywordDraft} onChange={(event) => setMemberKeywordDraft(event.target.value)} placeholder="姓名、用户名" />
              </div>
              <button className="btn-primary" type="submit">查询</button>
              <button className="btn-secondary" type="button" onClick={resetMemberFilters}>重置</button>
            </form>
            <div className="database-group-members-layout">
              <section className="database-group-member-section">
                <div className="database-group-member-section-head">
                  <strong>组内用户</strong>
                  <span>{filteredMemberUsers.length} 条</span>
                </div>
                <div className="database-group-member-list">
                  {pagedMemberUsers.length === 0 ? (
                    <div className="database-group-member-empty">没有匹配的用户。</div>
                  ) : pagedMemberUsers.map((user) => (
                    <div className="database-group-member-row" key={user.id}>
                      <div>
                        <strong>{userLabel(user)}</strong>
                        {user.displayName ? <span>{user.username}</span> : null}
                      </div>
                      <span className={`database-user-status ${isUserEnabled(user) ? "is-enabled" : "is-disabled"}`}>{isUserEnabled(user) ? "启用" : "禁用"}</span>
                    </div>
                  ))}
                </div>
                {filteredMemberUsers.length > memberPageSize ? (
                  <div className="database-group-member-pager">
                    <span>第 {memberPage} / {memberPageCount} 页</span>
                    <div className="database-users-page-buttons">
                      <button className="btn-secondary" type="button" onClick={() => setMemberPage((current) => Math.max(1, current - 1))} disabled={memberPage <= 1}>上一页</button>
                      <button className="btn-secondary" type="button" onClick={() => setMemberPage((current) => Math.min(memberPageCount, current + 1))} disabled={memberPage >= memberPageCount}>下一页</button>
                    </div>
                  </div>
                ) : null}
              </section>
              <section className="database-group-member-section">
                <div className="database-group-member-section-head">
                  <strong>可加入用户</strong>
                  <span>{candidateUsers.length} 条</span>
                </div>
                <div className="database-group-member-list">
                  {candidateUsers.length === 0 ? (
                    <div className="database-group-member-empty">没有匹配的用户。</div>
                  ) : candidateUsers.map((user) => (
                    <div className="database-group-member-row" key={user.id}>
                      <div>
                        <strong>{userLabel(user)}</strong>
                        <span>{user.displayName ? user.username : user.groupName || "未分组"}</span>
                      </div>
                      <button className="btn-secondary" type="button" onClick={() => void addUserToGroup(user)} disabled={action === `move:${user.id}`}>
                        {action === `move:${user.id}` ? <Loader2 className="spin" size={16} /> : <UserPlus size={16} />}
                        加入
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
