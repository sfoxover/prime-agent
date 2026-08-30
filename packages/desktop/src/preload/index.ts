import { contextBridge, ipcRenderer } from "electron";
import type {
	DesktopApi,
	DesktopEventEnvelope,
	DesktopPromptAttachment,
	DesktopSessionSnapshot,
} from "../shared/desktop-api.js";
import { DESKTOP_CHANNELS } from "../shared/desktop-api.js";

const desktopApi: DesktopApi = Object.freeze({
	platform: process.platform,
	versions: Object.freeze({
		electron: process.versions.electron,
		chrome: process.versions.chrome,
		node: process.versions.node,
	}),
	getBootstrap: () => ipcRenderer.invoke(DESKTOP_CHANNELS.bootstrap),
	createSession: (clientRequestId: string): Promise<DesktopSessionSnapshot> =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.createSession, clientRequestId),
	attachSession: (sessionId: string): Promise<DesktopSessionSnapshot> =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.attachSession, sessionId),
	detachSession: (sessionId: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.detachSession, sessionId),
	renameSession: (input: Parameters<DesktopApi["renameSession"]>[0]) =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.renameSession, input),
	deleteSession: (sessionId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, sessionId),
	clearSessions: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clearSessions),
	sendPrompt: (input: {
		sessionId: string;
		text: string;
		attachments: DesktopPromptAttachment[];
		clientRequestId: string;
	}) => ipcRenderer.invoke(DESKTOP_CHANNELS.sendPrompt, input),
	abort: (sessionId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.abort, sessionId),
	getModelCatalog: (sessionId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.getModelCatalog, sessionId),
	setModel: (input: Parameters<DesktopApi["setModel"]>[0]) => ipcRenderer.invoke(DESKTOP_CHANNELS.setModel, input),
	loginProvider: (input: Parameters<DesktopApi["loginProvider"]>[0]) =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.loginProvider, input),
	submitAuthInput: (input: Parameters<DesktopApi["submitAuthInput"]>[0]) =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.submitAuthInput, input),
	cancelProviderLogin: (providerId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelProviderLogin, providerId),
	getGoalState: (sessionId: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.getGoalState, sessionId),
	getMemories: (sessionId: string, limit: number) =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.getMemories, sessionId, limit),
	getRecentActivityLog: (sessionId: string, limit: number) =>
		ipcRenderer.invoke(DESKTOP_CHANNELS.getRecentActivityLog, sessionId, limit),
	onEvent: (listener: (event: DesktopEventEnvelope) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEventEnvelope) => listener(payload);
		ipcRenderer.on(DESKTOP_CHANNELS.event, handler);
		return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, handler);
	},
});

contextBridge.exposeInMainWorld("primeDesktop", desktopApi);
