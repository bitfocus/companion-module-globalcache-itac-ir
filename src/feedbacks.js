const { combineRgb } = require('@companion-module/base')
const { PORT_CHOICES, toPort } = require('./actions')

module.exports = {
	initFeedbacks: function () {
		let self = this
		let feedbacks = {}

		feedbacks.connected = {
			type: 'boolean',
			name: 'Device connected',
			description: 'True while the connection to the device is up and responding',
			defaultStyle: { bgcolor: combineRgb(0, 153, 0), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => self.client.connected,
		}

		feedbacks.portBusy = {
			type: 'boolean',
			name: 'Port sending',
			description: 'True while a code is transmitting or queued on the port',
			defaultStyle: { bgcolor: combineRgb(255, 153, 0), color: combineRgb(0, 0, 0) },
			options: [
				{
					type: 'dropdown',
					label: 'Port',
					id: 'portNum',
					default: '1',
					choices: PORT_CHOICES,
					allowCustom: true,
					regex: '/^\\d+$/',
				},
			],
			callback: (feedback) => {
				const port = toPort(feedback.options.portNum)
				return port !== undefined && self.client.isPortBusy(port)
			},
		}

		feedbacks.lastFailed = {
			type: 'boolean',
			name: 'Last code failed',
			description: 'True when the most recent code on the port (or any port) was not confirmed as sent',
			defaultStyle: { bgcolor: combineRgb(204, 0, 0), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'dropdown',
					label: 'Port',
					id: 'portNum',
					default: 'any',
					choices: [{ id: 'any', label: 'Any port' }, ...PORT_CHOICES],
					allowCustom: true,
					regex: '/^(any|\\d+)$/',
				},
			],
			callback: (feedback) => {
				const result =
					feedback.options.portNum === 'any'
						? self.lastResult
						: self.lastResultByPort.get(toPort(feedback.options.portNum))
				return result !== undefined && !result.ok
			},
		}

		self.setFeedbackDefinitions(feedbacks)
	},
}
