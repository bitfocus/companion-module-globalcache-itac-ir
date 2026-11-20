import type { InstanceBase } from '@companion-module/base'
import type { ModuleConfig } from './config.js'
import type { DeliveryResult, ItachClient } from './itach.js'

export interface GlobalCacheTypes {
	config: ModuleConfig
	secrets: undefined
	actions: {
		portSet: { options: { portNum: string; ir: string; repeat: number } }
		stopIR: { options: { portNum: string } }
		clearQueue: { options: Record<string, never> }
		reconnect: { options: Record<string, never> }
		sendRaw: { options: { command: string } }
	}
	feedbacks: {
		connected: { type: 'boolean'; options: Record<string, never> }
		portBusy: { type: 'boolean'; options: { portNum: string } }
		lastFailed: { type: 'boolean'; options: { portNum: string } }
	}
	variables: {
		connection_status: string
		firmware_version: string
		queue_depth: number
		last_port: number | ''
		last_result: string
		last_error: string
		last_latency_ms: number | ''
		sent_total: number
		failed_total: number
		reconnects: number
	}
}

export interface GlobalCacheInstance extends InstanceBase<GlobalCacheTypes> {
	readonly client: ItachClient
	readonly invalidCount: number
	readonly lastResult: DeliveryResult | undefined
	readonly lastResultByPort: ReadonlyMap<number, DeliveryResult>
	recordResult(result: DeliveryResult): void
}
