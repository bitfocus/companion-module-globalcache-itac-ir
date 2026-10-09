// Runs the Companion instance (index.js) against the simulated device with a
// stand-in for the Companion host, to check actions, feedbacks, variables and
// status are wired up correctly.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const base = require('@companion-module/base')
const { FakeItach } = require('./fake-itach')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class StubInstanceBase {
	constructor() {
		this.label = 'ir'
		this.statuses = []
		this.logs = []
		this.variables = {}
	}
	log(level, message) {
		this.logs.push({ level, message })
	}
	updateStatus(status, message) {
		this.statuses.push({ status, message })
	}
	setVariableDefinitions() {}
	setVariableValues(values) {
		Object.assign(this.variables, values)
	}
	checkFeedbacks() {}
	setActionDefinitions(actions) {
		this.actions = actions
	}
	setFeedbackDefinitions(feedbacks) {
		this.feedbacks = feedbacks
	}
	setPresetDefinitions(presets) {
		this.presets = presets
	}
	async parseVariablesInString(text) {
		return text.replace('$(internal:custom_code)', '38000,1,1,342,171,21,64,21,21,21,1520')
	}
}

function loadInstanceClass() {
	let InstanceClass
	const originalLoad = Module._load
	Module._load = function (request, ...rest) {
		if (request === '@companion-module/base') {
			return {
				...base,
				InstanceBase: StubInstanceBase,
				runEntrypoint: (cls) => {
					InstanceClass = cls
				},
			}
		}
		return originalLoad.call(this, request, ...rest)
	}
	try {
		delete require.cache[require.resolve('../index.js')]
		require('../index.js')
	} finally {
		Module._load = originalLoad
	}
	return InstanceClass
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
	const Instance = loadInstanceClass()
	const instance = new Instance({})
	t.after(async () => {
		await instance.destroy()
		await device.close()
	})

	await instance.init({ host: '127.0.0.1', port: device.port, moduleAddress: 1 })
	await waitFor(() => instance.variables.connection_status === 'Connected')
	assert.equal(instance.statuses.at(-1).status, base.InstanceStatus.Ok)
	await waitFor(() => instance.variables.firmware_version === '710-1005-05')
	assert.equal(instance.feedbacks.connected.callback({ options: {} }), true)

	// A full iLearn line in a variable, sent with a repeat override
	await instance.actions.portSet.callback({
		options: { portNum: '2', ir: 'sendir,1:1,1,$(internal:custom_code)', repeat: 3 },
	})
	assert.match(device.sendirs()[0], /^sendir,1:2,\d+,38000,3,1,342/)
	assert.equal(instance.variables.last_result, 'complete')
	assert.equal(instance.variables.sent_total, 1)
	assert.equal(instance.feedbacks.lastFailed.callback({ options: { portNum: 'any' } }), false)

	// An invalid code is reported and never reaches the device
	await instance.actions.portSet.callback({ options: { portNum: '1', ir: '38000,1,1,342,171,21', repeat: 0 } })
	assert.equal(device.sendirs().length, 1)
	assert.equal(instance.variables.last_result, 'invalid')
	assert.match(instance.variables.last_error, /on\/off pairs/)
	assert.equal(instance.feedbacks.lastFailed.callback({ options: { portNum: '1' } }), true)
	assert.equal(instance.feedbacks.lastFailed.callback({ options: { portNum: '2' } }), false)

	// Recovers from a dropped connection
	device.dropAll()
	await waitFor(() => instance.variables.connection_status === 'Disconnected')
	assert.equal(instance.statuses.at(-1).status, base.InstanceStatus.ConnectionFailure)
	await waitFor(() => instance.variables.connection_status === 'Connected')
	assert.equal(instance.variables.reconnects, 1)

	assert.ok(Object.keys(instance.presets).length > 0)
})

test('instance without an IP address reports bad config', async (t) => {
	const Instance = loadInstanceClass()
	const instance = new Instance({})
	t.after(() => instance.destroy())

	await instance.init({ host: '' })
	assert.equal(instance.statuses.at(-1).status, base.InstanceStatus.BadConfig)
	const before = instance.logs.length
	await instance.actions.portSet.callback({ options: { portNum: '1', ir: '38000,1,1,342,171', repeat: 0 } })
	assert.equal(instance.variables.last_result, 'rejected')
	assert.ok(instance.logs.length > before)
})
