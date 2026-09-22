/**
 * Local stand-ins for the four external services the workflows talk to:
 * WooCommerce, an OpenAI-compatible chat completions endpoint, a helpdesk
 * and an email sender, plus Slack incoming webhooks.
 *
 * It exists so the workflows can be executed end to end - on a laptop, in
 * CI, or in front of a client - without a WooCommerce store, an API key or
 * a Slack workspace. Nothing in workflows/ is modified to use it: only the
 * *_API_BASE and SLACK_*_WEBHOOK_URL environment variables change.
 *
 *   node test/mocks/server.mjs            # listens on 5799
 *   PORT=6000 node test/mocks/server.mjs
 *
 * Fault injection, used to prove the retry and error paths:
 *   curl -XPOST localhost:5799/__control/fail \
 *        -d '{"path":"/woo/products","times":2,"status":500}'
 *   curl localhost:5799/__control/calls
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 5799);

/** path -> { times, status } : the next `times` calls to `path` fail. */
const faults = new Map();
/** Everything the workflows sent, so a test can assert on it. */
const calls = [];

const now = Date.now();
const iso = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString().replace('Z', '');

// --------------------------------------------------------------- fixtures

const ORDERS = [
  {
    id: 1042,
    number: '1042',
    status: 'processing',
    currency: 'GBP',
    currency_symbol: '£',
    total: '38.50',
    date_created: iso(72),
    customer_id: 7,
    payment_method_title: 'Card',
    billing: { first_name: 'Priya', last_name: 'Nair', email: 'priya.nair@example.com' },
    line_items: [
      { product_id: 21, name: 'Ethiopia Guji - 250g whole bean', quantity: 1, total: '14.50' },
      { product_id: 33, name: 'Colombia Huila - 250g filter grind', quantity: 2, total: '24.00' },
    ],
    meta_data: [{ id: 1, key: '_tracking_number', value: 'RM284471193GB' }],
  },
  {
    id: 1043,
    number: '1043',
    status: 'completed',
    currency: 'GBP',
    currency_symbol: '£',
    total: '62.00',
    date_created: iso(400),
    customer_id: 7,
    billing: { first_name: 'Priya', last_name: 'Nair', email: 'priya.nair@example.com' },
    line_items: [{ product_id: 21, name: 'Ethiopia Guji - 1kg whole bean', quantity: 1, total: '62.00' }],
    meta_data: [],
  },
  {
    id: 1051,
    number: '1051',
    status: 'processing',
    currency: 'GBP',
    currency_symbol: '£',
    total: '284.00',
    date_created: iso(1),
    customer_id: 0,
    payment_method_title: 'Card',
    billing: { first_name: 'Tom', last_name: 'Okafor', email: 'tom.okafor@example.com' },
    line_items: [{ product_id: 44, name: 'Fern Espresso Machine', quantity: 1, total: '284.00' }],
    meta_data: [],
  },
  // Two abandoned carts inside the 4h-48h window used by workflow 03.
  {
    id: 1060,
    number: '1060',
    status: 'pending',
    currency: 'GBP',
    currency_symbol: '£',
    total: '46.00',
    date_created: iso(9),
    customer_id: 12,
    checkout_payment_url: 'https://store.example.test/checkout/order-pay/1060',
    billing: { first_name: 'Aisha', last_name: 'Khan', email: 'aisha.khan@example.com' },
    line_items: [{ product_id: 33, name: 'Colombia Huila - 250g filter grind', quantity: 4, total: '46.00' }],
    meta_data: [],
  },
  {
    id: 1061,
    number: '1061',
    status: 'failed',
    currency: 'GBP',
    currency_symbol: '£',
    total: '19.50',
    date_created: iso(26),
    customer_id: 0,
    checkout_payment_url: 'https://store.example.test/checkout/order-pay/1061',
    billing: { first_name: 'Dan', last_name: 'Weir', email: 'dan.weir@example.com' },
    line_items: [{ product_id: 52, name: 'Swiss Water Decaf - 250g', quantity: 1, total: '19.50' }],
    meta_data: [],
  },
];

