---
name: electrical-design-workflow
description: Master workflow for turning a calibrated floor plan into a complete electrical layout and matching single-line diagram. Load this first for any "design the electrics" request.
appliesTo: layout+sld
---

# Electrical Design Workflow

You are designing a real electrical installation for a building. Work in phases,
in order. Do not skip ahead: later phases depend on ids produced by earlier ones.

## Phase 0 — Establish the ground truth

1. `layout_list_floor_plans`
   - No plans → stop and tell the user to upload a floor plan. Do not invent one.
   - Multiple plans (multi-storey) → design each plan separately, ground floor
     first. Keep one SLD sheet per floor and name it after the floor.
2. `layout_get_plan_geometry`
   - If `isScaleCalibrated` is false, tell the user areas are unreliable and ask
     them to calibrate. You may continue if they insist, but say so in your
     summary. Never silently present area-derived counts as accurate.
   - If `roomCount` is 0, tell the user to run Detect Rooms. Without rooms you
     cannot place anything sensibly.
3. If the floor plan image is attached, compare it against the geometry you just
   read, before you name anything:
   - Does the room count match what you can see in the drawing?
   - Does any room in the tool data span what the drawing shows as two rooms?
     That means detection missed a wall.
   - Are there walls in the drawing with no counterpart in the geometry?

   If anything disagrees, report it plainly and ask the user to re-run Detect
   Rooms or draw the missing wall. The vector geometry is what the rest of the
   application uses, so designing around a detection error produces a drawing
   that is wrong everywhere except in your explanation of it.
4. Name the rooms. Detected plans give you `Room 1`, `Room 2` plus an OCR
   `detectedName` hint. If you have the image, read the actual label from the
   drawing — it is usually legible where OCR failed. Where there is no label,
   infer the purpose from fixtures visible in the drawing (WC and basin → toilet,
   sink and counter → kitchen, bed → bedroom). Commit all of them in **one**
   `layout_set_rooms_info` call, and say which rooms you inferred rather than read.

**Milestone: report the room list with areas, plus any detection discrepancies you
found, before placing anything.**

## Phase 1 — Place the loads

Loads first, boards second. The number and position of the loads determines how
many boards you need and where they go — doing it the other way round means
resizing boards later.

Per room, follow `load-placement` skill for quantities. For each room:

1. `layout_suggest_positions_batch` — ask for every purpose you need in one call:
   `[{roomId, purpose: "ceiling", count: 1}, {roomId, purpose: "wall", count: 4},
   {roomId, purpose: "external_wall", count: 1}]`. Cover several rooms in the same
   call. This is the most-called tool in a design run, and one call per purpose per
   room is the single biggest waste of turns.
2. `layout_place_components` with one batch per room (lights + fans together).

Ceiling-mounted: `ceiling_fan_point` only.
Wall-mounted: `bulb` and `tube_light` (**all lights go on walls, never the
ceiling** — see `load-placement` Section 2.1), `exhaust_fan` (bathrooms/kitchen,
**`purpose: "external_wall"` — boundary wall only, never a partition wall**),
`call_bell` (main entrance only, outside the entry door).

Batch aggressively. One `layout_place_components` call per room, not one call per
bulb.

Read the placement result. Each entry reports `roomId` and, when the point fell
outside every room, a `warning`. A component with `roomId: null` is missing from
per-room load totals — fix it there and then rather than at the end.

**Milestone: report placed load counts per room.**

## Phase 2 — Place the switch boards

1. Every room with lights or fans needs at least one `point_switch_board`.
   Position: `layout_suggest_positions` with `purpose: "beside_door"`, falling
   back to `purpose: "wall"` when the room has no door on record.
2. A Point Switch Board has **9 outputs (out1..out9)**. Each output feeds exactly
   one load. A room with more than 9 lights and fans needs a second board.
3. Place `avg_5a_switch_board` (5A socket board) in every habitable room —
   bedrooms, living, dining, kitchen, office. Not in bathrooms or toilets.
   Position on a wall, away from the wet area.

## Phase 3 — Place the dedicated-circuit appliances

These do **not** go through a Point Switch Board. They are dedicated circuits fed
straight from an HTPN way.

- `ac_point` — one per bedroom and living room. Place high on a **boundary
  (external) wall — never a partition wall**, using
  `purpose: "external_wall"`; prefer the boundary wall opposite the door.
- `geyser_point` — one per bathroom that has one. Place on the wall, near the
  ceiling, in the wet area.

## Phase 4 — Place the distribution boards

Read `board-sizing` skill and compute counts from actual placed items, not from
estimates. Then place, in this order:

1. `spn_db` — sized per `board-sizing`. Position centrally in the corridor or
   hallway, close to the rooms it serves.
2. `htpn_db` — feeds the SPN DBs and every dedicated appliance circuit. Position
   near the service entry.
3. `vtpn_db` — **only if you need more than one HTPN.** Feeds the HTPNs.
4. `source` — one per building, at the service entry point.

**Milestone: report the board schedule (type, way count, what each feeds) before
generating the SLD.**

## Phase 5 — Generate the schematic

> **The only way to create a schematic symbol for something on the floor plan is
> `layout_build_sld`.** Never use `add_item_to_diagram` for a device that exists
> in the layout. `add_item_to_diagram` creates a symbol with no link back to the
> floor plan, so:
> - the layout still reports the component as having no SLD symbol,
> - both views list the device in their "Unplaced" tray forever,
> - and the connections you draw between those symbols have no counterpart on the
>   floor plan.
>
> `add_item_to_diagram` is only for schematic-only items — a Portal, a Text Box,
> or an isolator the user asked for that has no place on the plan.

