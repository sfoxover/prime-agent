import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
	type AgentConnectionEvent,
	type AgentConnectionModel,
	type AgentConnectionSnapshot,
	AuthStorage,
	BUILT_IN_PROVIDER_DISPLAY_NAMES,
	DaemonAgentConnection,
	DaemonClient,
	type DaemonLaunchTarget,
	defaultDaemonSocketPath,
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	type SessionSummary,
	SettingsManager,
} from "@earendil-works/pi-coding-agent/desktop";
import type {
	DesktopAuthFlowState,
	DesktopBootstrap,
	DesktopEvent,
	DesktopEventEnvelope,
	DesktopModelCatalog,
	DesktopPromptAttachment,
	DesktopProviderAuthType,
	DesktopRenderBlock,
	DesktopRenderMessage,
	DesktopSessionSnapshot,
	DesktopSessionSummary,
	ToolRunStatus,
} from "../shared/desktop-api.js";
import { DESKTOP_PROTOCOL_VERSION } from "../shared/desktop-api.js";
import { DesktopMediaStore } from "./desktop-media-store.js";

const MAX_PROMPT_CHARS = 100_000;
const MAX_ATTACHMENT_BASE64_CHARS = 12_000_000;
const MAX_RENDER_TEXT_CHARS = 200_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const EXTERNAL_AUTH_PROVIDERS = new Set(["amazon-bedrock"]);

interface ManagedSession {
	connection: DaemonAgentConnection;
	generation: string;
	sequence: number;
	summary: DesktopSessionSummary;
	toolStatuses: Map<string, ToolRunStatus>;
	unsubscribe: () => void;
}

export interface DesktopSessionServiceOptions {
	cliPath: string;
	cwd: string;
	executablePath: string;
	openExternal: (url: string) => Promise<void>;
}

