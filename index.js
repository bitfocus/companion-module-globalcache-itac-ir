const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')
const UpgradeScripts = require('./src/upgrades')

const config = require('./src/config')
const actions = require('./src/actions')

const utils = require('./src/utils')

class itacirInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...config,
			...actions,
			...utils
		})
	}

	async destroy() {
		if (self.socket !== undefined) {
			self.socket.destroy();
		}
	}

	async init(config) {
		this.configUpdated(config)
	}

	async configUpdated(config) {
		this.config = config;

		this.updateStatus(InstanceStatus.Connecting);
		
		this.initActions();

		this.initTCP();
	}
}

runEntrypoint(itacirInstance, UpgradeScripts)