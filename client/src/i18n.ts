// i18n — English (default) + Norwegian. Keys are the English strings.
// Overrides the date formatters on the shared TT singleton with language-aware ones.
import TT from '../../shared/core.js';

const NO: Record<string, string> = {
  Today: 'I dag',
  'This week': 'Denne uken',
  Reports: 'Rapporter',
  Invoice: 'Faktura',
  Settings: 'Innstillinger',
  Projects: 'Prosjekter',
  Tasks: 'Oppgaver',
  Clients: 'Kunder',
  General: 'Generelt',
  // The English side is server/src/index.js's FIRST_RUN_CLOSED VERBATIM, because the key IS the
  // English string: if you edit one, edit the other in the same commit or the Norwegian falls
  // through untranslated. (This used to cite the capability refusals above it as the same
  // discipline; SB-181 removed every one of them, so the rule is stated here instead.)
  'the first run is over: this install has already answered it':
    'førstegangsoppsettet er over: denne installasjonen har allerede svart på det',
  // DD-024 clause 3 / SB-159: the demo step. Opt-in, off by default, and the button says which of
  // the two things it is about to do (DD-018 ruling 5) — never `OK`, which would make a person
  // re-read the checkbox to find out what they just agreed to.
  'Start with something in it?': 'Starte med noe i den?',
  'Add a few example clients, projects and a week of logged hours, so the app has something in it while you look around. You can delete them.':
    'Legg inn et par eksempelkunder, prosjekter og en uke med førte timer, så appen har noe i seg mens du ser deg om. Du kan slette dem.',
  'Add the example hours and start': 'Legg inn eksempeltimene og start',
  'Start with an empty timesheet': 'Start med en tom timeliste',
  // DD-024 clause 2: the starting-password note on the login screen. The first run sits in front
  // of the login, so a person who finishes it meets a wall holding a credential nobody showed them.
  'This install still has its starting password. Sign in as':
    'Denne installasjonen har fortsatt startpassordet sitt. Logg inn som',
  'and change it under Settings → Password. This note disappears when you do.':
    'og bytt det under Innstillinger → Passord. Denne meldingen forsvinner når du gjør det.',
  time: 'tid',
  task: 'oppgave',
  note: 'notat',
  bill: 'fakt',
  hours: 'timer',
  h: 't',
  count: 'antall',
  sum: 'sum',
  billable: 'fakturerbart',
  week: 'uke',
  Week: 'Uke',
  today: 'i dag',
  stop: 'stopp',
  timer: 'tidtaker',
  removed: 'slettet',
  '+ add': '+ ny',
  'task…': 'oppgave…',
  'search or create task…': 'søk eller opprett oppgave…',
  'create task': 'opprett oppgave',
  'New task': 'Ny oppgave',
  'Task name *': 'Oppgavenavn *',
  Project: 'Prosjekt',
  cancel: 'avbryt',
  'Billable by default': 'Fakturerbart som standard',
  'e.g. Checkout flow': 'f.eks. Utsjekk-flyt',
  'no project': 'uten prosjekt',
  'no client': 'uten kunde',
  'unrecognized — try 12:00-13:00, 12:30→ or 1h30m': 'ukjent format — prøv 12:00-13:00, 12:30→ eller 1h30m',
  'Timer started': 'Tidtaker startet',
  'Timer stopped': 'Tidtaker stoppet',
  'Entry removed': 'Rad slettet',
  'Task created': 'Oppgave opprettet',
  'Task removed': 'Oppgave slettet',
  'Project created': 'Prosjekt opprettet',
  'Client removed': 'Kunde slettet',
  'Invoice copied as markdown': 'Faktura kopiert som markdown',
  'time formats — ': 'tidsformater — ',
  range: 'intervall',
  'running timer': 'løpende tidtaker',
  'duration.': 'varighet.',
  'Overnight ranges roll to the next day. ': 'Intervaller over midnatt går til neste dag. ',
  adds: 'legger til',
  moves: 'flytter',
  'on empty deletes.': 'på tom rad sletter.',
  'by project': 'per prosjekt',
  'by client': 'per kunde',
  'this week': 'denne uken',
  'this month': 'denne måneden',
  all: 'alt',
  project: 'prosjekt',
  client: 'kunde',
  billed: 'fakturert',
  amount: 'beløp',
  total: 'totalt',
  date: 'dato',
  'Nothing tracked in this period.': 'Ingenting ført i denne perioden.',
  'Loading…': 'Laster…',
  'by person': 'per person',
  person: 'person',
  me: 'meg',
  team: 'team',
  'team totals are aggregated on the server — individual entries stay private to each user.':
    'teamtall summeres på serveren — enkeltrader forblir private for hver bruker.',
  'billed = hours rounded up per entry to the client’s rounding · non-billable entries excluded from billed and amount.':
    'fakturert = timer rundet opp per rad til kundens avrunding · ikke-fakturerbare rader holdes utenfor fakturert og beløp.',
  'copy as markdown': 'kopier som markdown',
  'round: ': 'avrunding: ',
  'rate: ': 'timepris: ',
  exact: 'eksakt',
  'per project': 'per prosjekt',
  'No billable hours for ': 'Ingen fakturerbare timer for ',
  ' in ': ' i ',
  'Project not found — it may have been removed.': 'Fant ikke prosjektet — det kan være slettet.',
  'No hours on this project yet.': 'Ingen timer på prosjektet ennå.',
  name: 'navn',
  rounding: 'avrunding',
  'default rate': 'standard timepris',
  code: 'kode',
  rate: 'timepris',
  '+ client': '+ kunde',
  '+ project': '+ prosjekt',
  '+ task': '+ oppgave',
  'No clients yet.': 'Ingen kunder ennå.',
  'No tasks yet — create one from the time grid.': 'Ingen oppgaver ennå — opprett fra timelisten.',
  'New client': 'Ny kunde',
  'New project': 'Nytt prosjekt',
  'client rate': 'kundens pris',
  Currency: 'Valuta',
  Language: 'Språk',
  'rounding — billed time per entry is rounded up to this increment.':
    'avrunding — fakturert tid per rad rundes opp til dette intervallet.',
  'rate — overrides the client default. Empty falls back to the client rate.':
    'timepris — overstyrer kundens standard. Tom bruker kundens pris.',
  'entries link to a task; the task carries the project (and through it, client, rate and rounding).':
    'rader knyttes til en oppgave; oppgaven eier prosjektet (og dermed kunde, timepris og avrunding).',
  // auth & users
  'Sign in': 'Logg inn',
  Email: 'E-post',
  Password: 'Passord',
  'Signing in…': 'Logger inn…',
  'sign out': 'logg ut',
  Users: 'Brukere',
  role: 'rolle',
  '+ user': '+ bruker',
  admin: 'admin',
  employee: 'ansatt',
  'Add user': 'Legg til bruker',
  Name: 'Navn',
  'Create user': 'Opprett bruker',
  'User created': 'Bruker opprettet',
  'User removed': 'Bruker slettet',
  password: 'passord',
  'Current password': 'Nåværende passord',
  'New password': 'Nytt passord',
  'Repeat new password': 'Gjenta nytt passord',
  'Change password': 'Endre passord',
  'Password changed': 'Passord endret',
  'The new passwords do not match': 'De nye passordene er ikke like',
  'Set password': 'Sett passord',
  'New password for ': 'Nytt passord for ',
  'Password updated': 'Passord oppdatert',
  'saving…': 'lagrer…',
  synced: 'synkronisert',
  'offline — retrying': 'frakoblet — prøver igjen',
  'someone else saved first — reloaded': 'noen andre lagret først — hentet på nytt',
  // SB-034: admin cross-user edit hit a stale-write 409 — the sheet was reloaded fresh.
  'This timesheet changed while you were editing — reloaded. Re-apply your correction.':
    'Denne timelisten ble endret mens du redigerte — hentet på nytt. Gjør korrigeringen på nytt.',
  saved: 'lagret',
};

