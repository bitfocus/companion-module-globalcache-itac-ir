const { Regex } = require('@companion-module/base')

const CONFIG_DEFAULTS = {
	host: '',
	port: 4998,
	moduleAddress: 1,
	maxCommandAge: 3000,
	retries: 3,
	retryUncertain: false,
	keepaliveInterval: 10,
	responseTimeout: 2000,
}

module.exports = {
	CONFIG_DEFAULTS,

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module controls Global Caché IR interfaces such as the iTach IP2IR and WF2IR. Use the <a href="https://www.globalcache.com/support/ilearntutorial/" target="_new">iLearn App</a> to capture IR codes for your device.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'IP Address',
				width: 6,
				regex: Regex.IP,
			},
			{
				type: 'number',
				id: 'port',
				label: 'TCP Port',
				width: 3,
				min: 1,
				max: 65535,
				default: CONFIG_DEFAULTS.port,
			},
			{
				type: 'number',
				id: 'moduleAddress',
				label: 'IR Module Address',
				tooltip:
					'Always 1 on an iTach. On a GC-100 use the module number of the IR ports (see the log after connecting).',
				width: 3,
				min: 0,
				max: 255,
				default: CONFIG_DEFAULTS.moduleAddress,
			},
			{
				type: 'static-text',
				id: 'deliveryInfo',
				width: 12,
				label: 'Delivery and recovery',
				value:
					'Codes are sent one at a time per port and confirmed by the device. The defaults suit most installations.',
			},
			{
				type: 'number',
				id: 'maxCommandAge',
				label: 'Discard codes not started within (ms)',
				tooltip:
					'Codes waiting while the device is offline or the port is busy are dropped after this time, so a power toggle is never fired long after the button was pressed.',
				width: 6,
				min: 250,
				max: 60000,
				default: CONFIG_DEFAULTS.maxCommandAge,
			},
			{
				type: 'number',
				id: 'retries',
				label: 'Retries',
				tooltip: 'How often a code is retried when the port is busy (in use by another controller).',
				width: 6,
				min: 0,
				max: 10,
				default: CONFIG_DEFAULTS.retries,
			},
			{
				type: 'checkbox',
				id: 'retryUncertain',
				label: 'Also resend when delivery is unconfirmed',
				tooltip:
					'Resend a code when the connection drops or no confirmation arrives. Only enable this if none of your codes are toggles (e.g. a single power on/off code), as a resend could undo the first one.',
				width: 6,
				default: CONFIG_DEFAULTS.retryUncertain,
			},
			{
				type: 'number',
				id: 'keepaliveInterval',
				label: 'Connection check interval (s, 0 = off)',
				tooltip: 'Checks an idle connection is still alive so power or network loss is detected before the next press.',
				width: 3,
				min: 0,
				max: 300,
				default: CONFIG_DEFAULTS.keepaliveInterval,
			},
			{
				type: 'number',
				id: 'responseTimeout',
				label: 'Response timeout (ms)',
				tooltip: 'Increase for Wi-Fi models (WF2IR) on congested networks.',
				width: 3,
				min: 500,
				max: 10000,
				default: CONFIG_DEFAULTS.responseTimeout,
			},
		]
	},
}
