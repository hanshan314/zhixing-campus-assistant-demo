import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAccountStore } from './lib/accounts.js';
import { createHandler } from './lib/http.js';
export const inject = ['webServer'];
export async function apply(ctx, config = {}) {
  const store = await createAccountStore(config.dataFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'class-picker', 'state.json'));
  const token = randomBytes(32).toString('hex');
  const handler = createHandler({ store, token });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/class-picker/', handler }), 'class-picker routes');
  ctx.effect(() => ctx.webServer.tapIndex(html => {
    const script = `<script>window.__DSH_CLASS_PICKER__=${JSON.stringify({ token, path: '/class-picker/' })};</script>`;
    return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, script + '</head>') : html + script;
  }), 'class-picker connection');
}
