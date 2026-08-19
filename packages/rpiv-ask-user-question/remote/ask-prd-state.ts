/**
 * Session-scoped `ask-prd` toggle state.
 *
 * Unlike the Feishu `remote.enabled` flag (persisted in config.json), `ask-prd`
 * is a session-level mode: it lives in memory only, is keyed by the pi session
 * id, and is reset on every `session_start` so a new session always starts
 * with it off. Nothing here writes to config.json.
 */

interface AskPrdState {
	sessionId: string | null;
	enabled: boolean;
}

let state: AskPrdState = { sessionId: null, enabled: false };

/** Reset to the default (off) state. Called on `session_start`. */
export function resetAskPrdState(): void {
	state = { sessionId: null, enabled: false };
}

/** Record whether `ask-prd` is on for a specific session. */
export function setAskPrdEnabled(sessionId: string, enabled: boolean): void {
	state = { sessionId, enabled };
}

/** True only when `ask-prd` was enabled for THIS session id; any other/undefined id reads as off. */
export function isAskPrdActive(sessionId: string | undefined): boolean {
	return state.enabled && sessionId !== undefined && sessionId === state.sessionId;
}
