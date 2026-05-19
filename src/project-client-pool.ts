import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ProjectConfig, ProjectStatusView, SupaBaseJumpSettings } from "./settings";
import { decryptSecret } from "./secret-storage";
import { enabledOrdered, shardFor } from "./routing";
import { logger } from "./logger";

export type ProjectStatusState = ProjectStatusView["state"];

export interface ProjectRuntime {
	id: string;
	client: SupabaseClient;
	status: ProjectStatusView;
	userId: string | null;
	lastConnectErr: string | null;
}

export type StatusListener = (id: string, status: ProjectStatusView) => void;

export interface ConnectResult {
	id: string;
	ok: boolean;
	state: ProjectStatusState;
	detail: string;
	pendingOtp?: boolean;
}

export interface AuthError {
	code: string;
	message: string;
	classification: "network" | "auth_invalid" | "email_unconfirmed" | "otp_required" | "rls" | "unknown";
}

function classifyAuthError(err: { code?: string; message?: string }): AuthError {
	const code = err.code ?? "";
	const msg = err.message ?? "unknown error";
	if (code === "email_not_confirmed") {
		return { code, message: msg, classification: "email_unconfirmed" };
	}
	if (code === "invalid_credentials") {
		return { code, message: msg, classification: "auth_invalid" };
	}
	if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")) {
		return { code, message: msg, classification: "network" };
	}
	return { code, message: msg, classification: "unknown" };
}

export class ProjectClientPool {
	private settings: SupaBaseJumpSettings;
	private runtimes: Map<string, ProjectRuntime> = new Map();
	private listeners: Set<StatusListener> = new Set();

	constructor(settings: SupaBaseJumpSettings) {
		this.settings = settings;
	}

	addStatusListener(fn: StatusListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(id: string): void {
		const rt = this.runtimes.get(id);
		if (!rt) return;
		for (const fn of this.listeners) {
			try {
				fn(id, rt.status);
			} catch {
				// listener faults must not break the pool
			}
		}
	}

	updateStatus(id: string, state: ProjectStatusState, detail = ""): void {
		const rt = this.runtimes.get(id);
		if (!rt) return;
		rt.status = { state, detail };
		this.notify(id);
	}

	getStatus(id: string): ProjectStatusView {
		const rt = this.runtimes.get(id);
		if (!rt) return { state: "offline", detail: "not initialized" };
		return rt.status;
	}

	getAggregateState(): ProjectStatusState {
		const enabled = enabledOrdered(this.settings.projects);
		if (enabled.length === 0) return "offline";
		const states = enabled.map((p) => this.getStatus(p.id).state);
		if (states.every((s) => s === "synced")) return "synced";
		if (states.some((s) => s === "syncing")) return "syncing";
		if (states.some((s) => s === "error")) return "error";
		if (states.some((s) => s === "degraded")) return "degraded";
		if (states.some((s) => s === "connecting")) return "connecting";
		return "offline";
	}

	aggregateLabel(): string {
		const enabled = enabledOrdered(this.settings.projects);
		if (enabled.length === 0) return "no projects configured";
		const syncedCount = enabled.filter((p) => this.getStatus(p.id).state === "synced").length;
		return `${syncedCount}/${enabled.length} project${enabled.length > 1 ? "s" : ""} synced`;
	}

	getRuntime(id: string): ProjectRuntime | null {
		return this.runtimes.get(id) ?? null;
	}

	forFile(path: string): ProjectRuntime | null {
		const project = shardFor(path, this.settings.projects, this.settings.routing.hashSalt);
		if (!project) return null;
		return this.runtimes.get(project.id) ?? null;
	}

	*forAllEnabled(): IterableIterator<ProjectRuntime> {
		for (const p of enabledOrdered(this.settings.projects)) {
			const rt = this.runtimes.get(p.id);
			if (rt) yield rt;
		}
	}

	enabledProjectCount(): number {
		return enabledOrdered(this.settings.projects).length;
	}

	async connectAll(): Promise<ConnectResult[]> {
		const results: ConnectResult[] = [];
		for (const project of enabledOrdered(this.settings.projects)) {
			results.push(await this.connect(project));
		}
		return results;
	}

	async connect(project: ProjectConfig): Promise<ConnectResult> {
		if (!project.supabaseUrl || !project.supabaseAnonKey) {
			this.upsertRuntime(project, null);
			this.updateStatus(project.id, "offline", "missing url or key");
			return { id: project.id, ok: false, state: "offline", detail: "missing url or key" };
		}

		let url: URL;
		try {
			url = new URL(project.supabaseUrl);
		} catch {
			this.upsertRuntime(project, null);
			this.updateStatus(project.id, "error", "invalid project URL");
			return { id: project.id, ok: false, state: "error", detail: "invalid project URL" };
		}

		this.updateRuntimeClient(project, url.toString());
		this.updateStatus(project.id, "connecting", `signing in (${project.authMethod})`);

		if (project.authMethod === "password") {
			return await this.signInPassword(project);
		}
		return await this.requestOtp(project);
	}

	private updateRuntimeClient(project: ProjectConfig, url: string): void {
		const existing = this.runtimes.get(project.id);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase-js generic widening, the runtime API surface is the same
		const client: SupabaseClient = createClient(url, project.supabaseAnonKey, {
			auth: {
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: false,
				storageKey: `sbj-${project.id}`,
			},
		});
		if (existing) {
			void existing.client.removeAllChannels().catch(() => {});
		}
		this.runtimes.set(project.id, {
			id: project.id,
			client,
			status: { state: "connecting", detail: "" },
			userId: null,
			lastConnectErr: null,
		});
	}

	private upsertRuntime(project: ProjectConfig, _: null): void {
		if (!this.runtimes.has(project.id)) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase-js generic widening, placeholder client is never queried
			const placeholder: SupabaseClient = createClient("https://invalid.invalid", "anon", {
				auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
			});
			this.runtimes.set(project.id, {
				id: project.id,
				client: placeholder,
				status: { state: "offline", detail: "" },
				userId: null,
				lastConnectErr: null,
			});
		}
	}

