import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { ItachClient } from '../dist/itach.js'
import { parseIrCode } from '../dist/ircode.js'
import { FakeItach } from './fake-itach.js'

const CODE = parseIrCode('38000,1,1,342,171,21,64,21,21,21,1520')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Short timings so failure scenarios run in milliseconds
const FAST = {
	connectTimeout: 500,
	reconnectMin: 50,
	reconnectMax: 200,
	keepaliveInterval: 0,
	responseTimeout: 200,
	completionMargin: 150,
	maxCommandAge: 1500,
	busyRetryDelay: 20,
	tickInterval: 20,
}

async function waitForState(client, state) {
	while (client.state !== state) await once(client, 'state')
}

async function waitFor(check, timeout = 2000) {
	const started = Date.now()
	while (!check()) {
		if (Date.now() - started >= timeout) assert.fail('Timed out waiting for the test device')
		await sleep(5)
	}
}

async function setup(t, options = {}) {
	const device = new FakeItach()
	await device.listen()
	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port, ...options })
	client.on('error', () => {})
	t.after(async () => {
		client.stop()
		await device.close().catch(() => {})
	})
	client.start()
	await waitForState(client, 'connected')
	return { device, client }
}

test('sends a code and resolves once the device confirms it', async (t) => {
	const { device, client } = await setup(t)
	const result = await client.sendIR(2, CODE)

	assert.equal(result.ok, true)
	assert.equal(result.status, 'complete')
	assert.match(device.sendirs()[0], /^sendir,1:2,\d+,38000,1,1,342,171,21,64,21,21,21,1520$/)
	assert.equal(client.stats.completed, 1)
})

test('identifies the device on connect', async (t) => {
	const device = new FakeItach()
	await device.listen()
	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port })
	t.after(async () => {
		client.stop()
		await device.close()
	})
	const devices = once(client, 'devices')
	const version = once(client, 'version')
	client.start()

	assert.equal((await version)[0], '710-1005-05')
	const [list, problem] = await devices
	assert.equal(list.length, 2)
	assert.equal(problem, null)
})

test('holds the queue until device discovery completes', { timeout: 4000 }, async (t) => {
	const device = new FakeItach()
	device.ignoreDeviceList = true
	await device.listen()
	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port, responseTimeout: 1000 })
	t.after(async () => {
		client.stop()
		await device.close()
	})
	const version = once(client, 'version')
	client.start()
	await version
	const pending = client.sendIR(1, CODE)

	assert.equal(client.state, 'connecting')
	assert.equal(device.sendirs().length, 0)
	device._replyWithDevices([...device.sockets][0])
	assert.equal((await pending).status, 'complete')
	assert.equal(device.sendirs().length, 1)
})

test(
	'falls back to configured ports when firmware answers but the device list is unavailable',
	{ timeout: 4000 },
	async (t) => {
		const device = new FakeItach()
		device.ignoreDeviceList = true
		await device.listen()
		const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port })
		t.after(async () => {
			client.stop()
			await device.close()
		})
		client.start()

		const result = await client.sendIR(1, CODE)
		assert.equal(result.status, 'complete')
		assert.equal(client.version, '710-1005-05')
		assert.equal(client.devices, null)
		assert.equal(device.sendirs().length, 1)
	},
)

test('a silent TCP connection leaves queued IR for the next responsive connection', { timeout: 4000 }, async (t) => {
	const { device, client } = await setup(t)
	device.silent = true
	device.dropAll()
	await waitForState(client, 'disconnected')
	const pending = client.sendIR(1, CODE)
	await waitForState(client, 'connecting')
	await waitForState(client, 'disconnected')
	assert.equal(device.sendirs().length, 0)
	assert.equal(client.queueDepth(), 1)

	device.silent = false
	assert.equal((await pending).status, 'complete')
	assert.equal(device.sendirs().length, 1)
})

test(
	'discovery cannot send a queued code past its deadline before the expiry timer runs',
	{ timeout: 4000 },
	async (t) => {
		const device = new FakeItach()
		device.ignoreDeviceList = true
		await device.listen()
		const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port, responseTimeout: 2000 })
		t.after(async () => {
			client.stop()
			await device.close()
		})
		const version = once(client, 'version')
		client.start()
		await version
		const now = Date.now()
		const clock = t.mock.method(Date, 'now', () => now)
		const pending = client.sendIR(1, CODE)
		clock.mock.mockImplementation(() => now + FAST.maxCommandAge + 1)
		device._replyWithDevices([...device.sockets][0])

		assert.equal((await pending).status, 'expired')
		assert.equal(device.sendirs().length, 0)
	},
)

