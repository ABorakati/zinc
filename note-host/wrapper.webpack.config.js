// Copied into vendor/note-editor/webpack.bun.config.js by build.sh.
// @benrbray/prosemirror-math is a github dep whose `prepare` (vite build) Bun does not run, so it has no dist/.
// build.sh pre-bundles its lib/ into .deps/prosemirror-math.js (outside node_modules); this aliases to it.
const path = require('path');
const configs = require('./webpack.config.js');
module.exports = configs.map(c => ({
	...c,
	resolve: { ...(c.resolve || {}), alias: { ...((c.resolve || {}).alias || {}),
		'@benrbray/prosemirror-math$': path.resolve(__dirname, '.deps/prosemirror-math.js') } },
}));