	private async signInPassword(project: ProjectConfig): Promise<ConnectResult> {
		const rt = this.runtimes.get(project.id)!;
		const password = decryptSecret(project.passwordEncrypted, this.settings.vaultId);

		if (!project.email || !password) {
			this.updateStatus(project.id, "offline", "email or password missing");
			return { id: project.id, ok: false, state: "offline", detail: "email or password missing" };
		}

		const signIn = await rt.client.auth.signInWithPassword({
			email: project.email,
			password,
		});

		if (!signIn.error) {
			rt.userId = signIn.data.user?.id ?? null;
			this.updateStatus(project.id, "synced", "signed in");
			logger.info("auth", `signed in to ${project.label}`, { projectId: project.id });
			return { id: project.id, ok: true, state: "synced", detail: "signed in" };
		}

		const classified = classifyAuthError(signIn.error);

		if (classified.classification === "auth_invalid") {
			// Try sign-up — common when a Supabase project was just created and the user hasn't created an account yet.
			const signUp = await rt.client.auth.signUp({ email: project.email, password });
			if (signUp.error) {
				const e = classifyAuthError(signUp.error);
				rt.lastConnectErr = e.message;
				this.updateStatus(project.id, "error", `sign-up failed: ${e.message}`);
				logger.error("auth", `sign-up failed for ${project.label}`, { error: e });
				return { id: project.id, ok: false, state: "error", detail: e.message };
			}
			const confirmed = signUp.data.user?.confirmed_at;
			if (!confirmed) {
				this.updateStatus(project.id, "offline", "confirmation email pending");
				logger.info("auth", `confirmation pending for ${project.label}`, { projectId: project.id });
				return { id: project.id, ok: false, state: "offline", detail: "confirmation email pending" };
			}
			rt.userId = signUp.data.user?.id ?? null;
			this.updateStatus(project.id, "synced", "account created");
			return { id: project.id, ok: true, state: "synced", detail: "account created" };
		}

		if (classified.classification === "email_unconfirmed") {
			this.updateStatus(project.id, "offline", "email not confirmed");
			return { id: project.id, ok: false, state: "offline", detail: "email not confirmed" };
		}

		rt.lastConnectErr = classified.message;
		this.updateStatus(project.id, "error", classified.message);
		logger.error("auth", `sign-in failed for ${project.label}`, { error: classified });
		return { id: project.id, ok: false, state: "error", detail: classified.message };
	}

