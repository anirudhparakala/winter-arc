/* Smoke-tests the pure chart helpers in a bare VM.
   Run: node tools/test-ui.js                                            */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'charts.js'), 'utf8');
const ctx = { console };
ctx.window = ctx;
ctx.document = { documentElement: {} };
ctx.getComputedStyle = () => ({ getPropertyValue: () => '' });
ctx.ResizeObserver = class { observe() {} disconnect() {} };
ctx.requestAnimationFrame = f => f();
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const Charts = ctx.window.Charts;

assert.strictEqual(typeof ctx.window.esc, 'function', 'window.esc still exported');
assert.strictEqual((Charts.segments(3, 7).match(/<i/g) || []).length, 7);
assert.strictEqual((Charts.segments(3, 7).match(/class="on"/g) || []).length, 3);
assert.strictEqual((Charts.segments(0, 0).match(/<i/g) || []).length, 1);
assert.strictEqual((Charts.segments(40, 40).match(/<i/g) || []).length, 31);
assert.strictEqual((Charts.segments(5, 3).match(/class="on"/g) || []).length, 3, 'done is clamped to total');
console.log('ui ok');
