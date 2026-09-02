import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "../src/main/external-url.js";

describe("isSafeExternalUrl", () => {
	it.each(["https://example.com/docs", "http://localhost:3000", "mailto:support@example.com"])(
		"allows %s to open outside the desktop app",
		(url) => expect(isSafeExternalUrl(url)).toBe(true),
	);

	it.each(["javascript:alert(1)", "file:///etc/passwd", "not a URL"])("rejects %s", (url) =>
		expect(isSafeExternalUrl(url)).toBe(false),
	);
});