	private async requestOtp(project: ProjectConfig): Promise<ConnectResult> {
		const rt = this.runtimes.get(project.id)!;

		if (!project.email) {
			this.updateStatus(project.id, "offline", "email missing");
			return { id: project.id, ok: false, state: "offline", detail: "email missing" };
		}

		// Skip sending if we already have a live session — autoRefreshToken handles renewal.
		const session = await rt.client.auth.getSession();
		if (session.data.session) {
			rt.userId = session.data.session.user.id;
			this.updateStatus(project.id, "synced", "session restored");
			return { id: project.id, ok: true, state: "synced", detail: "session restored" };
		}

		const { error } = await rt.client.auth.signInWithOtp({
			email: project.email,
			options: { shouldCreateUser: true },
		});

		if (error) {
			const classified = classifyAuthError(error);
			this.updateStatus(project.id, "error", `OTP request failed: ${classified.message}`);
			return { id: project.id, ok: false, state: "error", detail: classified.message };
		}

		this.updateStatus(project.id, "connecting", "OTP sent — awaiting code");
		return {
			id: project.id,
			ok: false,
			state: "connecting",
			detail: "OTP sent to email",
			pendingOtp: true,
		};
	}

	async verifyOtp(projectId: string, code: string): Promise<ConnectResult> {
		const project = this.settings.projects.find((p) => p.id === projectId);
		const rt = this.runtimes.get(projectId);
		if (!project || !rt) {
			return { id: projectId, ok: false, state: "error", detail: "project not initialized" };
		}

		const { data, error } = await rt.client.auth.verifyOtp({
			email: project.email,
			token: code.trim(),
			type: "email",
		});

		if (error) {
			const classified = classifyAuthError(error);
			this.updateStatus(projectId, "error", `OTP verify failed: ${classified.message}`);
			logger.warn("auth", `OTP verify failed for ${project.label}`, { error: classified });
			return { id: projectId, ok: false, state: "error", detail: classified.message };
		}

		rt.userId = data.user?.id ?? null;
		this.updateStatus(projectId, "synced", "verified");
		logger.info("auth", `OTP verified for ${project.label}`, { projectId });
		return { id: projectId, ok: true, state: "synced", detail: "verified" };
	}

	async getUserId(projectId: string): Promise<string> {
		const rt = this.runtimes.get(projectId);
		if (!rt) throw new Error("Supabase jump: project not connected.");
		if (rt.userId) return rt.userId;
		const { data, error } = await rt.client.auth.getUser();
		if (error || !data.user) throw new Error("Supabase jump: not authenticated.");
		rt.userId = data.user.id;
		return data.user.id;
	}

	async refreshSession(projectId: string): Promise<boolean> {
		const rt = this.runtimes.get(projectId);
		if (!rt) return false;
		const { data, error } = await rt.client.auth.refreshSession();
		if (error) {
			logger.warn("auth", `refreshSession failed`, { projectId, error: error.message });
			return false;
		}
		rt.userId = data.user?.id ?? rt.userId;
		return true;
	}

	async signOutAll(): Promise<void> {
		for (const rt of this.runtimes.values()) {
			try {
				await rt.client.auth.signOut();
			} catch {
				// best-effort
			}
			this.updateStatus(rt.id, "offline", "signed out");
		}
	}

	cleanup(): void {
		for (const rt of this.runtimes.values()) {
			void rt.client.removeAllChannels().catch(() => {});
		}
		this.runtimes.clear();
	}

	// Refresh runtimes when settings change (e.g. project added/removed/toggled).
	syncFromSettings(): void {
		// Drop runtimes for projects that no longer exist.
		const ids = new Set(this.settings.projects.map((p) => p.id));
		for (const id of Array.from(this.runtimes.keys())) {
			if (!ids.has(id)) {
				const rt = this.runtimes.get(id);
				if (rt) void rt.client.removeAllChannels().catch(() => {});
				this.runtimes.delete(id);
			}
		}
	}
}

export function isJwtExpired(err: { code?: string; message?: string } | null | undefined): boolean {
	if (!err) return false;
	const code = (err.code ?? "").toLowerCase();
	const msg = (err.message ?? "").toLowerCase();
	return (
		code === "pgrst301" ||
		msg.includes("jwt expired") ||
		msg.includes("token has expired") ||
		msg.includes("invalid jwt")
	);
}

export function isRlsError(err: { code?: string; message?: string } | null | undefined): boolean {
	if (!err) return false;
	const code = (err.code ?? "").toLowerCase();
	const msg = (err.message ?? "").toLowerCase();
	return code === "42501" || msg.includes("violates row-level security");
}
