export const DESKTOP_PROTOCOL_VERSION = 4 as const;

export type DesktopProtocolVersion = typeof DESKTOP_PROTOCOL_VERSION;

export const DESKTOP_CHANNELS = {
	abort: "desktop:abort",
	attachSession: "desktop:attach-session",
	bootstrap: "desktop:bootstrap",
	cancelProviderLogin: "desktop:cancel-provider-login",
	clearSessions: "desktop:clear-sessions",
	createSession: "desktop:create-session",
	deleteSession: "desktop:delete-session",
	detachSession: "desktop:detach-session",
	event: "desktop:event",
	getModelCatalog: "desktop:get-model-catalog",
	loginProvider: "desktop:login-provider",
	renameSession: "desktop:rename-session",
	sendPrompt: "desktop:send-prompt",
	setModel: "desktop:set-model",
	submitAuthInput: "desktop:submit-auth-input",
	getGoalState: "desktop:get-goal-state",
	getMemories: "desktop:get-memories",
	getRecentActivityLog: "desktop:get-recent-activity-log",
} as const;
export type SessionRunState = "idle" | "running" | "aborting" | "error";
export type ToolRunStatus = "running" | "done" | "error";

export interface DesktopSessionSummary {
	id: string;
	title: string;
	cwdLabel: string;
	updatedAt: string;
	runState: SessionRunState;
	unread: boolean;
}

export type DesktopRenderBlock =
	| { id: string; type: "text"; text: string }
	| { id: string; type: "thinking"; text: string }
	| {
			id: string;
			type: "tool";
			callId: string;
			name: string;
			status: ToolRunStatus;
			inputPreview?: string;
	  }
	| { id: string; type: "attachment"; source: string; mimeType: string; mediaType: "image" | "video"; alt?: string };

export interface DesktopRenderMessage {
	id: string;
	revision: number;
	role: "user" | "assistant" | "system";
	createdAt: string;
	status: "streaming" | "complete" | "error";
	blocks: DesktopRenderBlock[];
	errorText?: string;
}

export interface DesktopSessionSnapshot {
	id: string;
	generation: string;
	sequence: number;
	summary: DesktopSessionSummary;
	modelLabel?: string;
	messages: DesktopRenderMessage[];
}

export type DesktopProviderAuthType = "oauth" | "api_key" | "external";

export interface DesktopModelOption {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
}

export interface DesktopProviderOption {
	id: string;
	name: string;
	authTypes: DesktopProviderAuthType[];
	configured: boolean;
	modelCount: number;
}

export interface DesktopModelCatalog {
	models: DesktopModelOption[];
	providers: DesktopProviderOption[];
}

export type DesktopAuthFlowState =
	| { providerId: string; status: "opening_browser"; instructions?: string }
	| {
			providerId: string;
			status: "input_required";
			message: string;
			placeholder?: string;
			allowEmpty: boolean;
			options?: { id: string; label: string }[];
	  }
	| { providerId: string; status: "progress"; message: string }
	| { providerId: string; status: "success" }
	| { providerId: string; status: "cancelled" }
	| { providerId: string; status: "error"; message: string };

export interface GoalState {
	goalId: string;
	description: string;
	status: "active" | "completed" | "paused";
	progress: number; // 0.0 to 1.0
	lastUpdated: string;
}

export interface MemoryEntry {
	memoryId: string;
	source: "user_input" | "agent_observation" | "refinement";
	content: string;
	timestamp: string;
	relevanceScore: number; // 0.0 to 1.0
}

export interface AgentActivityLog {
	logId: string;
	timestamp: string;
	source: "subagent" | "heartbeat" | "tool_call";
	message: string;
	details?: Record<string, unknown>;
}

export interface DesktopBootstrap {
	protocolVersion: DesktopProtocolVersion;
	sessions: DesktopSessionSummary[];
	defaultCwdLabel: string;
	defaultModelLabel?: string;
}

export interface DesktopPromptAttachment {
	name: string;
	mimeType: string;
	data: string;
}

export type DesktopEvent =
	| { type: "catalog_replaced"; sessions: DesktopSessionSummary[] }
	| { type: "session_upserted"; session: DesktopSessionSummary }
	| { type: "message_upserted"; message: DesktopRenderMessage }
	| { type: "tool_status_changed"; callId: string; status: ToolRunStatus }
	| { type: "snapshot_replaced"; snapshot: DesktopSessionSnapshot }
	| { type: "session_error"; message: string }
	| { type: "goal_updated"; goal: GoalState }
	| { type: "memory_upserted"; memory: MemoryEntry[] }
	| { type: "activity_log_entry"; log: AgentActivityLog }
	| { type: "auth_flow_updated"; state: DesktopAuthFlowState };

export interface DesktopEventEnvelope {
	protocolVersion: DesktopProtocolVersion;
	sessionId?: string;
	generation: string;
	sequence: number;
	event: DesktopEvent;
}

export interface DesktopApi {
	platform: string;
	versions: {
		electron: string;
		chrome: string;
		node: string;
	};
	getBootstrap(): Promise<DesktopBootstrap>;
	createSession(clientRequestId: string): Promise<DesktopSessionSnapshot>;
	attachSession(sessionId: string): Promise<DesktopSessionSnapshot>;
	detachSession(sessionId: string): Promise<void>;
	renameSession(input: { sessionId: string; name: string }): Promise<DesktopSessionSummary>;
	deleteSession(sessionId: string): Promise<{ deleted: boolean }>;
	clearSessions(): Promise<{ deleted: number }>;
	sendPrompt(input: {
		sessionId: string;
		text: string;
		attachments: DesktopPromptAttachment[];
		clientRequestId: string;
	}): Promise<{ accepted: true }>;
	abort(sessionId: string): Promise<{ accepted: boolean }>;
	getModelCatalog(sessionId: string): Promise<DesktopModelCatalog>;
	setModel(input: { sessionId: string; provider: string; modelId: string }): Promise<DesktopSessionSnapshot>;
	loginProvider(input: {
		sessionId: string;
		providerId: string;
		authType: Exclude<DesktopProviderAuthType, "external">;
		apiKey?: string;
	}): Promise<DesktopModelCatalog>;
	submitAuthInput(input: { providerId: string; value: string }): Promise<{ accepted: true }>;
	cancelProviderLogin(providerId: string): Promise<{ cancelled: boolean }>;
	onEvent(listener: (event: DesktopEventEnvelope) => void): () => void;
	getGoalState(sessionId: string): Promise<GoalState | null>;
	getMemories(sessionId: string, limit: number): Promise<MemoryEntry[]>;
	getRecentActivityLog(sessionId: string, limit: number): Promise<AgentActivityLog[]>;
}
