/* Every asset the UI references must exist locally (offline-first). */
const fs = require('fs'), path = require('path'), assert = require('assert');
const A = path.join(__dirname, '..', 'assets');
const EMOJI = ['fire','snowflake','star','party','trophy','health','career','finance',
  'relations','romance','spirit','home','travel','fun','community'];
const FONTS = ['doto-900','doto-700','space-grotesk-400','space-grotesk-500',
  'space-grotesk-600','space-mono-400','space-mono-700'];
EMOJI.forEach(e => assert.ok(fs.statSync(path.join(A,'emoji',e+'.png')).size > 1000, 'emoji '+e));
FONTS.forEach(f => assert.ok(fs.statSync(path.join(A,'fonts',f+'.woff2')).size > 1000, 'font '+f));
// animated emoji are optional, but if present must stay small enough to inline
fs.readdirSync(path.join(A,'emoji')).filter(f => f.endsWith('-anim.png')).forEach(f =>
  assert.ok(fs.statSync(path.join(A,'emoji',f)).size < 400*1024, f + ' too large'));
console.log('assets ok');
