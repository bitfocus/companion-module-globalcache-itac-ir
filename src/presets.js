const { combineRgb } = require('@companion-module/base')

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const PORTS = [1, 2, 3]

module.exports = {
	initPresets: function () {
		const presets = {}

		const statusFeedbacks = (port) => [
			{ feedbackId: 'portBusy', options: { portNum: String(port) }, style: { bgcolor: combineRgb(255, 153, 0) } },
			{ feedbackId: 'lastFailed', options: { portNum: String(port) }, style: { bgcolor: combineRgb(204, 0, 0) } },
		]

		presets.status = {
			type: 'button',
			category: 'Status',
			name: 'Connection status (press to reconnect)',
			style: { text: `IR\\n$(${this.label}:connection_status)`, size: '14', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'reconnect', options: {} }], up: [] }],
			feedbacks: [
				{ feedbackId: 'connected', options: {}, style: { bgcolor: combineRgb(0, 153, 0) } },
				{ feedbackId: 'lastFailed', options: { portNum: 'any' }, style: { bgcolor: combineRgb(204, 0, 0) } },
			],
		}

		for (const port of PORTS) {
			presets[`send_${port}`] = {
				type: 'button',
				category: 'Send IR',
				name: `Send IR code on port ${port} (paste your code into the action)`,
				style: { text: `IR ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'portSet', options: { portNum: String(port), ir: '', repeat: 0 } }], up: [] }],
				feedbacks: statusFeedbacks(port),
			}

			presets[`hold_${port}`] = {
				type: 'button',
				category: 'Hold to repeat',
				name: `Repeat code on port ${port} while held (e.g. volume)`,
				style: { text: `HOLD ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
				steps: [
					{
						down: [{ actionId: 'portSet', options: { portNum: String(port), ir: '', repeat: 50 } }],
						up: [{ actionId: 'stopIR', options: { portNum: String(port) } }],
					},
				],
				feedbacks: statusFeedbacks(port),
			}

			presets[`stop_${port}`] = {
				type: 'button',
				category: 'Stop',
				name: `Stop IR on port ${port}`,
				style: { text: `STOP ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'stopIR', options: { portNum: String(port) } }], up: [] }],
				feedbacks: [],
			}
		}

		this.setPresetDefinitions(presets)
	},
}
