import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import * as React from "react";

interface MarkdownContentProps {
	text: string;
}

function isMarkedToken(token: Token): token is MarkedToken {
	switch (token.type) {
		case "blockquote":
		case "br":
		case "checkbox":
		case "code":
		case "codespan":
		case "def":
		case "del":
		case "em":
		case "escape":
		case "heading":
		case "hr":
		case "html":
		case "image":
		case "link":
		case "list":
		case "list_item":
		case "paragraph":
		case "space":
		case "strong":
		case "table":
		case "text":
			return true;
		default:
			return false;
	}
}

function safeLinkHref(href: string): string | undefined {
	if (href.startsWith("#")) return href;
	if (/^(https?:|mailto:)/i.test(href)) return href;
	return undefined;
}

function safeImageSource(source: string): string | undefined {
	if (/^https?:/i.test(source)) return source;
	return undefined;
}

function renderHeading(token: Tokens.Heading, key: string): React.ReactNode {
	const content = renderTokens(token.tokens, key);
	switch (token.depth) {
		case 1:
			return <h1 key={key}>{content}</h1>;
		case 2:
			return <h2 key={key}>{content}</h2>;
		case 3:
			return <h3 key={key}>{content}</h3>;
		case 4:
			return <h4 key={key}>{content}</h4>;
		case 5:
			return <h5 key={key}>{content}</h5>;
		default:
			return <h6 key={key}>{content}</h6>;
	}
}

function renderListItems(items: Tokens.ListItem[], scope: string): React.ReactNode[] {
	let offset = 0;
	return items.map((item) => {
		const key = `${scope}:${offset}`;
		offset += Math.max(1, item.raw.length);
		return (
			<li className={item.task ? "markdown-task-item" : undefined} key={key}>
				{item.task ? (
					<input aria-label="Task status" checked={item.checked ?? false} disabled type="checkbox" />
				) : null}
				{renderTokens(item.tokens, key)}
			</li>
		);
	});
}

function renderTableCells(cells: Tokens.TableCell[], scope: string, header: boolean): React.ReactNode[] {
	let offset = 0;
	return cells.map((cell) => {
		const key = `${scope}:${offset}`;
		offset += Math.max(1, cell.text.length);
		const content = renderTokens(cell.tokens, key);
		const style = cell.align ? { textAlign: cell.align } : undefined;
		return header ? (
			<th key={key} style={style}>
				{content}
			</th>
		) : (
			<td key={key} style={style}>
				{content}
			</td>
		);
	});
}

function renderTableRows(rows: Tokens.TableCell[][], scope: string): React.ReactNode[] {
	let offset = 0;
	return rows.map((row) => {
		const key = `${scope}:${offset}`;
		offset += Math.max(
			1,
			row.reduce((length, cell) => length + cell.text.length, 0),
		);
		return <tr key={key}>{renderTableCells(row, key, false)}</tr>;
	});
}

function renderToken(token: Token, key: string): React.ReactNode {
	if (!isMarkedToken(token)) return token.raw;

	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "hr":
			return <hr key={key} />;
		case "br":
			return <br key={key} />;
		case "code": {
			const language = token.lang?.match(/^[\w-]+/)?.[0];
			return (
				<pre key={key}>
					<code className={language ? `language-${language}` : undefined}>{token.text}</code>
				</pre>
			);
		}
		case "codespan":
			return <code key={key}>{token.text}</code>;
		case "heading":
			return renderHeading(token, key);
		case "paragraph":
			return <p key={key}>{renderTokens(token.tokens, key)}</p>;
		case "blockquote":
			return <blockquote key={key}>{renderTokens(token.tokens, key)}</blockquote>;
		case "strong":
			return <strong key={key}>{renderTokens(token.tokens, key)}</strong>;
		case "em":
			return <em key={key}>{renderTokens(token.tokens, key)}</em>;
		case "del":
			return <del key={key}>{renderTokens(token.tokens, key)}</del>;
		case "escape":
			return token.text;
		case "text":
			return token.tokens ? renderTokens(token.tokens, key) : token.text;
		case "html":
			return (
				<span className="markdown-raw-html" key={key}>
					{token.text}
				</span>
			);
		case "link": {
			const href = safeLinkHref(token.href);
			const content = renderTokens(token.tokens, key);
			return href ? (
				<a
					href={href}
					key={key}
					rel="noreferrer"
					target={href.startsWith("#") ? undefined : "_blank"}
					title={token.title ?? undefined}
				>
					{content}
				</a>
			) : (
				<span className="markdown-unsafe-link" key={key}>
					{content}
				</span>
			);
		}
		case "image": {
			const source = safeImageSource(token.href);
			return source ? (
				<img alt={token.text} key={key} loading="lazy" src={source} title={token.title ?? undefined} />
			) : (
				<span className="markdown-unsafe-link" key={key}>
					{token.text}
				</span>
			);
		}
		case "checkbox":
			return <input aria-label="Task status" checked={token.checked} disabled key={key} type="checkbox" />;
		case "list_item":
			return <li key={key}>{renderTokens(token.tokens, key)}</li>;
		case "list": {
			const items = renderListItems(token.items, key);
			return token.ordered ? (
				<ol key={key} start={token.start === "" ? undefined : token.start}>
					{items}
				</ol>
			) : (
				<ul key={key}>{items}</ul>
			);
		}
		case "table":
			return (
				<div className="markdown-table-scroll" key={key}>
					<table>
						<thead>
							<tr>{renderTableCells(token.header, `${key}:header`, true)}</tr>
						</thead>
						<tbody>{renderTableRows(token.rows, `${key}:body`)}</tbody>
					</table>
				</div>
			);
	}
}

function renderTokens(tokens: Token[], scope: string): React.ReactNode[] {
	let offset = 0;
	return tokens.map((token) => {
		const key = `${scope}:${offset}`;
		offset += Math.max(1, token.raw.length);
		return renderToken(token, key);
	});
}

export function MarkdownContent({ text }: MarkdownContentProps) {
	return React.createElement(
		"div",
		{ className: "markdown-content" },
		renderTokens(lexer(text, { gfm: true }), "markdown"),
	);
}
