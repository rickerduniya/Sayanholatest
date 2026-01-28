# SLD Chat Mode Tool Calling – Technical Specification

## 1. Existing SLD Workflow (Human User)

### 1.1 Project + Sheets
- The SLD is a multi-sheet canvas. Each sheet has `sheetId`, `name`, `canvasItems`, `storedConnectors`, and view state (zoom/viewport).
- Users create/rename/remove sheets via the sheet UI and switch the active sheet for editing.

### 1.2 Adding Components (Canvas Items)
- Users add components by choosing an item from the SLD library and placing it on the canvas.
- Item creation is not just “drop an icon”; it includes:
  - Assigning a unique ID.
  - Loading default properties from backend DB (or local defaults if unavailable).
  - Fetching SVG and applying rule-based visual updates.
  - For DB/switchgear items (e.g. VTPN/HTPN/SPN DB/Main Switch/Change Over), running backend initialization to populate `incomer`, `outgoing`, and `accessories`, and recalculating geometry/connection points.

### 1.3 Connecting Components (Connectors)
- Users connect items by clicking/dragging between connection points.
- Material selection may be required (Cable vs Wiring), except for specific cases:
  - Certain switch-board connections and “in Portal” connections skip the dialog.
- Connector creation includes:
  - Loading default connector properties from DB (`/api/properties/{Cable|Wiring}`).
  - Applying dynamic defaults based on downstream phase type (core / conductor size rules).
  - Special Portal behavior:
    - “out” Portal connections mirror to the counterpart Portal’s connector.
    - “in” Portal connections become virtual/zero-length and mirror properties from the counterpart.

### 1.4 Editing Details
- Users edit:
  - Item `properties[0]` (phase, power, way, etc.).
  - Advanced item fields (`incomer`, `outgoing`, `accessories`, alternative companies).
  - Connector properties (size/core/conductor size, laying, etc.).
- Edits trigger network recalculation where appropriate.

### 1.5 Quality Expectations (“Human-Level”)
Human-created SLDs are consistent in:
- Correct item types and correct initialization data (DB incomer/outgoing, correct geometry/points).
- Correct point-key usage (In/Out/Out1… etc.).
- Correct connector defaults and phase-sensitive conductor/core selection.
- Clean layout and minimal crossing (auto-layout and routing logic help).
- Correct portal semantics for cross-sheet continuity.

## 2. Design Goal

Enable chat mode to perform the same SLD operations as a skilled human by exposing the same manipulation primitives used by the UI, with guardrails, validation, and deterministic behavior.

Success target:
- Chat-driven edits are indistinguishable from UI edits because they go through the same item initialization rules and connector default logic.

## 3. Chosen Architecture (Implemented)

### 3.1 Frontend Tool Orchestrator
Tool calling is implemented client-side in chat mode:
- The LLM calls “tools” (Gemini function calling).
- Each tool is executed in the browser through `ChatService` and the existing SLD store/actions.
- This guarantees the chat operates on the same in-memory state and rules as the UI.