1. `layout_build_sld` — materializes every placed Layout component as an SLD
   symbol on the active sheet and returns `sldItemId` for each. It also adopts
   any symbols already sitting in the "Unplaced" tray. Nothing is wired yet.

   Read the result:
   - `createdCount` + `adoptedCount` — how many symbols now exist.
   - `sheetItemCount` — how many items the sheet holds in total.
   - `stillWithoutSymbol` — components it could not materialize. If this is
     present, say so; do not paper over it with `add_item_to_diagram`.

   If `sheetItemCount` is 0 after this call, something is genuinely broken. Report
   it and stop rather than hand-building a parallel schematic.

2. `get_diagram_state_json` — read the **actual** connection point keys. Never
   assume them. An SPN DB's outputs depend on its Way; an HTPN's output keys are
   phase-suffixed (`out1_Red Phase`).
3. Configure the Source's electrics per `board-sizing` Step 7 (`set_item_properties`:
   1-phase → 230 V, 3-phase → 415 V, Frequency always 50 Hz). Do this before
   wiring so downstream cable/phase reasoning uses the right supply.
3. Wire it up per the `connection-rules` skill, using `connect_items`. Batch with
   `apply_sld_operations`, one call per connection group.
4. `auto_arrange` to tidy the sheet.
5. `sld_auto_rate` — backend sizes breakers and cables from the network analysis
   and writes the ratings back (undo-safe). Run after wiring, before verifying.
   On failure, fix the connectivity it reports and retry — do not hand-edit
   ratings it refused to set.

## Phase 6 — Verify

1. `layout_validate` — catches loads with no symbol, loads fed by nothing,
   components outside every room, **schematic symbols with no Layout component**,
   and work left in either "Unplaced" tray.
2. `validate_diagram` — catches SLD structural problems. Note that it passes
   trivially on an empty sheet, so check `totalItems` too; "valid" and "empty" are
   not the same thing.
3. `analyze_diagram` — load and phase figures.
4. Fix every error. Report remaining warnings honestly rather than claiming
   success.

## Reporting

Finish with a short summary: rooms and areas, load counts, board schedule, total
connected load, and anything you could not do or had to assume. If the scale was
uncalibrated or rooms were undetected, say so — a confident-sounding design built
on a wrong scale is worse than an acknowledged gap.

## Hard rules

- Never guess a connection point key. Read it.
- Never connect two things to the same point key.
- Never place a component without a position from `layout_suggest_positions` or
  explicit user-supplied coordinates.
- Never create a schematic symbol for a floor-plan device with
  `add_item_to_diagram`. Only `layout_build_sld` produces linked symbols.
- If a tool returns an error, read it and adapt. Do not retry the identical call.
- If a tool returns something that contradicts what you can see, say so and
  investigate — do not route around it by building things a second way.
- Prefer batch tools. Tool turns are limited and the user is waiting.
- Fix your own mistakes instead of working around them. Full lifecycle powers:
  text labels — `layout_add_text` / `layout_update_text` / `layout_delete_text`
  on the plan, `add_text_to_diagram` (+ `set_item_properties`,
  `set_item_transform`, `delete_item_from_diagram`) on the schematic;
  remove misplaced devices with `layout_delete_component` /
  `delete_item_from_diagram`; remove wrong routes with
  `layout_delete_connection` (plan overlay) / `delete_connector` (schematic).

## When a tool result surprises you

A contradiction between two tools is information, not an obstacle. Report it and
work out which one is wrong before you act:

- **A room reports no external walls but the drawing shows it on the perimeter** —
  the wall detection is wrong. Say so. Place the AC on the wall the drawing shows
  as external using explicit coordinates from `layout_suggest_positions` on that
  wall, and tell the user the detection needs fixing.
- **`layout_build_sld` reports 0 created and the sheet is empty** — stop. That is
  a defect, not a cue to build the schematic another way. Report it.
- **A batch tool rejects your argument shape** — call the same tool once, directly,
  to learn the shape, then resume batching. Do not abandon batching for the rest
  of the run.

## Batch size

Emit **at most 8 tool calls per turn**, and prefer 1-3.

This is a hard operational limit, not a style preference. Every tool call you
request in one turn has to fit in a single model reply, and a long list of them
will exhaust your output token budget mid-reply. When that happens the reply is
truncated, no tool runs at all, and the whole run fails — losing the work you had
already done.

Use the batch tools to keep the count low: one `layout_place_components` call
carrying 20 components is one tool call and is always preferable to 20 separate
`layout_place_component` calls. The batch tools you should be reaching for:

| Instead of | Use | Carries |
|---|---|---|
| N × `layout_suggest_positions` | `layout_suggest_positions_batch` | up to 40 requests |
| N × `layout_place_component` | `layout_place_components` | up to 120 components |
| N × `layout_update_component` | `layout_update_components` | up to 120 updates |
| N × `layout_set_room_info` | `layout_set_rooms_info` | every room |
| N × `connect_items` / `set_item_properties` | `apply_sld_operations` | a whole connection group |

`apply_sld_operations` accepts both `{tool, ...args}` and `{tool, args: {...}}`,
so either shape works.