test('warns when there is no IR module at the configured address', async (t) => {
	const device = new FakeItach()
	device.devices = ['device,0,0 ETHERNET', 'device,1,1 SERIAL']
	await device.listen()
	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port })
	t.after(async () => {
		client.stop()
		await device.close()
	})
	const devices = once(client, 'devices')
	client.start()
	const [, problem] = await devices
	assert.match(problem, /SERIAL, not an IR module/)
})

test('codes on the same port wait for the previous one to finish', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	client.sendIR(1, CODE)
	client.sendIR(1, CODE)
	await sleep(50)
	assert.equal(device.sendirs().length, 1, 'second code must not interrupt the first')
	assert.equal(client.queueDepth(1), 2)
})

test('different ports transmit independently', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	client.sendIR(1, CODE)
	client.sendIR(2, CODE)
	await sleep(50)
	assert.equal(device.sendirs().length, 2)
})

test('a burst of presses is delivered in order without loss', async (t) => {
	const { device, client } = await setup(t)
	device.transmitMs = 5

	const results = await Promise.all(Array.from({ length: 10 }, () => client.sendIR(1, CODE)))
	assert.ok(results.every((r) => r.ok))
	const ids = device.sendirs().map((l) => Number(l.split(',')[2]))
	assert.deepEqual(
		ids,
		[...ids].sort((a, b) => a - b),
	)
	assert.equal(ids.length, 10)
})

test('retries when the port is busy', async (t) => {
	const { device, client } = await setup(t, { retries: 3 })
	device.busyCount = 2

	const result = await client.sendIR(1, CODE)
	assert.equal(result.ok, true)
	assert.equal(result.attempts, 3)
})

test('gives up after the configured busy retries', async (t) => {
	const { device, client } = await setup(t, { retries: 2 })
	device.busyCount = 10

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'busy')
	assert.equal(device.sendirs().length, 3)
})

test('reports device errors without retrying', async (t) => {
	const { device, client } = await setup(t)
	device.errorCode = '008'

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'error')
	assert.match(result.error, /Invalid pulse count \(ERR 008\)/)
	assert.equal(device.sendirs().length, 1)
})

test('reconnects after the device drops the connection', async (t) => {
	const { device, client } = await setup(t)

	device.dropAll()
	await waitForState(client, 'disconnected')
	await waitForState(client, 'connected')

	const result = await client.sendIR(1, CODE)
	assert.equal(result.ok, true)
	assert.equal(client.stats.reconnects, 1)
})

test('codes pressed while offline are sent when the device comes back in time', async (t) => {
	const { device, client } = await setup(t)
	const port = device.port

	await device.close()
	await waitForState(client, 'disconnected')
	const pending = client.sendIR(1, CODE)

	const revived = new FakeItach()
	await revived.listen(port)
	t.after(() => revived.close())

	const result = await pending
	assert.equal(result.ok, true)
	assert.equal(revived.sendirs().length, 1)
})

test('codes are discarded, not fired late, when the device stays offline', async (t) => {
	const { device, client } = await setup(t, { maxCommandAge: 200 })
	const port = device.port

	await device.close()
	await waitForState(client, 'disconnected')
	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'expired')
	assert.match(result.error, /device offline/)

	const revived = new FakeItach()
	await revived.listen(port)
	t.after(() => revived.close())
	await waitForState(client, 'connected')
	await sleep(50)
	assert.equal(revived.sendirs().length, 0)
})

test('detects a device that stops responding without closing the connection', async (t) => {
	const { device, client } = await setup(t, { keepaliveInterval: 100 })

	device.silent = true
	await waitForState(client, 'disconnected')
	assert.match(client.stateMessage, /stopped responding/)

	device.silent = false
	await waitForState(client, 'connected')
})

test('an unconfirmed code is not resent by default (toggle safety)', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'uncertain')
	assert.equal(device.sendirs().length, 1)
})

test('an unconfirmed code is resent when retryUncertain is enabled', async (t) => {
	const { device, client } = await setup(t, { retryUncertain: true, retries: 1 })
	device.swallowSendir = true

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'uncertain')
	assert.equal(device.sendirs().length, 2)
})

test('a missing confirmation triggers a connection check', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	await client.sendIR(1, CODE)
	device.silent = true
	await waitForState(client, 'disconnected')
})

