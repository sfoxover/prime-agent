import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain, protocol, shell } from "electron";
import type { DesktopPromptAttachment, DesktopProviderAuthType } from "../shared/desktop-api.js";
import { DESKTOP_CHANNELS } from "../shared/desktop-api.js";
import { DesktopSessionService } from "./desktop-session-service.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let sessionService: DesktopSessionService | undefined;

protocol.registerSchemesAsPrivileged([
	{
		scheme: "prime-media",
		privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
	},
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireShortString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 160) {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

function requireTrustedSender(event: IpcMainInvokeEvent): void {
	const frame = event.senderFrame;
	if (!frame || frame !== event.sender.mainFrame) throw new Error("IPC request did not come from the main frame");
	const rendererUrl = frame.url;
	if (app.isPackaged) {
		if (!rendererUrl.startsWith("file://")) throw new Error("IPC request came from an unexpected origin");
		return;
	}
	const expectedUrl = process.env.ELECTRON_RENDERER_URL;
	if (!expectedUrl) {
		throw new Error("IPC request came from an unexpected origin");
	}
	try {
		const rendererOrigin = new URL(rendererUrl).origin;
		const expectedOrigin = new URL(expectedUrl).origin;
		if (rendererOrigin === expectedOrigin) return;
		// Allow mismatched loopback hostnames (localhost vs 127.0.0.1) if ports match.
		const isLoopback = (origin: string) => {
			try {
				const u = new URL(origin);
				return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
			} catch {
				return false;
			}
		};
		if (
			isLoopback(rendererOrigin) &&
			isLoopback(expectedOrigin) &&
			new URL(rendererOrigin).port === new URL(expectedOrigin).port
		)
			return;
		throw new Error("IPC request came from an unexpected origin");
	} catch (_err) {
		throw new Error("IPC request came from an unexpected origin");
	}
}

function requireService(event: IpcMainInvokeEvent): DesktopSessionService {
	requireTrustedSender(event);
	if (!sessionService) throw new Error("Desktop session service is not ready");
	return sessionService;
}

function parsePromptInput(value: unknown): {
	sessionId: string;
	text: string;
	attachments: DesktopPromptAttachment[];
	clientRequestId: string;
} {
	if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.attachments)) {
		throw new Error("Invalid prompt request");
	}
	const sessionId = requireShortString(value.sessionId, "session ID");
	const clientRequestId = requireShortString(value.clientRequestId, "client request ID");
	const attachments = value.attachments.map((attachment) => {
		if (!isRecord(attachment)) throw new Error("Invalid attachment");
		return {
			name: requireShortString(attachment.name, "attachment name"),
			mimeType: requireShortString(attachment.mimeType, "attachment MIME type"),
			data: typeof attachment.data === "string" ? attachment.data : "",
		};
	});
	return { sessionId, text: value.text, attachments, clientRequestId };
}

function parseModelInput(value: unknown): { sessionId: string; provider: string; modelId: string } {
	if (!isRecord(value)) throw new Error("Invalid model request");
	return {
		sessionId: requireShortString(value.sessionId, "session ID"),
		provider: requireShortString(value.provider, "provider"),
		modelId: requireShortString(value.modelId, "model ID"),
	};
}

function parseLoginInput(value: unknown): {
	sessionId: string;
	providerId: string;
	authType: Exclude<DesktopProviderAuthType, "external">;
	apiKey?: string;
} {
	if (!isRecord(value) || (value.authType !== "oauth" && value.authType !== "api_key")) {
		throw new Error("Invalid provider login request");
	}
	const apiKey = value.apiKey;
	if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 64_000)) {
		throw new Error("Invalid API key");
	}
	return {
		sessionId: requireShortString(value.sessionId, "session ID"),
		providerId: requireShortString(value.providerId, "provider ID"),
		authType: value.authType,
		...(apiKey ? { apiKey } : {}),
	};
}

function parseAuthInput(value: unknown): { providerId: string; value: string } {
	if (!isRecord(value) || typeof value.value !== "string" || value.value.length > 100_000) {
		throw new Error("Invalid authentication input");
	}
	return {
		providerId: requireShortString(value.providerId, "provider ID"),
		value: value.value,
	};
}

function parseRenameSessionInput(value: unknown): { sessionId: string; name: string } {
	if (!isRecord(value) || typeof value.name !== "string") throw new Error("Invalid rename request");
	const name = value.name.trim();
	if (!name || name.length > 160) throw new Error("Session name must be between 1 and 160 characters");
	return {
		sessionId: requireShortString(value.sessionId, "session ID"),
		name,
	};
}

