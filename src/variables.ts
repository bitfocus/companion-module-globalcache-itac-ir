import type { GlobalCacheInstance } from './types.js'

export function UpdateVariableDefinitions(instance: GlobalCacheInstance): void {
	instance.setVariableDefinitions({
		connection_status: { name: 'Connection status' },
		firmware_version: { name: 'Device firmware version' },
		queue_depth: { name: 'Codes waiting or transmitting' },
		last_port: { name: 'Port of the last code' },
		last_result: { name: 'Result of the last code' },
		last_error: { name: 'Last error message' },
		last_latency_ms: { name: 'Time from press to confirmed send of the last code (ms)' },
		sent_total: { name: 'Codes confirmed sent' },
		failed_total: { name: 'Codes failed' },
		reconnects: { name: 'Reconnections since start' },
	})
}

export function UpdateStatsVariables(instance: GlobalCacheInstance): void {
	const { stats } = instance.client
	instance.setVariableValues({
		queue_depth: instance.client.queueDepth(),
		sent_total: stats.completed,
		failed_total: stats.failed + instance.invalidCount,
		reconnects: stats.reconnects,
	})
}
