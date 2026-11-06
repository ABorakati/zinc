// Bun preload: Bun's domain.bind() drops the wrapped function's return value,
// so gulp's async-done never sees a task's returned promise/stream and reports
// "did not complete". Rebuild bind() on run(), which does return values.
const domain = require('domain');
const create = domain.create;
domain.create = function () {
	const d = create.apply(this, arguments);
	d.bind = fn => function (...args) {
		return d.run(() => fn.apply(this, args));
	};
	return d;
};
