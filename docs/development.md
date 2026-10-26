# Development

## Prerequisites

- Node.js 24 or newer.
- Docker, for the integration tests (testcontainers) and to run the service locally.

## Project layout

```
src/
  main.ts                 Entrypoint: config, wiring, startup and shutdown
  instrument.ts           Sentry, loaded with --import before main.ts
  config.ts               Environment parsing with zod
  infra/
    rabbitmq.ts           The queue, its bindings and its arguments
    db.ts                 drizzle over postgres.js, advisory locks, migrations
    health.ts             /health/live and /health/ready, and /metrics on its own port
    metrics.ts            prom-client registry
  product/
    port.ts               The TMail interface the logic depends on
    api.ts                Its webadmin adapter
  events/
    router.ts             Routing key to handler, outcome metrics
    errors.ts             Malformed, refused for good, not yet known
    inbox.ts              Each event handled once
    outbox.ts             Outbox writes and the relay that publishes them
    parking.ts            Events that wait for a later one, and their replay
    activity.ts           Events published on the activity exchange
    schema.ts             The inbox, outbox and parked events tables
  modules/
    spaces/               Provisioning and membership: payloads, service, address, schema
    mail/                 Team mail to activity events
  testing/helpers.ts      Shared test helpers
drizzle/                  Generated migrations
```

Tests sit next to the code: `*.spec.ts` need no Docker, `*.int.spec.ts` run RabbitMQ and PostgreSQL in testcontainers.

## Checks

```sh
npm run check             # lint, format, typecheck, all tests (needs Docker), build
npm run test:unit         # without Docker
npm run test:integration  # the *.int.spec.ts files only
```

CI runs `npm audit --audit-level=high`, then `npm run check`. It also builds the image, starts it against PostgreSQL and RabbitMQ, and waits for `/health/ready` and `/metrics`.

## Database changes

Edit the `schema.ts` of the module or of `events/`, then generate the migration with `npm run db:generate` and commit it with the change. The service applies migrations at startup.

## Running locally

Start RabbitMQ and PostgreSQL, and declare the source exchanges as their publishers would, since the service only checks them:

```sh
docker run -d --name tmss-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:4-management
docker run -d --name tmss-postgres -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:17
for x in space admin-panel b2b tmail; do
  curl -fsS -u guest:guest -X PUT -H 'content-type: application/json' \
    -d '{"type":"topic","durable":true}' "http://localhost:15672/api/exchanges/%2F/$x"
done
```

Run the service:

```sh
RABBITMQ_URL=amqp://guest:guest@localhost:5672 \
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres \
TMAIL_WEBADMIN_URL=http://localhost:8000 \
npm run dev
```

`curl localhost:8080/health/ready` answers `{"status":"ready"}` once the queue is bound.

The service starts without a TMail behind it, but provisioning then fails and the event ends in the dead letter queue. Port forward a real TMail webadmin to test it, adding `TMAIL_WEBADMIN_PASSWORD`. Then publish a space, and validate its organization's mail domain:

```sh
publish() {
  curl -fsS -u guest:guest -H 'content-type: application/json' \
    "http://localhost:15672/api/exchanges/%2F/$1/publish" \
    -d "{\"routing_key\":\"$2\",\"payload\":$(jq -Rs . <<<"$3"),\"payload_encoding\":\"string\",\"properties\":{}}"
}
publish space twake.space.created \
  '{"organizationId":"acme","id":"3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091","name":"Design Sprint","timestamp":"2026-10-10T10:00:00Z"}'
publish admin-panel dns.validated \
  '{"organizationId":"acme","domain":"acme.com","mailDnsConfigurationValidated":true}'
```

The space waits after the first event and is provisioned on the second.

## Building the image

```sh
docker build -t twake-mail-side-service:dev .
```

The runtime image is `node:24-slim`, run as the `node` user, with the `drizzle/` folder next to `dist/`. It exposes 8080 (probes) and 9090 (metrics).

## Releasing

1. Bump the version in `package.json`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow fails when the tag does not match `package.json`. Otherwise it runs the checks, publishes `ghcr.io/linagora/twake-mail-side-service:vX.Y.Z` and a GitHub release with generated notes. Every push to `main` publishes `latest`.