TT.lang = 'en';
TT.t = (s) => (TT.lang === 'no' && NO[s] !== undefined ? NO[s] : s);

/**
 * DD-024: the language for a screen that renders BEFORE any session — the first run and the login.
 *
 * WHY IT EXISTS. `state.settings.language` is the real answer and it needs a session to read, so
 * every pre-session screen has always rendered English. That was invisible while the only such
 * screen was a login form with four words on it. This plan puts the whole first run there, and its
 * task requires both languages — a Norwegian meeting a genuinely fresh install has no stored
 * preference to read, because the setting that would carry one lives inside the app they have not
 * reached yet.
 *
 * `tt_lang` FIRST: a returning person's own choice, which is what a second install on the same
 * browser has. The browser's own language is the only signal a first one has. `nb`, `nn` and `no`
 * are all Norwegian to this app, which has exactly two languages.
 */
export function preSessionLang(stored: string | null): string {
  if (stored) return stored;
  const nav = typeof navigator === 'undefined' ? '' : navigator.language || '';
  return /^(nb|nn|no)\b/i.test(nav) ? 'no' : 'en';
}
const DAYS: Record<string, string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  no: ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'],
};
const MON: Record<string, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  no: ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'],
};
TT.fmtDayLong = (s) => {
  const d = TT.parseDate(s);
  return DAYS[TT.lang][d.getDay()] + ' ' + d.getDate() + ' ' + MON[TT.lang][d.getMonth()];
};
TT.fmtDayShort = (s) => {
  const d = TT.parseDate(s);
  return DAYS[TT.lang][d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MON[TT.lang][d.getMonth()];
};
TT.fmtMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return MON[TT.lang][m - 1] + ' ' + y;
};

export default TT;
