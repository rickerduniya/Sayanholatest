---
name: connection-rules
description: Exact wiring rules for the single-line diagram — what connects to what, which point keys to use, and the order to do it in. Load during Phase 5 of the design workflow.
appliesTo: sld
---

# SLD Connection Rules

## Before you connect anything

Call `get_diagram_state_json` and read the real `connectionPointKeys` for every
item you are about to touch. Point keys are **not** guessable:

- A `Point Switch Board` exposes `in`, `out1` … `out9`.
- An `SPN DB` exposes `in`, `out1` … `outN` where N comes from its Way (`2+N`).
- An `HTPN` exposes `in` plus phase-suffixed outputs:
  `out1_Red Phase`, `out2_Red Phase`, …, `out1_Yellow Phase`, …, `out1_Blue Phase`, …
- A `VTPN` exposes `in`, `out1` … `outN`.
- A `Source` exposes only `out`.
- A `Main Switch` exposes `in`, `out`.
- A `Change Over Switch` exposes `in1`, `in2`, `out`.
- Every end load (`Bulb`, `Tube Light`, `Ceiling Fan`, `Exhaust Fan`, `AC Point`,
  `Geyser Point`, `Call Bell`) exposes only `in`.
- An `Avg. 5A Switch Board` exposes only `in`.

Keys are case-sensitive and vary with the item's properties. If you change a
board's Way, its output keys change — re-read the state.

## The one inviolable rule

**One connector per connection point key.** Never attach two connectors to the
same key on the same item. If you run out of outputs, add another board; do not
double up. `connect_items` will reject a duplicate, and if you find yourself
retrying, the answer is a new board, not a different key.

## Single-phase vs 3-phase (enforced by `connect_items`)

`connect_items` rejects a single→3-phase or 3-phase→single mismatch with an
error that names the correct feeders — read it and pick the suggested feeder
instead of retrying. Rules per connection point (`unknown`/unconfigured stays
permissive so half-configured boards don't deadlock):

- OUT (what the point supplies): Source `Type` (`1-phase` = single,
  `3-phase` = three); HTPN ways always single; VTPN always 3-phase; SPN DB
  always single; Busbar per-tap `Phase` (`R/Y/B` = single, `ALL` = 3-phase;
  `Bars: 2` = whole chamber single); LT Panel per-outgoing `Pole`
  (`DP/SP/1P/2P` = single, `TP/FP/TPN/3P/4P` = 3-phase); Main/Change-Over
  Switch `Voltage` (`DP/230V` = single, `TPN/FP/415V` = 3-phase); switch
  boards/loads single; Portal/Text unknown.
- IN (what the point requires): HTPN incomer always 3-phase (4-pole FP);
  VTPN 3-phase; SPN DB single; Busbar by `Bars` (`2` = single, else 3-phase);
  LT Panel per-section `Incomer{N}_Pole/Type`; switches by `Voltage`; end
  loads and switch boards single.
- Changing a wired board's `Type`/`Bars`/`Voltage`/`Pole` (via
  `set_item_properties` / `update_item_fields`) is likewise blocked with an
  error listing the now-incompatible connections — rewire first.

## Connection map

Work strictly downstream-to-upstream **within each group**, but build the groups
in this order so that every parent exists before its children need it.

### 1. Loads → Point Switch Board

Lights, fans and the call bell connect to a Point Switch Board output.

```
Bulb.in        ← PointSwitchBoard.outN
Tube Light.in  ← PointSwitchBoard.outN
Ceiling Fan.in ← PointSwitchBoard.outN
Exhaust Fan.in ← PointSwitchBoard.outN
Call Bell.in   ← PointSwitchBoard.outN
```

Use the board **in the same room** as the load. Fill outputs `out1` upward, one
load per output. A board has 9 outputs; a room needing more needs a second board.

Loads never connect directly to an SPN DB.

### 2. Point Switch Board → SPN DB

```
PointSwitchBoard.in ← SPN_DB.outN
```

One board per SPN DB way.

### 3. Avg. 5A Switch Board → SPN DB

```
Avg5ASwitchBoard.in ← SPN_DB.outN
```

The 5A board represents a whole socket circuit, so it takes its own SPN DB way.
It does **not** hang off a Point Switch Board.

### 4. Dedicated appliances → HTPN

AC and geyser points are dedicated circuits and bypass the SPN DB entirely.

```
AC Point.in     ← HTPN.outN_<Phase>
Geyser Point.in ← HTPN.outN_<Phase>
```

Choose the phase to keep the three phases balanced — see `board-sizing`.

### 5. SPN DB → HTPN

```
SPN_DB.in ← HTPN.outN_<Phase>
```

The SPN DB is single-phase: it takes one phase from the HTPN. It is usually the
largest single block, so assign its phase first and balance the appliances around
it.

### 6. HTPN → VTPN (only with multiple HTPNs)

```
HTPN.in ← VTPN.outN
```

With a single HTPN, skip the VTPN entirely.

### 7. Top of the chain

With a VTPN:
```
VTPN.in ← Source.out
```

Without a VTPN:
```
HTPN.in ← Source.out
```

Optionally insert isolation if the user wants it:
```
Main Switch.in ← Source.out
HTPN.in        ← Main Switch.out
```

## Material type

`connect_items` takes `materialType`:

- `Wiring` — final circuits: board output to an end load.
- `Cable` — feeders: Source→VTPN, VTPN→HTPN, HTPN→SPN DB, HTPN→AC/Geyser,
  SPN DB→Point Switch Board, SPN DB→5A board.

If unsure, `Cable` for anything feeding a board, `Wiring` for anything feeding a
fitting.

## Recommended execution order

Connect parents before children so you never hold a dangling reference:

1. Source → (Main Switch) → VTPN or HTPN
2. HTPN → SPN DB(s)
3. HTPN → AC Points, Geyser Points
4. SPN DB → Point Switch Boards
5. SPN DB → 5A boards
6. Point Switch Boards → lights, fans, call bell

Batch with `apply_sld_operations` where you can — one call per group above is a
good granularity. Set `stopOnError: true` so a bad key does not cascade.

## After wiring

1. `validate_diagram` — structural check.
2. `analyze_diagram` — currents and totals.
3. `get_phase_balance` — confirm the three phases are within ~10 %.
4. `auto_arrange` — tidy the sheet into readable tiers.

Fix every error. Report every remaining warning; do not describe a diagram with
unfed loads as complete.

## Common mistakes to avoid

- Wiring a bulb straight to an SPN DB way. It goes via a Point Switch Board.
- Hanging the 5A board off a Point Switch Board. It takes its own SPN DB way.
- Putting an AC or geyser on a Point Switch Board. They are dedicated HTPN
  circuits.
- Using `out1` on an HTPN. HTPN outputs are always phase-suffixed.
- Adding a VTPN for a single-HTPN dwelling.
- Reusing a point key because the first attempt failed for another reason.
