import type {
  LoginResponse,
  StateResponse,
  StatePatch,
  PutStateResponse,
  UserCreateRequest,
  UsersResponse,
  UserResponse,
  OkResponse,
  ClientRenameResponse,
  MirrorAcknowledgeResponse,
  ProjectRenameResponse,
  TeamReportResponse,
  User,
  Settings,
  Client,
  Project,
  Task,
  Entry,
  CommitSegment,
  StateVersion,
} from '../../shared/types';

/**
 * SDD-002 ruling 6 (SB-025): the admin cross-user review read. A target user's full
 * timesheet with money PRESENT (admin) — entries, commit ledger (frozen snapshots),
 * templates and the shared catalog so the review view can resolve labels/colours and
 * compute live money for uncommitted segments via the snapshot-preferring readers.
 */
export interface UserTimesheet {
  user: User;
  settings: Settings;
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  entries: Entry[];
  commits: CommitSegment[];
  version: StateVersion;
}

/** Build a `?a=1&b=2` suffix, dropping undefined values; '' when nothing is set. */
function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter((pair): pair is [string, string] => pair[1] !== undefined);
  return pairs.length ? '?' + new URLSearchParams(pairs).toString() : '';
}

/** An Error carrying the failed response's HTTP status. */
export interface ApiError extends Error {
  status?: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  // justified: response body is trusted per the shared API contract, not
  // re-validated at the JSON parse boundary; {} stands in for a non-JSON body.
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err: ApiError = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) => request<LoginResponse>('POST', '/api/auth/login', { email, password }),
  logout: () => request<OkResponse>('POST', '/api/auth/logout'),
  getState: () => request<StateResponse>('GET', '/api/state'),
  putState: (patch: StatePatch) => request<PutStateResponse>('PUT', '/api/state', patch),
  /**
   * SB-065: clear a standing mirror refusal. This is NOT a dismiss — it ADOPTS the bytes
   * currently on disk as TT's stamp, which is consent for the next save to overwrite them.
   * Nothing is written here, so an acknowledgement made by mistake costs nothing until the
   * next save. Omit `userId` for your own mirror; admins may pass another user's id.
   */
  acknowledgeMirror: (userId?: number) =>
    request<MirrorAcknowledgeResponse>('POST', '/api/mirror/acknowledge', userId === undefined ? {} : { userId }),
  listUsers: () => request<UsersResponse>('GET', '/api/users'),
  createUser: (u: UserCreateRequest) => request<UserResponse>('POST', '/api/users', u),
  deleteUser: (id: number) => request<OkResponse>('DELETE', '/api/users/' + id),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<OkResponse>('POST', '/api/me/password', { currentPassword, newPassword }),
  setUserPassword: (id: number, password: string) =>
    request<OkResponse>('POST', '/api/users/' + id + '/password', { password }),
  /** admin only — cross-user totals over an inclusive date range (omit bounds for all time) */
  teamReport: (range: { from?: string; to?: string }) =>
    request<TeamReportResponse>('GET', '/api/reports/team' + query(range)),
  // SDD-002 rulings 5 & 6 (SB-025) — admin review surface, target-id-scoped:
  /** read any user's full timesheet (money present) */
  getUserTimesheet: (id: number) => request<UserTimesheet>('GET', '/api/users/' + id + '/timesheet'),
  /**
   * correct any user's entries line by line (collection-replace; server marks edited-by-admin
   * + re-freezes). DC-001: pass the version from the timesheet GET to make the write
   * conditional — a stale save (the employee logged an hour meanwhile) 409s instead of
   * clobbering it.
   */
  putUserEntries: (id: number, entries: Entry[], version?: StateVersion) =>
    request<PutStateResponse>('PUT', '/api/users/' + id + '/entries', { entries, version }),
  /** ruling 5 — lock a committed segment (the employee can no longer un-commit it) */
  approveSegment: (id: number, key: string) =>
    request<OkResponse>('POST', '/api/users/' + id + '/segments/' + encodeURIComponent(key) + '/approve'),
  /** ruling 5 — hand a segment back for edits */
  releaseSegment: (id: number, key: string) =>
    request<OkResponse>('POST', '/api/users/' + id + '/segments/' + encodeURIComponent(key) + '/release'),
  /**
   * DC-005 (PLAN-006) — rename a project's code across the WHOLE team in one server
   * transaction (every user's entries + templates reconciled old→new). Admin-only; a blind
   * reconcile — no entry content crosses. The caller reloads afterwards — its projects/
   * entries/tasks are otherwise stale.
   *
   * SB-086: the response reports every mirror this rename could not write. It writes
   * SEVERAL users' mirrors in one request, so the report is a LIST — the routes that write
   * one mirror carry a single `mirrorBlocked` instead.
   */
  renameProject: (code: string, to: string) =>
    request<ProjectRenameResponse>('POST', '/api/projects/' + encodeURIComponent(code) + '/rename', { to }),
  /**
   * SB-087 (SB-067 fix 3) — rename a client's ID, re-pointing every project that references
   * it in the SAME transaction. Admin-only. It needs the server because the two halves are
   * refused separately: a collection-replace PUT that drops the old id while projects still
   * point at it is a referenced delete (409). The caller reloads afterwards — its clients
   * AND its projects' clientId are both stale.
   */
  renameClient: (id: string, to: string) =>
    request<ClientRenameResponse>('POST', '/api/clients/' + encodeURIComponent(id) + '/rename', { to }),
};
