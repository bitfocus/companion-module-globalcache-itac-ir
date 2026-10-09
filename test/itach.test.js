const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { ItachClient } = require('../src/itach')
const { parseIrCode } = require('../src/ircode')
const { FakeItach } = require('./fake-itach')

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

test('rejects new codes when a port queue is full', async (t) => {
	const { device, client } = await setup(t, { maxQueuePerPort: 2 })
	device.swallowSendir = true

	client.sendIR(1, CODE)
	client.sendIR(1, CODE)
	const result = await client.sendIR(1, CODE)
	assert.equal(result.status, 'rejected')
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
