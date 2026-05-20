import { App, Modal, Notice, requestUrl, Setting } from "obsidian";
import { logger } from "./logger";
import { AuthMethod, ProjectConfig, SupaBaseJumpSettings } from "./settings";
import { encryptSecret } from "./secret-storage";
import { ProjectClientPool } from "./project-client-pool";

interface SqlStep {
	id: string;
	label: string;
	sql: string;
}

// Labelled SQL fragments so a failure on CREATE POLICY is distinguishable from
// CREATE TABLE or ALTER PUBLICATION.
const SQL_STEPS: SqlStep[] = [
	{
		id: "create-table",
		label: "Create vault_files table",
		sql: `CREATE TABLE IF NOT EXISTS vault_files (
  id           text primary key,
  vault_id     text not null,
  path         text not null,
  content      text,
  storage_path text,
  is_binary    boolean default false,
  frontmatter  jsonb,
  tags         text[],
  mtime        bigint not null,
  ctime        bigint not null,
  size         bigint not null,
  deleted      boolean default false,
  updated_at   timestamptz default now(),
  user_id      uuid references auth.users(id),
  platform     text default 'all'
);`,
	},
	{
		id: "alter-columns",
		label: "Ensure optional columns exist (frontmatter, tags, platform)",
		sql: `ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS frontmatter jsonb;
ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS platform text DEFAULT 'all';`,
	},
	{
		id: "create-indexes",
		label: "Create indexes",
		sql: `CREATE INDEX IF NOT EXISTS vault_files_vault_path ON vault_files(vault_id, path);
CREATE INDEX IF NOT EXISTS vault_files_vault_mtime ON vault_files(vault_id, mtime);
CREATE INDEX IF NOT EXISTS vault_files_tags ON vault_files USING gin(tags);`,
	},
	{
		id: "enable-rls",
		label: "Enable Row Level Security",
		sql: `ALTER TABLE vault_files ENABLE ROW LEVEL SECURITY;`,
	},
	{
		id: "create-policy",
		label: "Create vault_files RLS policy",
		sql: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='vault_files' AND policyname='Users manage own vault'
  ) THEN
    CREATE POLICY "Users manage own vault" ON vault_files FOR ALL
      USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;`,
	},
	{
		id: "add-publication",
		label: "Add vault_files to realtime publication",
		sql: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='vault_files'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE vault_files;
  END IF;
END $$;`,
	},
	{
		id: "storage-rls",
		label: "Create storage.objects RLS policy",
		sql: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='objects' AND schemaname='storage'
    AND policyname='Users manage own attachments'
  ) THEN
    CREATE POLICY "Users manage own attachments"
      ON storage.objects FOR ALL
      USING (auth.uid()::text = (storage.foldername(name))[1])
      WITH CHECK (auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
END $$;`,
	},
];

export type WizardMode = "first-run" | "add-project" | "edit-project";

export interface WizardHostBindings {
	settings: SupaBaseJumpSettings;
	pool: ProjectClientPool;
	saveSettings(): Promise<void>;
	connectProject(projectId: string): Promise<void>;
	refreshSettingsUi(): void;
}

interface StepStatus {
	id: string;
	label: string;
	state: "pending" | "running" | "ok" | "fail";
	detail: string;
	endpoint?: string;
	httpStatus?: number;
	body?: string;
}

interface WizardState {
	draft: ProjectConfig;
	pat: string;
	bucketOk: boolean;
	bucketDetail: string;
	bucketEndpoint?: string;
	bucketStatus?: number;
	bucketBody?: string;
	sqlSteps: Map<string, StepStatus>;
	pendingOtp: boolean;
	otpCode: string;
	probeOk: boolean | null;
	probeDetail: string;
}

function projectRefFrom(url: string): string | null {
	try {
		const u = new URL(url);
		const host = u.hostname;
		const dot = host.indexOf(".");
		return dot > 0 ? host.slice(0, dot) : null;
	} catch {
		return null;
	}
}

function newProjectId(): string {
	return window.crypto.randomUUID();
}

function blankDraft(label: string): ProjectConfig {
	return {
		id: newProjectId(),
		label,
		supabaseUrl: "",
		supabaseAnonKey: "",
		authMethod: "password",
		email: "",
		passwordEncrypted: "",
		enabled: true,
		lastUsedBytes: 0,
		lastConnectedAt: 0,
	};
}

export class SetupWizardModal extends Modal {
	private host: WizardHostBindings;
	private mode: WizardMode;
	private state: WizardState;
	private projectId: string | null;
	private password = "";

	constructor(
		app: App,
		host: WizardHostBindings,
		mode: WizardMode,
		projectId?: string,
	) {
		super(app);
		this.host = host;
		this.mode = mode;
		this.projectId = projectId ?? null;

		const initialSteps = new Map<string, StepStatus>();
		for (const s of SQL_STEPS) {
			initialSteps.set(s.id, { id: s.id, label: s.label, state: "pending", detail: "" });
		}

		if (mode === "edit-project" && projectId) {
			const existing = host.settings.projects.find((p) => p.id === projectId);
			this.state = {
				draft: existing ? { ...existing } : blankDraft("New project"),
				pat: "",
				bucketOk: false,
				bucketDetail: "",
				sqlSteps: initialSteps,
				pendingOtp: false,
				otpCode: "",
				probeOk: null,
				probeDetail: "",
			};
		} else {
			const label =
				mode === "first-run"
					? `Project 1`
					: `Project ${host.settings.projects.length + 1}`;
			this.state = {
				draft: blankDraft(label),
				pat: "",
				bucketOk: false,
				bucketDetail: "",
				sqlSteps: initialSteps,
				pendingOtp: false,
				otpCode: "",
				probeOk: null,
				probeDetail: "",
			};
		}
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("sbj-wizard");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();

		root.createEl("h2", {
			text: this.mode === "edit-project" ? "Edit project" : "Set up a Supabase project",
		});

		this.renderTransfer(root);
		this.renderCredentials(root);
		if (this.mode !== "edit-project") {
			this.renderSchema(root);
			this.renderBucket(root);
		}
		this.renderAuth(root);
		this.renderProbe(root);
		this.renderFinish(root);
	}

	private renderTransfer(root: HTMLElement): void {
		new Setting(root).setName("Transfer setup").setHeading();

		root.createEl("p", {
			text: "Copy one string to set up the same project on another device. The password is included (lightly obfuscated, like the rest of the plugin's storage) — treat the blob as a credential and do not share it.",
			cls: "sbj-help",
		});

		new Setting(root)
			.setName("Export this project")
			.setDesc("Copies URL + anon key + email + vault ID + label + password to your clipboard.")
			.addButton((btn) =>
				btn.setButtonText("Copy export string").onClick(async () => {
					const blob = this.buildExportBlob();
					if (!blob) {
						new Notice("Supabase jump: fill in URL, anon key, and email first.");
						return;
					}
					try {
						await navigator.clipboard.writeText(blob);
						new Notice("Supabase jump: setup copied to clipboard.");
					} catch (err) {
						new Notice(
							`Supabase jump: clipboard write failed — ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}),
			);

		if (this.mode !== "edit-project") {
			let importValue = "";
			new Setting(root)
				.setName("Import setup")
				.setDesc("Paste an export string here, then click Apply.")
				.addText((t) =>
					t.setPlaceholder("eyJ2Ijox…").onChange((v) => {
						importValue = v.trim();
					}),
				)
				.addButton((btn) =>
					btn.setButtonText("Apply").onClick(async () => {
						if (!this.applyImportBlob(importValue)) return;
						await this.persistDraft();
						new Notice(
							"Supabase jump: setup imported. Enter your password (or send OTP) below to sign in.",
						);
						this.render();
					}),
				);
		}
	}

	private buildExportBlob(): string | null {
		const d = this.state.draft;
		if (!d.supabaseUrl || !d.supabaseAnonKey || !d.email) return null;
		const passwordEncrypted =
			d.authMethod === "password" && this.password
				? encryptSecret(this.password, this.host.settings.vaultId)
				: d.passwordEncrypted;
		const payload = {
			v: 2,
			label: d.label,
			supabaseUrl: d.supabaseUrl,
			supabaseAnonKey: d.supabaseAnonKey,
			authMethod: d.authMethod,
			email: d.email,
			vaultId: this.host.settings.vaultId,
			passwordEncrypted,
		};
		try {
			return btoa(JSON.stringify(payload));
		} catch {
			return null;
		}
	}

	private applyImportBlob(raw: string): boolean {
		if (!raw) {
			new Notice("Supabase jump: import string is empty.");
			return false;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(atob(raw));
		} catch {
			new Notice("Supabase jump: could not decode import string.");
			return false;
		}
		if (typeof parsed !== "object" || parsed === null) {
			new Notice("Supabase jump: import payload is invalid.");
			return false;
		}
		const p = parsed as Record<string, unknown>;
		if (p.v !== 1 && p.v !== 2) {
			new Notice("Supabase jump: unsupported import version.");
			return false;
		}
		if (
			typeof p.supabaseUrl !== "string" ||
			typeof p.supabaseAnonKey !== "string" ||
			typeof p.email !== "string"
		) {
			new Notice("Supabase jump: required fields missing in import.");
			return false;
		}
		if (typeof p.label === "string" && p.label) this.state.draft.label = p.label;
		this.state.draft.supabaseUrl = p.supabaseUrl;
		this.state.draft.supabaseAnonKey = p.supabaseAnonKey;
		this.state.draft.email = p.email;
		if (p.authMethod === "password" || p.authMethod === "magic_link") {
			this.state.draft.authMethod = p.authMethod;
		}
		if (typeof p.vaultId === "string" && p.vaultId) {
			this.host.settings.vaultId = p.vaultId;
		}
		if (typeof p.passwordEncrypted === "string") {
			this.state.draft.passwordEncrypted = p.passwordEncrypted;
		}
		return true;
	}

	private renderCredentials(root: HTMLElement): void {
		new Setting(root).setName("Credentials").setHeading();

		new Setting(root)
			.setName("Project label")
			.setDesc("A short name shown in settings (e.g. 'home free', 'work free').")
			.addText((t) =>
				t.setValue(this.state.draft.label).onChange((v) => {
					this.state.draft.label = v.trim();
				}),
			);

		new Setting(root)
			.setName("Project URL")
			.setDesc("Found at supabase.com/dashboard/project/<ref>/settings/api.")
			.addText((t) =>
				t
					.setPlaceholder("https://xxxx.supabase.co")
					.setValue(this.state.draft.supabaseUrl)
					.onChange((v) => {
						this.state.draft.supabaseUrl = v.trim();
					}),
			);

		new Setting(root)
			.setName("Anon/public API key")
			.setDesc("Same page as the URL; do not paste the service-role key.")
			.addText((t) => {
				t.setValue(this.state.draft.supabaseAnonKey).onChange((v) => {
					this.state.draft.supabaseAnonKey = v.trim();
				});
				t.inputEl.type = "password";
			});
	}

	private renderSchema(root: HTMLElement): void {
		new Setting(root).setName("Schema setup").setHeading();

		root.createEl("p", {
			text: "Paste a personal access token to run the setup SQL via the Supabase management API. The token is used once and not stored.",
			cls: "sbj-help",
		});

		new Setting(root)
			.setName("Personal access token")
			.setDesc("Create one at supabase.com/dashboard/account/tokens (scope: this project).")
			.addText((t) => {
				t.setPlaceholder("Sbp_...").setValue(this.state.pat).onChange((v) => {
					this.state.pat = v.trim();
				});
				t.inputEl.type = "password";
			});

		const stepList = root.createDiv({ cls: "sbj-step-list" });
		this.renderStepList(stepList);

		new Setting(root).addButton((btn) =>
			btn
				.setButtonText("Run / retry schema setup")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.runSchemaSteps();
					} finally {
						btn.setDisabled(false);
						this.renderStepList(stepList);
					}
				}),
		);
	}

	private renderStepList(container: HTMLElement): void {
		container.empty();
		for (const [, status] of this.state.sqlSteps) {
			const row = container.createDiv({ cls: `sbj-step sbj-step-${status.state}` });
			row.createSpan({ text: this.iconForState(status.state), cls: "sbj-step-icon" });
			row.createSpan({ text: status.label, cls: "sbj-step-label" });
			if (status.state === "fail") {
				const det = row.createDiv({ cls: "sbj-step-detail" });
				if (status.httpStatus !== undefined) {
					det.createEl("p", { text: `HTTP ${status.httpStatus} at ${status.endpoint ?? ""}` });
				}
				if (status.body) {
					const pre = det.createEl("pre");
					pre.setText(status.body.slice(0, 1500));
				}
				const btn = det.createEl("button", { text: "Retry just this step" });
				btn.onclick = async () => {
					btn.disabled = true;
					await this.runSchemaStep(status.id);
					this.renderStepList(container);
					btn.disabled = false;
				};
			} else if (status.state === "ok" && status.detail) {
				row.createSpan({ text: ` — ${status.detail}`, cls: "sbj-step-note" });
			}
		}
	}

	private iconForState(state: StepStatus["state"]): string {
		switch (state) {
			case "ok": return "✓ ";
			case "fail": return "✗ ";
			case "running": return "… ";
			default: return "○ ";
		}
	}

	private renderBucket(root: HTMLElement): void {
		new Setting(root).setName("Storage bucket").setHeading();
		const status = root.createDiv({ cls: "sbj-bucket-status" });
		this.renderBucketStatus(status);

		new Setting(root)
			.setName("Create vault-attachments bucket")
			.setDesc("Private bucket for binary file uploads. Created via SQL through the management query endpoint.")
			.addButton((btn) =>
				btn.setButtonText("Create / verify").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.runBucketStep();
					} finally {
						btn.setDisabled(false);
						this.renderBucketStatus(status);
					}
				}),
			);
	}

	private renderBucketStatus(container: HTMLElement): void {
		container.empty();
		if (this.state.bucketOk) {
			container.createEl("p", { text: `✓ ${this.state.bucketDetail || "ready"}`, cls: "sbj-ok" });
			return;
		}
		if (this.state.bucketDetail) {
			container.createEl("p", { text: `✗ ${this.state.bucketDetail}`, cls: "sbj-fail" });
			if (this.state.bucketStatus !== undefined) {
				container.createEl("p", {
					text: `HTTP ${this.state.bucketStatus} at ${this.state.bucketEndpoint ?? ""}`,
				});
			}
			if (this.state.bucketBody) {
				const pre = container.createEl("pre");
				pre.setText(this.state.bucketBody.slice(0, 1500));
			}
			container.createEl("p", {
				text: "If auto-create keeps failing, create the bucket manually in Supabase → Storage (name: vault-attachments, public: OFF), then click Create / verify to confirm.",
				cls: "sbj-help",
			});
		}
	}

	private renderAuth(root: HTMLElement): void {
		new Setting(root).setName("Authentication").setHeading();

		new Setting(root)
			.setName("Method")
			.setDesc("Password requires sign-up via Supabase. Magic-link requires SMTP to be configured in your project.")
			.addDropdown((dd) =>
				dd
					.addOptions({ password: "Email + password", magic_link: "Magic-link OTP" })
					.setValue(this.state.draft.authMethod)
					.onChange((v) => {
						this.state.draft.authMethod = v as AuthMethod;
						this.render();
					}),
			);

		new Setting(root)
			.setName("Email")
			.addText((t) =>
				t.setValue(this.state.draft.email).onChange((v) => {
					this.state.draft.email = v.trim();
				}),
			);

		if (this.state.draft.authMethod === "password") {
			new Setting(root)
				.setName("Password")
				.setDesc("Stored locally with light obfuscation (see readme — not encryption-grade).")
				.addText((t) => {
					t.setPlaceholder("••••••••").setValue(this.password).onChange((v) => {
						this.password = v;
					});
					t.inputEl.type = "password";
				});
		} else {
			new Setting(root)
				.setName("Send otp")
				.setDesc("Sends a 6-digit code to your email. Paste it below.")
				.addButton((btn) =>
					btn.setButtonText("Send code").onClick(async () => {
						btn.setDisabled(true);
						try {
							await this.persistDraft();
							const res = await this.host.pool.connect(this.state.draft);
							this.state.pendingOtp = !!res.pendingOtp;
							if (res.pendingOtp) {
								new Notice(`Supabase jump: OTP sent to ${this.state.draft.email}`);
								this.render();
							} else if (res.state === "error") {
								new Notice(`Supabase jump: OTP request failed — ${res.detail}`);
							}
						} finally {
							btn.setDisabled(false);
						}
					}),
				);

			if (this.state.pendingOtp) {
				new Setting(root)
					.setName("Otp code")
					.addText((t) =>
						t.setValue(this.state.otpCode).onChange((v) => {
							this.state.otpCode = v.trim();
						}),
					)
					.addButton((btn) =>
						btn.setButtonText("Verify").onClick(async () => {
							btn.setDisabled(true);
							try {
								const result = await this.host.pool.verifyOtp(
									this.state.draft.id,
									this.state.otpCode,
								);
								if (result.ok) {
									new Notice(`Supabase jump: signed in to ${this.state.draft.label}`);
									this.state.pendingOtp = false;
									this.render();
								} else {
									new Notice(`Supabase jump: OTP verify failed — ${result.detail}`);
								}
							} finally {
								btn.setDisabled(false);
							}
						}),
					);
			}
		}
	}

	private renderProbe(root: HTMLElement): void {
		new Setting(root).setName("Verify").setHeading();
		const status = root.createDiv({ cls: "sbj-probe-status" });

		const refresh = (): void => {
			status.empty();
			if (this.state.probeOk === true) {
				status.createEl("p", { text: `✓ ${this.state.probeDetail}`, cls: "sbj-ok" });
			} else if (this.state.probeOk === false) {
				status.createEl("p", { text: `✗ ${this.state.probeDetail}`, cls: "sbj-fail" });
			} else {
				status.createEl("p", { text: "Run verification after schema + auth complete.", cls: "sbj-help" });
			}
		};
		refresh();

		new Setting(root)
			.setName("Run verification")
			.setDesc("Reads vault_files (rls-aware) and round-trips a tiny row to confirm the project is usable.")
			.addButton((btn) =>
				btn.setButtonText("Verify").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.runProbe();
					} finally {
						btn.setDisabled(false);
						refresh();
					}
				}),
			);
	}

	private renderFinish(root: HTMLElement): void {
		new Setting(root)
			.setName("Save")
			.setDesc("Persist this project to settings.")
			.addButton((btn) =>
				btn
					.setButtonText("Save project")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						try {
							await this.persistDraft();
							await this.host.connectProject(this.state.draft.id);
							new Notice(`Supabase jump: project "${this.state.draft.label}" saved`);
							this.host.refreshSettingsUi();
							this.close();
						} finally {
							btn.setDisabled(false);
						}
					}),
			);
	}

	private async persistDraft(): Promise<void> {
		if (this.password && this.state.draft.authMethod === "password") {
			this.state.draft.passwordEncrypted = encryptSecret(
				this.password,
				this.host.settings.vaultId,
			);
		} else if (this.state.draft.authMethod === "magic_link") {
			this.state.draft.passwordEncrypted = "";
		}

		const idx = this.host.settings.projects.findIndex((p) => p.id === this.state.draft.id);
		if (idx >= 0) {
			this.host.settings.projects[idx] = { ...this.state.draft };
		} else {
			this.host.settings.projects.push({ ...this.state.draft });
		}
		await this.host.saveSettings();
	}

	private async runSchemaSteps(): Promise<void> {
		for (const step of SQL_STEPS) {
			await this.runSchemaStep(step.id);
			const status = this.state.sqlSteps.get(step.id);
			if (status?.state === "fail") break;
		}
	}

	private async runSchemaStep(id: string): Promise<void> {
		const step = SQL_STEPS.find((s) => s.id === id);
		const status = this.state.sqlSteps.get(id);
		if (!step || !status) return;

		const ref = projectRefFrom(this.state.draft.supabaseUrl);
		if (!ref) {
			status.state = "fail";
			status.detail = "Project URL is not a valid Supabase project URL.";
			return;
		}
		if (!this.state.pat) {
			status.state = "fail";
			status.detail = "Personal access token is required.";
			return;
		}

		const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
		status.state = "running";
		status.detail = "";
		status.endpoint = endpoint;

		try {
			const res = await requestUrl({
				url: endpoint,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.state.pat}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query: step.sql }),
				throw: false,
			});
			status.httpStatus = res.status;
			status.body = res.text;
			if (res.status >= 200 && res.status < 300) {
				status.state = "ok";
				status.detail = "done";
			} else {
				status.state = "fail";
				status.detail = `HTTP ${res.status}`;
				logger.warn("setup", `${step.id} failed`, { ref, status: res.status });
			}
		} catch (err) {
			status.state = "fail";
			status.detail = err instanceof Error ? err.message : String(err);
			logger.error("setup", `${step.id} threw`, { ref, error: status.detail });
		}
	}

	private async runBucketStep(): Promise<void> {
		const ref = projectRefFrom(this.state.draft.supabaseUrl);
		if (!ref) {
			this.state.bucketOk = false;
			this.state.bucketDetail = "Project URL is not a valid Supabase project URL.";
			return;
		}
		if (!this.state.pat) {
			this.state.bucketOk = false;
			this.state.bucketDetail = "Personal access token is required.";
			return;
		}

		const listEndpoint = `https://api.supabase.com/v1/projects/${ref}/storage/buckets`;
		const queryEndpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
		this.state.bucketEndpoint = listEndpoint;

		const listBuckets = async (): Promise<{ ok: boolean; found: boolean; status: number; body: string; detail?: string }> => {
			const res = await requestUrl({
				url: listEndpoint,
				method: "GET",
				headers: { Authorization: `Bearer ${this.state.pat}` },
				throw: false,
			});
			if (res.status < 200 || res.status >= 300) {
				return { ok: false, found: false, status: res.status, body: res.text, detail: `HTTP ${res.status} — could not list buckets` };
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(res.text);
			} catch {
				return { ok: false, found: false, status: res.status, body: res.text, detail: "could not parse buckets response" };
			}
			const found =
				Array.isArray(parsed) &&
				parsed.some((b: unknown) => {
					if (typeof b !== "object" || b === null) return false;
					const rec = b as { name?: unknown; id?: unknown };
					return rec.name === "vault-attachments" || rec.id === "vault-attachments";
				});
			return { ok: true, found, status: res.status, body: res.text };
		};

		try {
			const first = await listBuckets();
			this.state.bucketStatus = first.status;
			this.state.bucketBody = first.body;
			if (!first.ok) {
				this.state.bucketOk = false;
				this.state.bucketDetail = first.detail ?? `HTTP ${first.status}`;
				logger.warn("setup", `bucket list failed`, { ref, status: first.status });
				return;
			}
			if (first.found) {
				this.state.bucketOk = true;
				this.state.bucketDetail = "bucket already exists";
				return;
			}

			this.state.bucketEndpoint = queryEndpoint;
			const createSql = `INSERT INTO storage.buckets (id, name, public) VALUES ('vault-attachments', 'vault-attachments', false) ON CONFLICT (id) DO NOTHING;`;
			const createRes = await requestUrl({
				url: queryEndpoint,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.state.pat}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query: createSql }),
				throw: false,
			});
			this.state.bucketStatus = createRes.status;
			this.state.bucketBody = createRes.text;
			if (createRes.status < 200 || createRes.status >= 300) {
				this.state.bucketOk = false;
				this.state.bucketDetail = `HTTP ${createRes.status} — could not create bucket via SQL`;
				logger.warn("setup", `bucket create (SQL) failed`, { ref, status: createRes.status });
				return;
			}

			this.state.bucketEndpoint = listEndpoint;
			const second = await listBuckets();
			this.state.bucketStatus = second.status;
			this.state.bucketBody = second.body;
			if (second.ok && second.found) {
				this.state.bucketOk = true;
				this.state.bucketDetail = "bucket created";
			} else {
				this.state.bucketOk = false;
				this.state.bucketDetail = "bucket insert reported success but bucket not visible — check Supabase → Storage";
			}
		} catch (err) {
			this.state.bucketOk = false;
			this.state.bucketDetail = err instanceof Error ? err.message : String(err);
		}
	}

	private async runProbe(): Promise<void> {
		await this.persistDraft();
		// Connect (may be a no-op if already signed in for magic-link).
		const conn = await this.host.pool.connect(this.state.draft);
		if (!conn.ok && !conn.pendingOtp) {
			this.state.probeOk = false;
			this.state.probeDetail = `connect failed — ${conn.detail}`;
			return;
		}
		const rt = this.host.pool.getRuntime(this.state.draft.id);
		if (!rt) {
			this.state.probeOk = false;
			this.state.probeDetail = "project runtime missing";
			return;
		}

		try {
			const { error: selectErr } = await rt.client
				.from("vault_files")
				.select("id")
				.limit(1);
			if (selectErr) {
				this.state.probeOk = false;
				this.state.probeDetail = `read failed — ${selectErr.message}`;
				return;
			}

			const userId = await this.host.pool.getUserId(this.state.draft.id);
			const probeId = `${this.host.settings.vaultId}::__sbj_probe__`;
			const { error: writeErr } = await rt.client.from("vault_files").upsert({
				id: probeId,
				user_id: userId,
				vault_id: this.host.settings.vaultId,
				path: "__sbj_probe__",
				is_binary: false,
				storage_path: null,
				content: "",
				platform: "all",
				mtime: Date.now(),
				ctime: Date.now(),
				size: 0,
				deleted: true,
				updated_at: new Date().toISOString(),
			});
			if (writeErr) {
				this.state.probeOk = false;
				this.state.probeDetail = `write failed — ${writeErr.message}`;
				return;
			}

			await rt.client.from("vault_files").delete().eq("id", probeId);

			this.state.probeOk = true;
			this.state.probeDetail = "read + write round-trip succeeded";
		} catch (err) {
			this.state.probeOk = false;
			this.state.probeDetail = err instanceof Error ? err.message : String(err);
		}
	}
}
