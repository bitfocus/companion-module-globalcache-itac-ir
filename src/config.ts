import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export const CONFIG_DEFAULTS = {
	host: '',
	maxCommandAge: 3000,
	retries: 3,
	retryUncertain: false,
	keepaliveInterval: 10,
	responseTimeout: 2000,
}

export type ModuleConfig = typeof CONFIG_DEFAULTS & {
	/** Retain explicitly saved ports for existing connections through TCP proxies. */
	port?: number
	/** Preserve the connector numbering of existing connections with a custom address. */
	moduleAddress?: number
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value:
				'This module controls Global Caché IR interfaces such as the iTach IP2IR and WF2IR. Use Learn Values in an IR action to capture a code from your remote.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'IP Address',
			width: 12,
			regex: Regex.IP,
		},
		{
			type: 'static-text',
			id: 'deliveryInfo',
			width: 12,
			label: 'Delivery and recovery',
			value: 'Codes are sent one at a time per port and confirmed by the device. The defaults suit most installations.',
		},
		{
			type: 'number',
			id: 'maxCommandAge',
			label: 'Discard codes not started within (ms)',
			tooltip:
				'Codes waiting while the device is offline or the port is busy are dropped after this time, so a power toggle is never fired long after the button was pressed. Time waiting behind another code this module is already sending does not count.',
			width: 6,
			min: 250,
			max: 60000,
			default: CONFIG_DEFAULTS.maxCommandAge,
		},
		{
			type: 'number',
			id: 'retries',
			label: 'Retries',
			tooltip:
				'How often a code is retried when the port is busy (in use by another controller), and how many times it is resent when "Also resend when delivery is unconfirmed" is enabled.',
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
}
