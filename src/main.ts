import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { CONFIG_DEFAULTS, GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import {
	UpdatePortModeVariables,
	UpdateStatsVariables,
	UpdateVariableDefinitions,
	type VariablesSchema,
} from './variables.js'
import { ITACH_TCP_PORT, ItachClient, type ClientState, type DeliveryResult, type StateInfo } from './itach.js'
import { DEFAULT_PORT_COUNT } from './devices.js'

export { UpgradeScripts } from './upgrades.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

const STATE_LABELS = {
	idle: 'Not configured',
	connecting: 'Connecting',
	connected: 'Connected',
	disconnected: 'Disconnected',
}

export default class GlobalCacheItachInstance extends InstanceBase<ModuleSchema> {
	client = new ItachClient()
	lastResult: DeliveryResult | undefined
	readonly lastResultByPort = new Map<number, DeliveryResult>()
	invalidCount = 0

	private clientState: ClientState = 'idle'
	private portCount = DEFAULT_PORT_COUNT
	private lastDeviceInventory?: string
	private lastDeviceProblem?: string | null
	private deviceWarning: string | null = null
	private lastDisconnectMessage?: string

	get portChoices(): { id: string; label: string }[] {
		return Array.from({ length: this.portCount }, (_, index) => ({
			id: String(index + 1),
			label: `Port ${index + 1}`,
		}))
	}

	private updatePortDefinitions() {
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdatePresets(this)
		UpdateVariableDefinitions(this)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updatePortDefinitions()

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

		const previous = this.client.options
		const port = cfg.port ?? ITACH_TCP_PORT
		const preferredModule = cfg.moduleAddress === 1 ? undefined : cfg.moduleAddress
		const sameDevice =
			previous.host === cfg.host && previous.port === port && previous.preferredModule === preferredModule
		const knownDevices = sameDevice ? this.client.devices : null
		if (!sameDevice) {
			this.lastDeviceInventory = undefined
			this.lastDeviceProblem = undefined
			this.setPortCount(DEFAULT_PORT_COUNT)
		}
		this.clientState = 'idle'
		this.lastDisconnectMessage = undefined
		this.client = new ItachClient(
			{
				host: cfg.host,
				port,
				preferredModule,
				maxCommandAge: cfg.maxCommandAge,
				retries: cfg.retries,
				retryUncertain: cfg.retryUncertain,
				keepaliveInterval: cfg.keepaliveInterval * 1000,
				responseTimeout: cfg.responseTimeout,
			},
			knownDevices,
		)
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
			reconnects: 0,
		})
		UpdateStatsVariables(this)
		UpdatePortModeVariables(this)
		this.checkAllFeedbacks()

		this.client.on('state', (state, message, info) => this.onClientState(state, message, info))
		this.client.on('result', (result) => this.recordResult(result))
		this.client.on('queue', () => {
			UpdateStatsVariables(this)
			this.checkFeedbacks('portBusy')
		})
		this.client.on('version', (version) => this.setVariableValues({ firmware_version: version }))
		this.client.on('devices', (devices, problem) => {
			const inventory = devices.map((d) => `${d.module}:${d.kind}(${d.ports})`).join(', ')
			if (inventory !== this.lastDeviceInventory) {
				this.log('info', `Device modules: ${inventory}`)
				this.lastDeviceInventory = inventory
			}
			if (problem && problem !== this.lastDeviceProblem) this.log('warn', problem)
			this.lastDeviceProblem = problem
			this.deviceWarning = problem

			this.setPortCount(this.client.portCount)
		})
		this.client.on('log', (level, message) => this.log(level, message))

		if (!cfg.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the IP address of the device')
			return
		}

		this.client.start()
	}

	private setPortCount(count: number) {
		if (count === this.portCount) return
		this.portCount = count
		this.updatePortDefinitions()
	}

	private stopClient() {
		this.client.removeAllListeners()
		this.client.stop()
	}

	private onClientState(state: ClientState, message?: string, info: StateInfo = {}) {
		const previous = this.clientState
		this.clientState = state

		this.setVariableValues({
			connection_status: STATE_LABELS[state],
			reconnects: this.client.stats.reconnects,
			...(state === 'disconnected' || state === 'connecting' ? { firmware_version: '' } : {}),
		})
		UpdatePortModeVariables(this)
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
