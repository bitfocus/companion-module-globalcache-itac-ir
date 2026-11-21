// Connection and IR delivery engine for Global Caché devices.
//
// Kept free of any Companion dependency so it can be tested against a fake
// device (see test/). The Companion instance in main.ts wires its events to
// status, variables and feedbacks.
//
// Delivery model:
//   - Each IR port has its own FIFO queue with one command in flight. The next
//     command waits for the previous command to settle. A hold keeps its
//     place on the port and refreshes a bounded burst until stopped.
//   - Every command gets a unique ID so confirmations are matched exactly.
//   - busyIR (port in use by another controller) is retried with a back-off:
//     the code was definitely not transmitted, so a retry is always safe.
//   - A command whose outcome is unknown (connection dropped, confirmation never
//     arrived) is NOT resent by default, because resending a toggle code such
//     as projector power would undo it. This can be enabled in the config.
//   - Commands that cannot be started within maxCommandAge (while the device is
//     offline, or the port stays busy) are discarded rather than fired late.
//     Time spent queued behind a code this module is already sending does not
//     count, so several codes pressed together are still delivered in order.
//   - The connection is watched with a keepalive probe, so a device that loses
//     power or network without closing the socket is detected and reconnected.

import { Socket } from 'node:net'
import { learnIrCode } from './learner.js'
import { EventEmitter } from 'node:events'
import { parseResponse, LineSplitter, type DeviceError, type DeviceInfo } from './protocol.js'
import { formatIrCode, transmitDurationMs, withRepeat, type IrCode } from './ircode.js'
import { DEFAULT_PORT_COUNT, getIrConnectors } from './devices.js'

export type ClientState = 'idle' | 'connecting' | 'connected' | 'disconnected'
export type StateInfo = { manual?: boolean }
type DeliveryStatus = 'complete' | 'stopped' | 'busy' | 'error' | 'uncertain' | 'expired' | 'cancelled' | 'rejected'

export interface DeliveryResult {
	ok: boolean
	status: DeliveryStatus | 'invalid'
	error?: string
	port: number
	attempts: number
	latencyMs: number
}

type QueuedCommand = {
	port: number
	address?: string
	code: IrCode
	enqueuedAt: number
	attempts: number
	resolve: (result: DeliveryResult) => void
	done: boolean
	ageRemaining: number
	ageStartedAt: number
	expiryTimer?: NodeJS.Timeout
	completionTimer?: NodeJS.Timeout
	hold?: { refreshMs: number; timer?: NodeJS.Timeout }
}

type InflightCommand = QueuedCommand & { id: number; address: string }

interface PortState {
	queue: QueuedCommand[]
	inflight: InflightCommand | null
	waiting: { cmd: QueuedCommand; timer: NodeJS.Timeout } | null
	stopTimer?: NodeJS.Timeout
}

interface ClientEvents {
	state: [state: ClientState, message?: string, info?: StateInfo]
	queue: []
	result: [result: DeliveryResult]
	log: [level: 'debug' | 'info' | 'warn', message: string]
	devices: [devices: DeviceInfo[], problem: string | null]
	version: [version: string]
}

export const ITACH_TCP_PORT = 4998
const DEFAULT_MODULE_ADDRESS = 1

const DEFAULTS = {
	host: '',
	port: ITACH_TCP_PORT,
	connectTimeout: 5000,
	reconnectMin: 1000,
	reconnectMax: 5000,
	keepaliveInterval: 10000,
	responseTimeout: 2000,
	completionMargin: 1500,
	maxCommandAge: 3000,
	retries: 3,
	busyRetryDelay: 250,
	retryUncertain: false,
	maxQueuePerPort: 20,
	tickInterval: 250,
}

type ClientOptions = typeof DEFAULTS & { preferredModule?: number }

const MAX_ID = 65535
const HOLD_REPEATS = 3
const NON_TRANSMITTING_MODES = new Set(['SENSOR', 'SENSOR_NOTIFY', 'LED_LIGHTING', 'SERIAL', 'RECEIVER'])

export class ItachClient extends EventEmitter<ClientEvents> {
	readonly options: ClientOptions
	readonly stats = { sent: 0, completed: 0, failed: 0, reconnects: 0 }
	state: ClientState = 'idle'
	version = ''
	devices: DeviceInfo[] | null