Key modules:
- [ChatService.ts](file:///d:/final%20project/SayanhoWeb/Sayanho.Frontend/src/services/ChatService.ts)
- [ChatPanel.tsx](file:///d:/final%20project/SayanhoWeb/Sayanho.Frontend/src/components/ChatPanel.tsx)
- [ConnectorFactory.ts](file:///d:/final%20project/SayanhoWeb/Sayanho.Frontend/src/utils/ConnectorFactory.ts)
- [DiagramContextBuilder.ts](file:///d:/final%20project/SayanhoWeb/Sayanho.Frontend/src/utils/DiagramContextBuilder.ts)

### 3.2 Tool Interface (LLM → App)
Tools are declared to Gemini in `ChatService.callGemini()` as function declarations. The assistant can now:
- Inspect state:
  - `get_diagram_state_json` (structured IDs/points/connectors)
- Manage sheets:
  - `list_sheets`, `set_active_sheet`, `add_sheet`, `rename_sheet`, `remove_sheet`
- Modify items:
  - `add_item_to_diagram`, `delete_item_from_diagram`
  - `move_items`, `set_item_transform`, `lock_item`, `duplicate_item`
  - `set_item_properties` (simple property layer)
  - `update_item_fields` (advanced DB fields: incomer/outgoing/accessories/alt companies)
- Modify connectors:
  - `connect_items`, `update_connector`, `delete_connector`
- Improve readability:
  - `auto_layout_active_sheet`
- Batch execution:
  - `apply_sld_operations`

### 3.3 Connector Parity Guarantee
To match UI connector creation, connector defaults are centralized in:
- [createConnectorWithDefaults](file:///d:/final%20project/SayanhoWeb/Sayanho.Frontend/src/utils/ConnectorFactory.ts)

This ensures chat-created connectors:
- Pull the same default DB properties for Cable/Wiring.
- Apply the same phase-sensitive dynamic defaults.
- Enforce the same Portal rules (mirror, virtual links, one-connector-per-portal, no portal-to-portal).

### 3.4 State Context for Precision
`get_diagram_state_json` returns deterministic, machine-readable state:
- Sheet IDs, active sheet ID
- Items: full IDs + short IDs, position/size/rotation, connection point keys, properties[0]
- Connectors: sheet-local connector indices and endpoint IDs/point keys, material, properties, virtual flag

This reduces hallucination and enables exact manipulation.

## 4. Safeguards, Validation, and Error Handling

Implemented safeguards:
- ID prefix resolution on the active sheet with ambiguity detection.
- Connection point key validation before connecting.
- Portal constraints:
  - no portal-to-portal direct connections
  - one connector per Portal on a sheet
  - “in Portal” connectors are virtual and mirror properties from counterpart
- Connector updates restrict the writable surface to known-safe fields.
- Missing capability errors when a tool is requested but the runtime cannot support it.

Graceful failure:
- Tools return structured `{ error: string }` without breaking the chat loop.
- `apply_sld_operations` can stop on first error (`stopOnError`).

## 5. Alternatives Considered (and Why Rejected)

### A) Server-side tool executor (backend applies SLD edits)
Pros:
- Centralized validation and audit.
- Stateless clients.
Cons:
- Would duplicate frontend rules (geometry, SVG updates, portal semantics) or risk divergence.
- Higher latency and harder to keep “UI parity”.
Decision: not chosen for parity risk and duplicated logic cost.

### B) “Declarative SLD Patch” DSL (single JSON patch describing full SLD)
Pros:
- Great for batching and speed.
Cons:
- Harder to validate incrementally.
- Harder to reuse existing UI initialization logic.
Decision: partially addressed via `apply_sld_operations`, while keeping primitive tools.

### C) Direct model → store mutation (no validation layer)
Pros:
- Simple implementation.
Cons:
- High risk of invalid IDs/points and broken connectors, and lower output quality.
Decision: not chosen; validation is required for human-level precision.

## 6. QA and Testing Strategy (Implemented + Extendable)

Implemented a structural QA validator exposed as a tool:
- `validate_diagram` checks connector point keys, portal rules, and basic structural invariants.

Recommended extensions:
- Automated unit tests for ID prefix resolution and ambiguity handling.
- Integration tests around multi-sheet Portal pairs and mirroring behavior.
- Golden tests for `get_diagram_state_json` output shape stability.

## 7. Operational Notes

- The chat system prompt is refreshed before each LLM request so the model sees the latest diagram state.
- API keys must be supplied via application settings; no embedded keys are used.

## 8. SLD Connection + Layout Guidance (LLM)

Connection rules:
- Source is the extreme upstream item (place at the top).
- AC Point and Geyser Point connect to HTPN outgoings (dedicated circuits).
- All other electrical loads connect to Point Switch Board out ports (not directly to SPN DB).
- Avg. 5A Switch Board connects to SPN DB (represents a power circuit group).
- Use Point Switch Board for fan-out; each out port feeds only one load.
- Never attach more than one connector to the same connection point key on an item.
- Always fetch actual connection point keys from get_diagram_state_json before connecting.

Layout rules:
- Maintain a top-to-bottom flow: Source → upstream switchgear → distribution boards → switch boards → loads.
- Use columns for rooms/zones (Bedroom-1, Bedroom-2, Bedroom-3, Kitchen, Living, Toilets, Outdoor).
- Keep boards above the devices they feed; prefer straight vertical drops and minimal crossings.
- After building or major edits, run validate_diagram; if messy, use auto_layout_active_sheet.
