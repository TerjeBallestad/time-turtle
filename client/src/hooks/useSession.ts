import React from 'react';
import { api } from '../api';
import type { ApiError } from '../api';
import type { AppState, FirstRunResponse } from '../../../shared/types';

/** null = loading · false = not logged in · AppState = logged-in state. */
export type SessionState = AppState | null | false;

// Session load/login/logout state machine.
export function useSession() {
  const [state, setState] = React.useState<SessionState>(null);
  // DD-024 — what the 401 MEANT. A 401 has two readings now and they lead to opposite screens:
  // a fresh install has not been asked what it is yet, and an answered team install wants a
  // password. Only the server can tell them apart, so the probe is asked and its answer is kept.
  //
  // `null` means "no first-run surface for this caller" and is the pre-DD-024 behaviour verbatim:
  // the probe 404s to anyone not on a loopback socket, and a LAN browser therefore lands on the
  // login screen exactly as it always did.
  const [firstRun, setFirstRun] = React.useState<FirstRunResponse | null>(null);
  const load = () =>
    api
      .getState()
      .then((next) => {
        setFirstRun(null); // a resolved session cannot be in the open state, and stale hints are worse than none
        setState(next);
      })
      .catch((err: ApiError) => {
        if (err.status !== 401) throw err;
        // ORDER MATTERS: `state` stays `null` — the loading screen — until the probe answers, so
        // the login form never flashes on a fresh install on its way to the first-run question.
        return api
          .firstRun()
          .then(setFirstRun)
          .catch(() => setFirstRun(null))
          .then(() => setState(false));
      });
  React.useEffect(() => {
    load();
  }, []);
  return { state, setState, firstRun, load };
}
