const test = require('node:test')
const assert = require('node:assert/strict')
const { parseIrCode, withRepeat, transmitDurationMs, formatIrCode, IrCodeError } = require('../src/ircode')

const BODY = '38000,1,1,342,171,21,64,21,21,21,1520'

test('parses a Global Caché code', () => {
	assert.deepEqual(parseIrCode(BODY), {
		frequency: 38000,
		repeat: 1,
		offset: 1,
		pulses: [342, 171, 21, 64, 21, 21, 21, 1520],
	})
})

test('strips the sendir header copied from iLearn', () => {
	assert.equal(formatIrCode(parseIrCode(`sendir,1:1,1,${BODY}`)), BODY)
	assert.equal(formatIrCode(parseIrCode(`SENDIR,1:3,4567,${BODY}`)), BODY)
})

test('accepts codes from the previous version of the module unchanged', () => {
	// The format the old help page asked for
	const legacy = '38580,1,1,346,170,22,64,22,64,22,21,22,21,22,64,22,1520'
	assert.equal(formatIrCode(parseIrCode(legacy)), legacy)
})

test('drops a leading ID left over from the sendir header', () => {
	assert.equal(formatIrCode(parseIrCode(`1,${BODY}`)), BODY)
})

test('tolerates whitespace, line breaks and a trailing comma', () => {
	assert.equal(formatIrCode(parseIrCode(` 38000, 1,1,\n342,171,\r\n21,64,21,21,21,1520,\n`)), BODY)
})

test('converts learned Pronto hex', () => {
	// 0x006D carrier = 38029 Hz, one burst pair once, one pair repeating
	const code = parseIrCode('0000 006D 0001 0001 0156 00AB 0015 05F0')
	assert.equal(code.frequency, 38029)
	assert.equal(code.offset, 3)
	assert.deepEqual(code.pulses, [0x156, 0xab, 0x15, 0x5f0])
})

test('rejects malformed codes with a helpful message', () => {
	assert.throws(() => parseIrCode(''), IrCodeError)
	assert.throws(() => parseIrCode('hello'), /numbers separated by commas/)
	assert.throws(() => parseIrCode(`1,1,${BODY}`), /Frequency 1 Hz/)
	assert.throws(() => parseIrCode('38000,1,1,342,171,21'), /on\/off pairs/)
	assert.throws(() => parseIrCode('38000,1,2,342,171,21,64'), /Offset 2/)
	assert.throws(() => parseIrCode('38000,99,1,342,171'), /Repeat count 99/)
	// sendir header missing its ID: the frequency is read as the ID
	assert.throws(() => parseIrCode('sendir,1:1,38000,1,1,342,171,21,64'), /Frequency 1 Hz/)
	assert.throws(() => parseIrCode('sendir,1:1'), /sendir/)
	assert.throws(() => parseIrCode('0001 006D 0001 0000 0156 00AB'), /Pronto/)
})

test('repeat override', () => {
	assert.equal(withRepeat(parseIrCode(BODY), 0).repeat, 1)
	assert.equal(withRepeat(parseIrCode(BODY), 5).repeat, 5)
	assert.throws(() => withRepeat(parseIrCode(BODY), 51), IrCodeError)
})

test('estimates transmit time including repeats', () => {
	const code = { frequency: 1000, repeat: 3, offset: 3, pulses: [100, 100, 50, 50] }
	// first pass 300 cycles, each repeat from offset 3 adds 100 cycles
	assert.equal(transmitDurationMs(code), 500)
})
