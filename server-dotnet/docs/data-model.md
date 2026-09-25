# Target data model

The Postgres model for the ASP.NET Core server, designed in B0 on 24 September 2026. It is the target, not the current schema. How the current SQLite data and the HTTP API reach it is decided separately.

The decisions are on the board: DD-028 to DD-041. The words are in `pm glossary`. This file holds only the shape.

## Work and money

```mermaid
erDiagram
  company ||--o{ users : employs
  company ||--o{ clients : has
  clients ||--o{ projects : "orders (optional)"
  users ||--o{ assignments : "is on"
  projects ||--o{ assignments : staffs
  assignments ||--o{ assignment_rates : "prices from a date"
  assignments ||--o{ entries : "receives"
  users ||--o| running_timers : "may run"
  assignments ||--o{ running_timers : "is timed by"
  users ||--o{ task_templates : keeps
  assignments |o--o{ task_templates : "suggests"
  users ||--o{ segment_submits : submits
  users ||--o{ segment_approvals : "is approved in"

  company {
    uuid id PK
    text name
    text currency "one per company"
    text time_zone "for today and the timer only, DD-036"
    text language "default for users"
    text preset_code "for example no"
    int preset_version "stamped at setup, DD-028"
    int bank_upper_min "optional warning, DD-041"
    int bank_lower_min "optional warning, DD-041"
  }
  users {
    uuid id PK
    uuid company_id FK
    text email UK
    text name
    text role "admin or employee"
    text password_hash
    text language "null is the company default"
    timestamptz deactivated_at "never deleted, DD-037"
  }
  clients {
    uuid id PK
    uuid company_id FK
    text name
    bool archived
  }
  projects {
    uuid id PK
    uuid company_id FK
    uuid client_id FK "null for internal work"
    text code UK "renamable, DD-033"
    text name
    bool archived
  }
  assignments {
    uuid id PK
    uuid user_id FK
    uuid project_id FK
    timestamptz ended_at "no dates on the work, DD-032"
  }
  assignment_rates {
    uuid id PK
    uuid assignment_id FK
    date valid_from
    numeric rate "the only rate, DD-031"
  }
  running_timers {
    uuid user_id PK "one per person, DD-051"
    uuid assignment_id FK
    text label
    timestamptz started_at
  }
  entries {
    uuid id PK
    uuid assignment_id FK "never null, DD-033"
    uuid user_id FK "must match the assignment"
    date entry_date "local, no time zone, DD-036"
    int minutes "not null, DD-051"
    time start_time "optional"
    time end_time "optional"
    text label "copied from a template"
    text note
    bool billable "admin only, DD-034"
    bool edited_by_admin
    numeric frozen_rate "set by the approval, DD-029"
    numeric frozen_amount "set by the approval, DD-029"
  }
  task_templates {
    uuid id PK
    uuid user_id FK
    uuid assignment_id FK
    text label
  }
  segment_submits {
    uuid user_id PK
    date segment_start PK
    timestamptz submitted_at "a withdraw deletes the row"
  }
  segment_approvals {
    uuid user_id PK
    date segment_start PK
    uuid approved_by FK
    timestamptz approved_at "a release deletes the row, DD-030"
    int norm_min "frozen"
    int bank_change_min "frozen"
  }
```

## Time bank and absence

