-- Application tables for the WooCommerce AI agent stack.
--
-- Applied automatically to the ecom_ops database by infra/db/init on the
-- first boot of an empty Postgres volume. To apply it to an existing
-- database by hand:
--
--   psql "$DATABASE_URL" -f sql/schema.sql
--
-- Everything here is idempotent, so it is safe to run again.
--
-- The uniqueness constraints are load bearing. They are what makes every
-- workflow safe to retry: a redelivered webhook, an n8n restart mid-run, or
-- a manual re-execution cannot produce a second email, a second alert or a
-- second ticket. Nothing in the workflows does SELECT-then-INSERT, because
-- two concurrent deliveries would both find nothing and both insert.

BEGIN;

-- ---------------------------------------------------------------------
-- Workflow 01: every decision the support agent made, both branches.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_decisions (
    id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_key      text        NOT NULL,
    conversation_id   text        NOT NULL,
    customer_email    text        NOT NULL,
    channel           text        NOT NULL,
    intent            text        NOT NULL,
    confidence        numeric(4,3) NOT NULL,
    touches_money     boolean     NOT NULL,
    -- auto_replied | human_review
    action            text        NOT NULL,
    -- woocommerce_order | faq_keyword_retrieval | tool_failure | order_lookup
    reply_source      text,
    reply_text        text,
    -- Why the gate refused. NULL on the auto branch.
    gate_reason       text,
    classifier_model  text,
    classifier_error  text,
    external_ref      text,
    execution_id      text,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT support_decisions_action_chk
        CHECK (action IN ('auto_replied', 'human_review')),
    CONSTRAINT support_decisions_confidence_chk
        CHECK (confidence >= 0 AND confidence <= 1)
);

-- One row per inbound message, however many times it is delivered.
CREATE UNIQUE INDEX IF NOT EXISTS support_decisions_decision_key_uq
    ON support_decisions (decision_key);

-- "How many did the agent answer on its own last week, and at what
-- confidence" is the question a client asks first.
CREATE INDEX IF NOT EXISTS support_decisions_created_action_idx
    ON support_decisions (created_at DESC, action);
CREATE INDEX IF NOT EXISTS support_decisions_email_idx
    ON support_decisions (customer_email, created_at DESC);


-- ---------------------------------------------------------------------
-- Workflow 01: the human queue. This table, not the Slack message, is the
-- source of truth - a Slack outage must not lose a customer.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS human_review_queue (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_key     text        NOT NULL,
    conversation_id  text        NOT NULL,
    customer_email   text        NOT NULL,
    channel          text        NOT NULL,
    intent           text        NOT NULL,
    confidence       numeric(4,3) NOT NULL,
    touches_money    boolean     NOT NULL,
    reason           text        NOT NULL,
    customer_message text        NOT NULL,
    -- open | claimed | answered
    status           text        NOT NULL DEFAULT 'open',
    claimed_by       text,
    answered_at      timestamptz,
    execution_id     text,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT human_review_queue_status_chk
        CHECK (status IN ('open', 'claimed', 'answered'))
);

CREATE UNIQUE INDEX IF NOT EXISTS human_review_queue_decision_key_uq
    ON human_review_queue (decision_key);

-- Partial index: the queue view only ever reads the open rows, and they are
-- a small fraction of the table after a month.
CREATE INDEX IF NOT EXISTS human_review_queue_open_idx
    ON human_review_queue (created_at)
    WHERE status = 'open';


-- ---------------------------------------------------------------------
-- Workflow 02: the idempotency ledger for inbound webhooks.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_webhooks (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source       text        NOT NULL,
    delivery_id  text        NOT NULL,
    topic        text,
    reference    text,
    received_at  timestamptz NOT NULL DEFAULT now()
);

-- The lock. INSERT ... ON CONFLICT against this index is what makes a
-- redelivered WooCommerce webhook a no-op instead of a second welcome email.
CREATE UNIQUE INDEX IF NOT EXISTS processed_webhooks_source_delivery_uq
    ON processed_webhooks (source, delivery_id);

CREATE INDEX IF NOT EXISTS processed_webhooks_received_idx
    ON processed_webhooks (received_at DESC);


