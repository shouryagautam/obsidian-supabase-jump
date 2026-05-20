import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import { logger, type LogLevel } from "./logger";

export const SETTINGS_SCHEMA_VERSION = 2;

export type AuthMethod = "password" | "magic_link";

export interface ProjectConfig {
	id: string;
	label: string;
	supabaseUrl: string;
	supabaseAnonKey: string;
	authMethod: AuthMethod;
	email: string;
	// Stored encrypted (see secret-storage.ts). Empty string when authMethod === 'magic_link'.
	passwordEncrypted: string;
	enabled: boolean;
	// Updated after successful sync. Used for the quota readout.
	lastUsedBytes: number;
	// Updated after each connect cycle. Used by the status bar.
	lastConnectedAt: number;
}

export interface RoutingConfig {
	strategy: "hash_mod";
	hashSalt: string;
}

export interface LoggingConfig {
	level: LogLevel;
	bufferSize: number;
	enabled: boolean;
	// Auto-purge entries older than this many minutes. 0 disables time-based purge.
	maxAgeMinutes: number;
}

export interface RealtimeTuning {
	reconnectInitialMs: number;
	reconnectMaxMs: number;
	escalateAfterMs: number;
}

export interface SupaBaseJumpSettings {
	schemaVersion: number;
	vaultId: string;
	projects: ProjectConfig[];
	routing: RoutingConfig;
	logging: LoggingConfig;
	realtime: RealtimeTuning;
	syncOnStartup: boolean;
	syncConfigFolder: boolean;
	syncIntervalMinutes: number;
	excludedFolders: string[];
	platformExcludedPaths: string[];
	lastSyncTime: number;
	// Resumable rebalance progress; absent when no rebalance is queued.
	rebalanceProgress?: { startedAt: number; movedRowIds: string[] };
}

export const DEFAULT_SETTINGS: SupaBaseJumpSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	vaultId: "",
	projects: [],
	routing: { strategy: "hash_mod", hashSalt: "" },
	logging: { level: "info", bufferSize: 1000, enabled: true, maxAgeMinutes: 60 },
	realtime: {
		reconnectInitialMs: 1000,
		reconnectMaxMs: 60000,
		escalateAfterMs: 30000,
	},
	syncOnStartup: false,
	syncConfigFolder: true,
	syncIntervalMinutes: 5,
	excludedFolders: [],
	platformExcludedPaths: [],
	lastSyncTime: 0,
};

const OS_SYSTEM_FILES = new Set([
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	".localized",
	".Spotlight-V100",
	".Trashes",
	".fseventsd",
	".TemporaryItems",
	"ehthumbs.db",
	"ehthumbs_vista.db",
]);

export function isSystemFile(path: string): boolean {
	const name = path.split("/").pop() ?? "";
	return OS_SYSTEM_FILES.has(name);
}

export const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif",
	"heic", "heif", "avif",
	"mp3", "mp4", "wav", "ogg", "m4a", "flac", "aac", "avi", "mov", "mkv",
	"webm",
	"pdf", "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
	"docx", "xlsx", "pptx", "doc", "xls", "ppt",
	"ttf", "otf", "woff", "woff2", "eot",
	"exe", "dll", "dylib", "so", "dmg", "pkg", "deb", "rpm", "apk", "ipa",
	"class", "jar",
	"sig", "key", "p12", "pfx", "cer", "crt", "der", "p7b",
	"db", "sqlite", "sqlite3", "bin", "dat", "raw",
]);

