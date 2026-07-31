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
  // "mirror paused").
  //
  // `Markdown mirror` is deliberately NOT translated (Terje, 2026-07-27), so there is no key for
  // it here and it falls through TT.t untouched. The rule, in his words: a compound that welds an
  // English word to a Norwegian one — `Markdown-speil` — is naming ONE specific concept in two
  // languages at once, and the concept is what goes blurry. Keep the term whole and English; let
  // the surrounding Norwegian do the explaining. So `Speilmappe` in the body directly beneath this
  // heading is correct and stays: the English term names the thing, the Norwegian words describe
  // it. `speil`/`speiling` likewise remain the Norwegian for the standalone Mirror section and for
  // the ACT of mirroring — those are ordinary words, not this term.
  // SB-056 / SB-100: the vault settings surface.
  // SB-056 / DD-008 / DD-011: the two capability refusals. The English side of these keys is
  // TT.shapeOffReason's text VERBATIM (shared/core.js) — the server puts the same string in
  // its 403 body, so the claim cannot drift between what the API says and what the screen says.
  // Only the language differs here; if you edit one of these, edit core.js in the same commit.
  'committing is off in the personal shape: the commit ledger lives in weekly notes, which phase 3 adds — a per-machine SQLite ledger would diverge silently (DD-008). Switch back to the team shape to commit.':
    'innsending er av i den personlige formen: innsendingsloggen hører hjemme i ukenotatene, som kommer i fase 3 — en SQLite-logg per maskin ville sprikt i stillhet (DD-008). Bytt tilbake til lagform for å sende inn.',
  'applying markdown edits is off in the personal shape: the vault’s daily notes are the markdown surface now, and the v2 mirror files this would restore from are no longer maintained (DD-011). Copy and download still work.':
    'å ta i bruk markdown-endringer er av i den personlige formen: dagsnotatene i hvelvet er markdown-flaten nå, og v2-speilfilene dette ville gjenopprettet fra vedlikeholdes ikke lenger (DD-011). Kopier og last ned virker fortsatt.',
  // SB-102 / DD-017 §3+§4: the two strings the frozen grid and the Week view render.
  //
  // `before your vault · read-only` is Terje's ruled string, not a suggestion — it is what a week
  // that predates the vault says, once, and it is what the locked grid beneath it says per day.
  // The Norwegian keeps the ruled shape: the same two halves, the same middot, no extra promise.
  // Neither side says `cutover` (DD-017 §4 — that is the repo's word, never the screen's) and
  // neither says anything about phase 3 importing anything, because there is no importer.
  //
  // The five pre-existing chip words (`open`/`committed`/`locked`/`commit`/`reopen`) and the two
  // older lock hints are still English-only and still SB-097's ticket, deliberately not widened
  // into here. These two are new, so they ship both languages (§5).
  'before your vault · read-only': 'før hvelvet ditt · skrivebeskyttet',
  'read-only': 'skrivebeskyttet',
  // SB-102 / DD-017 §1: the frozen-day refusal. Same discipline as the two capability refusals
  // above and for the same reason — `useServerSync` toasts `err.message`, which is the server's
  // raw string, so without this key a Norwegian user gets an English sentence at the one moment
  // the app is telling them no. The English side is TT.FROZEN_ENTRY_REFUSAL VERBATIM
  // (shared/core.js); if you edit one, edit core.js in the same commit.
  //
  // DD-017 §4 governs the words in BOTH languages: it says what is frozen and that the hours are
  // already saved, it promises no phase-3 import (there is no importer), and neither side says
  // `cutover` — "før hvelvet ditt" is Terje's ruled "before your vault".
  'these hours are read-only: the day is from before your vault, or it sits inside a week you committed. They are already saved exactly as they are — Time Turtle keeps them and will not rewrite them.':
    'disse timene er skrivebeskyttet: dagen er fra før hvelvet ditt, eller den ligger inne i en uke du har sendt inn. De er allerede lagret nøyaktig som de er — Time Turtle beholder dem og skriver dem ikke om.',
  // SB-056 / DD-006: the single-user refusals. These reach the user as a TOAST — setShape
  // surfaces the server's error verbatim — so without these keys a Norwegian admin got an
  // English sentence at the one moment the app is telling them no. English side is
  // server/src/index.js's SECOND_USER_REFUSAL / shapeSwitchRefusal verbatim; the count in
  // the second one is interpolated server-side, so only the fixed prefix can be translated
  // here — see the note in the review commit.
  'a vault belongs to one person, so the personal shape allows exactly one user (DD-006): there is no answer to whose daily note a second person’s hours would land in. Switch to the team shape to add users.':
    'et hvelv tilhører én person, så den personlige formen tillater nøyaktig én bruker (DD-006): det finnes ikke noe svar på hvilket dagsnotat en person nummer to sine timer skulle havne i. Bytt til lagform for å legge til brukere.',
  // SB-057 task 8: the quarantine surface. The English side of every reason key is
  // TT.vaultQuarantineText's text VERBATIM (shared/core.js) — same discipline as the capability
  // refusals above: the CLAIM must match, not the bytes, and a reason this map does not know falls
  // back to the generic line rather than rendering blank (SB-090 will move reason names).
  //
  // None of these say the hours were corrupted, in either language. Two of the commonest reasons
  // are not damage at all — an adopted note's missing digest (SB-091 rider 3), and a table editor
  // reflowing cell padding (SB-080) — and crying wolf about someone's hours is the worse error.
  'Notes paused': 'Notater satt på pause',
  paused: 'satt på pause',
  'Time Turtle cannot prove it wrote this block, so it has stopped writing to this note.':
    'Time Turtle kan ikke bevise at den skrev denne blokken, så den har sluttet å skrive til dette notatet.',
  'Time Turtle refused this note and did not say why in words this version knows.':
    'Time Turtle avviste dette notatet og forklarte det ikke med ord denne versjonen kjenner.',
  'the Time Log heading is not in this note.': 'Time Log-overskriften finnes ikke i dette notatet.',
  'this note uses Windows line endings, which Time Turtle will not rewrite.':
    'dette notatet bruker Windows-linjeskift, som Time Turtle ikke skriver om.',
  'this note has more than one Time Log heading, so nothing can say which is the day’s.':
    'dette notatet har mer enn én Time Log-overskrift, så ingenting kan si hvilken som er dagens.',
  'the block has no revision line, and its contents are not ones Time Turtle can describe.':
    'blokken har ingen revisjonslinje, og innholdet er ikke noe Time Turtle kan beskrive.',
  'the revision line is there but Time Turtle cannot read it — its short fingerprint is damaged.':
    'revisjonslinjen er der, men Time Turtle kan ikke lese den — det korte fingeravtrykket er skadet.',
  'the revision line sits in a later section, so the block has no end Time Turtle trusts.':
    'revisjonslinjen ligger i en senere seksjon, så blokken har ingen slutt Time Turtle stoler på.',
  'the block has more than one revision line.': 'blokken har mer enn én revisjonslinje.',
  'there is no table under the heading.': 'det finnes ingen tabell under overskriften.',
  'there is something under the heading that is not part of the table.':
    'det står noe under overskriften som ikke er en del av tabellen.',
  'the block’s fingerprint does not match the table it labels. Often this is only a table editor reflowing the spacing; it can also mean another machine’s edit was merged in.':
    'blokkens fingeravtrykk stemmer ikke med tabellen det merker. Ofte er dette bare en tabellredigerer som endrer mellomrommene; det kan også bety at en endring fra en annen maskin er flettet inn.',
  'the table has a column Time Turtle does not know.': 'tabellen har en kolonne Time Turtle ikke kjenner.',
  'the table has the same column twice.': 'tabellen har samme kolonne to ganger.',
  'a row has a different number of cells than the header.': 'en rad har et annet antall celler enn overskriftsraden.',
  'a Time cell is not one Time Turtle can read.': 'en Time-celle er ikke en Time Turtle kan lese.',
  'a Bill cell is neither a check mark nor blank, and that cell decides money.':
    'en Bill-celle er verken et hakemerke eller tom, og den cellen avgjør penger.',
  'what Time Turtle would write here is something it could not read back.':
    'det Time Turtle ville skrevet her er noe den ikke kunne lest tilbake.',
  'this note went back to an earlier revision with contents Time Turtle did not write — a restore from history, or another editor.':
    'dette notatet gikk tilbake til en tidligere revisjon med innhold Time Turtle ikke skrev — en gjenoppretting fra historikken, eller en annen redigerer.',
  'this note’s revision is older than the one Time Turtle recorded, and Time Turtle has no record of it — so it cannot tell an out-of-date copy from a deliberate restore.':
    'revisjonen i dette notatet er eldre enn den Time Turtle har notert, og Time Turtle har ingen oppføring av den — så den kan ikke skille en utdatert kopi fra en bevisst gjenoppretting.',
  // PLAN-017 task 1: the catalog note's own refusals. They reach the same surface as the daily
  // ones and follow the same rule — the CLAIM matches the English in shared/core.js, not the bytes.
  'a Rate or Rounding cell is not a number Time Turtle can read, and that cell decides money.':
    'en Rate- eller Avrundingscelle er ikke et tall Time Turtle kan lese, og den cellen avgjør penger.',
  'a Billable or Archived cell is neither a check mark nor blank.':
    'en Fakturerbar- eller Arkivert-celle er verken et hakemerke eller tom.',
  'a row has no id, so nothing can refer to it or rewrite it.':
    'en rad har ingen id, så ingenting kan vise til den eller skrive den om.',
  'two rows in this section carry the same id, so the second one would be invisible.':
    'to rader i denne seksjonen har samme id, så den andre ville vært usynlig.',
  'a project names a client this note does not list, which would make every rate on it resolve to nothing.':
    'et prosjekt viser til en kunde dette notatet ikke lister opp, noe som ville gjort at hver rate på det ikke fant noen verdi.',
  'the sections of this note carry different revision numbers, so part of it was written by something other than Time Turtle.':
    'seksjonene i dette notatet har ulike revisjonsnumre, så deler av det er skrevet av noe annet enn Time Turtle.',
  'Time Turtle was asked for a section of this note that does not exist.':
    'Time Turtle ble spurt om en seksjon i dette notatet som ikke finnes.',
  // SB-098 item 4: the first-run question (ShapeChoice.tsx). SHAPE LANGUAGE IN BOTH LANGUAGES —
  // never `sqlite`, never `vault` as an engine name. DD-015's point is that an install chooses
  // what it IS and the storage falls out of that, and someone opening Time Turtle for the first
  // time can answer "mine or my company's" without knowing either word.
  //
  // 'Hvelv' is already this surface's established Norwegian for the Obsidian vault (see 'Vault'
  // below and 'Hvelvmappe'), so the closing line points at the section the answer can be changed
  // in using the name that section actually carries in the sidebar.
  'Whose hours will this Time Turtle keep?': 'Hvem sine timer skal denne Time Turtle holde styr på?',
  'My own Obsidian-backed timesheet': 'Min egen Obsidian-baserte timeliste',
  'One person, no sign-in. Your Obsidian vault keeps the hours — Time Turtle writes them into your daily notes and reads back the edits you make there.':
    'Én person, ingen innlogging. Obsidian-hvelvet ditt holder timene — Time Turtle skriver dem inn i dagsnotatene dine og leser tilbake endringene du gjør der.',
  // SB-153, ruled by Terje: `My company’s` → `Team`, matching the word Settings → Vault has always
  // used for this value, and the Norwegian follows the same rule — `Lag` is what the Settings
  // toggle says, so the two surfaces stop naming one value with two words in either language.
  //
  // AND THE SQLITE SENTENCE, which is the bigger half of that ruling. It deliberately overrides
  // this block's own "never `sqlite`" instruction — see the rewritten comment in ShapeChoice.tsx
  // for his reasoning. `SQLite-database` is a compound of a product name and a Norwegian word,
  // which is the shape the `Markdown mirror` note above allows: the English word names the thing,
  // the Norwegian describes it. The word being avoided there is a TERM welded together, not a
  // product name used as itself.
  'Several people, each signing in, with roles and a review step before hours are invoiced. The hours live in Time Turtle’s own SQLite database, and every save is mirrored to markdown.':
    'Flere personer som logger inn hver for seg, med roller og et godkjenningssteg før timene faktureres. Timene bor i Time Turtles egen SQLite-database, og hver lagring speiles til markdown.',
  'Asked once. You can change the answer later under Settings → Vault.':
    'Spørsmålet stilles én gang. Du kan endre svaret senere under Innstillinger → Hvelv.',
  // DD-024 / SB-140: the vault step. It is the screen that decides whether the install a person was
  // just sold actually reads and writes their vault, so it says what it will do with the answer.
  'Which vault keeps these hours?': 'Hvilket hvelv skal holde disse timene?',
  'not on this machine right now': 'ikke på denne maskinen akkurat nå',
  'Time Turtle will write your hours into': 'Time Turtle skriver timene dine inn i',
  'and read back the edits you make there. You can change any of this later under Settings → Vault.':
    'og leser tilbake endringene du gjør der. Du kan endre alt dette senere under Innstillinger → Hvelv.',
  'Keep my hours in this vault': 'Hold timene mine i dette hvelvet',
  '← Back to the question': '← Tilbake til spørsmålet',
  // The two refusals this flow can reach, added by PLAN-016's end-gate review — without them the
  // ONE string a Norwegian could meet on the whole first run was the error, on the screen where a
  // person is most likely to be wrong. The path is appended by the client, which sent it, so this
  // key is the fixed half only (the same split the interpolated server refusals above use).
  'There is no folder at': 'Det finnes ingen mappe på',
  // The English side is server/src/index.js's FIRST_RUN_CLOSED VERBATIM — same discipline as the
  // capability refusals at the top of this file. If you edit one, edit the other in the same commit.
  'the first run is over: this install has already answered what it is':
    'førstegangsoppsettet er over: denne installasjonen har allerede svart på hva den er',
  // DD-024 clause 3 / SB-159: the demo step. Opt-in, off by default, and the button says which of
  // the two things it is about to do (DD-018 ruling 5) — never `OK`, which would make a person
  // re-read the checkbox to find out what they just agreed to.
  'Start with something in it?': 'Starte med noe i den?',
  'Add a few example clients, projects and a week of logged hours, so the app has something in it while you look around. You can delete them.':
    'Legg inn et par eksempelkunder, prosjekter og en uke med førte timer, så appen har noe i seg mens du ser deg om. Du kan slette dem.',
  'Add the example hours and start': 'Legg inn eksempeltimene og start',
  'Start with an empty timesheet': 'Start med en tom timeliste',
  // DD-024 clause 2: the starting-password note on the login screen. This plan MOVED the question
  // in front of the login, so a person who answers `Team` now meets a wall holding a credential
  // nobody showed them. The wall is this work's, so the note is too.
  'This install still has its starting password. Sign in as':
    'Denne installasjonen har fortsatt startpassordet sitt. Logg inn som',
  'and change it under Settings → Password. This note disappears when you do.':
    'og bytt det under Innstillinger → Passord. Denne meldingen forsvinner når du gjør det.',
  Vault: 'Hvelv',
  'Instance shape': 'Instansform',
  Team: 'Lag',
  Personal: 'Personlig',
  'instance shape: ': 'instansform: ',
  'the server pins the instance shape (TT_SHAPE_LOCK) — change it in the server environment.':
    'serveren har låst instansformen (TT_SHAPE_LOCK) — endre den i servermiljøet.',
  'A team install keeps SQLite as the source of truth and mirrors every save to markdown. A personal install is one person, with an Obsidian vault as the source of truth instead.':
    'En laginstallasjon har SQLite som fasit og speiler hver lagring til markdown. En personlig installasjon er én person, med et Obsidian-hvelv som fasit i stedet.',
  'The personal shape is not finished: the markdown mirror is off (the files it wrote are retired), committing is off until weekly notes land, and markdown paste-back is off. Daily notes DO sync — hours you log here are written into them, and edits made elsewhere are read back.':
    'Den personlige formen er ikke ferdig: markdown mirror er av (filene den skrev er pensjonert), innsending er av til ukenotater kommer, og markdown-tilbakeliming er av. Dagsnotatene synkroniseres — timer du fører her skrives inn i dem, og endringer gjort andre steder leses tilbake.',
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
  // SB-134: the sidebar's settled state under `personal`, where the markdown mirror is off and
  // the vault is the storage — `synced → md` claimed a write that does not happen there. Kept as
  // ONE key rather than composing `synced` with a bare `vault`: `→ md` is a file-format token
  // that survives translation, `hvelv` is a word, and 'Hvelv' is already this surface's
  // established Norwegian for the Obsidian vault (see the `Vault` key above).
  'synced → vault': 'synkronisert → hvelv',
  'offline — retrying': 'frakoblet — prøver igjen',
  'someone else saved first — reloaded': 'noen andre lagret først — hentet på nytt',
  // SB-034: admin cross-user edit hit a stale-write 409 — the sheet was reloaded fresh.
  'This timesheet changed while you were editing — reloaded. Re-apply your correction.':
    'Denne timelisten ble endret mens du redigerte — hentet på nytt. Gjør korrigeringen på nytt.',
  saved: 'lagret',
  'Saved to server + markdown mirror': 'Lagret til server + markdown mirror',
  'Mirror folder': 'Speilmappe',
  'markdown mirror failed: ': 'markdown mirror feilet: ',
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
