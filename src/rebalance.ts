import { Notice } from "obsidian";
import { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";
import { ProjectClientPool } from "./project-client-pool";
import { SupaBaseJumpSettings } from "./settings";
import { shardFor } from "./routing";
import { VaultFileRow } from "./sync";

const STORAGE_BUCKET = "vault-attachments";
const DB_TABLE = "vault_files";

function toStoragePath(userId: string, vaultId: string, filePath: string): string {
	const bytes = new TextEncoder().encode(filePath);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	const dotIdx = filePath.lastIndexOf(".");
	const ext = dotIdx >= 0 ? filePath.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "_") : "";
	return `${userId}/${vaultId}/${b64url}${ext}`;
}

export interface RebalanceHost {
	settings: SupaBaseJumpSettings;
	pool: ProjectClientPool;
	saveSettings(): Promise<void>;
}

export async function rebalance(host: RebalanceHost): Promise<{ moved: number; errors: string[] }> {
	const { vaultId } = host.settings;
	if (!vaultId) {
		new Notice("Supabase jump: vault ID is not set — cannot rebalance");
		return { moved: 0, errors: ["no vault id"] };
	}
	const enabled = [...host.pool.forAllEnabled()];
	if (enabled.length < 2) {
		new Notice("Supabase jump: rebalance needs at least 2 enabled projects");
		return { moved: 0, errors: [] };
	}

	const moved: string[] = host.settings.rebalanceProgress?.movedRowIds.slice() ?? [];
	const alreadyMoved = new Set(moved);
	if (!host.settings.rebalanceProgress) {
		host.settings.rebalanceProgress = { startedAt: Date.now(), movedRowIds: [] };
		await host.saveSettings();
	}
	const errors: string[] = [];

	for (const rt of enabled) {
		let rows: VaultFileRow[];
		try {
			const { data, error } = await rt.client
				.from(DB_TABLE)
				.select("*")
				.eq("vault_id", vaultId)
				.eq("deleted", false);
			if (error) {
				errors.push(`${rt.id}: list failed — ${error.message}`);
				continue;
			}
			rows = (data as VaultFileRow[]) ?? [];
		} catch (err) {
			errors.push(`${rt.id}: list threw — ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}

		for (const row of rows) {
			if (alreadyMoved.has(row.id)) continue;
			const expected = shardFor(row.path, host.settings.projects, host.settings.routing.hashSalt);
			if (!expected || expected.id === rt.id) continue;

			const target = host.pool.getRuntime(expected.id);
			if (!target) {
				errors.push(`${row.path}: target project ${expected.id} not connected`);
				continue;
			}
			try {
				await moveRow(rt.client, target.client, row, vaultId, host.pool, rt.id, expected.id);
				moved.push(row.id);
				alreadyMoved.add(row.id);
				const startedAt: number = host.settings.rebalanceProgress?.startedAt ?? Date.now();
				host.settings.rebalanceProgress = { startedAt, movedRowIds: [...moved] };
				await host.saveSettings();
				logger.info("rebalance", `moved ${row.path}`, {
					from: rt.id,
					to: expected.id,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${row.path}: ${msg}`);
				logger.error("rebalance", `move failed for ${row.path}`, { error: msg });
			}
		}
	}

	host.settings.rebalanceProgress = undefined;
	await host.saveSettings();

	const summary = `rebalance complete — moved ${moved.length} row${moved.length === 1 ? "" : "s"}, ${errors.length} error${errors.length === 1 ? "" : "s"}`;
	logger.info("rebalance", summary, { moved: moved.length, errors: errors.length });
	new Notice(`Supabase jump: ${summary}`);
	return { moved: moved.length, errors };
}

async function moveRow(
	source: SupabaseClient,
	target: SupabaseClient,
	row: VaultFileRow,
	vaultId: string,
	pool: ProjectClientPool,
	sourceProjectId: string,
	targetProjectId: string,
): Promise<void> {
	const targetUserId = await pool.getUserId(targetProjectId);

	let newStoragePath: string | null = null;
	if (row.is_binary && row.storage_path) {
		const { data, error } = await source.storage.from(STORAGE_BUCKET).download(row.storage_path);
		if (error || !data) throw new Error(`source download failed — ${error?.message ?? "no data"}`);
		const buf = await data.arrayBuffer();
		newStoragePath = toStoragePath(targetUserId, vaultId, row.path);
		const { error: upErr } = await target.storage
			.from(STORAGE_BUCKET)
			.upload(newStoragePath, buf, { upsert: true });
		if (upErr) throw new Error(`target upload failed — ${upErr.message}`);
	}

	// Verify the row does not already exist on target with newer mtime; never overwrite a newer copy.
	const { data: existing, error: existsErr } = await target
		.from(DB_TABLE)
		.select("mtime, deleted")
		.eq("id", row.id)
		.maybeSingle<{ mtime: number; deleted: boolean }>();
	if (existsErr) throw new Error(`target read failed — ${existsErr.message}`);
	if (existing && !existing.deleted && existing.mtime > row.mtime) {
		// Target already has newer data — clean up source instead of clobbering.
		await source.from(DB_TABLE).update({ deleted: true, updated_at: new Date().toISOString() }).eq("id", row.id);
		return;
	}

	const { error: writeErr } = await target.from(DB_TABLE).upsert({
		...row,
		user_id: targetUserId,
		storage_path: newStoragePath ?? row.storage_path,
		updated_at: new Date().toISOString(),
		deleted: false,
	});
	if (writeErr) throw new Error(`target write failed — ${writeErr.message}`);

	// Source soft-delete only after target write confirmed.
	const { error: srcErr } = await source
		.from(DB_TABLE)
		.update({ deleted: true, updated_at: new Date().toISOString() })
		.eq("id", row.id);
	if (srcErr) throw new Error(`source soft-delete failed — ${srcErr.message}`);

	if (row.is_binary && row.storage_path) {
		const { error: rmErr } = await source.storage.from(STORAGE_BUCKET).remove([row.storage_path]);
		if (rmErr) logger.warn("rebalance", `source storage cleanup failed`, { error: rmErr.message });
	}

	// Suppress unused-variable lint warning; sourceProjectId is preserved for future logging.
	void sourceProjectId;
}