interface PendingAuthInput {
	providerId: string;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

interface ActiveAuthFlow {
	providerId: string;
	controller: AbortController;
	pendingInput?: PendingAuthInput;
}

type DesktopEventListener = (event: DesktopEventEnvelope) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clampText(value: string): string {
	return value.length <= MAX_RENDER_TEXT_CHARS
		? value
		: `${value.slice(0, MAX_RENDER_TEXT_CHARS)}
…`;
}

function displayTitle(summary: SessionSummary): string {
	const candidate = summary.sessionName?.trim() || summary.firstMessage?.trim() || "New session";
	const firstLine = candidate.split(/\r?\n/, 1)[0] ?? "New session";
	return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}…`;
}

function toSessionSummary(
	summary: SessionSummary,
	runState?: DesktopSessionSummary["runState"],
): DesktopSessionSummary {
	return {
		id: summary.sessionId,
		title: displayTitle(summary),
		cwdLabel: basename(summary.cwd) || summary.cwd,
		updatedAt: summary.modified ?? summary.lastActivityAt ?? summary.created ?? new Date().toISOString(),
		runState: runState ?? (summary.isStreaming || summary.isCompacting ? "running" : "idle"),
		unread: false,
	};
}

export class DesktopSessionService {
	readonly mediaStore = new DesktopMediaStore();
	private readonly connections = new Map<string, ManagedSession>();
	private readonly listeners = new Set<DesktopEventListener>();
	private readonly requestResults = new Map<string, Promise<DesktopSessionSnapshot>>();
	private readonly promptResults = new Map<string, Promise<{ accepted: true }>>();
	private readonly socketPath = defaultDaemonSocketPath();
	private readonly authStorage = AuthStorage.create();
	private activeAuthFlow: ActiveAuthFlow | undefined;
	private authSequence = 0;
	private catalogSequence = 0;

	constructor(private readonly options: DesktopSessionServiceOptions) {}

	subscribe(listener: DesktopEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getBootstrap(): Promise<DesktopBootstrap> {
		const sessions = await this.listSessions();
		const settings = SettingsManager.create(this.options.cwd);
		const defaultProvider = settings.getDefaultProvider();
		const defaultModel = settings.getDefaultModel();
		return {
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			sessions,
			defaultCwdLabel: basename(this.options.cwd) || this.options.cwd,
			...(defaultProvider && defaultModel ? { defaultModelLabel: `${defaultProvider}/${defaultModel}` } : {}),
		};
	}

	createSession(clientRequestId: string): Promise<DesktopSessionSnapshot> {
		const existing = this.requestResults.get(clientRequestId);
		if (existing) return existing;
		const request = this.createAndAttach().finally(() => {
			if (this.requestResults.size > 100) this.requestResults.delete(this.requestResults.keys().next().value ?? "");
		});
		this.requestResults.set(clientRequestId, request);
		return request;
	}

	// Lightweight context APIs: return placeholders until richer implementations exist.
	async getGoalState(_sessionId: string): Promise<null> {
		// TODO: Implement goal tracking via daemon events. Return null for now.
		return null;
	}

	async getMemories(_sessionId: string, _limit: number): Promise<[]> {
		// TODO: Implement memory retrieval. Return empty list for now.
		return [];
	}

	async getRecentActivityLog(_sessionId: string, _limit: number): Promise<[]> {
		// TODO: Implement activity log retrieval from agent events/tools. Return empty list for now.
		return [];
	}

	async attachSession(sessionId: string): Promise<DesktopSessionSnapshot> {
		const managed = this.connections.get(sessionId);
		if (managed) return this.snapshotFor(managed);

		const summaries = await this.listRawSessions();
		const summary = summaries.find((candidate) => candidate.sessionId === sessionId);
		if (!summary) throw new Error("Session was not found");
		return this.attachSummary(summary);
	}

	async detachSession(sessionId: string): Promise<void> {
		const managed = this.connections.get(sessionId);
		if (!managed) return;
		this.connections.delete(sessionId);
		managed.unsubscribe();
		await managed.connection.dispose();
	}

	async renameSession(input: { sessionId: string; name: string }): Promise<DesktopSessionSummary> {
		const name = input.name.trim();
		if (!name) throw new Error("Session name is required");
		const summaries = await this.listRawSessions();
		const summary = summaries.find((candidate) => candidate.sessionId === input.sessionId);
		if (!summary) throw new Error("Session was not found");
		const managed = this.connections.get(input.sessionId);
		if (managed) {
			await managed.connection.setSessionName(name);
			managed.summary = { ...managed.summary, title: name, updatedAt: new Date().toISOString() };
			this.emitSession(managed);
		} else {
			await this.ensureDaemon();
			const client = new DaemonClient(this.socketPath);
			await client.connect();
			let renameConnection: DaemonAgentConnection | undefined;
			try {
				if (summary.activeSessionId) {
					renameConnection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
						closeClientOnDispose: false,
						supportsExtensionUi: false,
					});
					await renameConnection.setSessionName(name);
				} else if (summary.sessionFile) {
					const response = await client.request({
						type: "rename_saved_session",
						sessionPath: summary.sessionFile,
						name,
					});
					if (!response.success) throw new Error(response.error);
				} else {
					throw new Error("Session cannot be renamed");
				}
			} finally {
				await renameConnection?.dispose().catch(() => undefined);
				client.close();
			}
		}
		const renamed = { ...toSessionSummary(summary), title: name, updatedAt: new Date().toISOString() };
		await this.emitCatalog();
		return renamed;
	}

	async deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
		const summaries = await this.listRawSessions();
		const summary = summaries.find((candidate) => candidate.sessionId === sessionId);
		if (!summary) return { deleted: false };
		await this.deleteSessionSummary(summary);
		await this.emitCatalog();
		return { deleted: true };
	}

	async clearSessions(): Promise<{ deleted: number }> {
		const summaries = await this.listRawSessions();
		let deleted = 0;
		const failures: string[] = [];
		for (const summary of summaries) {
			try {
				await this.deleteSessionSummary(summary);
				deleted++;
			} catch (error) {
				failures.push(`${displayTitle(summary)}: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
		await this.emitCatalog();
		if (failures.length > 0) {
			throw new Error(
				`Cleared ${deleted} sessions; ${failures.length} could not be cleared (${failures.join("; ")})`,
			);
		}
		return { deleted };
	}

	sendPrompt(input: {
		sessionId: string;
		text: string;
		attachments: DesktopPromptAttachment[];
		clientRequestId: string;
	}): Promise<{ accepted: true }> {
		const existing = this.promptResults.get(input.clientRequestId);
		if (existing) return existing;
		const request = this.sendPromptOnce(input);
		this.promptResults.set(input.clientRequestId, request);
		if (this.promptResults.size > 500) this.promptResults.delete(this.promptResults.keys().next().value ?? "");
		return request;
	}

	private async sendPromptOnce(input: {
		sessionId: string;
		text: string;
		attachments: DesktopPromptAttachment[];
	}): Promise<{ accepted: true }> {
		const managed = this.connections.get(input.sessionId);
		if (!managed) throw new Error("Attach the session before sending a prompt");
		const text = input.text.trim();
		if (text.length > MAX_PROMPT_CHARS) throw new Error("Prompt is too long");
		if (!text && input.attachments.length === 0) throw new Error("Prompt is empty");
		if (input.attachments.length > 8) throw new Error("Too many attachments");
		const images = input.attachments.map((attachment) => this.validateImage(attachment));
		managed.summary = { ...managed.summary, runState: "running", updatedAt: new Date().toISOString() };
		this.emitSession(managed);
		try {
			await managed.connection.prompt(text, { images, queueIfBusy: true });
		} catch (error) {
			managed.summary = { ...managed.summary, runState: "error" };
			this.emitSession(managed);
			throw error;
		}
		return { accepted: true };
	}

	async abort(sessionId: string): Promise<{ accepted: boolean }> {
		const managed = this.connections.get(sessionId);
		if (!managed) return { accepted: false };
		managed.summary = { ...managed.summary, runState: "aborting" };
		this.emitSession(managed);
		await managed.connection.abort();
		return { accepted: true };
	}

	async getModelCatalog(sessionId: string): Promise<DesktopModelCatalog> {
		const managed = this.requireManagedSession(sessionId);
		const catalog = await managed.connection.getModelCatalog();
		return this.toDesktopModelCatalog(catalog.models, catalog.configuredProviders);
	}

	async setModel(input: { sessionId: string; provider: string; modelId: string }): Promise<DesktopSessionSnapshot> {
		const managed = this.requireManagedSession(input.sessionId);
		const model = await managed.connection.setModel(input.provider, input.modelId);
		const snapshot = await this.snapshotFor(managed);
		snapshot.modelLabel = `${model.provider}/${model.id}`;
		this.emit(managed, { type: "snapshot_replaced", snapshot });
		return snapshot;
	}

	async loginProvider(input: {
		sessionId: string;
		providerId: string;
		authType: Exclude<DesktopProviderAuthType, "external">;
		apiKey?: string;
	}): Promise<DesktopModelCatalog> {
		this.requireManagedSession(input.sessionId);
		if (input.authType === "api_key") {
			if (!input.apiKey?.trim()) throw new Error("API key is required");
			this.authStorage.drainErrors();
			this.authStorage.set(input.providerId, { type: "api_key", key: input.apiKey.trim() });
			const [storageError] = this.authStorage.drainErrors();
			if (storageError) throw storageError;
			this.emitAuth({ providerId: input.providerId, status: "success" });
		} else {
			await this.runOAuthLogin(input.providerId);
		}
		return this.getModelCatalog(input.sessionId);
	}

	submitAuthInput(input: { providerId: string; value: string }): { accepted: true } {
		const flow = this.activeAuthFlow;
		const pending = flow?.pendingInput;
		if (!flow || flow.providerId !== input.providerId || !pending) {
			throw new Error("No authentication input is pending for this provider");
		}
		flow.pendingInput = undefined;
		pending.resolve(input.value);
		return { accepted: true };
	}

	cancelProviderLogin(providerId: string): { cancelled: boolean } {
		const flow = this.activeAuthFlow;
		if (!flow || flow.providerId !== providerId) return { cancelled: false };
		flow.controller.abort();
		flow.pendingInput?.reject(new Error("Login cancelled"));
		flow.pendingInput = undefined;
		this.emitAuth({ providerId, status: "cancelled" });
		return { cancelled: true };
	}

	async dispose(): Promise<void> {
		if (this.activeAuthFlow) this.cancelProviderLogin(this.activeAuthFlow.providerId);
		const managed = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(
			managed.map(async (entry) => {
				entry.unsubscribe();
				await entry.connection.dispose();
			}),
		);
		this.listeners.clear();
		this.mediaStore.clear();
	}

	private requireManagedSession(sessionId: string): ManagedSession {
		const managed = this.connections.get(sessionId);
		if (!managed) throw new Error("Attach the session before selecting a model");
		return managed;
	}

	private async deleteSessionSummary(summary: SessionSummary): Promise<void> {
		const managed = this.connections.get(summary.sessionId);
		if (managed) {
			this.connections.delete(summary.sessionId);
			managed.unsubscribe();
			await managed.connection.dispose();
		}

		await this.ensureDaemon();
		const client = new DaemonClient(this.socketPath);
		await client.connect();
		let deletionConnection: DaemonAgentConnection | undefined;
		try {
			if (summary.activeSessionId) {
				deletionConnection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
					closeClientOnDispose: false,
					supportsExtensionUi: false,
				});
				const response = await client.request({ type: "kill", activeSessionId: summary.activeSessionId });
				if (!response.success) throw new Error(response.error);
			}

			if (!summary.sessionFile) return;
			const response = await client.request({ type: "delete_saved_session", sessionPath: summary.sessionFile });
			if (!response.success) throw new Error(response.error);
			if (!isRecord(response.data) || response.data.ok !== true) {
				const message = isRecord(response.data) ? asString(response.data.error) : undefined;
				throw new Error(message ?? "Could not delete the session transcript");
			}
		} finally {
			await deletionConnection?.dispose().catch(() => undefined);
			client.close();
		}
	}

	private toDesktopModelCatalog(models: AgentConnectionModel[], configuredProviderIds: string[]): DesktopModelCatalog {
		const configuredProviders = new Set(configuredProviderIds);
		const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
		const modelCounts = new Map<string, number>();
		for (const model of models) modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
		const providers = [...modelCounts.entries()]
			.map(([id, modelCount]) => {
				const oauthProvider = oauthProviders.get(id);
				const authTypes: DesktopProviderAuthType[] = EXTERNAL_AUTH_PROVIDERS.has(id)
					? ["external"]
					: [
							...(oauthProvider ? (["oauth"] as const) : []),
							...(!oauthProvider || BUILT_IN_PROVIDER_DISPLAY_NAMES[id] ? (["api_key"] as const) : []),
						];
				return {
					id,
					name: oauthProvider?.name ?? BUILT_IN_PROVIDER_DISPLAY_NAMES[id] ?? id,
					authTypes,
					configured: configuredProviders.has(id),
					modelCount,
				};
			})
			.sort((left, right) => {
				if (left.configured !== right.configured) return left.configured ? -1 : 1;
				return left.name.localeCompare(right.name);
			});
		return {
			models: models
				.map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
			providers,
		};
	}

	private async runOAuthLogin(providerId: string): Promise<void> {
		if (this.activeAuthFlow) throw new Error(`Login already in progress for ${this.activeAuthFlow.providerId}`);
		const provider = this.authStorage.getOAuthProviders().find((candidate) => candidate.id === providerId);
		if (!provider) throw new Error(`OAuth login is not available for ${providerId}`);
		const flow: ActiveAuthFlow = { providerId, controller: new AbortController() };
		this.activeAuthFlow = flow;
		try {
			const loginPromise = provider.login({
				onAuth: (info) => {
					const url = new URL(info.url);
					if (url.protocol !== "https:") throw new Error("Authentication URL must use HTTPS");
					this.emitAuth({ providerId, status: "opening_browser", instructions: info.instructions });
					void this.options.openExternal(url.toString()).catch((error: unknown) => {
						this.emitAuth({
							providerId,
							status: "error",
							message: error instanceof Error ? error.message : "Could not open the sign-in page",
						});
					});
				},
				onPrompt: (prompt) =>
					this.requestAuthInput(providerId, {
						message: prompt.message,
						placeholder: prompt.placeholder,
						allowEmpty: prompt.allowEmpty ?? false,
					}),
				onProgress: (message) => this.emitAuth({ providerId, status: "progress", message }),
				onManualCodeInput: provider.usesCallbackServer
					? () =>
							this.requestAuthInput(providerId, {
								message: "Paste the authorization code or final redirect URL if browser login does not finish",
								allowEmpty: false,
							})
					: undefined,
				onSelect: (prompt) =>
					this.requestAuthInput(providerId, {
						message: prompt.message,
						allowEmpty: false,
						options: prompt.options,
					}),
				signal: flow.controller.signal,
			});
			const credentials = await this.raceWithAbort(loginPromise, flow.controller.signal);
			if (flow.controller.signal.aborted) throw new Error("Login cancelled");
			this.authStorage.drainErrors();
			this.authStorage.set(providerId, { type: "oauth", ...credentials });
			const [storageError] = this.authStorage.drainErrors();
			if (storageError) throw storageError;
			this.emitAuth({ providerId, status: "success" });
		} catch (error) {
			if (!flow.controller.signal.aborted) {
				this.emitAuth({
					providerId,
					status: "error",
					message: error instanceof Error ? error.message : "Login failed",
				});
			}
			throw error;
		} finally {
			flow.pendingInput?.reject(new Error("Authentication input is no longer needed"));
			if (this.activeAuthFlow === flow) this.activeAuthFlow = undefined;
		}
	}

	private requestAuthInput(
		providerId: string,
		state: Omit<Extract<DesktopAuthFlowState, { status: "input_required" }>, "providerId" | "status">,
	): Promise<string> {
		const flow = this.activeAuthFlow;
		if (!flow || flow.providerId !== providerId || flow.controller.signal.aborted) {
			return Promise.reject(new Error("Login cancelled"));
		}
		flow.pendingInput?.reject(new Error("Authentication input was replaced"));
		this.emitAuth({ providerId, status: "input_required", ...state });
		return new Promise((resolve, reject) => {
			flow.pendingInput = { providerId, resolve, reject };
		});
	}

	private raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
		return new Promise((resolve, reject) => {
			const abort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}

	private launchTarget(): DaemonLaunchTarget {
		return {
			executablePath: this.options.executablePath,
			args: [this.options.cliPath],
			env: { ELECTRON_RUN_AS_NODE: "1" },
		};
	}

	private async ensureDaemon(): Promise<void> {
		await ensureInteractiveDaemonRunning(this.socketPath, this.options.cwd, this.launchTarget());
	}

	private async listRawSessions(): Promise<SessionSummary[]> {
		await this.ensureDaemon();
		const client = new DaemonClient(this.socketPath);
		await client.connect();
		try {
			const response = await client.request({ type: "list", all: true });
			if (!response.success) throw new Error(response.error);
			if (!isRecord(response.data) || !Array.isArray(response.data.sessions)) {
				throw new Error("Daemon returned an invalid session catalog");
			}
			return response.data.sessions
				.filter(isDaemonSessionSummary)
				.filter((summary) => summary.runtimeKind !== "subagent");
		} finally {
			client.close();
		}
	}

	private async listSessions(): Promise<DesktopSessionSummary[]> {
		const sessions = (await this.listRawSessions()).map((summary) => {
			const managed = this.connections.get(summary.sessionId);
			return managed?.summary ?? toSessionSummary(summary);
		});
		sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		return sessions;
	}

	private async createAndAttach(): Promise<DesktopSessionSnapshot> {
		await this.ensureDaemon();
		const client = new DaemonClient(this.socketPath);
		await client.connect();
		try {
			const response = await client.request({
				type: "create",
				config: { cwd: resolve(this.options.cwd), executionMode: "interactive" },
				lifecycle: "resident",
			});
			if (!response.success) throw new Error(response.error);
			if (!isDaemonSessionSummary(response.data)) throw new Error("Daemon returned an invalid session");
			return await this.attachWithClient(client, response.data);
		} catch (error) {
			client.close();
			throw error;
		}
	}

	private async attachSummary(summary: SessionSummary): Promise<DesktopSessionSnapshot> {
		await this.ensureDaemon();
		const client = new DaemonClient(this.socketPath);
		await client.connect();
		try {
			if (summary.activeSessionId) return await this.attachWithClient(client, summary);
			if (!summary.sessionFile) throw new Error("Session has no persisted transcript");
			const response = await client.request({
				type: "create",
				sessionPath: summary.sessionFile,
				config: { cwd: summary.cwd, executionMode: "interactive" },
				lifecycle: "resident",
			});
			if (!response.success) throw new Error(response.error);
			if (!isDaemonSessionSummary(response.data)) throw new Error("Daemon returned an invalid session");
			return await this.attachWithClient(client, response.data);
		} catch (error) {
			client.close();
			throw error;
		}
	}

	private async attachWithClient(client: DaemonClient, summary: SessionSummary): Promise<DesktopSessionSnapshot> {
		const activeSessionId = summary.activeSessionId ?? summary.id;
		if (!activeSessionId) throw new Error("Daemon session cannot be attached");
		const connection = await DaemonAgentConnection.attach(client, activeSessionId, {
			closeClientOnDispose: true,
			recoverDaemon: () => this.ensureDaemon(),
			sendClientEnv: true,
			supportsExtensionUi: false,
		});
		const managed: ManagedSession = {
			connection,
			generation: randomUUID(),
			sequence: 0,
			summary: toSessionSummary(summary),
			toolStatuses: new Map(),
			unsubscribe: () => {},
		};
		managed.unsubscribe = connection.subscribe((event) => this.handleConnectionEvent(managed, event));
		this.connections.set(summary.sessionId, managed);
		const snapshot = await this.snapshotFor(managed);
		this.emitSession(managed);
		await this.emitCatalog();
		return snapshot;
	}

	private async snapshotFor(managed: ManagedSession): Promise<DesktopSessionSnapshot> {
		const snapshot = await managed.connection.getInitialSnapshot();
		managed.summary = {
			...managed.summary,
			title: snapshot.state.sessionName?.trim() || managed.summary.title,
			cwdLabel: basename(snapshot.state.cwd) || snapshot.state.cwd,
			runState: snapshot.state.isStreaming || snapshot.state.isCompacting ? "running" : "idle",
		};
		return this.mapSnapshot(managed, snapshot);
	}

	private mapSnapshot(managed: ManagedSession, snapshot: AgentConnectionSnapshot): DesktopSessionSnapshot {
		for (const [callId, status] of this.collectToolStatuses(snapshot.messages)) {
			managed.toolStatuses.set(callId, status);
		}
		const messages = snapshot.messages.map((message) =>
			this.mapMessage(message, "complete", managed.sequence, managed.toolStatuses),
		);
		if (snapshot.streamingMessage) {
			messages.push(this.mapMessage(snapshot.streamingMessage, "streaming", managed.sequence, managed.toolStatuses));
		}
		const model = snapshot.state.model;
		return {
			id: managed.summary.id,
			generation: managed.generation,
			sequence: managed.sequence,
			summary: managed.summary,
			modelLabel: model ? `${model.provider}/${model.id}` : undefined,
			messages,
		};
	}

	private handleConnectionEvent(managed: ManagedSession, event: AgentConnectionEvent): void {
		if (event.type === "session_resynced") {
			this.emit(managed, { type: "snapshot_replaced", snapshot: this.mapSnapshot(managed, event.snapshot) });
			return;
		}
		if (event.type === "session_replaced") {
			const snapshot: AgentConnectionSnapshot = { state: event.state, messages: event.messages };
			this.emit(managed, { type: "snapshot_replaced", snapshot: this.mapSnapshot(managed, snapshot) });
			return;
		}
		if (event.type === "closed") {
			managed.summary = { ...managed.summary, runState: "error" };
			this.emit(managed, { type: "session_error", message: event.error ?? "Session connection closed" });
			this.emitSession(managed);
			return;
		}
		if (event.type !== "session_event") return;
		const sessionEvent = event.event;
		if (sessionEvent.type === "agent_start") {
			managed.summary = { ...managed.summary, runState: "running", updatedAt: new Date().toISOString() };
			this.emitSession(managed);
			return;
		}
		if (sessionEvent.type === "agent_end") {
			managed.summary = { ...managed.summary, runState: "idle", updatedAt: new Date().toISOString() };
			this.emitSession(managed);
			void this.emitCatalog();
			return;
		}
		if (sessionEvent.type === "session_info_changed") {
			managed.summary = { ...managed.summary, title: sessionEvent.name?.trim() || "New session" };
			this.emitSession(managed);
			return;
		}
		if (sessionEvent.type === "tool_execution_start") {
			this.updateToolStatus(managed, sessionEvent.toolCallId, "running");
			return;
		}
		if (sessionEvent.type === "tool_execution_end") {
			this.updateToolStatus(managed, sessionEvent.toolCallId, sessionEvent.isError ? "error" : "done");
			return;
		}
		if (
			sessionEvent.type === "message_start" ||
			sessionEvent.type === "message_update" ||
			sessionEvent.type === "message_end"
		) {
			const status = sessionEvent.type === "message_end" ? "complete" : "streaming";
			const message = this.mapMessage(sessionEvent.message, status, managed.sequence + 1, managed.toolStatuses);
			this.emit(managed, { type: "message_upserted", message });
		}
	}

	private mapMessage(
		value: unknown,
		status: DesktopRenderMessage["status"],
		revision: number,
		toolStatuses: ReadonlyMap<string, ToolRunStatus>,
	): DesktopRenderMessage {
		const message = isRecord(value) ? value : {};
		const sourceRole = asString(message.role) ?? "system";
		const role = sourceRole === "user" || sourceRole === "assistant" ? sourceRole : "system";
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
		const blocks = this.mapContent(message.content, toolStatuses);
		if (sourceRole === "bashExecution" && typeof message.output === "string") {
			blocks.push({ id: "bash-output", type: "text", text: clampText(message.output) });
		}
		const stopReason = asString(message.stopReason);
		const errorText = asString(message.errorMessage);
		return {
			id: `${sourceRole}:${timestamp}`,
			revision,
			role,
			createdAt: new Date(timestamp).toISOString(),
			status: errorText || stopReason === "error" ? "error" : status,
			blocks,
			...(errorText ? { errorText: clampText(errorText) } : {}),
		};
	}

	private mapContent(value: unknown, toolStatuses: ReadonlyMap<string, ToolRunStatus>): DesktopRenderBlock[] {
		if (typeof value === "string") return [{ id: "text:0", type: "text", text: clampText(value) }];
		if (!Array.isArray(value)) return [];
		const blocks: DesktopRenderBlock[] = [];
		for (const [index, item] of value.entries()) {
			if (!isRecord(item)) continue;
			const type = asString(item.type);
			if (type === "text" && typeof item.text === "string") {
				blocks.push({ id: `text:${index}`, type: "text", text: clampText(item.text) });
			} else if (type === "thinking" && typeof item.thinking === "string") {
				blocks.push({ id: `thinking:${index}`, type: "thinking", text: clampText(item.thinking) });
			} else if (type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
				blocks.push({
					id: `tool:${item.id}`,
					type: "tool",
					callId: item.id,
					name: item.name,
					status: toolStatuses.get(item.id) ?? "running",
				});
			} else if (
				type === "image" &&
				typeof item.data === "string" &&
				item.data.length <= MAX_ATTACHMENT_BASE64_CHARS &&
				typeof item.mimeType === "string" &&
				ALLOWED_IMAGE_TYPES.has(item.mimeType)
			) {
				const source = this.mediaStore.registerBase64(item.data, item.mimeType);
				if (source) {
					blocks.push({
						id: `attachment:${index}`,
						type: "attachment",
						source,
						mimeType: item.mimeType,
						mediaType: "image",
					});
				}
			}
		}
		return blocks;
	}

	private collectToolStatuses(messages: readonly unknown[]): Map<string, ToolRunStatus> {
		const statuses = new Map<string, ToolRunStatus>();
		for (const value of messages) {
			if (!isRecord(value) || value.role !== "toolResult" || typeof value.toolCallId !== "string") continue;
			statuses.set(value.toolCallId, value.isError === true ? "error" : "done");
		}
		return statuses;
	}

	private updateToolStatus(managed: ManagedSession, callId: string, status: ToolRunStatus): void {
		managed.toolStatuses.set(callId, status);
		this.emit(managed, { type: "tool_status_changed", callId, status });
	}

	private validateImage(attachment: DesktopPromptAttachment): { type: "image"; data: string; mimeType: string } {
		if (!ALLOWED_IMAGE_TYPES.has(attachment.mimeType)) throw new Error(`${attachment.name} is not a supported image`);
		if (!attachment.data || attachment.data.length > MAX_ATTACHMENT_BASE64_CHARS)
			throw new Error(`${attachment.name} is too large`);
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data))
			throw new Error(`${attachment.name} is not valid base64 data`);
		return { type: "image", data: attachment.data, mimeType: attachment.mimeType };
	}

	private emitSession(managed: ManagedSession): void {
		this.emit(managed, { type: "session_upserted", session: managed.summary });
	}

	private async emitCatalog(): Promise<void> {
		try {
			const sessions = await this.listSessions();
			this.catalogSequence++;
			this.notify({
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				generation: "catalog",
				sequence: this.catalogSequence,
				event: { type: "catalog_replaced", sessions },
			});
		} catch {
			// The attached session remains usable if a background catalog refresh fails.
		}
	}

	private emitAuth(state: DesktopAuthFlowState): void {
		this.authSequence++;
		this.notify({
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			generation: "auth",
			sequence: this.authSequence,
			event: { type: "auth_flow_updated", state },
		});
	}

	private emit(managed: ManagedSession, event: DesktopEvent): void {
		managed.sequence++;
		this.notify({
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			sessionId: managed.summary.id,
			generation: managed.generation,
			sequence: managed.sequence,
			event,
		});
	}

	private notify(event: DesktopEventEnvelope): void {
		for (const listener of this.listeners) listener(event);
	}
}
