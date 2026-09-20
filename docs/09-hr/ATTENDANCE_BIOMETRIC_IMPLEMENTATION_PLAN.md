# Attendance & Biometric — implementation plan

What already existed, what this adds, and the rules that decided each choice.

## What was already here

- `BiometricPunch` — raw device evidence, unique on `(deviceId, deviceUserId,
  punchedAt)`, so a replayed file is harmless. Never edited, never deleted.
- `AttendanceDay` — one derived day per employee, correctable, with a reason.
- `importPunches`, `deriveAttendance`, `adjustAttendance` in `src/lib/payroll.ts`.
- `deriveDay` in `src/core/payroll.ts` — first in, last out, worked minutes.
- Payroll that reads attendance, and `availableMinutesFromAttendance` feeding
  the factory's capacity.

The foundation was right and is kept. What it lacked was everything between a
device file and a day somebody can defend: no shifts, so nothing to be late
against; no import record, so no answer to "where did this punch come from";
no way to resolve an unknown badge; no lock, so payroll could be prepared on
attendance still under dispute.

## What this adds

### Shifts (`Shift`, `EmployeeShift`)

A shift is a reusable rule, not a property of an employee: start and end,
working days, break, grace, overtime threshold, and whether it crosses
midnight. Employees are assigned one from an effective date, so a schedule
change does not rewrite what last month was judged against.

Overnight is stored as a flag rather than inferred from `end < start`, because
a shift ending exactly at its start time is a twenty-four hour shift, and
guessing between the two silently halves or doubles somebody's day.

### Import batches (`AttendanceImport`, `AttendanceImportRow`)

Every import keeps who ran it, when, the device, the original filename, the
column mapping used, the counts, and every row it refused with the reason.
Idempotency stays where it was — the unique index — so a second import of the
same file adds nothing and says so.

A batch is *previewed* before it is committed: the file is parsed, counted and
classified, and nothing is written until somebody confirms what they are
about to accept.

### Unknown badges

A punch whose badge matches no employee is stored with a null employee, as
before. It now appears in a queue where it can be linked to an employee; the
link writes the badge onto the employee, claims every orphan punch with that
badge, and re-derives the days those punches touch.

### Derivation (`src/core/attendance.ts`)

Pure, and Cairo-safe. The day a punch belongs to is decided in Cairo, not UTC:
a 01:00 punch belongs to the night shift that began the evening before, and a
23:30 punch on the 31st is not the 1st. The engine produces scheduled, worked,
break, late, early-leave and overtime-candidate minutes, and a status:

| status | means |
|---|---|
| `PRESENT` | in and out, within the grace period |
| `LATE` | in after grace |
| `EARLY_LEAVE` | out before the shift ends |
| `INCOMPLETE` | one punch, or an odd number — **never absence** |
| `ABSENT` | scheduled, no punch at all, and marked so by a person |
| `LEAVE` | approved leave |
| `OFF` | not a working day for this shift |
| `NEEDS_REVIEW` | anything the engine will not decide alone |

A day with one punch is `INCOMPLETE` and never reduces pay. Absence is a
judgement, so the engine proposes it and a person confirms it.

Re-derivation never touches a day that was corrected, approved or locked.

### Adjustments (`AttendanceAdjustment`)

Append-only. A correction records before, after, reason, who asked and who
approved. The day carries the current value; the adjustments carry how it got
there.

### Period lock (`AttendancePeriod`)

`OPEN → REVIEWED → LOCKED`. A month gets its period row the moment anybody
derives a day in it, and that row is what turns the discipline on:

- **Period exists and something is unresolved** — payroll preparation is
  refused, naming how many days are outstanding.
- **Period exists, nothing unresolved, not yet locked** — prepared with a
  warning that the figures can still move.
- **No period row at all** — warned, not blocked. Those are months worked
  before this existed, and freezing payroll out of them would apply a rule to
  people who never had the chance to follow it.

Unapproved overtime warns separately, because it is worked and unpaid.

Locking is refused while anything is unresolved. After it, an ordinary
correction is refused outright; a post-lock change is a `POST_LOCK` adjustment
requiring the lock capability, and it says on its face that it came after.

## Permissions

| capability | who |
|---|---|
| `attendance:view` | HR, production, finance approver, owner |
| `attendance:import` | HR, owner |
| `attendance:review` | HR, owner |
| `attendance:correct` | HR, owner |
| `overtime:approve` | HR, owner |
| `attendance:lock` | **finance approver**, owner — not HR |

A production supervisor sees who is on the floor and who is late. Salary stays
behind `salary:view`, which they do not have, and no attendance screen shows a
figure that could be worked back to one.

`attendance:correct` and `attendance:lock` are a segregated pair, which is why
HR does not hold the lock: whoever spent the month correcting days does not
also declare them final. Sealing sits with the party that has to rely on the
figures — the same one that approves the payroll built from them. The repo
enforces this statically, and the pair was added to `SEGREGATED_DUTIES`.

## Deliberate limits

- **File import only.** The importer takes a parsed table and a mapping; where
  the rows came from is not its business. A future device or API connector
  produces the same rows and reuses everything downstream.
- **No vendor is named anywhere.** Device identity is a string the operator
  gives, and the column mapping is data.

## What the importer assumes about a file

Nothing about a vendor, and as little as possible about anything else.

- **A delimited text file with a header row.** The delimiter is detected —
  comma, semicolon, tab or pipe — because these files come off devices
  configured by whoever installed them, and a semicolon export read as commas
  produces one column and a page of meaningless errors. Quoted fields are
  honoured; a byte-order mark is ignored.
- **Two columns are required**: a badge or user id, and a timestamp. Which
  ones they are is chosen on screen and kept with the batch. Direction and a
  raw payload column are taken when offered and needed by nothing.
- **Timestamps are the device's own wall-clock, in Cairo.** A reader knows
  nothing of offsets, so `2026-07-01 09:00` is 06:00 UTC in summer and 07:00 in
  winter; both are handled by asking the calendar rather than assuming a fixed
  offset. Accepted shapes: `YYYY-MM-DD HH:mm[:ss]`, the same with slashes or a
  `T`, and `DD/MM/YYYY HH:mm[:ss] [AM|PM]`. A date with no time is refused —
  it names a day, not a moment somebody arrived.
- **Day-first when ambiguous.** `03/04/2026` is the third of April. It is the
  convention here, and the alternative is silently moving a punch by months.
- **XLSX is not parsed.** A spreadsheet is a zip of XML and reading it needs a
  library; every device tested exports CSV or TXT, and a file saved as xlsx can
  be saved as CSV in one step. The parser takes a table, so adding a
  spreadsheet reader later changes one function and nothing else.

## What is not built

- **Live device sync.** There is no polling, no webhook, no vendor SDK. The
  import takes a parsed table and a column mapping, which is exactly what a
  device connector would produce, so the adapter is the only new part: pull the
  readings, shape them into rows, and call the same preview and commit. The
  batch record already has a device field and would hold the connector's name
  as readily as a filename.
- **Rosters and leave balances.** Leave is recorded on the day it affects.
  Entitlement, accrual and requests are a separate subject.
- **Breaks that are punched.** A break is a rule on the shift, not a pair of
  punches. Where somebody punches out and back in, the second pair is counted
  as worked time and the unpaid break still comes off — which is correct for a
  floor where the break is fixed and understates nothing.
