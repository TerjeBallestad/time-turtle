# Time Turtle — vault vocabulary

The words Time Turtle uses for the things it reads and writes inside Terje's Obsidian vault.

**Temporary home.** The real glossary is being built on the PM board; this file is a holding pen so
the terms settled in a grill are written down somewhere other than a code comment. Fold it into the
PM glossary and delete it.

## Language

**Block**:
The anchored region the shared locator returns — one `##` heading, one table, one
`` `revision: N · digest` `` line, ending at the next heading of any level.
_Avoid_: Region, marker, `%%tt%%` block

**Anchor**:
The two lines that bound a block and make it writable: the heading above it, the revision line
below it.
_Avoid_: Marker, delimiter, fence

**Section**:
A catalog block occupying a named slot in the registry — `Clients`, `Projects`, `Task templates`,
`Settings`. Every section is a block; not every block is a section.
_Avoid_: Table, sub-block

**Catalog**:
The one note holding state that is not a day: clients, projects, rates, task templates, and the
settings the vault owns. Four blocks in one file.
_Avoid_: Config note, index note

**Revision**:
The counter a block carries. One catalog-wide counter is written identically into all four
sections, because the catalog is the unit of change and the section is not.
_Avoid_: Version, rev number, generation

**Digest**:
The per-block hash of a table's payload, carried in the revision line. Per block, never per file —
a file-level digest would leave a rewritten rate undetectable.
_Avoid_: Checksum, hash (which is the whole-file hash the sync index stores)

**Quarantine**:
A verdict: this block cannot be read with confidence, so it is surfaced to a human and never
written. A refusal, not an error.
_Avoid_: Corrupt, invalid, broken

**Adoption**:
Time Turtle writing a revision anchor into a region **a human authored**, claiming existing content
as its own. Applies to daily notes; never to the catalog.
_Avoid_: Claiming, taking over, migration

**Backfill**:
Time Turtle emitting a canonical catalog section the note lacks, at the note's current revision.
Adds a region that did not exist and touches no line anyone else wrote — which is what makes it not
adoption.
_Avoid_: Adoption, healing, upgrade