```mermaid
erDiagram
  company ||--o{ calendar_rules : "changes the norm with"
  company ||--o{ absence_types : defines
  absence_types ||--o{ quota_limits : "is limited by"
  users ||--o{ work_schedules : "works by"
  users ||--o{ absences : "is away in"
  users ||--o{ absence_requests : asks
  users ||--o{ quota_limits : "may have its own"
  absence_types ||--o{ absences : "classifies"
  absence_requests |o--o{ absences : "creates when granted"
  users ||--o{ adjustments : "has"
  assignments |o--o{ adjustments : "bills money to"

  work_schedules {
    uuid id PK
    uuid user_id FK
    date valid_from
    int mon_min
    int tue_min
    int wed_min
    int thu_min
    int fri_min
    int sat_min
    int sun_min
  }
  calendar_rules {
    uuid id PK
    uuid company_id FK
    text name "for example Christmas Eve"
    text kind "fixed, easter_offset or once"
    int month "fixed"
    int day "fixed"
    int easter_offset "easter_offset, Good Friday is -2"
    date on_date "once"
    int max_min "cap on the norm, 0 is off, DD-049"
    date valid_from "DD-028"
  }
  absence_types {
    uuid id PK
    uuid company_id FK
    text name
    text effect "covers_norm, draws_bank or removes_norm"
    bool needs_request "vacation yes, sick leave no"
    bool archived
  }
  quota_limits {
    uuid id PK
    uuid absence_type_id FK
    uuid user_id FK "null is the company limit, DD-050"
    int amount
    text unit "working_days, virkedager, calendar_days, occurrences or hours"
    text period "occurrence, calendar_year or twelve_months"
    date valid_from
  }
  absences {
    uuid id PK
    uuid user_id FK
    date absence_date
    uuid absence_type_id FK
    int minutes "null is the whole norm"
    uuid request_id FK "null for sick leave"
  }
  absence_requests {
    uuid id PK
    uuid user_id FK
    uuid absence_type_id FK
    date from_date
    date to_date
    text state "asked, granted or refused"
    uuid decided_by FK
    timestamptz decided_at
    text note
  }
  adjustments {
    uuid id PK
    uuid user_id FK
    date adjustment_date
    text kind "opening, payout, overtime, correction or money"
    int minutes "time bank, or null"
    numeric amount "money, or null"
    uuid assignment_id FK "set when amount is set"
    text note
    uuid created_by FK
    timestamptz created_at
  }
```

## Rules the diagram cannot show

- **Money is `numeric`, never a floating-point type.** An amount is rounded to whole øre once, at the approval.
- **No `ON DELETE CASCADE` anywhere.** Every foreign key to `users` uses `ON DELETE RESTRICT` (DD-037).
- **An entry's `user_id` must match its assignment.** A composite foreign key `(assignment_id, user_id)` to `assignments (id, user_id)` lets Postgres check it. The column exists for the index on `(user_id, entry_date)`.
- **A segment is named by its first date.** Segments never overlap, so `segment_start` is unique for each person. It replaces today's text key `2026-W09-2026-03`.
- **One active assignment for each person and project.** A partial unique index on `(user_id, project_id) WHERE ended_at IS NULL`.
- **Nothing derived is stored for a period that is not approved.** The norm, the balance and the amounts are computed. The approval freezes them (DD-029).
- **An adjustment holds minutes or money, never both.** A check constraint enforces it.

## Questions from part 1, answered in part 2

1. **Part days.** Decided in DD-049: a rule caps the norm (`max_min`), and the Norway preset gives a half day 240 minutes.
2. **Quota conditions for a person.** Decided in DD-050: a quota limit row may name one person and then replaces the company limit. No birth date is stored.
3. **Where the running timer lives.** Decided in DD-051: its own table, one row per person, and `entries.minutes` is not null.
4. **Language.** Decided 25 Sep: the company sets a default, and `users.language` overrides it for one person. Easy to change, so not a board decision.

## The bridge from the Node server

Decided in B0 part 2 on 24 and 25 Sep 2026.

| Decision | What it says                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------- |
| DD-042   | One route for each action, not the whole-state `PUT /api/state`                                    |
| DD-043   | The C# types are the contract. The client's TypeScript types are generated from `/openapi/v1.json` |
| DD-044   | The .NET server starts on an empty Postgres database. No import from SQLite                        |
| DD-045   | One switch day in the same namespace. A failed switch is fixed forward                             |
| DD-046   | xUnit tests through `WebApplicationFactory`. The Node tests go with `server/`                      |
| DD-047   | Tests run on a Postgres that Testcontainers starts for each run                                    |
| DD-048   | EF Core with the Npgsql provider, and SQL by hand only where LINQ cannot express the query         |
| DD-052   | ASP.NET Core cookie authentication, without Identity. Data Protection keys in Postgres             |
| DD-053   | Every primary key is a UUID v7 that EF Core makes in .NET. Foreign keys are `uuid` too             |

## Deferred

A currency for each client. Billed time set by the admin (DD-035). Erasure of personal data (DD-037). Partitioning `entries` by date (DD-037). Export formats (DD-038).
