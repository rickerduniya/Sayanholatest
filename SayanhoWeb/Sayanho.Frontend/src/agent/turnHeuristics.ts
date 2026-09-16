// Heuristics about the shape of an agent turn.
//
// Kept out of ChatService so they can be tested directly: these decide whether to
// spend another model round trip, and getting them wrong is either a stalled run
// or a wasted request.

/**
 * Did the model end its turn describing work it never carried out?
 *
 * The failure this exists for: an agent mid-design writes "Placing the decided
 * loads for the merged living region, the kitchen and BATH-03…", emits no tool
 * calls, and the provider returns finish_reason: stop. From the user's side the
 * agent silently abandoned the job with a third of the rooms unplaced.
 *
 * Only the tail of the message is examined. A model about to act says so in its
 * closing sentence; earlier prose is narration of work that already happened. A
 * genuine wrap-up reports in the past tense and names the verification it ran,
 * and must not trip this — nudging a finished agent burns a round trip.
 */
export function looksUnfinished(text: string): boolean {
    const s = (text || '').trim();

    // Silence with no tool call is never a real answer.
    if (!s) return true;

    // A real wrap-up names the verification it performed.
    if (/\b(layout_validate|validate_diagram|analyze_diagram|get_phase_balance)\b/.test(s)) {
        return false;
    }

    const tail = s.slice(-240);

    // "Now I'll wire…", "Next, placing…"
    const announcingNext =
        /\b(now|next|then)\b[^.!?]{0,60}\b(I['’]?l{1,2}|I will|I am going to|let me|placing|adding|wiring|connecting|generating|building|sizing|fixing|verifying|getting|pulling)\b/i;

    // A sentence that opens with a gerund and closes the message:
    // "Placing the loads for the kitchen and BATH-03."
    // The opener may follow a sentence end, a newline, or markdown emphasis —
    // models routinely prefix these with a "**Reasoning**" block.
    const gerundOpener =
        /(^|[.!?]\s+|\n\s*|\*\*\s*)(placing|adding|wiring|connecting|generating|building|sizing|fixing|re-?homing|pulling|getting|fetching)\b[^.!?]*\.?\s*$/i;

    // "Let me…", "I'll…", "I am going to…"
    const explicitIntent = /\b(let me|I['’]?l{1,2}|I will|I am going to|I'm going to)\b/i;

    return announcingNext.test(tail) || gerundOpener.test(tail) || explicitIntent.test(tail);
}
