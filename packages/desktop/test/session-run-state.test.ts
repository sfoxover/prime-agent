import { describe, expect, it } from "vitest";
import { isDesktopSessionRunning } from "../src/renderer/src/session-run-state.js";

describe("isDesktopSessionRunning", () => {
	it("shows Stop when a prompt starts", () => {
		expect(isDesktopSessionRunning({ runState: "running" }, { messages: [] })).toBe(true);
	});

	it("keeps Stop visible while a streamed response is active", () => {
		expect(isDesktopSessionRunning({ runState: "idle" }, { messages: [{ status: "streaming" }] })).toBe(true);
	});

	it("keeps Stop visible while cancellation is pending", () => {
		expect(isDesktopSessionRunning({ runState: "aborting" }, { messages: [{ status: "complete" }] })).toBe(true);
	});

	it("returns to Send when the prompt finishes", () => {
		expect(isDesktopSessionRunning({ runState: "idle" }, { messages: [{ status: "complete" }] })).toBe(false);
	});

	it("returns to Send after an error", () => {
		expect(isDesktopSessionRunning({ runState: "error" }, { messages: [{ status: "error" }] })).toBe(false);
	});

	it("does not let a stale streaming message override a session error", () => {
		expect(isDesktopSessionRunning({ runState: "error" }, { messages: [{ status: "streaming" }] })).toBe(false);
	});
});