	private irConnectors: ReturnType<typeof getIrConnectors> | null
	private running = false
	private socket: Socket | null = null
	private rawSocket?: Socket
	private modeSocket?: Socket
	private readonly portModes = new Map<number, string>()
	private learner?: AbortController
	private legacyGc100 = false
	private legacyRawTimer?: NodeJS.Timeout
	private readonly splitter = new LineSplitter()
	private readonly ports = new Map<number, PortState>()
	private nextId = 1
	private reconnectDelay: number
	private reconnectTimer?: NodeJS.Timeout
	private connectTimer?: NodeJS.Timeout
	private tickTimer?: NodeJS.Timeout
	private lastRx = 0
	private probe: { sentAt: number } | null = null
	private discovery?: { startedAt: number; sawVersion: boolean; sawDeviceList: boolean }
	private pendingDevices: DeviceInfo[] = []
	private stateMessage?: string
	private manualReconnect = false

	constructor(options?: Partial<ClientOptions>, knownDevices: DeviceInfo[] | null = null) {
		super()
		this.options = { ...DEFAULTS, ...options }
		this.devices = knownDevices
		this.irConnectors = knownDevices && getIrConnectors(knownDevices, this.options.preferredModule)
		this.reconnectDelay = this.options.reconnectMin
	}

	// ---------------------------------------------------------------- lifecycle

	start(): void {
		if (this.running) return
		this.running = true
		this._connect()
	}

	stop(): void {
		this.running = false
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined
		if (this.socket) this._dropConnection(this.socket, 'Stopped')
		for (const p of this.ports.values()) this._cancelQueued(p, 'Connection closed')
		this.emit('queue')
		this._setState('idle')
	}

	/** Drop the current connection (if any) and connect again straight away */
	reconnect(reason = 'Manual reconnect'): void {
		if (!this.running) return
		// A requested reconnect is not a failure: don't count it or report the link as down
		this.manualReconnect = true
		if (this.socket) this._dropConnection(this.socket, reason)
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined
		this.reconnectDelay = this.options.reconnectMin
		this._connect()
	}

	get connected(): boolean {
		return this.state === 'connected'
	}

	get portCount(): number {
		return this.irConnectors?.length ?? DEFAULT_PORT_COUNT
	}

	private _connectorAddress(port: number): string | undefined {
		if (this.irConnectors) return this.irConnectors[port - 1]?.address
		return `${this.options.preferredModule ?? DEFAULT_MODULE_ADDRESS}:${port}`
	}

	private _portForAddress(module: number, connector: number): number | undefined {
		if (!this.irConnectors) {
			return module === (this.options.preferredModule ?? DEFAULT_MODULE_ADDRESS) ? connector : undefined
		}
		const address = `${module}:${connector}`
		const index = this.irConnectors.findIndex((item) => item.address === address)
		return index === -1 ? undefined : index + 1
	}

	portMode(port: number): string | undefined {
		return this.portModes.get(port)
	}

	async learnIR(signal: AbortSignal): Promise<string> {
		signal.throwIfAborted()
		if (!this.connected) throw new Error('Connect to the iTach before learning an IR code')
		if (this.legacyGc100) throw new Error('The GC-100 has no onboard IR learner')
		if (this.learner) throw new Error('IR learning is already in progress')
		if (this.probe || this.queueDepth() || [...this.ports.values()].some((p) => p.stopTimer)) {
			throw new Error('Wait until the connection is idle before learning an IR code')
		}

		const learner = new AbortController()
		this.learner = learner
		try {
			return await learnIrCode(this.options.host, this.options.port, AbortSignal.any([signal, learner.signal]))
		} finally {
			this.learner = undefined
			for (const port of this.ports.keys()) this._pump(port)
		}
	}

	// ----------------------------------------------------------------- commands

	/**
	 * Queue an IR code for transmission. Resolves (never rejects) once the
	 * outcome is known: { ok, status, error?, attempts, latencyMs }
	 *   status: complete | stopped | busy | error | uncertain | expired | cancelled | rejected
	 */
	async sendIR(port: number, code: IrCode): Promise<DeliveryResult> {
		return this._sendIR(port, code)
	}