test('Stop IR cancels queued codes and stops the port', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	const first = client.sendIR(1, CODE)
	const second = client.sendIR(1, CODE)
	await sleep(20)
	assert.equal(client.stopIR(1), true)

	assert.equal((await first).status, 'stopped')
	assert.equal((await second).status, 'cancelled')
	await sleep(20)
	assert.ok(device.received.includes('stopir,1:1'))
	assert.equal(client.queueDepth(), 0)
})

test('Stop IR waits for the device acknowledgement and gates later sends', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true
	device.stopDelayMs = 100
	let stopped
	const active = client.sendIR(1, CODE).then((result) => {
		stopped = result
		return result
	})
	await waitFor(() => device.sendirs().length === 1)

	assert.equal(client.stopIR(1), true)
	device.swallowSendir = false
	const next = client.sendIR(1, CODE)
	await waitFor(() => device.received.includes('stopir,1:1'))
	assert.equal(stopped, undefined)
	assert.equal(device.sendirs().length, 1)
	assert.equal((await active).status, 'stopped')
	assert.equal((await next).status, 'complete')
	assert.equal(device.sendirs().length, 2)
})

test('an external stop acknowledgement settles the active send and advances its port queue', async (t) => {
	const { device, client } = await setup(t, { retryUncertain: true })
	device.swallowSendir = true
	const active = client.sendIR(1, CODE)
	const next = client.sendIR(1, CODE)
	await waitFor(() => device.sendirs().length === 1)
	device.swallowSendir = false
	device._reply([...device.sockets][0], 'stopir,1:1')

	assert.equal((await active).status, 'stopped')
	assert.equal((await next).status, 'complete')
	assert.equal(device.sendirs().length, 2)
})

test('an unacknowledged local stop never retransmits the interrupted code', async (t) => {
	const { device, client } = await setup(t, { retryUncertain: true })
	device.swallowSendir = true
	device.ignoreStop = true
	const active = client.sendIR(1, CODE)
	await waitFor(() => device.sendirs().length === 1)
	assert.equal(client.stopIR(1), true)

	const result = await active
	assert.equal(result.status, 'uncertain')
	assert.match(result.error, /Stop IR was not acknowledged/)
	await waitForState(client, 'connected')
	assert.equal(device.sendirs().length, 1)
})

test('a hold refreshes the same short burst and stops refreshing on release', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true
	const settled = once(client, 'result')
	client.startHold(1, parseIrCode('38000,1,1,4,950'))
	await waitFor(() => device.sendirs().length >= 3)
	const frames = device.sendirs()
	assert.equal(new Set(frames).size, 1)
	assert.match(frames[0], /^sendir,1:1,\d+,38000,3,1,4,950$/)

	assert.equal(client.stopIR(1), true)
	assert.equal((await settled)[0].status, 'stopped')
	const count = device.sendirs().length
	await sleep(125)
	assert.equal(device.sendirs().length, count)
})

test('a completed burst leaves the hold pending until the stop is acknowledged', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true
	device.stopDelayMs = 100
	const results = []
	client.on('result', (result) => results.push(result))
	client.startHold(1, parseIrCode('38000,1,1,4,950'))
	await waitFor(() => device.sendirs().length === 1)
	assert.equal(client.stopIR(1), true)
	await waitFor(() => device.received.includes('stopir,1:1'))

	const id = device.sendirs()[0].split(',')[2]
	device._reply([...device.sockets][0], `completeir,1:1,${id}`)
	await sleep(20)
	assert.deepEqual(results, [])
	await waitFor(() => results.length === 1)
	assert.equal(results[0].status, 'stopped')
	assert.equal(client.queueDepth(), 0)
})

test(
	'a hold ends after a silent connection times out and stays ended after reconnect',
	{ timeout: 4000 },
	async (t) => {
		const { device, client } = await setup(t, { retryUncertain: true })
		device.swallowSendir = true
		const settled = once(client, 'result')
		client.startHold(1, parseIrCode('38000,1,1,4,950'))
		await waitFor(() => device.sendirs().length >= 2)
		device.silent = true
		await waitForState(client, 'disconnected')
		assert.equal((await settled)[0].status, 'uncertain')
		const count = device.sendirs().length
		device.silent = false
		await waitForState(client, 'connected')
		await sleep(125)
		assert.equal(device.sendirs().length, count)
	},
)

