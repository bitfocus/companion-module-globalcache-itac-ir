import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { CONFIG_DEFAULTS, GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateStatsVariables, UpdateVariableDefinitions } from './variables.js'
import { ItachClient, type ClientState, type DeliveryResult, type StateInfo } from './itach.js'
import type { GlobalCacheInstance, GlobalCacheTypes } from './types.js'

export { UpgradeScripts } from './upgrades.js'

const STATE_LABELS = {
	idle: 'Not configured',
	connecting: 'Connecting',
	connected: 'Connected',
	disconnected: 'Disconnected',
}

export default class GlobalCacheItachInstance extends InstanceBase<GlobalCacheTypes> implements GlobalCacheInstance {
	client = new ItachClient()
	lastResult: DeliveryResult | undefined
	readonly lastResultByPort = new Map<number, DeliveryResult>()
	invalidCount = 0

	private clientState: ClientState = 'idle'
	private deviceWarning: string | null = null
	private lastDisconnectMessage?: string

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	async init(config: ModuleConfig): Promise<void> {
		UpdateVariableDefinitions(this)
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdatePresets(this)

		await this.configUpdated(config)
	}

	async destroy(): Promise<void> {
		this.stopClient()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.startClient({ ...CONFIG_DEFAULTS, ...config })
	}

	private startClient(cfg: ModuleConfig) {
		this.stopClient()

		this.client = new ItachClient({
			host: cfg.host,
			port: cfg.port,
			moduleAddress: cfg.moduleAddress,
			maxCommandAge: cfg.maxCommandAge,
			retries: cfg.retries,
			retryUncertain: cfg.retryUncertain,
			keepaliveInterval: cfg.keepaliveInterval * 1000,
			responseTimeout: cfg.responseTimeout,
		})
		this.lastResult = undefined
		this.lastResultByPort.clear()
		this.invalidCount = 0
		this.deviceWarning = null

		this.setVariableValues({
			connection_status: STATE_LABELS.idle,
			firmware_version: '',
			last_port: '',
			last_result: '',
			last_error: '',
			last_latency_ms: '',
		})
		UpdateStatsVariables(this)
		this.checkAllFeedbacks()

		this.client.on('state', (state, message, info) => this.onClientState(state, message, info))
		this.client.on('result', (result) => this.recordResult(result))
		this.client.on('queue', () => {
			UpdateStatsVariables(this)
			this.checkFeedbacks('portBusy')
		})
		this.client.on('version', (version) => this.setVariableValues({ firmware_version: version }))
		this.client.on('devices', (devices, problem) => {
			this.log('info', `Device modules: ${devices.map((d) => `${d.module}:${d.kind}(${d.ports})`).join(', ')}`)
			this.deviceWarning = problem
			if (problem) this.log('warn', problem)
			if (!this.client.connected) return
			if (problem) this.updateStatus(InstanceStatus.UnknownWarning, problem)
			else this.updateStatus(InstanceStatus.Ok)
		})
		this.client.on('log', (level, message) => this.log(level, message))

		if (!cfg.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the IP address of the device')
			return
		}

		this.client.start()
	}

	private stopClient() {
		this.client.removeAllListeners()
		this.client.stop()
	}

	private onClientState(state: ClientState, message?: string, info: StateInfo = {}) {
		const previous = this.clientState
		this.clientState = state

		this.setVariableValues({ connection_status: STATE_LABELS[state] ?? state })
		this.checkFeedbacks('connected')

		switch (state) {
			case 'connecting':
				// The next device list is a new answer; don't keep the previous one.
				this.deviceWarning = null
				// Only show "connecting" for the first attempt, so a device that is
				// offline keeps showing the reason it failed while retrying.
				// A manual reconnect always shows it, including while already offline.
				if (info.manual || previous !== 'disconnected') this.updateStatus(InstanceStatus.Connecting, message)
				break
			case 'connected':
				if (message) this.log('info', message)
				if (this.deviceWarning) this.updateStatus(InstanceStatus.UnknownWarning, this.deviceWarning)
				else this.updateStatus(InstanceStatus.Ok)
				break
			case 'disconnected':
				this.deviceWarning = null
				// Avoid flooding the log with the same failure on every retry
				if (previous === 'connected' || message !== this.lastDisconnectMessage) {
					this.log('warn', `Disconnected: ${message}. Reconnecting automatically.`)
				}
				this.lastDisconnectMessage = message
				this.updateStatus(InstanceStatus.ConnectionFailure, message)
				break
		}
	}

	recordResult(result: DeliveryResult): void {
		// Codes cancelled on purpose (Stop IR, Clear queue) are not delivery failures
		if (result.status === 'cancelled') return
		if (result.status === 'invalid') this.invalidCount++

		this.lastResult = result
		this.lastResultByPort.set(result.port, result)

		this.setVariableValues({
			last_port: result.port,
			last_result: result.status,
			last_error: result.ok ? '' : (result.error ?? ''),
			last_latency_ms: result.latencyMs,
		})

		if (!result.ok) this.log('warn', `Port ${result.port}: ${result.error}`)

		UpdateStatsVariables(this)
		this.checkFeedbacks('lastFailed', 'portBusy')
	}
}
