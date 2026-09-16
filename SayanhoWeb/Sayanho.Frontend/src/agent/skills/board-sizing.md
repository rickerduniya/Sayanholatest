---
name: board-sizing
description: How to count and size SPN DB, HTPN and VTPN distribution boards from the placed loads. Load during Phase 4 of the design workflow.
appliesTo: layout+sld
---

# Distribution Board Sizing

Count from what you have actually placed. Call `layout_get_placed_components` and
`layout_get_load_summary` first — do not size from your earlier intentions, which
may not match what the tools accepted.

## The distribution chain

```
Source
  └── VTPN            (only when more than one HTPN is needed)
        └── HTPN      (feeds SPN DBs + every dedicated appliance circuit)
              ├── SPN DB          (feeds Point Switch Boards + 5A boards)
              │     ├── Point Switch Board ──> lights, fans, call bell
              │     └── Avg. 5A Switch Board
              ├── AC Point        (dedicated)
              └── Geyser Point    (dedicated)
```

## Step 1 — Count SPN DB ways

An SPN DB's Way property is written `2+N`, where N is the number of single-phase
outgoing ways. Valid values from the database:

`2+2`, `2+4`, `2+6`, `2+8`, `2+10`, `2+12`, `2+14`, `2+16`, `2+18`

Ways needed on the SPN side:

```
spnWaysNeeded = (number of Point Switch Boards) + (number of Avg. 5A Switch Boards)
```

Add **20–25 % spare capacity**, then round **up** to the next valid Way value.
Spare ways are standard practice and cost nothing now; retrofitting a bigger
board later costs a rewire.

Example: 5 Point Switch Boards + 4 5A boards = 9 ways. 9 × 1.25 = 11.25 → choose
`2+12`.

## Step 2 — Decide how many SPN DBs

- One SPN DB can serve up to 18 ways (`2+18`). Beyond that, add another.
- Prefer a second SPN DB over a single maxed-out one when the dwelling has
  clearly separate zones (e.g. two floors, or a separate guest wing). Shorter
  final circuits mean less voltage drop.
- For a typical 2–3 bedroom flat, one SPN DB is correct.

Set the Way property when you create the SLD item, via `add_item_to_diagram`'s
`properties` argument or `set_item_properties` afterwards. Then call
`get_item_property_options` if a value is rejected — do not substitute a
different value on your own.

## Step 3 — Count HTPN ways

HTPN is a three-phase board with per-phase outgoing ways. Valid Way values:

`4`, `6`, `8`

Its outgoing connection point keys are phase-suffixed, three sets of `Way`:

```
out1_Red Phase … outN_Red Phase
out1_Yellow Phase … outN_Yellow Phase
out1_Blue Phase … outN_Blue Phase
```

So a Way-4 HTPN has 12 usable outgoing ways in total (4 per phase).

Ways needed:

```
htpnWaysNeeded = (number of SPN DBs)
               + (number of AC Points)
               + (number of Geyser Points)
```

Divide across three phases and round up:

```
wayPerPhase = ceil(htpnWaysNeeded / 3)
```

Then round `wayPerPhase` up to 4, 6 or 8. If it exceeds 8, you need more than one
HTPN.

Example: 1 SPN DB + 3 AC Points + 2 Geyser Points = 6 ways.
ceil(6 / 3) = 2 → round up to Way `4`. One HTPN, Way 4.

## Step 4 — Balance the phases

Distribute HTPN outgoings across R, Y and B so the connected load per phase is
within roughly 10 % of even. Practical approach:

1. Sort the loads you must feed by wattage, descending.
2. Assign each in turn to whichever phase currently carries the least load.
3. The SPN DB is single-phase and typically the largest single block — assign it
   first, then balance the appliances around it.

Verify with `get_phase_balance` after wiring, and report the result.

## Step 5 — VTPN, only if needed

A VTPN is only justified when you need **two or more HTPNs**. Valid Way values:

`4`, `6`, `8`, `12`

```
vtpnWaysNeeded = number of HTPNs   (+ 25 % spare, rounded up to a valid value)
```

For a single-HTPN dwelling, **do not place a VTPN**. Connect Source → HTPN
directly (optionally through a Main Switch if the user wants isolation). Adding an
unnecessary VTPN is a real cost and a common LLM overreach.

## Step 6 — Multi-storey
For a multi-floor building:

- One SPN DB per floor, minimum.
- One HTPN per floor if each floor's way count justifies it; otherwise one HTPN
  serving several floors.
- A VTPN at the service entry distributing to the per-floor HTPNs.
- Use a separate SLD sheet per floor and link them with Portal items so the
  cross-sheet feed is explicit.

## Step 7 — Configure the source (Type, Voltage, Frequency)

A freshly built Source symbol defaults to 3-phase / 415 V / 50 Hz. That default
is wrong for a small single-phase dwelling — **you must set it explicitly**
with `set_item_properties` (find the Source item id from the `layout_build_sld`
result or `get_diagram_state_json`) every time you design a supply. If a value
is rejected, call `get_item_property_options` for the Source and retry — do not
substitute a different value on your own.

**Decision rule (Indian supply practice):**

1. If the design contains any HTPN or VTPN → the supply is **3-phase**.
   (Those are three-phase boards; a single-phase source cannot feed them.)
2. Else if total connected load (`layout_get_load_summary`) exceeds ~5 kW →
   **3-phase**. DISCOMs move larger domestic loads to three-phase supply.
3. Otherwise → **1-phase**.

**Exact values to write — Type and Voltage are coupled, Frequency is fixed:**

| Supply | Type | Voltage | Frequency |
|---|---|---|---|
| 1-phase | `1-phase` | `230 V` | `50 Hz` |
| 3-phase | `3-phase` | `415 V` | `50 Hz` |

- Frequency is **always `50 Hz`**. India uses 50 Hz exclusively — never write
  `60 Hz` under any circumstances.
- Voltage follows Type mechanically: `1-phase` → `230 V`, `3-phase` → `415 V`.
  Never use `440 V` for the supply (legacy motor nameplate rating, not a
  supply voltage here).

Example: `set_item_properties` with itemId of the Source and properties
`{"Type": "3-phase", "Voltage": "415 V", "Frequency": "50 Hz"}`.

State the choice and its reason in your report, e.g. "Source set to 3-phase /
415 V / 50 Hz — HTPN present and 8.2 kW connected load."

## Positioning on the floor plan

- `spn_db`: corridor or hallway wall, central to the rooms it serves.
- `htpn_db`: near the service entry, on a wall.
- `vtpn_db`: at the service entry.
- `source`: at the service entry point, upstream of everything.

All are wall-mounted: place with `purpose: "wall"` so they snap flush.

## Report

State the schedule explicitly, e.g.

> 1 × SPN DB (2+12) feeding 5 Point Switch Boards and 4 5A boards, 3 spare ways.
> 1 × HTPN (Way 4) feeding the SPN DB, 3 AC points and 2 geysers. R 4.2 kW /
> Y 3.9 kW / B 4.1 kW. No VTPN needed.

The user needs to be able to check your arithmetic.
