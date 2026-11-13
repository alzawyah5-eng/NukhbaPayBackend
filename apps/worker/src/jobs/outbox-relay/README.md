# outbox-relay

Status: planned worker entry point.

Read committed outbox rows and deliver events with stable IDs. Delivery may repeat; consumers must deduplicate transactionally.

Call the shared application use case and keep queue or scheduler concerns here.

