// Role gating for the UI. The server is the real enforcement layer —
// employees get rate-stripped state and 403s on catalog writes; this just
// hides what would be empty or forbidden anyway.
import type { AppState } from '../../shared/types';

export const isAdmin = (state: AppState): boolean => !!state.user && state.user.role === 'admin';
