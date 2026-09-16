---
name: load-placement
description: Comprehensive Indian residential electrical placement guide — quantities, positions, orientations, mounting surfaces and contextual placement intelligence for every component type. All lights are wall mounted; AC points and exhaust fans go on boundary walls only. Load during Phase 1–3 of the design workflow.
appliesTo: layout
---

# Load Placement Rules — Indian Residential Electrical Design

This skill teaches you to think like an experienced Indian lighting architect /
electrical contractor. Quantities follow CPWD general specifications and IS 732
practice. Placement positions follow decades of Indian residential convention
refined by practical use.

**These are defaults, not law.** If the user states a preference, follow the
user. But when working autonomously, every placement must have a practical
reason — never scatter items randomly.

**Two rules are absolute** and are not "defaults" — do not deviate from them
unless the user explicitly overrides:

1. **All light points go on walls, never the ceiling** — both `tube_light` and
   `bulb`, in every room. See Section 2.1.
2. **AC points and exhaust fans go on boundary (external) walls, never on
   partition walls** — they need pipes, drains and airflow reaching outdoors.
   See Sections 4 and 7.

## Prerequisites

Compute counts from `areaSqm` returned by `layout_get_plan_geometry`. If the
plan is uncalibrated, those areas come from a default 50 px/m and may be badly
wrong — say so rather than presenting the counts as correct.

