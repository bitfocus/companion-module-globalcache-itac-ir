// Runs the built module using the real API base with a stand-in host context
// and a simulated iTach.
import test from 'node:test'
import assert from 'node:assert/strict'
import { InstanceStatus } from '@companion-module/base'
import GlobalCacheItachInstance, { UpgradeScripts } from '../dist/main.js'
import { FakeItach } from './fake-itach.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createInstance(t) {
	const host = {
		_isInstanceContext: true,
		id: 'itach-test',
		label: 'ir',
		statuses: [],
		logs: [],
		variables: {},
		updateStatus(status, message) {
			this.statuses.push({ status, message })
		},
		setVariableDefinitions(definitions) {
			this.variableDefinitions = definitions
		},
		setVariableValues(values) {
			Object.assign(this.variables, values)
		},
		checkAllFeedbacks() {},
		checkFeedbacks() {},
		setActionDefinitions(actions) {
			this.actions = actions
		},
		setFeedbackDefinitions(feedbacks) {
			this.feedbacks = feedbacks
		},
		setPresetDefinitions(structure, presets) {
			this.presetStructure = structure
			this.presets = presets
		},
	}

	const originalLogger = globalThis.COMPANION_LOGGER
	globalThis.COMPANION_LOGGER = (_source, level, message) => host.logs.push({ level, message })
	t.after(() => {
		globalThis.COMPANION_LOGGER = originalLogger
	})
	return { instance: new GlobalCacheItachInstance(host), host }
}

async function waitFor(check, timeout = 3000) {
	const start = Date.now()
	while (!check()) {
		if (Date.now() - start > timeout) throw new Error('Timed out')
		await sleep(10)
	}
}

test('instance connects, sends codes and reports results', async (t) => {
	const device = new FakeItach()
	await device.listen()
	const { instance, host } = createInstance(t)
	t.after(async () => {
		await instance.destroy()
		await device.close()
	})

	await instance.init({ host: '127.0.0.1', port: device.port, moduleAddress: 1 })
	await waitFor(() => host.variables.connection_status === 'Connected')
	assert.equal(host.statuses.at(-1).status, InstanceStatus.Ok)
	await waitFor(() => host.variables.firmware_version === '710-1005-05')
	assert.equal(host.feedbacks.connected.callback({ options: {} }), true)

	// The API 2.1 host expands variables before invoking the callback.
	assert.equal(host.actions.portSet.options.find((field) => field.id === 'ir').useVariables, true)
	await host.actions.portSet.callback({
		options: { portNum: '2', ir: 'sendir,1:1,1,38000,1,1,342,171,21,64,21,21,21,1520', repeat: 3 },
	})
	assert.match(device.sendirs()[0], /^sendir,1:2,\d+,38000,3,1,342/)
	assert.equal(host.variables.last_result, 'complete')
	assert.equal(host.variables.sent_total, 1)
	assert.equal(host.feedbacks.lastFailed.callback({ options: { portNum: 'any' } }), false)

	// An invalid code is reported and never reaches the device
	await host.actions.portSet.callback({ options: { portNum: '1', ir: '38000,1,1,342,171,21', repeat: 0 } })
	assert.equal(device.sendirs().length, 1)
	assert.equal(host.variables.last_result, 'invalid')
	assert.equal(host.variables.failed_total, 1)
	assert.match(host.variables.last_error, /on\/off pairs/)
	assert.equal(host.feedbacks.lastFailed.callback({ options: { portNum: '1' } }), true)
	assert.equal(host.feedbacks.lastFailed.callback({ options: { portNum: '2' } }), false)

	// Recovers from a dropped connection
	device.dropAll()
	await waitFor(() => host.variables.connection_status === 'Disconnected')
	assert.equal(host.statuses.at(-1).status, InstanceStatus.ConnectionFailure)
	await waitFor(() => host.variables.connection_status === 'Connected')
	assert.equal(host.variables.reconnects, 1)

	assert.equal(Object.keys(host.presets).length, 10)
	assert.deepEqual(
		host.presetStructure[0].definitions.flatMap((group) => group.presets),
		['status', 'send_1', 'hold_1', 'stop_1', 'send_2', 'hold_2', 'stop_2', 'send_3', 'hold_3', 'stop_3'],
	)
	assert.match(host.presets.status.style.text, /globalcache-itac-ir:connection_status/)
	assert.equal(host.presets.hold_1.type, 'simple')
	assert.equal(host.presets.hold_1.steps[0].down[0].actionId, 'startHold')
	assert.equal(host.presets.hold_1.steps[0].up[0].actionId, 'stopIR')
	assert.ok(host.variableDefinitions.firmware_version)
	assert.equal(UpgradeScripts.length, 2)
})

