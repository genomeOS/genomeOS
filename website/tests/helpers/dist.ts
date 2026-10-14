/** Read a built page from dist/ (the vitest globalSetup builds it); '' when it was not built. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const dist = path.resolve(import.meta.dirname, '../../dist');

export function builtHtml(route: string): string {
  const filename = route.endsWith('.html')
    ? path.join(dist, route)
    : path.join(dist, route, 'index.html');
  return existsSync(filename) ? readFileSync(filename, 'utf8') : '';
}
