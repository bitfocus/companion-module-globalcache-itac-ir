module.exports = {
	initVariables: function () {
		this.setVariableDefinitions([
			{ variableId: 'connection_status', name: 'Connection status' },
			{ variableId: 'firmware_version', name: 'Device firmware version' },
			{ variableId: 'queue_depth', name: 'Codes waiting or transmitting' },
			{ variableId: 'last_port', name: 'Port of the last code' },
			{ variableId: 'last_result', name: 'Result of the last code' },
			{ variableId: 'last_error', name: 'Last error message' },
			{ variableId: 'last_latency_ms', name: 'Time from press to confirmed send of the last code (ms)' },
			{ variableId: 'sent_total', name: 'Codes confirmed sent' },
			{ variableId: 'failed_total', name: 'Codes failed' },
			{ variableId: 'reconnects', name: 'Reconnections since start' },
		])
	},

	updateStatsVariables: function () {
		const { stats } = this.client
		this.setVariableValues({
			queue_depth: this.client.queueDepth(),
			sent_total: stats.completed,
			failed_total: stats.failed,
			reconnects: stats.reconnects,
		})
	},
}
