# Operations

## Configuration

Environment variables, validated at startup. The service exits on an invalid value. [`.env.example`](../.env.example) lists them with their defaults.

RabbitMQ:

- `RABBITMQ_URL` (required, secret): AMQP URL, vhost included.
- `RABBITMQ_QUEUE` (default `twake-mail-side-service.v2`): the queue the service declares and reads.
- `RABBITMQ_SPACE_EXCHANGE` (default `space`): the space events, read with `twake.space.#`.
- `RABBITMQ_DNS_EXCHANGE` (default `admin-panel`) and `RABBITMQ_DNS_ROUTING_KEY` (default `dns.validated`): where the admin panel publishes its DNS validation event.
- `RABBITMQ_USER_DELETED_EXCHANGE` (default `b2b`) and `RABBITMQ_USER_DELETED_ROUTING_KEY` (default `domain.user.deleted`): user deletion.
- `RABBITMQ_MAIL_EXCHANGE` (default `tmail`), `RABBITMQ_MAIL_RECEIVED_ROUTING_KEY` (default `team-mailbox.message.received`) and `RABBITMQ_MAIL_SENT_ROUTING_KEY` (default `team-mailbox.message.sent`): the TMail plugin's team mail events. Match the plugin's `exchange`, `receivedRoutingKey` and `sentRoutingKey` settings.
- `RABBITMQ_ACTIVITY_EXCHANGE` (default `activity`): where the service publishes its `com.twake.mail.*` events.
- `RABBITMQ_PREFETCH` (default 4): the events a replica handles at once. Its database pool holds twice as many connections, plus 8.
- `RABBITMQ_MAX_RETRIES` (default 8): handler attempts before the dead letter queue.
- `RABBITMQ_RETRY_DELAY` (ms, default 1000) and `RABBITMQ_MAX_RETRY_DELAY` (ms, default 30000): the first wait between attempts, and the cap of a wait that doubles after each one. With the defaults, an event rides out about a minute and a half of outage.

The queue's delivery limit (20 broker deliveries) is fixed in code. RabbitMQ refuses to redeclare a queue with different arguments, so change it with a policy.

The rest:

