import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {productionApiBaseUrl} from '../src/api.ts';

export function checkDeployment(config, api) {
  const origin = new URL(productionApiBaseUrl(api)).origin;
  const headers = Object.fromEntries(config.headers.find(rule => rule.source === '/(.*)').headers.map(({key,value}) => [key,value]));
  const directives = Object.fromEntries(headers['Content-Security-Policy'].split(';').map(part => {
    const [key,...values] = part.trim().split(/\s+/); return [key,values];
  }));
  if (config.framework !== 'vite' || config.outputDirectory !== 'dist' || config.installCommand !== 'npm ci'
    || JSON.stringify(directives['connect-src']) !== JSON.stringify(["'self'",origin])
    || JSON.stringify(directives['script-src']) !== JSON.stringify(["'self'"])
    || JSON.stringify(directives['style-src']) !== JSON.stringify(["'self'"])
    || directives['default-src']?.join(' ') !== "'none'"
    || directives['base-uri']?.join(' ') !== "'none'"
    || directives['object-src']?.join(' ') !== "'none'"
    || directives['frame-ancestors']?.join(' ') !== "'none'"
    || headers['X-Content-Type-Options'] !== 'nosniff' || headers['X-Frame-Options'] !== 'DENY'
    || headers['Referrer-Policy'] !== 'no-referrer'
    || headers['Strict-Transport-Security'] !== 'max-age=31536000') {
    throw new Error('Invalid deployment policy; match the CSP API origin to VITE_API_BASE_URL and preserve security headers.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkDeployment(JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8')),process.env.VITE_API_BASE_URL);
    console.log('Deployment configuration passed.');
  } catch {
    console.error('Deployment configuration failed; review the public API origin and Vercel headers.');
    process.exitCode = 1;
  }
}
