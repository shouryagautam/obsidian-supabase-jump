import {
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	Vault,
} from "obsidian";

import {
	DEFAULT_SETTINGS,
	ProjectStatusView,
	SettingsTabHost,
	SupaBaseJumpSettings,
	SupaBaseJumpSettingTab,
} from "./settings";
import { migrateSettings } from "./migration";
import { newHashSalt } from "./routing";
import { ProjectClientPool, ProjectStatusState } from "./project-client-pool";
import { SyncEngine, SyncStatus, VaultFileRow } from "./sync";
import { RealtimeCrdtManager } from "./realtime-crdt";
import { logger } from "./logger";
import { LogPanelModal } from "./log-panel";
import { SetupWizardModal, WizardMode } from "./setup-wizard";
import { rebalance } from "./rebalance";

const STATUS_ICON: Record<ProjectStatusState, string> = {
	offline: "🔴",
	connecting: "🟡",
	syncing: "🔄",
	synced: "🟢",
	degraded: "🟠",
	error: "⚠️",
};

export default class SupaBaseJumpPlugin extends Plugin implements SettingsTabHost {
	settings!: SupaBaseJumpSettings;
	statusBarItem!: HTMLElement;

	private pool!: ProjectClientPool;
	private syncEngine!: SyncEngine;
	private crdtManager!: RealtimeCrdtManager;
	private detachPoolListener: (() => void) | null = null;

	get pool_(): ProjectClientPool {
		return this.pool;
	}

	get vault(): Vault {
		return this.app.vault;
	}

	async onload() {
		await this.loadSettings();
		logger.configure(this.settings.logging.level, this.settings.logging.bufferSize);
		logger.info("plugin", "load", { version: this.manifest.version });

		this.statusBarItem = this.addStatusBarItem();
		this.pool = new ProjectClientPool(this.settings);
		this.detachPoolListener = this.pool.addStatusListener(() => this.refreshStatusBar());
		this.refreshStatusBar();

		this.syncEngine = new SyncEngine({
			vault: this.app.vault,
			settings: this.settings,
			pool: this.pool,
			saveSettings: () => this.saveSettings(),
			setStatus: (status) => this.setStatus(status),
		});

		this.crdtManager = new RealtimeCrdtManager(this);
		this.crdtManager.configure(this.pool, this.settings.vaultId, this.settings.realtime);

		this.addSettingTab(new SupaBaseJumpSettingTab(this.app, this));
		this.registerVaultEvents();
		this.registerCommands();

		if (this.settings.projects.length > 0) {
			await this.connectAll();
		}
	}

	onunload() {
		this.cleanup();
		this.detachPoolListener?.();
		logger.info("plugin", "unload");
	}

	async loadSettings() {
		const raw: unknown = await this.loadData();
		this.settings = migrateSettings(raw);
		if (!this.settings.routing.hashSalt) {
			this.settings.routing.hashSalt = newHashSalt();
		}
		if (!this.settings.vaultId) {
			this.settings.vaultId = window.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
		}
		await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		logger.configure(this.settings.logging.level, this.settings.logging.bufferSize);
		this.crdtManager?.configure(this.pool, this.settings.vaultId, this.settings.realtime);
	}

	setStatus(status: SyncStatus): void {
		// Aggregate setStatus from the sync engine maps to a transient state on top
		// of per-project status. We pin the next refresh to the requested state.
		this.statusBarItem.setText(`${STATUS_ICON[status]} ${this.pool.aggregateLabel()}`);
	}

	private refreshStatusBar(): void {
		const state = this.pool.getAggregateState();
		const label = this.pool.aggregateLabel();
		this.statusBarItem.setText(`${STATUS_ICON[state]} ${label}`);
	}

