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
		['status', 'send_1', 'send_2', 'send_3', 'hold_1', 'hold_2', 'hold_3', 'stop_1', 'stop_2', 'stop_3'],
	)
	assert.equal(host.presets.hold_1.type, 'simple')
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
