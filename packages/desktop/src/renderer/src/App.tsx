import {
	type ClipboardEvent,
	type DragEvent,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type SVGProps,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	DesktopAuthFlowState,
	DesktopEventEnvelope,
	DesktopModelCatalog,
	DesktopModelOption,
	DesktopPromptAttachment,
	DesktopProviderAuthType,
	DesktopProviderOption,
	DesktopRenderMessage,
	DesktopSessionSnapshot,
	DesktopSessionSummary,
	ToolRunStatus,
} from "../../shared/desktop-api.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { isDesktopSessionRunning } from "./session-run-state.js";

type Theme = "light" | "dark";
type IconName =
	| "agent"
	| "attach"
	| "chat"
	| "chevron"
	| "code"
	| "moon"
	| "plus"
	| "search"
	| "send"
	| "settings"
	| "sun";

interface IconProps extends SVGProps<SVGSVGElement> {
	name: IconName;
}

const suggestions = [
	{ icon: "code" as const, title: "Build a feature", detail: "Describe a change to this repository" },
	{ icon: "agent" as const, title: "Explore the codebase", detail: "Ask how a system or package works" },
	{ icon: "chat" as const, title: "Fix an issue", detail: "Paste an error or attach a screenshot" },
];

function Icon({ name, ...props }: IconProps) {
	const paths: Record<IconName, ReactNode> = {
		agent: (
			<>
				<path d="M12 2v3" />
				<rect width="16" height="14" x="4" y="7" rx="3" />
				<path d="M8 11h.01M16 11h.01M9 16h6M2 12h2M20 12h2" />
			</>
		),
		attach: (
			<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />
		),
		chat: (
			<>
				<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
				<path d="M8 9h8M8 13h5" />
			</>
		),
		chevron: <path d="m9 18 6-6-6-6" />,
		code: <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />,
		moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />,
		plus: <path d="M12 5v14M5 12h14" />,
		search: (
			<>
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-4-4" />
			</>
		),
		send: <path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" />,
		settings: (
			<>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
			</>
		),
		sun: (
			<>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</>
		),
	};

	return (
		<svg
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.7"
			viewBox="0 0 24 24"
			{...props}
		>
			{paths[name]}
		</svg>
	);
}

function getInitialTheme(): Theme {
	const storedTheme = window.localStorage.getItem("prime-agent-theme");
	if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_VISIBLE_MODELS = 250;
const SUPPORTED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

interface LocalAttachment extends DesktopPromptAttachment {
	id: string;
	previewUrl: string;
}

type SessionAction =
	| { type: "rename"; session: DesktopSessionSummary }
	| { type: "delete"; session: DesktopSessionSummary }
	| { type: "clear" };

interface SessionContextMenu {
	session: DesktopSessionSummary;
	x: number;
	y: number;
}

interface TextParagraph {
	offset: number;
	text: string;
}

function splitTextParagraphs(text: string): TextParagraph[] {
	const paragraphs: TextParagraph[] = [];
	const separator = /\n{2,}/g;
	let offset = 0;
	for (const match of text.matchAll(separator)) {
		paragraphs.push({ offset, text: text.slice(offset, match.index) });
		offset = match.index + match[0].length;
	}
	paragraphs.push({ offset, text: text.slice(offset) });
	return paragraphs;
}

function readFile(file: File): Promise<LocalAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(`Could not read ${file.name}`));
				return;
			}
			const separator = reader.result.indexOf(",");
			if (separator === -1) {
				reject(new Error(`Could not read ${file.name}`));
				return;
			}
			resolve({
				id: crypto.randomUUID(),
				name: file.name,
				mimeType: file.type,
				data: reader.result.slice(separator + 1),
				previewUrl: reader.result,
			});
		};
		reader.readAsDataURL(file);
	});
}

