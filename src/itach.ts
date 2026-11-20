// Connection and IR delivery engine for Global Caché devices.
//
// Kept free of any Companion dependency so it can be tested against a fake
// device (see test/). The Companion instance in main.ts wires its events to
// status, variables and feedbacks.
//
// Delivery model:
//   - Each IR port has its own FIFO queue with one command in flight. The next
//     command is only sent once the device confirms the previous one with
//     completeir, so codes are never cut short by the next button press.
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
import { EventEmitter } from 'node:events'
import { parseResponse, LineSplitter, type DeviceError, type DeviceInfo } from './protocol.js'
import { formatIrCode, transmitDurationMs, type IrCode } from './ircode.js'

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
	code: IrCode
	enqueuedAt: number
	attempts: number
	resolve: (result: DeliveryResult) => void
	done: boolean
	ageRemaining: number
	ageStartedAt: number
	expiryTimer?: NodeJS.Timeout
	completionTimer?: NodeJS.Timeout
}

type InflightCommand = QueuedCommand & { id: number }

interface PortState {
	queue: QueuedCommand[]
	inflight: InflightCommand | null
	waiting: { cmd: QueuedCommand; timer: NodeJS.Timeout } | null
}

interface ClientEvents {
	state: [state: ClientState, message?: string, info?: StateInfo]
	queue: []
	result: [result: DeliveryResult]
	log: [level: 'debug' | 'info' | 'warn', message: string]
	devices: [devices: DeviceInfo[], problem: string | null]
	version: [version: string]
}

