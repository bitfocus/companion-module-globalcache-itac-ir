const { Regex } = require('@companion-module/base')

module.exports = {
	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module controls an itac IP2IR device by <a href="https://www.globalcache.com/products/itach/ip2irspecs/" target="_new">Global Cache</a>. Use the <a href= "https://www.globalcache.com/support/ilearntutorial/" target="_new">iLearn App</a> to capture ir codes for your device.'
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'IP',
				width: 4,
				regex: Regex.IP
			}
		]
	},
}
