import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkDeployment} from '../scripts/check-deployment.mjs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url),'utf8'));
test('Vercel build policy matches the explicit HTTPS API origin', () => {
  assert.doesNotThrow(() => checkDeployment(config,'https://api.salon.example'));
  for (const origin of [undefined,'http://api.salon.example','https://other.salon.example','https://user:private@api.salon.example']) {
    assert.throws(() => checkDeployment(config,origin));
  }
});
test('Vercel refuses weakened script and framing policies', () => {
  for (const [before,after] of [["script-src 'self'","script-src 'self' 'unsafe-inline'"],["frame-ancestors 'none'","frame-ancestors *"]]) {
    const modified = JSON.parse(JSON.stringify(config).replace(before,after));
    assert.throws(() => checkDeployment(modified,'https://api.salon.example'));
  }
});
test('HTML revalidates while hashed assets are immutable and routing stays hash based', () => {
  for (const source of ['/','/index.html']) {
    assert.match(config.headers.find(rule => rule.source===source).headers.find(h=>h.key==='Cache-Control').value,/no-cache/);
  }
  assert.match(config.headers.find(rule=>rule.source==='/assets/(.*)').headers[0].value,/immutable/);
  assert.equal(config.rewrites,undefined);
});
