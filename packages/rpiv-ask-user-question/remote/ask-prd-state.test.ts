import { beforeEach, describe, expect, it } from "vitest";
import { isAskPrdActive, resetAskPrdState, setAskPrdEnabled } from "./ask-prd-state.js";

describe("ask-prd-state", () => {
	beforeEach(() => {
		resetAskPrdState();
	});

	it("starts disabled for every session", () => {
		expect(isAskPrdActive("session-a")).toBe(false);
		expect(isAskPrdActive(undefined)).toBe(false);
	});

	it("enables ask-prd only for the session it was enabled on", () => {
		setAskPrdEnabled("session-a", true);
		expect(isAskPrdActive("session-a")).toBe(true);
		expect(isAskPrdActive("session-b")).toBe(false);
		expect(isAskPrdActive(undefined)).toBe(false);
	});

	it("turns off when disabled", () => {
		setAskPrdEnabled("session-a", true);
		setAskPrdEnabled("session-a", false);
		expect(isAskPrdActive("session-a")).toBe(false);
	});

	it("re-enabling on another session does not leak to the previous one", () => {
		setAskPrdEnabled("session-a", true);
		setAskPrdEnabled("session-b", true);
		expect(isAskPrdActive("session-a")).toBe(false);
		expect(isAskPrdActive("session-b")).toBe(true);
	});

	it("resetAskPrdState clears any prior enable", () => {
		setAskPrdEnabled("session-a", true);
		resetAskPrdState();
		expect(isAskPrdActive("session-a")).toBe(false);
	});
});
