import { combineRgb } from '@companion-module/base'
import { PORT_CHOICES, toPort } from './actions.js'
import type { GlobalCacheInstance } from './types.js'

export function UpdateFeedbacks(instance: GlobalCacheInstance): void {
	instance.setFeedbackDefinitions({
		connected: {
			type: 'boolean',
			name: 'Device connected',
			description: 'True while the connection to the device is up and responding',
			defaultStyle: { bgcolor: combineRgb(0, 153, 0), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => instance.client.connected,
		},

		portBusy: {
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
				return port !== undefined && instance.client.isPortBusy(port)
			},
		},

		lastFailed: {
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
				const port = toPort(feedback.options.portNum)
				const result =
					feedback.options.portNum === 'any'
						? instance.lastResult
						: port === undefined
							? undefined
							: instance.lastResultByPort.get(port)
				return result !== undefined && !result.ok
			},
		},
	})
}
