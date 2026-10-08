const test = require('node:test')
const assert = require('node:assert/strict')
const { parseResponse, LineSplitter } = require('../src/protocol')

test('parses device responses', () => {
	assert.deepEqual(parseResponse('completeir,1:2,345'), { type: 'complete', module: 1, port: 2, id: 345 })
	assert.deepEqual(parseResponse('busyIR,1:1,7'), { type: 'busy', module: 1, port: 1, id: 7 })
	assert.deepEqual(parseResponse('ERR_1:3,008'), {
		type: 'error',
		module: 1,
		port: 3,
		code: 8,
		message: 'Invalid pulse count',
	})
	assert.equal(parseResponse('ERR_01').code, 1)
	assert.equal(parseResponse('ERR 014').port, undefined)
	assert.equal(parseResponse('unknowncommand 3').type, 'error')
	assert.deepEqual(parseResponse('device,1,3 IR'), { type: 'device', module: 1, ports: 3, kind: 'IR' })
	assert.equal(parseResponse('endlistdevices').type, 'endDevices')
	assert.equal(parseResponse('stopir,1:1').type, 'stopped')
	assert.deepEqual(parseResponse('710-1005-05'), { type: 'other', text: '710-1005-05' })
})

test('splits lines across chunks and mixed terminators', () => {
	const s = new LineSplitter()
	assert.deepEqual(s.push(Buffer.from('completeir,1:1,1\rcomplete')), ['completeir,1:1,1'])
	assert.deepEqual(s.push(Buffer.from('ir,1:1,2\r\n710-1005-05\n')), ['completeir,1:1,2', '710-1005-05'])
})