test('the documented invalid module error settles all affected sends without retrying', async (t) => {
	const { device, client } = await setup(t, { moduleAddress: 5, retryUncertain: true })
	device.swallowSendir = true
	const first = client.sendIR(1, CODE)
	const second = client.sendIR(2, CODE)
	await waitFor(() => device.sendirs().length === 2)
	device._reply([...device.sockets][0], 'ERR_0:0,002')

	for (const result of await Promise.all([first, second])) {
		assert.equal(result.status, 'error')
		assert.match(result.error, /Invalid module address/)
	}
	assert.equal(device.sendirs().length, 2)
})

test('an addressed raw-command error cannot settle a managed send on the same port', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true
	device.rawReplies['set_IR,1:1,IR_BLASTER'] = 'ERR_1:1,014'
	const pending = client.sendIR(1, CODE)
	await waitFor(() => device.sendirs().length === 1)
	const rawReply = once(client, 'log')
	assert.equal(client.sendRaw('set_IR,1:1,IR_BLASTER'), true)
	assert.match((await rawReply)[1], /Raw command reply: ERR_1:1,014/)
	assert.equal(device.sockets.size, 2)
	const id = device.sendirs()[0].split(',')[2]
	device._reply([...device.sockets][0], `completeir,1:1,${id}`)
	assert.equal((await pending).status, 'complete')
})

test('rejects new codes when a port queue is full', async (t) => {
	const { device, client } = await setup(t, { maxQueuePerPort: 2 })
	device.swallowSendir = true

	client.sendIR(1, CODE)
	client.sendIR(1, CODE)
	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'rejected')
})

test('codes waiting behind one already sending are not discarded', async (t) => {
	const { device, client } = await setup(t, { maxCommandAge: 80 })
	device.transmitMs = 120

	const results = await Promise.all([client.sendIR(1, CODE), client.sendIR(1, CODE), client.sendIR(1, CODE)])
	assert.ok(results.every((r) => r.status === 'complete'))
	assert.equal(device.sendirs().length, 3)
})

test('a code expires when the port stays busy past the discard limit', async (t) => {
	const { device, client } = await setup(t, { maxCommandAge: 250, retries: 10, busyRetryDelay: 40 })
	device.busyCount = 20

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'expired')
	assert.match(result.error, /port was busy/)
})

test('clearQueue discards codes that have not started', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	const inflight = client.sendIR(1, CODE)
	const queued = client.sendIR(1, CODE)
	await sleep(20)
	client.clearQueue()

	assert.equal((await queued).status, 'cancelled')
	assert.equal(client.queueDepth(), 1)
	assert.equal(client.stopIR(1), true)
	assert.equal((await inflight).status, 'stopped')
})

test('Stop IR cancels a code waiting to retry a busy port', async (t) => {
	const { device, client } = await setup(t, { retries: 5, busyRetryDelay: 500 })
	device.busyCount = 5

	const retrying = once(client, 'log')
	const pending = client.sendIR(1, CODE)
	await retrying
	assert.equal(client.stopIR(1), true)

	assert.equal((await pending).status, 'cancelled')
	await sleep(30)
	assert.equal(device.sendirs().length, 1)
})

test('stop settles a code that is still in flight', async (t) => {
	const { device, client } = await setup(t)
	device.swallowSendir = true

	const pending = client.sendIR(1, CODE)
	await sleep(20)
	client.stop()
	// The socket is gone, so the code may already have been transmitted
	assert.equal((await pending).status, 'uncertain')
})

test('resends after the connection drops when retryUncertain is enabled', async (t) => {
	const { device, client } = await setup(t, { retryUncertain: true, retries: 2 })
	device.swallowSendir = true

	const pending = client.sendIR(1, CODE)
	await sleep(30)
	assert.equal(device.sendirs().length, 1)
	device.swallowSendir = false
	device.dropAll()

	const result = await pending
	assert.equal(result.ok, true)
	assert.equal(result.attempts, 2)
})

test('a port-less error fails the single code in flight', async (t) => {
	const { device, client } = await setup(t)
	while (client.unattributedRequests > 0) await sleep(10)
	device.portlessError = true
	device.errorCode = '008'

	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'error')
	assert.match(result.error, /Invalid pulse count/)
})

