/**
 * Structural checks on every workflow in workflows/.
 *
 * These catch the mistakes that only surface after a file has been imported
 * into a live instance: a connection pointing at a node that was renamed, an
 * external call with no retry, an error output with nothing wired to it, a
 * credential id copied out of someone else's instance, a query against a
 * table that is not in the schema, a secret pasted into a parameter.
 *
 *   node --test test/validate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, 'workflows');

const FILES = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).sort();

/** 04 is the error workflow. Pointing it at itself would loop on its own failures. */
const ERROR_WORKFLOW_FILE = '04-error-trigger-alerts.json';

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.manualTrigger',
]);

/** Nodes that leave the instance and can therefore fail for reasons of their own. */
const EXTERNAL_CALL_TYPES = new Set(['n8n-nodes-base.httpRequest', 'n8n-nodes-base.postgres']);

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI API key'],
  [/\bck_[0-9a-f]{20,}/, 'WooCommerce consumer key'],
  [/\bcs_[0-9a-f]{20,}/, 'WooCommerce consumer secret'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/hooks\.slack\.com/, 'Slack incoming webhook URL'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT'],
  [/"(password|apiKey|api_key|accessToken|secret)"\s*:\s*"(?!=?\{\{)[^"{}\s]{8,}"/i, 'literal credential value'],
];

const raw = new Map();
const parsed = new Map();

for (const file of FILES) raw.set(file, readFileSync(join(WORKFLOW_DIR, file), 'utf8'));

const SCHEMA_SQL = readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8');
const COMPOSE = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');

test('there are four workflow files', () => {
  assert.equal(FILES.length, 4, `expected 4 workflows, found ${FILES.length}: ${FILES.join(', ')}`);
});

