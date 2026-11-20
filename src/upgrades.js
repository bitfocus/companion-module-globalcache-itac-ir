const { CONFIG_DEFAULTS } = require('./config')

module.exports = [
	function (_context, _props) {
		// This is a placeholder than now cannot be used/removed
		return {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},

	// v3.0.0: port choices changed from '1,' to '1', repeat option and delivery settings added
	function (_context, props) {
		const updatedActions = []
		for (const action of props.actions) {
			if (action.actionId !== 'portSet') continue
			const portNum = String(action.options.portNum ?? '1').replace(/,$/, '')
			if (portNum !== action.options.portNum || action.options.repeat === undefined) {
				action.options.portNum = portNum
				action.options.repeat ??= 0
				updatedActions.push(action)
			}
		}

		let updatedConfig = null
		if (props.config) {
			const config = { ...CONFIG_DEFAULTS, ...props.config }
			if (Object.keys(config).length !== Object.keys(props.config).length) updatedConfig = config
		}

		return { updatedConfig, updatedActions, updatedFeedbacks: [] }
	},
]
