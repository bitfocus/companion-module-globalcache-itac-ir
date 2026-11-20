const { parseIrCode, withRepeat, IrCodeError } = require('./ircode')

const PORT_CHOICES = [
	{ id: '1', label: 'Port 1' },
	{ id: '2', label: 'Port 2' },
	{ id: '3', label: 'Port 3' },
]

const portOption = {
	type: 'dropdown',
	label: 'Port',
	id: 'portNum',
	width: 12,
	default: '1',
	choices: PORT_CHOICES,
	allowCustom: true,
	regex: '/^\\d+$/',
	tooltip: 'Type a number for ports beyond 3 (e.g. on a GC-100)',
}

function toPort(value) {
	const port = parseInt(value, 10)
	return port >= 1 && port <= 255 ? port : undefined
}

async function parse(context, self, text) {
	return context?.parseVariablesInString ? context.parseVariablesInString(text) : self.parseVariablesInString(text)
}

module.exports = {
	PORT_CHOICES,
	toPort,

	initActions: function () {
		let self = this
		let actions = {}

		// The id 'portSet' is kept from earlier versions so existing buttons keep working
		actions.portSet = {
			name: 'Send IR code',
			description: 'Transmit a learned IR code. Waits until the device confirms the code was sent.',
			options: [
				portOption,
				{
					type: 'textinput',
					useVariables: true,
					label: 'IR Code',
					id: 'ir',
					width: 12,
					tooltip:
						'Global Caché format (38000,1,1,342,...), a full sendir line copied from iLearn, or Pronto hex (0000 006D ...)',
				},
				{
					type: 'number',
					label: 'Repeat count (0 = as captured)',
					id: 'repeat',
					width: 12,
					min: 0,
					max: 50,
					default: 0,
					tooltip: 'Some devices need a code repeated a few times to react, e.g. power buttons.',
				},
			],
			callback: async function (action, context) {
				const opt = action.options
				const port = toPort(opt.portNum)
				if (port === undefined) {
					self.log('error', `Send IR code: invalid port "${opt.portNum}"`)
					return
				}

				let code
				try {
					const text = await parse(context, self, opt.ir)
					code = withRepeat(parseIrCode(text), opt.repeat)
				} catch (err) {
					if (!(err instanceof IrCodeError)) throw err
					self.recordResult({ ok: false, status: 'invalid', error: err.message, port, attempts: 0, latencyMs: 0 })
					return
				}

				await self.client.sendIR(port, code)
			},
		}

		actions.stopIR = {
			name: 'Stop IR',
			description:
				'Stop the code transmitting on a port and discard any queued codes. Use on button release to end a held (repeating) code.',
			options: [portOption],
			callback: async function (action) {
				const port = toPort(action.options.portNum)
				if (port === undefined) return
				if (!self.client.stopIR(port)) self.log('debug', `Stop IR on port ${port}: not connected`)
			},
		}

		actions.clearQueue = {
			name: 'Clear queued codes',
			description: 'Discard all codes still waiting to be sent on every port',
			options: [],
			callback: async function () {
				self.client.clearQueue()
			},
		}

		actions.reconnect = {
			name: 'Reconnect',
			description: 'Drop and re-open the connection to the device',
			options: [],
			callback: async function () {
				self.log('info', 'Reconnect requested')
				self.client.reconnect('Reconnect requested')
			},
		}

		actions.sendRaw = {
			name: 'Send raw command (advanced)',
			description: 'Send any Global Caché API command, e.g. get_IR,1:1',
			options: [
				{
					type: 'textinput',
					useVariables: true,
					label: 'Command',
					id: 'command',
					width: 12,
				},
			],
			callback: async function (action, context) {
				const command = (await parse(context, self, action.options.command)).trim()
				if (command === '') return
				if (!self.client.sendRaw(command)) self.log('warn', `Raw command not sent, device not connected: ${command}`)
			},
		}

		self.setActionDefinitions(actions)
	},
}
