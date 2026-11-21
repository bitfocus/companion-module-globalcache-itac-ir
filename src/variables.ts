import type GlobalCacheItachInstance from './main.js'

export type VariablesSchema = {
	connection_status: string
	firmware_version: string
	queue_depth: number
	last_port: number | ''
	last_result: string
	last_error: string
	last_latency_ms: number | ''
	sent_total: number
	failed_total: number
	reconnects: number
	[id: `port_${number}_mode`]: string
}

export function UpdateVariableDefinitions(instance: GlobalCacheItachInstance): void {
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
		...Object.fromEntries(
			instance.portChoices.map(({ id, label }) => [`port_${id}_mode`, { name: `${label} connector mode` }]),
		),
	})
}

export function UpdateStatsVariables(instance: GlobalCacheItachInstance): void {
	const { stats } = instance.client
	instance.setVariableValues({
		queue_depth: instance.client.queueDepth(),
		sent_total: stats.completed,
		failed_total: stats.failed + instance.invalidCount,
	})
}

export function UpdatePortModeVariables(instance: GlobalCacheItachInstance): void {
	const values: Partial<VariablesSchema> = {}
	for (const { id } of instance.portChoices) {
		const port = Number(id)
		values[`port_${port}_mode`] = instance.client.portMode(port) ?? ''
	}
	instance.setVariableValues(values)
}
