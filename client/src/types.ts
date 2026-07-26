// Client-local types: the `ui` actions object (threaded through every view/grid
// component as props) and small grid/navigation helper signatures.
import type React from 'react';
import type { Entry, Task, Project, Client, User, UserCreateRequest, ParsedTime } from '../../shared/types';

/** The imperative actions the App exposes to every view; the highest-value client type. */
export interface UiActions {
  toast: (msg: string) => void;
  update: (id: string, patch: Partial<Entry>) => void;
  remove: (id: string) => void;
  add: (date: string, parsed: ParsedTime) => string;
  stop: (id: string) => void;
  openTaskModal: (name?: string, entryId?: string | null) => void;
  createTask: (input: { label: string; project: string | null }, entryId?: string | null) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  removeTask: (id: string) => void;
  addClient: () => void;
  updateClient: (id: string, patch: Partial<Client>) => void;
  /** SB-067: the name is committed (blur) — derive the id from it while the client is still unnamed & unreferenced. */
  commitClientName: (id: string) => void;
  /** SB-087 (SB-067 fix 3): a deliberate client-ID rename through the server — re-points every project. */
  renameClient: (id: string, next: string) => void;
  // SDD-002 ruling 7: clients & projects are ARCHIVED, never deleted — archive hides them
  // from creation pickers but keeps history resolving; restore un-hides them.
  archiveClient: (id: string) => void;
  restoreClient: (id: string) => void;
  addProject: () => void;
  createProject: (name: string) => void;
  updateProject: (code: string, patch: Partial<Project>) => void;
  /** DC-005 (PLAN-006): a deliberate code rename through the server — reconciles every user. */
  renameProject: (code: string, next: string) => void;
  archiveProject: (code: string) => void;
  restoreProject: (code: string) => void;
  setLanguage: (language: string) => void;
  setCurrency: (currency: string) => void;
  setMdDir: (dir: string) => void;
  /**
   * SB-065/SB-085: clear the standing mirror refusal — consent for the next save to
   * overwrite whatever is on disk. Resolves false (and toasts) when the server said no.
   */
  acknowledgeMirror: () => Promise<boolean>;
  importMd: (md: string) => boolean;
  openProject: (code: string) => void;
  /** SDD-002 ruling 4: attest a (week∩month) segment — the server freezes its money. */
  commitSegment: (key: string) => void;
  /** re-open a committed segment for edits (always free in Plan B — no admin lock yet). */
  uncommitSegment: (key: string) => void;
  users: {
    list: () => Promise<User[]>;
    create: (user: UserCreateRequest) => Promise<User>;
    remove: (id: number) => Promise<void>;
    /** admin reset — resolves false and toasts on failure, so the caller can keep the form open */
    setPassword: (id: number, password: string) => Promise<boolean>;
  };
  /** self-service change; rejects with the server error so the form can show it inline */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

/** The in-app route (no router; App holds this in state). `review` is admin-only (SB-025). */
export type Route =
  | { view: 'today' | 'week' | 'reports' | 'invoice' | 'review' | 'settings'; code?: undefined }
  | { view: 'project'; code: string };

export type SetRoute = React.Dispatch<React.SetStateAction<Route>>;

/** The task-modal init payload; null when closed. */
export type TaskModalInit = { name: string; entryId: string | null };

// ---- time grid cell wiring ----
/** A focusable grid cell is an input (time/task/note) or the bill toggle button. */
export type GridCell = HTMLInputElement | HTMLButtonElement;
/** reg(id, col) -> a React ref callback that registers the cell element for keyboard nav. */
export type RegisterCell = (id: string, col: number) => (el: GridCell | null) => void;
/** nav(rowId, col, dir) -> move focus to an adjacent cell. */
export type NavigateCell = (rowId: string, col: number, dir: 'up' | 'down' | 'left' | 'right') => void;