	/** Refresh a short burst with the same command ID until Stop IR is called. */
	startHold(port: number, code: IrCode): void {
		const burst = withRepeat(code, HOLD_REPEATS)
		// Two repeat sections leave one section for the next refresh to arrive.
		const refreshMs = Math.max(20, Math.floor(transmitDurationMs(burst) - transmitDurationMs({ ...code, repeat: 1 })))
		void this._sendIR(port, burst, { refreshMs })
	}

	private async _sendIR(port: number, code: IrCode, hold?: QueuedCommand['hold']): Promise<DeliveryResult> {
		return new Promise((resolve) => {
			const cmd: QueuedCommand = {
				port,
				address: this.irConnectors ? this._connectorAddress(port) : undefined,
				code,
				enqueuedAt: Date.now(),
				attempts: 0,
				resolve,
				done: false,
				ageRemaining: this.options.maxCommandAge,
				ageStartedAt: 0,
				hold,
			}

			if (!this.running) return this._finish(cmd, false, 'rejected', 'No device configured')
			if (this.irConnectors && !cmd.address) {
				return this._finish(cmd, false, 'rejected', `No IR connector for port ${port}`)
			}
			if (hold && (!this.connected || this.learner)) {
				return this._finish(cmd, false, 'rejected', 'Cannot start a hold while disconnected or learning IR')
			}

			const p = this._port(port)
			if (hold && (p.inflight?.hold || p.waiting?.cmd.hold || p.queue.some((item) => item.hold))) {
				return this._finish(cmd, false, 'rejected', `Port ${port} already has a hold`)
			}
			if (this._depth(p) >= this.options.maxQueuePerPort) {
				return this._finish(cmd, false, 'rejected', `Port ${port} queue is full (${this.options.maxQueuePerPort})`)
			}

			this._enqueue(cmd, false)
			this._pump(port)
		})
	}

	/** Abort the code transmitting on a port and discard anything queued for it */
	stopIR(port: number): boolean {
		const p = this._port(port)
		this._cancelQueued(p, 'Cancelled by Stop IR')
		this.emit('queue')
		if (!this.connected || this.legacyRawTimer || this.learner) return false
		const address = this._connectorAddress(port)
		if (!address) return false
		if (NON_TRANSMITTING_MODES.has(this.portModes.get(port) ?? '')) return false
		if (p.stopTimer) return true

		if (p.inflight) {
			this._clearSendTimers(p.inflight)
		}
		p.stopTimer = setTimeout(() => {
			// An old stop acknowledgement has no ID. Close the socket before any
			// new send can be confused with that acknowledgement.
			const reason = `No Stop IR acknowledgement on port ${port}`
			this.emit('log', 'warn', reason)
			this._dropConnection(this.socket, reason)
		}, this.options.responseTimeout)
		this._write(`stopir,${address}`)
		return true
	}

	/** Discard every queued (not yet transmitting) command */
	clearQueue(): void {
		for (const p of this.ports.values()) this._cancelQueued(p, 'Queue cleared')
		this.emit('queue')
	}

	/** Keep raw command replies off the socket used for managed IR delivery. */
	sendRaw(line: string): boolean {
		if (!this.connected || this.learner) return false
		if (this.legacyGc100) return this._sendLegacyRaw(line)
		const socket = this.rawSocket ?? this._connectRawSocket()
		socket.write(line + '\r')
		return true
	}

	private _sendLegacyRaw(line: string): boolean {
		// A GC-100 only allows one TCP client. Use a version query as a fence
		// so any raw error arrives before managed sends can resume.
		if (this.legacyRawTimer || this.probe || this.queueDepth() || [...this.ports.values()].some((p) => p.stopTimer)) {
			return false
		}
		this.legacyRawTimer = setTimeout(() => {
			this._dropConnection(this.socket, 'No reply to the raw command verification query')
		}, this.options.responseTimeout)
		this._write(line)
		this._write('getversion,0')
		return true
	}

	private _connectRawSocket() {
		const socket = new Socket()
		const splitter = new LineSplitter()
		this.rawSocket = socket
		const timer = setTimeout(
			() => socket.destroy(new Error('Raw command connection timed out')),
			this.options.connectTimeout,
		)
		socket.once('connect', () => {
			clearTimeout(timer)
			socket.setNoDelay(true)
		})
		socket.on('data', (chunk) => {
			for (const reply of splitter.push(chunk)) {
				const response = parseResponse(reply)
				const level = response.type === 'error' ? 'warn' : 'debug'
				this.emit('log', level, `Raw command reply: ${reply}`)
			}
		})
		socket.on('error', (err) => this.emit('log', 'warn', `Raw command connection failed: ${err.message}`))
		socket.once('close', () => {
			clearTimeout(timer)
			if (this.rawSocket === socket) this.rawSocket = undefined
		})
		socket.connect(this.options.port, this.options.host)
		return socket
	}

