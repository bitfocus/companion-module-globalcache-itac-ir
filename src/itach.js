// Connection and IR delivery engine for Global Caché devices.
//
// Kept free of any Companion dependency so it can be tested against a fake
// device (see test/). The Companion instance in index.js wires its events to
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
//   - Commands that cannot be started within maxCommandAge (e.g. while the
//     device is offline) are discarded rather than fired late.
//   - The connection is watched with a keepalive probe, so a device that loses
//     power or network without closing the socket is detected and reconnected.

const net = require('net')
const { EventEmitter } = require('events')
const { parseResponse, LineSplitter } = require('./protocol')
const { formatIrCode, transmitDurationMs } = require('./ircode')

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

class ItachClient extends EventEmitter {
	constructor(options) {
		super()
		this.options = { ...DEFAULTS, ...options }
		this.state = 'idle'
		this.running = false
		this.socket = null
		this.splitter = new LineSplitter()
		this.ports = new Map()
		this.nextId = 1
		this.reconnectDelay = this.options.reconnectMin
		this.reconnectTimer = null
		this.connectTimer = null
		this.tickTimer = null
		this.lastRx = 0
		this.probe = null
		this.versionRequests = 0
		this.pendingDevices = []
		this.devices = null
		this.version = ''
		this.stats = { sent: 0, completed: 0, failed: 0, reconnects: 0 }
	}

	// ---------------------------------------------------------------- lifecycle

	start() {
		if (this.running) return
		this.running = true
		this._connect()
	}

	stop() {
		this.running = false
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		if (this.socket) this._dropConnection(this.socket, 'Stopped')
		for (const port of this.ports.keys()) this._cancelPort(port, 'cancelled', 'Connection closed')
		this._setState('idle')
	}

	/** Drop the current connection (if any) and connect again straight away */
	reconnect(reason = 'Manual reconnect') {
		if (!this.running) return
		if (this.socket) this._dropConnection(this.socket, reason)
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		this.reconnectDelay = this.options.reconnectMin
		this._connect()
	}

	get connected() {
		return this.state === 'connected'
	}

	// ----------------------------------------------------------------- commands

