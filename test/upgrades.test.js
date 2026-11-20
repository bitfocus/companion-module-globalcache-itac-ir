const test = require('node:test')
const assert = require('node:assert/strict')
const upgrades = require('../src/upgrades')

test('v3 upgrade converts old port values and fills in new settings', () => {
	const actions = [
		{ id: 'a', controlId: 'c', actionId: 'portSet', options: { portNum: '2,', ir: '38000,1,1,1,1' } },
		{ id: 'b', controlId: 'c', actionId: 'other', options: {} },
	]
	const result = upgrades[1]({}, { config: { host: '10.0.0.5' }, actions, feedbacks: [] })

	assert.equal(result.updatedActions.length, 1)
	assert.deepEqual(result.updatedActions[0].options, { portNum: '2', ir: '38000,1,1,1,1', repeat: 0 })
	assert.equal(result.updatedConfig.host, '10.0.0.5')
	assert.equal(result.updatedConfig.port, 4998)
	assert.equal(result.updatedConfig.retryUncertain, false)
})

test('v3 upgrade leaves already upgraded actions alone', () => {
	const actions = [{ id: 'a', controlId: 'c', actionId: 'portSet', options: { portNum: '1', ir: '', repeat: 2 } }]
	const result = upgrades[1]({}, { config: null, actions, feedbacks: [] })
	assert.equal(result.updatedActions.length, 0)
	assert.equal(result.updatedConfig, null)
})