test('a module warning clears when a later connection reports an IR module', async (t) => {
	const device = new FakeItach()
	device.devices = ['device,0,0 ETHERNET', 'device,1,1 SERIAL']
	await device.listen()
	const { instance, host } = createInstance(t)
	t.after(async () => {
		await instance.destroy()
		await device.close()
	})

	await instance.init({ host: '127.0.0.1', port: device.port, moduleAddress: 1 })
	await waitFor(() => host.statuses.at(-1)?.status === InstanceStatus.UnknownWarning)

	device.devices = ['device,0,0 ETHERNET', 'device,1,3 IR']
	const seen = host.logs.length
	await host.actions.reconnect.callback()
	await waitFor(() => host.logs.slice(seen).some((entry) => entry.message.includes('1:IR(3)')))

	assert.equal(host.statuses.at(-1).status, InstanceStatus.Ok)
	assert.equal(host.variables.reconnects, 0)
	assert.ok(!host.logs.slice(seen).some((entry) => entry.message.startsWith('Disconnected')))
})

test('publishes an idle reconnect immediately and keeps discovered port choices', async (t) => {
	const device = new FakeItach()
	device.devices = ['device,0,0 ETHERNET', 'device,1,3 IR', 'device,4,2 IR']
	await device.listen()
	const { instance, host } = createInstance(t)
	t.after(async () => {
		await instance.destroy()
		await device.close()
	})
	await instance.init({ host: '127.0.0.1', port: device.port, moduleAddress: 4 })
	await waitFor(() => host.variables.connection_status === 'Connected')
	const portOption = (definition) => definition.options.find((option) => option.id === 'portNum')
	const setIrPort = portOption(host.actions.portSet)
	assert.deepEqual(
		setIrPort.choices.map((choice) => choice.id),
		['1', '2'],
	)
	assert.equal(setIrPort.allowCustom, true)
	assert.deepEqual(
		portOption(host.feedbacks.portBusy).choices.map((choice) => choice.id),
		['1', '2'],
	)
	assert.deepEqual(host.presetStructure[0].definitions[2].presets, ['send_2', 'hold_2', 'stop_2'])
	assert.equal(host.presets.send_3, undefined)

	device.dropAll()
	await waitFor(() => host.variables.connection_status === 'Disconnected')
	assert.equal(host.variables.reconnects, 1)
	assert.equal(host.variables.firmware_version, '')
	assert.equal(host.feedbacks.connected.callback({ options: {} }), false)
	assert.ok(host.presets.send_2)

	await waitFor(() => host.variables.connection_status === 'Connected')
	assert.equal(host.variables.reconnects, 1)
	assert.equal(host.variables.firmware_version, '710-1005-05')
	assert.equal(portOption(host.actions.portSet), setIrPort, 'unchanged discovery retains definitions')
	assert.equal(host.logs.filter((entry) => entry.message.startsWith('Device modules:')).length, 1)
	assert.deepEqual(device.sendirs(), [])
})

test('learns into both IR actions and publishes the actual connector modes', async (t) => {
	const device = new FakeItach()
	device.portModes = { '1:2': 'SENSOR', '1:3': 'IR_BLASTER' }
	device.learnedCode = 'sendir,1:1,1,38000,1,1,342,171,21,64'
	await device.listen()
	const { instance, host } = createInstance(t)
	t.after(async () => {
		await instance.destroy()
		await device.close()
	})

	assert.equal(
		instance.getConfigFields().some((field) => field.id === 'port'),
		false,
	)
	await instance.init({ host: '127.0.0.1', port: device.port })
	await waitFor(() => host.variables.connection_status === 'Connected')
	assert.ok(host.variableDefinitions.port_1_mode)
	assert.equal(host.variables.port_1_mode, 'IR')
	assert.equal(host.variables.port_2_mode, 'SENSOR')
	assert.equal(host.variables.port_3_mode, 'IR_BLASTER')
	const sensorSend = await instance.client.sendIR(2, {
		frequency: 38000,
		repeat: 1,
		offset: 1,
		pulses: [342, 171],
	})
	assert.equal(sensorSend.status, 'rejected')
	assert.match(sensorSend.error, /SENSOR mode/)
	assert.deepEqual(device.sendirs(), [])

	const context = { signal: new AbortController().signal }
	const action = { options: { portNum: '3', repeat: 4, ir: 'previous code' } }
	for (const { learn } of [host.actions.portSet, host.actions.startHold]) {
		assert.deepEqual(await learn(action, context), { ir: '38000,1,1,342,171,21,64' })
	}
	await waitFor(() => device.received.filter((line) => line === 'stop_IRL').length === 2)
	assert.deepEqual(device.sendirs(), [])
	device.dropAll()
	await waitFor(() => host.variables.connection_status === 'Disconnected')
	assert.equal(host.variables.port_2_mode, '')
})

test('instance without an IP address reports bad config', async (t) => {
	const { instance, host } = createInstance(t)
	t.after(() => instance.destroy())

	await instance.init({ host: '' })
	assert.equal(host.statuses.at(-1).status, InstanceStatus.BadConfig)
	const before = host.logs.length
	await host.actions.portSet.callback({ options: { portNum: '1', ir: '38000,1,1,342,171', repeat: 0 } })
	assert.equal(host.variables.last_result, 'rejected')
	assert.ok(host.logs.length > before)
})