	async connectAll(): Promise<void> {
		this.syncEngine.stopAll();
		this.crdtManager.stop();
		this.pool.syncFromSettings();

		const results = await this.pool.connectAll();
		const ok = results.filter((r) => r.ok).length;
		const total = results.length;
		logger.info("plugin", `connect summary`, { ok, total });
		if (ok === 0 && total > 0) {
			new Notice(
				`Supabase jump: no projects connected. ${results.map((r) => r.detail).filter(Boolean).join(" / ")}`,
				8000,
			);
		} else if (ok < total) {
			new Notice(`Supabase jump: ${ok}/${total} projects connected — see log panel for details`, 6000);
		}

		this.crdtManager.start();
		this.syncEngine.crdtIsActive = (path) => this.crdtManager.isActiveFile(path);
		this.syncEngine.startRealtimeListeners();
		this.syncEngine.startConfigWatcher();
		if (this.settings.syncIntervalMinutes > 0) {
			this.syncEngine.startAutoSync();
		}
		if (this.settings.syncOnStartup) {
			this.syncEngine.fullSync().catch((err) =>
				logger.error("plugin", `startup sync failed`, {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}

	async signOutAll(): Promise<void> {
		this.syncEngine.stopAll();
		this.crdtManager.stop();
		await this.pool.signOutAll();
	}

	cleanup(): void {
		this.syncEngine?.stopAll();
		this.crdtManager?.stop();
		this.pool?.cleanup();
	}

	async fullSync(): Promise<void> {
		await this.syncEngine.fullSync();
	}

	async fetchNow(): Promise<void> {
		await this.syncEngine.fetchOnly();
	}

	openSetupWizard(mode: WizardMode, projectId?: string): void {
		new SetupWizardModal(
			this.app,
			{
				settings: this.settings,
				pool: this.pool,
				saveSettings: () => this.saveSettings(),
				connectProject: async (id) => {
					const project = this.settings.projects.find((p) => p.id === id);
					if (!project) return;
					this.pool.syncFromSettings();
					await this.pool.connect(project);
					this.syncEngine.startRealtimeListeners();
					this.refreshStatusBar();
				},
				refreshSettingsUi: () => this.refreshSettingsTab(),
			},
			mode,
			projectId,
		).open();
	}

	openLogPanel(): void {
		new LogPanelModal(this.app).open();
	}

	async copyDiagnostics(): Promise<void> {
		const meta = {
			pluginVersion: this.manifest.version,
			obsidianVersion: (this.app as unknown as { isMobile?: boolean }).isMobile ? "mobile" : "desktop",
			settings: this.settings,
		};
		const text = logger.exportDiagnostics(meta);
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Supabase jump: diagnostics copied to clipboard");
		} catch {
			new Notice("Supabase jump: clipboard unavailable — open the log panel to copy manually");
		}
	}

	async rebalanceNow(): Promise<void> {
		await rebalance({
			settings: this.settings,
			pool: this.pool,
			saveSettings: () => this.saveSettings(),
		});
	}

	async removeProject(projectId: string): Promise<void> {
		this.settings.projects = this.settings.projects.filter((p) => p.id !== projectId);
		await this.saveSettings();
		this.pool.syncFromSettings();
		this.syncEngine.startRealtimeListeners();
		this.refreshStatusBar();
	}

	async toggleProject(projectId: string, enabled: boolean): Promise<void> {
		const project = this.settings.projects.find((p) => p.id === projectId);
		if (!project) return;
		project.enabled = enabled;
		await this.saveSettings();
		this.pool.syncFromSettings();
		if (enabled) {
			await this.pool.connect(project);
		} else {
			this.pool.updateStatus(projectId, "offline", "disabled");
		}
		this.syncEngine.startRealtimeListeners();
		this.refreshStatusBar();
	}

	getProjectStatus(projectId: string): ProjectStatusView {
		return this.pool.getStatus(projectId);
	}

	getTotalUsageBytes(): number {
		return this.settings.projects.reduce((acc, p) => acc + (p.lastUsedBytes ?? 0), 0);
	}

	private refreshSettingsTab(): void {
		const tabs = (this.app as unknown as { setting?: { activeTab?: { display?: () => void } } }).setting;
		tabs?.activeTab?.display?.();
		this.refreshStatusBar();
	}

	private registerCommands(): void {
		this.addCommand({
			id: "show-sync-status",
			name: "Show sync status",
			callback: () => {
				const label = this.statusBarItem.getText();
				new Notice(`Supabase jump: ${label || "status unavailable"}`);
			},
		});

		this.addCommand({
			id: "force-sync",
			name: "Force sync now",
			callback: () => {
				this.syncEngine.fullSync().catch((err) =>
					logger.error("plugin", `command force-sync failed`, {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
		});

		this.addCommand({
			id: "fetch-now",
			name: "Fetch from database",
			callback: () => {
				this.syncEngine.fetchOnly().catch((err) =>
					logger.error("plugin", `command fetch-now failed`, {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
		});

		this.addCommand({
			id: "open-log-panel",
			name: "Open log panel",
			callback: () => this.openLogPanel(),
		});

		this.addCommand({
			id: "open-setup-wizard",
			name: "Open setup wizard",
			callback: () =>
				this.openSetupWizard(this.settings.projects.length === 0 ? "first-run" : "add-project"),
		});

		this.addCommand({
			id: "copy-diagnostics",
			name: "Copy diagnostics to clipboard",
			callback: () => {
				this.copyDiagnostics().catch((err) =>
					logger.error("plugin", `copy diagnostics failed`, {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
		});

		this.addCommand({
			id: "rebalance-projects",
			name: "Rebalance projects",
			callback: () => {
				this.rebalanceNow().catch((err) =>
					logger.error("plugin", `command rebalance failed`, {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			},
		});
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "push");
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "push");
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "delete");
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(oldPath, "delete");
					this.syncEngine.queueChange(file.path, "push");
				}
			}),
		);
	}

	async pushFile(file: TFile): Promise<void> {
		await this.syncEngine.pushFile(file);
	}

	async pullFile(row: VaultFileRow, projectId: string): Promise<void> {
		await this.syncEngine.pullFile(row, projectId);
	}

	async deleteRemoteFile(path: string): Promise<void> {
		await this.syncEngine.deleteRemoteFile(path);
	}

	async ensureFolder(filePath: string): Promise<void> {
		await this.syncEngine.ensureFolder(filePath);
	}
}

// Preserve a tiny default-settings constant for any external code that may still import it.
export const DEFAULT_SETTINGS_EXPORT = DEFAULT_SETTINGS;