	queueDepth(port?: number): number {
		if (port !== undefined) {
			const p = this.ports.get(port)
			return p ? this._depth(p) : 0
		}
		let total = 0
		for (const p of this.ports.values()) total += this._depth(p)
		return total
	}

	isPortBusy(port: number): boolean {
		return this.queueDepth(port) > 0
	}

	// --------------------------------------------------------------- connection

	private _connect() {
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined

		const { host, port, connectTimeout } = this.options
		const manual = this.manualReconnect
		this.manualReconnect = false
		this._setState('connecting', `Connecting to ${host}:${port}`, manual ? { manual: true } : undefined)

		const socket = new Socket()
		this.socket = socket
		this.splitter.reset()

		this.connectTimer = setTimeout(() => {
			this._dropConnection(socket, `No answer from ${host}:${port} within ${connectTimeout / 1000}s`)
		}, connectTimeout)

		socket.on('connect', () => {
			if (socket !== this.socket) return
			clearTimeout(this.connectTimer)
			socket.setNoDelay(true)
			socket.setKeepAlive(true, 5000)
			this.lastRx = Date.now()
			this.version = ''
			this.legacyGc100 = false
			this.pendingDevices = []
			this.discovery = { startedAt: this.lastRx, sawVersion: false, sawDeviceList: false }
			this.tickTimer = setInterval(() => this._tick(), this.options.tickInterval)
			this._write('getversion')
			this._write('getdevices')
		})
		socket.on('data', (chunk) => {
			if (socket !== this.socket) return
			for (const line of this.splitter.push(chunk)) this._handleLine(line)
		})
		socket.on('error', (err) => this._dropConnection(socket, err.message || String(err)))
		socket.on('close', () => this._dropConnection(socket, 'Connection closed by device'))

		socket.connect(port, host)
	}

