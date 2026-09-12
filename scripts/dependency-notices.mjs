import fs from 'node:fs';
import path from 'node:path';
export function dependencyNotices() {
  return ['react', 'react-dom', 'scheduler', 'wxt', '@wxt-dev/browser'].map(name => {
    const base = path.resolve('node_modules', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const license = fs.readdirSync(base).find(file => /^license(?:\.md|\.txt)?$/i.test(file));
    const fallback = ['wxt', '@wxt-dev/browser'].includes(name) && pkg.license === 'MIT';
    if (!license && !fallback) throw new Error(`Missing dependency license: ${name}`);
    const file = license ? path.join(base, license) : 'scripts/licenses/WXT-MIT.txt';
    return `${name} ${pkg.version} (${pkg.license})\n${fs.readFileSync(file, 'utf8')}`;
  });
}
