import {
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionSimplePresetDefinition,
} from '@companion-module/base'
import type GlobalCacheItachInstance from './main.js'
import type { ModuleSchema } from './main.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)

export function UpdatePresets(instance: GlobalCacheItachInstance): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const groups: CompanionPresetGroup<ModuleSchema>[] = [
		{ id: 'status', type: 'simple', name: 'Status', presets: ['status'] },
	]

	const statusFeedbacks = (port: string): CompanionSimplePresetDefinition<ModuleSchema>['feedbacks'] => [
		{ feedbackId: 'portBusy', options: { portNum: port }, style: { bgcolor: combineRgb(255, 153, 0) } },
		{ feedbackId: 'lastFailed', options: { portNum: port }, style: { bgcolor: combineRgb(204, 0, 0) } },
	]

	presets.status = {
		type: 'simple',
		name: 'Connection status (press to reconnect)',
		style: { text: `IR\\n$(globalcache-itac-ir:connection_status)`, size: '14', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'reconnect', options: {} }], up: [] }],
		feedbacks: [
			{ feedbackId: 'connected', options: {}, style: { bgcolor: combineRgb(0, 153, 0) } },
			{ feedbackId: 'lastFailed', options: { portNum: 'any' }, style: { bgcolor: combineRgb(204, 0, 0) } },
		],
	}

	for (const { id: port, label } of instance.portChoices) {
		presets[`send_${port}`] = {
			type: 'simple',
			name: `Send IR code on port ${port} (paste your code into the action)`,
			style: { text: `IR ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'portSet', options: { portNum: port, ir: '', repeat: 0 } }], up: [] }],
			feedbacks: statusFeedbacks(port),
		}

		presets[`hold_${port}`] = {
			type: 'simple',
			name: `Repeat code on port ${port} while held (e.g. volume)`,
			style: { text: `HOLD ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
			steps: [
				{
					down: [{ actionId: 'startHold', options: { portNum: port, ir: '' } }],
					up: [{ actionId: 'stopIR', options: { portNum: port } }],
				},
			],
			feedbacks: statusFeedbacks(port),
		}

		presets[`stop_${port}`] = {
			type: 'simple',
			name: `Stop IR on port ${port}`,
			style: { text: `STOP ${port}`, size: '18', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'stopIR', options: { portNum: port } }], up: [] }],
			feedbacks: [],
		}
		groups.push({
			id: `port${port}`,
			type: 'simple',
			name: label,
			presets: [`send_${port}`, `hold_${port}`, `stop_${port}`],
		})
	}

	instance.setPresetDefinitions([{ id: 'ir', name: 'IR control', definitions: groups }], presets)
}
