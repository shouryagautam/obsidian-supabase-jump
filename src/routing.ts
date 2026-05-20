export interface ShardableProject {
	id: string;
	enabled: boolean;
}

// FNV-1a 32-bit; stable, fast, no deps. Same path + same salt + same project set
// always lands on the same project.
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return hash >>> 0;
}

export function pathHash(path: string, salt: string): number {
	return fnv1a(`${salt}::${path}`);
}

export function enabledOrdered<T extends ShardableProject>(projects: T[]): T[] {
	return projects.filter((p) => p.enabled).slice().sort((a, b) => a.id.localeCompare(b.id));
}

export function shardIndexFor(
	path: string,
	projects: ShardableProject[],
	salt: string,
): number {
	const enabled = enabledOrdered(projects);
	if (enabled.length === 0) return -1;
	const h = pathHash(path, salt);
	return h % enabled.length;
}

export function shardFor<T extends ShardableProject>(
	path: string,
	projects: T[],
	salt: string,
): T | null {
	const enabled = enabledOrdered(projects);
	if (enabled.length === 0) return null;
	const h = pathHash(path, salt);
	return enabled[h % enabled.length] ?? null;
}

export function newHashSalt(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}
