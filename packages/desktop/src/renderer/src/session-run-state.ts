import type { DesktopRenderMessage, DesktopSessionSummary } from "../../shared/desktop-api.js";

interface SessionRunSnapshot {
	messages: readonly Pick<DesktopRenderMessage, "status">[];
}

export function isDesktopSessionRunning(
	summary: Pick<DesktopSessionSummary, "runState"> | undefined,
	snapshot: SessionRunSnapshot | undefined,
): boolean {
	if (summary?.runState === "error") return false;
	return (
		summary?.runState === "running" ||
		summary?.runState === "aborting" ||
		snapshot?.messages.some((message) => message.status === "streaming") === true
	);
}
