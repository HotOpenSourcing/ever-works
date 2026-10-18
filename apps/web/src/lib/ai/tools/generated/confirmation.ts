/**
 * Security (prompt-injection hardening) — WHO confirmed a gated tool call.
 *
 * The factory's confirmation handshake used to trust the model alone: a gated
 * tool ran as soon as the model passed `confirmed: true`. The system prompt
 * says "only after the user agrees", but the same turn can contain tool output
 * the user never wrote (an email, an ingested event, a KB document, another
 * person's task-chat message) — and text in that output can tell the model to
 * pass `confirmed: true` straight away.
 *
 * So the flag is now honoured only when the CURRENT user turn — the human's
 * own message that started this streamText call, which no tool output can
 * change — actually confirms:
 *
 *   - the Confirm button on the card sends
 *     "Yes, I confirm — proceed with <tool_name> …" → confirms exactly that tool;
 *   - a short typed affirmative ("yes", "go ahead", "confirm") → confirms
 *     whatever the assistant just asked about.
 *
 * Anything else re-shows the confirmation card, so a refused call costs the
 * user one click, never a dead end.
 */

/** Max length of a typed message still read as a bare "yes". */
const MAX_AFFIRMATIVE_LENGTH = 120;

const AFFIRMATIVE_RE =
    /^(?:yes|yep|yeah|yup|y|sure|ok|okay|confirm(?:ed)?|i confirm|go ahead|go for it|do it|proceed|approved?|please do|absolutely|affirmative)\b/i;

/** The Confirm button's message names the exact tool (see `ConfirmCard`). */
const CARD_CONFIRM_RE = /\bproceed with ([a-z][a-z0-9_]{0,79})\b/i;

export type UserConfirmationCheck = (toolName: string) => boolean;

/**
 * Build the per-turn check from the latest user message's text. `null` /
 * empty text (no user turn) confirms nothing.
 */
export function createUserConfirmationCheck(latestUserText: string | null | undefined): UserConfirmationCheck {
    const text = (latestUserText ?? '').trim();
    if (!text) return () => false;

    const card = CARD_CONFIRM_RE.exec(text);
    if (card && /^yes,?\s+i confirm/i.test(text)) {
        const confirmedTool = card[1].toLowerCase();
        return (toolName) => toolName.toLowerCase() === confirmedTool;
    }

    const affirmative = text.length <= MAX_AFFIRMATIVE_LENGTH && AFFIRMATIVE_RE.test(text);
    return () => affirmative;
}
