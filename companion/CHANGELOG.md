# Changelog

This file records notable changes to the Global Caché iTach IR module.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0]  - 2026-11-21

### Added

- Capture IR codes directly from the onboard iTach learner with **Learn Values** in **Send IR code** and **Start IR hold**.
- Discover IR connectors automatically and number them across all IR modules, including multi-module GC-100 devices. Companion builds port choices, feedbacks, variables, and presets from the discovered connectors.
- Read iTach connector modes into the `port_N_mode` variables and reject IR sends to ports configured as inputs or for LED lighting.
- Add a repeat count to **Send IR code**, a dedicated **Start IR hold** action, and actions to stop IR, clear the queue, reconnect, or send a raw API command.
- Add connection and delivery feedbacks, status variables, and presets for status, send, hold, and stop.
- Accept complete iLearn `sendir` lines, compressed Global Caché codes, and learned Pronto hex alongside existing numeric codes.

### Changed

- Ported the module to TypeScript on Companion module API 2.1 and Node.js 26. The host must support both.
- Send one code at a time per connector and wait for device confirmation before sending the next. Busy connectors are retried, stale commands expire, and retrying an unconfirmed send is opt-in.
- **Start IR hold** refreshes short bursts while the button is held. To update a previously copied hold preset, replace its press action with **Start IR hold** and keep **Stop IR** on release.

### Removed

- Removed the **IR Module Address** and **TCP Port** setup fields. New connections use TCP port 4998. Existing connections keep saved custom TCP ports and put connectors on any previously selected custom IR module first.

### Fixed

- Detect dropped and unresponsive TCP connections and reconnect automatically. Queued sends wait for device identification.
- Correlate send, busy, and stop replies with the physical IR connector and isolate raw command replies from managed sends.
- Wait for a **Stop IR** acknowledgment before releasing the connector queue. Reconnect if the acknowledgment times out.
- Validate IR timing and pulse data before transmitting and report protocol errors in the log and delivery variables.

## [2.0.3] - 2023-09-15

### Fixed

- Restored the comma between the connector address and the IR payload in `sendir` commands.

## [2.0.2] - 2023-09-14

### Fixed

- Added the missing line terminator to outgoing commands.

## [2.0.1] - 2023-09-12

### Fixed

- Removed an obsolete variable API call that interrupted connection status updates.

## [2.0.0] - 2023-09-06

### Changed

- Migrated to the Companion 3 module API.

## [1.0.5] - 2021-03-10

### Fixed

- Corrected IR code validation to require a comma-separated list of numbers.

[3.0.0]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/compare/v2.0.2...v3.0.0
[2.0.3]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/compare/v1.0.5...v2.0.0
[1.0.5]: https://github.com/bitfocus/companion-module-globalcache-itac-ir/releases/tag/v1.0.5
