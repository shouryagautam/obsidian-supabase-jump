export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

export interface LogEntry {
	ts: number;
	level: LogLevel;
	scope: string;
	msg: string;
	data?: unknown;
}

export interface LogListener {
	(entry: LogEntry): void;
}

const REDACT_KEYS = new Set([
	"password",
	"anonkey",
	"supabaseanonkey",
	"personalaccesstoken",
	"token",
	"accesstoken",
	"refreshtoken",
	"apikey",
	"authorization",
]);

function redactString(value: string): string {
	if (value.length <= 8) return "***";
	return value.slice(0, 4) + "…" + value.slice(-2);
}

function redact(input: unknown, depth = 0): unknown {
	if (depth > 5) return "[depth-limit]";
	if (input == null) return input;
	if (typeof input === "string") return input;
	if (typeof input === "number" || typeof input === "boolean") return input;
	if (input instanceof Error) {
		return {
			name: input.name,
			message: input.message,
			stack: input.stack?.split("\n").slice(0, 8).join("\n"),
		};
	}
	if (Array.isArray(input)) {
		return input.slice(0, 32).map((v) => redact(v, depth + 1));
	}
	if (typeof input === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
			const norm = k.toLowerCase().replace(/[_-]/g, "");
			if (REDACT_KEYS.has(norm)) {
				out[k] = typeof v === "string" ? redactString(v) : "***";
			} else if (k.toLowerCase().includes("url") && typeof v === "string") {
				try {
					const u = new URL(v);
					out[k] = `${u.protocol}//${u.hostname}${u.pathname}`;
				} catch {
					out[k] = v;
				}
			} else {
				out[k] = redact(v, depth + 1);
			}
		}
		return out;
	}
	try {
		return JSON.parse(JSON.stringify(input));
	} catch {
		return "[unserializable]";
	}
}

export class Logger {
	private buffer: LogEntry[] = [];
	private listeners: Set<LogListener> = new Set();
	private level: LogLevel = "info";
	private size = 1000;

	configure(level: LogLevel, bufferSize: number): void {
		this.level = level;
		this.size = Math.max(50, Math.min(10000, bufferSize));
		if (this.buffer.length > this.size) {
			this.buffer.splice(0, this.buffer.length - this.size);
		}
	}

	addListener(fn: LogListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	entries(): readonly LogEntry[] {
		return this.buffer;
	}

	debug(scope: string, msg: string, data?: unknown): void {
		this.emit("debug", scope, msg, data);
	}

	info(scope: string, msg: string, data?: unknown): void {
		this.emit("info", scope, msg, data);
	}

	warn(scope: string, msg: string, data?: unknown): void {
		this.emit("warn", scope, msg, data);
	}

	error(scope: string, msg: string, data?: unknown): void {
		this.emit("error", scope, msg, data);
	}

	clear(): void {
		this.buffer.length = 0;
	}

	exportDiagnostics(meta: Record<string, unknown>): string {
		const header = [
			`# Supabase Jump diagnostics`,
			`Generated: ${new Date().toISOString()}`,
			``,
			`## Meta`,
			"```json",
			JSON.stringify(redact(meta), null, 2),
			"```",
			``,
			`## Log (last ${this.buffer.length} entries, level=${this.level})`,
			"```",
		];

		const body = this.buffer.map((e) => {
			const ts = new Date(e.ts).toISOString();
			const data = e.data === undefined ? "" : ` ${JSON.stringify(redact(e.data))}`;
			return `${ts} ${e.level.padEnd(5)} [${e.scope}] ${e.msg}${data}`;
		});

		return header.concat(body).concat(["```"]).join("\n");
	}

	private emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
		if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
		const entry: LogEntry = { ts: Date.now(), level, scope, msg, data };
		this.buffer.push(entry);
		if (this.buffer.length > this.size) {
			this.buffer.splice(0, this.buffer.length - this.size);
		}
		for (const fn of this.listeners) {
			try {
				fn(entry);
			} catch {
				// Listener faults must never break logging.
			}
		}
		if (level === "error") {
			console.error(`[supabase-jump:${scope}] ${msg}`, data ?? "");
		} else if (level === "warn") {
			console.warn(`[supabase-jump:${scope}] ${msg}`, data ?? "");
		}
	}
}

export const logger = new Logger();
