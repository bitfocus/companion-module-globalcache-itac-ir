import {
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionSimplePresetDefinition,
} from '@companion-module/base'
import type { GlobalCacheInstance, GlobalCacheTypes } from './types.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const PORTS = [1, 2, 3]

export function UpdatePresets(instance: GlobalCacheInstance): void {
	const presets: CompanionPresetDefinitions<GlobalCacheTypes> = {}

	const statusFeedbacks = (port: number): CompanionSimplePresetDefinition<GlobalCacheTypes>['feedbacks'] => [
		{ feedbackId: 'portBusy', options: { portNum: String(port) }, style: { bgcolor: combineRgb(255, 153, 0) } },
		{ feedbackId: 'lastFailed', options: { portNum: String(port) }, style: { bgcolor: combineRgb(204, 0, 0) } },
	]

	presets.status = {
		type: 'simple',
		name: 'Connection status (press to reconnect)',
		style: { text: `IR\\n$(${instance.label}:connection_status)`, size: '14', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'reconnect', options: {} }], up: [] }],
		feedbacks: [
			{ feedbackId: 'connected', options: {}, style: { bgcolor: combineRgb(0, 153, 0) } },
			{ feedbackId: 'lastFailed', options: { portNum: 'any' }, style: { bgcolor: combineRgb(204, 0, 0) } },
		],
	}

	for (const port of PORTS) {
		presets[`send_${port}`] = {
			type: 'simple',
			name: `Send IR code on port ${port} (paste your code into the action)`,
			style: { text: `IR ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'portSet', options: { portNum: String(port), ir: '', repeat: 0 } }], up: [] }],
			feedbacks: statusFeedbacks(port),
		}

		presets[`hold_${port}`] = {
			type: 'simple',
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
			type: 'simple',
			name: `Stop IR on port ${port}`,
			style: { text: `STOP ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'stopIR', options: { portNum: String(port) } }], up: [] }],
			feedbacks: [],
		}
	}

	instance.setPresetDefinitions(
		[
			{
				id: 'ir',
				name: 'IR control',
				definitions: [
					{ id: 'status', type: 'simple', name: 'Status', presets: ['status'] },
					{ id: 'send', type: 'simple', name: 'Send IR', presets: PORTS.map((port) => `send_${port}`) },
					{ id: 'hold', type: 'simple', name: 'Hold to repeat', presets: PORTS.map((port) => `hold_${port}`) },
					{ id: 'stop', type: 'simple', name: 'Stop', presets: PORTS.map((port) => `stop_${port}`) },
				],
			},
		],
		presets,
	)
}