function registerIpcHandlers(): void {
	ipcMain.handle(DESKTOP_CHANNELS.bootstrap, (event) => requireService(event).getBootstrap());
	ipcMain.handle(DESKTOP_CHANNELS.createSession, (event, requestId: unknown) =>
		requireService(event).createSession(requireShortString(requestId, "client request ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.attachSession, (event, sessionId: unknown) =>
		requireService(event).attachSession(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.detachSession, (event, sessionId: unknown) =>
		requireService(event).detachSession(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.renameSession, (event, input: unknown) =>
		requireService(event).renameSession(parseRenameSessionInput(input)),
	);
	ipcMain.handle(DESKTOP_CHANNELS.deleteSession, (event, sessionId: unknown) =>
		requireService(event).deleteSession(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.clearSessions, (event) => requireService(event).clearSessions());
	ipcMain.handle(DESKTOP_CHANNELS.sendPrompt, (event, input: unknown) =>
		requireService(event).sendPrompt(parsePromptInput(input)),
	);
	ipcMain.handle(DESKTOP_CHANNELS.abort, (event, sessionId: unknown) =>
		requireService(event).abort(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.getModelCatalog, (event, sessionId: unknown) =>
		requireService(event).getModelCatalog(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.setModel, (event, input: unknown) =>
		requireService(event).setModel(parseModelInput(input)),
	);
	ipcMain.handle(DESKTOP_CHANNELS.loginProvider, (event, input: unknown) =>
		requireService(event).loginProvider(parseLoginInput(input)),
	);
	ipcMain.handle(DESKTOP_CHANNELS.submitAuthInput, (event, input: unknown) =>
		requireService(event).submitAuthInput(parseAuthInput(input)),
	);
	ipcMain.handle(DESKTOP_CHANNELS.cancelProviderLogin, (event, providerId: unknown) =>
		requireService(event).cancelProviderLogin(requireShortString(providerId, "provider ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.getGoalState, (event, sessionId: unknown) =>
		requireService(event).getGoalState(requireShortString(sessionId, "session ID")),
	);
	ipcMain.handle(DESKTOP_CHANNELS.getMemories, (event, sessionId: unknown, limit: unknown) =>
		requireService(event).getMemories(requireShortString(sessionId, "session ID"), Number(limit) || 10),
	);
	ipcMain.handle(DESKTOP_CHANNELS.getRecentActivityLog, (event, sessionId: unknown, limit: unknown) =>
		requireService(event).getRecentActivityLog(requireShortString(sessionId, "session ID"), Number(limit) || 20),
	);
}

function getDevelopmentRoot(): string {
	return resolve(app.getAppPath(), "../..");
}

function createSessionService(): DesktopSessionService {
	const developmentRoot = getDevelopmentRoot();
	const cliPath = app.isPackaged
		? join(process.resourcesPath, "prime-agent", "cli.js")
		: join(developmentRoot, "packages/coding-agent/dist/bundle/cli.js");
	if (!existsSync(cliPath)) {
		throw new Error(`Prime Agent daemon entrypoint was not found at ${cliPath}`);
	}
	const cwd = process.env.PRIME_AGENT_DESKTOP_CWD ? resolve(process.env.PRIME_AGENT_DESKTOP_CWD) : developmentRoot;
	return new DesktopSessionService({
		cliPath,
		cwd,
		executablePath: process.execPath,
		openExternal: (url) => shell.openExternal(url),
	});
}

function getDevelopmentRendererUrl(): string | undefined {
	if (app.isPackaged) return undefined;
	const value = process.env.ELECTRON_RENDERER_URL;
	if (!value) return undefined;
	const url = new URL(value);
	if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
		throw new Error("Electron renderer URL must use a loopback HTTP origin");
	}
	return url.toString();
}

function parseByteRange(value: string, length: number): { start: number; end: number } | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!match) return undefined;
	const startText = match[1] ?? "";
	const endText = match[2] ?? "";
	if (!startText && !endText) return undefined;
	if (!startText) {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
		return { start: Math.max(0, length - suffixLength), end: length - 1 };
	}
	const start = Number(startText);
	const requestedEnd = endText ? Number(endText) : length - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= length)
		return undefined;
	return { start, end: Math.min(requestedEnd, length - 1) };
}

function handleMediaRequest(request: Request): Response {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	const url = new URL(request.url);
	const id = url.hostname === "attachment" ? url.pathname.slice(1) : "";
	if (!/^[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 404 });
	const asset = sessionService?.mediaStore.get(id);
	if (!asset) return new Response(null, { status: 404 });
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, max-age=300",
		"Content-Type": asset.mimeType,
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	});
	const requestedRange = request.headers.get("range");
	const range = requestedRange ? parseByteRange(requestedRange, asset.data.byteLength) : undefined;
	if (requestedRange && !range) {
		headers.set("Content-Range", `bytes */${asset.data.byteLength}`);
		return new Response(null, { status: 416, headers });
	}
	if (range) {
		const body = request.method === "HEAD" ? null : asset.data.slice(range.start, range.end + 1);
		headers.set("Content-Length", String(range.end - range.start + 1));
		headers.set("Content-Range", `bytes ${range.start}-${range.end}/${asset.data.byteLength}`);
		return new Response(body, { status: 206, headers });
	}
	headers.set("Content-Length", String(asset.data.byteLength));
	return new Response(request.method === "HEAD" ? null : asset.data, { status: 200, headers });
}

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		show: false,
		backgroundColor: "#0d1117",
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(currentDirectory, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});

	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.session.setPermissionCheckHandler(() => false);
	window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	window.once("ready-to-show", () => window.show());

	const unsubscribe = sessionService?.subscribe((event) => {
		if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.event, event);
	});
	window.once("closed", () => unsubscribe?.());

	const rendererUrl = getDevelopmentRendererUrl();
	if (rendererUrl) {
		void window.loadURL(rendererUrl);
	} else {
		void window.loadFile(join(currentDirectory, "../renderer/index.html"));
	}

	return window;
}

void app.whenReady().then(() => {
	sessionService = createSessionService();
	void protocol.handle("prime-media", handleMediaRequest);
	registerIpcHandlers();
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("before-quit", () => {
	void sessionService?.dispose();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
