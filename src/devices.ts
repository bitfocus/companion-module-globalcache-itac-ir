import type { DeviceInfo } from './protocol.js'

export const DEFAULT_PORT_COUNT = 3

type IrConnector = { address: string; modeAddress: string }

/** Maps the 1-based Companion port number to the device's module:connector address. */
export function getIrConnectors(devices: DeviceInfo[], preferredModule?: number): IrConnector[] {
	const modules = devices.filter(({ ports, kind }) => ports >= 1 && ports <= 255 && /^IR(?:TRIPORT)?(?:$|_)/.test(kind))
	modules.sort((a, b) => a.module - b.module)
	if (preferredModule !== undefined) {
		const index = modules.findIndex(({ module }) => module === preferredModule)
		if (index === -1) return []
		const [preferred] = modules.splice(index, 1)
		modules.unshift(preferred)
	}

	return modules.flatMap(({ module, ports, kind }) => {
		// Flex reports one port and uses get_IR at connector 1 for the entire cable.
		const triport = kind === 'IRTRIPORT' || kind === 'IRTRIPORT_BLASTER'
		return Array.from({ length: triport ? 3 : ports }, (_, index) => {
			const address = `${module}:${index + 1}`
			return { address, modeAddress: triport ? `${module}:1` : address }
		})
	})
}
