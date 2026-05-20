import { App, Modal, Notice } from "obsidian";
import { logger, LogEntry, LogLevel } from "./logger";

const LEVEL_OPTIONS: LogLevel[] = ["error", "warn", "info", "debug"];

export class LogPanelModal extends Modal {
	private filterLevel: LogLevel = "debug";
	private filterScope = "";
	private detach: (() => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("sbj-log-panel");
		this.contentEl.createEl("h2", { text: "Supabase jump — log panel" });
		this.renderControls();
		const body = this.contentEl.createDiv({ cls: "sbj-log-body" });
		this.renderEntries(body);

		this.detach = logger.addListener(() => this.renderEntries(body));
	}

	onClose(): void {
		this.detach?.();
		this.detach = null;
		this.contentEl.empty();
	}

	private renderControls(): void {
		const bar = this.contentEl.createDiv({ cls: "sbj-log-controls" });

		const levelSel = bar.createEl("select");
		for (const lvl of LEVEL_OPTIONS) {
			const opt = levelSel.createEl("option", { text: lvl, value: lvl });
			if (lvl === this.filterLevel) opt.selected = true;
		}
		levelSel.onchange = () => {
			this.filterLevel = levelSel.value as LogLevel;
			const body = this.contentEl.querySelector(".sbj-log-body");
			if (body instanceof HTMLElement) this.renderEntries(body);
		};

		const scopeInput = bar.createEl("input", { attr: { placeholder: "Filter scope (e.g. Sync, realtime)" } });
		scopeInput.oninput = () => {
			this.filterScope = scopeInput.value.trim();
			const body = this.contentEl.querySelector(".sbj-log-body");
			if (body instanceof HTMLElement) this.renderEntries(body);
		};

		const clearBtn = bar.createEl("button", { text: "Clear" });
		clearBtn.onclick = () => {
			logger.clear();
			const body = this.contentEl.querySelector(".sbj-log-body");
			if (body instanceof HTMLElement) this.renderEntries(body);
		};

		const copyBtn = bar.createEl("button", { text: "Copy" });
		copyBtn.onclick = async () => {
			const meta = { ts: new Date().toISOString() };
			const text = logger.exportDiagnostics(meta);
			try {
				await navigator.clipboard.writeText(text);
				new Notice("Supabase jump: diagnostics copied");
			} catch {
				new Notice("Supabase jump: clipboard unavailable");
			}
		};
	}

	private renderEntries(container: HTMLElement): void {
		container.empty();
		const order = ["error", "warn", "info", "debug"];
		const cap = order.indexOf(this.filterLevel);

		const filtered = logger.entries().filter((e) => {
			if (order.indexOf(e.level) > cap) return false;
			if (this.filterScope && !e.scope.includes(this.filterScope)) return false;
			return true;
		});

		if (filtered.length === 0) {
			container.createEl("p", { text: "No log entries match the current filter.", cls: "sbj-empty" });
			return;
		}

		for (const entry of filtered) {
			this.renderEntry(container, entry);
		}
	}

	private renderEntry(container: HTMLElement, entry: LogEntry): void {
		const row = container.createDiv({ cls: `sbj-log-row sbj-log-${entry.level}` });
		row.createSpan({ text: new Date(entry.ts).toLocaleTimeString(), cls: "sbj-log-ts" });
		row.createSpan({ text: entry.level, cls: `sbj-log-level sbj-log-level-${entry.level}` });
		row.createSpan({ text: `[${entry.scope}]`, cls: "sbj-log-scope" });
		row.createSpan({ text: entry.msg, cls: "sbj-log-msg" });
		if (entry.data !== undefined) {
			const det = row.createEl("pre", { cls: "sbj-log-data" });
			try {
				det.setText(JSON.stringify(entry.data, null, 2));
			} catch {
				det.setText("[unserializable]");
			}
		}
	}
}