	private _dropConnection(socket: Socket | null, reason: string) {
		if (!socket || socket !== this.socket) return
		const wasConnected = this.connected

		this.socket = null
		clearTimeout(this.connectTimer)
		clearInterval(this.tickTimer)
		this.tickTimer = undefined
		this.probe = null
		this.discovery = undefined
		socket.removeAllListeners()
		socket.on('error', () => {})
		socket.destroy()

		this.rawSocket?.destroy()
		this.rawSocket = undefined
		const modeSocket = this.modeSocket
		this.modeSocket = undefined
		modeSocket?.destroy()
		this.portModes.clear()
		this.learner?.abort()
		clearTimeout(this.legacyRawTimer)
		this.legacyRawTimer = undefined

		for (const p of this.ports.values()) {
			const wasStopping = !!p.stopTimer
			clearTimeout(p.stopTimer)
			p.stopTimer = undefined
			if (p.inflight) {
				const cmd = p.inflight
				this._clearInflight(cmd)
				if (wasStopping) {
					this._finish(cmd, false, 'uncertain', `Stop IR was not acknowledged (${reason})`)
				} else {
					this._settleUncertain(cmd, `Connection lost while sending (${reason})`)
				}
			}
			// A held button must be released and pressed again after a disconnect.
			this._cancelQueued(p, 'Hold cancelled on disconnect', true)
			this._syncQueueExpiry(p)
		}
		this.emit('queue')

		if (!this.running) return

		// reconnect() connects again itself, without announcing a failure
		if (this.manualReconnect) return

		if (wasConnected) this.stats.reconnects++
		this._setState('disconnected', reason)

		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMax)
		this.reconnectTimer = setTimeout(() => this._connect(), delay)
	}

	private _finishDiscovery() {
		if (this.discovery?.sawDeviceList) {
			this.devices = this.pendingDevices
			this.irConnectors = getIrConnectors(this.devices, this.options.preferredModule)
		}
		this.discovery = undefined
		this.pendingDevices = []
		if (this.devices) this.emit('devices', this.devices, this._checkDevices())
		// Use a separate connection so a late mode error cannot settle a send.
		// GC-100 only allows one TCP connection.
		if (!this.legacyGc100 && this.irConnectors?.length) {
			this._readPortModes(this.irConnectors)
		} else {
			this._markConnected()
		}
	}

	private _readPortModes(connectors: ReturnType<typeof getIrConnectors>) {
		const socket = new Socket()
		const splitter = new LineSplitter()
		// A Flex three-output cable reports its shared configuration at port 1.
		const pending = new Map<string, number[]>()
		connectors.forEach(({ modeAddress }, index) => {
			const ports = pending.get(modeAddress) ?? []
			ports.push(index + 1)
			pending.set(modeAddress, ports)
		})
		this.modeSocket = socket

		const finish = () => {
			clearTimeout(timer)
			if (this.modeSocket !== socket) return
			this.modeSocket = undefined
			socket.destroy()
			this._markConnected()
		}
		const timer = setTimeout(finish, this.options.responseTimeout)
		socket.once('connect', () => {
			for (const address of pending.keys()) socket.write(`get_IR,${address}\r`)
		})
		socket.on('data', (chunk) => {
			if (this.modeSocket !== socket) return
			for (const line of splitter.push(chunk)) {
				const response = parseResponse(line)
				if (response.type === 'portMode') {
					const address = `${response.module}:${response.port}`
					for (const port of pending.get(address) ?? []) this.portModes.set(port, response.mode)
					pending.delete(address)
				} else if (response.type === 'error') {
					pending.delete(`${response.module}:${response.port}`)
				}
			}
			if (!pending.size) finish()
		})
		socket.on('error', finish)
		socket.once('close', finish)
		socket.connect(this.options.port, this.options.host)
	}

	private _markConnected() {
		this.reconnectDelay = this.options.reconnectMin
		const { host, port } = this.options
		this._setState('connected', `Connected to ${host}:${port}`)
		for (const port of this.ports.keys()) this._pump(port)
	}

	private _probe() {
		if (!this.connected || this.probe) return
		this.probe = { sentAt: Date.now() }
		this._write('getversion')
	}

	private _tick() {
		const now = Date.now()
		if (this.legacyRawTimer || this.modeSocket || this.learner) return
		if (this.discovery) {
			if (now - this.discovery.startedAt >= this.options.responseTimeout) {
				if (this.discovery.sawVersion || this.discovery.sawDeviceList) {
					// A responsive device may lack one of the discovery commands.
					if (!this.discovery.sawDeviceList) this.emit('log', 'debug', 'No complete device list; using known IR ports')
					this._finishDiscovery()
				} else {
					this._dropConnection(this.socket, 'Device did not answer identification requests')
				}
			}
			return
		}
		if (this.probe) {
			if (now - this.probe.sentAt > this.options.responseTimeout) {
				this._dropConnection(
					this.socket,
					`Device stopped responding (no reply within ${this.options.responseTimeout / 1000}s)`,
				)
			}
			return
		}

		// A continuously refreshed hold may not produce completeir until release.
		const ports = [...this.ports.values()]
		const holding = ports.some((p) => p.inflight?.hold && !p.stopTimer)
		const transmitting = ports.some((p) => p.inflight)
		const interval = holding ? Math.min(1000, this.options.responseTimeout) : this.options.keepaliveInterval
		if (interval > 0 && (holding || !transmitting) && now - this.lastRx >= interval) this._probe()
	}

	private _write(line: string) {
		if (!this.socket) return false
		this.socket.write(line + '\r')
		return true
	}

	private _setState(state: ClientState, message?: string, info?: StateInfo) {
		if (this.state === state && this.stateMessage === message) return
		this.state = state
		this.stateMessage = message
		this.emit('state', state, message, info)
	}

	// ---------------------------------------------------------------- responses

	private _handleLine(line: string) {
		this.lastRx = Date.now()
		const wasProbing = !!this.probe
		this.probe = null

		const res = parseResponse(line)
		if (this.legacyRawTimer) {
			if (res.type === 'version' && res.module === 0) {
				clearTimeout(this.legacyRawTimer)
				this.legacyRawTimer = undefined
				for (const port of this.ports.keys()) this._pump(port)
			} else {
				this.emit('log', res.type === 'error' ? 'warn' : 'debug', `Raw command reply: ${line}`)
			}
			return
		}
		switch (res.type) {
			case 'complete': {
				const cmd = this._inflightFor(res.module, res.port, res.id)
				if (!cmd) return this.emit('log', 'debug', `Ignoring confirmation for unknown command: ${line}`)
				if (cmd.hold) {
					// completeir confirms one burst. The hold itself ends when the
					// device acknowledges the stop, even if a burst has completed.
					const p = this._port(cmd.port)
					clearTimeout(cmd.completionTimer)
					if (this.legacyGc100 && !p.stopTimer) this._transmit(cmd, p)
					return
				}
				this._clearInflight(cmd)
				this._finish(cmd, true, 'complete')
				return this._pump(cmd.port)
			}
			case 'busy': {
				const cmd = this._inflightFor(res.module, res.port, res.id)
				if (!cmd) return this.emit('log', 'debug', `Ignoring busy reply for unknown command: ${line}`)
				if (this._port(cmd.port).stopTimer) return
				this._clearInflight(cmd)
				if (cmd.attempts <= this.options.retries) {
					const delay = this.options.busyRetryDelay * cmd.attempts
					this.emit('log', 'info', `Port ${cmd.port} is busy (in use by another controller), retrying in ${delay}ms`)
					const p = this._port(cmd.port)
					p.waiting = {
						cmd,
						timer: setTimeout(() => {
							if (p.waiting?.cmd !== cmd) return
							p.waiting = null
							this._pauseExpiry(cmd)
							this._enqueue(cmd, true)
							this._pump(cmd.port)
						}, delay),
					}
				} else {
					this._finish(cmd, false, 'busy', `Port ${cmd.port} stayed busy after ${cmd.attempts} attempts`)
				}
				return this._pump(cmd.port)
			}
			case 'error':
				return this._handleError(res, wasProbing)
			case 'device':
				if (this.discovery && !this.discovery.sawDeviceList) this.pendingDevices.push(res)
				return
			case 'endDevices':
				if (!this.discovery) return
				this.discovery.sawDeviceList = true
				if (this.discovery.sawVersion) this._finishDiscovery()
				return
			case 'portMode':
				return
			case 'stopped': {
				const port = this._portForAddress(res.module, res.port)
				if (port !== undefined) this._handleStopped(port)
				return
			}
			case 'version':
				if (!this.version && res.module !== undefined && !res.text.startsWith('710-')) this.legacyGc100 = true
				if (this.version !== res.text) {
					this.version = res.text
					this.emit('version', this.version)
				}
				if (this.discovery) {
					this.discovery.sawVersion = true
					if (this.discovery.sawDeviceList) this._finishDiscovery()
				}
				return
			default:
				return this.emit('log', 'debug', `Unexpected reply from device: ${line}`)
		}
	}

	private _handleStopped(port: number) {
		const p = this.ports.get(port)
		if (!p || (!p.stopTimer && !p.inflight)) return
		clearTimeout(p.stopTimer)
		p.stopTimer = undefined
		if (p.inflight) {
			const cmd = p.inflight
			this._clearInflight(cmd)
			this._finish(cmd, true, 'stopped')
		}
		this._pump(port)
	}

	private _handleError(res: DeviceError, wasProbing: boolean): void {
		const message = `${res.message} (ERR ${String(res.code).padStart(3, '0')})`
		if (this.discovery) {
			this.emit('log', 'warn', `Device reported: ${message}`)
			return
		}

		const invalidModule = res.module === 0 && res.port === 0 && res.code === 2
		let affected: [number, PortState][] = []
		if (res.module !== undefined && res.port !== undefined && res.port > 0) {
			const port = this._portForAddress(res.module, res.port)
			if (port !== undefined) {
				const p = this.ports.get(port)
				if (p?.inflight || p?.stopTimer) affected = [[port, p]]
			}
		} else if (!wasProbing && (res.port === undefined || (res.module === 0 && res.port === 0))) {
			const candidates = [...this.ports].filter(([, p]) => p.inflight || p.stopTimer)
			if (candidates.length === 1) affected = candidates
			else if (invalidModule) {
				// The device omits the failed module. Only settle the group if they all target it.
				const modules = new Set(candidates.map(([port]) => this._connectorAddress(port)?.split(':')[0]))
				if (modules.size === 1) affected = candidates
			}
		}
		if (!affected.length) {
			this.emit('log', 'warn', `Device reported: ${message}`)
			return
		}

		// Settle the snapshot before pumping: a global error cannot settle later sends.
		for (const [port, p] of affected) {
			if (p.stopTimer) {
				// With a send and a stop outstanding on the same port, an error
				// has no request ID. Keep waiting for their explicit replies.
				this.emit('log', 'warn', `Device reported on port ${port}: ${message}`)
				if (p.inflight && !invalidModule) continue
				clearTimeout(p.stopTimer)
				p.stopTimer = undefined
				if (!p.inflight) continue
			}
			if (!p.inflight) {
				this.emit('log', 'warn', `Device reported: ${message}`)
				continue
			}
			const cmd = p.inflight
			this._clearInflight(cmd)
			this._finish(cmd, false, 'error', message)
		}
		for (const [port] of affected) this._pump(port)
	}

	private _checkDevices() {
		if (this.portCount) return null
		const { preferredModule } = this.options
		if (preferredModule !== undefined)
			return `No IR connectors at the previously configured module address ${preferredModule}`
		return 'Device reports no IR connectors'
	}

	private _inflightFor(module: number, port: number, id: number) {
		const logicalPort = this._portForAddress(module, port)
		if (logicalPort === undefined) return null
		const p = this.ports.get(logicalPort)
		return p?.inflight && p.inflight.id === id ? p.inflight : null
	}

	// -------------------------------------------------------------------- queue

	private _port(port: number): PortState {
		let p = this.ports.get(port)
		if (!p) {
			p = { queue: [], inflight: null, waiting: null }
			this.ports.set(port, p)
		}
		return p
	}

	private _depth(p: PortState) {
		return p.queue.length + (p.inflight ? 1 : 0) + (p.waiting ? 1 : 0)
	}

	/**
	 * Queue a command. It is discarded once it has spent maxCommandAge waiting to
	 * start while the device is offline or the port is busy. Time queued behind a
	 * code this module is already transmitting does not count.
	 */
	private _enqueue(cmd: QueuedCommand, front: boolean) {
		const p = this._port(cmd.port)

		if (front) p.queue.unshift(cmd)
		else p.queue.push(cmd)
		this._syncQueueExpiry(p)
		this.emit('queue')
	}

	/** Run the discard clock only while nothing of ours is transmitting on the port */
	private _syncQueueExpiry(p: PortState) {
		const hold = !!p.inflight
		const cmds = [...p.queue]
		if (p.waiting) cmds.push(p.waiting.cmd)
		for (const cmd of cmds) {
			if (hold) this._pauseExpiry(cmd)
			else this._armExpiry(cmd, p)
		}
	}

	private _armExpiry(cmd: QueuedCommand, p: PortState) {
		if (cmd.done || cmd.expiryTimer) return
		if (cmd.ageRemaining <= 0) {
			this._removeQueued(cmd, p)
			this._expire(cmd)
			return
		}

		const timer = setTimeout(() => {
			if (cmd.done || cmd.expiryTimer !== timer) return
			cmd.expiryTimer = undefined
			const portState = this._port(cmd.port)
			if (!portState.queue.includes(cmd) && portState.waiting?.cmd !== cmd) return
			this._removeQueued(cmd, portState)
			this._expire(cmd)
			this._pump(cmd.port)
		}, cmd.ageRemaining)
		cmd.expiryTimer = timer
		cmd.ageStartedAt = Date.now()
	}

	private _pauseExpiry(cmd: QueuedCommand) {
		if (!cmd.expiryTimer) return
		clearTimeout(cmd.expiryTimer)
		cmd.expiryTimer = undefined
		cmd.ageRemaining = Math.max(0, cmd.ageRemaining - (Date.now() - cmd.ageStartedAt))
	}

	private _removeQueued(cmd: QueuedCommand, p: PortState) {
		const index = p.queue.indexOf(cmd)
		if (index !== -1) p.queue.splice(index, 1)
		if (p.waiting?.cmd === cmd) {
			clearTimeout(p.waiting.timer)
			p.waiting = null
		}
	}

	private _expire(cmd: QueuedCommand) {
		const reason = this.connected ? 'port was busy' : 'device offline'
		this._finish(
			cmd,
			false,
			'expired',
			`Discarded: could not start within ${this.options.maxCommandAge / 1000}s (${reason})`,
		)
		this.emit('queue')
	}

	private _pump(port: number) {
		const p = this._port(port)
		this._syncQueueExpiry(p)
		if (!this.connected || p.inflight || p.waiting || p.stopTimer || this.legacyRawTimer || this.learner) return

		const address = this._connectorAddress(port)
		const mode = this.portModes.get(port)
		let queued = p.queue.shift()
		while (queued) {
			this._pauseExpiry(queued)
			if (queued.ageRemaining <= 0) {
				this._expire(queued)
			} else if (!address) {
				this._finish(queued, false, 'rejected', `No IR connector for port ${port}`)
			} else if (queued.address && queued.address !== address) {
				this._finish(queued, false, 'rejected', `The IR connector for port ${port} changed while the code was queued`)
			} else if (mode && NON_TRANSMITTING_MODES.has(mode)) {
				this._finish(queued, false, 'rejected', `Port ${port} is in ${mode} mode and cannot transmit IR`)
			} else {
				break
			}
			queued = p.queue.shift()
		}
		if (!queued || !address) {
			this.emit('queue')
			return
		}

		const cmd: InflightCommand = Object.assign(queued, { id: this.nextId, address })
		this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1
		cmd.attempts++
		p.inflight = cmd

		this._transmit(cmd, p)
		this._syncQueueExpiry(p)
		this.emit('queue')
	}

	private _transmit(cmd: InflightCommand, p: PortState) {
		const { completionMargin } = this.options
		this._write(`sendir,${cmd.address},${cmd.id},${formatIrCode(cmd.code)}`)
		this.stats.sent++

		const timeout = Math.ceil(transmitDurationMs(cmd.code)) + completionMargin
		clearTimeout(cmd.completionTimer)
		cmd.completionTimer = setTimeout(() => {
			if (p.inflight !== cmd) return
			this._clearInflight(cmd)
			this._settleUncertain(cmd, `No confirmation from device within ${timeout}ms`)
			this._probe()
			this._pump(cmd.port)
		}, timeout)

		const hold = cmd.hold
		if (hold && !this.legacyGc100) {
			hold.timer = setTimeout(() => {
				if (!this.connected || p.inflight !== cmd || p.stopTimer) return
				this._transmit(cmd, p)
			}, hold.refreshMs)
		}
	}

	private _clearSendTimers(cmd: InflightCommand) {
		clearTimeout(cmd.completionTimer)
		clearTimeout(cmd.hold?.timer)
	}

	private _clearInflight(cmd: InflightCommand) {
		this._clearSendTimers(cmd)
		const p = this._port(cmd.port)
		if (p.inflight === cmd) p.inflight = null
	}

	private _settleUncertain(cmd: QueuedCommand, reason: string) {
		if (this.running && !cmd.hold && this.options.retryUncertain && cmd.attempts <= this.options.retries) {
			this.emit('log', 'warn', `${reason}; resending to port ${cmd.port}`)
			this._enqueue(cmd, true)
		} else {
			this._finish(cmd, false, 'uncertain', `${reason}; the code may or may not have been transmitted`)
		}
	}

	private _cancelQueued(p: PortState, reason: string, onlyHolds = false) {
		const queued = onlyHolds ? p.queue.filter((cmd) => cmd.hold) : [...p.queue]
		if (p.waiting && (!onlyHolds || p.waiting.cmd.hold)) queued.push(p.waiting.cmd)
		for (const cmd of queued) {
			this._removeQueued(cmd, p)
			this._finish(cmd, false, 'cancelled', reason)
		}
	}

	private _finish(cmd: QueuedCommand, ok: boolean, status: DeliveryStatus, error?: string) {
		if (cmd.done) return
		cmd.done = true
		clearTimeout(cmd.expiryTimer)
		cmd.expiryTimer = undefined
		clearTimeout(cmd.completionTimer)

		if (status === 'complete') this.stats.completed++
		else if (!ok && status !== 'cancelled') this.stats.failed++

		const result: DeliveryResult = {
			ok,
			status,
			error,
			port: cmd.port,
			attempts: cmd.attempts,
			latencyMs: Date.now() - cmd.enqueuedAt,
		}
		this.emit('result', result)
		cmd.resolve(result)
	}
}
