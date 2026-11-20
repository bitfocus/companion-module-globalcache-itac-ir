# companion-module-globalcache-itac-ir

Bitfocus Companion module for Global Caché iTach IR interfaces (IP2IR, WF2IR).

See [HELP.md](./companion/HELP.md) for usage and [LICENSE](./LICENSE).

## Development

Use Node.js 26.13 or later in the Node 26 release line and Yarn 4 through Corepack. The module requires a Companion host with API 2.1 and the Node 26 runtime.

```sh
corepack enable
yarn install
yarn build     # compile TypeScript for local development
yarn test      # unit tests, including failure scenarios against a simulated iTach
yarn lint
yarn package   # build the installable module package
```

The connection and delivery logic lives in `src/itach.ts` and has no Companion dependency, so it's tested directly against the simulated device in `test/fake-itach.js`.
