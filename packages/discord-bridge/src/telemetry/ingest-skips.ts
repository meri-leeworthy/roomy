/**
 * In-process counters for messages ingest declines to sync, labelled by
 * reason (`bridge_ingest_skipped_total{reason}`).
 *
 * Ingest runs in a single process (live and backfill share it), so plain
 * module state is the whole ledger; the status API reads a snapshot. Counts
 * are per (message, target space) — a message fanned out to three spaces and
 * skipped in two increments twice, which is what ingest's own `skipped`
 * total reports.
 */

export const INGEST_SKIP_METRIC = "bridge_ingest_skipped_total";

/** Every path that declines to sync a message (or one target space of it). */
export type IngestSkipReason =
	| "no_guild_id"
	| "own_webhook_message"
	| "channel_not_bridged"
	| "system_message"
	| "already_synced"
	| "capacity_over_limit"
	| "no_room_mapping"
	| "empty_message"
	| "send_failed"
	| "thread_starter_missing_ref"
	| "thread_starter_not_bridged"
	| "thread_starter_already_synced"
	| "thread_starter_no_thread_room"
	| "thread_starter_no_original"
	| "thread_starter_no_parent"
	| "thread_starter_send_failed"
	| "forward_missing_ref"
	| "forward_not_bridged"
	| "forward_already_synced"
	| "forward_no_target_room"
	| "forward_no_original"
	| "forward_no_source_room"
	| "forward_send_failed";

export interface IngestSkipSnapshot {
	/** The counter's metric name, so a status reader needs no out-of-band map. */
	metric: typeof INGEST_SKIP_METRIC;
	/** Sum over every reason. */
	total: number;
	/** Reason → count, alphabetically ordered for a stable response. */
	reasons: Record<string, number>;
}

/**
 * A complete table, so every reason is nameable before it fires: a new union
 * member fails type-checking until it is listed here. The table doubles as
 * the ledger reset.
 */
function emptyCounts(): Record<IngestSkipReason, number> {
	return {
		no_guild_id: 0,
		own_webhook_message: 0,
		channel_not_bridged: 0,
		system_message: 0,
		already_synced: 0,
		capacity_over_limit: 0,
		no_room_mapping: 0,
		empty_message: 0,
		send_failed: 0,
		thread_starter_missing_ref: 0,
		thread_starter_not_bridged: 0,
		thread_starter_already_synced: 0,
		thread_starter_no_thread_room: 0,
		thread_starter_no_original: 0,
		thread_starter_no_parent: 0,
		thread_starter_send_failed: 0,
		forward_missing_ref: 0,
		forward_not_bridged: 0,
		forward_already_synced: 0,
		forward_no_target_room: 0,
		forward_no_original: 0,
		forward_no_source_room: 0,
		forward_send_failed: 0,
	};
}

let counts = emptyCounts();

export function recordIngestSkip(reason: IngestSkipReason): void {
	counts[reason] += 1;
}

export function ingestSkipSnapshot(): IngestSkipSnapshot {
	const reasons: Record<string, number> = {};
	let total = 0;
	for (const [reason, count] of Object.entries(counts).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (count === 0) continue;
		reasons[reason] = count;
		total += count;
	}
	return { metric: INGEST_SKIP_METRIC, total, reasons };
}

/** Clear every counter. Tests only — process lifetime is the counter's window. */
export function resetIngestSkips(): void {
	counts = emptyCounts();
}
