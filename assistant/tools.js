// Tool definitions for the admin assistant.
//
// SECURITY INVARIANTS — do not relax:
//  1. `domainId` is bound from the HTTP request in this closure. It is NEVER a
//     tool parameter, so a prompt injection in customer-supplied text (an order
//     note, a wholesale inquiry) cannot make the model read another storefront.
//  2. Every query is parameterized. Tool inputs are untrusted model output.
//  3. Read-only. No INSERT/UPDATE/DELETE tools live here.
//  4. Every query has a bounded LIMIT.
//
// `dbQuery` follows this codebase's convention of returning `[rows]`.
//
// Tools are defined in a PROVIDER-NEUTRAL shape:
//   { name, description, parameters (JSON Schema), run(input) -> string }
// Each adapter in ./providers/ translates this into its own wire format, so a
// tool is written once and works on every provider.

const DEFAULT_ROWS = 5
const MAX_ROWS = 50

function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROWS
  return Math.min(Math.floor(n), MAX_ROWS)
}

// Accepts YYYY-MM-DD (or anything Date can parse) and returns an ISO string,
// or null. Rejects garbage rather than letting Postgres throw on a bad cast.
function toDate(value) {
  if (value == null || String(value).trim() === '') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function nullableText(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

// Mirrors LOW_STOCK_THRESHOLD in index.js (~L334). If that moves, move this —
// the assistant contradicting the dashboard is worse than either being wrong.
const LOW_STOCK_THRESHOLD = 5

// `products.domain_id` exists but is NULL on live rows, i.e. the catalog is
// shared across storefronts. A plain `domain_id = $1` therefore returns NOTHING
// once the admin picks a store — NULL must be read as "belongs to every store".
const PRODUCT_DOMAIN_WHERE = '($1::int IS NULL OR p.domain_id IS NULL OR p.domain_id = $1)'

const RECEIVED_STATUSES = [
  'paid', 'succeeded', 'success', 'completed', 'complete', 'captured', 'approved', 'verified', 'received',
]

// Which tools are actually exposed to the model.
//
// MEASURED 2026-08-19 (see documentation/AI_ASSISTANT.md §9): on ollama /
// qwen3:14b, tool SELECTION is reliable up to ~10 tools and collapses at 15 —
// the model starts refusing tools it has, and worse, INVENTS filter arguments,
// gets an empty result caused by its own invention, and reports "no results".
// That reads exactly like a true answer, which is the failure this feature
// cannot afford.
//
// So all 15 tools stay in this file, and only a subset is bound per request.
// This default is the exact set that scored 4/4 in the threshold test; changing
// it is a real behavioural change, not tidying. Re-run the bake-off after any
// edit here — a fix verified at 3 tools does not stay verified at 15.
//
// Override with ASSISTANT_TOOLS in .env:
//   ASSISTANT_TOOLS=all                       → every tool (only on a stronger model)
//   ASSISTANT_TOOLS=query_orders,find_customer → exactly these
const DEFAULT_ENABLED_TOOLS = [
  // Core retail — the three that have been verified since phase 1.
  'query_orders',
  'get_revenue_stats',
  'find_customer',
  // Tables that currently hold real data.
  'query_products',
  'get_product_sales',
  'query_payments',
  'query_credits',
  // Wholesale essentials.
  'query_wholesale_orders',
  'get_wholesale_inventory',
  // The one actionable queue.
  'query_address_changes',
]

// Written but NOT exposed by default, purely to stay under the selection limit.
// Every one of these tables is empty on live today, so enabling them costs
// accuracy on every other question and buys nothing. Add them to
// ASSISTANT_TOOLS (and re-run the bake-off) once they hold real rows:
//   query_newsletter, query_affiliates, query_promos,
//   query_wholesale_production, query_wholesale_inquiries

// Applies the allowlist. Returns { tools, active, unknown, mode } so the caller
// can log the result — a silently-dropped tool name is very hard to debug.
export function selectEnabledTools(allTools, env = process.env) {
  const raw = String(env.ASSISTANT_TOOLS ?? '').trim()
  const known = new Set(allTools.map((t) => t.name))

  if (raw.toLowerCase() === 'all') {
    return { tools: allTools, active: allTools.map((t) => t.name), unknown: [], mode: 'all' }
  }

  const requested = raw
    ? raw.split(',').map((n) => n.trim()).filter(Boolean)
    : DEFAULT_ENABLED_TOOLS

  const unknown = requested.filter((n) => !known.has(n))
  const active = requested.filter((n) => known.has(n))

  // An empty or entirely-bogus ASSISTANT_TOOLS would otherwise leave the model
  // with no tools at all, which fails as a confident hallucination rather than
  // an error. Fall back to the tested default instead.
  if (active.length === 0) {
    return {
      tools: allTools.filter((t) => DEFAULT_ENABLED_TOOLS.includes(t.name)),
      active: DEFAULT_ENABLED_TOOLS,
      unknown,
      mode: 'default (ASSISTANT_TOOLS matched nothing)',
    }
  }

  return {
    tools: allTools.filter((t) => active.includes(t.name)),
    active,
    unknown,
    mode: raw ? 'ASSISTANT_TOOLS' : 'default',
  }
}

export function buildTools({ dbQuery, domainId }) {
  return [
    {
      name: 'query_orders',
      description:
        'COUNT or list retail orders. This is the tool for "how many orders..." — ' +
        'it returns an exact total for any filter, including with no filter at all ' +
        '("how many orders in total", "how many orders today", "how many pending "' +
        'orders"). It also lists individual orders when asked, and looks up one ' +
        'order by number or one customer by email. Filters: status, payment status, ' +
        'date range, country. The reply opens with a plain-English `answer` giving ' +
        'the count — state that number; the handful of `sample_rows` beneath it are ' +
        'only examples and must NEVER be counted. For money totals use ' +
        'get_revenue_stats instead.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Exact order number, e.g. "ORD-4821".' },
          customer_email: { type: 'string', description: 'Customer email address, matched case-insensitively.' },
          status: {
            type: 'string',
            description:
              'Fulfilment status, separate from payment_status. Values seen in this database: ' +
              '"pending", "processing". The app may also write "in_progress", "delivered", "cancelled".',
          },
          payment_status: {
            type: 'string',
            description:
              'Money status, separate from status. Values in this database: "pending" (awaiting payment), ' +
              '"received" (PAID — this is the success value; there is no "paid" value), "rejected" (failed/declined). ' +
              'Use "received" for questions about paid or successful orders.',
          },
          country: { type: 'string', description: 'Shipping country name or part of one, e.g. "Latvia". Matched loosely.' },
          from: { type: 'string', description: 'Start of created_at range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of created_at range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.order_number),
          nullableText(input.customer_email),
          nullableText(input.status),
          nullableText(input.payment_status),
          nullableText(input.country),
          toDate(input.from),
          toDate(input.to),
        ]

        const where = `
            ($1::int IS NULL OR o.domain_id = $1)
        AND ($2::text IS NULL OR o.order_number = $2)
        AND ($3::text IS NULL OR LOWER(TRIM(o.customer_email)) = LOWER(TRIM($3)))
        AND ($4::text IS NULL OR LOWER(o.status) = LOWER($4))
        AND ($5::text IS NULL OR LOWER(o.payment_status) = LOWER($5))
        AND ($6::text IS NULL OR o.shipping_country ILIKE '%' || $6 || '%')
        AND ($7::timestamptz IS NULL OR o.created_at >= $7)
        AND ($8::timestamptz IS NULL OR o.created_at < ($8::timestamptz + INTERVAL '1 day'))`

        const [countRows] = await dbQuery(
          `SELECT COUNT(*)::int AS total FROM orders o WHERE ${where}`,
          params,
        )

        const [rows] = await dbQuery(
          `SELECT o.order_number, o.customer_email, o.customer_name, o.status,
                  o.payment_status, o.total, o.currency, o.shipping_country,
                  o.created_at
             FROM orders o
            WHERE ${where}
            ORDER BY o.created_at DESC
            LIMIT $9`,
          [...params, clampLimit(input.limit)],
        )

        const total = countRows[0]?.total ?? 0
        return JSON.stringify({
          answer: `${total} orders match this filter.`,
          total_matching: total,
          sample_rows: rows,
          sample_is_partial: total > rows.length,
        })
      },
    },

    {
      name: 'get_revenue_stats',
      description:
        'Aggregate sales figures over a date range. Use this for any "how much", ' +
        '"how many orders", "what was revenue", "average order value", or ' +
        'period-comparison question. Call it twice with different ranges to compare ' +
        'periods. Results are grouped by currency and must not be summed across ' +
        'currencies. Returns BOTH order value (sum of order totals placed, matching ' +
        'the dashboard Sales cards) and confirmed payments (money actually received ' +
        'per the payments table) — state which one you are reporting.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start of range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely. Omit for all time.' },
          to: { type: 'string', description: 'End of range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely. Omit for up to now.' },
          country: { type: 'string', description: 'Optional shipping country filter, matched loosely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const from = toDate(input.from)
        const to = toDate(input.to)
        const country = nullableText(input.country)
        const params = [domainId ?? null, from, to, country]

        const dateWhere = `
            ($1::int IS NULL OR o.domain_id = $1)
        AND ($2::timestamptz IS NULL OR o.created_at >= $2)
        AND ($3::timestamptz IS NULL OR o.created_at < ($3::timestamptz + INTERVAL '1 day'))
        AND ($4::text IS NULL OR o.shipping_country ILIKE '%' || $4 || '%')`

        const [orderRows] = await dbQuery(
          `SELECT o.currency,
                  COUNT(*)::int                       AS order_count,
                  COALESCE(SUM(o.total), 0)           AS order_value,
                  COALESCE(AVG(o.total), 0)           AS avg_order_value,
                  COUNT(*) FILTER (WHERE LOWER(o.payment_status) = ANY($5::text[]))::int AS paid_orders
             FROM orders o
            WHERE ${dateWhere}
            GROUP BY o.currency
            ORDER BY order_value DESC`,
          [...params, RECEIVED_STATUSES],
        )

        const [paymentRows] = await dbQuery(
          `SELECT p.currency,
                  COUNT(*)::int             AS payment_count,
                  COALESCE(SUM(p.amount),0) AS confirmed_amount
             FROM payments p
             JOIN orders o ON o.id = p.order_id
            WHERE ${dateWhere}
              AND LOWER(p.status) = ANY($5::text[])
            GROUP BY p.currency
            ORDER BY confirmed_amount DESC`,
          [...params, RECEIVED_STATUSES],
        )

        const answer = orderRows.length
          ? orderRows
              .map((r) => `${r.order_count} orders totalling ${r.currency} ${Number(r.order_value).toFixed(2)}, of which ${r.paid_orders} are paid`)
              .join('; ')
          : 'No orders in this range.'

        return JSON.stringify({
          answer,
          range: { from: input.from ?? 'all time', to: input.to ?? 'now' },
          order_value_by_currency: orderRows,
          confirmed_payments_by_currency: paymentRows,
        })
      },
    },

    {
      name: 'find_customer',
      description:
        'Look up customers with a lifetime order-history summary (order count, ' +
        'lifetime spend, first/last order date). Two modes: pass `search` to find a ' +
        'specific customer by email or partial name ("who is X", "how much has X ' +
        'spent"); OR omit `search` entirely to get the TOP customers ranked by ' +
        'lifetime spend, highest first — use that for "who are our best customers", ' +
        '"top 5 spenders", "which customer has spent the most". Results are always ' +
        'sorted by lifetime spend descending. Customers are identified by email ' +
        'because guests can order without registering, so a customer may appear ' +
        'here with no user account.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description:
              'Email address, partial email, or customer name. OMIT this to rank all customers by lifetime spend.',
          },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        // No `search` = "top customers by spend" mode.
        const search = nullableText(input.search)

        const [rows] = await dbQuery(
          `SELECT LOWER(TRIM(o.customer_email))    AS email,
                  MAX(o.customer_name)             AS name,
                  o.currency,
                  COUNT(*)::int                    AS order_count,
                  COALESCE(SUM(o.total), 0)        AS lifetime_value,
                  MIN(o.created_at)                AS first_order_at,
                  MAX(o.created_at)                AS last_order_at,
                  COUNT(*) FILTER (WHERE LOWER(o.payment_status) = ANY($4::text[]))::int AS paid_orders,
                  BOOL_OR(u.id IS NOT NULL)        AS has_account
             FROM orders o
             LEFT JOIN users u
                    ON LOWER(TRIM(u.email)) = LOWER(TRIM(o.customer_email))
                   AND u.domain_id = o.domain_id
            WHERE ($1::int IS NULL OR o.domain_id = $1)
              AND ($2::text IS NULL
                   OR o.customer_email ILIKE '%' || $2 || '%'
                   OR o.customer_name ILIKE '%' || $2 || '%')
            GROUP BY LOWER(TRIM(o.customer_email)), o.currency
            ORDER BY lifetime_value DESC
            LIMIT $3`,
          [domainId ?? null, search, clampLimit(input.limit), RECEIVED_STATUSES],
        )

        return JSON.stringify({
          answer: rows.length
            ? `${rows.length} customers, highest lifetime spend first.`
            : 'No matching customers.',
          customers: rows,
        })
      },
    },

    {
      name: 'query_products',
      description:
        'Look up products in the catalogue: price, stock level, and whether a ' +
        'product is enabled on the storefront. Use this for "what are we running ' +
        'low on", "is X in stock", "how many units of X do we have", "what does X ' +
        'cost", "how many products do we sell". Pass `stock` to filter by stock ' +
        'state. The catalogue is shared across all storefronts, so results are not ' +
        'store-specific even when a store filter is active. This tool says what is ' +
        'ON THE SHELF — it does NOT say what has SOLD; use get_product_sales for that.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Product name, SKU or slug, partial match. Omit to list everything.' },
          stock: {
            type: 'string',
            description:
              'Filter by stock state. Use "low" for products at or below the low-stock ' +
              'threshold of ' + LOW_STOCK_THRESHOLD + ' units, "out" for out of stock or zero units, ' +
              '"in" for products actually available. Omit for all products.',
          },
          include_disabled: {
            type: 'string',
            description:
              'By default only products enabled on the storefront are returned. Pass "yes" ' +
              'to also include disabled/hidden products.',
          },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.search),
          nullableText(input.stock),
          nullableText(input.include_disabled),
        ]

        // `stock_qty` is nullable and means "not tracked", which is NOT the same
        // as zero — COALESCE only where a missing count should read as empty.
        const where = `
            ${PRODUCT_DOMAIN_WHERE}
        AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%'
                              OR p.sku  ILIKE '%' || $2 || '%'
                              OR p.slug ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL
             OR (LOWER($3) = 'low' AND p.in_stock AND COALESCE(p.stock_qty, 0) > 0
                                   AND COALESCE(p.stock_qty, 0) <= ${LOW_STOCK_THRESHOLD})
             OR (LOWER($3) = 'out' AND (NOT p.in_stock OR COALESCE(p.stock_qty, 0) = 0))
             OR (LOWER($3) = 'in'  AND p.in_stock AND COALESCE(p.stock_qty, 0) > 0)
             OR (LOWER($3) NOT IN ('low', 'out', 'in')))
        AND (LOWER(COALESCE($4, 'no')) = 'yes' OR p.is_enabled)`

        const [summaryRows] = await dbQuery(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE NOT p.in_stock OR COALESCE(p.stock_qty, 0) = 0)::int AS out_of_stock,
                  COUNT(*) FILTER (WHERE p.in_stock AND COALESCE(p.stock_qty, 0) > 0
                                     AND COALESCE(p.stock_qty, 0) <= ${LOW_STOCK_THRESHOLD})::int AS low_stock
             FROM products p
            WHERE ${where}`,
          params,
        )

        const [rows] = await dbQuery(
          `SELECT p.name, p.sku, p.price, p.currency, p.in_stock, p.stock_qty,
                  p.is_enabled, p.updated_at
             FROM products p
            WHERE ${where}
            ORDER BY p.in_stock ASC, COALESCE(p.stock_qty, 999999) ASC, p.name ASC
            LIMIT $5`,
          [...params, clampLimit(input.limit)],
        )

        const summary = summaryRows[0] ?? { total: 0, out_of_stock: 0, low_stock: 0 }
        return JSON.stringify({
          answer: summary.total
            ? `${summary.total} products match: ${summary.low_stock} low on stock, ${summary.out_of_stock} out of stock.`
            : 'No products match this filter.',
          total_matching: summary.total,
          low_stock: summary.low_stock,
          out_of_stock: summary.out_of_stock,
          sample_rows: rows,
        })
      },
    },

    {
      name: 'get_product_sales',
      description:
        'Rank products by what they have actually SOLD over a period — units sold, ' +
        'revenue, and how many orders included them. Use this for "best seller", ' +
        '"what sells most", "worst performing product", "how many units of X did we ' +
        'sell", "top products last month". This is SALES HISTORY, not stock: for ' +
        'current stock levels use query_products. Every order line counts regardless ' +
        'of whether the order was paid, matching the dashboard Sales figures.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Limit to one product by name or SKU, partial match. Omit to rank all products.' },
          from: { type: 'string', description: 'Start of order date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely. Omit for all time.' },
          to: { type: 'string', description: 'End of order date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely. Omit for up to now.' },
          rank: {
            type: 'string',
            description:
              'Pass "worst" to list the LOWEST selling products first ("what is not selling"). ' +
              'Anything else, or omitted, lists the best sellers first.',
          },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.search),
          toDate(input.from),
          toDate(input.to),
        ]

        // Chosen by comparison, never interpolated from model text — the only two
        // possible values are these literals.
        const worst = String(input.rank ?? '').trim().toLowerCase() === 'worst'
        const direction = worst ? 'ASC' : 'DESC'

        // order_items has no domain_id of its own; the join to orders is what
        // applies the store scope.
        const [rows] = await dbQuery(
          `SELECT oi.sku,
                  MAX(oi.name)                  AS name,
                  o.currency,
                  SUM(oi.quantity)::int         AS units_sold,
                  COALESCE(SUM(oi.line_total),0) AS revenue,
                  COUNT(DISTINCT o.id)::int     AS order_count,
                  MAX(o.created_at)             AS last_sold_at
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
            WHERE ($1::int IS NULL OR o.domain_id = $1)
              AND ($2::text IS NULL OR oi.name ILIKE '%' || $2 || '%' OR oi.sku ILIKE '%' || $2 || '%')
              AND ($3::timestamptz IS NULL OR o.created_at >= $3)
              AND ($4::timestamptz IS NULL OR o.created_at < ($4::timestamptz + INTERVAL '1 day'))
            GROUP BY oi.sku, o.currency
            ORDER BY units_sold ${direction}, revenue ${direction}
            LIMIT $5`,
          [...params, clampLimit(input.limit)],
        )

        return JSON.stringify({
          answer: rows.length
            ? `${rows[0].name} is top by units sold (${rows[0].units_sold} units, ${rows[0].currency} ${rows[0].revenue}). Full ranking below, ${worst ? 'fewest' : 'most'} units first.`
            : 'No product sales in this range.',
          range: { from: input.from ?? 'all time', to: input.to ?? 'now' },
          products: rows,
        })
      },
    },

    {
      name: 'query_payments',
      description:
        'Look up individual payment-provider transactions, with a breakdown by ' +
        'status. Use this for "which payments failed", "show payments for order X", ' +
        '"how many payments are still pending", "what did we take through <provider>", ' +
        'or when the admin is chasing a specific stuck or rejected payment. An order ' +
        'can have SEVERAL payment rows (retries), so the payment count is not the ' +
        'order count. For headline revenue totals use get_revenue_stats instead.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Restrict to one order, e.g. "ORD-20260816-041540043-316DB8".' },
          status: {
            type: 'string',
            description:
              'Payment status. Values in this database: "pending" (not yet settled) and ' +
              '"rejected" (failed or declined). Successful payments carry one of: ' +
              RECEIVED_STATUSES.join(', ') + '. Omit for all statuses.',
          },
          provider: { type: 'string', description: 'Payment provider name, partial match, e.g. "Manual", "Revolut".' },
          from: { type: 'string', description: 'Start of payment date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of payment date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.order_number),
          nullableText(input.status),
          nullableText(input.provider),
          toDate(input.from),
          toDate(input.to),
        ]

        const where = `
            ($1::int IS NULL OR p.domain_id = $1)
        AND ($2::text IS NULL OR o.order_number = $2)
        AND ($3::text IS NULL OR LOWER(p.status) = LOWER($3))
        AND ($4::text IS NULL OR p.provider ILIKE '%' || $4 || '%')
        AND ($5::timestamptz IS NULL OR p.created_at >= $5)
        AND ($6::timestamptz IS NULL OR p.created_at < ($6::timestamptz + INTERVAL '1 day'))`

        // LEFT JOIN, not JOIN: a payment whose order row is missing must still be
        // counted, or the totals quietly disagree with get_revenue_stats.
        const [breakdown] = await dbQuery(
          `SELECT p.status, p.currency, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0) AS amount
             FROM payments p
             LEFT JOIN orders o ON o.id = p.order_id
            WHERE ${where}
            GROUP BY p.status, p.currency
            ORDER BY count DESC`,
          params,
        )

        const [rows] = await dbQuery(
          `SELECT o.order_number, p.provider, p.amount, p.currency, p.status,
                  p.final_status, p.bank_name, p.webhook_received, p.created_at
             FROM payments p
             LEFT JOIN orders o ON o.id = p.order_id
            WHERE ${where}
            ORDER BY p.created_at DESC
            LIMIT $7`,
          [...params, clampLimit(input.limit)],
        )

        const total = breakdown.reduce((n, r) => n + r.count, 0)
        return JSON.stringify({
          answer: total
            ? `${total} payment transactions match: ` +
              breakdown.map((b) => `${b.count} ${b.status}`).join(', ') + '.'
            : 'No payments match this filter.',
          total_matching: total,
          by_status: breakdown,
          sample_rows: rows,
        })
      },
    },

    {
      name: 'query_newsletter',
      description:
        'Mailing-list subscribers: how many there are, how fast the list is growing, ' +
        'and which signup source they came from. Use this for "how many newsletter ' +
        'subscribers", "how many signed up this month", "where are signups coming ' +
        'from", "is <email> subscribed". Returns a total, a breakdown by source, and ' +
        'the most recent subscribers.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Email address or part of one, to check whether somebody is subscribed.' },
          source: { type: 'string', description: 'Signup source, partial match, e.g. "home_popup".' },
          from: { type: 'string', description: 'Start of signup date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of signup date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.search),
          nullableText(input.source),
          toDate(input.from),
          toDate(input.to),
        ]

        // `consent` and `is_winner` are smallint flags (0/1), not booleans —
        // comparing them to true is a type error in Postgres.
        const where = `
            ($1::int IS NULL OR n.domain_id = $1)
        AND ($2::text IS NULL OR n.email ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR n.source ILIKE '%' || $3 || '%')
        AND ($4::timestamptz IS NULL OR n.created_at >= $4)
        AND ($5::timestamptz IS NULL OR n.created_at < ($5::timestamptz + INTERVAL '1 day'))`

        const [summaryRows] = await dbQuery(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE n.consent = 1)::int AS consented,
                  COUNT(*) FILTER (WHERE n.is_winner = 1)::int AS winners
             FROM newsletter_subscribers n
            WHERE ${where}`,
          params,
        )

        const [bySource] = await dbQuery(
          `SELECT n.source, COUNT(*)::int AS count
             FROM newsletter_subscribers n
            WHERE ${where}
            GROUP BY n.source
            ORDER BY count DESC
            LIMIT 20`,
          params,
        )

        const [rows] = await dbQuery(
          `SELECT n.email, n.source, n.consent, n.is_winner, n.created_at
             FROM newsletter_subscribers n
            WHERE ${where}
            ORDER BY n.created_at DESC
            LIMIT $6`,
          [...params, clampLimit(input.limit)],
        )

        const summary = summaryRows[0] ?? { total: 0, consented: 0, winners: 0 }
        return JSON.stringify({
          total_matching: summary.total,
          consented: summary.consented,
          prize_winners: summary.winners,
          by_source: bySource,
          returned: rows.length,
          truncated: summary.total > rows.length,
          recent_subscribers: rows,
        })
      },
    },

    {
      name: 'query_address_changes',
      description:
        'Customer requests to change the delivery address on an order after placing ' +
        'it. Use this for "any address changes waiting", "what needs my approval", ' +
        '"did anyone ask to change their address", or when the admin asks about a ' +
        'pending queue or outstanding actions. Status values: "pending" (waiting for ' +
        'an admin decision), plus approved/rejected once decided. Defaults to ' +
        'showing pending requests first, since those are the actionable ones.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Request status, e.g. "pending", "approved", "rejected". Omit for all.' },
          order_number: { type: 'string', description: 'Restrict to one order.' },
          customer_email: { type: 'string', description: 'Restrict to one customer, partial match.' },
          from: { type: 'string', description: 'Start of request date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of request date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.status),
          nullableText(input.order_number),
          nullableText(input.customer_email),
          toDate(input.from),
          toDate(input.to),
        ]

        const where = `
            ($1::int IS NULL OR r.domain_id = $1)
        AND ($2::text IS NULL OR LOWER(r.status) = LOWER($2))
        AND ($3::text IS NULL OR r.order_number = $3)
        AND ($4::text IS NULL OR r.customer_email ILIKE '%' || $4 || '%')
        AND ($5::timestamptz IS NULL OR r.created_at >= $5)
        AND ($6::timestamptz IS NULL OR r.created_at < ($6::timestamptz + INTERVAL '1 day'))`

        const [breakdown] = await dbQuery(
          `SELECT r.status, COUNT(*)::int AS count
             FROM order_address_change_requests r
            WHERE ${where}
            GROUP BY r.status
            ORDER BY count DESC`,
          params,
        )

        // The two *_shipping_json columns are free-text JSON blobs. Truncated
        // here on purpose: pasting whole addresses for every row would swamp the
        // model's context for no gain.
        const [rows] = await dbQuery(
          `SELECT r.order_number, r.customer_email, r.status, r.admin_note,
                  LEFT(r.requested_shipping_json, 300) AS requested_address,
                  LEFT(r.current_shipping_json, 300)   AS current_address,
                  r.decided_at, r.created_at
             FROM order_address_change_requests r
            WHERE ${where}
            ORDER BY (LOWER(r.status) = 'pending') DESC, r.created_at DESC
            LIMIT $7`,
          [...params, clampLimit(input.limit)],
        )

        const total = breakdown.reduce((n, r) => n + r.count, 0)
        return JSON.stringify({
          total_matching: total,
          by_status: breakdown,
          pending: breakdown.find((b) => String(b.status).toLowerCase() === 'pending')?.count ?? 0,
          returned: rows.length,
          truncated: total > rows.length,
          requests: rows,
        })
      },
    },

    {
      name: 'query_affiliates',
      description:
        'The affiliate / influencer programme in one call: applications waiting for a ' +
        'decision, approved affiliates, and how many orders each affiliate has ' +
        'actually referred plus the reward owed. Use this for "how is the affiliate ' +
        'programme doing", "any affiliate applications pending", "who are our best ' +
        'affiliates", "how many sales did <name> refer". Call it with no arguments ' +
        'for the overall picture; pass a search term only to ask about one person.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Affiliate name, email or promo code, partial match. Omit for the whole programme.' },
          status: { type: 'string', description: 'Filter by status, e.g. "approved" or "pending". Omit for all.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [domainId ?? null, nullableText(input.search), nullableText(input.status)]

        // Referral performance comes from promo_redemptions, keyed on the
        // affiliate's user_id. LEFT JOIN so a brand-new affiliate with no
        // referrals yet still appears, with zeros, instead of vanishing.
        const [affiliates] = await dbQuery(
          `SELECT a.promo_code,
                  a.promo_percent,
                  a.reward_amount AS reward_per_referral,
                  a.status,
                  COALESCE(NULLIF(TRIM(CONCAT_WS(' ', a.first_name, a.last_name)), ''), u.name) AS name,
                  u.email,
                  a.tiktok_link,
                  a.approved_at,
                  COUNT(r.id)::int                  AS referrals,
                  COALESCE(SUM(r.reward_amount), 0) AS rewards_total
             FROM affiliates a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN promo_redemptions r
                    ON r.affiliate_user_id = a.user_id
                   AND ($1::int IS NULL OR r.domain_id = $1)
            WHERE ($1::int IS NULL OR a.domain_id = $1)
              AND ($3::text IS NULL OR LOWER(a.status) = LOWER($3))
              AND ($2::text IS NULL
                   OR a.promo_code ILIKE '%' || $2 || '%'
                   OR u.email      ILIKE '%' || $2 || '%'
                   OR u.name       ILIKE '%' || $2 || '%'
                   OR a.first_name ILIKE '%' || $2 || '%'
                   OR a.last_name  ILIKE '%' || $2 || '%')
            GROUP BY a.id, a.promo_code, a.promo_percent, a.reward_amount, a.status,
                     a.first_name, a.last_name, u.name, u.email, a.tiktok_link, a.approved_at
            ORDER BY referrals DESC, rewards_total DESC
            LIMIT $4`,
          [...params, clampLimit(input.limit)],
        )

        const [requests] = await dbQuery(
          `SELECT q.user_email, q.status, q.promo_code, q.promo_percent,
                  COALESCE(NULLIF(TRIM(CONCAT_WS(' ', q.first_name, q.last_name)), ''), q.user_name) AS name,
                  q.tiktok_link, q.admin_note, q.decided_at, q.created_at
             FROM affiliate_requests q
            WHERE ($1::int IS NULL OR q.domain_id = $1)
              AND ($3::text IS NULL OR LOWER(q.status) = LOWER($3))
              AND ($2::text IS NULL
                   OR q.user_email ILIKE '%' || $2 || '%'
                   OR q.user_name  ILIKE '%' || $2 || '%'
                   OR q.first_name ILIKE '%' || $2 || '%'
                   OR q.last_name  ILIKE '%' || $2 || '%')
            ORDER BY (LOWER(q.status) = 'pending') DESC, q.created_at DESC
            LIMIT $4`,
          [...params, clampLimit(input.limit)],
        )

        const [countRows] = await dbQuery(
          `SELECT (SELECT COUNT(*)::int FROM affiliates a
                    WHERE ($1::int IS NULL OR a.domain_id = $1))     AS affiliate_count,
                  (SELECT COUNT(*)::int FROM affiliate_requests q
                    WHERE ($1::int IS NULL OR q.domain_id = $1)
                      AND LOWER(q.status) = 'pending')               AS pending_requests`,
          [domainId ?? null],
        )

        return JSON.stringify({
          affiliate_count: countRows[0]?.affiliate_count ?? 0,
          pending_requests: countRows[0]?.pending_requests ?? 0,
          affiliates,
          applications: requests,
        })
      },
    },

    {
      name: 'query_promos',
      description:
        'Discount / promo codes and how often they have been redeemed. Use this for ' +
        '"what promo codes do we have", "is code X still active", "how many times was ' +
        'X used", "which discount code performs best", "how much have we given away in ' +
        'discounts". A code is either created manually by an admin or issued to an ' +
        'affiliate, which the source field says. Codes have NO expiry date — only an ' +
        'active/inactive flag — so never say that a code expires.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Promo code or part of one, matched case-insensitively.' },
          active_only: { type: 'string', description: 'Pass "yes" to return only codes that are currently active.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [domainId ?? null, nullableText(input.code), nullableText(input.active_only)]

        // Redemptions join on the code TEXT, not an id — promo_redemptions
        // stores promo_code as a string snapshot taken at checkout.
        const [rows] = await dbQuery(
          `SELECT c.code,
                  c.percent,
                  c.source,
                  c.is_active,
                  c.created_at,
                  COUNT(r.id)::int                  AS redemptions,
                  COALESCE(SUM(r.reward_amount), 0) AS rewards_total,
                  MAX(r.created_at)                 AS last_used_at
             FROM promo_codes c
             LEFT JOIN promo_redemptions r
                    ON LOWER(r.promo_code) = LOWER(c.code)
                   AND ($1::int IS NULL OR r.domain_id = $1)
            WHERE ($1::int IS NULL OR c.domain_id = $1)
              AND ($2::text IS NULL OR c.code ILIKE '%' || $2 || '%')
              AND (LOWER(COALESCE($3, 'no')) <> 'yes' OR c.is_active)
            GROUP BY c.id, c.code, c.percent, c.source, c.is_active, c.created_at
            ORDER BY redemptions DESC, c.created_at DESC
            LIMIT $4`,
          [...params, clampLimit(input.limit)],
        )

        const [summaryRows] = await dbQuery(
          `SELECT (SELECT COUNT(*)::int FROM promo_codes c
                    WHERE ($1::int IS NULL OR c.domain_id = $1))     AS total_codes,
                  (SELECT COUNT(*)::int FROM promo_codes c
                    WHERE ($1::int IS NULL OR c.domain_id = $1)
                      AND c.is_active)                               AS active_codes,
                  (SELECT COUNT(*)::int FROM promo_redemptions r
                    WHERE ($1::int IS NULL OR r.domain_id = $1))     AS total_redemptions`,
          [domainId ?? null],
        )

        const summary = summaryRows[0] ?? { total_codes: 0, active_codes: 0, total_redemptions: 0 }
        return JSON.stringify({
          total_codes: summary.total_codes,
          active_codes: summary.active_codes,
          total_redemptions: summary.total_redemptions,
          returned: rows.length,
          codes: rows,
        })
      },
    },

    {
      name: 'query_credits',
      description:
        'Store credit held by customers, and the ledger of how it was granted or ' +
        'spent. Use this for "who has store credit", "how much credit is outstanding", ' +
        '"why does X have credit", "how much credit have we given away", "what credit ' +
        'did we issue this month". Store credit is money the customer can spend on a ' +
        'future order; a spent credit shows as a negative ledger amount. This is NOT ' +
        'the same as a refund and NOT the same as a discount code.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Customer email or name, partial match. Omit to list the largest balances.' },
          from: { type: 'string', description: 'Start of ledger date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of ledger date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [domainId ?? null, nullableText(input.search), toDate(input.from), toDate(input.to)]

        // NEITHER user_credits NOR credit_ledger carries a domain_id — verified
        // against the live schema. The ONLY way to scope these to a storefront is
        // through users.domain_id, so the join to users is a security boundary,
        // not a convenience. Do not turn it into a LEFT JOIN: an orphaned credit
        // row with no matching user would then appear under every domain.
        const [balances] = await dbQuery(
          `SELECT u.email, u.name, c.balance, c.updated_at
             FROM user_credits c
             JOIN users u ON u.id = c.user_id
            WHERE ($1::int IS NULL OR u.domain_id = $1)
              AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%')
            ORDER BY c.balance DESC
            LIMIT $3`,
          [params[0], params[1], clampLimit(input.limit)],
        )

        const [ledger] = await dbQuery(
          `SELECT u.email, l.amount, l.source, l.order_number, l.admin_username,
                  l.note, l.created_at
             FROM credit_ledger l
             JOIN users u ON u.id = l.user_id
            WHERE ($1::int IS NULL OR u.domain_id = $1)
              AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%')
              AND ($3::timestamptz IS NULL OR l.created_at >= $3)
              AND ($4::timestamptz IS NULL OR l.created_at < ($4::timestamptz + INTERVAL '1 day'))
            ORDER BY l.created_at DESC
            LIMIT $5`,
          [...params, clampLimit(input.limit)],
        )

        const [totals] = await dbQuery(
          `SELECT COUNT(*)::int                                   AS customers_with_credit,
                  COALESCE(SUM(c.balance), 0)                     AS total_outstanding
             FROM user_credits c
             JOIN users u ON u.id = c.user_id
            WHERE ($1::int IS NULL OR u.domain_id = $1)
              AND c.balance > 0`,
          [domainId ?? null],
        )

        return JSON.stringify({
          customers_with_credit: totals[0]?.customers_with_credit ?? 0,
          total_outstanding: totals[0]?.total_outstanding ?? 0,
          balances,
          recent_ledger_entries: ledger,
        })
      },
    },

    {
      name: 'query_wholesale_orders',
      description:
        'Wholesale (B2B / bulk) orders. WHOLESALE IS A SEPARATE BUSINESS from the ' +
        'retail shop: these are different orders in a different table, identified by ' +
        'an order_code rather than an order_number. NEVER add wholesale figures to ' +
        'retail figures, and never use this tool for an unqualified question about ' +
        '"orders" — that means retail, so use query_orders. Use this only when the ' +
        'admin says wholesale, bulk, B2B, or trade. Tracks payment as three separate ' +
        'amounts: total_payment, received_payment and pending_payment (what is owed).',
      parameters: {
        type: 'object',
        properties: {
          order_code: { type: 'string', description: 'Exact wholesale order code.' },
          email: { type: 'string', description: 'Wholesale customer email, partial match.' },
          status: { type: 'string', description: 'Order status, e.g. "pending". Omit for all.' },
          country: { type: 'string', description: 'Destination country, partial match.' },
          from: { type: 'string', description: 'Start of order date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of order date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.order_code),
          nullableText(input.email),
          nullableText(input.status),
          nullableText(input.country),
          toDate(input.from),
          toDate(input.to),
        ]

        const where = `
            ($1::int IS NULL OR w.domain_id = $1)
        AND ($2::text IS NULL OR w.order_code = $2)
        AND ($3::text IS NULL OR w.email ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR LOWER(w.status) = LOWER($4))
        AND ($5::text IS NULL OR w.country ILIKE '%' || $5 || '%')
        AND ($6::timestamptz IS NULL OR w.created_at >= $6)
        AND ($7::timestamptz IS NULL OR w.created_at < ($7::timestamptz + INTERVAL '1 day'))`

        const [summary] = await dbQuery(
          `SELECT w.currency,
                  w.status,
                  COUNT(*)::int                        AS order_count,
                  COALESCE(SUM(w.grand_total), 0)      AS total_value,
                  COALESCE(SUM(w.received_payment), 0) AS received,
                  COALESCE(SUM(w.pending_payment), 0)  AS outstanding
             FROM wholesale_orders w
            WHERE ${where}
            GROUP BY w.currency, w.status
            ORDER BY total_value DESC`,
          params,
        )

        // Items carry no domain_id of their own; they inherit scope from the
        // parent order, which is why they are aggregated per order rather than
        // queried directly.
        const [rows] = await dbQuery(
          `SELECT w.order_code,
                  TRIM(CONCAT_WS(' ', w.first_name, w.last_name)) AS customer,
                  w.email, w.country, w.city, w.status, w.currency,
                  w.grand_total, w.received_payment, w.pending_payment,
                  w.delivery_date, w.created_at,
                  COALESCE(i.item_count, 0)::int AS item_count,
                  COALESCE(i.units, 0)::int      AS units
             FROM wholesale_orders w
             LEFT JOIN (
                   SELECT wholesale_order_id,
                          COUNT(*)      AS item_count,
                          SUM(quantity) AS units
                     FROM wholesale_order_items
                    GROUP BY wholesale_order_id
             ) i ON i.wholesale_order_id = w.id
            WHERE ${where}
            ORDER BY w.created_at DESC
            LIMIT $8`,
          [...params, clampLimit(input.limit)],
        )

        const total = summary.reduce((n, r) => n + r.order_count, 0)
        return JSON.stringify({
          total_matching: total,
          by_status: summary,
          returned: rows.length,
          truncated: total > rows.length,
          wholesale_orders: rows,
        })
      },
    },

    {
      name: 'get_wholesale_inventory',
      description:
        'Wholesale stock: finished-product component counts per product and country, ' +
        'plus raw-material stock on hand, plus the wholesale product list with trade ' +
        'prices. Use this for "how much wholesale stock do we have", "are we low on ' +
        'raw materials", "how many cartridges/pens/needles are left", "what do we ' +
        'charge wholesale for X". This is the WHOLESALE side only — for retail shop ' +
        'stock use query_products instead.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Product name, product code or raw material name, partial match.' },
          country: { type: 'string', description: 'Stock location country, partial match.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const search = nullableText(input.search)
        const country = nullableText(input.country)

        // None of these three tables has a domain_id — verified against the live
        // schema. Wholesale stock is genuinely global, so no store filter can be
        // applied here. The returned note says so, because silently ignoring the
        // admin's store selection would otherwise look like a bug.
        const [inventory] = await dbQuery(
          `SELECT product_name, country, cartridge, leaflet, magnet_box, pen,
                  solution, needles, powder, updated_at
             FROM wholesale_product_inventory
            WHERE ($1::text IS NULL OR product_name ILIKE '%' || $1 || '%')
              AND ($2::text IS NULL OR country ILIKE '%' || $2 || '%')
            ORDER BY product_name, country
            LIMIT $3`,
          [search, country, clampLimit(input.limit)],
        )

        const [materials] = await dbQuery(
          `SELECT s.material_name, s.on_hand, m.unit, s.updated_at
             FROM wholesale_raw_material_stock s
             LEFT JOIN wholesale_raw_materials m ON m.name = s.material_name
            WHERE ($1::text IS NULL OR s.material_name ILIKE '%' || $1 || '%')
            ORDER BY s.on_hand ASC
            LIMIT $2`,
          [search, clampLimit(input.limit)],
        )

        const [products] = await dbQuery(
          `SELECT code, title, unit_price, currency, is_active
             FROM wholesale_products
            WHERE ($1::text IS NULL OR title ILIKE '%' || $1 || '%' OR code ILIKE '%' || $1 || '%')
            ORDER BY is_active DESC, title
            LIMIT $2`,
          [search, clampLimit(input.limit)],
        )

        return JSON.stringify({
          product_inventory: inventory,
          raw_materials: materials,
          wholesale_products: products,
        })
      },
    },

    {
      name: 'query_wholesale_production',
      description:
        'Wholesale production: the team members who assemble orders, and the work ' +
        'allocated to each of them. Use this for "who is working on what", "how much ' +
        'work is allocated to X", "who is on the wholesale team", "what is in ' +
        'production". Only relevant to the wholesale side of the business.',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'Team member name, partial match. Omit for the whole team.' },
          order_code: { type: 'string', description: 'Restrict allocations to one wholesale order code.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const member = nullableText(input.member)
        const orderCode = nullableText(input.order_code)

        // wholesale_team_members has no domain_id; the allocation rows reach a
        // domain only through the parent wholesale order, which is where the
        // scope filter is applied.
        const [team] = await dbQuery(
          `SELECT t.display_name, t.role, t.is_active,
                  COUNT(a.id)::int                       AS allocations,
                  COALESCE(SUM(a.quantity_assigned), 0)::int AS units_assigned
             FROM wholesale_team_members t
             LEFT JOIN wholesale_work_allocations a ON a.team_member_id = t.id
            WHERE ($1::text IS NULL OR t.display_name ILIKE '%' || $1 || '%')
            GROUP BY t.id, t.display_name, t.role, t.is_active
            ORDER BY units_assigned DESC, t.display_name
            LIMIT $2`,
          [member, clampLimit(input.limit)],
        )

        const [allocations] = await dbQuery(
          `SELECT w.order_code, t.display_name AS member, i.product_title,
                  a.quantity_assigned, a.note, a.created_at
             FROM wholesale_work_allocations a
             JOIN wholesale_orders w      ON w.id = a.wholesale_order_id
             JOIN wholesale_team_members t ON t.id = a.team_member_id
             LEFT JOIN wholesale_order_items i ON i.id = a.wholesale_order_item_id
            WHERE ($1::int IS NULL OR w.domain_id = $1)
              AND ($2::text IS NULL OR t.display_name ILIKE '%' || $2 || '%')
              AND ($3::text IS NULL OR w.order_code = $3)
            ORDER BY a.created_at DESC
            LIMIT $4`,
          [domainId ?? null, member, orderCode, clampLimit(input.limit)],
        )

        return JSON.stringify({
          team,
          recent_allocations: allocations,
        })
      },
    },

    {
      name: 'query_wholesale_inquiries',
      description:
        'Inbound wholesale enquiries — potential B2B customers who submitted the ' +
        'wholesale contact form but have not necessarily ordered. Use this for "any ' +
        'wholesale enquiries", "who is asking about bulk orders", "wholesale leads ' +
        'this month", "which countries are asking about wholesale". These are LEADS, ' +
        'not orders: for actual wholesale orders use query_wholesale_orders.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Name or email, partial match.' },
          country: { type: 'string', description: 'Country, partial match.' },
          from: { type: 'string', description: 'Start of submission date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
          to: { type: 'string', description: 'End of submission date range, inclusive. YYYY-MM-DD. Never invent a date: if the admin named no date, omit this parameter entirely.' },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const params = [
          domainId ?? null,
          nullableText(input.search),
          nullableText(input.country),
          toDate(input.from),
          toDate(input.to),
        ]

        // submitted_at is `timestamp without time zone` here, unlike the
        // timestamptz columns elsewhere — hence the ::timestamp casts.
        const where = `
            ($1::int IS NULL OR q.domain_id = $1)
        AND ($2::text IS NULL OR q.name ILIKE '%' || $2 || '%' OR q.email ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR q.country ILIKE '%' || $3 || '%')
        AND ($4::timestamp IS NULL OR q.submitted_at >= $4::timestamp)
        AND ($5::timestamp IS NULL OR q.submitted_at < ($5::timestamp + INTERVAL '1 day'))`

        const [countRows] = await dbQuery(
          `SELECT COUNT(*)::int AS total FROM wholesale_inquiries q WHERE ${where}`,
          params,
        )

        const [byCountry] = await dbQuery(
          `SELECT q.country, COUNT(*)::int AS count
             FROM wholesale_inquiries q
            WHERE ${where}
            GROUP BY q.country
            ORDER BY count DESC
            LIMIT 20`,
          params,
        )

        const [rows] = await dbQuery(
          `SELECT q.name, q.email, q.contact, q.quantity, q.country, q.submitted_at
             FROM wholesale_inquiries q
            WHERE ${where}
            ORDER BY q.submitted_at DESC
            LIMIT $6`,
          [...params, clampLimit(input.limit)],
        )

        const total = countRows[0]?.total ?? 0
        return JSON.stringify({
          total_matching: total,
          by_country: byCountry,
          returned: rows.length,
          truncated: total > rows.length,
          inquiries: rows,
        })
      },
    },
  ]
}