const DEFAULTS = {
	host: '',
	port: 4998,
	moduleAddress: 1,
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

const MAX_ID = 65535

export class ItachClient extends EventEmitter<ClientEvents> {
	readonly options: typeof DEFAULTS
	readonly stats = { sent: 0, completed: 0, failed: 0, reconnects: 0 }
	state: ClientState = 'idle'
	version = ''
	devices: DeviceInfo[] | null = null

	private running = false
	private socket: Socket | null = null
	private readonly splitter = new LineSplitter()
	private readonly ports = new Map<number, PortState>()
	private nextId = 1
	private reconnectDelay: number
	private reconnectTimer?: NodeJS.Timeout
	private connectTimer?: NodeJS.Timeout
	private tickTimer?: NodeJS.Timeout
	private lastRx = 0
	private probe: { sentAt: number } | null = null
	private unattributedRequests = 0
	private pendingDevices: DeviceInfo[] = []
	private stateMessage?: string
	private manualReconnect = false

	constructor(options?: Partial<typeof DEFAULTS>) {
		super()
		this.options = { ...DEFAULTS, ...options }
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
		for (const port of this.ports.keys()) this._cancelPort(port, 'cancelled', 'Connection closed')
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

	// ----------------------------------------------------------------- commands

	/**
	 * Queue an IR code for transmission. Resolves (never rejects) once the
	 * outcome is known: { ok, status, error?, attempts, latencyMs }
	 *   status: complete | stopped | busy | error | uncertain | expired | cancelled | rejected
	 */
	async sendIR(port: number, code: IrCode): Promise<DeliveryResult> {
		return new Promise((resolve) => {
			const cmd: QueuedCommand = {
				port,
				code,
				enqueuedAt: Date.now(),
				attempts: 0,
				resolve,
				done: false,
				ageRemaining: this.options.maxCommandAge,
				ageStartedAt: 0,
			}

			if (!this.running) return this._finish(cmd, false, 'rejected', 'No device configured')

			const p = this._port(port)
			if (this._depth(p) >= this.options.maxQueuePerPort) {
				return this._finish(cmd, false, 'rejected', `Port ${port} queue is full (${this.options.maxQueuePerPort})`)
			}

			this._enqueue(cmd, false)
			this._pump(port)
		})
	}

	/** Abort the code transmitting on a port and discard anything queued for it */
	stopIR(port: number): boolean {
		this._cancelPort(port, 'cancelled', 'Cancelled by Stop IR')
		if (!this.connected) return false
		this._write(`stopir,${this.options.moduleAddress}:${port}`)
		return true
	}

	/** Discard every queued (not yet transmitting) command */
	clearQueue(): void {
		for (const p of this.ports.values()) {
			for (const cmd of p.queue.splice(0)) this._finish(cmd, false, 'cancelled', 'Queue cleared')
			if (p.waiting) {
				clearTimeout(p.waiting.timer)
				this._finish(p.waiting.cmd, false, 'cancelled', 'Queue cleared')
				p.waiting = null
			}
		}
		this.emit('queue')
	}

	/** Send a raw API command, for advanced use */
	sendRaw(line: string): boolean {
		if (!this.connected) return false
		// Its reply must not be mistaken for the result of an IR code in flight
		this.unattributedRequests++
		this._write(line)
		return true
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
			this.reconnectDelay = this.options.reconnectMin
			this.lastRx = Date.now()
			this.unattributedRequests = 0
			this.pendingDevices = []
			this._setState('connected', `Connected to ${host}:${port}`)
			this.tickTimer = setInterval(() => this._tick(), this.options.tickInterval)
			this._identify()
			for (const p of this.ports.keys()) this._pump(p)
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
		socket.removeAllListeners()
		socket.on('error', () => {})
		socket.destroy()

		for (const p of this.ports.values()) {
			if (p.inflight) {
				const cmd = p.inflight
				p.inflight = null
				clearTimeout(cmd.completionTimer)
				this._settleUncertain(cmd, `Connection lost while sending (${reason})`)
			}
			// Nothing of ours is transmitting now, so queued codes start ageing
			this._syncQueueExpiry(p)
		}

		if (!this.running) return

		// reconnect() connects again itself, without announcing a failure
		if (this.manualReconnect) return

		if (wasConnected) this.stats.reconnects++
		this._setState('disconnected', reason)

		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMax)
		this.reconnectTimer = setTimeout(() => this._connect(), delay)
	}

	private _identify() {
		// getversion doubles as the first health probe: a device that accepts the
		// TCP connection but never answers is treated as offline
		this._probe()
		this._write('getdevices')
	}

	private _probe() {
		if (!this.connected || this.probe) return
		this.probe = { sentAt: Date.now() }
		this.unattributedRequests++
		this._write('getversion')
	}

	private _tick() {
		const now = Date.now()
		if (this.probe) {
			if (now - this.probe.sentAt > this.options.responseTimeout) {
				this._dropConnection(
					this.socket,
					`Device stopped responding (no reply within ${this.options.responseTimeout / 1000}s)`,
				)
			}
			return
		}

		// While a code is transmitting its own completion timeout watches the link
		const { keepaliveInterval } = this.options
		const transmitting = [...this.ports.values()].some((p) => p.inflight)
		if (keepaliveInterval > 0 && !transmitting && now - this.lastRx >= keepaliveInterval) this._probe()
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
		this.probe = null

		const res = parseResponse(line)
		switch (res.type) {
			case 'complete': {
				const cmd = this._inflightFor(res.port, res.id)
				if (!cmd) return this.emit('log', 'debug', `Ignoring confirmation for unknown command: ${line}`)
				this._clearInflight(cmd)
				this._finish(cmd, true, 'complete')
				return this._pump(cmd.port)
			}
			case 'busy': {
				const cmd = this._inflightFor(res.port, res.id)
				if (!cmd) return this.emit('log', 'debug', `Ignoring busy reply for unknown command: ${line}`)
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
			case 'error': {
				const cmd = this._inflightForError(res)
				const text = `${res.message} (ERR ${String(res.code).padStart(3, '0')})`
				if (!cmd) {
					// A bare "ERR_008" may belong to a raw command or a keepalive probe
					if (res.port === undefined) this._consumeUnattributed()
					return this.emit('log', 'warn', `Device reported: ${text}`)
				}
				this._clearInflight(cmd)
				this._finish(cmd, false, 'error', text)
				return this._pump(cmd.port)
			}
			case 'device':
				this.pendingDevices.push(res)
				return
			case 'endDevices':
				this.devices = this.pendingDevices
				this.pendingDevices = []
				return this.emit('devices', this.devices, this._checkDevices())
			case 'stopped':
				return
			case 'version':
				this._consumeUnattributed()
				this.version = res.text
				return this.emit('version', this.version)
			default:
				this._consumeUnattributed()
				return this.emit('log', 'debug', `Unexpected reply from device: ${line}`)
		}
	}

	private _consumeUnattributed() {
		if (this.unattributedRequests > 0) this.unattributedRequests--
	}

	private _checkDevices() {
		const { moduleAddress } = this.options
		const found = this.devices?.find((d) => d.module === moduleAddress)
		if (!found) {
			const list = this.devices?.map((d) => `${d.module}:${d.kind}`).join(', ') || 'none'
			return `No module at address ${moduleAddress} (device reports: ${list})`
		}
		if (!/IR/.test(found.kind)) return `Module ${moduleAddress} is ${found.kind}, not an IR module`
		return null
	}

	private _inflightFor(port: number, id: number) {
		const p = this.ports.get(port)
		return p?.inflight && p.inflight.id === id ? p.inflight : null
	}

	private _inflightForError(res: DeviceError) {
		if (res.port !== undefined) return this.ports.get(res.port)?.inflight ?? null
		// Older error format without a connector. Don't charge it to an IR code when a
		// raw command or keepalive probe is also waiting for a reply.
		if (this.unattributedRequests > 0) return null
		const inflight = [...this.ports.values()].map((p) => p.inflight).filter((cmd) => cmd !== null)
		return inflight.length === 1 ? inflight[0] : null
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
		if (!this.connected || p.inflight || p.waiting) return

		const queued = p.queue.shift()
		if (!queued) {
			this.emit('queue')
			return
		}
		this._pauseExpiry(queued)

		const cmd: InflightCommand = Object.assign(queued, { id: this.nextId })
		this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1
		cmd.attempts++
		p.inflight = cmd

		const { moduleAddress, completionMargin } = this.options
		this._write(`sendir,${moduleAddress}:${port},${cmd.id},${formatIrCode(cmd.code)}`)
		this.stats.sent++

		const timeout = Math.ceil(transmitDurationMs(cmd.code)) + completionMargin
		cmd.completionTimer = setTimeout(() => {
			if (p.inflight !== cmd) return
			p.inflight = null
			this._settleUncertain(cmd, `No confirmation from device within ${timeout}ms`)
			// A missing confirmation often means a dead connection: check it now
			this._probe()
			this._pump(port)
		}, timeout)

		this._syncQueueExpiry(p)
		this.emit('queue')
	}

	private _clearInflight(cmd: InflightCommand) {
		clearTimeout(cmd.completionTimer)
		const p = this._port(cmd.port)
		if (p.inflight === cmd) p.inflight = null
	}

	private _settleUncertain(cmd: QueuedCommand, reason: string) {
		if (this.options.retryUncertain && cmd.attempts <= this.options.retries) {
			this.emit('log', 'warn', `${reason}; resending to port ${cmd.port}`)
			this._enqueue(cmd, true)
		} else {
			this._finish(cmd, false, 'uncertain', `${reason}; the code may or may not have been transmitted`)
		}
	}

	private _cancelPort(port: number, status: DeliveryStatus, reason: string) {
		const p = this.ports.get(port)
		if (!p) return
		for (const cmd of p.queue.splice(0)) this._finish(cmd, false, status, reason)
		if (p.waiting) {
			clearTimeout(p.waiting.timer)
			this._finish(p.waiting.cmd, false, status, reason)
			p.waiting = null
		}
		if (p.inflight) {
			const cmd = p.inflight
			this._clearInflight(cmd)
			this._finish(cmd, true, 'stopped')
		}
		this.emit('queue')
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
