import {
	DEFAULT_SETTINGS,
	ProjectConfig,
	SETTINGS_SCHEMA_VERSION,
	SupaBaseJumpSettings,
} from "./settings";
import { encryptSecret } from "./secret-storage";
import { newHashSalt } from "./routing";
import { logger } from "./logger";

interface LegacyV1Settings {
	supabaseUrl?: string;
	supabaseAnonKey?: string;
	personalAccessToken?: string;
	email?: string;
	password?: string;
	vaultId?: string;
	syncOnStartup?: boolean;
	syncConfigFolder?: boolean;
	syncIntervalMinutes?: number;
	excludedFolders?: string[];
	platformExcludedPaths?: string[];
	lastSyncTime?: number;
}

function newProjectId(): string {
	return window.crypto.randomUUID();
}

export function isV1(raw: unknown): raw is LegacyV1Settings {
	if (!raw || typeof raw !== "object") return false;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.schemaVersion === "number" && obj.schemaVersion >= 2) return false;
	return "supabaseUrl" in obj || "email" in obj || "password" in obj || "supabaseAnonKey" in obj;
}

export function migrateSettings(rawIn: unknown): SupaBaseJumpSettings {
	const raw = (rawIn ?? {}) as Record<string, unknown>;

	if (typeof raw.schemaVersion === "number" && raw.schemaVersion >= SETTINGS_SCHEMA_VERSION) {
		return ensureV2Defaults(raw as Partial<SupaBaseJumpSettings>);
	}

	if (isV1(raw)) {
		return migrateV1ToV2(raw);
	}

	return { ...DEFAULT_SETTINGS, routing: { strategy: "hash_mod", hashSalt: newHashSalt() } };
}

function ensureV2Defaults(partial: Partial<SupaBaseJumpSettings>): SupaBaseJumpSettings {
	const out: SupaBaseJumpSettings = {
		...DEFAULT_SETTINGS,
		...partial,
		routing: { ...DEFAULT_SETTINGS.routing, ...(partial.routing ?? {}) },
		logging: { ...DEFAULT_SETTINGS.logging, ...(partial.logging ?? {}) },
		realtime: { ...DEFAULT_SETTINGS.realtime, ...(partial.realtime ?? {}) },
		projects: (partial.projects ?? []).map(normalizeProject),
		excludedFolders: partial.excludedFolders ?? [],
		platformExcludedPaths: partial.platformExcludedPaths ?? [],
		projectSyncCursors: { ...(partial.projectSyncCursors ?? {}) },
	};

	if (!out.routing.hashSalt) {
		out.routing.hashSalt = newHashSalt();
	}

	// Drop cursors for projects that no longer exist so the map can't grow
	// unboundedly across add/remove cycles.
	const liveIds = new Set(out.projects.map((p) => p.id));
	for (const id of Object.keys(out.projectSyncCursors)) {
		if (!liveIds.has(id)) delete out.projectSyncCursors[id];
	}

	out.schemaVersion = SETTINGS_SCHEMA_VERSION;
	return out;
}

function normalizeProject(raw: Partial<ProjectConfig>): ProjectConfig {
	return {
		id: raw.id || newProjectId(),
		label: raw.label || "Project",
		supabaseUrl: raw.supabaseUrl || "",
		supabaseAnonKey: raw.supabaseAnonKey || "",
		authMethod: raw.authMethod === "magic_link" ? "magic_link" : "password",
		email: raw.email || "",
		passwordEncrypted: raw.passwordEncrypted || "",
		enabled: raw.enabled !== false,
		lastUsedBytes: raw.lastUsedBytes ?? 0,
		lastConnectedAt: raw.lastConnectedAt ?? 0,
	};
}

function migrateV1ToV2(v1: LegacyV1Settings): SupaBaseJumpSettings {
	const vaultId =
		v1.vaultId && v1.vaultId.length > 0
			? v1.vaultId
			: window.crypto.randomUUID().replace(/-/g, "").slice(0, 12);

	const hadAnyProjectField =
		!!(v1.supabaseUrl || v1.supabaseAnonKey || v1.email || v1.password);

	const projects: ProjectConfig[] = [];
	if (hadAnyProjectField) {
		projects.push({
			id: newProjectId(),
			label: "Project 1",
			supabaseUrl: v1.supabaseUrl ?? "",
			supabaseAnonKey: v1.supabaseAnonKey ?? "",
			authMethod: "password",
			email: v1.email ?? "",
			passwordEncrypted: v1.password ? encryptSecret(v1.password, vaultId) : "",
			enabled: true,
			lastUsedBytes: 0,
			lastConnectedAt: 0,
		});
	}

	const migrated: SupaBaseJumpSettings = {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		vaultId,
		projects,
		routing: { strategy: "hash_mod", hashSalt: newHashSalt() },
		logging: { ...DEFAULT_SETTINGS.logging },
		realtime: { ...DEFAULT_SETTINGS.realtime },
		syncOnStartup: v1.syncOnStartup ?? DEFAULT_SETTINGS.syncOnStartup,
		syncConfigFolder: v1.syncConfigFolder ?? DEFAULT_SETTINGS.syncConfigFolder,
		syncIntervalMinutes: v1.syncIntervalMinutes ?? DEFAULT_SETTINGS.syncIntervalMinutes,
		excludedFolders: v1.excludedFolders ?? [],
		platformExcludedPaths: v1.platformExcludedPaths ?? [],
		lastSyncTime: v1.lastSyncTime ?? 0,
		projectSyncCursors: {},
		coEditEnabled: false,
	};

	logger.info("migration", "Migrated v1 settings to v2", {
		hadProject: hadAnyProjectField,
		vaultId,
	});

	return migrated;
}
