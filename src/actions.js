module.exports = {
	initActions: function () {
		let self = this;
		let actions = {};

		actions.portSet = {
			name: 'Choose port',
			options: [
				{
					type:    'dropdown',
					label:   'Choose Port',
					id:      'portNum',
					width:   12,
					default: '1,',
					choices:	[
						{ id: '1,',		label: 'Port 1' },
						{ id: '2,',		label: 'Port 2' },
						{ id: '3,',		label: 'Port 3' }
					]
				},
				{
					type:    'textinput',
					useVariables: true,
					label:   'IR Code',
					id:      'ir',
					width:   12,
				}
			],
			callback: async function (action, bank) {
				let opt = action.options;
				let ir = await self.parseVariablesInString(opt.ir);
				let cmd = 'sendir,1:' + opt.portNum + ir;
				self.sendCommand(cmd);
			}
		}

		self.setActionDefinitions(actions);
	}
}