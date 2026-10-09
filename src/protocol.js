// Global Caché Unified TCP API (port 4998) response parsing.
// Commands and responses are terminated with a carriage return.

const ERROR_CODES = {
	1: 'Invalid command. Command not found',
	2: 'Invalid module address (does not exist)',
	3: 'Invalid connector address (does not exist)',
	4: 'Invalid ID value',
	5: 'Invalid frequency value',
	6: 'Invalid repeat value',
	7: 'Invalid offset value',
	8: 'Invalid pulse count',
	9: 'Invalid pulse data',
	10: 'Uneven amount of on/off statements',
	11: 'No carriage return found',
	12: 'Repeat count exceeded',
	13: 'IR command sent to input connector',
	14: 'Blaster command sent to non-blaster connector',
	15: 'No carriage return before buffer full',
	16: 'No carriage return',
	17: 'Bad command syntax',
	18: 'Sensor command sent to non-input connector',
	19: 'Repeated IR transmission failure',
	20: 'Above designated IR on/off pair limit',
	21: 'Symbol odd boundary',
	22: 'Undefined symbol',
	23: 'Unknown option',
}

function describeError(code) {
	return ERROR_CODES[code] ?? `Device error ${code}`
}

/**
 * Turn one line received from the device into a structured response.
 * Unrecognised lines are returned as { type: 'other' } so callers can still
 * treat them as proof the connection is alive (e.g. the getversion reply).
 */
function parseResponse(line) {
	let m

	if ((m = line.match(/^completeir,(\d+):(\d+),(\d+)$/i))) {
		return { type: 'complete', module: Number(m[1]), port: Number(m[2]), id: Number(m[3]) }
	}
	if ((m = line.match(/^busyir,(\d+):(\d+),(\d+)$/i))) {
		return { type: 'busy', module: Number(m[1]), port: Number(m[2]), id: Number(m[3]) }
	}
	// iTach: ERR_1:1,008   older firmware / other units: ERR_008, ERR 008
	if ((m = line.match(/^err[_ ]?(?:(\d+):(\d+),)?(\d+)$/i))) {
		const code = Number(m[3])
		return {
			type: 'error',
			module: m[1] === undefined ? undefined : Number(m[1]),
			port: m[2] === undefined ? undefined : Number(m[2]),
			code,
			message: describeError(code),
		}
	}
	if ((m = line.match(/^unknowncommand\s*,?\s*(\d+)?$/i))) {
		return { type: 'error', code: m[1] === undefined ? 1 : Number(m[1]), message: 'Unknown command' }
	}
	if ((m = line.match(/^stopir,(\d+):(\d+)$/i))) {
		return { type: 'stopped', module: Number(m[1]), port: Number(m[2]) }
	}
	if ((m = line.match(/^device,(\d+),(\d+)\s+(\S+)/i))) {
		return { type: 'device', module: Number(m[1]), ports: Number(m[2]), kind: m[3].toUpperCase() }
	}
	if (/^endlistdevices$/i.test(line)) {
		return { type: 'endDevices' }
	}

	return { type: 'other', text: line }
}

/** Splits a TCP stream into lines, buffering partial lines between chunks */
class LineSplitter {
	constructor() {
		this.buffer = ''
	}

	push(chunk) {
		this.buffer += chunk.toString('latin1')
		const parts = this.buffer.split(/\r\n|\r|\n/)
		this.buffer = parts.pop()
		return parts.map((line) => line.trim()).filter((line) => line !== '')
	}

	reset() {
		this.buffer = ''
	}
}

module.exports = { parseResponse, describeError, LineSplitter }