// 1062 is deliberately NOT in the abandoned list result but IS returned by
// /orders/1062 as completed, to exercise the "converted since" recheck.
const ORDERS_BY_ID = Object.fromEntries(ORDERS.map((o) => [String(o.id), o]));
ORDERS_BY_ID['1062'] = { ...ORDERS[3], id: 1062, number: '1062', status: 'completed' };

const PRODUCTS = [
  { id: 21, name: 'Ethiopia Guji - 250g', sku: 'ETH-GUJI-250', type: 'simple', status: 'publish', manage_stock: true, stock_quantity: 41, backorders: 'no', price: '14.50' },
  { id: 33, name: 'Colombia Huila - 250g', sku: 'COL-HUIL-250', type: 'simple', status: 'publish', manage_stock: true, stock_quantity: 3, backorders: 'no', price: '11.50' },
  { id: 52, name: 'Swiss Water Decaf - 250g', sku: 'DEC-SW-250', type: 'simple', status: 'publish', manage_stock: true, stock_quantity: 0, backorders: 'notify', price: '19.50' },
  { id: 44, name: 'Fern Espresso Machine', sku: 'EQ-FERN-01', type: 'simple', status: 'publish', manage_stock: false, stock_quantity: null, backorders: 'no', price: '284.00' },
  { id: 61, name: 'Tasting Subscription', sku: 'SUB-TASTE', type: 'variable', status: 'publish', manage_stock: true, stock_quantity: 1, backorders: 'no', price: '24.00' },
];

// ------------------------------------------------------- LLM stand-in

/**
 * Classifies on keywords and returns a response in the exact shape the
 * workflow parses: choices[0].message.content holding a JSON string that
 * satisfies the strict json_schema in the node. The point is that the
 * workflow's parsing, gating and routing are exercised for real - only the
 * model's judgement is replaced.
 */
function classify(userMessage) {
  const m = String(userMessage || '').toLowerCase();

  if (/refund|money back|chargeback|cancel my order|overcharg/.test(m)) {
    return { intent: 'refund', confidence: 0.94, touches_money: true };
  }
  if (/where.*order|order.*status|arriv|deliver|dispatch|shipp?ed|tracking/.test(m)) {
    return { intent: 'order_status', confidence: 0.93, touches_money: false };
  }
  if (/how long|shipping|return|grind|decaf|roast|subscri|allergen|wholesale|gift|payment method/.test(m)) {
    return { intent: 'product_question', confidence: 0.88, touches_money: false };
  }
  if (/terrible|awful|disgust|complain|never again|furious/.test(m)) {
    return { intent: 'complaint', confidence: 0.81, touches_money: false };
  }
  // Deliberately low: this is the branch that must reach a human.
  return { intent: 'other', confidence: 0.31, touches_money: false };
}

