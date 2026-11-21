import { Socket } from 'node:net'
import { formatIrCode, parseIrCode } from './ircode.js'
import { LineSplitter, parseResponse } from './protocol.js'

export const IR_LEARN_TIMEOUT = 25_000

/** Capture one frame on the TCP connection that opened the device's learner. */
export async function learnIrCode(host: string, port: number, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted()

	return new Promise((resolve, reject) => {
		const socket = new Socket()
		const splitter = new LineSplitter()
		let requested = false
		let finished = false

		const finish = (error?: Error, code?: string) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
			if (requested && !socket.destroyed) {
				socket.end('stop_IRL\r')
				socket.destroySoon()
			} else {
				socket.destroy()
			}
			if (error) reject(error)
			else if (code) resolve(code)
		}

		const abort = () => finish(new Error('IR learning cancelled'))
		const timer = setTimeout(
			() => finish(new Error('No IR code received before the learner timed out')),
			IR_LEARN_TIMEOUT,
		)
		signal.addEventListener('abort', abort, { once: true })
		socket.once('connect', () => {
			requested = true
			socket.write('get_IRL\r')
		})
		socket.on('data', (chunk) => {
			if (finished) return
			for (const line of splitter.push(chunk)) {
				if (/^sendir,/i.test(line)) {
					try {
						finish(undefined, formatIrCode(parseIrCode(line)))
					} catch (err) {
						finish(new Error(`Invalid captured IR code: ${err instanceof Error ? err.message : String(err)}`))
					}
					return
				}
				if (/^IR Learner Unavailable$/i.test(line)) {
					finish(new Error('The device’s IR learner is unavailable. Check whether it is configured for LED lighting.'))
					return
				}
				if (/^IR Learner Disabled$/i.test(line)) {
					finish(new Error('The device stopped IR learning before it captured a code'))
					return
				}
				const response = parseResponse(line)
				if (response.type === 'error') {
					finish(new Error(`The device rejected IR learning: ${response.message}`))
					return
				}
			}
		})
		socket.on('error', finish)
		socket.once('close', () => finish(new Error('IR learner connection closed before it captured a code')))
		socket.connect(port, host)
	})
}
