import React from 'react';
import { api } from '../api';
import type { ApiError } from '../api';
import type { AppState } from '../../../shared/types';

/** null = loading · false = not logged in · AppState = logged-in state. */
export type SessionState = AppState | null | false;

// Session load/login/logout state machine.
export function useSession() {
  const [state, setState] = React.useState<SessionState>(null);
  const load = () =>
    api
      .getState()
      .then(setState)
      .catch((err: ApiError) => {
        if (err.status === 401) setState(false);
        else throw err;
      });
  React.useEffect(() => {
    load();
  }, []);
  return { state, setState, load };
}
