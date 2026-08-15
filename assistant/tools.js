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

const DEFAULT_ROWS = 10
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

const RECEIVED_STATUSES = [
  'paid', 'succeeded', 'success', 'completed', 'complete', 'captured', 'approved', 'verified', 'received',
]

export function buildTools({ dbQuery, domainId }) {
  return [
    {
      name: 'query_orders',
      description:
        'Look up individual retail orders. Use this when the admin asks about a ' +
        'specific order, a specific customer\'s orders, or wants to see a list of ' +
        'orders matching some filter (status, payment status, date range, country). ' +
        'Returns at most 10 rows, newest first, plus `total_matching` — the true ' +
        'count of ALL matches, which is accurate even when the row list is ' +
        'truncated, so use that field for counts. Do NOT use this to compute ' +
        'revenue totals — use get_revenue_stats, which aggregates over all matching ' +
        'rows rather than just the first 50.',
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
          from: { type: 'string', description: 'Start of created_at range, inclusive. YYYY-MM-DD.' },
          to: { type: 'string', description: 'End of created_at range, inclusive. YYYY-MM-DD.' },
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
                  o.payment_method, o.tracking_number, o.created_at
             FROM orders o
            WHERE ${where}
            ORDER BY o.created_at DESC
            LIMIT $9`,
          [...params, clampLimit(input.limit)],
        )

        const total = countRows[0]?.total ?? 0
        return JSON.stringify({
          total_matching: total,
          returned: rows.length,
          truncated: total > rows.length,
          orders: rows,
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
          from: { type: 'string', description: 'Start of range, inclusive. YYYY-MM-DD. Omit for all time.' },
          to: { type: 'string', description: 'End of range, inclusive. YYYY-MM-DD. Omit for up to now.' },
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

        return JSON.stringify({
          range: { from: input.from ?? 'all time', to: input.to ?? 'now' },
          by_currency_order_value: orderRows,
          by_currency_confirmed_payments: paymentRows,
          note: 'order_value counts orders placed regardless of payment outcome; confirmed_payments counts money actually received.',
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
          mode: search ? 'search' : 'top customers by lifetime spend',
          matches: rows.length,
          customers: rows,
          note: 'Sorted by lifetime spend, highest first. A customer with orders in multiple currencies appears once per currency.',
        })
      },
    },
  ]
}