-- ---------------------------------------------------------------------
-- Workflow 02: what the automation did to each order.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_lifecycle_actions (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id     text        NOT NULL,
    order_id        bigint      NOT NULL,
    order_number    text,
    customer_email  text        NOT NULL,
    -- new | returning | vip | unknown (unknown = the history read failed)
    segment         text        NOT NULL,
    lifetime_value  numeric(12,2),
    order_total     numeric(12,2),
    order_status    text,
    -- high_value_alert | welcome_sequence | payment_recovery_nudge | none
    action          text        NOT NULL,
    succeeded       boolean     NOT NULL,
    detail          text,
    execution_id    text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per (delivery, action). A retried execution of the same delivery
-- records the same action once, and a single order can legitimately produce
-- both a high-value alert and a welcome enrolment.
CREATE UNIQUE INDEX IF NOT EXISTS order_lifecycle_actions_delivery_action_uq
    ON order_lifecycle_actions (delivery_id, action);

CREATE INDEX IF NOT EXISTS order_lifecycle_actions_order_idx
    ON order_lifecycle_actions (order_id, created_at DESC);
-- "What did we try to do and fail at" - the report nobody builds until the
-- day a client asks why a customer never got their welcome email.
CREATE INDEX IF NOT EXISTS order_lifecycle_actions_failed_idx
    ON order_lifecycle_actions (created_at DESC)
    WHERE succeeded = false;


-- ---------------------------------------------------------------------
-- Workflow 03: one nudge per abandoned cart, ever.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_nudges (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id         bigint      NOT NULL,
    order_number     text,
    email            text        NOT NULL,
    cart_value       numeric(12,2),
    currency         text,
    hours_abandoned  numeric(6,1),
    subject          text,
    -- llm | template_fallback
    copy_source      text,
    copy_error       text,
    delivered        boolean,
    detail           text,
    claimed_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz,
    execution_id     text
);

-- The claim. The row is inserted BEFORE the email is sent, so a crash between
-- the two costs one missed nudge rather than a duplicate one.
CREATE UNIQUE INDEX IF NOT EXISTS cart_nudges_order_uq
    ON cart_nudges (order_id);

CREATE INDEX IF NOT EXISTS cart_nudges_undelivered_idx
    ON cart_nudges (claimed_at DESC)
    WHERE delivered IS DISTINCT FROM true;


-- ---------------------------------------------------------------------
-- Workflow 03: restock tasks, one per product per day.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restock_tasks (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- "<product_id>:<YYYY-MM-DD>". A job running every two hours must not
    -- open twelve tickets for the same shortage.
    task_key       text        NOT NULL,
    product_id     bigint      NOT NULL,
    sku            text,
    product_name   text        NOT NULL,
    stock_quantity integer     NOT NULL,
    threshold      integer     NOT NULL,
    out_of_stock   boolean     NOT NULL DEFAULT false,
    -- open | ordered | closed
    status         text        NOT NULL DEFAULT 'open',
    closed_at      timestamptz,
    execution_id   text,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT restock_tasks_status_chk
        CHECK (status IN ('open', 'ordered', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS restock_tasks_task_key_uq
    ON restock_tasks (task_key);

CREATE INDEX IF NOT EXISTS restock_tasks_open_idx
    ON restock_tasks (created_at DESC)
    WHERE status = 'open';


-- ---------------------------------------------------------------------
-- Workflow 04: every failed execution, whether or not Slack accepted the
-- alert. A failures table containing only the failures you were
-- successfully told about is not a failures table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_failures (
    id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id       text,
    workflow_name     text        NOT NULL,
    execution_id      text,
    execution_url     text,
    failed_node       text,
    error_name        text,
    error_message     text,
    error_description text,
    error_stack       text,
    execution_mode    text,
    retry_of          text,
    -- The item that was in flight when the node threw, truncated.
    input_excerpt     text,
    alert_delivered   boolean     NOT NULL DEFAULT false,
    acknowledged_at   timestamptz,
    occurred_at       timestamptz NOT NULL DEFAULT now()
);

-- The Error Trigger can fire twice for one execution if n8n itself is
-- restarted mid-alert. NULLs are allowed through: a manual execution has no
-- id, and two of those are two genuine failures.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_failures_execution_uq
    ON workflow_failures (execution_id)
    WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_failures_recent_idx
    ON workflow_failures (occurred_at DESC);
CREATE INDEX IF NOT EXISTS workflow_failures_unacked_idx
    ON workflow_failures (occurred_at DESC)
    WHERE acknowledged_at IS NULL;


-- ---------------------------------------------------------------------
-- The two reports a client actually opens.
-- ---------------------------------------------------------------------

-- Deflection rate and average confidence per day, split by branch. This is
-- the number that tells you whether the confidence threshold can come down.
CREATE OR REPLACE VIEW support_agent_daily AS
SELECT
    date_trunc('day', created_at)                                    AS day,
    count(*)                                                         AS messages,
    count(*) FILTER (WHERE action = 'auto_replied')                  AS auto_replied,
    count(*) FILTER (WHERE action = 'human_review')                  AS handed_over,
    round(
        100.0 * count(*) FILTER (WHERE action = 'auto_replied')
        / nullif(count(*), 0), 1)                                    AS deflection_pct,
    round(avg(confidence), 3)                                        AS avg_confidence,
    count(*) FILTER (WHERE classifier_error IS NOT NULL)             AS classifier_errors
FROM support_decisions
GROUP BY 1
ORDER BY 1 DESC;

-- Everything the automation tried and could not do, in one place, newest
-- first. If this view is empty, nothing is being swallowed.
CREATE OR REPLACE VIEW automation_problems AS
SELECT occurred_at AS at, 'execution_failed' AS kind,
       workflow_name AS subject, failed_node AS detail, error_message AS message
FROM workflow_failures
UNION ALL
SELECT created_at, 'action_failed',
       'order ' || order_number, action, detail
FROM order_lifecycle_actions
WHERE succeeded = false
UNION ALL
SELECT claimed_at, 'nudge_not_delivered',
       'order ' || coalesce(order_number, order_id::text), copy_source, detail
FROM cart_nudges
WHERE delivered IS DISTINCT FROM true AND sent_at IS NOT NULL
ORDER BY 1 DESC;

COMMIT;
