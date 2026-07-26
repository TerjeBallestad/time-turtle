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
  // SB-113: was 'Markdown backend' → 'Markdown-backend'. After DD-015/SB-100 "backend" means
  // `sqlite | vault`, derived from the shape and never selected — so the one place the word
  // reached a user named the concept it specifically does not mean. This section configures the
  // markdown MIRROR, which is the word the rest of the surface already uses (Mirror folder,
  // "mirror paused"), and `speil` is its established Norwegian.
  'Markdown mirror': 'Markdown-speil',
  // SB-056 / SB-100: the vault settings surface.
  // SB-056 / DD-008 / DD-011: the two capability refusals. The English side of these keys is
  // TT.shapeOffReason's text VERBATIM (shared/core.js) — the server puts the same string in
  // its 403 body, so the claim cannot drift between what the API says and what the screen says.
  // Only the language differs here; if you edit one of these, edit core.js in the same commit.
  'committing is off in the personal shape: the commit ledger lives in weekly notes, which phase 3 adds — a per-machine SQLite ledger would diverge silently (DD-008). Switch back to the team shape to commit.':
    'innsending er av i den personlige formen: innsendingsloggen hører hjemme i ukenotatene, som kommer i fase 3 — en SQLite-logg per maskin ville sprikt i stillhet (DD-008). Bytt tilbake til lagform for å sende inn.',
  'applying markdown edits is off in the personal shape: the vault’s daily notes are the markdown surface now, and the v2 mirror files this would restore from are no longer maintained (DD-011). Copy and download still work.':
    'å ta i bruk markdown-endringer er av i den personlige formen: dagsnotatene i hvelvet er markdown-flaten nå, og v2-speilfilene dette ville gjenopprettet fra vedlikeholdes ikke lenger (DD-011). Kopier og last ned virker fortsatt.',
  // SB-056 / DD-006: the single-user refusals. These reach the user as a TOAST — setShape
  // surfaces the server's error verbatim — so without these keys a Norwegian admin got an
  // English sentence at the one moment the app is telling them no. English side is
  // server/src/index.js's SECOND_USER_REFUSAL / shapeSwitchRefusal verbatim; the count in
  // the second one is interpolated server-side, so only the fixed prefix can be translated
  // here — see the note in the review commit.
  'a vault belongs to one person, so the personal shape allows exactly one user (DD-006): there is no answer to whose daily note a second person’s hours would land in. Switch to the team shape to add users.':
    'et hvelv tilhører én person, så den personlige formen tillater nøyaktig én bruker (DD-006): det finnes ikke noe svar på hvilket dagsnotat en person nummer to sine timer skulle havne i. Bytt til lagform for å legge til brukere.',
  Vault: 'Hvelv',
  'Instance shape': 'Instansform',
  Team: 'Lag',
  Personal: 'Personlig',
  'instance shape: ': 'instansform: ',
  'the server pins the instance shape (TT_SHAPE_LOCK) — change it in the server environment.':
    'serveren har låst instansformen (TT_SHAPE_LOCK) — endre den i servermiljøet.',
  'A team install keeps SQLite as the source of truth and mirrors every save to markdown. A personal install is one person, with an Obsidian vault as the source of truth instead.':
    'En laginstallasjon har SQLite som fasit og speiler hver lagring til markdown. En personlig installasjon er én person, med et Obsidian-hvelv som fasit i stedet.',
  'The personal shape is not finished: the markdown mirror is off (the files it wrote are retired), committing is off until weekly notes land, and markdown paste-back is off. Nothing syncs these paths yet.':
    'Den personlige formen er ikke ferdig: markdown-speilet er av (filene den skrev er pensjonert), innsending er av til ukenotatene kommer, og tilbakeliming av markdown er av. Ingenting synkroniserer disse stiene ennå.',
  'Vault folder': 'Hvelvmappe',
  'e.g. ~/Obsidian/ballestad': 'f.eks. ~/Obsidian/ballestad',
  'the vault root — every path below is relative to it.': 'roten i hvelvet — alle stiene under er relative til den.',
  'Daily notes': 'Dagsnotater',
  'Weekly notes': 'Ukenotater',
  'where the commit ledger will live once weekly rollups land.':
    'her havner innsendingsloggen når ukesoppsummeringene kommer.',
  'Catalog note': 'Katalognotat',
  // Deliberately short: 'Overskrift for timeloggen' wrapped to two lines in the 128px label
  // column and broke the row rhythm the rest of this view keeps.
  'Time Log heading': 'Timelogg-overskrift',
  'the heading Time Turtle writes its block under in a daily note — rename it here if you renamed it there.':
    'overskriften Time Turtle skriver blokken sin under i et dagsnotat — endre den her hvis du endret den der.',
  'Time separator': 'Tidsskille',
  'how a daily note writes a start and an end time. Reading accepts all three, so changing it never needs a migration.':
    'hvordan et dagsnotat skriver start- og sluttid. Lesing godtar alle tre, så en endring krever aldri migrering.',
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
  'Markdown applied': 'Markdown lagret',
  'Could not parse markdown': 'Kunne ikke tolke markdown',
  'Invoice copied as markdown': 'Faktura kopiert som markdown',
  'Markdown copied': 'Markdown kopiert',
  'timesheet.md downloaded': 'timesheet.md lastet ned',
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
  copy: 'kopier',
  'download .md': 'last ned .md',
  'apply edits': 'bruk endringer',
  discard: 'forkast',
  'rounding — billed time per entry is rounded up to this increment.':
    'avrunding — fakturert tid per rad rundes opp til dette intervallet.',
  'rate — overrides the client default. Empty falls back to the client rate.':
    'timepris — overstyrer kundens standard. Tom bruker kundens pris.',
  'entries link to a task; the task carries the project (and through it, client, rate and rounding).':
    'rader knyttes til en oppgave; oppgaven eier prosjektet (og dermed kunde, timepris og avrunding).',
  'The whole timesheet persists as one markdown file — clients, projects and a section per day. Sync it to any cloud drive, edit it by hand, paste it back here. This is the entire database.':
    'Hele timelisten lagres som én markdown-fil — kunder, prosjekter og én seksjon per dag. Synk den til skyen, rediger for hånd, lim tilbake her. Dette er hele databasen.',
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
  'Saved to server + markdown mirror': 'Lagret til server + markdown-speil',
  'Mirror folder': 'Speilmappe',
  'markdown mirror failed: ': 'markdown-speil feilet: ',
  'server default — e.g. ~/Obsidian/vault/timesheets': 'serverstandard — f.eks. ~/Obsidian/vault/timelister',
  'every save writes timesheet-<user>.md here — point it at a cloud-synced folder (Obsidian, Dropbox…). Empty uses the server default.':
    'hver lagring skriver timesheet-<bruker>.md hit — pek på en skysynket mappe (Obsidian, Dropbox…). Tom bruker serverstandarden.',
  'locked to the server default': 'låst til serverstandarden',
  'the server pins the mirror folder (TT_MD_DIR_LOCK) — change it in the server environment.':
    'serveren låser speilmappen (TT_MD_DIR_LOCK) — endre den i servermiljøet.',
  // SB-085: the standing mirror refusal (SB-065's guard). The two `reason` strings are the
  // server's own wording, translated here by exact match.
  //
  // SB-095 moved the notice OUT of the admin-only Mirror folder row into a section of its own
  // that every user sees, so the toast had to stop pointing at a row a non-admin cannot reach:
  // it names the new section ('Mirror' / 'Speil') instead.
  Mirror: 'Speil',
  'mirror paused — see Settings → Mirror': 'speiling satt på pause — se Innstillinger → Speil',
  'mirror unblocked — the next save overwrites the file': 'speiling gjenåpnet — neste lagring overskriver filen',
  'Mirror paused': 'Speiling satt på pause',
  'the file changed on disk since Time Turtle last wrote it':
    'filen er endret på disken siden Time Turtle sist skrev den',
  'the file was not written by this Time Turtle': 'filen er ikke skrevet av denne Time Turtle',
  'detected ': 'oppdaget ',
  'last written by Time Turtle ': 'sist skrevet av Time Turtle ',
  'never written by Time Turtle': 'aldri skrevet av Time Turtle',
  'Time Turtle will not overwrite a file it did not write, so it has stopped mirroring this timesheet. Everything you log is still saved here — only the markdown file is frozen. Copy it somewhere safe if it holds changes you need.':
    'Time Turtle overskriver ikke en fil den ikke har skrevet selv, så speilingen av denne timelisten er stanset. Alt du fører opp lagres fortsatt her — det er bare markdown-filen som er frosset. Ta en kopi av den et trygt sted hvis den inneholder endringer du trenger.',
  // SB-095: the same notice, about SOMEBODY ELSE's mirror, shown to an admin. Second person
  // is wrong there — the hours are not the reader's — so the heading and the body differ while
  // the two buttons and the red confirm line are shared.
  'Mirror paused for ': 'Speiling satt på pause for ',
  'Time Turtle will not overwrite a file it did not write, so it has stopped mirroring this person’s timesheet. Their hours are still saved here — only the markdown file is frozen. Copy it somewhere safe before you adopt it.':
    'Time Turtle overskriver ikke en fil den ikke har skrevet selv, så speilingen av denne personens timeliste er stanset. Timene deres lagres fortsatt her — det er bare markdown-filen som er frosset. Ta en kopi av den et trygt sted før du overtar den.',
  'Adopt the file on disk…': 'Overta filen på disken…',
  'Nothing is merged: Time Turtle adopts the file exactly as it stands right now, and the next save replaces its contents with the data in this app.':
    'Ingenting slås sammen: Time Turtle overtar filen nøyaktig slik den står nå, og neste lagring erstatter innholdet med dataene i denne appen.',
  'Adopt it and overwrite on the next save': 'Overta den og overskriv ved neste lagring',
};

TT.lang = 'en';
TT.t = (s) => (TT.lang === 'no' && NO[s] !== undefined ? NO[s] : s);
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
