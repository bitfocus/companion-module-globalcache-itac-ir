var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.status(self.STATE_UNKNOWN);

	self.init_tcp();
};

instance.prototype.init_tcp = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, 4998);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});
	}
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;
	return [
		{
			type:  'textinput',
			id:    'host',
			label: 'Device IP',
			width: 12,
			regex: self.REGEX_IP
		},
		{
			type:  'text',
			id:    'info',
			width: 12,
			label: 'Information',
			value: 'This module controls an itac IP2IR device by <a href="https://www.globalcache.com/products/itach/ip2irspecs/" target="_new">Global Cache</a>. Use the <a href= "https://www.globalcache.com/support/ilearntutorial/" target="_new">iLearn App</a> to capture ir codes for your device.'
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	debug("destroy", self.id);;
};


instance.prototype.actions = function(system) {
	var self = this;
	self.system.emit('instance_actions', self.id, {

		'portSet':    {
			label: 'Choose port',
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
						label:   'IR Code',
						id:      'ir',
						width:   12,
						regex:   '/^\\d+(,\\d+)+$/'
					}
			]
		},
	});
}

instance.prototype.action = function(action) {
	var self = this;
	var cmd  = 'sendir,1:';
	var opt  = action.options;

	switch (action.action) {

		case 'portSet':
			cmd += opt.portNum + '1,' + opt.ir;
			break;

	}

	if (cmd !== undefined) {

		debug('sending tcp', cmd, "to", self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(cmd + "\r\n");
		} else {
			debug('Socket not connected :(');
		}

	}

	debug('action():', action);


};

instance.module_info = {
	label:   'Global Cache - iTach IP2IR',
	id:      'globalcache-itac-ir',
	version: '0.0.1'
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
