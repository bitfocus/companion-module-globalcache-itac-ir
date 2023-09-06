const { TCPHelper, InstanceStatus } = require('@companion-module/base');

module.exports = {
	initTCP: function() {
		let self = this;
	
		if (self.socket !== undefined) {
			self.socket.destroy();
			delete self.socket;
		}
	
		if (self.config.host) {
			self.socket = new TCPHelper(self.config.host, 4998);

			self.socket.on('connect', function () {
				self.setVariable('connect_status', 'Connected');
				self.updateStatus(InstanceStatus.Ok);
			});
	
			self.socket.on('error', function (err) {
				self.log('error', 'Network error: ' + err.message);
				self.socket.destroy(); //close the socket after receiving the error
			});
		}
	},

	sendCommand: function(cmd) {
		let self = this;

		if (cmd !== undefined) {
			if (self.socket !== undefined && self.socket.isConnected) {
				self.socket.send(cmd);
			} else {
				self.log('debug', 'Socket not connected :(');
			}
		}
	}
}