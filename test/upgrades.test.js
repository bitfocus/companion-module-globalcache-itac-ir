import test from 'node:test'
import assert from 'node:assert/strict'
import { UpgradeScripts } from '../dist/main.js'

const literal = (value) => ({ isExpression: false, value })

test('v3 upgrade converts old port values and fills in new settings', () => {
	const actions = [
		{
			id: 'a',
			controlId: 'c',
			actionId: 'portSet',
			options: { portNum: literal('2,'), ir: literal('$(internal:custom_ir)') },
		},
		{ id: 'b', controlId: 'c', actionId: 'other', options: {} },
	]
	const result = UpgradeScripts[1]({}, { config: { host: '10.0.0.5' }, actions, feedbacks: [] })

	assert.equal(result.updatedActions.length, 1)
	assert.deepEqual(result.updatedActions[0].options, {
		portNum: literal('2'),
		ir: literal('$(internal:custom_ir)'),
		repeat: literal(0),
	})
	assert.equal(result.updatedConfig.host, '10.0.0.5')
	assert.equal(result.updatedConfig.port, 4998)
	assert.equal(result.updatedConfig.retryUncertain, false)
	assert.equal(result.updatedSecrets, null)
})

test('v3 upgrade leaves already upgraded actions alone', () => {
	const actions = [
		{
			id: 'a',
			controlId: 'c',
			actionId: 'portSet',
			options: { portNum: literal('1'), ir: literal(''), repeat: literal(2) },
		},
	]
	const result = UpgradeScripts[1]({}, { config: null, actions, feedbacks: [] })
	assert.equal(result.updatedActions.length, 0)
	assert.equal(result.updatedConfig, null)
})

test('v3 upgrade preserves expressions when filling in missing options', () => {
	const portNum = { isExpression: true, value: '$(local:port)' }
	const actions = [{ id: 'a', controlId: 'c', actionId: 'portSet', options: { portNum } }]
	const result = UpgradeScripts[1]({}, { config: null, actions, feedbacks: [] })
	assert.deepEqual(result.updatedActions[0].options, { portNum, repeat: literal(0) })
})
