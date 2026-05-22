import { Notice, TFile, Vault, Platform } from "obsidian";
import { SupabaseClient } from "@supabase/supabase-js";
import { isBinary, isExcluded, isPlatformExcluded, isSystemFile, SupaBaseJumpSettings } from "./settings";
import { parseFrontmatter } from "./frontmatter";
import { ProjectClientPool, ProjectStatusState, isJwtExpired, isRlsError } from "./project-client-pool";
import { superviseChannel, SupervisedChannel } from "./realtime-supervisor";
import { shardFor, enabledOrdered } from "./routing";
import { logger } from "./logger";

const STORAGE_BUCKET = "vault-attachments";
const DB_TABLE = "vault_files";
const DEBOUNCE_MS = 1000;
// 5s covers slow vault writes on mobile / large binaries. Anything shorter let
// the modify-event echo leak past the ignore set and re-push what we just pulled.
const PULL_IGNORE_TTL = 5000;
const CONFIG_WATCH_MS = 5000;
const RECONNECT_FETCH_DEBOUNCE_MS = 1500;

export type SyncStatus = ProjectStatusState;

function stripNullBytes(s: string): string {
	return s.includes("\0") ? s.split("\0").join("") : s;
}

function toStoragePath(userId: string, vaultId: string, filePath: string): string {
	const bytes = new TextEncoder().encode(filePath);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	const dotIdx = filePath.lastIndexOf(".");
	const ext = dotIdx >= 0 ? filePath.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "_") : "";
	return `${userId}/${vaultId}/${b64url}${ext}`;
}

export interface VaultFileRow {
	id: string;
	user_id: string;
	vault_id: string;
	path: string;
	content: string | null;
	is_binary: boolean;
	storage_path: string | null;
	frontmatter: Record<string, unknown> | null;
	tags: string[] | null;
	platform: string;
	mtime: number;
	ctime: number;
	size: number;
	deleted: boolean;
	updated_at: string;
}

export interface SyncHost {
	readonly vault: Vault;
	readonly settings: SupaBaseJumpSettings;
	readonly pool: ProjectClientPool;
	saveSettings(): Promise<void>;
	setStatus(status: SyncStatus): void;
}

function toRowId(vaultId: string, filePath: string): string {
	return `${vaultId}::${filePath.replace(/\//g, "__SLASH__")}`;
}

interface RemoteLocation {
	projectId: string;
	row: VaultFileRow;
}

interface RemoteState {
	rows: Map<string, RemoteLocation>;
	succeeded: Set<string>;
}

export class SyncEngine {
	private host: SyncHost;
	private changeQueue = new Map<string, "push" | "delete">();
	private flushTimer: number | null = null;
	private syncIntervalId: number | null = null;
	private configWatcherId: number | null = null;
	private configFileCache = new Map<string, number>();
	private ignorePaths = new Set<string>();
	private realtimeChannels = new Map<string, SupervisedChannel>();
	private syncInFlight: Promise<void> | null = null;
	private reconnectFetchTimer: number | null = null;

	crdtIsActive: ((path: string) => boolean) | null = null;

	constructor(host: SyncHost) {
		this.host = host;
	}

	private clientFor(path: string): { client: SupabaseClient; projectId: string } {
		const rt = this.host.pool.forFile(path);
		if (!rt) throw new Error("Supabase jump: no enabled project for this file.");
		return { client: rt.client, projectId: rt.id };
	}

	private clientForProject(projectId: string): SupabaseClient {
		const rt = this.host.pool.getRuntime(projectId);
		if (!rt) throw new Error("Supabase jump: project not connected.");
		return rt.client;
	}

	private async userIdFor(projectId: string): Promise<string> {
		return await this.host.pool.getUserId(projectId);
	}

	private shouldSkip(filePath: string): boolean {
		if (isSystemFile(filePath)) return true;
		if (
			!this.host.settings.syncConfigFolder &&
			(filePath === this.host.vault.configDir ||
				filePath.startsWith(this.host.vault.configDir + "/"))
		) {
			return true;
		}
		return isExcluded(filePath, this.host.settings.excludedFolders);
	}

	private shouldPull(row: VaultFileRow): boolean {
		if (row.platform === "all") return true;
		const currentPlatform = Platform.isMobile ? "mobile" : "desktop";
		return row.platform === currentPlatform;
	}

	private async listAdapterFiles(folderPath: string): Promise<string[]> {
		const result: string[] = [];
		try {
			const listed = await this.host.vault.adapter.list(folderPath);
			result.push(...listed.files);
			for (const sub of listed.folders) {
				result.push(...(await this.listAdapterFiles(sub)));
			}
		} catch {
			// Folder may not exist
		}
		return result;
	}

	private async getLocalMtime(path: string): Promise<number> {
		const file = this.host.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return file.stat.mtime;
		try {
			const stat = await this.host.vault.adapter.stat(path);
			return stat?.mtime ?? 0;
		} catch {
			return 0;
		}
	}

	private getPlatformForPath(filePath: string): string {
		const isSpecific = isPlatformExcluded(filePath, this.host.settings.platformExcludedPaths);
		return isSpecific ? (Platform.isMobile ? "mobile" : "desktop") : "all";
	}

