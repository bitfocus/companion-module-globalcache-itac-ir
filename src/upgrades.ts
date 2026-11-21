import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import { CONFIG_DEFAULTS, type ModuleConfig } from './config.js'

type UpgradeScript = CompanionStaticUpgradeScript<ModuleConfig, undefined>

// Preserve the original upgrade index.
const placeholder: UpgradeScript = () => ({
	updatedConfig: null,
	updatedSecrets: null,
	updatedActions: [],
	updatedFeedbacks: [],
})

// v3.0.0: port choices changed from '1,' to '1', repeat option and delivery settings added.
const migrateDeliverySettings: UpgradeScript = (_context, { actions, config }) => {
	const updatedActions = []
	for (const action of actions) {
		if (action.actionId !== 'portSet') continue
		const port = action.options.portNum
		const value = port?.value
		const portNum = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/,$/, '') : '1'
		const updatePort = !port?.isExpression && portNum !== value
		if (updatePort || action.options.repeat === undefined) {
			if (updatePort) action.options.portNum = { isExpression: false, value: portNum }
			action.options.repeat ??= { isExpression: false, value: 0 }
			updatedActions.push(action)
		}
	}

	const configNeedsDefaults = config && Object.keys(CONFIG_DEFAULTS).some((key) => !(key in config))
	return {
		updatedConfig: configNeedsDefaults ? { ...CONFIG_DEFAULTS, ...config } : null,
		updatedSecrets: null,
		updatedActions,
		updatedFeedbacks: [],
	}
}

export const UpgradeScripts: UpgradeScript[] = [placeholder, migrateDeliverySettings]