function chatCompletion(body) {
  const userMessage = (body.messages || []).filter((x) => x.role === 'user').map((x) => x.content).join('\n');
  const schemaName = body?.response_format?.json_schema?.name;

  let content;
  if (schemaName === 'cart_nudge') {
    const first = (userMessage.match(/Customer first name: (.*)/) || [])[1] || 'there';
    const items = (userMessage.match(/Items left in the cart: (.*)/) || [])[1] || 'your basket';
    content = JSON.stringify({
      subject: 'Still thinking it over, ' + first + '?',
      body:
        'Hi ' + first + ',\n\nYou left ' + items + ' in your basket and it is still saved. ' +
        'If you were waiting on anything, just reply to this email and we will help.\n\nKettle and Fern',
      tone: 'warm',
    });
  } else {
    const c = classify(userMessage);
    const ref = (userMessage.match(/#?\b(\d{3,})\b/) || [])[1] || null;
    content = JSON.stringify({
      intent: c.intent,
      confidence: c.confidence,
      order_reference: ref,
      touches_money: c.touches_money,
      summary: String(userMessage).slice(0, 160),
      language: 'en',
    });
  }

  return {
    id: 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 210, completion_tokens: 48, total_tokens: 258 },
  };
}

// ------------------------------------------------------------- routing

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function route(method, path, query, body) {
  // --- control plane -------------------------------------------------
  if (path === '/__control/fail' && method === 'POST') {
    faults.set(body.path, { times: Number(body.times || 1), status: Number(body.status || 500) });
    return [200, { ok: true, faults: [...faults.entries()] }];
  }
  if (path === '/__control/calls') return [200, { count: calls.length, calls }];
  if (path === '/__control/reset' && method === 'POST') {
    faults.clear();
    calls.length = 0;
    return [200, { ok: true }];
  }
  if (path === '/__control/health') return [200, { ok: true, service: 'n8n-ecommerce-ai-agent mocks' }];

  // --- woocommerce ---------------------------------------------------
  if (path === '/woo/orders' && method === 'GET') {
    const search = String(query.get('search') || '').toLowerCase();
    const statuses = String(query.get('status') || '').split(',').filter(Boolean);
    const after = query.get('after');
    const before = query.get('before');

    let out = ORDERS;
    if (search) out = out.filter((o) => JSON.stringify(o).toLowerCase().includes(search));
    if (statuses.length) out = out.filter((o) => statuses.includes(o.status));
    if (after) out = out.filter((o) => o.date_created >= after);
    if (before) out = out.filter((o) => o.date_created <= before);
    return [200, out];
  }
  const orderById = path.match(/^\/woo\/orders\/(\d+)$/);
  if (orderById && method === 'GET') {
    const o = ORDERS_BY_ID[orderById[1]];
    return o ? [200, o] : [404, { code: 'woocommerce_rest_shop_order_invalid_id' }];
  }
  if (path === '/woo/products' && method === 'GET') return [200, PRODUCTS];

  // --- llm -----------------------------------------------------------
  if (path === '/llm/chat/completions' && method === 'POST') return [200, chatCompletion(body)];

  // --- helpdesk ------------------------------------------------------
  const reply = path.match(/^\/support\/conversations\/([^/]+)\/reply$/);
  if (reply && method === 'POST') {
    return [201, { id: 'msg_' + Math.random().toString(36).slice(2, 10), conversation_id: reply[1], status: 'sent' }];
  }

  // --- email ---------------------------------------------------------
  if (path === '/email/messages' && method === 'POST') {
    return [202, { id: 'em_' + Math.random().toString(36).slice(2, 10), status: 'queued' }];
  }
  if (/^\/email\/sequences\/[^/]+\/subscribers$/.test(path) && method === 'POST') {
    return [201, { id: 'sub_' + Math.random().toString(36).slice(2, 10), status: 'enrolled' }];
  }

  // --- slack incoming webhooks ---------------------------------------
  if (path.startsWith('/slack/') && method === 'POST') {
    return [200, { ok: true, channel: path.replace('/slack/', '') }];
  }

  return [404, { error: 'no mock for ' + method + ' ' + path }];
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { _raw: raw };
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    const fault = faults.get(path);
    if (fault && fault.times > 0) {
      fault.times -= 1;
      if (fault.times === 0) faults.delete(path);
      calls.push({ at: new Date().toISOString(), method: req.method, path, injected_failure: true });
      console.log(`${req.method} ${path} -> ${fault.status} (injected)`);
      return json(res, fault.status, { error: 'injected failure', remaining: fault.times });
    }

    const [status, payload] = route(req.method, path, url.searchParams, body);
    if (!path.startsWith('/__control')) {
      calls.push({ at: new Date().toISOString(), method: req.method, path, body, status });
    }
    console.log(`${req.method} ${path} -> ${status}`);
    json(res, status, payload);
  });
});

server.listen(PORT, () => {
  console.log(`mock services listening on http://localhost:${PORT}`);
  console.log('  WOO_API_BASE      http://host.docker.internal:' + PORT + '/woo');
  console.log('  LLM_API_BASE      http://host.docker.internal:' + PORT + '/llm');
  console.log('  SUPPORT_API_BASE  http://host.docker.internal:' + PORT + '/support');
  console.log('  EMAIL_API_BASE    http://host.docker.internal:' + PORT + '/email');
  console.log('  SLACK_*_URL       http://host.docker.internal:' + PORT + '/slack/<channel>');
});
