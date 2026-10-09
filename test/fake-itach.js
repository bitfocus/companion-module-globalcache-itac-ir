// A minimal stand-in for an iTach IP2IR, used to exercise failure modes that
// are hard to reproduce with real hardware on demand.

const net = require('net')

class FakeItach {
	constructor() {
		this.received = []
		this.sockets = new Set()
		// Behaviour switches, changed by tests
		this.silent = false // accept connections but never answer (half-open / hung device)
		this.transmitMs = 20 // how long a sendir takes before completeir
		this.busyCount = 0 // answer the next N sendir with busyIR
		this.errorCode = null // answer sendir with ERR_1:<port>,<code>
		this.swallowSendir = false // never confirm sendir
		this.devices = ['device,0,0 ETHERNET', 'device,1,3 IR']
		this.timers = new Set()
	}

	listen(port = 0) {
		this.server = net.createServer((socket) => this._accept(socket))
		return new Promise((resolve) => {
			this.server.listen(port, '127.0.0.1', () => {
				this.port = this.server.address().port
				resolve(this.port)
			})
		})
	}

	_accept(socket) {
		this.sockets.add(socket)
		socket.on('close', () => this.sockets.delete(socket))
		socket.on('error', () => {})
		let buffer = ''
		socket.on('data', (chunk) => {
			buffer += chunk.toString()
			const lines = buffer.split('\r')
			buffer = lines.pop()
			for (const line of lines) this._handle(socket, line)
		})
	}

	_later(ms, fn) {
		const t = setTimeout(() => {
			this.timers.delete(t)
			fn()
		}, ms)
		this.timers.add(t)
	}

	_reply(socket, line) {
		if (!socket.destroyed) socket.write(line + '\r')
	}

	_handle(socket, line) {
		this.received.push(line)
		if (this.silent) return

		if (line === 'getversion') return this._reply(socket, '710-1005-05')
		if (line === 'getdevices') {
			for (const d of this.devices) this._reply(socket, d)
			return this._reply(socket, 'endlistdevices')
		}

		let m
		if ((m = line.match(/^sendir,(\d+):(\d+),(\d+),/))) {
			const [, mod, port, id] = m
			if (this.busyCount > 0) {
				this.busyCount--
				return this._reply(socket, `busyIR,${mod}:${port},${id}`)
			}
			if (this.errorCode !== null) return this._reply(socket, `ERR_${mod}:${port},${this.errorCode}`)
			if (this.swallowSendir) return
			return this._later(this.transmitMs, () => this._reply(socket, `completeir,${mod}:${port},${id}`))
		}
		if ((m = line.match(/^stopir,(\d+):(\d+)$/))) return this._reply(socket, line)

		this._reply(socket, 'ERR_01')
	}

	sendirs() {
		return this.received.filter((l) => l.startsWith('sendir'))
	}

	/** Simulate a reboot or cable pull: drop every open connection */
	dropAll() {
		for (const s of this.sockets) s.destroy()
	}

	async close() {
		for (const t of this.timers) clearTimeout(t)
		this.dropAll()
		await new Promise((resolve) => this.server.close(resolve))
	}
}

module.exports = { FakeItach }