test('a port-less error from a raw command does not fail the code in flight', async (t) => {
	const { device, client } = await setup(t)
	while (client.unattributedRequests > 0) await sleep(10)
	device.swallowSendir = true

	let settled
	const pending = client.sendIR(1, CODE).then((result) => {
		settled = result
		return result
	})
	await sleep(20)
	assert.equal(client.sendRaw('no-such-command'), true)
	await sleep(30)
	assert.equal(settled, undefined, 'the raw command error must not fail the IR code')

	assert.equal(client.stopIR(1), true)
	assert.equal((await pending).status, 'stopped')
})

test('GC-100 uses an idle primary connection with a response fence for raw commands', async (t) => {
	const device = new FakeItach()
	device.firmwareReply = 'version,0,3.0-12'
	device.rawReplies['get_IR,1:1'] = 'unknowncommand 21'
	await device.listen()
	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port: device.port })
	t.after(async () => {
		client.stop()
		await device.close()
	})
	client.start()
	await waitForState(client, 'connected')

	const raw = once(client, 'log')
	assert.equal(client.sendRaw('get_IR,1:1'), true)
	const pending = client.sendIR(1, CODE)
	assert.match((await raw)[1], /Raw command reply: unknowncommand 21/)
	assert.equal((await pending).status, 'complete')
	assert.equal(device.sockets.size, 1)
	assert.deepEqual(device.received.slice(2, 4), ['get_IR,1:1', 'getversion,0'])

	device.swallowSendir = true
	const active = client.sendIR(1, CODE)
	await waitFor(() => device.sendirs().length === 2)
	assert.equal(client.sendRaw('get_IR,1:1'), false)
	const id = device.sendirs()[1].split(',')[2]
	device._reply([...device.sockets][0], `completeir,1:1,${id}`)
	assert.equal((await active).status, 'complete')
})

test('a raw command reply is not stored as the firmware version', async (t) => {
	const { device, client } = await setup(t, { keepaliveInterval: 40 })
	assert.equal(client.version, '710-1005-05')
	const versions = []
	client.on('version', (version) => versions.push(version))
	device.rawReplies['get_IR,1:1'] = 'IR,1:1,IR'

	assert.equal(client.sendRaw('get_IR,1:1'), true)
	await sleep(100)
	assert.ok(device.received.filter((line) => line === 'getversion').length > 1)
	assert.deepEqual(versions, [], 'unchanged firmware replies do not publish another update')
	assert.equal(client.version, '710-1005-05')
})

test('cancels a learn on its socket and resumes the managed queue', async (t) => {
	const { device, client } = await setup(t, { keepaliveInterval: 30 })
	const controller = new AbortController()
	const learned = client.learnIR(controller.signal)
	await waitFor(() => device.received.includes('get_IRL'))
	await assert.rejects(client.learnIR(controller.signal), /already in progress/)
	const count = device.received.filter((line) => line === 'getversion').length
	const queued = client.sendIR(1, CODE)
	await sleep(80)
	assert.equal(device.sendirs().length, 0)
	assert.equal(device.received.filter((line) => line === 'getversion').length, count)
	controller.abort()
	await assert.rejects(learned, /cancelled/)
	assert.equal((await queued).status, 'complete')
	await waitFor(() => device.received.includes('stop_IRL'))
})

test('reports an unavailable learner and leaves ordinary delivery usable', async (t) => {
	const { device, client } = await setup(t)
	device.learnerUnavailable = true
	await assert.rejects(client.learnIR(new AbortController().signal), /IR learner is unavailable.*LED lighting/)
	assert.equal((await client.sendIR(1, CODE)).status, 'complete')
})

test('a manual reconnect is not counted or reported as a failure', async (t) => {
	const { client } = await setup(t)
	const states = []
	client.on('state', (state) => states.push(state))

	client.reconnect('Reconnect requested')
	await waitForState(client, 'connected')

	assert.deepEqual(states, ['connecting', 'connected'])
	assert.equal(client.stats.reconnects, 0)
})

test('keeps retrying with back-off while the device is unreachable', async (t) => {
	const device = new FakeItach()
	const port = await device.listen()
	await device.close()

	const client = new ItachClient({ ...FAST, host: '127.0.0.1', port })
	t.after(() => client.stop())
	const failures = []
	client.on('state', (state) => state === 'disconnected' && failures.push(Date.now()))
	client.start()
	while (failures.length < 4) await once(client, 'state')

	const revived = new FakeItach()
	await revived.listen(port)
	t.after(() => revived.close())
	await waitForState(client, 'connected')
	assert.equal(client.reconnectDelay, FAST.reconnectMin, 'back-off resets after a good connection')
})
