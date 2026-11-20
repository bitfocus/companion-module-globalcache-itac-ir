import type { CompanionInputFieldDropdown } from '@companion-module/base'
import { parseIrCode, withRepeat, IrCodeError } from './ircode.js'
import type { GlobalCacheInstance } from './types.js'

export const PORT_CHOICES = [
	{ id: '1', label: 'Port 1' },
	{ id: '2', label: 'Port 2' },
	{ id: '3', label: 'Port 3' },
]

const portOption: CompanionInputFieldDropdown<'portNum'> = {
	type: 'dropdown',
	label: 'Port',
	id: 'portNum',
	default: '1',
	choices: PORT_CHOICES,
	allowCustom: true,
	regex: '/^\\d+$/',
	tooltip: 'Type a number for ports beyond 3 (e.g. on a GC-100)',
}

export function toPort(value: string | number | undefined): number | undefined {
	const port = Number.parseInt(String(value), 10)
	return port >= 1 && port <= 255 ? port : undefined
}

export function UpdateActions(instance: GlobalCacheInstance): void {
	instance.setActionDefinitions({
		portSet: {
			name: 'Send IR code',
			description: 'Transmit a learned IR code. Waits until the device confirms the code was sent.',
			options: [
				portOption,
				{
					type: 'textinput',
					useVariables: true,
					label: 'IR Code',
					id: 'ir',
					tooltip:
						'Global Caché format (38000,1,1,342,...), a full sendir line copied from iLearn, or Pronto hex (0000 006D ...)',
				},
				{
					type: 'number',
					label: 'Repeat count (0 = as captured)',
					id: 'repeat',
					min: 0,
					max: 50,
					default: 0,
					tooltip: 'Some devices need a code repeated a few times to react, e.g. power buttons.',
				},
			],
			callback: async (action) => {
				const opt = action.options
				const port = toPort(opt.portNum)
				if (port === undefined) {
					instance.log('error', `Send IR code: invalid port "${opt.portNum}"`)
					return
				}

				let code
				try {
					code = withRepeat(parseIrCode(opt.ir), opt.repeat)
				} catch (err) {
					if (!(err instanceof IrCodeError)) throw err
					instance.recordResult({ ok: false, status: 'invalid', error: err.message, port, attempts: 0, latencyMs: 0 })
					return
				}

				await instance.client.sendIR(port, code)
			},
		},

		stopIR: {
			name: 'Stop IR',
			description:
				'Stop the code transmitting on a port and discard any queued codes. Use on button release to end a held (repeating) code.',
			options: [portOption],
			callback: (action) => {
				const port = toPort(action.options.portNum)
				if (port === undefined) return
				if (!instance.client.stopIR(port)) instance.log('debug', `Stop IR on port ${port}: not connected`)
			},
		},

		clearQueue: {
			name: 'Clear queued codes',
			description: 'Discard all codes still waiting to be sent on every port',
			options: [],
			callback: () => {
				instance.client.clearQueue()
			},
		},

		reconnect: {
			name: 'Reconnect',
			description: 'Drop and re-open the connection to the device',
			options: [],
			callback: () => {
				instance.log('info', 'Reconnect requested')
				instance.client.reconnect('Reconnect requested')
			},
		},

		sendRaw: {
			name: 'Send raw command (advanced)',
			description: 'Send any Global Caché API command, e.g. get_IR,1:1',
			options: [
				{
					type: 'textinput',
					useVariables: true,
					label: 'Command',
					id: 'command',
				},
			],
			callback: (action) => {
				const command = action.options.command?.trim()
				if (!command) return
				if (!instance.client.sendRaw(command))
					instance.log('warn', `Raw command not sent, device not connected: ${command}`)
			},
		},
	})
}
