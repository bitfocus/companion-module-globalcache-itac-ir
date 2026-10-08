// Parsing, normalising and validating IR codes before they reach the iTach.
//
// Accepted input formats:
//   - Global Caché body:    38000,1,1,342,171,21,64,...
//   - Full sendir command:  sendir,1:1,1,38000,1,1,342,171,...   (as copied from iLearn)
//   - Pronto hex:           0000 006D 0022 0002 0157 00AC ...
// Whitespace, line breaks and a trailing comma are tolerated in all formats.

const LIMITS = {
	minFrequency: 15000,
	maxFrequency: 500000,
	minRepeat: 1,
	maxRepeat: 50,
	maxPulse: 65535,
}

// The Pronto carrier word is expressed in units of this many microseconds
const PRONTO_CLOCK_US = 0.241246

class IrCodeError extends Error {}

function parseIrCode(input) {
	if (input === undefined || input === null) throw new IrCodeError('No IR code entered')

	const text = String(input).trim()
	if (text === '') throw new IrCodeError('No IR code entered')

	if (/^[0-9a-f]{4}(\s+[0-9a-f]{4})+$/i.test(text)) {
		return parseProntoHex(text)
	}

	return parseGlobalCache(text)
}

function parseGlobalCache(text) {
	// Line breaks and spaces are common when codes are copied out of iLearn or a document
	let body = text.replace(/\s+/g, '')

	// sendir,<module>:<port>,<id>,<freq>,...  -> <freq>,...
	const header = body.match(/^sendir,\d+:\d+,\d+,(.*)$/i)
	if (header) body = header[1]
	else if (/^sendir/i.test(body)) {
		throw new IrCodeError('Code starts with "sendir" but is not in the form sendir,<module>:<port>,<id>,...')
	}

	body = body.replace(/,+$/, '')

	if (!/^\d+(,\d+)+$/.test(body)) {
		throw new IrCodeError('IR code may only contain numbers separated by commas')
	}

	const values = body.split(',').map((v) => Number(v))

	// "<id>,<freq>,..." (sendir header only partly removed, or entered that way to
	// work around older versions of this module): a valid frequency is never
	// below 15000, so a small first value followed by a valid frequency is an ID
	if (values.length > 1 && values[0] < LIMITS.minFrequency && isFrequency(values[1])) values.shift()

	if (values.length < 5) throw new IrCodeError('IR code is too short')

	const [frequency, repeat, offset, ...pulses] = values
	return validate({ frequency, repeat, offset, pulses })
}

function parseProntoHex(text) {
	const words = text.split(/\s+/).map((w) => parseInt(w, 16))
	const [type, carrier, onceLength, repeatLength, ...pulses] = words

	if (type !== 0x0000) {
		throw new IrCodeError('Only learned (raw) Pronto codes starting with 0000 are supported')
	}
	if (!carrier) throw new IrCodeError('Pronto code has no carrier frequency')
	if (pulses.length !== (onceLength + repeatLength) * 2) {
		throw new IrCodeError(
			`Pronto code declares ${onceLength + repeatLength} burst pairs but contains ${pulses.length / 2}`,
		)
	}

	const frequency = Math.round(1000000 / (carrier * PRONTO_CLOCK_US))
	// The repeat sequence starts after the "once" sequence. With no repeat
	// sequence the whole code is repeated.
	const offset = repeatLength > 0 ? onceLength * 2 + 1 : 1

	return validate({ frequency, repeat: 1, offset, pulses })
}

function isFrequency(value) {
	return value >= LIMITS.minFrequency && value <= LIMITS.maxFrequency
}

function validate(code) {
	const { frequency, repeat, offset, pulses } = code

	if (!isFrequency(frequency)) {
		throw new IrCodeError(
			`Frequency ${frequency} Hz is out of range (${LIMITS.minFrequency}-${LIMITS.maxFrequency}). Is the "sendir,..." header only partially removed?`,
		)
	}
	if (repeat < LIMITS.minRepeat || repeat > LIMITS.maxRepeat) {
		throw new IrCodeError(`Repeat count ${repeat} is out of range (${LIMITS.minRepeat}-${LIMITS.maxRepeat})`)
	}
	if (pulses.length === 0 || pulses.length % 2 !== 0) {
		throw new IrCodeError(`IR code must contain on/off pairs, but has ${pulses.length} pulse values`)
	}
	if (offset < 1 || offset % 2 !== 1 || offset >= pulses.length) {
		throw new IrCodeError(`Offset ${offset} must be odd and point inside the ${pulses.length} pulse values`)
	}
	for (const pulse of pulses) {
		if (pulse < 1 || pulse > LIMITS.maxPulse) {
			throw new IrCodeError(`Pulse value ${pulse} is out of range (1-${LIMITS.maxPulse})`)
		}
	}

	return { frequency, repeat, offset, pulses }
}

function withRepeat(code, repeat) {
	if (!repeat) return code
	const value = Math.round(Number(repeat))
	if (!(value >= LIMITS.minRepeat && value <= LIMITS.maxRepeat)) {
		throw new IrCodeError(`Repeat count ${repeat} is out of range (${LIMITS.minRepeat}-${LIMITS.maxRepeat})`)
	}
	return { ...code, repeat: value }
}

/** How long the iTach needs to transmit the code, in milliseconds */
function transmitDurationMs(code) {
	const sum = (list) => list.reduce((total, pulse) => total + pulse, 0)
	const cycles = sum(code.pulses) + (code.repeat - 1) * sum(code.pulses.slice(code.offset - 1))
	return (cycles / code.frequency) * 1000
}

/** The part of a sendir command after the ID */
function formatIrCode(code) {
	return [code.frequency, code.repeat, code.offset, ...code.pulses].join(',')
}

module.exports = {
	IrCodeError,
	LIMITS,
	parseIrCode,
	withRepeat,
	transmitDurationMs,
	formatIrCode,
}
