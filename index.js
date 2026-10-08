const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')
const UpgradeScripts = require('./src/upgrades')

const config = require('./src/config')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')
const { ItachClient } = require('./src/itach')

const STATE_LABELS = {
	idle: 'Not configured',
	connecting: 'Connecting',
	connected: 'Connected',
	disconnected: 'Disconnected',
}

class itacirInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...config,
			...actions,
			...feedbacks,
			...variables,
			...presets,
		})

		this.client = new ItachClient()
		this.lastResult = undefined
		this.lastResultByPort = new Map()
	}

	async init(config) {
		this.initVariables()
		this.initActions()
		this.initFeedbacks()
		this.initPresets()

		await this.configUpdated(config)
	}

	async destroy() {
		this.stopClient()
	}

	async configUpdated(config) {
		this.config = { ...this.CONFIG_DEFAULTS, ...config }
		this.startClient()
	}

	startClient() {
		this.stopClient()

		const cfg = this.config
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
		this.deviceWarning = null

		this.setVariableValues({
			connection_status: STATE_LABELS.idle,
			firmware_version: '',
			last_port: '',
			last_result: '',
			last_error: '',
			last_latency_ms: '',
		})
		this.updateStatsVariables()
		this.checkFeedbacks()

		this.client.on('state', (state, message) => this.onClientState(state, message))
		this.client.on('result', (result) => this.recordResult(result))
		this.client.on('queue', () => {
			this.updateStatsVariables()
			this.checkFeedbacks('portBusy')
		})
		this.client.on('version', (version) => this.setVariableValues({ firmware_version: version }))
		this.client.on('devices', (devices, problem) => {
			this.log('info', `Device modules: ${devices.map((d) => `${d.module}:${d.kind}(${d.ports})`).join(', ')}`)
			this.deviceWarning = problem
			if (problem) {
				this.log('warn', problem)
				this.updateStatus(InstanceStatus.UnknownWarning, problem)
			}
		})
		this.client.on('log', (level, message) => this.log(level, message))

		if (!cfg.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the IP address of the device')
			return
		}

		this.client.start()
	}

	stopClient() {
		this.client.removeAllListeners()
		this.client.stop()
	}

	onClientState(state, message) {
		const previous = this.clientState
		this.clientState = state

		this.setVariableValues({ connection_status: STATE_LABELS[state] ?? state })
		this.checkFeedbacks('connected')

		switch (state) {
			case 'connecting':
				// Only show "connecting" for the first attempt, so a device that is
				// offline keeps showing the reason it failed while retrying
				if (previous !== 'disconnected') this.updateStatus(InstanceStatus.Connecting, message)
				break
			case 'connected':
				this.log('info', message)
				this.updateStatus(this.deviceWarning ? InstanceStatus.UnknownWarning : InstanceStatus.Ok, this.deviceWarning)
				break
			case 'disconnected':
				// Avoid flooding the log with the same failure on every retry
				if (previous === 'connected' || message !== this.lastDisconnectMessage) {
					this.log('warn', `Disconnected: ${message}. Reconnecting automatically.`)
				}
				this.lastDisconnectMessage = message
				this.updateStatus(InstanceStatus.ConnectionFailure, message)
				break
		}
	}

	recordResult(result) {
		// Codes cancelled on purpose (Stop IR, Clear queue) are not delivery failures
		if (result.status === 'cancelled') return

		this.lastResult = result
		this.lastResultByPort.set(result.port, result)

		this.setVariableValues({
			last_port: result.port,
			last_result: result.status,
			last_error: result.ok ? '' : (result.error ?? ''),
			last_latency_ms: result.latencyMs,
		})

		if (!result.ok) this.log('warn', `Port ${result.port}: ${result.error}`)

		this.updateStatsVariables()
		this.checkFeedbacks('lastFailed', 'portBusy')
	}
}

runEntrypoint(itacirInstance, UpgradeScripts)