export function isBinary(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

export function isExcluded(filePath: string, excludedFolders: string[]): boolean {
	if (excludedFolders.length === 0) return false;
	return excludedFolders.some((folder) => {
		const prefix = folder.replace(/\/$/, "");
		return filePath === prefix || filePath.startsWith(prefix + "/");
	});
}

export function isPlatformExcluded(
	filePath: string,
	platformExcludedPaths: string[],
): boolean {
	if (platformExcludedPaths.length === 0) return false;
	return platformExcludedPaths.some((folder) => {
		const prefix = folder.replace(/\/$/, "");
		return filePath === prefix || filePath.startsWith(prefix + "/");
	});
}

export const FALLBACK_SETUP_SQL = `-- vault_files table
CREATE TABLE IF NOT EXISTS vault_files (
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
);
CREATE INDEX IF NOT EXISTS vault_files_vault_path
  ON vault_files(vault_id, path);
CREATE INDEX IF NOT EXISTS vault_files_vault_mtime
  ON vault_files(vault_id, mtime);
CREATE INDEX IF NOT EXISTS vault_files_tags
  ON vault_files USING gin(tags);
ALTER TABLE vault_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vault" ON vault_files FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
ALTER PUBLICATION supabase_realtime ADD TABLE vault_files;

-- storage bucket: create manually in Storage → New bucket
--   Name: vault-attachments   Public: OFF
-- Then add a policy on storage.objects:
--   USING  (auth.uid()::text = (storage.foldername(name))[1])
--   WITH CHECK (same)`;

export interface ProjectStatusView {
	state: "offline" | "connecting" | "synced" | "syncing" | "error" | "degraded";
	detail: string;
}

export interface SettingsTabHost {
	settings: SupaBaseJumpSettings;
	saveSettings(): Promise<void>;
	connectAll(): Promise<void>;
	signOutAll(): Promise<void>;
	fullSync(): Promise<void>;
	fetchNow(): Promise<void>;
	openSetupWizard(mode: "first-run" | "add-project" | "edit-project", projectId?: string): void;
	openLogPanel(): void;
	copyDiagnostics(): Promise<void>;
	rebalanceNow(): Promise<void>;
	removeProject(projectId: string): Promise<void>;
	toggleProject(projectId: string, enabled: boolean): Promise<void>;
	getProjectStatus(projectId: string): ProjectStatusView;
	getTotalUsageBytes(): number;
}

export class SupaBaseJumpSettingTab extends PluginSettingTab {
	private plugin: Plugin & SettingsTabHost;

	constructor(app: App, plugin: Plugin & SettingsTabHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderHeader(containerEl);
		this.renderVault(containerEl);
		this.renderProjects(containerEl);
		this.renderSyncBehaviour(containerEl);
		this.renderPlatformPaths(containerEl);
		this.renderActions(containerEl);
		this.renderDiagnostics(containerEl);
	}

	private renderHeader(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Setup").setHeading();

		const projectCount = this.plugin.settings.projects.length;
		const enabledCount = this.plugin.settings.projects.filter((p) => p.enabled).length;
		const totalBytes = this.plugin.getTotalUsageBytes();
		const totalQuotaMb = this.plugin.settings.projects.length * 500;
		const usedMb = totalBytes > 0 ? (totalBytes / 1024 / 1024).toFixed(1) : "0";

		const summary = containerEl.createDiv({ cls: "sbj-summary" });
		if (projectCount === 0) {
			summary.createEl("p", {
				text: "No projects configured yet. Run the setup wizard to add your first Supabase project.",
			});
			new Setting(containerEl)
				.setName("Run setup wizard")
				.setDesc("Walk through creating the table, bucket, and rls policy on one or more projects.")
				.addButton((btn) =>
					btn
						.setButtonText("Open wizard")
						.setCta()
						.onClick(() => this.plugin.openSetupWizard("first-run")),
				);
		} else {
			summary.createEl("p", {
				text: `${enabledCount} of ${projectCount} project${projectCount > 1 ? "s" : ""} enabled · ~${usedMb} MB used / ~${totalQuotaMb} MB free-tier capacity`,
			});
		}
	}

	private renderVault(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Vault").setHeading();

		let vaultIdText: TextComponent;
		new Setting(containerEl)
			.setName("Vault ID")
			.setDesc(
				"Identifier for this vault. Files from different vaults syncing to the same project must use different IDs.",
			)
			.addText((text) => {
				vaultIdText = text;
				text.setPlaceholder("My-vault")
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn
					.setButtonText("Generate")
					.setTooltip("Auto-generate a unique vault ID")
					.onClick(async () => {
						const id = window.crypto
							.randomUUID()
							.replace(/-/g, "")
							.slice(0, 12);
						vaultIdText.setValue(id);
						this.plugin.settings.vaultId = id;
						await this.plugin.saveSettings();
						new Notice("Supabase jump: vault ID generated");
					}),
			);
	}

	private renderProjects(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Projects").setHeading();

		for (const project of this.plugin.settings.projects) {
			this.renderProjectCard(containerEl, project);
		}

		new Setting(containerEl)
			.setName("Add a Supabase project")
			.setDesc(
				"Add another Supabase project to expand storage beyond a single free-tier quota. Files are sharded by path hash across enabled projects.",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Add project")
					.setCta()
					.onClick(() => this.plugin.openSetupWizard("add-project")),
			);

		new Setting(containerEl)
			.setName("Connect / sign in")
			.setDesc("Sign in to every enabled project using stored credentials or magic-link otp.")
			.addButton((btn) =>
				btn
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Connecting…").setDisabled(true);
						try {
							await this.plugin.connectAll();
						} finally {
							btn.setButtonText("Connect").setDisabled(false);
						}
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Sign out all").onClick(async () => {
					await this.plugin.signOutAll();
				}),
			);

		if (this.plugin.settings.projects.length > 1) {
			new Setting(containerEl)
				.setName("Rebalance shards")
				.setDesc(
					"Re-shard existing files across the current project set. Run after adding, removing, or disabling a project.",
				)
				.addButton((btn) =>
					btn.setButtonText("Rebalance now").onClick(async () => {
						btn.setButtonText("Rebalancing…").setDisabled(true);
						try {
							await this.plugin.rebalanceNow();
						} finally {
							btn.setButtonText("Rebalance now").setDisabled(false);
						}
					}),
				);
		}
	}

	private renderProjectCard(containerEl: HTMLElement, project: ProjectConfig): void {
		const status = this.plugin.getProjectStatus(project.id);
		const card = containerEl.createDiv({ cls: "sbj-project-card" });

		const setting = new Setting(card)
			.setName(project.label || "(unnamed project)")
			.setDesc(
				`${project.supabaseUrl || "no URL"} · auth: ${project.authMethod === "magic_link" ? "magic link" : "password"} · ${status.state}${status.detail ? " — " + status.detail : ""}`,
			);

		setting.addToggle((toggle) =>
			toggle.setValue(project.enabled).onChange(async (value) => {
				await this.plugin.toggleProject(project.id, value);
				this.display();
			}),
		);

		setting.addButton((btn) =>
			btn
				.setButtonText("Edit")
				.onClick(() => this.plugin.openSetupWizard("edit-project", project.id)),
		);

		setting.addButton((btn) =>
			btn.setButtonText("Remove").setWarning().onClick(async () => {
				// eslint-disable-next-line no-alert -- Obsidian has no built-in confirm dialog; a custom Modal is overkill for a low-risk destructive op
				const ok = window.confirm(
					`Remove project "${project.label || project.id}"? Files on this project will become unreachable until you re-add it or rebalance.`,
				);
				if (!ok) return;
				await this.plugin.removeProject(project.id);
				this.display();
			}),
		);

		if (project.lastUsedBytes > 0) {
			const mb = (project.lastUsedBytes / 1024 / 1024).toFixed(1);
			const pct = Math.min(100, Math.round((project.lastUsedBytes / (500 * 1024 * 1024)) * 100));
			card.createEl("p", {
				text: `${mb} MB used of ~500 MB free tier (${pct}%)`,
				cls: "sbj-project-quota",
			});
		}
	}

	private renderSyncBehaviour(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Sync behaviour").setHeading();

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a full sync when the app opens.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync config folder")
			.setDesc(
				"Sync the obsidian config folder (themes, snippets, plugin settings). Disable to sync notes only.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncConfigFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncConfigFolder = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("Background sync cadence. Set to 0 to disable.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma-separated folder paths to skip (e.g. Templates, archive/old).")
			.addText((text) =>
				text
					.setPlaceholder("Templates, archive/old")
					.setValue(this.plugin.settings.excludedFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderPlatformPaths(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Platform-specific config paths")
			.setDesc(
				"Paths that sync only to the current platform (mobile or desktop). Toggle common ones below; add custom paths in the bottom field.",
			)
			.setHeading();

		const WELL_KNOWN_PATHS = [
			{ path: "appearance.json", label: "Appearance (themes, fonts, colors)" },
			{ path: "themes/", label: "Themes folder" },
			{ path: "snippets/", label: "CSS snippets folder" },
			{ path: "plugins/", label: "All plugins folder" },
			{ path: "community-plugins.json", label: "Installed plugins list" },
			{ path: "hotkeys.json", label: "Custom hotkeys" },
			{ path: "workspace.json", label: "Workspace layout" },
		];

		for (const item of WELL_KNOWN_PATHS) {
			const isActive = this.plugin.settings.platformExcludedPaths.includes(item.path);
			new Setting(containerEl)
				.setName(item.label)
				.setDesc(item.path)
				.addToggle((toggle) =>
					toggle.setValue(isActive).onChange(async (value) => {
						const paths = this.plugin.settings.platformExcludedPaths;
						if (value && !paths.includes(item.path)) {
							paths.push(item.path);
						} else if (!value) {
							const idx = paths.indexOf(item.path);
							if (idx >= 0) paths.splice(idx, 1);
						}
						await this.plugin.saveSettings();
					}),
				);
		}

		const customPaths = this.plugin.settings.platformExcludedPaths.filter(
			(p) => !WELL_KNOWN_PATHS.some((w) => w.path === p),
		);
		new Setting(containerEl)
			.setName("Custom paths")
			.setDesc("Comma-separated additional paths.")
			.addText((text) =>
				text
					.setPlaceholder("my-plugin/, custom.json")
					.setValue(customPaths.join(", "))
					.onChange(async (value) => {
						const knownActive = this.plugin.settings.platformExcludedPaths.filter(
							(p) => WELL_KNOWN_PATHS.some((w) => w.path === p),
						);
						const custom = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						this.plugin.settings.platformExcludedPaths = [...knownActive, ...custom];
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderActions(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Actions").setHeading();

		new Setting(containerEl)
			.setName("Force sync")
			.setDesc("Compare and reconcile every file across all enabled projects.")
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Syncing…").setDisabled(true);
						try {
							await this.plugin.fullSync();
						} finally {
							btn.setButtonText("Sync now").setDisabled(false);
						}
					}),
			);

		new Setting(containerEl)
			.setName("Fetch from database")
			.setDesc("Pull-only sync: download remote changes without pushing local files.")
			.addButton((btn) =>
				btn.setButtonText("Fetch now").onClick(async () => {
					btn.setButtonText("Fetching…").setDisabled(true);
					try {
						await this.plugin.fetchNow();
					} finally {
						btn.setButtonText("Fetch now").setDisabled(false);
					}
				}),
			);

		if (this.plugin.settings.lastSyncTime > 0) {
			const ts = new Date(this.plugin.settings.lastSyncTime).toLocaleString();
			containerEl.createEl("p", { text: `Last synced: ${ts}`, cls: "sbj-last-sync" });
		}
	}

	private renderDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Diagnostics").setHeading();

		new Setting(containerEl)
			.setName("Enable logging")
			.setDesc("When off, the in-memory ring buffer is bypassed; only error/warn still go to the browser console.")
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.logging.enabled).onChange(async (value) => {
					this.plugin.settings.logging.enabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Log level")
			.setDesc("Higher levels capture more detail in the log panel. Debug is verbose; use it only when investigating an issue.")
			.addDropdown((dd) =>
				dd
					.addOptions({ error: "error", warn: "warn", info: "info", debug: "debug" })
					.setValue(this.plugin.settings.logging.level)
					.onChange(async (value) => {
						this.plugin.settings.logging.level = value as LogLevel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Log buffer size")
			.setDesc("Maximum entries kept in memory. Oldest are dropped when full. Range: 50–10000.")
			.addText((t) => {
				t.setValue(String(this.plugin.settings.logging.bufferSize)).onChange(async (value) => {
					const n = Number.parseInt(value, 10);
					if (!Number.isFinite(n)) return;
					this.plugin.settings.logging.bufferSize = Math.max(50, Math.min(10000, n));
					await this.plugin.saveSettings();
				});
				t.inputEl.type = "number";
			});

		new Setting(containerEl)
			.setName("Auto-purge older than (minutes)")
			.setDesc("Entries older than this are dropped every minute. Set to 0 to keep entries until the buffer fills.")
			.addText((t) => {
				t.setValue(String(this.plugin.settings.logging.maxAgeMinutes)).onChange(async (value) => {
					const n = Number.parseInt(value, 10);
					if (!Number.isFinite(n) || n < 0) return;
					this.plugin.settings.logging.maxAgeMinutes = n;
					await this.plugin.saveSettings();
					logger.purgeExpired();
				});
				t.inputEl.type = "number";
			});

		new Setting(containerEl)
			.setName("Clear logs now")
			.setDesc("Empties the in-memory buffer immediately.")
			.addButton((btn) =>
				btn.setButtonText("Clear").onClick(() => {
					logger.clear();
					new Notice("Supabase jump: log buffer cleared");
				}),
			);

		new Setting(containerEl)
			.setName("Open log panel")
			.setDesc("View the in-memory ring buffer with filtering.")
			.addButton((btn) =>
				btn.setButtonText("Open").onClick(() => this.plugin.openLogPanel()),
			);

		new Setting(containerEl)
			.setName("Copy diagnostics")
			.setDesc("Copy a redacted log bundle to the clipboard for issue reports.")
			.addButton((btn) =>
				btn.setButtonText("Copy").onClick(async () => {
					await this.plugin.copyDiagnostics();
				}),
			);

		new Setting(containerEl)
			.setName("Realtime escalate-after (seconds)")
			.setDesc("How long a realtime channel must stay down before showing a user notice. Keeps short hiccups silent.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 120, 5)
					.setValue(Math.round(this.plugin.settings.realtime.escalateAfterMs / 1000))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.realtime.escalateAfterMs = value * 1000;
						await this.plugin.saveSettings();
					}),
			);
	}
}