- `OUTBOX_INTERVAL_MS` (default 1000): how often the relay looks for pending messages. Each run sends everything pending.
- `PARKING_INTERVAL_MS` (default 5000): how often parked events are replayed. `PARKING_MAX_WAIT_MS` (default 600000): how long an event stays parked before it goes to the dead letter queue.
- `DATABASE_URL` (required, secret): PostgreSQL URL.
- `TMAIL_WEBADMIN_URL` (required): TMail's webadmin, for example `http://tmail-admin.tmail.svc.cluster.local:8000`.
- `TMAIL_WEBADMIN_PASSWORD` (optional, secret): sent as the `Password` header.
- `TEAM_MAILBOX_PREFIX` (default empty): put before each team mailbox name, like `space-` for `space-sales@acme.com`, so a space's name never takes a person's, a list's or a role address. Lowercase letters, digits or `_`, ending with a dash. It applies to new spaces only.
- `LOG_LEVEL` (default `info`), `HEALTH_PORT` (default 8080), `METRICS_PORT` (default 9090), `SHUTDOWN_TIMEOUT_MS` (default 10000).
- `SENTRY_DSN` (optional, secret) and `SENTRY_ENVIRONMENT` (optional): see [error reports](#error-reports).

## RabbitMQ permissions

The user in `RABBITMQ_URL` needs:

- `read` on the four source exchanges. They must exist before the service starts.
- `configure`, `write` and `read` on the `twake-mail-side-service.v2` queue, its `.dlq` twin and the `twake-mail-side-service.v2.dlx` exchange, which the service declares.
- `configure` and `write` on the `activity` exchange, which the service declares (topic, durable) on its first publish.
- `configure` and `write` on the `space` exchange, for the startup sync request. The client may declare the exchange when it publishes, which takes `configure` even though it exists.

## Probes

On `HEALTH_PORT`:

- `GET /health/live`: 503 with a `reason` when the consumer has been disconnected for over a minute (`consumer_disconnected`), or has held one message for over ten minutes (`consumer_stuck`). The clock starts at the first probe, startup included, so give the pod a startup probe or an initial delay longer than its migrations.
- `GET /health/ready`: 200 once the consumer is subscribed and PostgreSQL answers, 503 with a `reason` otherwise.

## Metrics

On `METRICS_PORT`, `GET /metrics`:

- `tmss_messages_processed_total{event,outcome}`: one per handler attempt. `event` is the routing key, `outcome` is one of:
  - `handled`.
  - `duplicate`: a copy of a message already handled.
  - `stale`: older than what the space or member already has, or about a deleted space.
  - `unrouted`: no handler for the routing key.
  - `parked`: waiting for an object a later event may bring.
  - `dead_lettered`: refused for good, sent to the dead letter queue at once.
  - `dropped`: malformed.
  - `failed`: retried. After the last attempt, the message goes to the dead letter queue.
- `tmss_message_latency_seconds{event,outcome}`: handling time.
- `tmss_outbox_pending`: messages written to the outbox and not yet confirmed by RabbitMQ. Zero in steady state.
- `tmss_parked_events`: events waiting for an object a later event may bring. Zero in steady state.
- `tmss_tmail_request_seconds{operation,result}`: TMail webadmin calls. `operation` is the client method (`createTeamMailbox`, `addMember`...), `result` the HTTP status, `timeout` or `error`.
- The default Node.js process metrics.

Parked event replays do not go through the router, so they are not in `tmss_messages_processed_total`.

## Alerts

- `twake-mail-side-service.v2.dlq` growing: see [dead letters](#dead-letters).
- `outcome="failed"` rising.
- `tmss_outbox_pending` above zero for more than a minute. The relay sends in order and stops at the first message the broker refuses, so one message it can never publish (for example on an exchange the service may not write to) holds back every message after it. Its logs name that message.
- `tmss_parked_events` above zero for longer than `PARKING_MAX_WAIT_MS`.
- Any TMail call with `result=~"401|403"`: `TMAIL_WEBADMIN_PASSWORD` is wrong, and every event that calls TMail ends in the dead letter queue.

## Error reports

With `SENTRY_DSN` set, the service reports to Sentry each event its handler sends to the dead letter queue (refused for good, or failed on its last retry), a failure to start, and a failure during shutdown. Earlier failed attempts are only logged, and a parked or malformed event is not reported. Reports carry the release `twake-mail-side-service@<version>`, the tag `service` and, for a handler, the tag `event` (the routing key). `SENTRY_ENVIRONMENT` names the environment. Without `SENTRY_DSN`, nothing is sent.

## Dead letters

Nothing replays a dead letter on its own, since it could apply an old event over newer ones. What repairs one depends on the event:

- Space, member and user deletion events: a sync of the space, which ldap-rest also answers for a deleted space.
- A DNS event: a sync, when the organization's domain was stored before the failure. Otherwise its spaces wait until the admin panel validates it again (see [organizations validated before the first deployment](#organizations-validated-before-the-first-deployment)).
- A team mail event: nothing. That message never shows in the space feed.

To request a sync, publish `twake.space.sync.requested` on `space` with `{"organizationId"}` for an organization or `{"organizationId", "id"}` for one space.

## Organizations validated before the first deployment

The admin panel publishes the DNS event only when a validation runs. The service never hears about an organization whose mail DNS was validated before it was deployed, and that organization's spaces wait. After the first deployment, ask the admin panel to validate those organizations again, for example by publishing `dns.validation.requested` on its `operator` exchange.

## Spaces created before the first deployment

On a start with no space stored, the service requests a sync of every organization, which provisions the spaces created before it was deployed. Nothing else is needed.

## A space whose address is already a team mailbox

The service logs `<address> is a team mailbox no space holds, store it as space <space id>'s address to use it`, and the event goes to the dead letter queue. A DNS event may carry another space's error there instead, so search the logs.

The service does not know that mailbox, for example because it was created by hand or the space's row was lost. If it is the space's mailbox, store its address and request a sync of that space:

```sql
UPDATE spaces SET address = lower('<address>') WHERE space_id = '<space id>';
```

The sync makes the mailbox's members those of the space, removing anyone else, and publishes its id. If it is not the space's, rename the space so it gets another address, or delete the mailbox, then request a sync of that space.
