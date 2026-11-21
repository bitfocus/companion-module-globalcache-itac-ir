// Parsing, normalising and validating IR codes before they reach the iTach.
//
// Accepted input formats:
//   - Global Caché body:    38000,1,1,342,171,21,64,...
//   - Full sendir command:  sendir,1:1,1,38000,1,1,342,171,...   (as copied from iLearn)
//   - Pronto hex:           0000 006D 0022 0002 0157 00AC ...
// Whitespace, line breaks and a trailing comma are tolerated in all formats.

export interface IrCode {
	frequency: number
	repeat: number
	offset: number
	pulses: number[]
	compressedPulses?: string
}

export const LIMITS = {
	minFrequency: 15000,
	maxFrequency: 500000,
	minRepeat: 1,
	maxRepeat: 50,
	maxPulse: 65535,
	maxPulseValues: 520,
	maxRepeatOffset: 383,
	minPulseUs: 80,
}

// The Pronto carrier word is expressed in units of this many microseconds
const PRONTO_CLOCK_US = 0.241246

export class IrCodeError extends Error {}

export function parseIrCode(input: string | null | undefined): IrCode {
	if (input === undefined || input === null) throw new IrCodeError('No IR code entered')

	const text = String(input).trim()
	if (text === '') throw new IrCodeError('No IR code entered')

	if (/^[0-9a-f]{4}(\s+[0-9a-f]{4})+$/i.test(text)) {
		return parseProntoHex(text)
	}

	return parseGlobalCache(text)
}

function parseGlobalCache(text: string): IrCode {
	// Line breaks and spaces are common when codes are copied out of iLearn or a document
	let body = text.replace(/\s+/g, '')

	// sendir,<module>:<port>,<id>,<freq>,...  -> <freq>,...
	const header = body.match(/^sendir,\d+:\d+,\d+,(.*)$/i)
	if (header) body = header[1]
	else if (/^sendir/i.test(body)) {
		throw new IrCodeError('Code starts with "sendir" but is not in the form sendir,<module>:<port>,<id>,...')
	}

	body = body.replace(/,+$/, '')

	// Older saved codes can start with a leftover command ID. The second field
	// of a normal body is a repeat count, so it cannot be a carrier frequency.
	const legacy = header ? null : body.match(/^(\d+),(\d+),/)
	if (legacy && Number(legacy[1]) <= 65535 && isFrequency(Number(legacy[2]))) body = body.slice(legacy[1].length + 1)

	const fields = body.match(/^(\d+),(\d+),(\d+),(.+)$/)
	if (!fields) throw new IrCodeError('IR code must contain numbers separated by commas or compressed pulse pairs')
	const [, frequency, repeat, offset, payload] = fields
	const compressed = /[A-Z]/.test(payload)
	if (!compressed && !/^\d+(,\d+)*$/.test(payload)) {
		throw new IrCodeError('IR code must contain numbers separated by commas or compressed pulse pairs')
	}
	const pulses = compressed ? expandPulsePairs(payload) : payload.split(',').map(Number)
	return validate({
		frequency: Number(frequency),
		repeat: Number(repeat),
		offset: Number(offset),
		pulses,
		...(compressed ? { compressedPulses: payload } : {}),
	})
}

function expandPulsePairs(payload: string): number[] {
	const dictionary: [number, number][] = []
	const pulses: number[] = []
	const token = /([A-O])|(\d+),(\d+)(?:,(?=\d)|(?=[A-O]|$))/y

	while (token.lastIndex < payload.length) {
		const match = token.exec(payload)
		if (!match) throw new IrCodeError('Invalid compressed IR pulse pair')

		if (match[1]) {
			const pair = dictionary[match[1].charCodeAt(0) - 65]
			if (!pair) throw new IrCodeError(`Undefined compressed IR pulse pair ${match[1]}`)
			pulses.push(...pair)
		} else {
			const on = Number(match[2])
			const off = Number(match[3])
			if (dictionary.length < 15 && !dictionary.some(([a, b]) => a === on && b === off)) dictionary.push([on, off])
			pulses.push(on, off)
		}
		if (pulses.length > LIMITS.maxPulseValues)
			throw new IrCodeError(`IR code exceeds ${LIMITS.maxPulseValues} pulse values`)
	}
	return pulses
}

function parseProntoHex(text: string): IrCode {
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

function isFrequency(value: number) {
	return value >= LIMITS.minFrequency && value <= LIMITS.maxFrequency
}

function validate(code: IrCode): IrCode {
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
	if (pulses.length > LIMITS.maxPulseValues)
		throw new IrCodeError(`IR code exceeds ${LIMITS.maxPulseValues} pulse values`)
	if (offset < 1 || offset % 2 !== 1 || offset >= pulses.length) {
		throw new IrCodeError(`Offset ${offset} must be odd and point inside the ${pulses.length} pulse values`)
	}
	if (repeat > 1 && offset > LIMITS.maxRepeatOffset) {
		throw new IrCodeError(`Repeat offset ${offset} exceeds ${LIMITS.maxRepeatOffset}`)
	}
	const minPulse = Math.ceil((frequency * LIMITS.minPulseUs) / 1_000_000)
	for (const pulse of pulses) {
		if (pulse < minPulse || pulse > LIMITS.maxPulse) {
			throw new IrCodeError(`Pulse value ${pulse} is out of range (${minPulse}-${LIMITS.maxPulse}) at ${frequency} Hz`)
		}
	}

	return code
}

export function withRepeat(code: IrCode, repeat: number | undefined): IrCode {
	if (!repeat) return code
	const value = Math.round(Number(repeat))
	if (!(value >= LIMITS.minRepeat && value <= LIMITS.maxRepeat)) {
		throw new IrCodeError(`Repeat count ${repeat} is out of range (${LIMITS.minRepeat}-${LIMITS.maxRepeat})`)
	}
	return validate({ ...code, repeat: value })
}

/** How long the iTach needs to transmit the code, in milliseconds */
export function transmitDurationMs(code: IrCode): number {
	const sum = (list: number[]) => list.reduce((total, pulse) => total + pulse, 0)
	const cycles = sum(code.pulses) + (code.repeat - 1) * sum(code.pulses.slice(code.offset - 1))
	return (cycles / code.frequency) * 1000
}

/** The part of a sendir command after the ID */
export function formatIrCode(code: IrCode): string {
	return [code.frequency, code.repeat, code.offset, code.compressedPulses ?? code.pulses.join(',')].join(',')
}
