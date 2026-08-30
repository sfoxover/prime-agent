import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../src/renderer/src/MarkdownContent.js";

describe("MarkdownContent", () => {
	it("renders common Markdown formatting", () => {
		const output = renderToStaticMarkup(
			<MarkdownContent text={'## Heading\n\nA **bold** paragraph.\n\n> Quoted\n\n- One\n- Two\n\n`code`'} />,
		);

		expect(output).toContain("<h2>Heading</h2>");
		expect(output).toContain("<strong>bold</strong>");
		expect(output).toContain("<blockquote>");
		expect(output).toContain("<ul>");
		expect(output).toContain("<code>code</code>");
	});

	it("renders raw HTML as text instead of injecting it", () => {
		const output = renderToStaticMarkup(<MarkdownContent text={'<script>alert("unsafe")</script>'} />);

		expect(output).not.toContain("<script>");
		expect(output).toContain("&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;");
	});

	it("does not create links for unsafe protocols", () => {
		const output = renderToStaticMarkup(<MarkdownContent text="[unsafe](javascript:alert(1))" />);

		expect(output).not.toContain("href=");
		expect(output).toContain("unsafe");
	});
});
