import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { Notice } from "obsidian";
import { logger } from "./logger";
import { RealtimeTuning } from "./settings";

export type SubscribeStatus = string;

export interface SupervisedChannel {
	stop(): void;
	restart(): void;
	isUp(): boolean;
}

export interface SuperviseOptions {
	scope: string;             // logger scope, e.g. "realtime:projectid"
	label: string;             // human-readable, used in user notices
	tuning: RealtimeTuning;
	client: SupabaseClient;
	build: (client: SupabaseClient) => RealtimeChannel;
	onStatus?: (state: "up" | "down" | "retrying") => void;
	onSubscribed?: () => void;
	onJwtExpired?: () => Promise<boolean>;  // resolve true on refresh success
}

export function superviseChannel(opts: SuperviseOptions): SupervisedChannel {
	const { scope, label, tuning, build, client } = opts;

	let current: RealtimeChannel | null = null;
	let retryTimer: number | null = null;
	let escalateTimer: number | null = null;
	let stopped = false;
	let up = false;
	let attempt = 0;
	let downSince = 0;
	let noticeShown = false;

	const setStatus = (state: "up" | "down" | "retrying"): void => {
		opts.onStatus?.(state);
	};

	const clearTimers = (): void => {
		if (retryTimer !== null) {
			window.clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (escalateTimer !== null) {
			window.clearTimeout(escalateTimer);
			escalateTimer = null;
		}
	};

	const teardownCurrent = (): void => {
		if (current) {
			void client.removeChannel(current).catch(() => {});
			current = null;
		}
	};

	const scheduleEscalation = (): void => {
		if (escalateTimer !== null || noticeShown) return;
		escalateTimer = window.setTimeout(() => {
			escalateTimer = null;
			if (stopped || up) return;
			noticeShown = true;
			new Notice(
				`Supabase jump: ${label} realtime offline — still retrying. Open the log panel for details.`,
				8000,
			);
			logger.warn(scope, `realtime offline for ${tuning.escalateAfterMs}ms — user notified`, {
				label,
				attempt,
			});
		}, tuning.escalateAfterMs);
	};

	const scheduleRetry = (): void => {
		if (stopped) return;
		const base = Math.min(tuning.reconnectMaxMs, tuning.reconnectInitialMs * 2 ** attempt);
		const jitter = base * (Math.random() * 0.4 - 0.2);
		const delay = Math.max(tuning.reconnectInitialMs, Math.round(base + jitter));
		attempt++;
		logger.debug(scope, `scheduling retry`, { delayMs: delay, attempt });
		setStatus("retrying");
		retryTimer = window.setTimeout(() => {
			retryTimer = null;
			subscribe();
		}, delay);
	};

	const handleFailure = async (status: SubscribeStatus): Promise<void> => {
		up = false;
		teardownCurrent();
		if (downSince === 0) downSince = Date.now();
		setStatus("down");
		logger.warn(scope, `realtime channel ${status}`, { label, attempt });

		// JWT recovery — try one refresh before backing off.
		if (status === "CHANNEL_ERROR" && opts.onJwtExpired && attempt === 0) {
			const refreshed = await opts.onJwtExpired();
			if (refreshed) {
				attempt = 0;
				subscribe();
				return;
			}
		}

		scheduleEscalation();
		scheduleRetry();
	};

	const subscribe = (): void => {
		if (stopped) return;
		teardownCurrent();
		current = build(client);
		current.subscribe((status: SubscribeStatus) => {
			if (stopped) return;
			if (status === "SUBSCRIBED") {
				up = true;
				attempt = 0;
				downSince = 0;
				noticeShown = false;
				if (escalateTimer !== null) {
					window.clearTimeout(escalateTimer);
					escalateTimer = null;
				}
				setStatus("up");
				logger.info(scope, `realtime channel subscribed`, { label });
				try {
					opts.onSubscribed?.();
				} catch (err) {
					logger.warn(scope, `onSubscribed handler threw`, {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			} else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
				void handleFailure(status);
			}
		});
	};

	subscribe();

	return {
		stop(): void {
			stopped = true;
			clearTimers();
			teardownCurrent();
			up = false;
		},
		restart(): void {
			if (stopped) return;
			attempt = 0;
			clearTimers();
			subscribe();
		},
		isUp(): boolean {
			return up;
		},
	};
}
