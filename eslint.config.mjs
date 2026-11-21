import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default [
	...(await generateEslintConfig({ enableTypescript: true })),
	{
		files: ['test/*.test.js'],
		// Tests load the built entrypoint after yarn build.
		rules: { 'n/no-missing-import': 'off', 'n/no-unpublished-import': 'off' },
	},
]