function upsertSession(sessions: DesktopSessionSummary[], session: DesktopSessionSummary): DesktopSessionSummary[] {
	const next = sessions.filter((candidate) => candidate.id !== session.id);
	next.push(session);
	return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function upsertMessage(messages: DesktopRenderMessage[], message: DesktopRenderMessage): DesktopRenderMessage[] {
	const index = messages.findIndex((candidate) => candidate.id === message.id);
	if (index === -1) return [...messages, message];
	if (messages[index]!.revision > message.revision) return messages;
	const next = [...messages];
	next[index] = message;
	return next;
}

function updateToolStatus(
	messages: DesktopRenderMessage[],
	callId: string,
	status: ToolRunStatus,
): DesktopRenderMessage[] {
	let changed = false;
	const next = messages.map((message) => {
		let messageChanged = false;
		const blocks = message.blocks.map((block) => {
			if (block.type !== "tool" || block.callId !== callId || block.status === status) return block;
			changed = true;
			messageChanged = true;
			return { ...block, status };
		});
		return messageChanged ? { ...message, blocks } : message;
	});
	return changed ? next : messages;
}

function isAuthFlowActive(state: DesktopAuthFlowState | undefined): boolean {
	return state?.status === "opening_browser" || state?.status === "input_required" || state?.status === "progress";
}

export function App() {
	const desktopApi = window.primeDesktop;

	const [theme, setTheme] = useState<Theme>(getInitialTheme);
	const [prompt, setPrompt] = useState("");
	const [sessionSearch, setSessionSearch] = useState("");
	const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
	const [snapshots, setSnapshots] = useState<Record<string, DesktopSessionSnapshot>>({});
	const [selectedSessionId, setSelectedSessionId] = useState<string>();
	const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
	const [error, setError] = useState<string>();
	const [isLoading, setIsLoading] = useState(true);
	const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
	const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
	const [isModelChanging, setIsModelChanging] = useState(false);
	const [modelCatalog, setModelCatalog] = useState<DesktopModelCatalog>();
	const [defaultModelLabel, setDefaultModelLabel] = useState<string>();
	const [defaultCwdLabel, setDefaultCwdLabel] = useState("prime-agent");
	const [modelSearch, setModelSearch] = useState("");
	const [selectedProviderId, setSelectedProviderId] = useState<string>();
	const [authProvider, setAuthProvider] = useState<DesktopProviderOption>();
	const [authFlow, setAuthFlow] = useState<DesktopAuthFlowState>();
	const [authInput, setAuthInput] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [pendingModel, setPendingModel] = useState<DesktopModelOption>();
	const [modelSessionId, setModelSessionId] = useState<string>();
	const [attachingSessionId, setAttachingSessionId] = useState<string>();
	const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenu>();
	const [sessionAction, setSessionAction] = useState<SessionAction>();
	const [sessionActionPending, setSessionActionPending] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const chatCanvasRef = useRef<HTMLElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const promptInputRef = useRef<HTMLTextAreaElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const sessionSearchInputRef = useRef<HTMLInputElement>(null);
	const shouldAutoScrollRef = useRef(true);

	const selectedSnapshot = selectedSessionId ? snapshots[selectedSessionId] : undefined;
	const selectedSummary = sessions.find((session) => session.id === selectedSessionId);
	const isRunning = isDesktopSessionRunning(selectedSummary, selectedSnapshot);
	const normalizedSearch = sessionSearch.trim().toLocaleLowerCase();
	const visibleSessions = normalizedSearch
		? sessions.filter((session) =>
				`${session.title}\n${session.cwdLabel}`.toLocaleLowerCase().includes(normalizedSearch),
			)
		: sessions;
	const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase();
	const filteredModels = (modelCatalog?.models ?? []).filter((model) => {
		if (selectedProviderId && model.provider !== selectedProviderId) return false;
		if (!normalizedModelSearch) return true;
		return `${model.name}\n${model.id}\n${model.provider}`.toLocaleLowerCase().includes(normalizedModelSearch);
	});

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		document.documentElement.style.colorScheme = theme;
		window.localStorage.setItem("prime-agent-theme", theme);
	}, [theme]);

	useEffect(() => {
		if (sessionAction?.type !== "rename") return;
		requestAnimationFrame(() => renameInputRef.current?.focus());
	}, [sessionAction]);

	useEffect(() => {
		function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				setSessionContextMenu(undefined);
				if (!sessionActionPending) setSessionAction(undefined);
				if (isModelSelectorOpen) {
					if (authProvider && isAuthFlowActive(authFlow))
						void window.primeDesktop?.cancelProviderLogin(authProvider.id);
					setIsModelSelectorOpen(false);
					setAuthProvider(undefined);
					setAuthFlow(undefined);
					setPendingModel(undefined);
					setModelSessionId(undefined);
					setApiKey("");
					setAuthInput("");
				}
				return;
			}
			if (!(event.metaKey || event.ctrlKey) || event.altKey || isModelSelectorOpen || sessionAction) return;
			if (event.key.toLocaleLowerCase() === "n") {
				event.preventDefault();
				setSelectedSessionId(undefined);
				shouldAutoScrollRef.current = true;
				setPrompt("");
				setAttachments([]);
				setError(undefined);
				setSessionContextMenu(undefined);
				requestAnimationFrame(() => promptInputRef.current?.focus());
			} else if (event.key.toLocaleLowerCase() === "k") {
				event.preventDefault();
				setSessionContextMenu(undefined);
				requestAnimationFrame(() => sessionSearchInputRef.current?.focus());
			}
		}
		window.addEventListener("keydown", handleGlobalKeyDown);
		return () => window.removeEventListener("keydown", handleGlobalKeyDown);
	}, [authFlow, authProvider, isModelSelectorOpen, sessionAction, sessionActionPending]);

	useEffect(() => {
		if (!selectedSessionId || !selectedSnapshot || !shouldAutoScrollRef.current) return;
		const frame = requestAnimationFrame(() => {
			const canvas = chatCanvasRef.current;
			if (canvas) canvas.scrollTo({ top: canvas.scrollHeight, behavior: "auto" });
		});
		return () => cancelAnimationFrame(frame);
	}, [selectedSessionId, selectedSnapshot]);

	useEffect(() => {
		if (!desktopApi) {
			setIsLoading(false);
			return;
		}

		function handleEvent(envelope: DesktopEventEnvelope) {
			const event = envelope.event;
			if (event.type === "catalog_replaced") {
				setSessions(event.sessions);
			} else if (event.type === "session_upserted") {
				setSessions((current) => upsertSession(current, event.session));
			} else if (event.type === "snapshot_replaced") {
				setSnapshots((current) => ({ ...current, [event.snapshot.id]: event.snapshot }));
				if (event.snapshot.modelLabel) setDefaultModelLabel(event.snapshot.modelLabel);
			} else if (event.type === "message_upserted" && envelope.sessionId) {
				const sessionId = envelope.sessionId;
				setSnapshots((current) => {
					const snapshot = current[sessionId];
					if (!snapshot) return current;
					return {
						...current,
						[sessionId]: {
							...snapshot,
							sequence: envelope.sequence,
							messages: upsertMessage(snapshot.messages, event.message),
						},
					};
				});
			} else if (event.type === "tool_status_changed" && envelope.sessionId) {
				const sessionId = envelope.sessionId;
				setSnapshots((current) => {
					const snapshot = current[sessionId];
					if (!snapshot) return current;
					return {
						...current,
						[sessionId]: {
							...snapshot,
							sequence: envelope.sequence,
							messages: updateToolStatus(snapshot.messages, event.callId, event.status),
						},
					};
				});
			} else if (event.type === "session_error") {
				setError(event.message);
			} else if (event.type === "auth_flow_updated") {
				setAuthFlow(event.state);
			}
		}

		const unsubscribe = desktopApi.onEvent(handleEvent);
		void desktopApi
			.getBootstrap()
			.then((bootstrap) => {
				setSessions(bootstrap.sessions);
				setDefaultModelLabel(bootstrap.defaultModelLabel);
				setDefaultCwdLabel(bootstrap.defaultCwdLabel);
				setIsLoading(false);
			})
			.catch((bootstrapError: unknown) => {
				setError(bootstrapError instanceof Error ? bootstrapError.message : "Could not connect to Prime Agent");
				setIsLoading(false);
			});
		return unsubscribe;
	}, []);

	if (!desktopApi) {
		return (
			<div style={{ padding: 20, fontFamily: "sans-serif" }}>
				<h2>Prime Agent renderer</h2>
				<p>Desktop API not available. If running in the browser, open the app via the Electron dev launcher.</p>
			</div>
		);
	}
	const api = desktopApi;

	async function createSession(): Promise<DesktopSessionSnapshot | undefined> {
		setError(undefined);
		try {
			const snapshot = await api.createSession(crypto.randomUUID());
			setSnapshots((current) => ({ ...current, [snapshot.id]: snapshot }));
			if (snapshot.modelLabel) setDefaultModelLabel(snapshot.modelLabel);
			setSessions((current) => upsertSession(current, snapshot.summary));
			setSelectedSessionId(snapshot.id);
			return snapshot;
		} catch (createError) {
			setError(createError instanceof Error ? createError.message : "Could not create a session");
			return undefined;
		}
	}

	async function selectSession(sessionId: string) {
		setSessionContextMenu(undefined);
		setSelectedSessionId(sessionId);
		shouldAutoScrollRef.current = true;
		if (snapshots[sessionId]) return;
		setError(undefined);
		setAttachingSessionId(sessionId);
		try {
			const snapshot = await api.attachSession(sessionId);
			setSnapshots((current) => ({ ...current, [sessionId]: snapshot }));
		} catch (attachError) {
			setError(attachError instanceof Error ? attachError.message : "Could not open the session");
		} finally {
			setAttachingSessionId((current) => (current === sessionId ? undefined : current));
		}
	}

	function startNewSession() {
		setSelectedSessionId(undefined);
		shouldAutoScrollRef.current = true;
		setPrompt("");
		setAttachments([]);
		setError(undefined);
		setSessionContextMenu(undefined);
		requestAnimationFrame(() => promptInputRef.current?.focus());
	}

	function openSessionContextMenu(session: DesktopSessionSummary, x: number, y: number) {
		setSessionContextMenu({
			session,
			x: Math.max(8, Math.min(x, window.innerWidth - 196)),
			y: Math.max(8, Math.min(y, window.innerHeight - 152)),
		});
	}

	function openSessionAction(action: SessionAction) {
		setSessionContextMenu(undefined);
		setSessionAction(action);
		setRenameValue(action.type === "rename" ? action.session.title : "");
	}

	function removeSessionFromRenderer(sessionId: string) {
		setSessions((current) => current.filter((session) => session.id !== sessionId));
		setSnapshots((current) => {
			const next = { ...current };
			delete next[sessionId];
			return next;
		});
		if (selectedSessionId === sessionId) setSelectedSessionId(undefined);
	}

	async function submitSessionAction(event?: FormEvent<HTMLFormElement>) {
		event?.preventDefault();
		if (!sessionAction || sessionActionPending) return;
		setSessionActionPending(true);
		setError(undefined);
		try {
			if (sessionAction.type === "rename") {
				const name = renameValue.trim();
				if (!name) return;
				const renamed = await api.renameSession({ sessionId: sessionAction.session.id, name });
				setSessions((current) => upsertSession(current, renamed));
			} else if (sessionAction.type === "delete") {
				await api.deleteSession(sessionAction.session.id);
				removeSessionFromRenderer(sessionAction.session.id);
			} else {
				await api.clearSessions();
				setSessions([]);
				setSnapshots({});
				setSelectedSessionId(undefined);
			}
			setSessionAction(undefined);
		} catch (actionError) {
			setError(actionError instanceof Error ? actionError.message : "Could not update sessions");
		} finally {
			setSessionActionPending(false);
		}
	}

	async function openModelSelector() {
		setIsModelSelectorOpen(true);
		setIsModelCatalogLoading(true);
		setModelSearch("");
		setAuthProvider(undefined);
		setAuthFlow(undefined);
		setPendingModel(undefined);
		try {
			const snapshot = selectedSnapshot ?? (await createSession());
			if (!snapshot) {
				setIsModelSelectorOpen(false);
				return;
			}
			setModelSessionId(snapshot.id);
			const catalog = await api.getModelCatalog(snapshot.id);
			setModelCatalog(catalog);
			const currentProvider = (snapshot.modelLabel ?? defaultModelLabel)?.split("/", 1)[0];
			const initialProvider =
				catalog.providers.find((provider) => provider.id === currentProvider) ??
				catalog.providers.find((provider) => provider.configured) ??
				catalog.providers[0];
			setSelectedProviderId(initialProvider?.id);
		} catch (catalogError) {
			setError(catalogError instanceof Error ? catalogError.message : "Could not load models");
			setIsModelSelectorOpen(false);
		} finally {
			setIsModelCatalogLoading(false);
		}
	}

	function closeModelSelector() {
		if (authProvider && isAuthFlowActive(authFlow)) void api.cancelProviderLogin(authProvider.id);
		setIsModelSelectorOpen(false);
		setAuthProvider(undefined);
		setAuthFlow(undefined);
		setPendingModel(undefined);
		setModelSessionId(undefined);
		setApiKey("");
		setAuthInput("");
	}

	async function applyModel(model: DesktopModelOption) {
		if (!modelSessionId) return;
		setIsModelChanging(true);
		setError(undefined);
		try {
			const snapshot = await api.setModel({
				sessionId: modelSessionId,
				provider: model.provider,
				modelId: model.id,
			});
			setSnapshots((current) => ({ ...current, [snapshot.id]: snapshot }));
			if (snapshot.modelLabel) setDefaultModelLabel(snapshot.modelLabel);
			closeModelSelector();
		} catch (modelError) {
			setError(modelError instanceof Error ? modelError.message : "Could not select the model");
		} finally {
			setIsModelChanging(false);
		}
	}

	function chooseModel(model: DesktopModelOption) {
		const provider = modelCatalog?.providers.find((candidate) => candidate.id === model.provider);
		if (!provider) return;
		if (provider.configured) {
			void applyModel(model);
			return;
		}
		setPendingModel(model);
		setAuthProvider(provider);
		setAuthFlow(undefined);
		setApiKey("");
		setAuthInput("");
	}

	async function loginProvider(authType: Exclude<DesktopProviderAuthType, "external">, key?: string) {
		if (!modelSessionId || !authProvider) return;
		setError(undefined);
		setAuthFlow({ providerId: authProvider.id, status: "progress", message: "Starting sign-in…" });
		try {
			const catalog = await api.loginProvider({
				sessionId: modelSessionId,
				providerId: authProvider.id,
				authType,
				...(key ? { apiKey: key } : {}),
			});
			setModelCatalog(catalog);
			const authenticatedProvider = catalog.providers.find((provider) => provider.id === authProvider.id);
			setAuthProvider(authenticatedProvider);
			setApiKey("");
			if (pendingModel) {
				await applyModel(pendingModel);
			} else {
				setAuthProvider(undefined);
			}
		} catch (loginError) {
			const loginMessage = loginError instanceof Error ? loginError.message : "Provider login failed";
			if (loginMessage !== "Login cancelled") {
				setError(loginMessage);
			}
		}
	}

	async function submitAuthValue(value: string) {
		if (!authProvider) return;
		setError(undefined);
		setAuthFlow({ providerId: authProvider.id, status: "progress", message: "Continuing sign-in…" });
		try {
			await api.submitAuthInput({ providerId: authProvider.id, value });
			setAuthInput("");
		} catch (inputError) {
			setError(inputError instanceof Error ? inputError.message : "Could not submit authentication input");
			setAuthFlow({
				providerId: authProvider.id,
				status: "error",
				message: inputError instanceof Error ? inputError.message : "Could not continue sign-in",
			});
		}
	}

	async function submitAuthPrompt(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!authProvider || authFlow?.status !== "input_required") return;
		if (!authFlow.allowEmpty && !authInput.trim()) return;
		await submitAuthValue(authInput);
	}

	async function addFiles(files: File[]) {
		if (isRunning) return;
		const imageFiles = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
		const accepted = imageFiles.filter((file) => file.size <= MAX_IMAGE_ATTACHMENT_BYTES);
		if (accepted.length !== files.length) setError("Attach up to 8 PNG, JPEG, GIF, or WebP images of 8 MB or less");
		if (accepted.length === 0) return;
		try {
			const next = await Promise.all(accepted.slice(0, 8 - attachments.length).map(readFile));
			setAttachments((current) => [...current, ...next].slice(0, 8));
		} catch (readError) {
			setError(readError instanceof Error ? readError.message : "Could not read the attachment");
		}
	}

	function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		const files = Array.from(event.clipboardData.files);
		if (files.length > 0) void addFiles(files);
	}

	function handleDrop(event: DragEvent<HTMLFormElement>) {
		event.preventDefault();
		void addFiles(Array.from(event.dataTransfer.files));
	}

	function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (isRunning || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	async function stopSelectedSession() {
		if (!selectedSessionId) return;
		setError(undefined);
		try {
			const result = await api.abort(selectedSessionId);
			if (!result.accepted) setError("The current query could not be stopped");
		} catch (abortError) {
			setError(abortError instanceof Error ? abortError.message : "Could not stop the query");
		}
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (isRunning || (!prompt.trim() && attachments.length === 0)) return;
		const snapshot = selectedSnapshot ?? (await createSession());
		if (!snapshot) return;
		const text = prompt;
		const submittedAttachments = attachments;
		const images = attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
		shouldAutoScrollRef.current = true;
		setPrompt("");
		setAttachments([]);
		try {
			await api.sendPrompt({
				sessionId: snapshot.id,
				text,
				attachments: images,
				clientRequestId: crypto.randomUUID(),
			});
		} catch (sendError) {
			setPrompt(text);
			setAttachments((current) => [...submittedAttachments, ...current].slice(0, 8));
			setError(sendError instanceof Error ? sendError.message : "Could not send the prompt");
		}
	}

	return (
		<div className="app-shell">
			<aside className="session-sidebar">
				<header className="sidebar-header">
					<div>
						<p className="eyebrow">Workspace</p>
						<h1>Prime Agent</h1>
					</div>
					<button
						aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
						className="icon-button"
						onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
						type="button"
					>
						<Icon name={theme === "dark" ? "sun" : "moon"} />
					</button>
				</header>
				<button className="new-session-button" onClick={startNewSession} type="button">
					<Icon name="plus" />
					New session
				</button>
				<label className="search-field">
					<Icon name="search" />
					<span className="sr-only">Search sessions</span>
					<input
						onChange={(event) => setSessionSearch(event.target.value)}
						placeholder="Search sessions"
						ref={sessionSearchInputRef}
						type="search"
						value={sessionSearch}
					/>
				</label>
				<div className="session-list">
					<p className="session-group-label">{normalizedSearch ? "Search results" : "Recent"}</p>
					{isLoading ? <p className="session-placeholder">Loading sessions…</p> : null}
					{!isLoading && sessions.length === 0 ? <p className="session-placeholder">No sessions yet</p> : null}
					{!isLoading && sessions.length > 0 && visibleSessions.length === 0 ? (
						<p className="session-placeholder">No matching sessions</p>
					) : null}
					{visibleSessions.map((session) => (
						<div
							className={`session-row${session.id === selectedSessionId ? " is-active" : ""}`}
							key={session.id}
						>
							<button
								aria-current={session.id === selectedSessionId ? "page" : undefined}
								className="session-select-button"
								onClick={() => void selectSession(session.id)}
								onContextMenu={(event) => {
									event.preventDefault();
									openSessionContextMenu(session, event.clientX, event.clientY);
								}}
								type="button"
							>
								<span className="session-title">
									<span className={`run-indicator ${session.runState}`} />
									{session.title}
								</span>
								<span className="session-detail">{session.cwdLabel}</span>
							</button>
							<button
								aria-label={`More actions for ${session.title}`}
								className="session-more-button"
								onClick={(event) => {
									const bounds = event.currentTarget.getBoundingClientRect();
									openSessionContextMenu(session, bounds.right, bounds.bottom + 4);
								}}
								type="button"
							>
								•••
							</button>
						</div>
					))}
				</div>
			</aside>

			<main className="chat-workspace">
				<header className="chat-header">
					<div>
						<h2>{selectedSummary?.title ?? "New session"}</h2>
						<span className="workspace-path">{selectedSummary?.cwdLabel ?? defaultCwdLabel}</span>
					</div>
					<div className="header-actions">
						<button
							aria-expanded={isModelSelectorOpen}
							className="model-button"
							disabled={isRunning}
							title={isRunning ? "Stop the current query before changing models" : "Change model"}
							onClick={() => void openModelSelector()}
							type="button"
						>
							<span className="model-dot" />
							{selectedSnapshot?.modelLabel ?? defaultModelLabel ?? "Model"}
							<Icon name="chevron" />
						</button>
					</div>
				</header>

				<section
					className="chat-canvas"
					onScroll={(event) => {
						const canvas = event.currentTarget;
						shouldAutoScrollRef.current = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 120;
					}}
					ref={chatCanvasRef}
				>
					{error ? (
						<div className="error-banner" role="alert">
							{error}
							<button onClick={() => setError(undefined)} type="button">
								Dismiss
							</button>
						</div>
					) : null}
					{attachingSessionId && attachingSessionId === selectedSessionId && !selectedSnapshot ? (
						<div className="chat-loading" role="status">
							Opening session…
						</div>
					) : selectedSnapshot && selectedSnapshot.messages.length > 0 ? (
						<div className="transcript">
							{selectedSnapshot.messages.map((message) => (
								<article className={`message message-${message.role}`} key={message.id}>
									<div className="message-role">
										{message.role === "assistant"
											? "Prime Agent"
											: message.role === "user"
												? "You"
												: "System"}
									</div>
									<div className="message-body">
										{message.blocks.map((block) => {
											if (block.type === "text" && message.role === "assistant")
												return <MarkdownContent key={block.id} text={block.text} />;
											if (block.type === "text")
												return (
													<div className="message-text" key={block.id}>
														{splitTextParagraphs(block.text).map((paragraph) => (
															<p key={`${block.id}:${paragraph.offset}`}>{paragraph.text}</p>
														))}
													</div>
												);
											if (block.type === "thinking")
												return (
													<details className="thinking-block" key={block.id}>
														<summary>Thinking</summary>
														<p>{block.text}</p>
													</details>
												);
											if (block.type === "tool")
												return (
													<div className="tool-block" key={block.callId}>
														<Icon name="code" />
														<span>{block.name}</span>
														<small>{block.status}</small>
													</div>
												);
											return block.mediaType === "video" ? (
												// biome-ignore lint/a11y/useMediaCaption: User-provided media does not necessarily include a captions track.
												<video controls key={block.id} src={block.source} />
											) : (
												<img
													alt={block.alt ?? "Message attachment"}
													key={block.id}
													loading="lazy"
													src={block.source}
												/>
											);
										})}
										{message.errorText ? <p className="message-error">{message.errorText}</p> : null}
									</div>
								</article>
							))}
						</div>
					) : (
						<div className="empty-state">
							<div className="copilot-orbit">
								<span />
							</div>
							<p className="eyebrow">Prime Agent</p>
							<h2>What do you want to build?</h2>
							<p className="empty-state-copy">
								Start an agent session in this repository. Attach context, paste a screenshot, or describe the
								outcome you want.
							</p>
							<div className="suggestion-grid">
								{suggestions.map((suggestion) => (
									<button
										className="suggestion-card"
										key={suggestion.title}
										onClick={() => {
											setPrompt(suggestion.detail);
											requestAnimationFrame(() => promptInputRef.current?.focus());
										}}
										type="button"
									>
										<Icon name={suggestion.icon} />
										<span>
											<strong>{suggestion.title}</strong>
											<small>{suggestion.detail}</small>
										</span>
										<Icon className="card-chevron" name="chevron" />
									</button>
								))}
							</div>
						</div>
					)}
				</section>

				<form
					className="composer"
					onDragOver={(event) => event.preventDefault()}
					onDrop={handleDrop}
					onSubmit={handleSubmit}
				>
					{attachments.length > 0 ? (
						<div className="attachment-strip">
							{attachments.map((attachment) => (
								<div className="attachment-preview" key={attachment.id}>
									<img alt="" src={attachment.previewUrl} />
									<span>{attachment.name}</span>
									<button
										aria-label={`Remove ${attachment.name}`}
										disabled={isRunning}
										onClick={() =>
											setAttachments((current) =>
												current.filter((candidate) => candidate.id !== attachment.id),
											)
										}
										type="button"
									>
										×
									</button>
								</div>
							))}
						</div>
					) : null}
					<label className="sr-only" htmlFor="prompt">
						Message Prime Agent
					</label>
					<textarea
						disabled={isRunning}
						id="prompt"
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={handlePromptKeyDown}
						onPaste={handlePaste}
						placeholder={
							isRunning ? "Prime Agent is working…" : "Ask Prime Agent to build, investigate, or fix something…"
						}
						ref={promptInputRef}
						rows={3}
						value={prompt}
					/>
					<div className="composer-toolbar">
						<div className="composer-actions">
							<input
								accept="image/gif,image/jpeg,image/png,image/webp"
								className="sr-only"
								multiple
								onChange={(event) => {
									void addFiles(Array.from(event.target.files ?? []));
									event.target.value = "";
								}}
								ref={fileInputRef}
								type="file"
							/>
							<button
								aria-label="Attach images"
								className="icon-button"
								disabled={isRunning}
								onClick={() => fileInputRef.current?.click()}
								type="button"
							>
								<Icon name="attach" />
							</button>
							<span className="context-label" title="Current workspace">
								<Icon name="code" /> {selectedSummary?.cwdLabel ?? defaultCwdLabel}
							</span>
						</div>
						{isRunning ? (
							<button
								aria-label="Stop query"
								className="send-button stop-send-button"
								onClick={() => void stopSelectedSession()}
								type="button"
							>
								<span className="stop-glyph" />
							</button>
						) : (
							<button
								aria-label="Send prompt"
								className="send-button"
								disabled={!prompt.trim() && attachments.length === 0}
								type="submit"
							>
								<Icon name="send" />
							</button>
						)}
					</div>
				</form>
			</main>

			{sessionContextMenu ? (
				<div className="session-context-layer">
					<button
						aria-label="Close session menu"
						className="session-context-backdrop"
						onClick={() => setSessionContextMenu(undefined)}
						type="button"
					/>
					<div
						aria-label={`Actions for ${sessionContextMenu.session.title}`}
						className="session-context-menu"
						role="menu"
						style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
					>
						<button
							onClick={() => openSessionAction({ type: "rename", session: sessionContextMenu.session })}
							role="menuitem"
							type="button"
						>
							Rename
						</button>
						<button
							className="danger"
							onClick={() => openSessionAction({ type: "delete", session: sessionContextMenu.session })}
							role="menuitem"
							type="button"
						>
							Delete
						</button>
						<div className="session-context-separator" />
						<button
							className="danger"
							onClick={() => openSessionAction({ type: "clear" })}
							role="menuitem"
							type="button"
						>
							Clear all sessions
						</button>
					</div>
				</div>
			) : null}

			{sessionAction ? (
				<div className="session-action-overlay">
					<button
						aria-label="Cancel session action"
						className="session-action-backdrop"
						disabled={sessionActionPending}
						onClick={() => setSessionAction(undefined)}
						type="button"
					/>
					<section aria-modal="true" className="session-action-dialog" role="dialog">
						{sessionAction.type === "rename" ? (
							<form onSubmit={(event) => void submitSessionAction(event)}>
								<h2>Rename session</h2>
								<p>Choose a name for this session.</p>
								<input
									maxLength={160}
									onChange={(event) => setRenameValue(event.target.value)}
									ref={renameInputRef}
									value={renameValue}
								/>
								<div className="session-action-buttons">
									<button
										disabled={sessionActionPending}
										onClick={() => setSessionAction(undefined)}
										type="button"
									>
										Cancel
									</button>
									<button
										className="primary"
										disabled={!renameValue.trim() || sessionActionPending}
										type="submit"
									>
										{sessionActionPending ? "Renaming…" : "Rename"}
									</button>
								</div>
							</form>
						) : (
							<>
								<h2>{sessionAction.type === "clear" ? "Clear all sessions?" : "Delete session?"}</h2>
								<p>
									{sessionAction.type === "clear"
										? `This removes all ${sessions.length} sessions and their saved transcripts.`
										: `This removes “${sessionAction.session.title}” and its saved transcript.`}
								</p>
								<div className="session-action-buttons">
									<button
										disabled={sessionActionPending}
										onClick={() => setSessionAction(undefined)}
										type="button"
									>
										Cancel
									</button>
									<button
										className="danger"
										disabled={sessionActionPending}
										onClick={() => void submitSessionAction()}
										type="button"
									>
										{sessionActionPending
											? "Removing…"
											: sessionAction.type === "clear"
												? "Clear all"
												: "Delete"}
									</button>
								</div>
							</>
						)}
					</section>
				</div>
			) : null}

			{isModelSelectorOpen ? (
				<div className="model-overlay">
					<button
						aria-label="Close model selector"
						className="model-backdrop"
						onClick={closeModelSelector}
						type="button"
					/>
					<section aria-label="Select a model" aria-modal="true" className="model-dialog" role="dialog">
						<header className="model-dialog-header">
							<div>
								<h2>{authProvider ? `Connect ${authProvider.name}` : "Models"}</h2>
								<p>
									{authProvider
										? "Use the same credentials as the Prime Agent CLI."
										: "Choose any model available to Prime Agent."}
								</p>
							</div>
							<button aria-label="Close" className="dialog-close" onClick={closeModelSelector} type="button">
								×
							</button>
						</header>

						{authProvider ? (
							<div className="auth-panel">
								<button
									className="back-button"
									onClick={() => {
										if (isAuthFlowActive(authFlow)) void api.cancelProviderLogin(authProvider.id);
										setAuthProvider(undefined);
										setAuthFlow(undefined);
										setPendingModel(undefined);
									}}
									type="button"
								>
									← Back to models
								</button>

								{authFlow?.providerId === authProvider.id && authFlow.status === "input_required" ? (
									<div className="auth-step">
										<h3>{authFlow.message}</h3>
										{authFlow.options ? (
											<div className="auth-options">
												{authFlow.options.map((option) => (
													<button
														key={option.id}
														onClick={() => void submitAuthValue(option.id)}
														type="button"
													>
														{option.label}
													</button>
												))}
											</div>
										) : (
											<form className="auth-input-form" onSubmit={(event) => void submitAuthPrompt(event)}>
												<input
													onChange={(event) => setAuthInput(event.target.value)}
													placeholder={authFlow.placeholder ?? "Paste value"}
													value={authInput}
												/>
												<button disabled={!authFlow.allowEmpty && !authInput.trim()} type="submit">
													Continue
												</button>
											</form>
										)}
									</div>
								) : null}

								{authFlow?.providerId === authProvider.id &&
								(authFlow.status === "opening_browser" || authFlow.status === "progress") ? (
									<div className="auth-step auth-waiting">
										<span className="auth-spinner" />
										<h3>
											{authFlow.status === "opening_browser"
												? "Complete sign-in in your browser"
												: authFlow.message}
										</h3>
										{authFlow.status === "opening_browser" && authFlow.instructions ? (
											<p>{authFlow.instructions}</p>
										) : null}
										<button onClick={() => void api.cancelProviderLogin(authProvider.id)} type="button">
											Cancel
										</button>
									</div>
								) : null}

								{!isAuthFlowActive(authFlow) && authFlow?.status !== "input_required" ? (
									<div className="auth-methods">
										{authFlow?.providerId === authProvider.id && authFlow.status === "error" ? (
											<p className="auth-error">{authFlow.message}</p>
										) : null}
										{authProvider.authTypes.includes("oauth") ? (
											<button
												className="oauth-login-button"
												onClick={() => void loginProvider("oauth")}
												type="button"
											>
												Open browser login
											</button>
										) : null}
										{authProvider.authTypes.includes("api_key") ? (
											<form
												className="api-key-form"
												onSubmit={(event) => {
													event.preventDefault();
													void loginProvider("api_key", apiKey);
												}}
											>
												<label htmlFor="provider-api-key">API key</label>
												<div>
													<input
														autoComplete="off"
														id="provider-api-key"
														onChange={(event) => setApiKey(event.target.value)}
														placeholder={`Enter ${authProvider.name} API key`}
														type="password"
														value={apiKey}
													/>
													<button disabled={!apiKey.trim()} type="submit">
														Save and connect
													</button>
												</div>
											</form>
										) : null}
										{authProvider.authTypes.includes("external") ? (
											<div className="external-auth-note">
												<h3>External credentials required</h3>
												<p>
													Configure this provider using the environment or credential profile supported by
													the CLI, then reopen this selector.
												</p>
											</div>
										) : null}
									</div>
								) : null}
							</div>
						) : (
							<div className="model-browser">
								<aside className="provider-list">
									{modelCatalog?.providers.map((provider) => (
										<button
											className={provider.id === selectedProviderId ? "is-active" : ""}
											key={provider.id}
											onClick={() => setSelectedProviderId(provider.id)}
											type="button"
										>
											<span>{provider.name}</span>
											<small>{provider.configured ? "Connected" : `${provider.modelCount} models`}</small>
										</button>
									))}
								</aside>
								<div className="model-list-pane">
									<div className="model-search-row">
										<label className="model-search">
											<Icon name="search" />
											<span className="sr-only">Search models</span>
											<input
												onChange={(event) => setModelSearch(event.target.value)}
												placeholder="Search models"
												value={modelSearch}
											/>
										</label>
										{modelCatalog?.providers.find((provider) => provider.id === selectedProviderId)
											?.configured === false ? (
											<button
												className="connect-provider-button"
												onClick={() => {
													const provider = modelCatalog.providers.find(
														(candidate) => candidate.id === selectedProviderId,
													);
													if (provider) setAuthProvider(provider);
												}}
												type="button"
											>
												Connect
											</button>
										) : null}
									</div>

									<div className="model-list">
										{isModelCatalogLoading ? <p className="model-list-message">Loading models…</p> : null}
										{!isModelCatalogLoading && filteredModels.length === 0 ? (
											<p className="model-list-message">No matching models</p>
										) : null}
										{filteredModels.slice(0, MAX_VISIBLE_MODELS).map((model) => {
											const provider = modelCatalog?.providers.find(
												(candidate) => candidate.id === model.provider,
											);
											const modelLabel = `${model.provider}/${model.id}`;
											return (
												<button
													aria-current={selectedSnapshot?.modelLabel === modelLabel ? "true" : undefined}
													className="model-row"
													disabled={isModelChanging}
													key={modelLabel}
													onClick={() => chooseModel(model)}
													type="button"
												>
													<span>
														<strong>{model.name}</strong>
														<small>{model.id}</small>
													</span>
													<span className="model-meta">
														{model.reasoning ? "Reasoning" : "Chat"}
														{model.input.includes("image") ? " · Vision" : ""}
														{provider?.configured ? "" : " · Login required"}
													</span>
												</button>
											);
										})}
										{filteredModels.length > MAX_VISIBLE_MODELS ? (
											<p className="model-list-message">Refine your search to see more models.</p>
										) : null}
									</div>
								</div>
							</div>
						)}
					</section>
				</div>
			) : null}
		</div>
	);
}