	/**
	 * Queue an IR code for transmission. Resolves (never rejects) once the
	 * outcome is known: { ok, status, error?, attempts, latencyMs }
	 *   status: complete | stopped | busy | error | uncertain | expired | cancelled | rejected
	 */
	sendIR(port, code) {
		return new Promise((resolve) => {
			const cmd = { port, code, enqueuedAt: Date.now(), attempts: 0, resolve, done: false }

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
	stopIR(port) {
		this._cancelPort(port, 'cancelled', 'Cancelled by Stop IR')
		if (!this.connected) return false
		this._write(`stopir,${this.options.moduleAddress}:${port}`)
		return true
	}

	/** Discard every queued (not yet transmitting) command */
	clearQueue() {
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
	sendRaw(line) {
		if (!this.connected) return false
		if (/^getversion$/i.test(line)) this.versionRequests++
		this._write(line)
		return true
	}

	queueDepth(port) {
		if (port !== undefined) {
			const p = this.ports.get(port)
			return p ? this._depth(p) : 0
		}
		let total = 0
		for (const p of this.ports.values()) total += this._depth(p)
		return total
	}

	isPortBusy(port) {
		return this.queueDepth(port) > 0
	}

	// --------------------------------------------------------------- connection

	_connect() {
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null

		const { host, port, connectTimeout } = this.options
		this._setState('connecting', `Connecting to ${host}:${port}`)

		const socket = new net.Socket()
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
			this.versionRequests = 0
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

	_dropConnection(socket, reason) {
		if (socket !== this.socket) return
		const wasConnected = this.connected

		this.socket = null
		clearTimeout(this.connectTimer)
		clearInterval(this.tickTimer)
		this.tickTimer = null
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
		}

		if (!this.running) return

		if (wasConnected) this.stats.reconnects++
		this._setState('disconnected', reason)

		const delay = this.reconnectDelay
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMax)
		this.reconnectTimer = setTimeout(() => this._connect(), delay)
	}

	_identify() {
		// getversion doubles as the first health probe: a device that accepts the
		// TCP connection but never answers is treated as offline
		this._probe()
		this._write('getdevices')
	}

	_probe() {
		if (!this.connected || this.probe) return
		this.probe = { sentAt: Date.now() }
		this.versionRequests++
		this._write('getversion')
	}

	_tick() {
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

	_write(line) {
		if (!this.socket) return false
		this.socket.write(line + '\r')
		return true
	}

	_setState(state, message) {
		if (this.state === state && this.stateMessage === message) return
		this.state = state
		this.stateMessage = message
		this.emit('state', state, message)
	}

	// ---------------------------------------------------------------- responses

	_handleLine(line) {
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
							p.waiting = null
							this._enqueue(cmd, true)
							this._pump(cmd.port)
						}, delay),
					}
				} else {
					this._finish(cmd, false, 'busy', `Port ${cmd.port} stayed busy after ${cmd.attempts} attempts`)
					this._pump(cmd.port)
				}
				return
			}
			case 'error': {
				const cmd = this._inflightForError(res)
				const text = `${res.message} (ERR ${String(res.code).padStart(3, '0')})`
				if (!cmd) return this.emit('log', 'warn', `Device reported: ${text}`)
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
			default:
				if (this.versionRequests > 0) {
					this.versionRequests--
					// GC-100 answers "version,0,3.0-12", iTach answers "710-1005-05"
					this.version = res.text.replace(/^version,\d+,/i, '')
					return this.emit('version', this.version)
				}
				return this.emit('log', 'debug', `Unexpected reply from device: ${line}`)
		}
	}

	_checkDevices() {
		const { moduleAddress } = this.options
		const found = this.devices.find((d) => d.module === moduleAddress)
		if (!found) {
			const list = this.devices.map((d) => `${d.module}:${d.kind}`).join(', ') || 'none'
			return `No module at address ${moduleAddress} (device reports: ${list})`
		}
		if (!/IR/.test(found.kind)) return `Module ${moduleAddress} is ${found.kind}, not an IR module`
		return null
	}

	_inflightFor(port, id) {
		const p = this.ports.get(port)
		return p?.inflight && p.inflight.id === id ? p.inflight : null
	}

	_inflightForError(res) {
		if (res.port !== undefined) return this.ports.get(res.port)?.inflight ?? null
		// Older error format without a connector: only attributable when a single command is in flight
		const inflight = [...this.ports.values()].filter((p) => p.inflight).map((p) => p.inflight)
		return inflight.length === 1 ? inflight[0] : null
	}

	// -------------------------------------------------------------------- queue

	_port(port) {
		let p = this.ports.get(port)
		if (!p) {
			p = { queue: [], inflight: null, waiting: null }
			this.ports.set(port, p)
		}
		return p
	}

	_depth(p) {
		return p.queue.length + (p.inflight ? 1 : 0) + (p.waiting ? 1 : 0)
	}

	/** Queue a command, discarding it if it cannot start within maxCommandAge of the original press */
	_enqueue(cmd, front) {
		const p = this._port(cmd.port)
		const remaining = this.options.maxCommandAge - (Date.now() - cmd.enqueuedAt)
		if (remaining <= 0) return this._expire(cmd)

		cmd.expiryTimer = setTimeout(() => {
			const index = p.queue.indexOf(cmd)
			if (index === -1) return
			p.queue.splice(index, 1)
			this._expire(cmd)
		}, remaining)

		if (front) p.queue.unshift(cmd)
		else p.queue.push(cmd)
		this.emit('queue')
	}

	_expire(cmd) {
		const reason = this.connected ? 'port was busy' : 'device offline'
		this._finish(
			cmd,
			false,
			'expired',
			`Discarded: could not start within ${this.options.maxCommandAge / 1000}s (${reason})`,
		)
	}

	_pump(port) {
		const p = this._port(port)
		if (!this.connected || p.inflight || p.waiting) return

		const cmd = p.queue.shift()
		if (!cmd) return this.emit('queue')
		clearTimeout(cmd.expiryTimer)

		cmd.id = this.nextId
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

		this.emit('queue')
	}

	_clearInflight(cmd) {
		clearTimeout(cmd.completionTimer)
		const p = this._port(cmd.port)
		if (p.inflight === cmd) p.inflight = null
	}

	_settleUncertain(cmd, reason) {
		if (this.options.retryUncertain && cmd.attempts <= this.options.retries) {
			this.emit('log', 'warn', `${reason}; resending to port ${cmd.port}`)
			this._enqueue(cmd, true)
		} else {
			this._finish(cmd, false, 'uncertain', `${reason}; the code may or may not have been transmitted`)
		}
	}

	_cancelPort(port, status, reason) {
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

	_finish(cmd, ok, status, error) {
		if (cmd.done) return
		cmd.done = true
		clearTimeout(cmd.expiryTimer)
		clearTimeout(cmd.completionTimer)

		if (status === 'complete') this.stats.completed++
		else if (!ok && status !== 'cancelled') this.stats.failed++

		const result = {
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

module.exports = { ItachClient, DEFAULTS }
