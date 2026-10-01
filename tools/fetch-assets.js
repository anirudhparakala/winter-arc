/* Downloads the vendored fonts + Fluent emoji. Run once: node tools/fetch-assets.js */
const fs = require('fs'), path = require('path');
const A = path.join(__dirname, '..', 'assets');
const FL = 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/';
const FLA = 'https://media.githubusercontent.com/media/microsoft/fluentui-emoji-animated/main/assets/';
const FS = 'https://cdn.jsdelivr.net/npm/@fontsource/';
const EMOJI = {
  fire: 'Fire/3D/fire_3d.png', snowflake: 'Snowflake/3D/snowflake_3d.png',
  star: 'Star/3D/star_3d.png', party: 'Party popper/3D/party_popper_3d.png',
  trophy: 'Trophy/3D/trophy_3d.png',
  health: 'Flexed biceps/Default/3D/flexed_biceps_3d_default.png',
  career: 'Chart increasing/3D/chart_increasing_3d.png',
  finance: 'Money bag/3D/money_bag_3d.png',
  relations: 'Handshake/3D/handshake_3d.png',
  romance: 'Red heart/3D/red_heart_3d.png', spirit: 'Sparkles/3D/sparkles_3d.png',
  home: 'House/3D/house_3d.png', travel: 'Compass/3D/compass_3d.png',
  fun: 'Video game/3D/video_game_3d.png',
  community: 'Globe showing europe-africa/3D/globe_showing_europe-africa_3d.png'
};
const ANIM = { fire: 'Fire/animated/fire_animated.png',
  snowflake: 'Snowflake/animated/snowflake_animated.png',
  party: 'Party popper/animated/party_popper_animated.png',
  trophy: 'Trophy/animated/trophy_animated.png' };
const FONTS = {
  'doto-900': 'doto/files/doto-latin-900-normal.woff2',
  'doto-700': 'doto/files/doto-latin-700-normal.woff2',
  'space-grotesk-400': 'space-grotesk/files/space-grotesk-latin-400-normal.woff2',
  'space-grotesk-500': 'space-grotesk/files/space-grotesk-latin-500-normal.woff2',
  'space-grotesk-600': 'space-grotesk/files/space-grotesk-latin-600-normal.woff2',
  'space-mono-400': 'space-mono/files/space-mono-latin-400-normal.woff2',
  'space-mono-700': 'space-mono/files/space-mono-latin-700-normal.woff2'
};
async function get(url, out, optional) {
  const r = await fetch(encodeURI(url));
  if (!r.ok) { if (optional) { console.warn('skip', url, r.status); return; } throw new Error(url + ' ' + r.status); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('ok', path.relative(A, out), fs.statSync(out).size);
}
(async () => {
  for (const [k, p] of Object.entries(EMOJI)) await get(FL + p, path.join(A, 'emoji', k + '.png'));
  for (const [k, p] of Object.entries(FONTS)) await get(FS + p, path.join(A, 'fonts', k + '.woff2'));
  for (const [k, p] of Object.entries(ANIM)) await get(FLA + p, path.join(A, 'emoji', k + '-anim-src.png'), true);
})();
