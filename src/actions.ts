import type { CompanionInputFieldDropdown, CompanionInputFieldTextInput } from '@companion-module/base'
import { parseIrCode, withRepeat, IrCodeError } from './ircode.js'
import type GlobalCacheItachInstance from './main.js'

export type ActionsSchema = {
	portSet: { options: { portNum: string; ir: string; repeat: number } }
	startHold: { options: { portNum: string; ir: string } }
	stopIR: { options: { portNum: string } }
	clearQueue: { options: Record<string, never> }
	reconnect: { options: Record<string, never> }
	sendRaw: { options: { command: string } }
}

export function toPort(value: string | number | undefined): number | undefined {
	const port = Number.parseInt(String(value), 10)
	return port >= 1 && port <= 255 ? port : undefined
}

function recordInvalid(instance: GlobalCacheItachInstance, port: number, error: unknown) {
	if (!(error instanceof IrCodeError)) throw error
	instance.recordResult({ ok: false, status: 'invalid', error: error.message, port, attempts: 0, latencyMs: 0 })
}

export function UpdateActions(instance: GlobalCacheItachInstance): void {
	const portOption: CompanionInputFieldDropdown<'portNum'> = {
		type: 'dropdown',
		label: 'Port',
		id: 'portNum',
		default: '1',
		choices: instance.portChoices,
		allowCustom: true,
		regex: '/^\\d+$/',
		tooltip: 'Type a port number if it is not listed',
	}
	const irOption: CompanionInputFieldTextInput<'ir'> = {
		type: 'textinput',
		useVariables: true,
		label: 'IR Code',
		id: 'ir',
		tooltip: 'Global Caché (numeric or compressed), a full sendir line, or learned Pronto hex',
	}

	instance.setActionDefinitions({
		portSet: {
			name: 'Send IR code',
			description: 'Transmit a learned IR code. Waits until the device confirms the code was sent.',
			options: [
				portOption,
				irOption,
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
					recordInvalid(instance, port, err)
					return
				}

				await instance.client.sendIR(port, code)
			},
		},

		startHold: {
			name: 'Start IR hold',
			description: 'Refresh short IR bursts until Stop IR is run. Pair with Stop IR on button release.',
			options: [portOption, irOption],
			callback: ({ options }) => {
				const port = toPort(options.portNum)
				if (port === undefined) {
					instance.log('error', `Start IR hold: invalid port "${options.portNum}"`)
					return
				}
				try {
					instance.client.startHold(port, parseIrCode(options.ir))
				} catch (err) {
					recordInvalid(instance, port, err)
				}
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
				if (!instance.client.stopIR(port)) instance.log('debug', `Stop IR could not be sent on port ${port}`)
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
					instance.log(
						'warn',
						`Raw command needs a connected device. On a GC-100 the connection must also be idle: ${command}`,
					)
			},
		},
	})
}
