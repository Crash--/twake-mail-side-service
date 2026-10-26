import { readFileSync } from 'node:fs';
import { initSentry } from '@linagora/twake-node-telemetry/sentry';

const { name, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

// Loaded with --import, before main.ts, so Sentry can instrument the modules main.ts loads.
// Sentry reads SENTRY_DSN and SENTRY_ENVIRONMENT itself. Without SENTRY_DSN, nothing is sent.
initSentry({ service: name, version });