If the floor plan image is attached and it carries dimension annotations
(e.g. "12'-0" × 10'-6""), read them and compare against `areaSqm`. A large
disagreement means the scale calibration is wrong — report it instead of
proceeding quietly.

---

## SECTION 1: ROOM READING — Understand Before You Place

Before placing anything in a room, mentally identify:

1. **Doors** — count, position, and which way they swing (the arc in the
   drawing). The door opens AWAY from the hinge; a switch board goes on the
   **latch side** (the side the door swings toward when opening into the room).
2. **Windows** — count and which walls they are on. Windows usually indicate
   boundary walls.
3. **Boundary walls vs partition walls** — this distinction decides where AC
   points and exhaust fans can go, so establish it before placing either.
   - A **boundary wall** (external wall) is on the building perimeter. The far
     side of it is outdoors.
   - A **partition wall** (internal wall) separates two rooms of the same
     dwelling. The far side of it is another room.
   - **How to tell them apart:**
     - `layout_get_plan_geometry` reports `isExternal` per wall — that is the
       authoritative signal. Use it first.
     - Cross-check against the drawing: trace the outer outline of the plan, and
       every wall on that outline is a boundary wall.
     - Walls with windows are almost always boundary walls.
     - Walls shared between two labelled rooms are partition walls.
     - Boundary walls are often drawn thicker (230 mm) than partitions
       (115 mm) in Indian plans.
     - If `isExternal` and the drawing disagree, say so — the wall detection is
       probably wrong, and that affects more than this one fitting.
   - AC points and exhaust fans **must** go on boundary walls. Placing either on
     a partition wall is a hard error — see Sections 4 and 7.
4. **Likely furniture positions** — infer from room type and dimensions:
   - Bedroom: bed along the longest wall, headboard against the wall
   - Living room: sofa along the longest wall, TV on the opposite wall
   - Kitchen: counter/platform along the wall with the window or the longest wall
   - Dining: table roughly centred
5. **Wet zones** — bathrooms, toilets, and the kitchen sink area. No 5A sockets
   in wet zones. Switches must be outside or at a safe distance.

> **Key principle:** You are not just placing electrical points — you are
> designing the daily experience of living in the home. Every switch, socket and
> light must be reachable, useful, and safe where the occupant actually stands,
> sits, or lies.

---

## SECTION 2: LIGHTING

### 2.1 Mounting Surface Rule

> **CRITICAL — ALL light points go on WALLS, never on the ceiling.**
> This applies to **both** `tube_light` and `bulb`, in **every** room type —
> bedrooms, living rooms, kitchens, bathrooms, toilets, corridors, staircases,
> balconies, pooja rooms, storage, parking. No exceptions.
>
> Why this is standard Indian residential practice:
> - Cost: no false ceiling needed
> - Maintenance: reachable from a stool for tube/bulb replacement, no ladder
> - Aesthetics: Indian homes typically have bare RCC ceilings, and a fitting on
>   bare RCC needs surface conduit dropped across the slab
> - Conflict: the ceiling is occupied by the fan point
>
> The **only** exception is when the user explicitly asks for false-ceiling /
> cove / downlight design, or the space is commercial/office. Until they say so,
> place every light on a wall.

**How to place lights:** call `layout_suggest_positions` with `purpose: "wall"`
for all light points. Do **not** use `purpose: "ceiling"` for `bulb` or
`tube_light` — `purpose: "ceiling"` is reserved for `ceiling_fan_point`. Both
light types are `placementType: 'wall'` in the catalog, so the seating logic
mounts them for you: the base lands on the wall face and the light side faces
the room. **Never pass an explicit `rotation` for lights** — Section 2.4
explains the per-type orientation the tool applies, and a hand-supplied angle
overrides it (usually wrongly).

**Height reference** (not drawn on the plan, but it is why walls work):
- `tube_light` — 2.1–2.4 m, mounted horizontally along the wall
- `bulb` — 2.0–2.2 m, a wall-mounted batten/bracket holder

**Wall choice for a bulb** (where the old rule said "ceiling centre"): pick the
wall that best lights the space the room is used for, and prefer a partition
wall so you leave the boundary wall clear for the exhaust fan:
- bathroom / toilet — the wall above the door, or the wall facing the WC; keep
  clear of the shower spray zone and off the exhaust fan's wall segment
- corridor — the longest wall, evenly spaced if 2
- staircase — the landing wall
- balcony — the wall shared with the room (i.e. the house side, sheltered from
  rain), not the open parapet side
- storage / pooja / parking — the wall facing the entry door, so the light is
  behind you as you walk in and you are not lighting your own shadow

### 2.2 Quantity Table

Every entry below is **wall-mounted**. The notes say which wall.

| Room type | Area | Light points | Preferred type | Placement notes (always a wall) |
|---|---|---|---|---|
| bedroom | ≤ 12 m² | 1 | `tube_light` | On wall opposite bed, centred |
| bedroom | > 12 m² | 2 | `tube_light` | One above bed wall, one opposite |
| living_room | ≤ 15 m² | 2 | `tube_light` | One each on two opposite long walls |
| living_room | > 15 m² | 3 | `tube_light` | Distributed across walls |
| kitchen | any | 1–2 | `tube_light` | On the wall above the platform/counter |
| bathroom / toilet | any | 1 | `bulb` | Wall above the door or facing the WC, IP-rated, clear of spray |
| balcony | any | 1 | `bulb` | Wall shared with the house (sheltered side), weather-rated |
| corridor | ≤ 6 m² | 1 | `bulb` | On the longest wall, mid-length |
| corridor | > 6 m² | 2 | `bulb` | Along the longest wall, evenly spaced |
| dining | any | 1–2 | `tube_light` | On the wall nearest the dining table position |
| staircase | any | 1 per landing | `bulb` | Landing wall at each level |
| storage / utility | any | 1 | `bulb` | Wall facing the entry door |
| pooja | any | 1 | `bulb` | Wall facing the entry door, warm tone |
| office | ≤ 12 m² | 2 | `tube_light` | Wall over desk area, and the general-area wall |
| office | > 12 m² | 3 | `tube_light` | Evenly distributed on walls |

### 2.3 Lighting Placement Intelligence

- **Bedroom tube light**: Place on the wall OPPOSITE the bed (the wall you face
  while lying down). If two tube lights, add a second above the headboard wall
  for reading. Orient parallel to the wall it's mounted on.

- **Living room tube lights**: Place on the two longer walls facing each other.
  This creates even, shadow-free illumination across the seating area.

- **Kitchen tube light**: Place above the kitchen platform (counter) so the cook
  is not working in their own shadow. If the kitchen has a window, the tube light
  goes on the wall ABOVE the window or on the wall perpendicular to the platform.

- **Dining tube light**: On the wall nearest where the dining table will sit,
  aimed across the table.

- **Bathroom/toilet bulb**: On the wall — the wall above the door, or the wall
  facing the WC. Use `purpose: "wall"`, count 1. Keep it out of the shower spray
  zone and off the same wall segment as the exhaust fan. Never ceiling.

### 2.4 Orientation

The two light types mount DIFFERENTLY — this is the most common orientation
mistake, so memorise it. The icons are drawn as wall-mount top views with an
explicit base side, and the placement tool seats them automatically (base on
the wall face, offset into the room, facing the room you placed them for).
Do **not** pass `rotation` for either type.

- **`bulb` — PERPENDICULAR to the wall.** The icon's left edge is the mounting
  base plate; the circle (globe) sticks out at right angles into the room, like
  a real wall-bracket holder viewed from above. The tool rotates it so the
  globe points at the served room's interior:
  - North wall (room to the south) → globe faces south (~90°)
  - South wall (room to the north) → globe faces north (~270°)
  - West wall (room to the east) → globe faces east (~0°)
  - East wall (room to the west) → globe faces west (~180°)
  - A bulb lying ALONG the wall (long axis parallel to it) is WRONG — re-place
    it without `rotation` so the auto-seating applies.

- **`tube_light` — PARALLEL to the wall, offset into the room.** The icon's top
  edge is the mounting base strip screwed flat to the wall; the tube sits below
  it on the room side, like a real batten viewed from above. The tool keeps the
  long axis parallel to the wall, flips base-vs-tube to face the served room,
  and offsets the whole fitting so the base strip touches the wall face instead
  of straddling inside the wall body. A tube centred ON the wall line (half
  buried in the wall) is WRONG — re-place it without `rotation`.

**Visual check** on the annotated overlay image: every bulb should show its
base plate touching a wall with the circle clearly inside the room; every tube
should show a long bar running alongside a wall with daylight (a gap) between
the bar and the wall line on any other side. If you see a bulb parallel to a
wall or a tube buried in one, that placement predates the auto-seating — move
it with `layout_update_component` (omit `rotation`) or delete and re-place it.

---

## SECTION 3: CEILING FANS

`ceiling_fan_point` — always ceiling-mounted at the room centre. This is the
**only** component that belongs on the ceiling, and therefore the only one that
uses `purpose: "ceiling"`.

| Room type | Count | Condition |
|---|---|---|
| bedroom | 1 | Always (2 if area > 20 m²) |
| living_room | 1 | Always (2 if area > 22 m²) |
| dining | 1 | Always |
| office | 1 | Always |
| lobby / hall (with seating) | 1 | Treat like living_room: 2 if area > 22 m² |
| lobby / passage (pure transit, no furniture) | **0** | Like corridor |
| kitchen | **0** | Use exhaust fan instead |
| bathroom / toilet | **0** | Never |
| balcony | **0** | Never (use wall fan if needed) |
| corridor | **0** | Never |
| staircase | **0** | Never |
| storage / utility | **0** | Never |
| pooja | **0** | Too small usually |

### How to decide the count (do this before requesting positions)
1. Read `areaSqm` for the room from `layout_get_plan_geometry`.
2. Apply the table above — it is arithmetic, not judgement. Worked example:
   a lobby of 288 sqft = 26.8 m² typed as living space is **over 22 m² → 2 fans**,
   not 1. Request `count` = 2 in `layout_suggest_positions`.
3. `layout_suggest_positions` echoes `recommendedCount` for `purpose: "ceiling"`.
   If you requested fewer, a `quantityNote` tells you. The recommended count is
   the default, not a cage: you may keep fewer or place more for a stated
   furniture/usage reason (AC-first room, distinct bed and seating zones), but
   resolve the note deliberately — never end with fewer fans than the table says
   and an "add more if you want" note to the user.
4. A lobby/hall with a sofa set, dining table or other seating drawn in it
   functions as a living room — type it accordingly and count fans by area.
   Only a bare transit passage with no furniture counts as a corridor (0 fans).

### Placement rules
- Place fans FIRST at room centre using `purpose: "ceiling"`, count 1.
- When a room has both fan(s) and lights, place the fan first, then lights.
  The collision avoidance in `layout_suggest_positions` handles spacing.
- Fan must be at least 2.4 m (8 ft) from the floor in reality — the plan view
  just needs it centred.
- When a room has 2 fans (large room), use `purpose: "ceiling"`, count 2 —
  they will distribute along the room's long axis.

### Symmetry rule (multi-fan rooms)
- Multiple fans in one room go **symmetric on the room's long axis, spaced
  equally**: 2 fans sit at 1/4 and 3/4 of the length on the centre line;
  3 fans at 1/6, 3/6, 5/6. `layout_suggest_positions` constructs this
  symmetric layout by construction (equal zones, zone-centre preference).
- Only a real obstruction — a narrow neck in the polygon, a door swing
  keep-out — moves a fan off its symmetric point, and only as far as the
  1200 mm sweep clearance requires. An off-axis result therefore always has
  a physical reason: read the overlay (which wall/door forced it) and state
  it to the user instead of accepting it silently. Never place fans
  asymmetrically without such a reason.

### Sweep-clearance rule (no overlaps)
- A ceiling fan is a **1200 mm sweep circle**. The centre must sit at least a
  full sweep radius plus margin clear of every wall, door swing and window
  symbol — a centre merely "inside the room" is NOT enough, the blades must
  clear as well.
- `layout_suggest_positions` enforces this and marks any best-effort point
  that cannot fit with `[WARNING: fan sweep overlaps …]`, plus a
  `placementWarning` / `geometryNote` on the response. `layout_place_component`
  and `layout_update_component` report the same `placementWarning`.
- **Never accept an overlap.** If you see the warning: first check whether the
  room detection is wrong (merged rooms, missing walls — see below); if the
  geometry is correct but tight, move the fan with `layout_update_component`
  until the warning clears; then verify on the annotated overlay image that
  no blade touches a wall, door or window.

### Detection-merged rooms (e.g. living + dining + office as one polygon)
- Wall detection often merges an open plan (living, dining, home office,
  foyer, passage) into one large polygon. Do NOT treat its bounding-box
  middle as the room centre — that point frequently lands in the narrow
  passage strip or on the partition wall between zones.
- Quantities for a merged polygon: **one fan per ~12–15 m² of habitable area**
  (passages, foyer and corridors excluded — they get no fans), i.e.
  `count = round(habitableArea / 13)`, minimum 1 per functional zone
  (living zone, dining zone, office zone). A ~38 m² merged living/dining/
  office therefore needs **3 fans** (one per zone), not 2.
- Say explicitly that the detection merged the spaces and which zones each
  fan serves. If the polygon also swallowed a narrow passage, expect a
  `geometryNote` (fewer feasible sweeps than requested) — that is the tool
  refusing to put a 1.2 m fan in a 1 m passage, which is correct behaviour.
- After placing, verify on the overlay that every fan sits in the wide part
  of its zone: bedroom fans centred in the bedroom (not on the bathroom
  wall), living fan centred on the seating area, dining fan over the table
  zone, office fan over the desk zone — none touching a wall, door or window.

---

## SECTION 4: EXHAUST FANS

`exhaust_fan` — wall-mounted high on a **boundary (external) wall**, near the
ceiling.

| Room type | Count | Notes |
|---|---|---|
| bathroom | 1 | Mandatory for ventilation |
| toilet | 1 | Mandatory for ventilation |
| kitchen | 1 | Above or near the cooking area |
| everything else | **0** | Never |

### Placement intelligence

> **CRITICAL — boundary wall only, never a partition wall.**
> An exhaust fan must discharge into open air. On a boundary wall it vents
> outdoors, which is the entire point of the fitting. On a partition wall it
> would blow bathroom moisture and kitchen smoke straight into the adjoining
> room — the fan does nothing useful, and in practice the hole cannot even be
> cut. **A partition-wall exhaust fan is a hard error, not a stylistic choice.**

- **How to identify the boundary wall:** read `isExternal` from
  `layout_get_plan_geometry`, then sanity-check it against the drawing — every
  wall on the plan's outer outline is a boundary wall, and walls with windows
  almost always are. A wall shared with another labelled room is a partition wall
  and is disqualified. See Section 1, item 3.
- If the bathroom has a window, place the exhaust fan on the **same wall as the
  window**, near the top — that wall is confirmed to open outside.
- In the kitchen, place it on the boundary wall closest to the cooking platform,
  ideally above or beside the window.
- **If the room genuinely has no boundary wall** (an internal toilet or kitchen,
  which does happen in flats), do not silently drop it onto a partition wall.
  Place it on the wall nearest the building perimeter or the ventilation shaft,
  and **say explicitly** that the room appears to have no external wall and the
  fan needs a duct run — so the user can correct you.
- Keep the exhaust fan off the same wall segment as the geyser point and the
  light point.

Use `purpose: "external_wall"` — that strategy returns candidates on boundary
walls only, so it cannot hand you a partition wall. State which wall you chose
and why you believe it is external.

---

## SECTION 5: POINT SWITCH BOARDS

`point_switch_board` — wall-mounted, at standard switch height (1.2 m from
floor). Controls lights and fans in the room.

### 5.1 Quantity

Every room with lights or fans needs at least one. A Point Switch Board has
**9 outputs** — one per load. Rooms with more than 9 light+fan points need a
second board.

### 5.2 Placement — The Door-Side Rule

> **CRITICAL RULE**: The point switch board goes **beside the room's entry door**,
> on the **latch side** (the opening side), NOT the hinge side.

**Why the latch side?** When you enter a dark room and reach for the switch,
your hand naturally goes to the side where the door opens. The hinge side is
blocked by the door itself when it's open. Every Indian electrician installs
switches on the opening side.

**How to determine the latch side from the floor plan:**
1. Look at the door's arc in the drawing — the arc shows the sweep direction.
2. The hinge is at the fixed end (where the arc starts/pivots).
3. The latch side is at the moving end (where the arc reaches).
4. Place the switch board on the wall on the latch side, approximately 15 cm
   from the door frame.

**When using the tool:** Use `layout_suggest_positions` with
`purpose: "beside_door"`. The tool offsets along the wall from the door.
The board then seats automatically — base on the wall face, plate face toward
the room you placed it for — so omit `rotation`. It must land on clear wall
BESIDE the opening: never overlapping the door leaf span itself (no wall body
there to fix to). Placement slides it clear automatically and
`layout_validate` flags any board left over an opening — fix every one.
If the floor plan image is available, verify the placement is on the correct
(latch/opening) side. If the tool placed it on the hinge side, use explicit
coordinates to correct it.

### 5.3 Multiple Entry Points

- If a room has two doors (e.g., master bedroom with attached bathroom), place
  one switch board at the main entry door.
- For pass-through rooms (corridors with doors at both ends), consider a switch
  at each entry for two-way control — but this is one board, not two separate
  circuits.

### 5.4 Special Cases

| Room type | Switch board position |
|---|---|
| bedroom | Beside entry door, latch side, ~1.2 m height |
| living_room | Beside main entry door, latch side |
| kitchen | Beside kitchen entry door, latch side |
| bathroom / toilet | **OUTSIDE** the door, on the corridor/room wall — never inside a wet room |
| balcony | Inside the adjacent room, near the balcony door |
| corridor | At the entry point, beside the door |
| staircase | At the bottom of the staircase, beside the stairwell door |
| dining | Beside entry (often shared access with living room) |
| pooja | Beside the pooja room door |

> **Wet room rule:** Bathroom and toilet switch boards are placed OUTSIDE the
> bathroom door, on the wall in the adjacent corridor or bedroom. This is Indian
> electrical safety code — 240V switches must not be within reach of someone
> standing in water.

---

## SECTION 6: AVG. 5A SWITCH BOARDS (Socket Circuits)

`avg_5a_switch_board` — wall-mounted, represents the room's general 5A socket
circuit for charging, lamps, small appliances.

### 6.1 Quantity per Room

| Room type | Count | Notes |
|---|---|---|
| bedroom | 1 | For charging, table lamps, etc. |
| living_room | 1 | For TV, set-top box, lamps |
| dining | 1 | For mixer, small appliances on dining table |
| kitchen | 1 | For mixer, toaster, microwave (near platform) |
| office | 1 | For computer, printer, desk accessories |
| pooja | 1 | For electric diya, small appliances |
| bathroom / toilet | **0** | **NEVER** — wet area, safety hazard |
| balcony | 0 | Only if user specifically asks |
| corridor / staircase | 0 | No habitable use |
| storage / utility | 1 | Only if user asks |

### 6.2 Placement Intelligence — Context-Aware Positioning

The 5A board is where people plug in their everyday devices. Its position must
match how the room is USED:

**Bedroom:**
- Place on the wall **beside the bed headboard**, at bedside table height
  (~0.7 m from floor, i.e., low on the wall).
- Specifically: on one side of the bed (the side closer to the window or the
  side with a nightstand).
- **Rationale**: Mobile phone charging while sleeping, bedside lamp, mosquito
  repellent plug-in.
- If the bedroom is large (> 15 m²) and might have a dressing table area on the
  opposite wall, the user may want a second 5A board there — but default to one.

**Living Room:**
- Place on the wall **opposite the sofa** — this is the TV wall.
- **Rationale**: TV, set-top box, DTH, Wi-Fi router, sound bar all plug in at
  the TV wall.
- If the living room is combined with the dining area, one 5A board in each zone.

**Kitchen:**
- Place on the wall **above the kitchen platform** (counter), near where small
  appliances are used.
- **Rationale**: Mixer-grinder, toaster, kettle, microwave.
- Keep it at least 0.6 m away from the sink (wet zone separation).
- Must be above counter height — approximately 1.0–1.2 m from floor.

**Office:**
- Place on the wall **behind or beside the desk area**.
- **Rationale**: Computer, monitor, printer, chargers.

**Dining:**
- Place on the wall near the dining table position (usually a side wall).
- **Rationale**: Table fan, phone charging during meals, blender near table.

**Pooja Room:**
- Place on a side wall, low.
- **Rationale**: Electric diya, small amplifier for bhajans.

Use `purpose: "wall"` and pick the wall that matches the functional reasoning
above. State which wall you chose and why. Like every switch board it must sit
on clear wall spans — never overlapping a door or window opening (placement
slides it clear; `layout_validate` flags leftovers).

---

## SECTION 7: AC POINTS (Dedicated Circuit)

`ac_point` — wall-mounted, high on a **boundary (external) wall**. Each is a
dedicated circuit from the HTPN.

### 7.1 Quantity

| Room type | Count | Condition |
|---|---|---|
| bedroom | 1 | Always in modern Indian homes |
| living_room | 1 | Always |
| office | 1 | Always |
| dining | 0 | Usually cooled by living room AC |
| kitchen | 0 | Unless user requests |
| everything else | 0 | Unless user requests |

### 7.2 Placement Intelligence

The AC indoor unit placement follows strict practical rules:

1. **Boundary wall — MANDATORY, never a partition wall.** A split AC's indoor
   unit needs refrigerant pipes and a condensate drain running to the outdoor
   unit, and the pipe run is limited to roughly 3–5 m. On a boundary wall the
   installer core-drills straight through to the outside and the drain falls
   outdoors. On a partition wall there is nowhere for the pipes or the water to
   go — it would mean chasing the lines across the neighbouring room's ceiling.
   **A partition-wall AC point is a hard error.** Identify boundary vs partition
   walls per Section 1, item 3, before choosing.

2. **Opposite the door** — The AC should blow air across the room, not at the
   door opening. The wall opposite the main entry door is ideal because:
   - The cold air fills the room evenly before escaping through the door
   - The AC unit is not the first thing you see when entering

3. **Above the bed in bedrooms** — In Indian bedrooms, the AC is conventionally
   above the headboard wall or on the wall adjacent to it. This avoids direct
   cold air blast on the sleeping person while cooling the room. If the headboard
   wall is a boundary wall, that's perfect.

4. **Near window in living room** — Often placed above or near a window on the
   boundary wall.

5. **Height**: 2.1–2.4 m from floor (near the ceiling). On the plan, this means
   placed flush against the wall.

**Decision priority:**
1. List the room's boundary walls. Partition walls are not candidates.
2. Of those, is one opposite the entry door? YES → place there, done.
3. If the only boundary wall is the door wall, use another boundary wall of the
   room even if it is not opposite the door — boundary beats orientation.
4. If the room has **no** boundary wall at all, do not fall back to a partition
   wall. Place it on the wall closest to the perimeter and **say explicitly**
   that the room appears fully internal so the AC needs a long pipe run, and ask
   the user to confirm.
5. Always state which wall you chose and why you believe it is external.

Use `purpose: "external_wall"` — it restricts candidates to boundary walls, so a
partition wall cannot be returned by accident. The point then seats just
inside the served room (base toward the wall, label upright) — omit
`rotation`.

---

## SECTION 8: GEYSER POINTS (Dedicated Circuit)

`geyser_point` — wall-mounted, high, in the wet area of bathrooms.

### 8.1 Quantity

| Room type | Count | Condition |
|---|---|---|
| bathroom | 1 | Always (attached to bedroom) |
| toilet | 0 | Only if user says it has bathing facility |
| kitchen | 0 | Only if user specifically requests |

### 8.2 Placement

- Place on the wall directly above where the shower/bathing area would be.
- In Indian bathrooms, the geyser is typically above the door height on the wall
  nearest the shower area.
- Must be away from the exhaust fan (they shouldn't share the same wall segment).
- Use `purpose: "wall"` and place on the wall nearest to the bathing zone.
  The point seats just inside the bathroom (label upright) — omit `rotation`.

---

## SECTION 9: CALL BELL

`call_bell` — exactly ONE per dwelling, wall-mounted.

### Placement

- **Outside** the main entrance door, on the door frame wall or beside it.
- The main entrance is identified as:
  - The door opening to the building exterior, corridor, or staircase
  - Usually the widest door
  - Often near the drawing/living room
  - In the floor plan image, it's the door that opens to "outside" or "parking"

- Place it on the external side of the door, at about 1.5 m height, beside the
  door handle (latch side).
- If identifying the main entrance from the image: look for "GATE",
  "ENTRANCE", parking access, or the door that opens to the staircase.

---

## SECTION 10: DISTRIBUTION BOARDS

These are covered in detail by the `board-sizing` skill, but the placement
rules belong here:

### SPN DB
- **Where**: Corridor or hallway wall, centrally located to minimize cable runs
  to the rooms it serves.
- In typical Indian flats, this is in the passage/lobby area.
- Height: 1.5–1.8 m from floor.
- Use `purpose: "wall"`, pick the corridor's longest wall.
- On a clear span: never centred over a door or window opening (no wall body
  there). Placement slides it clear; `layout_validate` flags leftovers.

### HTPN DB
- **Where**: Near the electrical service entry (meter box location).
- In Indian apartments: usually near the front door, in the passage.
- In independent houses: near the main gate or under the staircase.
- Use `purpose: "wall"`, pick a wall near the building entry.
- Same clear-span rule: beside openings, never over them.

### Source
- **Where**: At the service entry point (where the electricity board's meter
  connects).
- Near the HTPN, outside or at the building boundary.
- For apartments: near the electrical riser/shaft.

---

## SECTION 11: PLACEMENT EXECUTION RULES

### 11.1 Tool Usage Protocol

1. **You have coordinate and quantity authority.** `layout_suggest_positions`
   is the vetted default — recommended counts, sweep clearance checked — and
   covers most rooms. But you may place by your own numbers instead, computed
   from the room `polygon` vertices in `layout_get_plan_geometry` and from what
   you read in the floor plan image. The placement tools validate every point
   and `layout_validate` re-checks all of it: a placement the validator rejects
   is not placed well. Which room and how many is always your decision; the
   coordinates may be yours or the tool's.

2. **Default fan position — centre of the largest inscribed rectangle.**
   For a ceiling fan, the strongest default is the centre of the largest
   axis-aligned rectangle that fits inside the room's wall lines (the habitable
   body, excluding entry bands, passage strips and carve-outs). It is the point
   of maximum clearance from every wall — ≥450–600 mm blade-tip clearance,
   clear of door swings and wardrobe arcs — and in a ~4×4 m bedroom it is the
   one position from which a single 1200 mm sweep reaches all four walls.
   The tool's room centre already approximates this; compute your own from the
   `polygon` when the polygon centroid is visibly dragged into a doorway band
   or second lobe. Show the rectangle extents you used when you do.

3. **Furniture-aware second pass (optional, needs the image).** The rectangle
   centre cools the whole room; cooling the person means offsetting toward use:
   bed against a wall → fan on the bed's centre line, ~450 mm toward the foot
   from the bed's mid-length; seating zone → over the seating. Keep ≥600 mm to
   every wall and the full sweep clear of doors/windows. Only claim
   furniture-aware placement when you actually offset by furniture you read —
   never label a pure rectangle centre as a "bed zone".

4. **`purpose` selection — memorise this:**

   | Component | purpose | Constraint |
   |---|---|---|
   | `ceiling_fan_point` | `"ceiling"` | Room centre. The only ceiling item. |
   | `tube_light`, `bulb` | `"wall"` | Never `"ceiling"`. Any wall. |
   | `exhaust_fan` | `"external_wall"` | **Boundary wall only** |
   | `ac_point` | `"external_wall"` | **Boundary wall only** |
   | `point_switch_board` | `"beside_door"` | Latch side |
   | `avg_5a_switch_board` | `"wall"` | Context wall (furniture-driven) |
   | `geyser_point` | `"wall"` | Bathing-zone wall |
   | `call_bell` | `"wall"` | Outside main entry door |

   `purpose: "external_wall"` only returns points on boundary walls. If the room
   has none, it returns partition-wall points **with a warning in the response** —
   read that warning and tell the user instead of placing silently.

3. **Batch aggressively** — one `layout_place_components` call per room. Include
   all items for that room (lights + fans + switch boards + 5A boards) in a single
   batch where possible.

4. **Place in this order within each room:**
   - Ceiling fan (takes the room centre — the only ceiling item)
   - Lights (on walls, spread around the room)
   - Exhaust fan (if applicable, boundary wall only)
   - Point switch board (beside door, latch side)
   - 5A switch board (context-specific wall position)
   - AC point (boundary wall, high)
   - Geyser point (if bathroom)

5. **Between rooms, process in this order:**
   - Bedrooms (most items per room)
   - Living room / drawing room
   - Kitchen
   - Dining
   - Bathrooms / toilets
   - Corridors / passages
   - Utility / storage
   - Pooja
   - Parking (usually just a light point)

### 11.2 Rotation and Orientation

- **Wall-mounted items** (`snapToWall: true`): rotation and seating are
  auto-calculated by the snap-to-wall logic — seating OWNS rotation for
  lights, switch boards, AC and geyser points, so an explicit `rotation` on
  those types is ignored (reported back as `rotationNote`). Just omit it.
- **Tube lights**: wall-mounted, long axis parallel to the wall, base strip on
  the wall face, tube offset into the room. Automatic — omit `rotation`.
- **Bulbs**: wall-mounted, PERPENDICULAR to the wall — base plate on the wall
  face, globe pointing into the room. Automatic — omit `rotation`. (A bulb is
  directional, not a symmetrical point source.)
- **Switch boards** (`point_switch_board`, `avg_5a_switch_board`): wall-mounted
  like tube lights — long axis parallel to the wall, base on the wall face,
  plate face pointing into the served room. Automatic — omit `rotation`. On a
  partition wall the board belongs to whichever room you placed it for; the
  user can drag it across the wall to flip it to the other room.
- **AC and geyser points**: wall-mounted, long side parallel to the wall,
  seated slightly sunk into the wall face on the room side so ownership is
  obvious at a glance — never floating in open ceiling area. Labels stay
  upright (no flipping). Automatic — omit `rotation`.
- **AC point**: oriented with the long side parallel to the wall (rotation matches
  the wall angle).
- **Ceiling fans**: rotation 0° (symmetrical, rotation doesn't matter visually).

### 11.3 Label Convention

Use clear, room-contextual labels:
- `"M.Bed Light 1"`, `"M.Bed Fan"`, `"M.Bed AC"`
- `"Kitchen Exhaust"`, `"Kitchen Light"`
- `"Toilet 1 Light"`, `"Toilet 1 Exhaust"`
- `"Main Entry Bell"`, `"Drawing Room Fan"`

---

## SECTION 12: COMPLETE ROOM-BY-ROOM REFERENCE

> Reading this section: **every light is on a wall.** `ceiling_fan_point` is the
> only ceiling item. "Boundary wall" means external/perimeter — never a partition
> wall shared with another room.

### Bedroom (10–15 m² typical Indian)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `ceiling_fan_point` | 1 | Room centre (ceiling) | Air circulation |
| `tube_light` | 1–2 | **Wall** opposite bed | Even illumination, no glare while lying down |
| `point_switch_board` | 1 | Beside entry door, latch side | Light/fan control on entering |
| `avg_5a_switch_board` | 1 | Beside bed headboard wall | Mobile charging, bedside lamp |
| `ac_point` | 1 | **Boundary wall**, opposite door or above headboard | Pipes and drain must reach outdoors |

### Master Bedroom with Attached Bathroom

Same as bedroom, plus:
- The bathroom switch board goes on the bedroom wall, outside the bathroom door
- Consider 5A board position to also serve the dressing table area

### Living Room / Drawing Room (15–20 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `ceiling_fan_point` | 1–2 | Centre / two centres for large rooms | Air circulation |
| `tube_light` | 2–3 | On opposite long **walls** | Even illumination across seating |
| `point_switch_board` | 1 | Beside main entry door, latch side | Control on entering |
| `avg_5a_switch_board` | 1 | Wall opposite sofa (TV wall) | TV, router, set-top box |
| `ac_point` | 1 | **Boundary wall**, ideally above window | Pipes and drain must reach outdoors |

### Kitchen (6–10 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `tube_light` | 1–2 | **Wall** above kitchen platform/counter | Cook must not work in own shadow |
| `exhaust_fan` | 1 | **Boundary wall** near cooking area | Smoke must vent outdoors |
| `point_switch_board` | 1 | Beside kitchen door, latch side | Light/exhaust control |
| `avg_5a_switch_board` | 1 | Above kitchen platform, away from sink | Mixer, toaster, microwave |

### Dining Room (8–12 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `ceiling_fan_point` | 1 | Room centre | Air circulation while eating |
| `tube_light` | 1–2 | **Wall** nearest the dining table | Illuminate the eating surface |
| `point_switch_board` | 1 | Beside entry, latch side | Control |
| `avg_5a_switch_board` | 1 | Side wall near dining table | Occasional use |

### Bathroom (3–6 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall** above door or facing WC, clear of spray | General illumination |
| `exhaust_fan` | 1 | **Boundary wall** with window, near ceiling | Moisture must vent outdoors |
| `geyser_point` | 1 | Wall near shower area, high | Water heating |
| `point_switch_board` | 1 | **OUTSIDE** on corridor/bedroom wall | Wet area safety |

### Toilet (2–4 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall** above door or facing WC | General illumination |
| `exhaust_fan` | 1 | **Boundary wall**, near ceiling | Odour must vent outdoors |
| `point_switch_board` | 1 | **OUTSIDE** on corridor wall | Wet area safety |

### Corridor / Passage

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1–2 | Longest **wall**, evenly spaced | Passage illumination |
| `point_switch_board` | 1 | At passage entry | Control |

### Staircase

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 per landing | Landing **wall** at each level | Safety illumination |
| `point_switch_board` | 1 | At bottom of stairs | Two-way switch is ideal |

### Balcony

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall** shared with the house (sheltered side) | Evening use, protected from rain |
| `point_switch_board` | 1 | Inside adjacent room, near balcony door | Weather protection for switch |

### Pooja Room (2–4 m²)

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall** facing the entry door | Ambient light |
| `point_switch_board` | 1 | Beside door, latch side | Control |
| `avg_5a_switch_board` | 1 | Side wall, low | Electric diya, small speakers |

### Utility / Storage

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall** facing the entry door | Basic illumination |
| `point_switch_board` | 1 | Beside door | Control |

### Parking

| Component | Qty | Position | Reasoning |
|---|---|---|---|
| `bulb` | 1 | **Wall**, facing the parking bay | Vehicle parking illumination |
| `point_switch_board` | 1 | Beside entry, latch side | Control |

---

## SECTION 13: SANITY CHECKS

Before finalizing placement for any room, verify:

1. **No room has 0 light points** — every room needs at least one light.
2. **No room has more than 4 lights** unless it exceeds 40 m².
3. **Zero lights on the ceiling** — every `bulb` and `tube_light` is on a wall.
   If any light used `purpose: "ceiling"`, that is a bug: re-place it with
   `purpose: "wall"`. The only ceiling item is `ceiling_fan_point`.
4. **Zero floating wall-mounted items** — every wall `placementType` fitting
   must sit on a wall, not in open room area. Hand-picked coordinates bypass
   the wall snap when they land far from any wall line, so `layout_validate`
   flags these explicitly: fix every one it names (move with
   `layout_update_component`, omitting `rotation`) AND audit your other
   hand-placed coordinates from the same turn for the same defect.
5. **Every `exhaust_fan` is on a boundary wall**, not a partition wall. Check
   `isExternal` for the wall it landed on, and confirm against the drawing.
6. **Every `ac_point` is on a boundary wall**, not a partition wall. Same check.
   "Adjacent to an external wall" is not good enough — it must be on one.
7. **No 5A board in bathrooms or toilets** — ever.
8. **Bathroom/toilet switch boards are OUTSIDE** the wet room.
9. **Switch boards are on the latch side of doors**, not the hinge side.
10. **One call bell total** for the entire dwelling, not one per room.
11. **Ceiling fans only in habitable rooms** — never in bathrooms, toilets,
    kitchens, corridors, or balconies.
12. **If computed count > 6 items of one type in any room**, re-read the area —
    the plan is probably uncalibrated.
13. **No switch board or distribution board over a door/window span** — point
    and 5A boards, SPN/HTPN/VTPN all sit on clear wall beside openings, never
    in front of them. `layout_validate` flags overlaps; move each along its
    wall.

---

## SECTION 14: PLACEMENT FLOW SUMMARY

```
For each room in the plan:
  1. Read room type, area, walls, doors, windows
  2. Identify: which walls are BOUNDARY (isExternal from plan geometry, confirmed
     against the drawing outline / windows) vs PARTITION (shared with another
     room), door swing direction, latch sides (opposite the hinge side) of the doors , likely furniture layout
  3. Determine counts from the tables above
  4. Place ceiling fan first (if applicable) → room centre, purpose "ceiling"
     (the only ceiling item)
  5. Place lights → ALWAYS purpose "wall", for both tube_light and bulb.
     Never purpose "ceiling".
  6. Place exhaust fan (if applicable) → purpose "external_wall", near the window
  7. Place point_switch_board → beside door, latch side
     (OUTSIDE for bathrooms/toilets)
  8. Place avg_5a_switch_board → context-specific wall position
  9. Place ac_point (if applicable) → purpose "external_wall", high
  10. Place geyser_point (if applicable) → bathroom wall near shower

After all rooms:
  11. Place call_bell → outside main entrance door
  12. Place distribution boards → corridor/passage area (see board-sizing skill)
  13. Place source → at service entry
```

---

## SECTION 15: COMMON MISTAKES TO AVOID

- ❌ Putting **any** light on the ceiling — both `tube_light` and `bulb` go on
  walls, in every room including bathrooms, corridors and balconies
- ❌ Using `purpose: "ceiling"` for a light (it is only for `ceiling_fan_point`)
- ❌ Placing an `exhaust_fan` on a partition wall — it would vent into the next
  room instead of outdoors
- ❌ Placing an `ac_point` on a partition wall — the refrigerant pipes and
  condensate drain have nowhere to go
- ❌ Settling for "near an external wall" when a real boundary wall was available
- ❌ Silently dropping an AC or exhaust fan onto a partition wall when the room
  has no boundary wall, instead of flagging it to the user
- ❌ Placing switches inside bathrooms/toilets
- ❌ Putting the switch board on the hinge side of the door
- ❌ Placing 5A socket boards in bathrooms
- ❌ Forgetting to place bathroom switches on the OUTSIDE wall
- ❌ Putting multiple call bells (it's one per dwelling)
- ❌ Placing ceiling fans in kitchens, bathrooms or toilets
- ❌ Random/centred placement of 5A boards instead of matching furniture use
- ❌ Leaving a validator rejection in place — every `placementWarning`,
  `quantityNote`, `geometryNote` and `layout_validate` issue must be resolved
  (new coordinates, corrected detection, or a stated reason) before you call
  the work done
- ❌ Labeling a pure rectangle-centre fan as furniture-aware ("bed zone")
  without actually offsetting by furniture you read
- ❌ Not stating your assumptions about which walls are boundary walls, or about
  door swing direction