for (const file of FILES) {
  test(`${file}: parses as JSON with the keys n8n expects`, () => {
    const wf = JSON.parse(raw.get(file));
    parsed.set(file, wf);

    assert.equal(typeof wf.name, 'string', 'name must be a string');
    assert.ok(wf.name.length > 0, 'name must not be empty');
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0, 'nodes must be a non-empty array');
    assert.equal(typeof wf.connections, 'object', 'connections must be an object');
    assert.equal(typeof wf.settings, 'object', 'settings must be an object');
  });

  test(`${file}: every node has the fields n8n requires`, () => {
    for (const node of parsed.get(file).nodes) {
      const where = `node "${node.name ?? '(unnamed)'}"`;
      assert.equal(typeof node.id, 'string', `${where}: id must be a string`);
      assert.equal(typeof node.name, 'string', `${where}: name must be a string`);
      assert.match(node.type, /^n8n-nodes-base\./, `${where}: unexpected node type ${node.type}`);
      assert.equal(typeof node.typeVersion, 'number', `${where}: typeVersion must be a number`);
      assert.ok(
        Array.isArray(node.position) && node.position.length === 2,
        `${where}: position must be [x, y]`,
      );
      assert.equal(typeof node.parameters, 'object', `${where}: parameters must be an object`);
    }
  });

  test(`${file}: node names and ids are unique`, () => {
    const wf = parsed.get(file);

    const names = wf.nodes.map((n) => n.name);
    assert.deepEqual(
      names.filter((n, i) => names.indexOf(n) !== i),
      [],
      'connections are keyed by name, so names must be unique',
    );

    const ids = wf.nodes.map((n) => n.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate node ids');
  });

  test(`${file}: every connection points at a node that exists`, () => {
    const wf = parsed.get(file);
    const names = new Set(wf.nodes.map((n) => n.name));

    for (const [source, outputs] of Object.entries(wf.connections)) {
      assert.ok(names.has(source), `connections key "${source}" is not a node in this workflow`);

      for (const branch of outputs.main ?? []) {
        for (const link of branch ?? []) {
          assert.ok(names.has(link.node), `"${source}" connects to "${link.node}", which does not exist`);
          assert.equal(link.type, 'main', `"${source}" -> "${link.node}": type must be "main"`);
          assert.equal(typeof link.index, 'number', `"${source}" -> "${link.node}": index missing`);
        }
      }
    }
  });

  test(`${file}: one trigger, and every node is reachable from it`, () => {
    const wf = parsed.get(file);

    const triggers = wf.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
    assert.equal(triggers.length, 1, `expected one trigger, found ${triggers.length}`);

    const reached = new Set([triggers[0].name]);
    const queue = [triggers[0].name];
    while (queue.length) {
      for (const branch of wf.connections[queue.shift()]?.main ?? []) {
        for (const link of branch ?? []) {
          if (!reached.has(link.node)) {
            reached.add(link.node);
            queue.push(link.node);
          }
        }
      }
    }

    const orphans = wf.nodes.map((n) => n.name).filter((n) => !reached.has(n));
    assert.deepEqual(orphans, [], 'nodes not reachable from the trigger - a dangling branch');
  });

  test(`${file}: every external call retries, and no failure is swallowed`, () => {
    const wf = parsed.get(file);

    for (const node of wf.nodes.filter((n) => EXTERNAL_CALL_TYPES.has(n.type))) {
      const where = `"${node.name}"`;

      assert.equal(node.retryOnFail, true, `${where}: retryOnFail must be true`);
      assert.ok(
        Number.isInteger(node.maxTries) && node.maxTries >= 2,
        `${where}: maxTries must be at least 2`,
      );
      assert.ok(
        Number.isInteger(node.waitBetweenTries) && node.waitBetweenTries >= 1000,
        `${where}: waitBetweenTries must be >= 1000ms - an immediate retry hits the same failure`,
      );

      // The one genuinely silent setting: the node fails, the item passes
      // downstream looking like a success, and nobody ever finds out.
      assert.notEqual(
        node.onError,
        'continueRegularOutput',
        `${where}: continueRegularOutput passes a failed call off as a success`,
      );

      const successBranch = wf.connections[node.name]?.main?.[0] ?? [];
      const errorBranch = wf.connections[node.name]?.main?.[1] ?? [];

      if (node.onError === 'continueErrorOutput') {
        assert.ok(errorBranch.length > 0, `${where}: has an error output with nothing wired to it`);
      }

      if (node.type === 'n8n-nodes-base.httpRequest' && successBranch.length > 0) {
        // A mid-flow HTTP call is a third party having a bad day. It must have
        // somewhere to go: a degraded path, a human, or an alert.
        assert.equal(
          node.onError,
          'continueErrorOutput',
          `${where}: is mid-flow and would stop its branch silently when the third party is down`,
        );
      }

      if (node.type === 'n8n-nodes-base.postgres') {
        // The opposite rule, on purpose. These queries ARE the idempotency
        // guarantee and the audit trail. Continuing past a failed claim could
        // send a customer a second email; failing the execution reaches
        // workflow 04 and can be retried from the n8n UI.
        assert.notEqual(
          node.onError,
          'continueErrorOutput',
          `${where}: a database failure must fail the execution, not be routed around`,
        );
      }
    }
  });

  test(`${file}: Code nodes do not use $('X').item outside per-item mode`, () => {
    // In "Run Once for All Items" mode there is no current item, so
    // $('Node').item throws at runtime - and only at runtime, on the day it
    // matters. .first() / .all() are the correct accessors there.
    for (const node of parsed.get(file).nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      if (node.parameters.mode !== 'runOnceForAllItems') continue;
      const hit = node.parameters.jsCode.match(/\$\('[^']+'\)\s*\.item\b/);
      assert.equal(
        hit,
        null,
        `"${node.name}": ${hit?.[0]} is not available in Run Once for All Items mode`,
      );
    }
  });

  test(`${file}: settings are production settings`, () => {
    const wf = parsed.get(file);

    assert.equal(
      wf.settings.executionOrder,
      'v1',
      'executionOrder must be v1 - v0 runs branches in an order you cannot predict',
    );
    assert.equal(wf.settings.saveDataErrorExecution, 'all', 'failed executions must keep their data');

    if (file === ERROR_WORKFLOW_FILE) {
      assert.equal(
        wf.settings.errorWorkflow,
        undefined,
        'the error workflow must not point at itself - it would loop on its own failures',
      );
    } else {
      assert.equal(
        typeof wf.settings.errorWorkflow,
        'string',
        'settings.errorWorkflow must be set so failures reach workflow 04',
      );
      assert.ok(wf.settings.errorWorkflow.length > 0, 'settings.errorWorkflow must not be empty');
    }
  });

  test(`${file}: no secrets and no hard-coded endpoints`, () => {
    const text = raw.get(file);

    for (const [pattern, label] of SECRET_PATTERNS) {
      const hit = text.match(pattern);
      assert.equal(hit, null, `looks like a ${label} was committed: ${hit?.[0]?.slice(0, 24)}`);
    }

    // Every external call goes through {{ $env.X }} so the same file imports
    // into staging and production without a single parameter being edited.
    const literalUrls = text.match(/https?:\\?\/\\?\/[^"\\\s]+/g) ?? [];
    assert.deepEqual(literalUrls, [], 'hard-coded URL - use {{ $env.SOMETHING_API_BASE }} instead');
  });

  test(`${file}: credentials are placeholders, not ids from another instance`, () => {
    for (const node of parsed.get(file).nodes) {
      for (const [type, cred] of Object.entries(node.credentials ?? {})) {
        const where = `"${node.name}" (${type})`;
        assert.equal(cred.id, null, `${where}: credential id must be null, not an instance id`);
        assert.equal(typeof cred.name, 'string', `${where}: credential name missing`);
        assert.ok(cred.name.length > 0, `${where}: credential name is empty`);
      }
    }
  });

  test(`${file}: every $env var it reads is documented in docker-compose`, () => {
    const names = new Set([...raw.get(file).matchAll(/\$env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
    for (const name of names) {
      assert.ok(
        COMPOSE.includes(`${name}:`),
        `${name} is read by this workflow but never passed to the container in infra/docker-compose.yml`,
      );
    }
  });

  test(`${file}: every table it writes to exists in sql/schema.sql`, () => {
    for (const node of parsed.get(file).nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
      const query = node.parameters.query ?? '';
      const tables = [...query.matchAll(/(?:INSERT INTO|UPDATE|FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)]
        .map((m) => m[1].toLowerCase());

      for (const table of new Set(tables)) {
        assert.ok(
          SCHEMA_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table} `),
          `"${node.name}" writes to ${table}, which is not created in sql/schema.sql`,
        );
      }
    }
  });
}

test('list lookups return the full response, so an empty list is still an item', () => {
  // A node that emits zero items ends its branch, and the execution is still
  // recorded as a success - the most expensive kind of silent failure. An
  // empty WooCommerce list is normal (a first-time buyer, a quiet night, a
  // fully stocked shop), so every list call is read as a full response: one
  // item carrying the array, however short it is.
  //
  // alwaysOutputData does not cover this. n8n only substitutes an empty item
  // when a node produced no output arrays at all, and a node with an error
  // output always produces two.
  const lookups = [
    ['01-support-agent.json', 'WooCommerce: Find Orders'],
    ['02-order-lifecycle.json', 'WooCommerce: Customer History'],
    ['03-abandoned-cart-and-stock.json', 'WooCommerce: Open Orders'],
    ['03-abandoned-cart-and-stock.json', 'WooCommerce: Product Stock'],
  ];

  for (const [file, name] of lookups) {
    const node = parsed.get(file).nodes.find((n) => n.name === name);
    assert.ok(node, `${file}: no node named ${name}`);
    assert.equal(
      node.parameters.options?.response?.response?.fullResponse,
      true,
      `${file}/${name}: without Full Response an empty list would end the branch without a trace`,
    );
  }
});

test('webhook paths are unique across the repo', () => {
  const seen = new Map();

  for (const file of FILES) {
    for (const node of parsed.get(file).nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue;
      const path = node.parameters.path;
      assert.ok(path, `"${node.name}" in ${file} has no webhook path`);
      assert.ok(!seen.has(path), `webhook path "${path}" is used by ${seen.get(path)} and ${file}`);
      seen.set(path, file);
    }
  }
});

test('both inbound webhooks authenticate the caller before anything else runs', () => {
  const expected = {
    '01-support-agent.json': 'Normalise Inbound',
    '02-order-lifecycle.json': 'Verify Woo Signature',
  };

  for (const [file, gate] of Object.entries(expected)) {
    const wf = parsed.get(file);
    const webhook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');

    assert.equal(
      wf.connections[webhook.name].main[0][0].node,
      gate,
      `${file}: the webhook must feed "${gate}" first, before any side effect`,
    );

    const node = wf.nodes.find((n) => n.name === gate);
    assert.match(node.parameters.jsCode, /timingSafeEqual/, `${file}: comparison must be constant time`);
    assert.match(node.parameters.jsCode, /throw new Error/, `${file}: a bad caller must be rejected, not flagged`);
  }
});

test('02 verifies the WooCommerce HMAC over the raw body, not the parsed one', () => {
  const wf = parsed.get('02-order-lifecycle.json');
  const webhook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');

  assert.equal(
    webhook.parameters.options?.rawBody,
    true,
    'without Raw Body the exact bytes WooCommerce signed are gone and the HMAC can never match',
  );

  const verify = wf.nodes.find((n) => n.name === 'Verify Woo Signature');
  assert.match(verify.parameters.jsCode, /createHmac\('sha256'/);
  assert.match(verify.parameters.jsCode, /digest\('base64'\)/, 'WooCommerce sends a base64 digest');
});

test('the confidence gate checks all three things, and low confidence goes to a human', () => {
  const wf = parsed.get('01-support-agent.json');
  const gate = wf.nodes.find((n) => n.name === 'Confidence Gate');

  assert.ok(gate, 'workflow 01 has no Confidence Gate');
  assert.equal(gate.type, 'n8n-nodes-base.if');

  const conditions = gate.parameters.conditions.conditions;
  assert.equal(gate.parameters.conditions.combinator, 'and', 'all three must hold, not any of them');
  assert.equal(conditions.length, 3, 'expected: there is an answer, confidence is high enough, no money involved');

  const left = conditions.map((c) => c.leftValue).join(' ');
  assert.match(left, /reply_text/, 'the gate must require a grounded answer to exist');
  assert.match(left, /confidence/, 'the gate must compare the confidence');
  assert.match(left, /touches_money/, 'the gate must refuse anything touching money');

  const threshold = conditions.find((c) => String(c.leftValue).includes('confidence'));
  assert.match(
    String(threshold.rightValue),
    /\$env\.SUPPORT_CONFIDENCE_THRESHOLD/,
    'the threshold must be an env var so it can be tightened without editing the workflow',
  );

  const [truthy, falsy] = wf.connections['Confidence Gate'].main;
  assert.equal(truthy[0].node, 'Send Auto Reply', 'the true branch answers the customer');
  assert.equal(falsy[0].node, 'Build Handover Payload', 'the false branch must reach a human, not stop');
});

test('the idempotency guards rely on a unique constraint, not on a prior SELECT', () => {
  const guards = [
    ['02-order-lifecycle.json', 'Claim Delivery', 'processed_webhooks', '(source, delivery_id)'],
    ['03-abandoned-cart-and-stock.json', 'Claim Nudge', 'cart_nudges', '(order_id)'],
    ['03-abandoned-cart-and-stock.json', 'Open Restock Task', 'restock_tasks', '(task_key)'],
  ];

  for (const [file, name, table, conflict] of guards) {
    const node = parsed.get(file).nodes.find((n) => n.name === name);
    assert.ok(node, `${file}: no node named ${name}`);
    assert.equal(node.type, 'n8n-nodes-base.postgres');

    const query = node.parameters.query;
    assert.match(query, new RegExp(`INSERT INTO ${table}`), `${file}/${name}: the guard must INSERT`);
    assert.ok(
      query.includes(`ON CONFLICT ${conflict} DO NOTHING`),
      `${file}/${name}: must be ON CONFLICT ${conflict} DO NOTHING`,
    );
    assert.match(query, /RETURNING/, `${file}/${name}: must return rows so a duplicate is detectable`);
    assert.equal(
      node.alwaysOutputData,
      true,
      `${file}/${name}: without alwaysOutputData a duplicate emits nothing and the IF below never runs`,
    );

    assert.ok(
      SCHEMA_SQL.includes(`ON ${table} ${conflict}`),
      `sql/schema.sql has no unique index on ${table} ${conflict} - ON CONFLICT would error at runtime`,
    );
  }
});

test('04 records the failure whether or not the alert was delivered', () => {
  const wf = parsed.get('04-error-trigger-alerts.json');

  assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger'), 'no Error Trigger');

  const [ok, failed] = wf.connections['Alert Ops Channel'].main;
  assert.equal(ok[0].node, 'Record Failure');
  assert.equal(failed[0].node, 'Record Failure', 'a Slack outage must not lose the failure record');
});

test('every other workflow points its errorWorkflow at 04', () => {
  for (const file of FILES) {
    if (file === ERROR_WORKFLOW_FILE) continue;
    assert.equal(
      parsed.get(file).settings.errorWorkflow,
      'REPLACE_WITH_WORKFLOW_04_ID',
      `${file}: the placeholder must be committed, and swapped for the real id at import time`,
    );
  }
});

test('a message with no upstream id gets a decision_key of its own', () => {
  const node = parsed.get('01-support-agent.json').nodes.find((n) => n.name === 'Normalise Inbound');
  const code = node.parameters.jsCode;

  // The first version fell back to the empty string when the widget sent no
  // message_id, so every such message keyed on ":" and the ON CONFLICT in the
  // decision log dropped all but the first - while still auto-replying to them.
  assert.ok(
    !/decision_key:\s*String\(body\.message_id[^\n]*\|\|\s*''\)\s*\+/.test(code),
    'an absent upstream id must not collapse to a shared decision_key',
  );
  assert.match(code, /createHash\('sha256'\)/, 'the id-less path must hash the message');
  assert.ok(
    /\[email, message, receivedAt\]/.test(code),
    'the hash must cover sender, body and timestamp, or two customers can still collide',
  );
});
