# companion-module-globalcache-itac-ir

Bitfocus Companion module for Global Caché iTach IR interfaces (IP2IR, WF2IR).

See [HELP.md](./companion/HELP.md) for usage and [LICENSE](./LICENSE).

## Development

```sh
yarn install
yarn test      # unit tests, including failure scenarios against a simulated iTach
yarn lint
yarn package   # build the installable module package
```

The connection and delivery logic lives in `src/itach.js` and has no Companion dependency, so it's tested directly against the simulated device in `test/fake-itach.js`.