	private markIgnore(path: string): void {
		this.ignorePaths.add(path);
		window.setTimeout(() => this.ignorePaths.delete(path), PULL_IGNORE_TTL);
	}

	async ensureFolder(filePath: string): Promise<void> {
		const segments = filePath.split("/");
		segments.pop();

		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.host.vault.getAbstractFileByPath(current)) {
				try {
					await this.host.vault.createFolder(current);
				} catch {
					// Folder may already exist
				}
			}
		}
	}

	async pushFile(file: TFile): Promise<void> {
		const { vaultId } = this.host.settings;
		const { client, projectId } = this.clientFor(file.path);
		const userId = await this.userIdFor(projectId);
		const rowId = toRowId(vaultId, file.path);

		try {
			if (isBinary(file.path)) {
				await this.pushBinaryFile(client, file, userId, vaultId, rowId);
			} else {
				await this.pushTextFile(client, file, userId, vaultId, rowId);
			}
			logger.debug("sync", `pushed ${file.path}`, { projectId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("sync", `pushFile failed for "${file.path}"`, { error: msg, projectId });
			new Notice(`Supabase jump: push failed for "${file.path}" — ${msg}`);
			throw err;
		}
	}

	// Server-side LWW write: only persists the row when remote is older or
	// already tombstoned, with an INSERT fallback for new ids and a probe on
	// PK collision (race between our UPDATE-returning-0-rows and a peer INSERT).
	// Returns `applied=false` when the remote already holds a newer copy — the
	// caller should not surface this as an error.
	private async upsertRowSafely(
		client: SupabaseClient,
		payload: Record<string, unknown> & { id: string; mtime: number },
	): Promise<{ applied: boolean; reason?: string }> {
		const updateResult = await client
			.from(DB_TABLE)
			.update(payload)
			.eq("id", payload.id)
			.or(`mtime.lt.${payload.mtime},deleted.eq.true`)
			.select("id");
		if (updateResult.error) {
			throw new Error(`update failed — ${updateResult.error.message}`);
		}
		if ((updateResult.data?.length ?? 0) > 0) return { applied: true };

		// 0 rows matched: either row doesn't exist, or remote.mtime >= ours
		// (and not deleted). Try INSERT; PK collision means the latter.
		const insertResult = await client.from(DB_TABLE).insert(payload);
		if (!insertResult.error) return { applied: true };
		if (insertResult.error.code !== "23505") {
			throw new Error(`insert failed — ${insertResult.error.message}`);
		}

		// PK collision. Probe to decide: a peer either won the race or held the
		// newer copy all along.
		const probe = await client
			.from(DB_TABLE)
			.select("mtime, deleted")
			.eq("id", payload.id)
			.maybeSingle<{ mtime: number; deleted: boolean }>();
		if (probe.error) {
			throw new Error(`probe failed — ${probe.error.message}`);
		}
		if (probe.data && !probe.data.deleted && probe.data.mtime >= payload.mtime) {
			return { applied: false, reason: "remote newer or equal" };
		}
		// Remote is older or deleted now — retry the conditional update.
		const retry = await client
			.from(DB_TABLE)
			.update(payload)
			.eq("id", payload.id)
			.or(`mtime.lt.${payload.mtime},deleted.eq.true`)
			.select("id");
		if (retry.error) {
			throw new Error(`update retry failed — ${retry.error.message}`);
		}
		return { applied: (retry.data?.length ?? 0) > 0, reason: "raced; retried" };
	}

	// Cheap precheck used only by the binary push path to avoid uploading bytes
	// we'd then refuse to write. Returns null when the row is absent or the
	// read fails; remote-newer cases short-circuit the upload entirely.
	private async peekRemoteMtime(
		client: SupabaseClient,
		rowId: string,
	): Promise<{ mtime: number; deleted: boolean } | null> {
		try {
			const { data, error } = await client
				.from(DB_TABLE)
				.select("mtime,deleted")
				.eq("id", rowId)
				.maybeSingle<{ mtime: number; deleted: boolean }>();
			if (error || !data) return null;
			return data;
		} catch {
			return null;
		}
	}

	private async pushBinaryFile(
		client: SupabaseClient,
		file: TFile,
		userId: string,
		vaultId: string,
		rowId: string,
	): Promise<void> {
		// Cheap precheck: skip the storage upload too if we'd just refuse the
		// row write. Storage path is deterministic so an unnecessary upload
		// would replace whatever the remote-newer peer just uploaded.
		const peek = await this.peekRemoteMtime(client, rowId);
		if (peek && !peek.deleted && peek.mtime > file.stat.mtime) {
			logger.info("sync", `skip push: remote newer for "${file.path}"`, {
				localMtime: file.stat.mtime,
				remoteMtime: peek.mtime,
			});
			return;
		}

		const data = await this.host.vault.readBinary(file);
		const storagePath = toStoragePath(userId, vaultId, file.path);

		const { error: uploadErr } = await client.storage
			.from(STORAGE_BUCKET)
			.upload(storagePath, data, { upsert: true });
		if (uploadErr) throw new Error(`Storage upload failed — ${uploadErr.message}`);

		const result = await this.upsertRowSafely(client, {
			id: rowId,
			user_id: userId,
			vault_id: vaultId,
			path: file.path,
			is_binary: true,
			storage_path: storagePath,
			content: null,
			platform: this.getPlatformForPath(file.path),
			mtime: file.stat.mtime,
			ctime: file.stat.ctime ?? file.stat.mtime,
			size: file.stat.size ?? 0,
			deleted: false,
			updated_at: new Date().toISOString(),
		});
		if (!result.applied) {
			logger.info("sync", `push lost race for "${file.path}"`, { reason: result.reason });
		}
	}

	private async pushTextFile(
		client: SupabaseClient,
		file: TFile,
		userId: string,
		vaultId: string,
		rowId: string,
	): Promise<void> {
		let raw = await this.host.vault.read(file);
		raw = stripNullBytes(raw);

		const isMarkdown = file.path.endsWith(".md");
		const { properties, tags } = isMarkdown
			? parseFrontmatter(raw)
			: { properties: {}, tags: [] };

		const result = await this.upsertRowSafely(client, {
			id: rowId,
			user_id: userId,
			vault_id: vaultId,
			path: file.path,
			is_binary: false,
			storage_path: null,
			content: raw,
			frontmatter: Object.keys(properties).length > 0 ? properties : null,
			tags: tags.length > 0 ? tags : null,
			platform: this.getPlatformForPath(file.path),
			mtime: file.stat.mtime,
			ctime: file.stat.ctime ?? file.stat.mtime,
			size: file.stat.size ?? 0,
			deleted: false,
			updated_at: new Date().toISOString(),
		});
		if (!result.applied) {
			logger.info("sync", `push lost race for "${file.path}"`, { reason: result.reason });
		}
	}

	private async pushAdapterFile(
		filePath: string,
		userId: string,
		vaultId: string,
		client: SupabaseClient,
	): Promise<void> {
		const stat = await this.host.vault.adapter.stat(filePath);
		if (!stat || stat.type !== "file") return;

		const rowId = toRowId(vaultId, filePath);

		if (isBinary(filePath)) {
			const peek = await this.peekRemoteMtime(client, rowId);
			if (peek && !peek.deleted && peek.mtime > stat.mtime) {
				logger.info("sync", `skip push: remote newer for "${filePath}"`, {
					localMtime: stat.mtime,
					remoteMtime: peek.mtime,
				});
				return;
			}

			const data = await this.host.vault.adapter.readBinary(filePath);
			const storagePath = toStoragePath(userId, vaultId, filePath);

			const { error: uploadErr } = await client.storage
				.from(STORAGE_BUCKET)
				.upload(storagePath, data, { upsert: true });
			if (uploadErr) throw new Error(`Storage upload failed — ${uploadErr.message}`);

			const result = await this.upsertRowSafely(client, {
				id: rowId,
				user_id: userId,
				vault_id: vaultId,
				path: filePath,
				is_binary: true,
				storage_path: storagePath,
				content: null,
				platform: this.getPlatformForPath(filePath),
				mtime: stat.mtime,
				ctime: stat.ctime ?? stat.mtime,
				size: stat.size ?? 0,
				deleted: false,
				updated_at: new Date().toISOString(),
			});
			if (!result.applied) {
				logger.info("sync", `push lost race for "${filePath}"`, { reason: result.reason });
			}
		} else {
			const raw = await this.host.vault.adapter.read(filePath);
			const content = stripNullBytes(raw);
			const isMarkdown = filePath.endsWith(".md");
			const { properties, tags } = isMarkdown
				? parseFrontmatter(content)
				: { properties: {}, tags: [] };

			const result = await this.upsertRowSafely(client, {
				id: rowId,
				user_id: userId,
				vault_id: vaultId,
				path: filePath,
				is_binary: false,
				storage_path: null,
				content,
				frontmatter: Object.keys(properties).length > 0 ? properties : null,
				tags: tags.length > 0 ? tags : null,
				platform: this.getPlatformForPath(filePath),
				mtime: stat.mtime,
				ctime: stat.ctime ?? stat.mtime,
				size: stat.size ?? 0,
				deleted: false,
				updated_at: new Date().toISOString(),
			});
			if (!result.applied) {
				logger.info("sync", `push lost race for "${filePath}"`, { reason: result.reason });
			}
		}
	}

	async pullFile(row: VaultFileRow, projectId: string): Promise<void> {
		try {
			await this.ensureFolder(row.path);
			if (row.is_binary) {
				await this.pullBinaryFile(row, projectId);
			} else {
				await this.pullTextFile(row);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("sync", `pullFile failed for "${row.path}"`, { error: msg, projectId });
			new Notice(`Supabase jump: pull failed for "${row.path}" — ${msg}`);
			throw err;
		}
	}

	private async pullBinaryFile(row: VaultFileRow, projectId: string): Promise<void> {
		if (!row.storage_path) throw new Error(`missing storage_path for "${row.path}"`);

		const client = this.clientForProject(projectId);
		const { data, error } = await client.storage.from(STORAGE_BUCKET).download(row.storage_path);
		if (error || !data) {
			throw new Error(`storage download failed — ${error?.message ?? "no data returned"}`);
		}

		const buffer = await data.arrayBuffer();
		this.markIgnore(row.path);

		const live = this.host.vault.getAbstractFileByPath(row.path);
		try {
			if (live instanceof TFile) {
				await this.host.vault.modifyBinary(live, buffer);
			} else {
				await this.host.vault.createBinary(row.path, buffer);
			}
		} catch {
			try {
				await this.host.vault.createBinary(row.path, buffer);
			} catch {
				await this.host.vault.adapter.writeBinary(row.path, buffer);
			}
		}
	}

	private async pullTextFile(row: VaultFileRow): Promise<void> {
		const content = row.content ?? "";
		this.markIgnore(row.path);

		const live = this.host.vault.getAbstractFileByPath(row.path);
		try {
			if (live instanceof TFile) {
				await this.host.vault.modify(live, content);
			} else {
				await this.host.vault.create(row.path, content);
			}
		} catch {
			try {
				await this.host.vault.create(row.path, content);
			} catch {
				await this.host.vault.adapter.write(row.path, content);
			}
		}
	}

	async deleteRemoteFile(path: string): Promise<void> {
		// During rebalance the file might live on a different shard than its
		// current routing target. Delete from every enabled project that has the row.
		const { vaultId } = this.host.settings;
		const rowId = toRowId(vaultId, path);
		const errors: string[] = [];

		for (const rt of this.host.pool.forAllEnabled()) {
			try {
				const { data, error: fetchErr } = await rt.client
					.from(DB_TABLE)
					.select("is_binary, storage_path")
					.eq("id", rowId)
					.maybeSingle<Pick<VaultFileRow, "is_binary" | "storage_path">>();
				if (fetchErr) {
					errors.push(`${rt.id}: ${fetchErr.message}`);
					continue;
				}
				if (!data) continue;

				const { error: updateErr } = await rt.client
					.from(DB_TABLE)
					.update({ deleted: true, updated_at: new Date().toISOString() })
					.eq("id", rowId);
				if (updateErr) {
					errors.push(`${rt.id}: ${updateErr.message}`);
					continue;
				}

				if (data.is_binary && data.storage_path) {
					const { error: storageErr } = await rt.client.storage
						.from(STORAGE_BUCKET)
						.remove([data.storage_path]);
					if (storageErr) {
						logger.warn("sync", `storage removal failed`, { projectId: rt.id, error: storageErr.message });
					}
				}
			} catch (err) {
				errors.push(`${rt.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (errors.length > 0) {
			const msg = errors.join("; ");
			logger.error("sync", `deleteRemoteFile partial failure for "${path}"`, { errors });
			new Notice(`Supabase jump: delete partially failed for "${path}" — ${msg}`);
			throw new Error(msg);
		}
	}

	// Run an async task across a list of items with a bounded number of in-flight
	// promises. Errors inside `task` are the caller's responsibility — this helper
	// never throws (it's intentionally fire-and-collect-results).
	private async runWithConcurrency<T>(
		items: readonly T[],
		concurrency: number,
		task: (item: T) => Promise<void>,
	): Promise<void> {
		if (items.length === 0) return;
		const width = Math.max(1, Math.min(concurrency, items.length));
		let cursor = 0;
		const workers: Promise<void>[] = [];
		for (let w = 0; w < width; w++) {
			workers.push(
				(async () => {
					while (cursor < items.length) {
						const i = cursor++;
						const item = items[i];
						if (item === undefined) continue;
						await task(item);
					}
				})(),
			);
		}
		await Promise.all(workers);
	}

	private cursorsForEnabled(): Map<string, number> {
		const map = new Map<string, number>();
		for (const rt of this.host.pool.forAllEnabled()) {
			const stored = this.host.settings.projectSyncCursors[rt.id];
			// Fall back to the legacy global cursor so settings saved before
			// projectSyncCursors existed resume incrementally instead of doing
			// a one-time full re-pull.
			map.set(rt.id, stored ?? this.host.settings.lastSyncTime ?? 0);
		}
		return map;
	}

	// Query every enabled project for rows updated since each project's own
	// cursor. Returns *all* matching rows (including tombstones — rows with
	// deleted=true) so callers can replay deletions for peers that were offline
	// when the delete happened. Only projects whose query succeeded appear in
	// `succeeded`; failed projects don't advance their cursor.
	private async collectRemoteState(cursors: Map<string, number>): Promise<RemoteState> {
		const { vaultId } = this.host.settings;
		const winning = new Map<string, RemoteLocation>();
		const succeeded = new Set<string>();

		for (const rt of this.host.pool.forAllEnabled()) {
			const sinceMs = cursors.get(rt.id) ?? 0;
			// 10-second safety buffer absorbs clock skew between client and server.
			const sinceIso = sinceMs > 0 ? new Date(sinceMs - 10_000).toISOString() : null;
			const runQuery = () => {
				const q = rt.client
					.from(DB_TABLE)
					.select("*")
					.eq("vault_id", vaultId);
				return sinceIso ? q.gt("updated_at", sinceIso) : q;
			};
			try {
				let { data, error } = await runQuery();
				if (error && isJwtExpired(error)) {
					const ok = await this.host.pool.refreshSession(rt.id);
					if (ok) {
						const retry = await runQuery();
						data = retry.data;
						error = retry.error;
					}
				}
				if (error) {
					if (isRlsError(error)) {
						logger.error("sync", `RLS rejected query`, { projectId: rt.id });
						new Notice(`Supabase jump: project ${rt.id.slice(0, 6)}… rejected the query — check RLS policy.`);
					} else {
						logger.error("sync", `failed to fetch remote rows`, { projectId: rt.id, error: error.message });
					}
					continue;
				}
				succeeded.add(rt.id);
				for (const row of (data as VaultFileRow[]) ?? []) {
					this.acceptRemoteRow(winning, row, rt.id);
				}
			} catch (err) {
				logger.error("sync", `remote query threw`, {
					projectId: rt.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return { rows: winning, succeeded };
	}

	private acceptRemoteRow(
		remoteMap: Map<string, RemoteLocation>,
		row: VaultFileRow,
		projectId: string,
	): void {
		const existing = remoteMap.get(row.path);
		if (!existing) {
			remoteMap.set(row.path, { projectId, row });
			return;
		}
		// Same path landed on multiple projects (rebalance in flight or settings
		// changed). Pick the row with the newer updated_at — that's the most
		// recent write regardless of which shard currently owns the path.
		const existingTs = Date.parse(existing.row.updated_at);
		const incomingTs = Date.parse(row.updated_at);
		if (incomingTs > existingTs) {
			remoteMap.set(row.path, { projectId, row });
			return;
		}
		if (incomingTs === existingTs) {
			// Exact tie: defer to the shard that *should* own the path under the
			// current routing config.
			const expected = shardFor(row.path, this.host.settings.projects, this.host.settings.routing.hashSalt);
			if (expected?.id === projectId) {
				remoteMap.set(row.path, { projectId, row });
			}
		}
	}

	private persistCursors(cursorAtStart: number, succeeded: Set<string>): void {
		for (const id of succeeded) {
			this.host.settings.projectSyncCursors[id] = cursorAtStart;
		}
		// Keep the legacy global cursor in sync for the settings-tab readout.
		// (Per-project cursors are the authoritative incremental state; this is
		// just "when did the last sync attempt finish".)
		this.host.settings.lastSyncTime = cursorAtStart;
	}

	async fetchOnly(): Promise<void> {
		if (this.syncInFlight) {
			logger.debug("sync", "fetchOnly: deduped — sync already in flight");
			return this.syncInFlight;
		}
		this.syncInFlight = this.runFetchOnly();
		try {
			await this.syncInFlight;
		} finally {
			this.syncInFlight = null;
		}
	}

	private async runFetchOnly(): Promise<void> {
		const { vaultId } = this.host.settings;
		if (!vaultId) {
			new Notice("Supabase jump: vault ID is not set — cannot fetch");
			return;
		}
		if (this.host.pool.enabledProjectCount() === 0) {
			new Notice("Supabase jump: no enabled projects — cannot fetch");
			return;
		}

		this.host.setStatus("syncing");
		const errors: string[] = [];
		// Capture cursor BEFORE issuing queries so anything updated mid-sync is
		// picked up next round (per-project, so a stalled project doesn't lose
		// its window).
		const cursorAtStart = Date.now();
		const cursors = this.cursorsForEnabled();

		try {
			const { rows: remoteMap, succeeded } = await this.collectRemoteState(cursors);
			let tombstoneCount = 0;
			for (const [, loc] of remoteMap) if (loc.row.deleted) tombstoneCount++;
			logger.info("sync", "fetchOnly: collected remote delta", {
				count: remoteMap.size,
				tombstones: tombstoneCount,
				projectsSucceeded: succeeded.size,
			});

			const pullCandidates: RemoteLocation[] = [];
			const tombstones: RemoteLocation[] = [];
			for (const [, loc] of remoteMap) {
				if (this.shouldSkip(loc.row.path)) continue;
				if (this.crdtIsActive?.(loc.row.path)) continue;
				if (loc.row.deleted) {
					tombstones.push(loc);
					continue;
				}
				if (!this.shouldPull(loc.row)) continue;
				pullCandidates.push(loc);
			}

			await this.runWithConcurrency(pullCandidates, 6, async (loc) => {
				const localMtime = await this.getLocalMtime(loc.row.path);
				if (loc.row.mtime <= localMtime) return;
				try {
					await this.pullFile(loc.row, loc.projectId);
				} catch {
					errors.push(loc.row.path);
				}
			});

			for (const loc of tombstones) {
				// Tombstone replay: a peer marked this row deleted while we were
				// offline. Honor it unless the local copy is newer than the
				// tombstone (resurrect case — left for the next fullSync to push).
				const localMtime = await this.getLocalMtime(loc.row.path);
				if (localMtime === 0) {
					// Nothing local, nothing to do.
					continue;
				}
				const tombstoneTs = Date.parse(loc.row.updated_at);
				if (Number.isFinite(tombstoneTs) && localMtime > tombstoneTs) {
					logger.info("sync", `tombstone skipped: local newer than remote delete`, {
						path: loc.row.path,
						localMtime,
						tombstoneTs,
					});
					continue;
				}
				try {
					await this.deleteLocalFile(loc.row.path);
				} catch (err) {
					logger.warn("sync", `tombstone replay failed`, {
						path: loc.row.path,
						error: err instanceof Error ? err.message : String(err),
					});
					errors.push(loc.row.path);
				}
			}

			this.persistCursors(cursorAtStart, succeeded);
			await this.host.saveSettings();
			this.host.setStatus("synced");

			const s = errors.length;
			const suffix = s > 0 ? ` (${s} error${s > 1 ? "s" : ""} — open log panel)` : "";
			new Notice(`Supabase jump: fetch complete${suffix}`);
		} catch (err) {
			logger.error("sync", `fetchOnly failed`, { error: err instanceof Error ? err.message : String(err) });
			this.host.setStatus("error");
			new Notice(
				`Supabase jump: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async fullSync(): Promise<void> {
		if (this.syncInFlight) {
			logger.debug("sync", "fullSync: deduped — sync already in flight");
			return this.syncInFlight;
		}
		this.syncInFlight = this.runFullSync();
		try {
			await this.syncInFlight;
		} finally {
			this.syncInFlight = null;
		}
	}

	private async runFullSync(): Promise<void> {
		const { vaultId } = this.host.settings;
		if (!vaultId) {
			new Notice("Supabase jump: vault ID is not set — cannot sync");
			return;
		}
		if (this.host.pool.enabledProjectCount() === 0) {
			new Notice("Supabase jump: no enabled projects — cannot sync");
			return;
		}

		this.host.setStatus("syncing");
		const errors: string[] = [];
		const cursorAtStart = Date.now();
		// fullSync re-reconciles against everything, so query without a since
		// filter. We still use the projectSyncCursors plumbing to mark per-project
		// success when persisting at the end.
		const baseCursors = new Map<string, number>();
		for (const rt of this.host.pool.forAllEnabled()) baseCursors.set(rt.id, 0);

		try {
			const { rows: remoteMap, succeeded } = await this.collectRemoteState(baseCursors);

			const localFiles = this.host.vault.getFiles().filter((f) => !this.shouldSkip(f.path));
			const filesNeedingPush = localFiles.filter((file) => {
				const remote = remoteMap.get(file.path);
				if (!remote) return true;
				if (remote.row.deleted) {
					// Resurrect only if the local copy is strictly newer than the
					// tombstone — otherwise the delete-pass below removes it.
					const tombstoneTs = Date.parse(remote.row.updated_at);
					return Number.isFinite(tombstoneTs) && file.stat.mtime > tombstoneTs;
				}
				return file.stat.mtime > remote.row.mtime;
			});
			await this.runWithConcurrency(filesNeedingPush, 6, async (file) => {
				try {
					await this.pushFile(file);
				} catch {
					errors.push(file.path);
				}
			});

			const configPaths = await this.listAdapterFiles(this.host.vault.configDir);
			if (configPaths.length > 0) {
				for (const configPath of configPaths) {
					if (this.shouldSkip(configPath)) continue;
					const stat = await this.host.vault.adapter.stat(configPath);
					if (!stat || stat.type !== "file") continue;
					const remote = remoteMap.get(configPath);
					const shouldPush =
						!remote ||
						(remote.row.deleted
							? (() => {
									const tombstoneTs = Date.parse(remote.row.updated_at);
									return Number.isFinite(tombstoneTs) && stat.mtime > tombstoneTs;
								})()
							: stat.mtime > remote.row.mtime);
					if (shouldPush) {
						try {
							const rt = this.host.pool.forFile(configPath);
							if (!rt) {
								errors.push(configPath);
								continue;
							}
							const userId = await this.userIdFor(rt.id);
							await this.pushAdapterFile(configPath, userId, vaultId, rt.client);
						} catch {
							errors.push(configPath);
						}
					}
				}
			}

			const pullCandidates: RemoteLocation[] = [];
			const tombstones: RemoteLocation[] = [];
			for (const [, loc] of remoteMap) {
				if (this.shouldSkip(loc.row.path)) continue;
				if (this.crdtIsActive?.(loc.row.path)) continue;
				if (loc.row.deleted) {
					tombstones.push(loc);
					continue;
				}
				if (!this.shouldPull(loc.row)) continue;
				pullCandidates.push(loc);
			}
			await this.runWithConcurrency(pullCandidates, 6, async (loc) => {
				const localMtime = await this.getLocalMtime(loc.row.path);
				if (loc.row.mtime <= localMtime) return;
				try {
					await this.pullFile(loc.row, loc.projectId);
				} catch {
					errors.push(loc.row.path);
				}
			});

			for (const loc of tombstones) {
				const localMtime = await this.getLocalMtime(loc.row.path);
				if (localMtime === 0) continue;
				const tombstoneTs = Date.parse(loc.row.updated_at);
				if (Number.isFinite(tombstoneTs) && localMtime > tombstoneTs) {
					// Local is newer — push pass above already handled the resurrect.
					continue;
				}
				try {
					await this.deleteLocalFile(loc.row.path);
				} catch (err) {
					logger.warn("sync", `tombstone replay failed`, {
						path: loc.row.path,
						error: err instanceof Error ? err.message : String(err),
					});
					errors.push(loc.row.path);
				}
			}

			this.persistCursors(cursorAtStart, succeeded);
			await this.host.saveSettings();
			this.host.setStatus("synced");

			const s = errors.length;
			const suffix = s > 0 ? ` (${s} error${s > 1 ? "s" : ""} — open log panel)` : "";
			new Notice(`Supabase jump: sync complete${suffix}`);
		} catch (err) {
			logger.error("sync", `fullSync failed`, { error: err instanceof Error ? err.message : String(err) });
			this.host.setStatus("error");
			new Notice(
				`Supabase jump: sync failed — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	startRealtimeListeners(): void {
		this.stopRealtimeListeners();
		const { vaultId } = this.host.settings;
		if (!vaultId) {
			logger.warn("realtime", "startRealtimeListeners: no vaultId, skipping");
			return;
		}
		logger.info("realtime", "starting listeners", {
			vaultId,
			projects: enabledOrdered(this.host.settings.projects).map((p) => p.id),
			isMobile: Platform.isMobile,
		});

		for (const project of enabledOrdered(this.host.settings.projects)) {
			const rt = this.host.pool.getRuntime(project.id);
			if (!rt) {
				logger.warn("realtime", "no runtime for project, skipping", { projectId: project.id });
				continue;
			}
			logger.info("realtime", "subscribing", {
				projectId: project.id,
				vaultId,
				filter: `vault_id=eq.${vaultId}`,
				channelName: `vault-${vaultId}-${project.id.slice(0, 8)}`,
			});

			const supervised = superviseChannel({
				scope: `realtime:${project.id.slice(0, 6)}`,
				label: project.label,
				tuning: this.host.settings.realtime,
				client: rt.client,
				build: (client) =>
					client.channel(`vault-${vaultId}-${project.id.slice(0, 8)}`).on<VaultFileRow>(
						"postgres_changes",
						{
							event: "*",
							schema: "public",
							table: DB_TABLE,
							filter: `vault_id=eq.${vaultId}`,
						},
						(payload) => {
							this.handleRealtimeEvent(payload, project.id).catch((err) => {
								logger.error("realtime", `handler error`, {
									projectId: project.id,
									error: err instanceof Error ? err.message : String(err),
								});
							});
						},
					),
				onStatus: (state) => {
					const target: ProjectStatusState =
						state === "up" ? "synced" : state === "retrying" ? "degraded" : "error";
					this.host.pool.updateStatus(project.id, target, `realtime ${state}`);
				},
				onSubscribed: (isReconnect) => {
					if (isReconnect) this.scheduleReconnectFetch(project.id);
				},
				onJwtExpired: () => this.host.pool.refreshSession(project.id),
			});

			this.realtimeChannels.set(project.id, supervised);
		}
	}

	stopRealtimeListeners(): void {
		for (const ch of this.realtimeChannels.values()) ch.stop();
		this.realtimeChannels.clear();
	}

	// Debounce so multiple projects reconnecting in quick succession trigger a
	// single catch-up fetch. The fetchOnly call is itself dedup'd by the
	// single-flight guard, so this is belt-and-braces.
	private scheduleReconnectFetch(projectId: string): void {
		logger.info("sync", `realtime reconnected — scheduling catch-up fetch`, { projectId });
		if (this.reconnectFetchTimer !== null) return;
		this.reconnectFetchTimer = window.setTimeout(() => {
			this.reconnectFetchTimer = null;
			void this.fetchOnly().catch((err) =>
				logger.error("sync", `reconnect catch-up fetch failed`, {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			// Drain any edits that piled up while the channel was down.
			this.flushNow();
		}, RECONNECT_FETCH_DEBOUNCE_MS);
	}

	private async handleRealtimeEvent(
		payload: { eventType: string; new: Partial<VaultFileRow>; old: Partial<VaultFileRow> },
		projectId: string,
	): Promise<void> {
		const { eventType, new: newRow, old: oldRow } = payload;
		logger.info("realtime", "event received", {
			projectId,
			eventType,
			path: newRow?.path ?? oldRow?.path,
			vault_id: newRow?.vault_id ?? oldRow?.vault_id,
			row_mtime: newRow?.mtime,
			platform: newRow?.platform,
			deleted: newRow?.deleted,
		});

		if (eventType === "DELETE") {
			// Hard DELETEs aren't part of this plugin's protocol — we soft-delete
			// via `deleted=true` UPDATEs, which arrive as eventType "UPDATE" and
			// are handled below. Postgres realtime only ships the PK in
			// oldRow.* unless REPLICA IDENTITY FULL is set on the table, so the
			// path is unreliable here. Log and ignore.
			logger.debug("realtime", "ignoring hard-DELETE event (use soft-delete)", {
				projectId,
				oldRowKeys: Object.keys(oldRow ?? {}),
			});
			return;
		}

		const row = newRow as VaultFileRow;
		if (!row?.path) {
			logger.info("realtime", "skip: no path on row", { projectId });
			return;
		}

		if (row.deleted) {
			await this.deleteLocalFile(row.path);
			return;
		}

		if (this.crdtIsActive?.(row.path)) {
			logger.info("realtime", "skip: crdt active for path", { path: row.path });
			return;
		}

		const localMtime = await this.getLocalMtime(row.path);
		const pullOk = this.shouldPull(row);
		const mtimeOk = row.mtime > localMtime;
		if (!mtimeOk || !pullOk) {
			logger.info("realtime", "skip: not applying", {
				path: row.path,
				row_mtime: row.mtime,
				local_mtime: localMtime,
				mtimeOk,
				pullOk,
				platform: row.platform,
				isMobile: Platform.isMobile,
			});
			return;
		}
		logger.info("realtime", "applying pull", { path: row.path, projectId });
		await this.pullFile(row, projectId);
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const file = this.host.vault.getAbstractFileByPath(path);
		const targetPath = file?.path ?? path;
		const exists = file !== null || (await this.host.vault.adapter.exists(path));
		if (!exists) return;
		this.markIgnore(path);
		try {
			await this.host.vault.adapter.trashLocal(targetPath);
		} catch (err) {
			logger.warn("sync", `deleteLocalFile failed for "${path}"`, {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		await this.pruneEmptyAncestors(path);
	}

	// Walk up the parent chain and remove folders that are now empty. Stops at
	// the first non-empty ancestor (or the vault root). Without this, syncing a
	// peer's deletion leaves behind an orphan folder tree.
	private async pruneEmptyAncestors(path: string): Promise<void> {
		const segments = path.split("/");
		segments.pop();
		while (segments.length > 0) {
			const folderPath = segments.join("/");
			let listed: { files: string[]; folders: string[] };
			try {
				listed = await this.host.vault.adapter.list(folderPath);
			} catch {
				return;
			}
			if (listed.files.length > 0 || listed.folders.length > 0) return;
			try {
				await this.host.vault.adapter.rmdir(folderPath, false);
			} catch (err) {
				logger.debug("sync", `pruneEmptyAncestors: rmdir failed`, {
					folderPath,
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			segments.pop();
		}
	}

	startConfigWatcher(): void {
		if (this.configWatcherId !== null) return;
		this.warmConfigCache().catch(() => {});

		this.configWatcherId = window.setInterval(() => {
			this.pollConfigDir().catch((err) =>
				logger.error("sync", `config watcher error`, {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}, CONFIG_WATCH_MS);
	}

	private async warmConfigCache(): Promise<void> {
		const paths = await this.listAdapterFiles(this.host.vault.configDir);
		for (const p of paths) {
			const stat = await this.host.vault.adapter.stat(p);
			if (stat?.type === "file") this.configFileCache.set(p, stat.mtime);
		}
	}

	private async pollConfigDir(): Promise<void> {
		const paths = await this.listAdapterFiles(this.host.vault.configDir);
		const seen = new Set<string>();
		for (const p of paths) {
			seen.add(p);
			if (this.ignorePaths.has(p) || this.shouldSkip(p)) continue;
			const stat = await this.host.vault.adapter.stat(p);
			if (!stat || stat.type !== "file") continue;
			const cached = this.configFileCache.get(p);
			if (cached === undefined || stat.mtime > cached) {
				this.configFileCache.set(p, stat.mtime);
				this.queueChange(p, "push");
			}
		}
		for (const [p] of this.configFileCache) {
			if (!seen.has(p)) {
				this.configFileCache.delete(p);
				this.queueChange(p, "delete");
			}
		}
	}

	startAutoSync(): void {
		const { syncIntervalMinutes } = this.host.settings;
		if (syncIntervalMinutes <= 0) return;

		this.syncIntervalId = window.setInterval(() => {
			void this.fullSync().catch((err) =>
				logger.error("sync", `auto-sync failed`, {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}, syncIntervalMinutes * 60 * 1000);
	}

	queueChange(path: string, type: "push" | "delete"): void {
		if (this.shouldSkip(path) || this.ignorePaths.has(path)) return;
		this.changeQueue.set(path, type);
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => {
			this.flushQueue().catch((err) =>
				logger.error("sync", `flush failed`, {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}, DEBOUNCE_MS);
	}

	private async flushQueue(): Promise<void> {
		this.flushTimer = null;
		if (this.host.pool.enabledProjectCount() === 0) {
			// Preserve queued edits: callers will retry via flushNow() once a
			// project comes online. Otherwise edits made while disconnected are
			// silently lost.
			logger.debug("sync", "flushQueue: no enabled projects — keeping queue intact", {
				queued: this.changeQueue.size,
			});
			return;
		}

		const entries = [...this.changeQueue.entries()];
		this.changeQueue.clear();

		for (const [path, type] of entries) {
			try {
				if (type === "push") {
					const file = this.host.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.pushFile(file);
					} else {
						const rt = this.host.pool.forFile(path);
						if (!rt) {
							logger.warn("sync", `flushQueue: no shard for "${path}" — skipped`);
							continue;
						}
						const userId = await this.userIdFor(rt.id);
						await this.pushAdapterFile(path, userId, this.host.settings.vaultId, rt.client);
					}
				} else {
					await this.deleteRemoteFile(path);
				}
			} catch (err) {
				logger.warn("sync", `flushQueue: ${type} failed for "${path}"`, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// Public entry point used after a successful (re)connect to drain any edits
	// that were debounced while no projects were available.
	flushNow(): void {
		if (this.changeQueue.size === 0) return;
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.flushQueue().catch((err) =>
			logger.error("sync", `flushNow failed`, {
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}

	stopAll(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
		if (this.configWatcherId !== null) {
			window.clearInterval(this.configWatcherId);
			this.configWatcherId = null;
		}
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.reconnectFetchTimer !== null) {
			window.clearTimeout(this.reconnectFetchTimer);
			this.reconnectFetchTimer = null;
		}
		this.stopRealtimeListeners();
		this.changeQueue.clear();
		this.configFileCache.clear();
		this.ignorePaths.clear();
	}
}
