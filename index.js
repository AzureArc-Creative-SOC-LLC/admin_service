import express from 'express'
import cors from 'cors'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import multer from 'multer'
import { fileURLToPath } from 'url'
import { buildHasInvoiceMaskedItems, buildIbalticxMaskedItems, sendCustomerInfoEmail, sendEmail, sendHasInvoiceEmail, sendIbalticxEmail, sendNewsletterWinnerEmail, sendOutForDeliveryEmail, sendPaymentDeclinedEmail, sendPaymentReminderEmail, sendPaymentSuccessfulEmail, sendRefundInitiatedEmail } from './emailService.js'
import { createDomainMiddleware } from './domainMiddleware.js'
import { registerAssistant } from './assistant/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Prefer backend/.env if present, otherwise fall back to project root .env.
// Allows override via DOTENV_PATH.
const dotenvCandidates = [
  process.env.DOTENV_PATH,
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
].filter(Boolean)

for (const p of dotenvCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: true })
    break
  }
}

async function ensureCustomerCreditsSchema() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS user_credits (
        user_id INT NOT NULL,
        balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id),
        CONSTRAINT fk_user_credits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure user_credits table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id BIGSERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        source VARCHAR(50) NOT NULL,
        order_number VARCHAR(64) NULL,
        admin_username VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_credit_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure credit_ledger table:', msg)
    }
  }

  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }
  try {
    await dbQuery('ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_applied DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure orders.credits_applied:', e?.message || String(e))
  }
  try {
    await dbQuery('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_before_credits DECIMAL(12,2) NULL')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure orders.total_before_credits:', e?.message || String(e))
  }
}

function env(name, fallback = '') {
  const v = process.env[name]
  if (v === undefined || v === null || String(v).trim() === '') return fallback
  return String(v)
}

const aabanpayRefundAuthToken = (rawKey) => Buffer.from(String(rawKey || ''), 'utf8').toString('base64')

async function aabanpayRefundTransaction({ transactionId, amount }) {
  const key = String(env('AABANPAY_API_KEY') || '').trim()
  if (!key) return { ok: false, status: 500, error: 'AabanPay API key not configured' }

  const auth = aabanpayRefundAuthToken(key)
  const base = String(env('AABANPAY_REFUND_BASE', 'https://aabanpay.com/rest/v1/transactions/refund')).trim().replace(/\/$/, '')
  const url = `${base}/${encodeURIComponent(String(transactionId).trim())}`

  const body = new URLSearchParams({ Authorization: auth, amount: String(amount) }).toString()

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body,
  })

  const text = await response.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: `AabanPay refund failed (${response.status})`, provider: data || text }
  }

  return { ok: true, status: response.status, provider: data || text }
}

function fetchTimeoutMs() {
  const v = Number(env('PAYMENT_CAPTURE_VERIFY_TIMEOUT_MS', '25000'))
  return Number.isFinite(v) && v > 1000 ? v : 25000
}

async function fetchJsonWithTimeout(url, opts = {}) {
  const ms = fetchTimeoutMs()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  } finally {
    clearTimeout(t)
  }
}

async function postExternalInvoice(payload) {
  // Disabled: no outbound requests should be sent to external invoice endpoints.
  return { ok: false, status: 410, data: { error: 'External invoice endpoint disabled' } }
}

async function postExternalHasEntry(payload) {
  // Disabled: no outbound requests should be sent to external invoice endpoints.
  return { ok: false, status: 410, data: { error: 'External HAS entry endpoint disabled' } }
}

function envInt(name, fallback) {

  
  const raw = env(name, '')
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const PORT = envInt('ADMIN_SERVICE_PORT', envInt('PORT', 5001))

const DATABASE_URL = env('DATABASE_URL', '')

const JWT_SECRET = env('JWT_SECRET', '')
if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in environment')
}

// Any restart rotates this value, invalidating all previously issued admin tokens.
const ADMIN_SESSION_VERSION = crypto.randomBytes(16).toString('hex')

const corsOrigin = env('CORS_ORIGIN', '*')

const UPLOADS_DIR = env('UPLOADS_DIR', '/var/www/backend/uploads')
const PUBLIC_BASE_URL = env('PUBLIC_BASE_URL', '')

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '2mb' }))

app.use(
  cors({
    origin: (origin, callback) => {
      if (corsOrigin === '*' || !origin) return callback(null, true)
      const allowed = corsOrigin.split(',').map((s) => s.trim()).filter(Boolean)
      if (allowed.includes(origin)) return callback(null, true)
      callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    credentials: true,
  })
)

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in environment — set it to your Supabase PostgreSQL connection string')
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: envInt('DB_POOL_LIMIT', 10),
  ssl: { rejectUnauthorized: false },
})

// Pool query helper — returns [rows] for SELECT, [{affectedRows, insertId}] for DML.
async function dbQuery(sql, params) {
  const result = await pool.query(sql, params ?? [])
  const isSelect = /^\s*(SELECT|WITH|SHOW)/i.test(sql.trim())
  if (isSelect) return [result.rows]
  return [{ affectedRows: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, insertId: result.rows?.[0]?.id ?? null, rows: result.rows }]
}

// Transaction client query helper — same semantics as dbQuery but on a client.
async function dbQueryConn(client, sql, params) {
  const result = await client.query(sql, params ?? [])
  const isSelect = /^\s*(SELECT|WITH|SHOW)/i.test(sql.trim())
  if (isSelect) return [result.rows]
  return [{ affectedRows: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, insertId: result.rows?.[0]?.id ?? null, rows: result.rows }]
}

const domainMiddleware = createDomainMiddleware({
  lookupDomain: async (name) => {
    const [rows] = await dbQuery('SELECT id, status FROM domains WHERE domain_name = $1', [name])
    return rows[0] || null
  },
})
app.use(domainMiddleware)

// Admin-only explicit domain filter: unlike storefront services, admin callers
// are the internal dashboard (not a storefront origin), so domain scoping here
// must come from an explicit ?domain / ?domain_id query param, never Origin
// auto-detection. Returns null when the caller didn't ask for a filter, which
// must mean "no restriction" so the existing admin frontend keeps working.
// Domain name -> id barely ever changes, so a short in-process cache avoids
// re-querying it on every single admin request (each request resolves it once).
const DOMAIN_ID_CACHE_TTL_MS = envInt('DOMAIN_ID_CACHE_TTL_MS', 5 * 60 * 1000)
const domainIdCache = new Map()

async function resolveAdminDomainFilter(req) {
  const rawId = req.query?.domain_id
  if (rawId != null && String(rawId).trim() !== '') {
    const id = Number(rawId)
    return Number.isFinite(id) && id > 0 ? id : null
  }
  const rawName = req.query?.domain
  if (rawName) {
    const name = String(rawName).trim().toLowerCase()
    const cached = domainIdCache.get(name)
    if (cached && Date.now() < cached.expires) return cached.id
    const [rows] = await dbQuery('SELECT id FROM domains WHERE domain_name = $1', [name])
    const id = rows[0]?.id ?? null
    domainIdCache.set(name, { id, expires: Date.now() + DOMAIN_ID_CACHE_TTL_MS })
    return id
  }
  return null
}

// Resolves a domains.id back to its domain_name, so order-specific emails
// (payment links, reminders, decline notices) can be branded/sent as the
// storefront the order actually came from instead of a hardcoded sender.
const domainNameByIdCache = new Map()
async function resolveDomainNameById(domainId) {
  if (domainId == null) return null
  if (domainNameByIdCache.has(domainId)) return domainNameByIdCache.get(domainId)
  try {
    const [rows] = await dbQuery('SELECT domain_name FROM domains WHERE id = $1', [domainId])
    const name = rows[0]?.domain_name || null
    domainNameByIdCache.set(domainId, name)
    return name
  } catch {
    return null
  }
}

// Per-domain "from" address/name, using admin-service's own copy of the
// brand registry (./brand-config.js) so a customer always sees the brand
// they actually ordered from. This must stay a local copy, not an import
// from ../../shared-email — that package is deployed on a separate VPS
// instance and isn't reachable from here in production. Loaded
// lazily/defensively — a domain with no brand entry (or the module being
// unreachable) just falls back to admin-service's existing default sender.
let brandConfigModulePromise = null
async function resolveBrandFromForDomain(domainName) {
  if (!domainName) return null
  try {
    if (!brandConfigModulePromise) brandConfigModulePromise = import('./brand-config.js')
    const mod = await brandConfigModulePromise
    const brand = mod.getBrandConfig(domainName)
    return { from: brand.from, fromName: brand.fromName, website: brand.website }
  } catch (e) {
    console.warn('[admin-service] no brand config for domain', domainName, e?.message || e)
    return null
  }
}

// Short-lived cache for read-heavy dashboard aggregate endpoints. Dashboard
// analytics don't need per-second freshness, and this avoids re-running
// expensive aggregate queries every time an admin flips the domain/range filter.
const DASHBOARD_CACHE_TTL_MS = envInt('DASHBOARD_CACHE_TTL_MS', 20 * 1000)

// Cache keys embed caller-supplied values (domain, range, ?since), so the map
// needs a ceiling or a client varying them grows it without bound. Entries are
// also only evicted lazily when their own key is read again, which means keys
// that are never requested a second time would otherwise linger forever.
const DASHBOARD_CACHE_MAX_ENTRIES = envInt('DASHBOARD_CACHE_MAX_ENTRIES', 500)
const dashboardCache = new Map()

function getCachedDashboard(key) {
  const entry = dashboardCache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expires) {
    dashboardCache.delete(key)
    return undefined
  }
  return entry.value
}

function setCachedDashboard(key, value) {
  if (!dashboardCache.has(key) && dashboardCache.size >= DASHBOARD_CACHE_MAX_ENTRIES) {
    const now = Date.now()
    for (const [k, entry] of dashboardCache) {
      if (now > entry.expires) dashboardCache.delete(k)
    }
    // Still at the ceiling with nothing expired: evict oldest-inserted first
    // (Map iterates in insertion order) to make room.
    while (dashboardCache.size >= DASHBOARD_CACHE_MAX_ENTRIES) {
      const oldest = dashboardCache.keys().next()
      if (oldest.done) break
      dashboardCache.delete(oldest.value)
    }
  }
  dashboardCache.set(key, { value, expires: Date.now() + DASHBOARD_CACHE_TTL_MS })
}

app.get('/api/admin/domains', requireAuth, async (_req, res) => {
  try {
    const [rows] = await dbQuery('SELECT id, domain_name, status FROM domains ORDER BY domain_name ASC')
    return res.json({ success: true, domains: rows })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch domains' })
  }
})

// ─── Dashboard: KPI / analytics endpoints ────────────────────────────────
// All domain-scoped via resolveAdminDomainFilter (?domain / ?domain_id), same
// convention as every other admin-scoped endpoint. `products` has no
// domain_id column (catalog is global), so inventory figures are store-wide
// regardless of the domain filter.
const DASHBOARD_RECEIVED_STATUSES = [
  'paid', 'succeeded', 'success', 'completed', 'complete', 'captured', 'approved', 'verified', 'received',
]
const DASHBOARD_FAILED_STATUSES = [
  'rejected', 'reject', 'declined', 'denied', 'failed', 'cancelled', 'canceled',
]
const LOW_STOCK_THRESHOLD = 5

app.get('/api/admin/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `summary:${domainId ?? 'all'}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const ordersDomainParams = domainId != null ? [domainId] : []
    const ordersDomainClause = domainId != null ? 'AND domain_id = $1' : ''

    const successParams = [...DASHBOARD_RECEIVED_STATUSES]
    let successDomainClause = ''
    if (domainId != null) { successParams.push(domainId); successDomainClause = `AND o.domain_id = $${successParams.length}` }
    const successPlaceholders = DASHBOARD_RECEIVED_STATUSES.map((_, i) => '$' + (i + 1)).join(',')

    const failedParams = [...DASHBOARD_FAILED_STATUSES]
    let failedDomainClause = ''
    if (domainId != null) { failedParams.push(domainId); failedDomainClause = `AND o.domain_id = $${failedParams.length}` }
    const failedPlaceholders = DASHBOARD_FAILED_STATUSES.map((_, i) => '$' + (i + 1)).join(',')

    const refundParams = []
    let refundDomainClause = ''
    if (domainId != null) { refundParams.push(domainId); refundDomainClause = `AND o.domain_id = $${refundParams.length}` }

    const linksParams = []
    let linksDomainClause = ''
    if (domainId != null) { linksParams.push(domainId); linksDomainClause = `AND domain_id = $${linksParams.length}` }

    const affiliatesParams = []
    let affiliatesDomainClause = ''
    if (domainId != null) { affiliatesParams.push(domainId); affiliatesDomainClause = `WHERE a.domain_id = $${affiliatesParams.length}` }

    const wholesaleParams = []
    let wholesaleDomainClause = ''
    if (domainId != null) { wholesaleParams.push(domainId); wholesaleDomainClause = `WHERE domain_id = $${wholesaleParams.length}` }

    // The affiliate and wholesale tables are provisioned lazily elsewhere , so a missing
    // table must not take down the whole summary — most of the dashboard depends
    // on it. Each of these degrades to a neutral value on its own.
    const safe = (promise, fallback) => promise.then((r) => r, () => fallback)

    const [
      [todayRows], [weekRows], [monthRows], [aovRows], [customerRows], [orderStatusRows],
      [successRows], [failedRows], [refundRows], [outstandingRows], [pendingLinksRows], [inventoryRows],
      [returningRows], [recentCustomerRows], [affiliatesRows], [wholesaleRows],
    ] = await Promise.all([
      dbQuery(
        `SELECT COALESCE(SUM(total),0) AS amount, COUNT(*) AS count FROM orders WHERE created_at >= CURRENT_DATE ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT COALESCE(SUM(total),0) AS amount, COUNT(*) AS count FROM orders WHERE created_at >= (CURRENT_DATE - INTERVAL '6 days') ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT COALESCE(SUM(total),0) AS amount, COUNT(*) AS count FROM orders WHERE created_at >= date_trunc('month', CURRENT_DATE) ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT COALESCE(AVG(total),0) AS avg_order_value FROM orders WHERE 1=1 ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT
           COUNT(*) AS total_customers,
           COUNT(*) FILTER (WHERE first_order_at >= (NOW() - INTERVAL '30 days')) AS new_customers_30d
         FROM (
           SELECT LOWER(TRIM(customer_email)) AS email, MIN(created_at) AS first_order_at
           FROM orders
           WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> '' ${ordersDomainClause}
           GROUP BY LOWER(TRIM(customer_email))
         ) c`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS new_today,
           COUNT(*) FILTER (WHERE LOWER(status) = 'pending') AS pending,
           -- 'in_progress' is the wholesale_orders vocabulary and was never written
           -- to this table; it is kept only so any legacy row still lands somewhere.
           COUNT(*) FILTER (WHERE LOWER(status) IN ('processing','in_progress')) AS processing,
           COUNT(*) FILTER (WHERE LOWER(status) = 'dispatched') AS dispatched,
           COUNT(*) FILTER (WHERE LOWER(status) = 'delivered') AS delivered,
           COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
           COUNT(*) FILTER (
             WHERE LOWER(COALESCE(status,'')) NOT IN
               ('pending','processing','in_progress','dispatched','delivered','cancelled')
           ) AS other,
           COUNT(*) AS total
         FROM orders WHERE 1=1 ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT COUNT(*) AS count, COALESCE(SUM(pay.amount),0) AS amount FROM payments pay INNER JOIN orders o ON o.id = pay.order_id
         WHERE LOWER(pay.status) IN (${successPlaceholders}) ${successDomainClause}`,
        successParams
      ),
      dbQuery(
        `SELECT COUNT(*) AS count FROM payments pay INNER JOIN orders o ON o.id = pay.order_id
         WHERE LOWER(pay.status) IN (${failedPlaceholders}) ${failedDomainClause}`,
        failedParams
      ),
      dbQuery(
        `SELECT COALESCE(SUM(pay.amount),0) AS amount, COUNT(*) AS count
         FROM payments pay INNER JOIN orders o ON o.id = pay.order_id
         WHERE LOWER(pay.status) = 'refunded' ${refundDomainClause}`,
        refundParams
      ),
      dbQuery(
        `SELECT COALESCE(SUM(total),0) AS amount, COUNT(*) AS count FROM orders
         WHERE LOWER(payment_status) IN ('pending','unpaid') ${ordersDomainClause}`,
        ordersDomainParams
      ),
      dbQuery(
        `SELECT COUNT(*) AS count FROM payment_capture_requests
         WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ${linksDomainClause}`,
        linksParams
      ),
      dbQuery(
        `SELECT
           COUNT(*) AS total_products,
           COUNT(*) FILTER (WHERE is_enabled::text IN ('1','true','t')) AS active_products,
           COUNT(*) FILTER (WHERE stock_qty IS NOT NULL AND stock_qty > 0 AND stock_qty <= ${LOW_STOCK_THRESHOLD}) AS low_stock_products,
           COUNT(*) FILTER (WHERE in_stock::text IN ('0','false','f') OR stock_qty = 0) AS out_of_stock_products
         FROM products`
      ),
      // Customers with more than one order. The dashboard used to derive this by
      // downloading 500 customer rows and filtering in JS, which silently capped
      // the figure at 500; counted in SQL there is no cap.
      dbQuery(
        `SELECT COUNT(*) AS returning_customers
         FROM (
           SELECT 1
           FROM orders
           WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> '' ${ordersDomainClause}
           GROUP BY LOWER(TRIM(customer_email))
           HAVING COUNT(*) > 1
         ) c`,
        ordersDomainParams
      ),
      // The six most recently active customers — the only place the dashboard
      // needed real rows rather than a total.
      dbQuery(
        `SELECT
           LOWER(TRIM(customer_email)) AS email,
           MAX(NULLIF(TRIM(customer_name), '')) AS customer_name,
           COUNT(*) AS orders_count,
           MAX(created_at) AS last_order_created_at
         FROM orders
         WHERE customer_email IS NOT NULL
           AND TRIM(customer_email) <> ''
           AND POSITION('@' IN customer_email) > 0 ${ordersDomainClause}
         GROUP BY LOWER(TRIM(customer_email))
         ORDER BY MAX(created_at) DESC
         LIMIT 6`,
        ordersDomainParams
      ),
      // Mirrors the joins /api/admin/affiliates uses for these four figures: the
      // inner join to users decides which affiliates count, and the redemption
      // rollup is deliberately not domain-scoped there either.
      safe(dbQuery(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE a.status = 'approved') AS active,
           COALESCE(SUM(COALESCE(r.total_earned, 0)), 0) AS rewards_paid,
           COALESCE(SUM(COALESCE(r.redemption_count, 0)), 0) AS promo_redemptions
         FROM affiliates a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN (
           SELECT affiliate_user_id,
                  COUNT(*)           AS redemption_count,
                  SUM(reward_amount) AS total_earned
           FROM promo_redemptions
           GROUP BY affiliate_user_id
         ) r ON r.affiliate_user_id = a.user_id
         ${affiliatesDomainClause}`,
        affiliatesParams
      ), [[{}]]),
      safe(dbQuery(
        `SELECT
           COUNT(*) AS orders,
           COUNT(DISTINCT LOWER(TRIM(email))) FILTER (WHERE email IS NOT NULL AND TRIM(email) <> '') AS customers,
           COALESCE(SUM(COALESCE(grand_total, 0)), 0) AS revenue
         FROM wholesale_orders
         ${wholesaleDomainClause}`,
        wholesaleParams
      ), [[{}]]),
    ])

    const row0 = (rows) => (Array.isArray(rows) && rows[0]) ? rows[0] : {}
    const today = row0(todayRows)
    const week = row0(weekRows)
    const month = row0(monthRows)
    const aov = row0(aovRows)
    const cust = row0(customerRows)
    const ord = row0(orderStatusRows)
    const inv = row0(inventoryRows)
    const aff = row0(affiliatesRows)
    const whl = row0(wholesaleRows)

    const payload = {
      sales: {
        todaySales: Number(today.amount || 0),
        todayOrders: Number(today.count || 0),
        weekSales: Number(week.amount || 0),
        weekOrders: Number(week.count || 0),
        monthSales: Number(month.amount || 0),
        monthOrders: Number(month.count || 0),
        avgOrderValue: Number(aov.avg_order_value || 0),
        totalCustomers: Number(cust.total_customers || 0),
        newCustomers30d: Number(cust.new_customers_30d || 0),
        returningCustomers: Number(row0(returningRows).returning_customers || 0),
      },
      orders: {
        newToday: Number(ord.new_today || 0),
        pending: Number(ord.pending || 0),
        processing: Number(ord.processing || 0),
        dispatched: Number(ord.dispatched || 0),
        delivered: Number(ord.delivered || 0),
        cancelled: Number(ord.cancelled || 0),
        // Catch-all so the named buckets always reconcile to `total`. NULL and
        // whitespace-padded statuses land here rather than silently vanishing.
        other: Number(ord.other || 0),
        total: Number(ord.total || 0),
      },
      payments: {
        successfulCount: Number(row0(successRows).count || 0),
        successfulAmount: Number(row0(successRows).amount || 0),
        failedCount: Number(row0(failedRows).count || 0),
        refundAmount: Number(row0(refundRows).amount || 0),
        refundCount: Number(row0(refundRows).count || 0),
        outstandingAmount: Number(row0(outstandingRows).amount || 0),
        outstandingCount: Number(row0(outstandingRows).count || 0),
        pendingPaymentLinks: Number(row0(pendingLinksRows).count || 0),
      },
      inventory: {
        totalProducts: Number(inv.total_products || 0),
        activeProducts: Number(inv.active_products || 0),
        lowStockProducts: Number(inv.low_stock_products || 0),
        outOfStockProducts: Number(inv.out_of_stock_products || 0),
        lowStockThreshold: LOW_STOCK_THRESHOLD,
      },
      affiliates: {
        total: Number(aff.total || 0),
        active: Number(aff.active || 0),
        rewardsPaid: Number(aff.rewards_paid || 0),
        promoRedemptions: Number(aff.promo_redemptions || 0),
      },
      wholesale: {
        orders: Number(whl.orders || 0),
        customers: Number(whl.customers || 0),
        revenue: Number(whl.revenue || 0),
      },
      recentCustomers: (Array.isArray(recentCustomerRows) ? recentCustomerRows : []).map((r) => ({
        email: String(r?.email || '').trim(),
        customer_name: String(r?.customer_name || '').trim(),
        orders_count: Number(r?.orders_count || 0),
        last_order_created_at: r?.last_order_created_at ?? null,
      })),
    }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    console.error('[admin-service] /api/admin/dashboard/summary failed:', e?.message || e)
    return res.status(500).json({ error: e?.message || 'Failed to fetch dashboard summary' })
  }
})

app.get('/api/admin/dashboard/trend', requireAuth, async (req, res) => {
  try {
    const daysRaw = Number(req.query?.days || 30)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 90) : 30
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `trend:${domainId ?? 'all'}:${days}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const params = [days]
    let domainClause = ''
    if (domainId != null) { params.push(domainId); domainClause = `AND domain_id = $${params.length}` }

    const prevParams = [days]
    let prevDomainClause = ''
    if (domainId != null) { prevParams.push(domainId); prevDomainClause = `AND domain_id = $${prevParams.length}` }

    const [[rows], [prevRows]] = await Promise.all([
      dbQuery(
        `SELECT DATE(created_at) AS day, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders
         FROM orders
         WHERE created_at >= (CURRENT_DATE - ($1 * INTERVAL '1 day')) ${domainClause}
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
        params
      ),
      dbQuery(
        `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders
         FROM orders
         WHERE created_at >= (CURRENT_DATE - ($1 * 2 * INTERVAL '1 day'))
           AND created_at < (CURRENT_DATE - ($1 * INTERVAL '1 day')) ${prevDomainClause}`,
        prevParams
      ),
    ])

    const series = (Array.isArray(rows) ? rows : []).map((r) => ({
      date: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      revenue: Number(r.revenue || 0),
      orders: Number(r.orders || 0),
    }))
    const current = series.reduce((acc, r) => ({ revenue: acc.revenue + r.revenue, orders: acc.orders + r.orders }), { revenue: 0, orders: 0 })
    const prev = (Array.isArray(prevRows) && prevRows[0]) ? prevRows[0] : { revenue: 0, orders: 0 }
    const previous = { revenue: Number(prev.revenue || 0), orders: Number(prev.orders || 0) }
    const pctChange = (curr, prior) => (prior > 0 ? ((curr - prior) / prior) * 100 : null)

    const payload = {
      series,
      current,
      previous,
      revenueChangePct: pctChange(current.revenue, previous.revenue),
      ordersChangePct: pctChange(current.orders, previous.orders),
    }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch trend' })
  }
})

app.get('/api/admin/dashboard/customer-growth', requireAuth, async (req, res) => {
  try {
    const daysRaw = Number(req.query?.days || 90)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 7), 365) : 90
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `customer-growth:${domainId ?? 'all'}:${days}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const params = [days]
    let domainClause = ''
    if (domainId != null) { params.push(domainId); domainClause = `AND domain_id = $${params.length}` }

    const [rows] = await dbQuery(
      `SELECT DATE(first_order_at) AS day, COUNT(*) AS new_customers
       FROM (
         SELECT LOWER(TRIM(customer_email)) AS email, MIN(created_at) AS first_order_at
         FROM orders
         WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> '' ${domainClause}
         GROUP BY LOWER(TRIM(customer_email))
       ) c
       WHERE first_order_at >= (CURRENT_DATE - ($1 * INTERVAL '1 day'))
       GROUP BY DATE(first_order_at)
       ORDER BY day ASC`,
      params
    )

    const series = (Array.isArray(rows) ? rows : []).map((r) => ({
      date: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      newCustomers: Number(r.new_customers || 0),
    }))

    const payload = { series }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch customer growth' })
  }
})

app.get('/api/admin/dashboard/top-products', requireAuth, async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit || 6)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20) : 6
    const sortDir = String(req.query?.sort || 'top').toLowerCase() === 'low' ? 'ASC' : 'DESC'
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `top-products:${domainId ?? 'all'}:${limit}:${sortDir}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const params = []
    let qtyExpr = 'COALESCE(SUM(oi.quantity),0)'
    let revExpr = 'COALESCE(SUM(oi.line_total),0)'
    if (domainId != null) {
      params.push(domainId)
      qtyExpr = `COALESCE(SUM(oi.quantity) FILTER (WHERE o.domain_id = $${params.length}), 0)`
      revExpr = `COALESCE(SUM(oi.line_total) FILTER (WHERE o.domain_id = $${params.length}), 0)`
    }

    const [rows] = await dbQuery(
      `SELECT
         p.id AS product_id,
         p.name,
         p.sku,
         p.image_url,
         ${qtyExpr} AS units_sold,
         ${revExpr} AS revenue
       FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN orders o ON o.id = oi.order_id
       WHERE p.is_enabled::text IN ('1','true','t')
       GROUP BY p.id, p.name, p.sku, p.image_url
       ORDER BY revenue ${sortDir}
       LIMIT ${limit}`,
      params
    )
    const payload = { products: Array.isArray(rows) ? rows : [] }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch top products' })
  }
})

app.get('/api/admin/dashboard/inventory', requireAuth, async (_req, res) => {
  try {
    const cacheKey = 'inventory'
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const [[lowStockRows], [outOfStockRows], [recentRows]] = await Promise.all([
      dbQuery(
        `SELECT id, name, sku, image_url, stock_qty, is_enabled
         FROM products
         WHERE stock_qty IS NOT NULL AND stock_qty > 0 AND stock_qty <= ${LOW_STOCK_THRESHOLD}
         ORDER BY stock_qty ASC LIMIT 20`
      ),
      dbQuery(
        `SELECT id, name, sku, image_url, stock_qty, is_enabled
         FROM products
         WHERE in_stock::text IN ('0','false','f') OR stock_qty = 0
         ORDER BY updated_at DESC LIMIT 20`
      ),
      dbQuery(
        `SELECT id, name, sku, image_url, stock_qty, is_enabled, created_at
         FROM products
         ORDER BY created_at DESC LIMIT 8`
      ),
    ])
    const payload = {
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      lowStock: Array.isArray(lowStockRows) ? lowStockRows : [],
      outOfStock: Array.isArray(outOfStockRows) ? outOfStockRows : [],
      recentlyAdded: Array.isArray(recentRows) ? recentRows : [],
    }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch inventory' })
  }
})

app.get('/api/admin/dashboard/payment-methods', requireAuth, async (req, res) => {
  try {
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `payment-methods:${domainId ?? 'all'}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const params = []
    let domainClause = ''
    if (domainId != null) { params.push(domainId); domainClause = `AND o.domain_id = $${params.length}` }
    const [rows] = await dbQuery(
      `SELECT COALESCE(NULLIF(TRIM(pay.provider), ''), 'Manual') AS provider, COUNT(*) AS count, COALESCE(SUM(pay.amount),0) AS amount
       FROM payments pay
       INNER JOIN orders o ON o.id = pay.order_id
       WHERE 1=1 ${domainClause}
       GROUP BY COALESCE(NULLIF(TRIM(pay.provider), ''), 'Manual')
       ORDER BY amount DESC`,
      params
    )
    const payload = { methods: Array.isArray(rows) ? rows : [] }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch payment methods' })
  }
})

app.get('/api/admin/dashboard/activity', requireAuth, async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit || 15)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50) : 15
    const domainId = await resolveAdminDomainFilter(req)

    const cacheKey = `activity:${domainId ?? 'all'}:${limit}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const orderParams = []
    let orderDomainClause = ''
    if (domainId != null) { orderParams.push(domainId); orderDomainClause = `AND domain_id = $${orderParams.length}` }

    const paymentParams = [...DASHBOARD_RECEIVED_STATUSES]
    let paymentDomainClause = ''
    if (domainId != null) { paymentParams.push(domainId); paymentDomainClause = `AND o.domain_id = $${paymentParams.length}` }
    const paymentPlaceholders = DASHBOARD_RECEIVED_STATUSES.map((_, i) => '$' + (i + 1)).join(',')

    const [[orderRows], [paymentRows], [productRows]] = await Promise.all([
      dbQuery(
        `SELECT id, order_number, customer_name, customer_email, total, currency, created_at
         FROM orders WHERE 1=1 ${orderDomainClause}
         ORDER BY created_at DESC LIMIT ${limit}`,
        orderParams
      ),
      dbQuery(
        `SELECT pay.id, pay.order_id, o.order_number, pay.amount, pay.currency, pay.status, pay.created_at
         FROM payments pay
         INNER JOIN orders o ON o.id = pay.order_id
         WHERE LOWER(pay.status) IN (${paymentPlaceholders}) ${paymentDomainClause}
         ORDER BY pay.created_at DESC LIMIT ${limit}`,
        paymentParams
      ),
      dbQuery(
        `SELECT id, name, sku, created_at FROM products ORDER BY created_at DESC LIMIT ${limit}`
      ),
    ])

    const activity = [
      ...(Array.isArray(orderRows) ? orderRows : []).map((r) => ({
        type: 'order',
        id: `order-${r.id}`,
        title: `New order ${r.order_number}`,
        detail: r.customer_name || r.customer_email || 'Customer',
        amount: Number(r.total || 0),
        currency: r.currency,
        at: r.created_at,
      })),
      ...(Array.isArray(paymentRows) ? paymentRows : []).map((r) => ({
        type: 'payment',
        id: `payment-${r.id}`,
        title: `Payment received — ${r.order_number}`,
        detail: r.status,
        amount: Number(r.amount || 0),
        currency: r.currency,
        at: r.created_at,
      })),
      ...(Array.isArray(productRows) ? productRows : []).map((r) => ({
        type: 'product',
        id: `product-${r.id}`,
        title: `Product added — ${r.name}`,
        detail: r.sku,
        at: r.created_at,
      })),
    ]
    activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

    const payload = { activity: activity.slice(0, limit) }
    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch activity' })
  }
})

let ORDERS_HAS_PAYMENT_PROCESSOR_COL = null
let ORDERS_HAS_BANK_ACCOUNT_USED_COL = null
let ORDERS_COLUMNS = null

console.log('[admin-service] db config', { url: DATABASE_URL ? DATABASE_URL.replace(/:([^@]+)@/, ':***@') : 'not set' })

;(async () => {
  try {
    const c = await pool.connect()
    c.release()
    console.log('[admin-service] db connection ok')

    try {
      try {
        const [cols] = await dbQuery(
          `SELECT column_name AS "Field" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' ORDER BY ordinal_position`
        )
        const list = Array.isArray(cols) ? cols : []
        ORDERS_COLUMNS = new Set(list.map((r) => String(r?.Field || '').trim()).filter(Boolean))
      } catch {
        ORDERS_COLUMNS = null
      }

      const [ppCols] = await dbQuery(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'payment_processor'`)
      const [bankCols] = await dbQuery(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'bank_account_used'`)
      ORDERS_HAS_PAYMENT_PROCESSOR_COL = Array.isArray(ppCols) && ppCols.length > 0
      ORDERS_HAS_BANK_ACCOUNT_USED_COL = Array.isArray(bankCols) && bankCols.length > 0
      console.log('[admin-service] orders columns', {
        payment_processor: ORDERS_HAS_PAYMENT_PROCESSOR_COL,
        bank_account_used: ORDERS_HAS_BANK_ACCOUNT_USED_COL,
      })
    } catch (e) {
      ORDERS_HAS_PAYMENT_PROCESSOR_COL = false
      ORDERS_HAS_BANK_ACCOUNT_USED_COL = false
      console.error('[admin-service] failed to detect orders columns', {
        message: e?.message || String(e),
      })
    }
  } catch (e) {
    console.error('[admin-service] db connection failed', {
      code: e?.code,
      message: e?.message || String(e),
    })
  }
})()

// Refund card payment (AabanPay) for test-product orders only.
app.post('/api/admin/order/:id/refund', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const amountFromBody = Number(req.body?.amount)

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 
      'SELECT id, order_number, customer_email, customer_name, total, currency, payment_status FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE',
      [id]
    )
    const order = Array.isArray(orderRows) && orderRows[0] ? orderRows[0] : null
    if (!order?.id) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }

    if (String(order.payment_status || '').trim().toLowerCase() === 'refunded') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.json({ success: true, alreadyRefunded: true })
    }

    // Only allow refunds for orders containing test product ID 32
    const [itemRows] = await dbQueryConn(connection, 
      'SELECT product_id FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [Number(order.id)]
    )
    const items = Array.isArray(itemRows) ? itemRows : []
    const isTestOrder = items.length > 0 && items.every((it) => String(it?.product_id || '').trim() === '32')
    if (!isTestOrder) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'Refunds are enabled only for test-product orders.' })
    }

    // Find latest AabanPay payment transaction id
    const [payRows] = await dbQueryConn(connection, 
      `SELECT id, provider_id, amount, currency, raw_response
       FROM payments
       WHERE order_id = $1 AND LOWER(provider) = 'aabanpay'
       ORDER BY COALESCE(updated_at, created_at) DESC
      `,
      [Number(order.id)]
    )
    const payment = Array.isArray(payRows) && payRows[0] ? payRows[0] : null
    const transactionId = String(payment?.provider_id || '').trim()
    if (!transactionId) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'Refund failed: missing AabanPay transaction id for this order.' })
    }

    const refundAmount = Number.isFinite(amountFromBody) && amountFromBody > 0
      ? amountFromBody
      : Number(payment?.amount || order.total || 0)

    dbQueryConn(connection, 'COMMIT')

    const refundRes = await aabanpayRefundTransaction({ transactionId, amount: refundAmount })
    if (!refundRes.ok) {
      return res.status(502).json({ error: refundRes.error || 'Refund failed', provider: refundRes.provider || null })
    }

    // Persist refunded status
    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    await dbQueryConn(connection, 
      'UPDATE orders SET payment_status = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      ['refunded', 'refunded', Number(order.id)]
    )
    await dbQueryConn(connection, 
      `UPDATE payments
       SET status = $1, final_status = $2, raw_response = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      ['REFUNDED', 'REFUNDED', JSON.stringify({ refund: refundRes.provider || null, previous: payment?.raw_response || null }), Number(payment.id)]
    )

    dbQueryConn(connection, 'COMMIT')

    // Send refund email (best-effort)
    try {
      const to = String(order.customer_email || '').trim()
      if (to && to.includes('@')) {
        const publicBase = env('PUBLIC_API_BASE_URL', env('PUBLIC_BASE_URL', '')).replace(/\/$/, '')
        const trackUrl = `${publicBase}/track-order`
        await sendRefundInitiatedEmail(to, {
          customerName: String(order.customer_name || '').trim() || 'Customer',
          orderNumber: String(order.order_number || '').trim(),
          amount: refundAmount,
          currency: String(order.currency || 'GBP'),
          trackUrl,
        })
      }
    } catch (e) {
      console.error('[admin/refund] refund email failed', e?.message || e)
    }

    return res.json({ success: true, refunded: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Refund failed' })
  } finally {
    if (connection) connection.release()
  }
})

// Affiliate side effects fired by admin payment-status changes.
// Grant: idempotent (deduped by promo_redemptions.order_id and (affiliate_user_id, customer_email) UNIQUE).
// Revoke: removes the redemption, deducts the reward from the affiliate's wallet (allowing negative),
//         and writes a negative ledger entry for audit.
const AFFILIATE_DEFAULT_REWARD_GBP = Number(process.env.AFFILIATE_DEFAULT_REWARD || 40)

const nowMysqlDatetimeUtc = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function grantAffiliateRewardForReceivedOrder(connection, order, opts) {
  const reward = Number(opts?.rewardAmount ?? AFFILIATE_DEFAULT_REWARD_GBP)
  const safeReward = Number.isFinite(reward) && reward > 0 ? Number(reward.toFixed(2)) : AFFILIATE_DEFAULT_REWARD_GBP

  const orderId = Number(order?.id)
  const orderNumber = String(order?.order_number || '').trim()
  if (!Number.isFinite(orderId) || !orderNumber) return { ok: false, reason: 'invalid_order' }

  const customerEmail = String(order?.customer_email || '').trim().toLowerCase()
  if (!customerEmail || !customerEmail.includes('@')) return { ok: true, skipped: true, reason: 'missing_customer_email' }

  const promoCode = String(order?.promo_code || '').trim().toUpperCase()
  if (!promoCode || promoCode === '-' || promoCode === 'NONE') return { ok: true, skipped: true, reason: 'no_promo' }

  const [promoRows] = await dbQueryConn(connection, 
    `SELECT user_id FROM promo_codes
     WHERE code = $1 AND is_active = 1 AND LOWER(source) = 'affiliate'
     ORDER BY id DESC`,
    [promoCode]
  )
  const affiliateUserId = Number(promoRows?.[0]?.user_id)
  if (!Number.isFinite(affiliateUserId) || affiliateUserId <= 0) return { ok: true, skipped: true, reason: 'not_affiliate_code' }

  // Self-referral guard.
  try {
    const [uRows] = await dbQueryConn(connection, 
      'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1',
      [customerEmail]
    )
    const buyerUserId = Number(uRows?.[0]?.id)
    if (Number.isFinite(buyerUserId) && buyerUserId > 0 && buyerUserId === affiliateUserId) {
      return { ok: true, skipped: true, reason: 'self_referral' }
    }
  } catch { /* ignore */ }

  // Already-rewarded-by-this-customer guard.
  const [dupCustomerRows] = await dbQueryConn(connection, 
    'SELECT id FROM promo_redemptions WHERE affiliate_user_id = $1 AND customer_email = $2 LIMIT 1 FOR UPDATE',
    [affiliateUserId, customerEmail]
  )
  if (dupCustomerRows?.[0]?.id) return { ok: true, skipped: true, reason: 'customer_already_rewarded' }

  const [dupOrderRows] = await dbQueryConn(connection, 
    'SELECT id FROM promo_redemptions WHERE order_id = $1 LIMIT 1 FOR UPDATE',
    [orderId]
  )
  if (dupOrderRows?.[0]?.id) return { ok: true, alreadyGranted: true }

  await dbQueryConn(connection, 'INSERT INTO user_credits (user_id, balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING', [affiliateUserId])
  await dbQueryConn(connection, 
    'UPDATE user_credits SET balance = COALESCE(balance, 0) + $1 WHERE user_id = $2',
    [safeReward, affiliateUserId]
  )
  await dbQueryConn(connection, 
    'INSERT INTO credit_ledger (user_id, amount, source, order_number, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [affiliateUserId, safeReward, 'affiliate_reward', orderNumber, `admin received: promo ${promoCode}`, nowMysqlDatetimeUtc()]
  )
  await dbQueryConn(connection,
    'INSERT INTO promo_redemptions (order_id, order_number, promo_code, affiliate_user_id, customer_email, reward_amount, status, created_at, domain_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [orderId, orderNumber, promoCode, affiliateUserId, customerEmail, safeReward, 'granted', nowMysqlDatetimeUtc(), order?.domain_id ?? null]
  )

  console.log(`[admin/affiliate-grant ${orderNumber}] GRANTED £${safeReward.toFixed(2)} to user_id=${affiliateUserId} (promo=${promoCode})`)
  return { ok: true, granted: true, affiliateUserId, promoCode, rewardAmount: safeReward }
}

async function revokeAffiliateRewardForRejectedOrder(connection, order) {
  const orderId = Number(order?.id)
  const orderNumber = String(order?.order_number || '').trim()
  if (!Number.isFinite(orderId) || !orderNumber) return { ok: false, reason: 'invalid_order' }

  const [redemptionRows] = await dbQueryConn(connection, 
    'SELECT id, affiliate_user_id, reward_amount, promo_code FROM promo_redemptions WHERE order_id = $1 LIMIT 1 FOR UPDATE',
    [orderId]
  )
  const redemption = redemptionRows?.[0]
  if (!redemption?.id) return { ok: true, skipped: true, reason: 'no_redemption_to_revoke' }

  const affiliateUserId = Number(redemption.affiliate_user_id)
  const reward = Number(redemption.reward_amount || 0)
  const promoCode = String(redemption.promo_code || '').trim().toUpperCase()

  // Deduct from wallet (allow going negative — honest accounting).
  await dbQueryConn(connection, 
    'UPDATE user_credits SET balance = COALESCE(balance, 0) - $1 WHERE user_id = $2',
    [reward, affiliateUserId]
  )

  // Audit trail: negative ledger entry.
  await dbQueryConn(connection, 
    'INSERT INTO credit_ledger (user_id, amount, source, order_number, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [affiliateUserId, -reward, 'affiliate_revoke', orderNumber, `admin rejected: reversed promo ${promoCode}`, nowMysqlDatetimeUtc()]
  )

  // Free the (affiliate_user_id, customer_email) UNIQUE so future flips re-grant cleanly.
  await dbQueryConn(connection, 'DELETE FROM promo_redemptions WHERE id = $1', [redemption.id])

  console.log(`[admin/affiliate-revoke ${orderNumber}] REVOKED £${reward.toFixed(2)} from user_id=${affiliateUserId} (promo=${promoCode})`)
  return { ok: true, revoked: true, affiliateUserId, promoCode, rewardAmount: reward }
}

async function applyAdminPaymentStatusUpdate({
  id,
  nextStatusRaw,
  reason,
  account,
  adminRemark,
  adminScreenshotFilename,
  adminScreenshotUrl,
  fireAndForget,
}) {
  await dbQuery(
    `UPDATE orders
     SET payment_status = $1,
         payment_rejection_reason = $2,
         bank_account_used = $3,
         admin_payment_remark = $4,
         admin_payment_screenshot_filename = $5,
         admin_payment_screenshot_url = $6,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
    `,
    [
      nextStatusRaw,
      nextStatusRaw === 'rejected' ? reason : null,
      nextStatusRaw === 'received' ? account : null,
      nextStatusRaw === 'received' ? (adminRemark || null) : null,
      nextStatusRaw === 'received' ? (adminScreenshotFilename || null) : null,
      nextStatusRaw === 'received' ? (adminScreenshotUrl || null) : null,
      id,
    ]
  )

  const [ordersAfter] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
  const order = Array.isArray(ordersAfter) && ordersAfter[0] ? ordersAfter[0] : null
  if (!order) {
    const err = new Error('Order not found')
    err.code = 'ORDER_NOT_FOUND'
    throw err
  }

  const runSideEffects = async () => {
    // Send customer-facing payment status email (same templates as automated flow).
    try {
      const customerEmail = String(order?.customer_email || '').trim()
      const customerName = String(order?.customer_name || '').trim() || 'Customer'
      const orderNumber = String(order?.order_number || '').trim()
      const amount = Number(order?.total || 0)
      const currency = String(order?.currency || 'GBP')

      if (customerEmail && customerEmail.includes('@')) {
        const domainName = await resolveDomainNameById(order?.domain_id)
        const brand = await resolveBrandFromForDomain(domainName)

        if (nextStatusRaw === 'received') {
          await sendPaymentSuccessfulEmail(customerEmail, {
            customerName,
            orderNumber,
            amount: Number.isFinite(amount) ? amount : 0,
            currency,
            domain: domainName,
            website: brand?.website,
            from: brand?.from,
            fromName: brand?.fromName,
          })
        } else if (nextStatusRaw === 'rejected') {
          let retryLink = ''
          try {
            const rawToken = randomToken()
            const tokenHash = sha256Hex(rawToken)
            const createdAt = nowMysqlDatetime()
            const expiresAt = addHoursMysql(24)

            await dbQuery(
              `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, created_at, domain_id)
                VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
              [Number(order.id), customerEmail, tokenHash, expiresAt, createdAt, order?.domain_id ?? null]
            )

            const publicBase = (brand?.website || env('PUBLIC_API_BASE_URL', env('PUBLIC_BASE_URL', ''))).replace(/\/$/, '')
            retryLink = `${publicBase}/payment-capture/${encodeURIComponent(rawToken)}`
          } catch (linkErr) {
            console.error('[admin/payment-status] failed to create retry payment link', linkErr?.message || linkErr)
            retryLink = ''
          }

          await sendPaymentDeclinedEmail(customerEmail, {
            customerName,
            orderNumber,
            reason: reason || 'Rejected by admin',
            retryLink,
            domain: domainName,
            website: brand?.website,
            from: brand?.from,
            fromName: brand?.fromName,
          })
        }
      }
    } catch (emailErr) {
      console.error('[admin/payment-status] customer payment status email failed', emailErr?.message || emailErr)
    }

    // Affiliate side effects: grant when admin marks 'received', revoke when admin marks 'rejected'.
    // Wrapped in its own try/catch so a failure here doesn't break the email/invoice flow.
    try {
      const affConn = await pool.connect()
      try {
        if (nextStatusRaw === 'received') {
          await grantAffiliateRewardForReceivedOrder(affConn, order, { rewardAmount: AFFILIATE_DEFAULT_REWARD_GBP })
        } else if (nextStatusRaw === 'rejected') {
          await revokeAffiliateRewardForRejectedOrder(affConn, order)
        }
      } finally {
        affConn.release()
      }
    } catch (affErr) {
      console.error('[admin/payment-status] affiliate side effect failed', affErr?.message || affErr)
    }

    // Preserve existing behavior: invoice/email side effects for manual received.
    if (String(nextStatusRaw || '').trim().toLowerCase() === 'received') {
      try {
        const alreadySent = !!order?.ibalticx_invoice_sent_at
        if (!alreadySent) {
          const toDate = (value) => {
            if (!value) return null
            if (value instanceof Date) return value
            const d = new Date(value)
            return Number.isNaN(d.getTime()) ? null : d
          }

          const [payRows] = await dbQuery(
            `SELECT COALESCE(updated_at, created_at) AS payment_date
             FROM payments
             WHERE order_id = $1
               AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')
             ORDER BY COALESCE(updated_at, created_at) DESC
            `,
            [Number(order.id)]
          )
          const payList = Array.isArray(payRows) ? payRows : []
          const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null

          const invoiceDate = new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }).format(paymentDate || new Date())

          const invoiceTotal = Number(order?.total || 0)
          const orderNumber = String(order?.order_number || '').trim() || String(order?.id || '')
          const invoiceNumberRaw = `INV-${orderNumber || Date.now()}`
          const invoiceNumber = String(invoiceNumberRaw)
            .replace(/^INV-ALU-/i, 'INV-')
            .replace(/^INV-ALU/i, 'INV-')

          let orderItems = []
          try {
            const [itemRows] = await dbQuery(
              'SELECT name, sku, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id ASC',
              [Number(order.id)]
            )
            orderItems = Array.isArray(itemRows) ? itemRows : []
          } catch {
            orderItems = []
          }

          const promoDiscountPercent = Number(order?.promo_discount_percent || 0)
          const promoCode = String(order?.promo_code || '').trim()
          const discountAmount = Number(order?.discount_amount || 0)
          const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'
          const customerPhone = String(order?.customer_phone || '').trim()
          const customerAddressLine1 = String(order?.shipping_address || '').trim()
          const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .join(', ')

          const ibMasked = buildHasInvoiceMaskedItems({
            orderItems,
            promoDiscountPercent,
            expectedTotal: invoiceTotal,
          })

          const invoicePayload = {
            invoiceDate,
            invoiceNumber,
            billToName: customerDisplayName,
            billToAddressLine1: customerAddressLine1,
            billToAddressLine2: customerAddressLine2,
            billToNumber: customerPhone,
            items: ibMasked.items,
            subtotal: ibMasked.subtotal,
            total: ibMasked.total,
            promoCode: promoCode && promoCode !== '-' ? promoCode : '',
            promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,
            discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
            bank: {
              bankName: 'HSA INTERPAY UK',
              bankAddress: '',
              accountNumber: '21327124',
              sortCode: '609561',
              beneficiaryName: 'HSA INTERPAY UK',
              reference: 'Ivms Subscription',
            },
          }

          console.log('[payment-status] HAS/IVMS invoice email skipped (disabled)', {
            orderNumber: String(order?.order_number || '').trim() || String(order?.id || ''),
            invoiceNumber,
          })
        }
      } catch (invoiceErr) {
        console.error('[payment-status] HAS invoice send failed', invoiceErr?.message || invoiceErr)
      }
    }
  }

  if (fireAndForget) {
    setImmediate(() => {
      runSideEffects().catch((e) => console.error('[payment-status] side effects failed', e?.message || e))
    })
  } else {
    await runSideEffects()
  }

  const [ordersAfter2] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
  const refreshed = Array.isArray(ordersAfter2) && ordersAfter2[0] ? ordersAfter2[0] : order
  return { order: refreshed }
}

async function ensureOrdersAdminPaymentEvidenceColumns() {
  const addColumn = async (sql) => {
    try {
      await dbQuery(sql)
    } catch (e) {
      const msg = String(e?.message || e)
      if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('exists')) return
      console.error('Failed to ensure order column:', msg)
    }
  }

  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_remark TEXT NULL')
  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_screenshot_filename VARCHAR(255) NULL')
  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_screenshot_url VARCHAR(512) NULL')
}

// Static hosting for uploaded files (admin evidence screenshots)
app.use('/uploads', express.static(UPLOADS_DIR))

const adminUploadStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true })
    } catch {
      // ignore
    }
    cb(null, UPLOADS_DIR)
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname || '') || '.jpg'
    cb(null, `admin-payment-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)
  },
})

const adminUpload = multer({
  storage: adminUploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
})

async function backfillOrderItemSkus() {
  try {
    const [result] = await dbQuery(
      `UPDATE order_items
       SET sku = p.sku
       FROM products p
       WHERE p.id = order_items.product_id
         AND (order_items.sku IS NULL OR TRIM(order_items.sku) = '')
         AND p.sku IS NOT NULL
         AND TRIM(p.sku) <> ''`
    )
    const affected = Number(result?.affectedRows || 0)
    if (affected > 0) {
      console.log(` Backfilled sku for ${affected} order_items row(s).`)
    }
  } catch (e) {
    console.warn('⚠️ Failed to backfill order_items.sku:', e?.message || String(e))
  }
}

async function columnExists(tableName, columnName) {
  try {
    const [rows] = await dbQuery(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [tableName, columnName]
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    return false
  }
}

async function ensureOrdersPaymentRejectionReasonColumn() {
  try {
    await dbQuery(
      `ALTER TABLE orders
        ADD COLUMN payment_rejection_reason VARCHAR(255) NULL`
    )
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) return
    console.error('Failed to ensure payment_rejection_reason column:', msg)
  }
}

async function ensureOrdersIbalticxInvoiceColumns() {
  const addColumn = async (sql) => {
    try {
      await dbQuery(sql)
    } catch (e) {
      const msg = String(e?.message || e)
      if (msg.toLowerCase().includes('duplicate column') || msg.toLowerCase().includes('exists')) return
      console.error('Failed to ensure iBalticX invoice column:', msg)
    }
  }

  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_sent_at TIMESTAMP NULL')
  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_to VARCHAR(255) NULL')
  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_message_id VARCHAR(255) NULL')
  await addColumn('ALTER TABLE orders ADD COLUMN IF NOT EXISTS bank_account_used VARCHAR(100) NULL')
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex')
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

function nowMysqlDatetime() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function generateAdminOrderNumber() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const hh = pad(d.getHours())
  const mm = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  const ms = pad(d.getMilliseconds(), 3)
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase()
  return `ORD-${y}${m}${day}-${hh}${mm}${ss}${ms}-${rand}`
}

function addHoursMysql(hours) {
  const d = new Date(Date.now() + hours * 60 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function toMoney(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Number(x.toFixed(2))
}

function normalizeSku(raw) {
  const s = String(raw || '').trim()
  return s.slice(0, 100)
}

function normalizeName(raw) {
  const s = String(raw || '').trim()
  return s.slice(0, 150)
}

function normalizeAddressField(raw, maxLen = 255) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return s.slice(0, maxLen)
}

function safeJsonParse(raw) {
  try {
    if (raw === null || raw === undefined) return null
    const s = String(raw)
    if (!s) return null
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function ensureWholesaleConsoleSchema() {
  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_products (
        code VARCHAR(32) NOT NULL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        currency VARCHAR(8) NOT NULL DEFAULT 'GBP',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_products table:', msg)
    }
  }

  // Ensure is_active column exists (table may have been created externally without it)
  try {
    await dbQuery('ALTER TABLE wholesale_products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE')
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists') && !msg.toLowerCase().includes('duplicate')) {
      console.error('Failed to ensure wholesale_products.is_active column:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_orders (
        id BIGSERIAL PRIMARY KEY,
        order_code VARCHAR(64) NOT NULL,
        first_name VARCHAR(120) NOT NULL,
        last_name VARCHAR(120) NOT NULL,
        email VARCHAR(255) NOT NULL,
        mobile VARCHAR(64) NOT NULL,
        alt_mobile VARCHAR(64) NULL,
        address_line1 VARCHAR(255) NOT NULL,
        address_line2 VARCHAR(255) NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NULL,
        country VARCHAR(100) NOT NULL,
        postal_code VARCHAR(32) NOT NULL,
        delivery_date DATE NULL,
        notes TEXT NULL,
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        grand_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        currency VARCHAR(8) NOT NULL DEFAULT 'GBP',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        created_by_admin_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_wholesale_orders_code UNIQUE (order_code)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_orders table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_order_items (
        id BIGSERIAL PRIMARY KEY,
        wholesale_order_id BIGINT NOT NULL,
        product_code VARCHAR(32) NOT NULL,
        product_title VARCHAR(255) NOT NULL,
        unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        quantity INT NOT NULL DEFAULT 1,
        line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_order_items table:', msg)
    }
  }

  try {
    await dbQuery('ALTER TABLE wholesale_order_items ADD CONSTRAINT fk_wholesale_order_items_order FOREIGN KEY (wholesale_order_id) REFERENCES wholesale_orders(id) ON DELETE CASCADE')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_order_items FK:', msg)
      }
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_team_members (
        id BIGSERIAL PRIMARY KEY,
        display_name VARCHAR(120) NOT NULL,
        role VARCHAR(64) NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_team_members table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_raw_materials (
        name VARCHAR(64) NOT NULL PRIMARY KEY,
        unit VARCHAR(16) NOT NULL DEFAULT 'pcs',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_raw_materials table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_raw_material_stock (
        material_name VARCHAR(64) NOT NULL PRIMARY KEY,
        on_hand INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_raw_material_stock table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_work_allocations (
        id BIGSERIAL PRIMARY KEY,
        wholesale_order_id BIGINT NOT NULL,
        wholesale_order_item_id BIGINT NOT NULL,
        team_member_id BIGINT NOT NULL,
        quantity_assigned INT NOT NULL DEFAULT 0,
        note VARCHAR(255) NULL,
        created_by_admin_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_work_allocations table:', msg)
    }
  }

  try {
    await dbQuery('ALTER TABLE wholesale_work_allocations ADD CONSTRAINT fk_wholesale_alloc_order FOREIGN KEY (wholesale_order_id) REFERENCES wholesale_orders(id) ON DELETE CASCADE')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_work_allocations order FK:', msg)
      }
    }
  }
  try {
    await dbQuery('ALTER TABLE wholesale_work_allocations ADD CONSTRAINT fk_wholesale_alloc_item FOREIGN KEY (wholesale_order_item_id) REFERENCES wholesale_order_items(id) ON DELETE CASCADE')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_work_allocations item FK:', msg)
      }
    }
  }
  try {
    await dbQuery('ALTER TABLE wholesale_work_allocations ADD CONSTRAINT fk_wholesale_alloc_member FOREIGN KEY (team_member_id) REFERENCES wholesale_team_members(id) ON DELETE RESTRICT')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_work_allocations member FK:', msg)
      }
    }
  }

  // Seed products
  try {
    const seedProducts = [
      { code: 'RETA20', title: 'RETA20', unit_price: 0 },
      { code: 'RETA40', title: 'RETA40', unit_price: 0 },
      { code: 'TRIZ40', title: 'TRIZ40', unit_price: 0 },
      { code: 'GLOW', title: 'GLOW', unit_price: 0 },
      { code: 'BPC BLEND', title: 'BPC BLEND', unit_price: 0 },
      { code: 'NAD', title: 'NAD', unit_price: 0 },
    ]
    for (const p of seedProducts) {
      // eslint-disable-next-line no-await-in-loop
      await dbQuery(
        'INSERT INTO wholesale_products (code, title, unit_price, currency, is_active) VALUES ($1, $2, $3, $4, true) ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title',
        [p.code, p.title, Number(p.unit_price || 0), 'GBP']
      )
    }
  } catch (e) {
    console.warn('⚠️ Failed to seed wholesale products:', e?.message || String(e))
  }

  // Seed raw materials + stock row
  try {
    const materials = ['Pen', 'Cartridge', 'Needle', 'Magnet Box', 'Leaflet', 'Powder', 'Solution']
    for (const m of materials) {
      // eslint-disable-next-line no-await-in-loop
      await dbQuery('INSERT INTO wholesale_raw_materials (name, unit) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET unit = EXCLUDED.unit', [m, 'pcs'])
      // eslint-disable-next-line no-await-in-loop
      await dbQuery('INSERT INTO wholesale_raw_material_stock (material_name, on_hand) VALUES ($1, 0) ON CONFLICT (material_name) DO NOTHING', [m])
    }
  } catch (e) {
    console.warn('⚠️ Failed to seed wholesale raw materials:', e?.message || String(e))
  }

  // Seed 10 team members if table empty
  try {
    const [rows] = await dbQuery('SELECT COUNT(*) AS c FROM wholesale_team_members')
    const c = Array.isArray(rows) && rows[0] ? Number(rows[0].c) : 0
    if (!Number.isFinite(c) || c <= 0) {
      for (let i = 1; i <= 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await dbQuery('INSERT INTO wholesale_team_members (display_name, role, is_active) VALUES ($1, $2, true)', [`Team Member ${i}`, ''])
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to seed wholesale team members:', e?.message || String(e))
  }
}

async function ensureWholesaleProductInventorySchema() {
  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  // Add country column to wholesale_orders if not exists
  try {
    await dbQuery('ALTER TABLE wholesale_orders ADD COLUMN IF NOT EXISTS country VARCHAR(100) NULL')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_orders.country:', msg)
      }
    }
  }

  // Add payment columns to wholesale_orders
  try {
    await dbQuery('ALTER TABLE wholesale_orders ADD COLUMN IF NOT EXISTS total_payment DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_orders.total_payment:', msg)
      }
    }
  }

  try {
    await dbQuery('ALTER TABLE wholesale_orders ADD COLUMN IF NOT EXISTS received_payment DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_orders.received_payment:', msg)
      }
    }
  }

  try {
    await dbQuery('ALTER TABLE wholesale_orders ADD COLUMN IF NOT EXISTS pending_payment DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('already')) {
        console.error('Failed to ensure wholesale_orders.pending_payment:', msg)
      }
    }
  }

  // Table for product inventory by country
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_product_inventory (
        id BIGSERIAL PRIMARY KEY,
        product_name VARCHAR(100) NOT NULL,
        country VARCHAR(100) NOT NULL,
        cartridge INT NOT NULL DEFAULT 0,
        leaflet INT NOT NULL DEFAULT 0,
        magnet_box INT NOT NULL DEFAULT 0,
        pen INT NOT NULL DEFAULT 0,
        solution INT NOT NULL DEFAULT 0,
        needles INT NOT NULL DEFAULT 0,
        powder INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_product_country UNIQUE (product_name, country)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_product_inventory table:', msg)
    }
  }

  try {
    await dbQuery('ALTER TABLE wholesale_product_inventory ADD COLUMN IF NOT EXISTS powder INT NOT NULL DEFAULT 0')
  } catch (e) {
    if (!isDuplicate(e)) {
      const msg = String(e?.message || e)
      if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('exists')) {
        console.error('Failed to ensure wholesale_product_inventory powder column:', msg)
      }
    }
  }

  // Table for product recipes (bill of materials)
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_product_recipes (
        id BIGSERIAL PRIMARY KEY,
        product_name VARCHAR(100) NOT NULL,
        cartridge INT NOT NULL DEFAULT 1,
        leaflet INT NOT NULL DEFAULT 1,
        magnet_box INT NOT NULL DEFAULT 1,
        pen INT NOT NULL DEFAULT 1,
        solution INT NOT NULL DEFAULT 3,
        needles INT NOT NULL DEFAULT 12,
        powder INT NOT NULL DEFAULT 0,
        CONSTRAINT uq_recipe_product UNIQUE (product_name)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_product_recipes table:', msg)
    }
  }

  // Add powder column if it doesn't exist
  try {
    await dbQuery(`ALTER TABLE wholesale_product_recipes ADD COLUMN IF NOT EXISTS powder INT NOT NULL DEFAULT 0`)
  } catch (e) {
    // Column might already exist, ignore
  }

  // Seed product recipes with correct quantities
  const recipes = [
    { name: 'Retatrutide 20mg', cartridge: 1, leaflet: 1, magnet_box: 1, pen: 1, solution: 3, needles: 12, powder: 20 },
    { name: 'Retatrutide 40mg', cartridge: 1, leaflet: 1, magnet_box: 1, pen: 1, solution: 3, needles: 12, powder: 40 },
    { name: 'Tirzepetide 40mg', cartridge: 1, leaflet: 1, magnet_box: 1, pen: 1, solution: 3, needles: 12, powder: 40 },
    { name: 'Glow', cartridge: 2, leaflet: 1, magnet_box: 1, pen: 2, solution: 6, needles: 7, powder: 70 },
    { name: 'NAD+', cartridge: 1, leaflet: 1, magnet_box: 1, pen: 2, solution: 6, needles: 7, powder: 500 },
    { name: 'BPC', cartridge: 1, leaflet: 1, magnet_box: 1, pen: 1, solution: 3, needles: 12, powder: 40 },
  ]

  for (const r of recipes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await dbQuery(
        `INSERT INTO wholesale_product_recipes (product_name, cartridge, leaflet, magnet_box, pen, solution, needles, powder)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (product_name) DO UPDATE SET
         cartridge = EXCLUDED.cartridge,
         leaflet = EXCLUDED.leaflet,
         magnet_box = EXCLUDED.magnet_box,
         pen = EXCLUDED.pen,
         solution = EXCLUDED.solution,
         needles = EXCLUDED.needles,
         powder = EXCLUDED.powder`,
        [r.name, r.cartridge, r.leaflet, r.magnet_box, r.pen, r.solution, r.needles, r.powder]
      )
    } catch (e) {
      console.warn(`⚠️ Failed to seed recipe for ${r.name}:`, e?.message || String(e))
    }
  }

  // Seed initial inventory for UK (and other countries if needed)
  const products = ['Retatrutide 20mg', 'Retatrutide 40mg', 'Tirzepetide 40mg', 'Glow', 'NAD+', 'BPC']
  const countries = ['United Kingdom', 'United States', 'Canada', 'Australia']

  for (const product of products) {
    for (const country of countries) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await dbQuery(
          `INSERT INTO wholesale_product_inventory (product_name, country, cartridge, leaflet, magnet_box, pen, solution, needles, powder)
           VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0)
           ON CONFLICT (product_name, country) DO NOTHING`,
          [product, country]
        )
      } catch (e) {
        console.warn(`⚠️ Failed to seed inventory for ${product} in ${country}:`, e?.message || String(e))
      }
    }
  }
}

async function ensureAffiliateSchema() {
  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id BIGSERIAL PRIMARY KEY,
        code VARCHAR(64) NOT NULL,
        percent INT NOT NULL DEFAULT 0,
        source VARCHAR(32) NOT NULL DEFAULT 'manual',
        user_id INT NULL,
        is_active SMALLINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_promo_codes_code UNIQUE (code)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure promo_codes table:', msg)
    }
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS affiliate_requests (
        id BIGSERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        promo_code VARCHAR(64) NULL,
        promo_percent INT NULL,
        admin_id INT NULL,
        admin_note VARCHAR(255) NULL,
        decided_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure affiliate_requests table:', msg)
    }
  }

  try {
    await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_requests_user ON affiliate_requests(user_id)')
  } catch (e) {
    if (!isDuplicate(e)) console.error('Failed to ensure affiliate_requests unique user constraint:', e?.message || String(e))
  }

  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS affiliates (
        id BIGSERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        promo_code VARCHAR(64) NULL,
        promo_percent INT NOT NULL DEFAULT 10,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 10.00,
        status VARCHAR(16) NOT NULL DEFAULT 'approved',
        approved_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_affiliates_user UNIQUE (user_id)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure affiliates table:', msg)
    }
  }

  // Self-serve affiliate signup fields (idempotent on rerun).
  for (const sql of [
    'ALTER TABLE affiliate_requests ADD COLUMN IF NOT EXISTS first_name VARCHAR(64) NULL',
    'ALTER TABLE affiliate_requests ADD COLUMN IF NOT EXISTS last_name VARCHAR(64) NULL',
    'ALTER TABLE affiliate_requests ADD COLUMN IF NOT EXISTS tiktok_link VARCHAR(255) NULL',
    'ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS first_name VARCHAR(64) NULL',
    'ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS last_name VARCHAR(64) NULL',
    'ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS tiktok_link VARCHAR(255) NULL',
  ]) {
    try {
      await dbQuery(sql)
    } catch (e) {
      if (!isDuplicate(e)) console.error(`Failed schema migration "${sql}":`, e?.message || String(e))
    }
  }
}

// Ensure affiliate tables exist at service startup.
try {
  // eslint-disable-next-line no-void
  void ensureAffiliateSchema()
} catch {
  // ignore
}

// Ensure wholesale product inventory tables exist at service startup.
try {
  // eslint-disable-next-line no-void
  void ensureWholesaleProductInventorySchema()
} catch {
  // ignore
}

function splitFirstName(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.split(/\s+/g)[0] || ''
}

function sanitizePromoToken(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32)
}

async function generateUniqueAffiliatePromoCode(connection, userName, percent) {
  const p = Number(percent)
  const pct = Number.isFinite(p) && p > 0 ? Math.trunc(p) : 10

  const first = sanitizePromoToken(splitFirstName(userName))
  const baseName = first || 'USER'
  const base = `A${baseName}${pct}`

  const candidates = [base]
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${base}${ch}`)
    if (candidates.length >= 30) break
  }

  for (const code of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await dbQueryConn(connection, 'SELECT id FROM promo_codes WHERE code = $1', [code])
    const exists = Array.isArray(rows) && rows[0]
    if (!exists) return code
  }

  return `${base}${String(Date.now()).slice(-4)}`.slice(0, 64)
}

async function approveAddressChangeRequestById(requestId, adminId, adminNote) {
  let connection
  const id = Number(requestId)
  if (!Number.isFinite(id)) return { ok: false, error: 'Invalid request id' }

  try {
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      `SELECT * FROM order_address_change_requests WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return { ok: false, error: 'Request not found' }
    }

    const reqRow = list[0]
    if (String(reqRow?.status || '').toLowerCase() !== 'pending') {
      dbQueryConn(connection, 'ROLLBACK')
      return { ok: false, error: 'Request is not pending' }
    }

    const requested = safeJsonParse(reqRow?.requested_shipping_json) || {}
    const shipping_address = normalizeAddressField(requested?.shipping_address || '', 255)
    const shipping_city = normalizeAddressField(requested?.shipping_city || '', 100)
    const shipping_zip = normalizeAddressField(requested?.shipping_zip || '', 30)
    const shipping_country = normalizeAddressField(requested?.shipping_country || '', 100)

    if (!shipping_address) {
      dbQueryConn(connection, 'ROLLBACK')
      return { ok: false, error: 'Requested shipping address is invalid' }
    }

    const orderId = reqRow?.order_id !== undefined && reqRow?.order_id !== null ? Number(reqRow.order_id) : null
    const orderNumber = String(reqRow?.order_number || '').trim()

    if (Number.isFinite(orderId)) {
      await dbQueryConn(connection, 
        `UPDATE orders
         SET shipping_address = $1, shipping_city = $2, shipping_zip = $3, shipping_country = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [shipping_address, shipping_city, shipping_zip, shipping_country, orderId]
      )
    } else if (orderNumber) {
      await dbQueryConn(connection, 
        `UPDATE orders
         SET shipping_address = $1, shipping_city = $2, shipping_zip = $3, shipping_country = $4, updated_at = CURRENT_TIMESTAMP
         WHERE order_number = $5`,
        [shipping_address, shipping_city, shipping_zip, shipping_country, orderNumber]
      )
    } else {
      dbQueryConn(connection, 'ROLLBACK')
      return { ok: false, error: 'Request missing order reference' }
    }

    await dbQueryConn(connection, 
      `UPDATE order_address_change_requests
       SET status = 'approved', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    dbQueryConn(connection, 'COMMIT')
    return { ok: true }
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return { ok: false, error: e?.message || 'Failed to approve request' }
  } finally {
    if (connection) connection.release()
  }
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' })
    }
    const token = authHeader.substring(7)
    const decoded = jwt.verify(token, JWT_SECRET)

     if (!decoded || decoded.sv !== ADMIN_SESSION_VERSION) {
       return res.status(401).json({ error: 'Unauthorized - Session expired' })
     }

    req.adminUser = decoded
    return next()
  } catch (_e) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' })
  }
}

// AI assistant routes (POST /api/admin/assistant/chat). Kept in ./assistant/ to
registerAssistant(app, { requireAuth, dbQuery, resolveAdminDomainFilter, resolveDomainNameById })



app.get('/api/admin/wholesale-inquiries', requireAuth, async (req, res) => {
  try {
    try {
      await ensureWholesaleInquiriesTable()
    } catch {
      // ignore
    }

    const limitRaw = Number(req.query?.limit)
    const offsetRaw = Number(req.query?.offset)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? Math.floor(limitRaw) : 500
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0

    const [rows] = await dbQuery(
      `SELECT id, name, email, contact, quantity, country, submitted_at
       FROM wholesale_inquiries
       ORDER BY submitted_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`
    )
    const [countRows] = await dbQuery('SELECT COUNT(*) AS total FROM wholesale_inquiries')
    const total = Array.isArray(countRows) && countRows[0] ? Number(countRows[0].total) || 0 : 0

    return res.json({
      success: true,
      inquiries: Array.isArray(rows) ? rows : [],
      total,
      limit,
      offset,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch wholesale inquiries' })
  }
})

app.delete('/api/admin/wholesale-inquiries/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params?.id, 10)
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid inquiry ID' })
  }
  try {
    const [result] = await dbQuery('DELETE FROM wholesale_inquiries WHERE id = $1', [id])
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Inquiry not found' })
    }
    return res.json({ success: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to delete inquiry' })
  }
})

app.get('/api/admin/wholesale/products', requireAuth, async (_req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const [rows] = await dbQuery('SELECT code, title, unit_price, currency, is_active FROM wholesale_products ORDER BY code ASC')
    const list = (Array.isArray(rows) ? rows : []).filter(r => r.is_active !== false && r.is_active !== 0 && r.is_active !== '0')
    return res.json({ success: true, products: list })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch wholesale products' })
  }
})

app.get('/api/admin/wholesale/team', requireAuth, async (_req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const [rows] = await dbQuery('SELECT id, display_name, role, is_active FROM wholesale_team_members ORDER BY id ASC')
    const team = (Array.isArray(rows) ? rows : []).filter(r => r.is_active !== false && r.is_active !== 0 && r.is_active !== '0')
    return res.json({ success: true, team })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch team members' })
  }
})

app.get('/api/admin/wholesale/inventory/raw', requireAuth, async (_req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const [rows] = await dbQuery(
      `SELECT
         m.name,
         m.unit,
         COALESCE(s.on_hand, 0) AS on_hand,
         COALESCE(s.updated_at, CURRENT_TIMESTAMP) AS updated_at
       FROM wholesale_raw_materials m
       LEFT JOIN wholesale_raw_material_stock s
         ON s.material_name = m.name
       ORDER BY m.name ASC`
    )
    return res.json({ materials: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch raw inventory' })
  }
})

app.put('/api/admin/wholesale/inventory/raw', requireAuth, async (req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const updatesRaw = Array.isArray(req.body?.updates) ? req.body.updates : []
    const updates = updatesRaw
      .map((u) => ({
        name: String(u?.name || '').trim(),
        on_hand: Number(u?.on_hand),
      }))
      .filter((u) => u.name)
      .slice(0, 50)

    if (!updates.length) return res.status(400).json({ error: 'No updates provided' })

    for (const u of updates) {
      const onHand = Number.isFinite(u.on_hand) ? Math.max(0, Math.trunc(u.on_hand)) : 0
      // eslint-disable-next-line no-await-in-loop
      await dbQuery('INSERT INTO wholesale_raw_material_stock (material_name, on_hand) VALUES ($1, $2) ON CONFLICT (material_name) DO UPDATE SET on_hand = EXCLUDED.on_hand', [u.name, onHand])
    }

    const [rows] = await dbQuery(
      `SELECT
         m.name,
         m.unit,
         COALESCE(s.on_hand, 0) AS on_hand,
         COALESCE(s.updated_at, CURRENT_TIMESTAMP) AS updated_at
       FROM wholesale_raw_materials m
       LEFT JOIN wholesale_raw_material_stock s
         ON s.material_name = m.name
       ORDER BY m.name ASC`
    )
    return res.json({ ok: true, materials: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to update raw inventory' })
  }
})

app.get('/api/admin/wholesale/orders', requireAuth, async (req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const status = String(req.query?.status || 'all').trim().toLowerCase()
    const country = String(req.query?.country || '').trim()
    const allowed = ['pending', 'in_progress', 'completed', 'cancelled', 'all']
    const safeStatus = allowed.includes(status) ? status : 'all'
    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const offset = Math.max(Number(req.query?.offset || 0), 0)
    const domainId = await resolveAdminDomainFilter(req)

    let sql = `SELECT
        id,
        order_code,
        order_code AS order_number,
        first_name,
        last_name,
        CONCAT(first_name, ' ', last_name) AS customer_name,
        email,
        email AS customer_email,
        mobile,
        mobile AS customer_phone,
        country,
        country AS shipping_country,
        delivery_date,
        status,
        subtotal,
        discount_amount,
        grand_total,
        grand_total AS total,
        currency,
        total_payment,
        received_payment,
        pending_payment,
        domain_id,
        created_at
      FROM wholesale_orders`
    const params = []
    const where = []
    if (safeStatus !== 'all') {
      where.push('status = $1')
      params.push(safeStatus)
    }
    if (country) {
      where.push('country = $1')
      params.push(country)
    }
    if (domainId != null) {
      params.push(domainId)
      where.push(`wholesale_orders.domain_id = $${params.length}`)
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ')
    }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`

    const [rows] = await dbQuery(sql, params)
    const orders = Array.isArray(rows) ? rows : []
    if (!orders.length) return res.json({ orders: [] })

    const ids = orders.map((o) => Number(o?.id)).filter((n) => Number.isFinite(n))
    if (!ids.length) return res.json({ orders: [] })

    const [itemsRows] = await dbQuery(
      `SELECT id, wholesale_order_id, product_code, product_title, unit_price, quantity
       FROM wholesale_order_items
       WHERE wholesale_order_id IN (${ids.map((_, i) => '$' + (i + 1)).join(',')})
       ORDER BY wholesale_order_id DESC, id ASC`,
      ids
    )
    const items = Array.isArray(itemsRows) ? itemsRows : []
    const byOrder = new Map()
    for (const it of items) {
      const oid = Number(it?.wholesale_order_id)
      if (!byOrder.has(oid)) byOrder.set(oid, [])
      byOrder.get(oid).push(it)
    }

    const out = orders.map((o) => ({
      ...o,
      // wholesale console UI expects this field to exist
      payment_status: (o && typeof o === 'object' && o.payment_status) ? o.payment_status : 'pending',
      items: byOrder.get(Number(o.id)) || [],
    }))
    return res.json({ orders: out })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch wholesale orders' })
  }
})

app.get('/api/admin/wholesale/orders/:id', requireAuth, async (req, res) => {
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const [rows] = await dbQuery(
      `SELECT
        *,
        order_code AS order_number,
        CONCAT(first_name, ' ', last_name) AS customer_name,
        email AS customer_email,
        mobile AS customer_phone,
        country AS shipping_country,
        grand_total AS total
      FROM wholesale_orders
      WHERE id = $1
     `,
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return res.status(404).json({ error: 'Order not found' })
    const order = { ...list[0], payment_status: list[0]?.payment_status || 'pending' }

    const [itemsRows] = await dbQuery('SELECT * FROM wholesale_order_items WHERE wholesale_order_id = $1 ORDER BY id ASC', [id])
    const [allocRows] = await dbQuery(
      `SELECT a.*, tm.display_name
       FROM wholesale_work_allocations a
       LEFT JOIN wholesale_team_members tm ON tm.id = a.team_member_id
       WHERE a.wholesale_order_id = $1
       ORDER BY a.created_at DESC`,
      [id]
    )

    return res.json({ order, items: Array.isArray(itemsRows) ? itemsRows : [], allocations: Array.isArray(allocRows) ? allocRows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch wholesale order' })
  }
})

app.post('/api/admin/wholesale/orders', requireAuth, async (req, res) => {
  let connection
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const body = req.body || {}

    // Accept both snake_case and camelCase field names
    const firstName     = String(body?.first_name    || body?.firstName    || '').trim().slice(0, 120)
    const lastName      = String(body?.last_name     || body?.lastName     || '').trim().slice(0, 120)
    const email         = String(body?.email         || '').trim().toLowerCase().slice(0, 255)
    const mobile        = String(body?.mobile        || '').trim().slice(0, 64)
    const altMobile     = String(body?.alt_mobile    || body?.altMobile    || '').trim().slice(0, 64) || null
    const address1      = String(body?.address_line1 || body?.address1     || body?.address || '').trim().slice(0, 255) || null
    const address2      = String(body?.address_line2 || body?.address2     || '').trim().slice(0, 255) || null
    const city          = String(body?.city          || '').trim().slice(0, 100) || null
    const state         = String(body?.state         || '').trim().slice(0, 100) || null
    const country       = String(body?.country       || '').trim().slice(0, 100)
    const postalCode    = String(body?.postal_code   || body?.postalCode   || '').trim().slice(0, 32) || null
    const deliveryDate  = body?.delivery_date  || body?.deliveryDate  ? String(body.delivery_date || body.deliveryDate).slice(0, 10) : null
    const notes         = body?.notes !== undefined && body?.notes !== null ? String(body.notes).trim() : null
    const discountAmount = toMoney(Number(body?.discount_amount ?? body?.discountAmount ?? 0))
    const requestedCurrency = String(body?.currency || 'GBP').trim().toUpperCase().slice(0, 3) || 'GBP'

    if (!firstName) return res.status(400).json({ error: 'first_name is required' })
    if (!lastName)  return res.status(400).json({ error: 'last_name is required' })
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' })
    if (!mobile)    return res.status(400).json({ error: 'mobile is required' })
    if (!country)   return res.status(400).json({ error: 'country is required' })
    if (!address1)  return res.status(400).json({ error: 'address_line1 is required' })
    if (!city)      return res.status(400).json({ error: 'city is required' })
    if (!postalCode) return res.status(400).json({ error: 'postal_code is required' })

    const itemsRaw = Array.isArray(body?.items) ? body.items : []
    const items = itemsRaw
      .map((it) => ({
        product_code:  String(it?.product_code  || '').trim(),
        product_title: String(it?.product_title || it?.name || '').trim(),
        unit_price:    Number(it?.unit_price ?? it?.price ?? 0),
        quantity:      Number(it?.quantity),
      }))
      .filter((it) => it.product_code)
      .slice(0, 20)

    if (!items.length) return res.status(400).json({ error: 'At least one item is required' })

    for (const it of items) {
      if (!Number.isFinite(it.quantity) || it.quantity <= 0)
        return res.status(400).json({ error: `Invalid quantity for ${it.product_code}` })
      if (!Number.isFinite(it.unit_price) || it.unit_price < 0)
        return res.status(400).json({ error: `Invalid unit_price for ${it.product_code}` })
      it.quantity = Math.min(Math.trunc(it.quantity), 100000)
    }

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    // Enrich items from wholesale_products if available; fall back to request values
    const codes = [...new Set(items.map((x) => x.product_code))]
    const [prodRows] = await dbQueryConn(
      connection,
      `SELECT code, title, unit_price, currency FROM wholesale_products WHERE code IN (${codes.map((_, i) => '$' + (i + 1)).join(',')})`,
      codes
    )
    const prodMap = new Map((Array.isArray(prodRows) ? prodRows : []).map((p) => [String(p.code), p]))

    let subtotal = 0
    const expanded = items.map((it) => {
      const dbProd   = prodMap.get(it.product_code)
      const unitPrice = toMoney(Number(dbProd?.unit_price ?? it.unit_price))
      const title     = String(dbProd?.title || it.product_title || it.product_code)
      const lineTotal = toMoney(unitPrice * it.quantity)
      subtotal += lineTotal
      return { product_code: it.product_code, product_title: title, unit_price: unitPrice, quantity: it.quantity, line_total: lineTotal }
    })
    subtotal = toMoney(subtotal)

    const currency    = String(prodRows?.[0]?.currency || requestedCurrency)
    const grandTotal  = toMoney(Math.max(0, subtotal - discountAmount))
    const orderCode   = `W${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 64)
    const adminId     = Number.isFinite(Number(req.adminUser?.id)) ? Number(req.adminUser.id) : null
    const wholesaleDomainId = (await resolveAdminDomainFilter(req)) ?? req.domainId

    const [ins] = await dbQueryConn(
      connection,
      `INSERT INTO wholesale_orders (
        order_code, first_name, last_name, email, mobile, alt_mobile,
        address_line1, address_line2, city, state, country, postal_code,
        delivery_date, notes, subtotal, discount_amount, grand_total, currency, status, created_by_admin_id, domain_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19,$20) RETURNING id`,
      [orderCode, firstName, lastName, email, mobile, altMobile,
       address1, address2, city, state, country, postalCode,
       deliveryDate, notes, subtotal, discountAmount, grandTotal, currency,
       adminId, wholesaleDomainId ?? null]
    )

    const orderId = ins?.insertId
    if (!orderId) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Failed to create order' })
    }

    for (const it of expanded) {
      await dbQueryConn(
        connection,
        `INSERT INTO wholesale_order_items (wholesale_order_id, product_code, product_title, unit_price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [Number(orderId), it.product_code, it.product_title, it.unit_price, it.quantity, it.line_total]
      )
    }

    await dbQueryConn(connection, 'COMMIT')

    const [orderRows] = await dbQuery('SELECT * FROM wholesale_orders WHERE id = $1', [Number(orderId)])
    const [itemRows]  = await dbQuery('SELECT * FROM wholesale_order_items WHERE wholesale_order_id = $1 ORDER BY id ASC', [Number(orderId)])
    return res.status(201).json({ success: true, order: Array.isArray(orderRows) ? orderRows[0] : null, items: Array.isArray(itemRows) ? itemRows : [] })
  } catch (e) {
    if (connection) {
      try { await dbQueryConn(connection, 'ROLLBACK') } catch {}
    }
    return res.status(500).json({ error: e?.message || 'Failed to create wholesale order' })
  } finally {
    if (connection) connection.release()
  }
})

app.post('/api/admin/wholesale/allocations', requireAuth, async (req, res) => {
  let connection
  try {
    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const orderId = Number(req.body?.wholesale_order_id)
    const orderItemId = Number(req.body?.wholesale_order_item_id)
    const memberId = Number(req.body?.team_member_id)
    const qty = Number(req.body?.quantity_assigned)
    const note = req.body?.note !== undefined && req.body?.note !== null ? String(req.body.note).trim().slice(0, 255) : null

    if (!Number.isFinite(orderId)) return res.status(400).json({ error: 'Invalid wholesale_order_id' })
    if (!Number.isFinite(orderItemId)) return res.status(400).json({ error: 'Invalid wholesale_order_item_id' })
    if (!Number.isFinite(memberId)) return res.status(400).json({ error: 'Invalid team_member_id' })
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Invalid quantity_assigned' })

    const quantityAssigned = Math.min(Math.trunc(qty), 100000)
    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 'SELECT id, status FROM wholesale_orders WHERE id = $1 LIMIT 1 FOR UPDATE', [orderId])
    const orderList = Array.isArray(orderRows) ? orderRows : []
    if (!orderList.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Wholesale order not found' })
    }

    const [itemRows] = await dbQueryConn(connection, 
      'SELECT id, wholesale_order_id, product_code, quantity FROM wholesale_order_items WHERE id = $1 AND wholesale_order_id = $2 LIMIT 1 FOR UPDATE',
      [orderItemId, orderId]
    )
    const itemList = Array.isArray(itemRows) ? itemRows : []
    if (!itemList.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Wholesale order item not found' })
    }
    const item = itemList[0]

    const [memberRows] = await dbQueryConn(connection, 'SELECT id, is_active FROM wholesale_team_members WHERE id = $1', [memberId])
    const memberList = (Array.isArray(memberRows) ? memberRows : []).filter(r => r.is_active !== false && r.is_active !== 0 && r.is_active !== '0')
    if (!memberList.length) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Team member not found or inactive' })
    }

    const [allocSumRows] = await dbQueryConn(connection, 
      'SELECT COALESCE(SUM(quantity_assigned),0) AS assigned FROM wholesale_work_allocations WHERE wholesale_order_item_id = $1',
      [orderItemId]
    )
    const alreadyAssigned = Array.isArray(allocSumRows) && allocSumRows[0] ? Number(allocSumRows[0].assigned) : 0
    const maxQty = Number(item?.quantity || 0)
    if (alreadyAssigned + quantityAssigned > maxQty) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: `Allocation exceeds remaining quantity. Remaining: ${Math.max(0, maxQty - alreadyAssigned)}` })
    }

    // Inventory decrement: 1 unit consumes 1 of each raw material.
    const materials = ['Pen', 'Cartridge', 'Needle', 'Magnet Box', 'Leaflet', 'Powder', 'Solution']
    const [stockRows] = await dbQueryConn(connection, 
      `SELECT material_name, on_hand FROM wholesale_raw_material_stock WHERE material_name IN (${materials.map((_, i) => '$' + (i + 1)).join(',')}) FOR UPDATE`,
      materials
    )
    const stockList = Array.isArray(stockRows) ? stockRows : []
    const stockMap = new Map(stockList.map((s) => [String(s.material_name), Number(s.on_hand || 0)]))
    for (const m of materials) {
      const onHand = Number(stockMap.get(m) ?? 0)
      if (!Number.isFinite(onHand) || onHand < quantityAssigned) {
        dbQueryConn(connection, 'ROLLBACK')
        return res.status(409).json({ error: `Insufficient stock for ${m}. Need ${quantityAssigned}, have ${Number.isFinite(onHand) ? onHand : 0}` })
      }
    }

    const [ins] = await dbQueryConn(connection, 
      `INSERT INTO wholesale_work_allocations (wholesale_order_id, wholesale_order_item_id, team_member_id, quantity_assigned, note, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orderId, orderItemId, memberId, quantityAssigned, note, Number.isFinite(adminId) ? adminId : null]
    )
    const allocId = ins?.insertId
    if (!allocId) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Failed to create allocation' })
    }

    for (const m of materials) {
      const onHand = Number(stockMap.get(m) ?? 0)
      const next = Math.max(0, Math.trunc(onHand - quantityAssigned))
      // eslint-disable-next-line no-await-in-loop
      await dbQueryConn(connection, 'UPDATE wholesale_raw_material_stock SET on_hand = $1 WHERE material_name = $2', [next, m])
    }

    await dbQueryConn(connection, 
      `UPDATE wholesale_orders
       SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [orderId]
    )

    dbQueryConn(connection, 'COMMIT')

    const [allocRows] = await dbQuery(
      `SELECT a.*, tm.display_name
       FROM wholesale_work_allocations a
       LEFT JOIN wholesale_team_members tm ON tm.id = a.team_member_id
       WHERE a.id = $1
      `,
      [Number(allocId)]
    )
    const [materialsRows] = await dbQuery(
      `SELECT m.name, m.unit, COALESCE(s.on_hand,0) AS on_hand, COALESCE(s.updated_at, CURRENT_TIMESTAMP) AS updated_at
       FROM wholesale_raw_materials m
       LEFT JOIN wholesale_raw_material_stock s ON s.material_name = m.name
       ORDER BY m.name ASC`
    )

    return res.json({ ok: true, allocation: Array.isArray(allocRows) ? allocRows[0] : null, materials: Array.isArray(materialsRows) ? materialsRows : [] })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to create allocation' })
  } finally {
    if (connection) connection.release()
  }
})

// Get product inventory by country
app.get('/api/admin/wholesale/product-inventory', requireAuth, async (req, res) => {
  try {
    try {
      await ensureWholesaleProductInventorySchema()
    } catch {
      // ignore
    }

    const product = String(req.query?.product || '').trim()
    const country = String(req.query?.country || '').trim()

    let sql = 'SELECT * FROM wholesale_product_inventory WHERE 1=1'
    const params = []

    if (product) {
      sql += ' AND product_name = $1'
      params.push(product)
    }
    if (country) {
      sql += ' AND country = $1'
      params.push(country)
    }

    sql += ' ORDER BY product_name ASC, country ASC'

    const [rows] = await dbQuery(sql, params)
    return res.json({ inventory: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch product inventory' })
  }
})

// Update product inventory
app.put('/api/admin/wholesale/product-inventory', requireAuth, async (req, res) => {
  let connection
  try {
    try {
      await ensureWholesaleProductInventorySchema()
    } catch {
      // ignore
    }

    const { product_name, country, cartridge, leaflet, magnet_box, pen, solution, needles, powder } = req.body || {}

    if (!product_name || !country) {
      return res.status(400).json({ error: 'Product name and country are required' })
    }

    connection = await pool.connect()

    await dbQueryConn(connection, 
      `INSERT INTO wholesale_product_inventory (product_name, country, cartridge, leaflet, magnet_box, pen, solution, needles, powder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product_name, country) DO UPDATE SET
       cartridge = EXCLUDED.cartridge,
       leaflet = EXCLUDED.leaflet,
       magnet_box = EXCLUDED.magnet_box,
       pen = EXCLUDED.pen,
       solution = EXCLUDED.solution,
       needles = EXCLUDED.needles,
       powder = EXCLUDED.powder`,
      [
        product_name,
        country,
        Math.max(0, Number(cartridge) || 0),
        Math.max(0, Number(leaflet) || 0),
        Math.max(0, Number(magnet_box) || 0),
        Math.max(0, Number(pen) || 0),
        Math.max(0, Number(solution) || 0),
        Math.max(0, Number(needles) || 0),
        Math.max(0, Number(powder) || 0),
      ]
    )

    const [rows] = await dbQueryConn(connection, 
      'SELECT * FROM wholesale_product_inventory WHERE product_name = $1 AND country = $2',
      [product_name, country]
    )

    return res.json({ ok: true, inventory: Array.isArray(rows) && rows[0] ? rows[0] : null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to update product inventory' })
  } finally {
    if (connection) connection.release()
  }
})

// Get product recipes
app.get('/api/admin/wholesale/product-recipes', requireAuth, async (_req, res) => {
  try {
    try {
      await ensureWholesaleProductInventorySchema()
    } catch {
      // ignore
    }

    const [rows] = await dbQuery('SELECT * FROM wholesale_product_recipes ORDER BY product_name ASC')
    return res.json({ recipes: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch product recipes' })
  }
})

// Get countries list
app.get('/api/admin/wholesale/countries', requireAuth, async (_req, res) => {
  try {
    const countries = ['United Kingdom', 'United States', 'Canada', 'Australia', 'Germany', 'France', 'Netherlands', 'Sweden', 'Ireland', 'Switzerland']
    return res.json({ success: true, countries })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch countries' })
  }
})

// Create wholesale order with inventory deduction
app.post('/api/admin/wholesale/orders-with-deduction', requireAuth, async (req, res) => {
  let connection
  try {
    try {
      await ensureWholesaleProductInventorySchema()
    } catch {
      // ignore
    }

    const body = req.body || {}
    const firstName = String(body?.firstName || '').trim().slice(0, 120)
    const lastName = String(body?.lastName || '').trim().slice(0, 120)
    const email = String(body?.email || '').trim().toLowerCase().slice(0, 255)
    const mobile = String(body?.mobile || '').trim().slice(0, 64)
    const country = String(body?.country || '').trim().slice(0, 100)
    const deliveryDate = body?.deliveryDate ? String(body.deliveryDate).slice(0, 10) : null
    const totalPayment = toMoney(Number(body?.totalPayment || 0))
    const receivedPayment = toMoney(Number(body?.receivedPayment || 0))
    const pendingPayment = toMoney(Number(body?.pendingPayment || 0))

    if (!firstName) return res.status(400).json({ error: 'First Name is required' })
    if (!lastName) return res.status(400).json({ error: 'Last Name is required' })
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid Email is required' })
    if (!mobile) return res.status(400).json({ error: 'Contact Number is required' })
    if (!country) return res.status(400).json({ error: 'Country is required' })

    const itemsRaw = Array.isArray(body?.items) ? body.items : []
    const items = itemsRaw
      .map((it) => ({
        product_name: String(it?.product_name || '').trim(),
        quantity: Number(it?.quantity),
      }))
      .filter((it) => it.product_name)
      .slice(0, 20)

    if (!items.length) return res.status(400).json({ error: 'At least one product is required' })

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    // Get recipes for all products
    const productNames = items.map((i) => i.product_name)
    const [recipeRows] = await dbQueryConn(connection, 
      `SELECT * FROM wholesale_product_recipes WHERE product_name IN (${productNames.map((_, i) => '$' + (i + 1)).join(',')})`,
      productNames
    )
    const recipes = Array.isArray(recipeRows) ? recipeRows : []
    const recipeMap = new Map(recipes.map((r) => [r.product_name, r]))

    // Validate all products have recipes
    for (const item of items) {
      if (!recipeMap.has(item.product_name)) {
        dbQueryConn(connection, 'ROLLBACK')
        return res.status(400).json({ error: `No recipe found for product: ${item.product_name}` })
      }
    }

    // Get current inventory for country
    const [inventoryRows] = await dbQueryConn(connection, 
      `SELECT * FROM wholesale_product_inventory WHERE country = $1 AND product_name IN (${productNames.map((_, i) => '$' + (i + 2)).join(',')}) FOR UPDATE`,
      [country, ...productNames]
    )
    const inventoryList = Array.isArray(inventoryRows) ? inventoryRows : []
    const inventoryMap = new Map(inventoryList.map((i) => [i.product_name, i]))

    // Calculate required materials
    const required = { cartridge: 0, leaflet: 0, magnet_box: 0, pen: 0, solution: 0, needles: 0, powder: 0 }
    for (const item of items) {
      const recipe = recipeMap.get(item.product_name)
      const qty = Math.max(0, Math.trunc(Number(item.quantity) || 0))
      required.cartridge += recipe.cartridge * qty
      required.leaflet += recipe.leaflet * qty
      required.magnet_box += recipe.magnet_box * qty
      required.pen += recipe.pen * qty
      required.solution += recipe.solution * qty
      required.needles += recipe.needles * qty
      required.powder += (Number(recipe.powder) || 0) * qty
    }

    // Check if we have enough inventory
    for (const item of items) {
      const inventory = inventoryMap.get(item.product_name)
      const recipe = recipeMap.get(item.product_name)
      const qty = Math.max(0, Math.trunc(Number(item.quantity) || 0))

      if (!inventory) {
        dbQueryConn(connection, 'ROLLBACK')
        return res.status(400).json({ error: `No inventory found for ${item.product_name} in ${country}` })
      }

      const checks = [
        { name: 'cartridge', need: recipe.cartridge * qty, have: inventory.cartridge },
        { name: 'leaflet', need: recipe.leaflet * qty, have: inventory.leaflet },
        { name: 'magnet_box', need: recipe.magnet_box * qty, have: inventory.magnet_box },
        { name: 'pen', need: recipe.pen * qty, have: inventory.pen },
        { name: 'solution', need: recipe.solution * qty, have: inventory.solution },
        { name: 'needles', need: recipe.needles * qty, have: inventory.needles },
        { name: 'powder', need: (Number(recipe.powder) || 0) * qty, have: inventory.powder },
      ]

      for (const check of checks) {
        if (check.have < check.need) {
          dbQueryConn(connection, 'ROLLBACK')
          return res.status(400).json({
            error: `Insufficient ${check.name} for ${item.product_name}. Need ${check.need}, have ${check.have}`,
          })
        }
      }
    }

    // Deduct inventory
    for (const item of items) {
      const recipe = recipeMap.get(item.product_name)
      const qty = Math.max(0, Math.trunc(Number(item.quantity) || 0))

      await dbQueryConn(connection, 
        `UPDATE wholesale_product_inventory SET
         cartridge = cartridge - $1,
         leaflet = leaflet - $2,
         magnet_box = magnet_box - $3,
         pen = pen - $4,
         solution = solution - $5,
         needles = needles - $6,
         powder = powder - $7
         WHERE country = $8 AND product_name = $9`,
        [
          recipe.cartridge * qty,
          recipe.leaflet * qty,
          recipe.magnet_box * qty,
          recipe.pen * qty,
          recipe.solution * qty,
          recipe.needles * qty,
          (Number(recipe.powder) || 0) * qty,
          country,
          item.product_name,
        ]
      )
    }

    // Create order
    const orderCode = `W${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 64)
    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const wholesaleDedupDomainId = (await resolveAdminDomainFilter(req)) ?? req.domainId

    const [ins] = await dbQueryConn(connection,
      `INSERT INTO wholesale_orders (
        order_code, first_name, last_name, email, mobile, country,
        delivery_date, total_payment, received_payment, pending_payment,
        grand_total, currency, status, created_by_admin_id, domain_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'GBP', 'pending', $12, $13) RETURNING id`,
      [
        orderCode,
        firstName,
        lastName,
        email,
        mobile,
        country,
        deliveryDate,
        totalPayment,
        receivedPayment,
        pendingPayment,
        totalPayment,
        Number.isFinite(adminId) ? adminId : null,
        wholesaleDedupDomainId ?? null,
      ]
    )

    const orderId = ins?.insertId
    if (!orderId) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Failed to create order' })
    }

    // Insert order items
    for (const item of items) {
      const recipe = recipeMap.get(item.product_name)
      const qty = Math.max(0, Math.trunc(Number(item.quantity) || 0))

      await dbQueryConn(connection, 
        `INSERT INTO wholesale_order_items (wholesale_order_id, product_code, product_title, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          item.product_name,
          item.product_name,
          qty,
          0,
          0,
        ]
      )
    }

    dbQueryConn(connection, 'COMMIT')

    const [orderRows] = await dbQuery('SELECT * FROM wholesale_orders WHERE id = $1', [Number(orderId)])
    const [itemRows] = await dbQuery(
      'SELECT * FROM wholesale_order_items WHERE wholesale_order_id = $1 ORDER BY id ASC',
      [Number(orderId)]
    )

    return res.json({
      ok: true,
      order: Array.isArray(orderRows) ? orderRows[0] : null,
      items: Array.isArray(itemRows) ? itemRows : [],
    })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to create wholesale order' })
  } finally {
    if (connection) connection.release()
  }
})

// Update wholesale order
app.put('/api/admin/wholesale/orders/:id', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    const body = req.body || {}
    const status = String(body?.status || '').trim().toLowerCase()
    const allowedStatus = ['pending', 'in_progress', 'completed', 'cancelled']
    
    if (status && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' })
    }

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 'SELECT id, status FROM wholesale_orders WHERE id = $1 LIMIT 1 FOR UPDATE', [id])
    const orderList = Array.isArray(orderRows) ? orderRows : []
    if (!orderList.length) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Wholesale order not found' })
    }

    const updates = []
    const params = []
    let p = 1

    // Accept both snake_case and camelCase field names
    const firstName    = body?.first_name    ?? body?.firstName
    const lastName     = body?.last_name     ?? body?.lastName
    const deliveryDate = body?.delivery_date ?? body?.deliveryDate
    const discountAmt  = body?.discount_amount ?? body?.discountAmount

    if (firstName    !== undefined) { updates.push(`first_name = $${p++}`);    params.push(String(firstName).trim().slice(0, 120)) }
    if (lastName     !== undefined) { updates.push(`last_name = $${p++}`);     params.push(String(lastName).trim().slice(0, 120)) }
    if (body?.email  !== undefined) { updates.push(`email = $${p++}`);         params.push(String(body.email).trim().toLowerCase().slice(0, 255)) }
    if (body?.mobile !== undefined) { updates.push(`mobile = $${p++}`);        params.push(String(body.mobile).trim().slice(0, 64)) }
    if (body?.country !== undefined){ updates.push(`country = $${p++}`);       params.push(String(body.country).trim().slice(0, 100)) }
    if (deliveryDate !== undefined) { updates.push(`delivery_date = $${p++}`); params.push(deliveryDate ? String(deliveryDate).slice(0, 10) : null) }
    if (body?.notes  !== undefined) { updates.push(`notes = $${p++}`);         params.push(String(body.notes).trim() || null) }
    if (discountAmt  !== undefined) { updates.push(`discount_amount = $${p++}`); params.push(toMoney(Number(discountAmt))) }
    if (body?.subtotal !== undefined){ updates.push(`subtotal = $${p++}`);     params.push(toMoney(Number(body.subtotal))) }
    if (body?.grand_total !== undefined || body?.grandTotal !== undefined) {
      const gt = body?.grand_total ?? body?.grandTotal
      updates.push(`grand_total = $${p++}`)
      params.push(toMoney(Number(gt)))
    }
    if (body?.total_payment !== undefined || body?.totalPayment !== undefined) {
      const tp = body?.total_payment ?? body?.totalPayment
      updates.push(`total_payment = $${p++}`)
      params.push(toMoney(Number(tp)))
    }
    if (status) { updates.push(`status = $${p++}`); params.push(status) }

    if (!updates.length) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'No fields to update' })
    }

    params.push(id)
    await dbQueryConn(connection,
      `UPDATE wholesale_orders SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${p}`,
      params
    )

    // Replace items if provided
    if (Array.isArray(body?.items) && body.items.length > 0) {
      await dbQueryConn(connection, 'DELETE FROM wholesale_order_items WHERE wholesale_order_id = $1', [id])
      for (const it of body.items) {
        const unitPrice = toMoney(Number(it?.unit_price ?? it?.price ?? 0))
        const qty       = Math.min(Math.trunc(Number(it?.quantity || 1)), 100000)
        const lineTotal = toMoney(unitPrice * qty)
        await dbQueryConn(
          connection,
          'INSERT INTO wholesale_order_items (wholesale_order_id, product_code, product_title, unit_price, quantity, line_total) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, String(it?.product_code || '').trim(), String(it?.product_title || it?.name || '').trim(), unitPrice, qty, lineTotal]
        )
      }
    }

    await dbQueryConn(connection, 'COMMIT')

    const [updatedRows] = await dbQuery('SELECT * FROM wholesale_orders WHERE id = $1', [id])
    const [itemRows]    = await dbQuery('SELECT * FROM wholesale_order_items WHERE wholesale_order_id = $1 ORDER BY id ASC', [id])
    return res.json({ success: true, order: Array.isArray(updatedRows) ? updatedRows[0] : null, items: Array.isArray(itemRows) ? itemRows : [] })
  } catch (e) {
    if (connection) {
      try { await dbQueryConn(connection, 'ROLLBACK') } catch {}
    }
    return res.status(500).json({ error: e?.message || 'Failed to update wholesale order' })
  } finally {
    if (connection) connection.release()
  }
})

// Delete wholesale order
app.delete('/api/admin/wholesale/orders/:id', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    try {
      await ensureWholesaleConsoleSchema()
    } catch {
      // ignore
    }

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 'SELECT id FROM wholesale_orders WHERE id = $1 FOR UPDATE', [id])
    if (!Array.isArray(orderRows) || !orderRows.length) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Wholesale order not found' })
    }

    await dbQueryConn(connection, 'DELETE FROM wholesale_work_allocations WHERE wholesale_order_id = $1', [id])
    await dbQueryConn(connection, 'DELETE FROM wholesale_order_items WHERE wholesale_order_id = $1', [id])
    await dbQueryConn(connection, 'DELETE FROM wholesale_orders WHERE id = $1', [id])

    await dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try { await dbQueryConn(connection, 'ROLLBACK') } catch {}
    }
    return res.status(500).json({ error: e?.message || 'Failed to delete wholesale order' })
  } finally {
    if (connection) connection.release()
  }
})

app.get('/api/admin/affiliate-requests', requireAuth, async (req, res) => {
  try {
    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const status = String(req.query?.status || 'pending').trim().toLowerCase()
    const allowed = ['pending', 'approved', 'rejected', 'all']
    const safeStatus = allowed.includes(status) ? status : 'pending'

    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const offset = Math.max(Number(req.query?.offset || 0), 0)
    const domainId = await resolveAdminDomainFilter(req)

    let sql = `SELECT * FROM affiliate_requests`
    const params = []
    const where = []
    if (safeStatus !== 'all') {
      params.push(safeStatus)
      where.push(`status = $${params.length}`)
    }
    if (domainId != null) {
      params.push(domainId)
      where.push(`domain_id = $${params.length}`)
    }
    if (where.length) sql += ` WHERE ` + where.join(' AND ')
    sql += ` ORDER BY created_at DESC LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`

    const [rows] = await dbQuery(sql, params)
    return res.json({ requests: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch affiliate requests' })
  }
})



app.post('/api/admin/affiliate-requests/:id/approve', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const promoPercent = Number(req.body?.percent)
    const percent = Number.isFinite(promoPercent) && promoPercent > 0 ? Math.min(Math.trunc(promoPercent), 90) : 10

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      'SELECT * FROM affiliate_requests WHERE id = $1 LIMIT 1 FOR UPDATE',
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    const reqRow = list[0]
    if (String(reqRow?.status || '').toLowerCase() !== 'pending') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Request is not pending' })
    }

    const userId = Number(reqRow?.user_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'Request missing user_id' })
    }

    const userName = String(reqRow?.user_name || '').trim()
    const promoCode = await generateUniqueAffiliatePromoCode(connection, userName, percent)
    const affiliateDomainId = (await resolveAdminDomainFilter(req)) ?? req.domainId

    await dbQueryConn(connection,
      `INSERT INTO promo_codes (code, percent, source, user_id, is_active, created_at, domain_id)
       VALUES ($1, $2, 'affiliate', $3, 1, $4, $5)
       ON CONFLICT (code) DO UPDATE SET percent = EXCLUDED.percent, is_active = 1, updated_at = CURRENT_TIMESTAMP`,
      [promoCode, percent, userId, now, affiliateDomainId ?? null]
    )

    await dbQueryConn(connection,
      `UPDATE affiliate_requests
       SET status = 'approved', promo_code = $1, promo_percent = $2, admin_id = $3, admin_note = $4, decided_at = $5, updated_at = $6
       WHERE id = $7`,
      [promoCode, percent, Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    await dbQueryConn(connection,
      `INSERT INTO affiliates (user_id, promo_code, promo_percent, reward_amount, status, approved_at, created_at, domain_id)
       VALUES ($1, $2, $3, 10.00, 'approved', $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET promo_code = EXCLUDED.promo_code, promo_percent = EXCLUDED.promo_percent, reward_amount = 10.00, status = 'approved', approved_at = EXCLUDED.approved_at, updated_at = CURRENT_TIMESTAMP`,
      [userId, promoCode, percent, now, now, affiliateDomainId ?? null]
    )

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true, promoCode, percent })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to approve affiliate request' })
  } finally {
    if (connection) connection.release()
  }
})



app.post('/api/admin/affiliate-requests/:id/reject', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 'SELECT status FROM affiliate_requests WHERE id = $1 LIMIT 1 FOR UPDATE', [id])
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    if (String(list[0]?.status || '').toLowerCase() !== 'pending') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Request is not pending' })
    }

    await dbQueryConn(connection, 
      `UPDATE affiliate_requests
       SET status = 'rejected', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to reject affiliate request' })
  } finally {
    if (connection) connection.release()
  }
})

app.post('/api/admin/affiliate-requests/:id/revoke', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      'SELECT id, user_id, promo_code, status FROM affiliate_requests WHERE id = $1 LIMIT 1 FOR UPDATE',
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    const reqRow = list[0]
    const currentStatus = String(reqRow?.status || '').toLowerCase()
    if (currentStatus === 'revoked') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Request already revoked' })
    }
    if (currentStatus !== 'approved') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Only approved requests can be revoked' })
    }

    const userId = Number(reqRow?.user_id)
    const promoCode = String(reqRow?.promo_code || '').trim()

    await dbQueryConn(connection, 
      `UPDATE affiliate_requests
       SET status = 'revoked', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    if (promoCode) {
      await dbQueryConn(connection, 
        `UPDATE promo_codes SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE code = $1 AND LOWER(source) = 'affiliate'`,
        [promoCode]
      )
    }

    if (Number.isFinite(userId) && userId > 0) {
      await dbQueryConn(connection, 
        `UPDATE affiliates SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [userId]
      )
    }

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to revoke affiliate request' })
  } finally {
    if (connection) connection.release()
  }
})

// Reinstate a previously revoked affiliate. Mirrors the revoke endpoint but in reverse.
app.post('/api/admin/affiliate-requests/:id/reinstate', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      'SELECT id, user_id, promo_code, status FROM affiliate_requests WHERE id = $1 LIMIT 1 FOR UPDATE',
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    const reqRow = list[0]
    const currentStatus = String(reqRow?.status || '').toLowerCase()
    if (currentStatus === 'approved') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Affiliate is already active' })
    }
    if (currentStatus !== 'revoked') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Only revoked affiliates can be reinstated' })
    }

    const userId = Number(reqRow?.user_id)
    const promoCode = String(reqRow?.promo_code || '').trim()

    await dbQueryConn(connection, 
      `UPDATE affiliate_requests
       SET status = 'approved', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    if (promoCode) {
      await dbQueryConn(connection, 
        `UPDATE promo_codes SET is_active = 1, updated_at = CURRENT_TIMESTAMP
         WHERE code = $1 AND LOWER(source) = 'affiliate'`,
        [promoCode]
      )
    }

    if (Number.isFinite(userId) && userId > 0) {
      await dbQueryConn(connection, 
        `UPDATE affiliates SET status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [userId]
      )
    }

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to reinstate affiliate request' })
  } finally {
    if (connection) connection.release()
  }
})

// List all affiliates with wallet balance + redemption aggregates for the admin Affiliates tab.
app.get('/api/admin/affiliates', requireAuth, async (req, res) => {
  try {
    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const limit = Math.min(Math.max(Number(req.query?.limit || 500), 1), 1000)
    const offset = Math.max(Number(req.query?.offset || 0), 0)
    const domainId = await resolveAdminDomainFilter(req)
    const domainParams = []
    let domainWhereClause = ''
    if (domainId != null) {
      domainParams.push(domainId)
      domainWhereClause = `WHERE a.domain_id = $${domainParams.length}`
    }

    const sql = `
      SELECT
        a.id              AS affiliate_id,
        ar.id             AS request_id,
        a.user_id,
        a.promo_code,
        a.promo_percent,
        a.reward_amount,
        a.first_name,
        a.last_name,
        a.tiktok_link,
        a.status,
        a.approved_at,
        a.created_at,
        u.email           AS user_email,
        COALESCE(NULLIF(TRIM(u.name), ''), TRIM(CONCAT_WS(' ', a.first_name, a.last_name))) AS user_name,
        COALESCE(c.balance, 0)             AS wallet_balance,
        COALESCE(r.redemption_count, 0)    AS redemption_count,
        COALESCE(r.total_earned, 0)        AS total_earned
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN affiliate_requests ar ON ar.user_id = a.user_id
      LEFT JOIN user_credits c ON c.user_id = a.user_id
      LEFT JOIN (
        SELECT affiliate_user_id,
               COUNT(*)            AS redemption_count,
               SUM(reward_amount)  AS total_earned
        FROM promo_redemptions
        GROUP BY affiliate_user_id
      ) r ON r.affiliate_user_id = a.user_id
      ${domainWhereClause}
      ORDER BY a.created_at DESC
      LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}
    `

    const [rows] = await dbQuery(sql, domainParams)
    return res.json({ affiliates: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch affiliates' })
  }
})

// Diagnostic: returns raw row counts + samples so we can see if the affiliate pipeline is producing data.
// MUST be registered before /api/admin/affiliates/:id so Express does not match :id = '_debug'.
app.get('/api/admin/affiliates/_debug', requireAuth, async (req, res) => {
  try {
    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const safeCount = async (sql, params = []) => {
      try {
        const [rows] = await dbQuery(sql, params)
        return Number(rows?.[0]?.c || 0)
      } catch (e) {
        return { error: e?.message || String(e) }
      }
    }
    const safeRows = async (sql, params = []) => {
      try {
        const [rows] = await dbQuery(sql, params)
        return Array.isArray(rows) ? rows : []
      } catch (e) {
        return { error: e?.message || String(e) }
      }
    }

    const counts = {
      affiliates_total: await safeCount('SELECT COUNT(*) AS c FROM affiliates'),
      affiliates_approved: await safeCount("SELECT COUNT(*) AS c FROM affiliates WHERE LOWER(status) = 'approved'"),
      affiliates_revoked: await safeCount("SELECT COUNT(*) AS c FROM affiliates WHERE LOWER(status) = 'revoked'"),
      promo_codes_total: await safeCount('SELECT COUNT(*) AS c FROM promo_codes'),
      promo_codes_active_affiliate: await safeCount("SELECT COUNT(*) AS c FROM promo_codes WHERE is_active = 1 AND LOWER(source) = 'affiliate'"),
      promo_redemptions_total: await safeCount('SELECT COUNT(*) AS c FROM promo_redemptions'),
      user_credits_with_balance: await safeCount('SELECT COUNT(*) AS c FROM user_credits WHERE balance > 0'),
      paid_orders_with_promo: await safeCount(
        "SELECT COUNT(*) AS c FROM orders WHERE LOWER(payment_status) = 'received' AND promo_code IS NOT NULL AND TRIM(promo_code) <> '' AND TRIM(promo_code) <> '-' AND UPPER(TRIM(promo_code)) <> 'NONE'"
      ),
      paid_orders_with_affiliate_code_no_redemption: await safeCount(
        `SELECT COUNT(*) AS c
         FROM orders o
         JOIN promo_codes pc ON pc.code = UPPER(TRIM(o.promo_code)) AND LOWER(pc.source) = 'affiliate'
         LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
         WHERE LOWER(o.payment_status) = 'received'
           AND pr.id IS NULL`
      ),
    }

    const samples = {
      recent_affiliates: await safeRows('SELECT id, user_id, promo_code, status, created_at FROM affiliates ORDER BY id DESC LIMIT 5'),
      recent_redemptions: await safeRows(
        'SELECT id, order_number, promo_code, affiliate_user_id, customer_email, reward_amount, created_at FROM promo_redemptions ORDER BY id DESC LIMIT 10'
      ),
      paid_orders_with_promo_no_redemption: await safeRows(
        `SELECT o.id, o.order_number, o.customer_email, o.promo_code, o.payment_status, o.total
         FROM orders o
         LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
         WHERE LOWER(o.payment_status) = 'received'
           AND o.promo_code IS NOT NULL
           AND TRIM(o.promo_code) <> ''
           AND TRIM(o.promo_code) <> '-'
           AND UPPER(TRIM(o.promo_code)) <> 'NONE'
           AND pr.id IS NULL
         ORDER BY o.id DESC
         LIMIT 20`
      ),
    }

    return res.json({ ok: true, counts, samples })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to load debug data' })
  }
})

// Backfill: retroactively grant rewards for paid orders with affiliate promo codes that were never credited.
// Idempotent — uses UNIQUE constraint on (affiliate_user_id, customer_email) to prevent double-grants.
// MUST be registered before /api/admin/affiliates/:id.
app.post('/api/admin/affiliates/_backfill', requireAuth, async (req, res) => {
  let connection
  try {
    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const DEFAULT_REWARD = Number(process.env.AFFILIATE_DEFAULT_REWARD || 40)
    const nowMysqlDatetime = () => {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    }

    connection = await pool.connect()

    const [orders] = await dbQueryConn(connection,
      `SELECT o.id, o.order_number, o.customer_email, o.promo_code, o.domain_id
       FROM orders o
       LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
       WHERE LOWER(o.payment_status) = 'received'
         AND o.promo_code IS NOT NULL
         AND TRIM(o.promo_code) <> ''
         AND TRIM(o.promo_code) <> '-'
         AND UPPER(TRIM(o.promo_code)) <> 'NONE'
         AND pr.id IS NULL
       ORDER BY o.id ASC`
    )

    const results = []
    const tally = { granted: 0, skipped_not_affiliate: 0, skipped_self_referral: 0, skipped_customer_already_rewarded: 0, skipped_no_email: 0, errors: 0 }

    for (const order of (Array.isArray(orders) ? orders : [])) {
      const orderId = Number(order.id)
      const orderNumber = String(order.order_number || '').trim()
      const customerEmail = String(order.customer_email || '').trim().toLowerCase()
      const promoCode = String(order.promo_code || '').trim().toUpperCase()
      const entry = { order_number: orderNumber, promo_code: promoCode }

      if (!customerEmail || !customerEmail.includes('@')) {
        entry.outcome = 'skipped_no_email'
        tally.skipped_no_email++
        results.push(entry)
        continue
      }

      const [promoRows] = await dbQueryConn(connection, 
        "SELECT user_id FROM promo_codes WHERE code = $1 AND is_active = 1 AND LOWER(source) = 'affiliate' ORDER BY id DESC LIMIT 1",
        [promoCode]
      )
      const affiliateUserId = Number(promoRows?.[0]?.user_id)
      if (!Number.isFinite(affiliateUserId) || affiliateUserId <= 0) {
        entry.outcome = 'skipped_not_affiliate'
        tally.skipped_not_affiliate++
        results.push(entry)
        continue
      }

      const [uRows] = await dbQueryConn(connection, 
        'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1',
        [customerEmail]
      )
      const buyerUserId = Number(uRows?.[0]?.id)
      if (Number.isFinite(buyerUserId) && buyerUserId === affiliateUserId) {
        entry.outcome = 'skipped_self_referral'
        tally.skipped_self_referral++
        results.push(entry)
        continue
      }

      const [dupRows] = await dbQueryConn(connection, 
        'SELECT id FROM promo_redemptions WHERE affiliate_user_id = $1 AND customer_email = $2',
        [affiliateUserId, customerEmail]
      )
      if (dupRows?.[0]?.id) {
        entry.outcome = 'skipped_customer_already_rewarded'
        tally.skipped_customer_already_rewarded++
        results.push(entry)
        continue
      }

      try {
        dbQueryConn(connection, 'BEGIN')
        await dbQueryConn(connection, 'INSERT INTO user_credits (user_id, balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING', [affiliateUserId])
        await dbQueryConn(connection, 
          'UPDATE user_credits SET balance = COALESCE(balance, 0) + $1 WHERE user_id = $2',
          [DEFAULT_REWARD, affiliateUserId]
        )
        await dbQueryConn(connection, 
          'INSERT INTO credit_ledger (user_id, amount, source, order_number, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [affiliateUserId, DEFAULT_REWARD, 'affiliate_reward', orderNumber, `backfill: promo ${promoCode} redeemed`, nowMysqlDatetime()]
        )
        await dbQueryConn(connection,
          'INSERT INTO promo_redemptions (order_id, order_number, promo_code, affiliate_user_id, customer_email, reward_amount, status, created_at, domain_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [orderId, orderNumber, promoCode, affiliateUserId, customerEmail, DEFAULT_REWARD, 'granted', nowMysqlDatetime(), order?.domain_id ?? null]
        )
        dbQueryConn(connection, 'COMMIT')
        entry.outcome = 'granted'
        entry.affiliate_user_id = affiliateUserId
        entry.reward = DEFAULT_REWARD
        tally.granted++
      } catch (e) {
        try { dbQueryConn(connection, 'ROLLBACK') } catch { /* ignore */ }
        entry.outcome = 'error'
        entry.error = e?.message || String(e)
        tally.errors++
      }
      results.push(entry)
    }

    return res.json({ ok: true, candidates_found: orders.length, tally, results })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to run backfill' })
  } finally {
    if (connection) connection.release()
  }
})

// Detail for a single affiliate: stats + redemption rows joined with order + items.
app.get('/api/admin/affiliates/:id', requireAuth, async (req, res) => {
  try {
    try {
      await ensureAffiliateSchema()
    } catch {
      // ignore
    }

    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid affiliate id' })

    const [affRows] = await dbQuery(
      `SELECT
        a.id              AS affiliate_id,
        ar.id             AS request_id,
        a.user_id,
        a.promo_code,
        a.promo_percent,
        a.reward_amount,
        a.first_name,
        a.last_name,
        a.tiktok_link,
        a.status,
        a.approved_at,
        a.created_at,
        u.email           AS user_email,
        COALESCE(NULLIF(TRIM(u.name), ''), TRIM(CONCAT_WS(' ', a.first_name, a.last_name))) AS user_name,
        COALESCE(c.balance, 0)             AS wallet_balance,
        COALESCE(r.redemption_count, 0)    AS redemption_count,
        COALESCE(r.total_earned, 0)        AS total_earned
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN affiliate_requests ar ON ar.user_id = a.user_id
      LEFT JOIN user_credits c ON c.user_id = a.user_id
      LEFT JOIN (
        SELECT affiliate_user_id,
               COUNT(*)            AS redemption_count,
               SUM(reward_amount)  AS total_earned
        FROM promo_redemptions
        GROUP BY affiliate_user_id
      ) r ON r.affiliate_user_id = a.user_id
      WHERE a.id = $1
     `,
      [id]
    )
    const affiliate = Array.isArray(affRows) && affRows[0] ? affRows[0] : null
    if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' })

    const affiliateUserId = Number(affiliate.user_id)
    if (!Number.isFinite(affiliateUserId) || affiliateUserId <= 0) {
      return res.json({ affiliate, redemptions: [] })
    }

    const [redemptionRows] = await dbQuery(
      `SELECT
        pr.id                    AS redemption_id,
        pr.reward_amount,
        pr.created_at            AS redeemed_at,
        o.id                     AS order_id,
        o.order_number,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.subtotal,
        o.total,
        o.total_before_discount,
        o.total_after_discount,
        o.discount_amount,
        o.currency,
        o.payment_status,
        o.created_at             AS order_created_at
      FROM promo_redemptions pr
      LEFT JOIN orders o ON o.id = pr.order_id
      WHERE pr.affiliate_user_id = $1
      ORDER BY pr.created_at DESC
      LIMIT 500`,
      [affiliateUserId]
    )
    const redemptions = Array.isArray(redemptionRows) ? redemptionRows : []

    if (redemptions.length) {
      const orderIds = redemptions
        .map((r) => Number(r?.order_id))
        .filter((n) => Number.isFinite(n) && n > 0)

      if (orderIds.length) {
        const placeholders = orderIds.map((_, i) => '$' + (i + 1)).join(',')
        const [itemRows] = await dbQuery(
          `SELECT order_id, name, quantity, unit_price, line_total
           FROM order_items
           WHERE order_id IN (${placeholders})
           ORDER BY id ASC`,
          orderIds
        )
        const itemsByOrder = new Map()
        for (const it of Array.isArray(itemRows) ? itemRows : []) {
          const key = Number(it?.order_id)
          if (!Number.isFinite(key)) continue
          if (!itemsByOrder.has(key)) itemsByOrder.set(key, [])
          itemsByOrder.get(key).push({
            name: String(it?.name || ''),
            quantity: Number(it?.quantity || 0),
            unit_price: it?.unit_price !== null && it?.unit_price !== undefined ? Number(it.unit_price) : null,
            line_total: it?.line_total !== null && it?.line_total !== undefined ? Number(it.line_total) : null,
          })
        }
        for (const r of redemptions) {
          const key = Number(r?.order_id)
          r.items = Number.isFinite(key) && itemsByOrder.has(key) ? itemsByOrder.get(key) : []
        }
      } else {
        for (const r of redemptions) r.items = []
      }
    }

    return res.json({ affiliate, redemptions })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch affiliate detail' })
  }
})

app.post('/api/admin/email/customer-info/send', requireAuth, async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid to email is required' })

    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}
    const r = await sendCustomerInfoEmail(to, data)
    if (!r?.success) return res.status(502).json({ error: r?.error || 'Failed to send email' })
    return res.json({ success: true, messageId: r?.messageId })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send email' })
  }
})

app.post('/api/admin/email/template/send', requireAuth, async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid to email is required' })

    const type = String(req.body?.type || '').trim()
    if (!type) return res.status(400).json({ error: 'type is required' })

    const subject = String(req.body?.subject || '').trim() || `Order update - ${type}`
    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}

    const r = await sendEmail(to, subject, type, data)
    if (!r?.success) return res.status(502).json({ error: r?.error || 'Failed to send email' })
    return res.json({ success: true, messageId: r?.messageId })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send email' })
  }
})

app.post('/api/admin/email/ibalticx/send', requireAuth, async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid to email is required' })

    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}
    const rawItems = Array.isArray(data?.orderItems) ? data.orderItems : (Array.isArray(data?.items) ? data.items : [])
    const masked = buildIbalticxMaskedItems({
      orderItems: rawItems,
      promoDiscountPercent: data?.promoDiscountPercent ?? data?.promo_discount_percent,
      expectedTotal: data?.total,
    })

    const payload = {
      ...data,
      template: 'ibalticx',
      items: masked.items,
      subtotal: masked.subtotal,
      total: typeof data?.total !== 'undefined' ? Number(data.total || 0) : masked.total,
    }

    const r = await sendIbalticxEmail(to, payload)
    if (!r?.success) return res.status(502).json({ error: r?.error || 'Failed to send email' })
    return res.json({ success: true, messageId: r?.messageId })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send email' })
  }
})

app.post('/api/admin/email/payment-reminder/send', requireAuth, async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid to email is required' })

    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}

    const r = await sendPaymentReminderEmail(to, data)
    if (!r?.success) return res.status(502).json({ error: r?.error || 'Failed to send email' })

    return res.json({ success: true, messageId: r?.messageId })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send email' })
  }
})

app.post('/api/admin/orders/:orderNumber/resend-has-entry', requireAuth, async (req, res) => {
  try {
    return res.status(410).json({ error: 'HAS invoice sending is disabled' })

    const [rows] = await dbQuery(
      `SELECT
        id,
        order_number,
        customer_name,
        customer_email,
        customer_phone,
        shipping_address,
        shipping_city,
        shipping_zip,
        shipping_country,
        submitted_at,
        reserved_at,
        created_at,
        total,
        currency,
        promo_code,
        discount_amount,
        promo_discount_percent
      FROM orders
      WHERE order_number = $1
     `,
      [orderNumber]
    )

    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return res.status(404).json({ error: 'Order not found' })
    const order = list[0]

    const toDate = (value) => {
      if (!value) return null
      if (value instanceof Date) return value
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }

    const [payRows] = await dbQuery(
      `SELECT COALESCE(updated_at, created_at) AS payment_date
       FROM payments
       WHERE order_id = $1
         AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')
       ORDER BY COALESCE(updated_at, created_at) DESC
      `,
      [Number(order.id)]
    )
    const payList = Array.isArray(payRows) ? payRows : []
    const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null
    if (!paymentDate) return res.status(400).json({ error: 'No successful payment date found for this order' })
    const invoiceDate = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(paymentDate || new Date())

    const invoiceTotal = Number(order?.total || 0)
    const invoiceNumberRaw = `INV-${String(order?.order_number || orderNumber).trim() || Date.now()}`
    const invoiceNumber = String(invoiceNumberRaw)
      .replace(/^INV-ALU-/i, 'INV-')
      .replace(/^INV-ALU/i, 'INV-')

    const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'
    const customerPhone = String(order?.customer_phone || '').trim()
    const customerEmail = String(order?.customer_email || '').trim()

    const customerAddressLine1 = String(order?.shipping_address || '').trim()
    const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(', ')

    const billToAddress = [customerAddressLine1, customerAddressLine2]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(', ')

    let orderItems = []
    try {
      const [itemRows] = await dbQuery(
        'SELECT name, sku, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id ASC',
        [order.id]
      )
      orderItems = Array.isArray(itemRows) ? itemRows : []
    } catch {
      orderItems = []
    }

    const promoDiscountPercent = Number(order?.promo_discount_percent || 0)
    const promoCode = String(order?.promo_code || '').trim()
    const discountAmount = Number(order?.discount_amount || 0)
    const masked = buildHasInvoiceMaskedItems({
      orderItems,
      promoDiscountPercent,
      expectedTotal: invoiceTotal,
    })

    const baseUrl = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || env('PUBLIC_BASE_URL', '')).replace(/\/$/, '')

    const externalItems = (Array.isArray(masked?.items) ? masked.items : []).map((it) => {
      const quantity = Math.max(1, Number(it?.qty || 1))
      const unitPrice = Number(it?.rate ?? 0)
      const lineTotal = Number(it?.amount ?? (unitPrice * quantity))
      return {
        name: String(it?.description || '').trim(),
        sku: '',
        quantity,
        unit_price: Number.isFinite(unitPrice) ? unitPrice : 0,
        line_total: Number.isFinite(lineTotal) ? lineTotal : 0,
      }
    })

    // Send HAS invoice to IVMS accounts only
    const ibMasked = buildHasInvoiceMaskedItems({
      orderItems,
      promoDiscountPercent,
      expectedTotal: invoiceTotal,
    })

    const invoicePayload = {
      invoiceNumber,
      invoiceDate,
      billToName: customerDisplayName,
      billToAddressLine1: customerAddressLine1,
      billToAddressLine2: customerAddressLine2,
      billToNumber: customerPhone,
      items: ibMasked.items,
      subtotal: ibMasked.subtotal,
      total: ibMasked.total,
      promoCode: promoCode && promoCode !== '-' ? promoCode : '',
      promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
      bank: {
        bankName: 'HSA INTERPAY UK',
        bankAddress: '',
        accountNumber: '21327124',
        sortCode: '609561',
        beneficiaryName: 'HSA INTERPAY UK',
        reference: 'Ivms Subscription',
      },
    }

    return res.status(410).json({ error: 'HAS/IVMS invoice emails are disabled' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'HAS invoice sending is disabled' })
  }
})

app.post('/api/admin/orders/resend-all-has-entries', requireAuth, async (req, res) => {
  try {
    return res.status(410).json({ error: 'HAS invoice sending is disabled' })

    const [rows] = await dbQuery(
      `SELECT
        id,
        order_number,
        customer_name,
        customer_email,
        customer_phone,
        shipping_address,
        shipping_city,
        shipping_zip,
        shipping_country,
        submitted_at,
        reserved_at,
        created_at,
        total,
        currency,
        promo_code,
        discount_amount,
        promo_discount_percent,
        payment_status,
        status
      FROM orders
      WHERE LOWER(payment_status) IN ('received')
      ORDER BY created_at DESC
      LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`
    )

    const list = Array.isArray(rows) ? rows : []
    const results = []

    const toDate = (value) => {
      if (!value) return null
      if (value instanceof Date) return value
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }

    for (const order of list) {
      const orderNumber = String(order?.order_number || '').trim()
      if (!orderNumber) continue
      try {
        const [payRows] = await dbQuery(
          `SELECT COALESCE(updated_at, created_at) AS payment_date
           FROM payments
           WHERE order_id = $1
             AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')
           ORDER BY COALESCE(updated_at, created_at) DESC
          `,
          [Number(order.id)]
        )
        const payList = Array.isArray(payRows) ? payRows : []
        const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null
        if (!paymentDate) {
          results.push({ orderNumber, ok: false, error: 'No successful payment date found for this order' })
          continue
        }
        const invoiceDate = new Intl.DateTimeFormat('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(paymentDate || new Date())

        const invoiceTotal = Number(order?.total || 0)
        const invoiceNumberRaw = `INV-${String(order?.order_number || orderNumber).trim() || Date.now()}`
        const invoiceNumber = String(invoiceNumberRaw)
          .replace(/^INV-ALU-/i, 'INV-')
          .replace(/^INV-ALU/i, 'INV-')

        let orderItems = []
        try {
          const [itemRows] = await dbQuery(
            'SELECT name, sku, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id ASC',
            [Number(order.id)]
          )
          orderItems = Array.isArray(itemRows) ? itemRows : []
        } catch {
          orderItems = []
        }

        const promoDiscountPercent = Number(order?.promo_discount_percent || 0)
        const promoCode = String(order?.promo_code || '').trim()
        const discountAmount = Number(order?.discount_amount || 0)

        const masked = buildHasInvoiceMaskedItems({
          orderItems,
          promoDiscountPercent,
          expectedTotal: invoiceTotal,
        })

        const externalItems = (Array.isArray(masked?.items) ? masked.items : []).map((it) => {
          const quantity = Math.max(1, Number(it?.qty || 1))
          const unitPrice = Number(it?.rate ?? 0)
          const lineTotal = Number(it?.amount ?? (unitPrice * quantity))
          return {
            name: String(it?.description || '').trim(),
            sku: '',
            quantity,
            unit_price: Number.isFinite(unitPrice) ? unitPrice : 0,
            line_total: Number.isFinite(lineTotal) ? lineTotal : 0,
          }
        })

        const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'
        const customerPhone = String(order?.customer_phone || '').trim()
        const customerEmail = String(order?.customer_email || '').trim()

        const customerAddressLine1 = String(order?.shipping_address || '').trim()
        const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]
          .map((v) => String(v || '').trim())
          .filter(Boolean)
          .join(', ')

        const billToAddress = [customerAddressLine1, customerAddressLine2]
          .map((v) => String(v || '').trim())
          .filter(Boolean)
          .join(', ')

        // Send HAS invoice to IVMS accounts only
        const ibMasked = buildHasInvoiceMaskedItems({
          orderItems,
          promoDiscountPercent,
          expectedTotal: invoiceTotal,
        })

        const invoicePayload = {
          invoiceNumber,
          invoiceDate,
          billToName: customerDisplayName,
          billToAddressLine1: customerAddressLine1,
          billToAddressLine2: customerAddressLine2,
          billToNumber: customerPhone,
          items: ibMasked.items,
          subtotal: ibMasked.subtotal,
          total: ibMasked.total,
          promoCode: promoCode && promoCode !== '-' ? promoCode : '',
          promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,
          discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
          bank: {
            bankName: 'HSA INTERPAY UK',
            bankAddress: '',
            accountNumber: '21327124',
            sortCode: '609561',
            beneficiaryName: 'HSA INTERPAY UK',
            reference: 'Ivms Subscription',
          },

        }

        results.push({ orderNumber, ok: false, error: 'HAS/IVMS invoice emails are disabled' })
      } catch (e) {
        results.push({ orderNumber, ok: false, error: e?.message || 'Failed' })
      }
    }

    const sent = results.filter((r) => r?.ok).length
    const failed = results.filter((r) => !r?.ok).length

    return res.json({ success: true, total: list.length, sent, failed, results })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'HAS invoice sending is disabled' })
  }
})

app.post('/api/admin/email/has-invoice/send', requireAuth, async (req, res) => {
  try {
    return res.status(410).json({ error: 'HAS invoice sending is disabled' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'HAS invoice sending is disabled' })
  }
})

app.get('/api/admin/address-change-requests', requireAuth, async (req, res) => {
  try {
    const status = String(req.query?.status || 'pending').trim().toLowerCase()
    const allowed = ['pending', 'approved', 'rejected', 'all']
    const safeStatus = allowed.includes(status) ? status : 'pending'

    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const offset = Math.max(Number(req.query?.offset || 0), 0)

    let sql = `SELECT * FROM order_address_change_requests`
    const params = []
    if (safeStatus !== 'all') {
      sql += ` WHERE status = $1`
      params.push(safeStatus)
    }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`

    const [rows] = await dbQuery(sql, params)
    return res.json({ success: true, requests: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch address change requests' })
  }
})

app.post('/api/admin/address-change-requests/:id/approve', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      `SELECT * FROM order_address_change_requests WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }

    const reqRow = list[0]
    if (String(reqRow?.status || '').toLowerCase() !== 'pending') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Request is not pending' })
    }

    const requested = safeJsonParse(reqRow?.requested_shipping_json) || {}
    const shipping_address = normalizeAddressField(requested?.shipping_address || '', 255)
    const shipping_city = normalizeAddressField(requested?.shipping_city || '', 100)
    const shipping_zip = normalizeAddressField(requested?.shipping_zip || '', 30)
    const shipping_country = normalizeAddressField(requested?.shipping_country || '', 100)

    if (!shipping_address) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'Requested shipping address is invalid' })
    }

    const orderId = reqRow?.order_id !== undefined && reqRow?.order_id !== null ? Number(reqRow.order_id) : null
    const orderNumber = String(reqRow?.order_number || '').trim()

    if (Number.isFinite(orderId)) {
      await dbQueryConn(connection, 
        `UPDATE orders
         SET shipping_address = $1, shipping_city = $2, shipping_zip = $3, shipping_country = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [shipping_address, shipping_city, shipping_zip, shipping_country, orderId]
      )
    } else if (orderNumber) {
      await dbQueryConn(connection, 
        `UPDATE orders
         SET shipping_address = $1, shipping_city = $2, shipping_zip = $3, shipping_country = $4, updated_at = CURRENT_TIMESTAMP
         WHERE order_number = $5`,
        [shipping_address, shipping_city, shipping_zip, shipping_country, orderNumber]
      )
    } else {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(400).json({ error: 'Request missing order reference' })
    }

    await dbQueryConn(connection, 
      `UPDATE order_address_change_requests
       SET status = 'approved', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to approve request' })
  } finally {
    if (connection) connection.release()
  }
})

app.post('/api/admin/address-change-requests/:id/reject', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })

    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const now = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [rows] = await dbQueryConn(connection, 
      `SELECT status FROM order_address_change_requests WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    if (String(list[0]?.status || '').toLowerCase() !== 'pending') {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Request is not pending' })
    }

    await dbQueryConn(connection, 
      `UPDATE order_address_change_requests
       SET status = 'rejected', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE id = $5`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, id]
    )

    dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to reject request' })
  } finally {
    if (connection) connection.release()
  }
})

app.post('/api/admin/address-change-requests/approve-all', requireAuth, async (req, res) => {
  try {
    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const limit = Math.min(Math.max(Number(req.body?.limit || 200), 1), 1000)

    const [rows] = await dbQuery(
      `SELECT id FROM order_address_change_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${Math.trunc(limit)}`
    )
    const ids = (Array.isArray(rows) ? rows : []).map((r) => Number(r?.id)).filter((n) => Number.isFinite(n))

    let approved = 0
    let failed = 0
    const errors = []

    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const r = await approveAddressChangeRequestById(id, adminId, adminNote)
      if (r?.ok) {
        approved += 1
      } else {
        failed += 1
        if (errors.length < 50) errors.push({ id, error: r?.error || 'Failed' })
      }
    }

    return res.json({ success: true, total: ids.length, approved, failed, errors })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to approve all' })
  }
})

app.post('/api/admin/address-change-requests/reject-all', requireAuth, async (req, res) => {
  try {
    const adminId = req.adminUser?.id !== undefined && req.adminUser?.id !== null ? Number(req.adminUser.id) : null
    const adminNote = req.body?.adminNote !== undefined && req.body?.adminNote !== null ? String(req.body.adminNote).trim().slice(0, 255) : null
    const limit = Math.min(Math.max(Number(req.body?.limit || 1000), 1), 5000)
    const now = nowMysqlDatetime()
    const [rows] = await dbQuery(
      `SELECT id FROM order_address_change_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${Math.trunc(limit)}`
    )
    const ids = (Array.isArray(rows) ? rows : []).map((r) => Number(r?.id)).filter((n) => Number.isFinite(n))
    if (!ids.length) return res.json({ success: true, rejected: 0 })

    const placeholders = ids.map((_, i) => '$' + (i + 5)).join(',')
    const [result] = await dbQuery(
      `UPDATE order_address_change_requests
       SET status = 'rejected', admin_id = $1, admin_note = $2, decided_at = $3, updated_at = $4
       WHERE status = 'pending' AND id IN (${placeholders})`,
      [Number.isFinite(adminId) ? adminId : null, adminNote, now, now, ...ids]
    )
    return res.json({ success: true, rejected: result?.affectedRows || 0 })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to reject all' })
  }
})

app.post('/api/admin/email/customer-info/send-all', requireAuth, async (req, res) => {
  try {
    const allowBulk = String(process.env.ALLOW_BULK_EMAIL_TEST || '').trim().toLowerCase() === 'true'
    if (!allowBulk) {
      return res.status(403).json({
        error: 'Bulk email is disabled. Set ALLOW_BULK_EMAIL_TEST=true to enable.'
      })
    }

    const dryRun = Boolean(req.body?.dryRun)
    const limitRaw = req.body?.limit
    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 5000) : 500

    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}

    const [rows] = await dbQuery(
      `SELECT DISTINCT LOWER(TRIM(customer_email)) AS email
       FROM orders
       WHERE customer_email IS NOT NULL AND TRIM(customer_email) <> ''
       ORDER BY email ASC
       LIMIT ${Math.trunc(limit)}`
    )

    const emails = (Array.isArray(rows) ? rows : [])
      .map((r) => String(r?.email || '').trim())
      .filter((e) => e && e.includes('@'))

    if (dryRun) {
      return res.json({ success: true, dryRun: true, count: emails.length, emails })
    }

    let sent = 0
    let failed = 0
    const errors = []

    for (const email of emails) {
      // sequential to avoid provider rate limits
      // eslint-disable-next-line no-await-in-loop
      const r = await sendCustomerInfoEmail(email, data)
      if (r?.success) {
        sent += 1
      } else {
        failed += 1
        if (errors.length < 50) errors.push({ email, error: r?.error || 'send failed' })
      }
    }

    return res.json({ success: true, sent, failed, total: emails.length, errors })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send bulk email' })
  }
})

app.get('/api/admin/health', async (_req, res) => {
  try {
    await dbQuery('SELECT 1')
    res.json({ ok: true, status: 'ok', service: 'admin-service', db: 'connected' })
  } catch (e) {
    res.status(500).json({ ok: false, status: 'error', service: 'admin-service', db: 'disconnected', error: e?.message || String(e) })
  }
})

app.get('/api/admin/products', requireAuth, async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(req.query?.limit || 50), 1), 200)

    let sql = 'SELECT id, name, sku, price, currency, image_url, image_alt, is_enabled FROM products'
    const params = []
    if (q) {
      sql += ' WHERE (LOWER(name) LIKE $1 OR LOWER(sku) LIKE $2)' 
      params.push(`%${q}%`, `%${q}%`)
    }
    sql += ' ORDER BY display_order ASC, id ASC'
    sql += ` LIMIT ${Number.isFinite(limit) ? Math.trunc(limit) : 50}`

    const [rows] = await dbQuery(sql, params)
    const products = Array.isArray(rows) ? rows : []

    const ids = products.map((p) => Number(p?.id)).filter((n) => Number.isFinite(n))
    let imagesByProductId = new Map()
    if (ids.length) {
      const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',')
      const [imgRows] = await dbQuery(
        `SELECT id, product_id, position, src FROM product_images WHERE product_id IN (${placeholders}) ORDER BY product_id ASC, position ASC, id ASC`,
        ids
      )
      const imgs = Array.isArray(imgRows) ? imgRows : []
      for (const img of imgs) {
        const pid = Number(img?.product_id)
        if (!Number.isFinite(pid)) continue
        const arr = imagesByProductId.get(pid) || []
        arr.push(img)
        imagesByProductId.set(pid, arr)
      }
    }

    const out = products.map((p) => ({
      ...p,
      images: imagesByProductId.get(Number(p?.id)) || [],
    }))

    return res.json({ products: out })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch products' })
  }
})

// GET /api/admin/products/:id — single product with images
app.get('/api/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid product id' })

    const [rows] = await dbQuery(
      `SELECT id, name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
              lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
              is_enabled, display_order, klyme_enabled, created_at, updated_at
       FROM products WHERE id = $1`,
      [id]
    )
    const product = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (!product) return res.status(404).json({ error: 'Product not found' })

    const [imgRows] = await dbQuery(
      'SELECT id, product_id, position, src FROM product_images WHERE product_id = $1 ORDER BY position ASC, id ASC',
      [id]
    )
    return res.json({ success: true, product: { ...product, images: Array.isArray(imgRows) ? imgRows : [] } })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch product' })
  }
})

// POST /api/admin/products — create product
app.post('/api/admin/products', requireAuth, async (req, res) => {
  let connection
  try {
    const name             = String(req.body?.name || '').trim()
    const sku              = String(req.body?.sku || '').trim().toUpperCase()
    const price            = Number(req.body?.price)
    const currency         = String(req.body?.currency || 'GBP').trim().toUpperCase().slice(0, 3)
    const in_stock         = req.body?.in_stock         !== undefined ? (Number(req.body.in_stock) ? 1 : 0) : 1
    const stock_qty        = Number.isFinite(Number(req.body?.stock_qty)) ? Math.trunc(Number(req.body.stock_qty)) : null
    const image_url        = String(req.body?.image_url    || '').trim() || null
    const image_alt        = String(req.body?.image_alt    || '').trim() || null
    const lab_test_url     = String(req.body?.lab_test_url || '').trim() || null
    const short_desc       = String(req.body?.short_desc   || '').trim() || null
    const long_desc        = String(req.body?.long_desc    || '').trim() || null
    const details_contents = String(req.body?.details_contents || '').trim() || null
    const details_storage  = String(req.body?.details_storage  || '').trim() || null
    const details_delivery = String(req.body?.details_delivery || '').trim() || null
    const is_enabled       = req.body?.is_enabled       !== undefined ? (Number(req.body.is_enabled) ? 1 : 0) : 1
    const display_order    = Number.isFinite(Number(req.body?.display_order)) ? Math.trunc(Number(req.body.display_order)) : 0
    const images           = Array.isArray(req.body?.images) ? req.body.images : []

    if (!name)  return res.status(400).json({ error: 'name is required' })
    if (!sku)   return res.status(400).json({ error: 'sku is required' })
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'price must be a non-negative number' })

    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const skuSlug  = sku.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [dupSku] = await dbQueryConn(connection, 'SELECT id FROM products WHERE UPPER(sku) = $1', [sku])
    if (Array.isArray(dupSku) && dupSku.length > 0) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: `A product with SKU "${sku}" already exists` })
    }

    let slug = baseSlug
    const [dupSlug] = await dbQueryConn(connection, 'SELECT id FROM products WHERE slug = $1', [slug])
    if (Array.isArray(dupSlug) && dupSlug.length > 0) slug = `${baseSlug}-${skuSlug}`

    const productDomainId = (await resolveAdminDomainFilter(req)) ?? req.domainId
    const [insertResult] = await dbQueryConn(
      connection,
      `INSERT INTO products
         (name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
          lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
          is_enabled, display_order, domain_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
       lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
       is_enabled, display_order, productDomainId ?? null]
    )

    const newId = Number(insertResult?.insertId)
    if (!Number.isFinite(newId) || newId <= 0) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Failed to create product' })
    }

    for (const img of images) {
      const src = String(img?.src || '').trim()
      if (!src) continue
      const pos = Number.isFinite(Number(img?.position)) ? Math.trunc(Number(img.position)) : 0
      await dbQueryConn(connection, 'INSERT INTO product_images (product_id, position, src) VALUES ($1,$2,$3)', [newId, pos, src])
    }

    // Sync product_config so klyme-enabled toggle works immediately
    await dbQueryConn(
      connection,
      `INSERT INTO product_config (product_id, product_name, product_sku, klyme_enabled)
       VALUES ($1,$2,$3,false)
       ON CONFLICT (product_id) DO UPDATE SET product_name = EXCLUDED.product_name, product_sku = EXCLUDED.product_sku`,
      [String(newId), name, sku]
    )

    await dbQueryConn(connection, 'COMMIT')

    const [productRows] = await dbQuery(
      `SELECT id, name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
              lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
              is_enabled, display_order, klyme_enabled, created_at, updated_at
       FROM products WHERE id = $1`,
      [newId]
    )
    const [imgRowsAfter] = await dbQuery(
      'SELECT id, product_id, position, src FROM product_images WHERE product_id = $1 ORDER BY position ASC, id ASC',
      [newId]
    )
    return res.status(201).json({
      success: true,
      product: { ...(productRows?.[0] ?? {}), images: Array.isArray(imgRowsAfter) ? imgRowsAfter : [] },
    })
  } catch (e) {
    if (connection) { try { await dbQueryConn(connection, 'ROLLBACK') } catch {} }
    return res.status(500).json({ error: e?.message || 'Failed to create product' })
  } finally {
    if (connection) connection.release()
  }
})

// PUT /api/admin/products/:id — update product (patch-style: only sent fields are changed)
app.put('/api/admin/products/:id', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid product id' })

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [existRows] = await dbQueryConn(
      connection,
      `SELECT id, name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
              lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
              is_enabled, display_order FROM products WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const cur = Array.isArray(existRows) ? existRows[0] : null
    if (!cur) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Product not found' })
    }

    const b = req.body || {}
    const name             = b.name             !== undefined ? String(b.name).trim()                                                                       : cur.name
    const sku              = b.sku              !== undefined ? String(b.sku).trim().toUpperCase()                                                           : String(cur.sku || '').toUpperCase()
    const price            = b.price            !== undefined ? Number(b.price)                                                                             : Number(cur.price)
    const currency         = b.currency         !== undefined ? String(b.currency).trim().toUpperCase().slice(0, 3)                                         : String(cur.currency || 'GBP')
    const in_stock         = b.in_stock         !== undefined ? (Number(b.in_stock) ? 1 : 0)                                                               : cur.in_stock
    const stock_qty        = b.stock_qty        !== undefined ? (Number.isFinite(Number(b.stock_qty)) ? Math.trunc(Number(b.stock_qty)) : null)             : cur.stock_qty
    const image_url        = b.image_url        !== undefined ? (String(b.image_url).trim() || null)                                                        : cur.image_url
    const image_alt        = b.image_alt        !== undefined ? (String(b.image_alt).trim() || null)                                                        : cur.image_alt
    const lab_test_url     = b.lab_test_url     !== undefined ? (String(b.lab_test_url).trim() || null)                                                     : cur.lab_test_url
    const short_desc       = b.short_desc       !== undefined ? (String(b.short_desc).trim() || null)                                                       : cur.short_desc
    const long_desc        = b.long_desc        !== undefined ? (String(b.long_desc).trim() || null)                                                        : cur.long_desc
    const details_contents = b.details_contents !== undefined ? (String(b.details_contents).trim() || null)                                                 : cur.details_contents
    const details_storage  = b.details_storage  !== undefined ? (String(b.details_storage).trim() || null)                                                  : cur.details_storage
    const details_delivery = b.details_delivery !== undefined ? (String(b.details_delivery).trim() || null)                                                 : cur.details_delivery
    const is_enabled       = b.is_enabled       !== undefined ? (Number(b.is_enabled) ? 1 : 0)                                                             : cur.is_enabled
    const display_order    = b.display_order    !== undefined ? Math.trunc(Number(b.display_order))                                                         : Number(cur.display_order || 0)

    if (!name) return res.status(400).json({ error: 'name cannot be empty' })
    if (!sku)  return res.status(400).json({ error: 'sku cannot be empty' })
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'price must be a non-negative number' })

    if (sku !== String(cur.sku || '').toUpperCase()) {
      const [skuConflict] = await dbQueryConn(connection, 'SELECT id FROM products WHERE UPPER(sku) = $1 AND id != $2', [sku, id])
      if (Array.isArray(skuConflict) && skuConflict.length > 0) {
        await dbQueryConn(connection, 'ROLLBACK')
        return res.status(409).json({ error: `A product with SKU "${sku}" already exists` })
      }
    }

    await dbQueryConn(
      connection,
      `UPDATE products SET
         name=$1, sku=$2, price=$3, currency=$4, in_stock=$5, stock_qty=$6,
         image_url=$7, image_alt=$8, lab_test_url=$9, short_desc=$10, long_desc=$11,
         details_contents=$12, details_storage=$13, details_delivery=$14,
         is_enabled=$15, display_order=$16, updated_at=CURRENT_TIMESTAMP
       WHERE id=$17`,
      [name, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
       lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
       is_enabled, display_order, id]
    )

    if (Array.isArray(b.images)) {
      await dbQueryConn(connection, 'DELETE FROM product_images WHERE product_id = $1', [id])
      for (const img of b.images) {
        const src = String(img?.src || '').trim()
        if (!src) continue
        const pos = Number.isFinite(Number(img?.position)) ? Math.trunc(Number(img.position)) : 0
        await dbQueryConn(connection, 'INSERT INTO product_images (product_id, position, src) VALUES ($1,$2,$3)', [id, pos, src])
      }
    }

    await dbQueryConn(
      connection,
      `INSERT INTO product_config (product_id, product_name, product_sku, klyme_enabled)
       VALUES ($1,$2,$3,false)
       ON CONFLICT (product_id) DO UPDATE SET product_name = EXCLUDED.product_name, product_sku = EXCLUDED.product_sku`,
      [String(id), name, sku]
    )

    await dbQueryConn(connection, 'COMMIT')

    const [productRows] = await dbQuery(
      `SELECT id, name, slug, sku, price, currency, in_stock, stock_qty, image_url, image_alt,
              lab_test_url, short_desc, long_desc, details_contents, details_storage, details_delivery,
              is_enabled, display_order, klyme_enabled, created_at, updated_at
       FROM products WHERE id = $1`,
      [id]
    )
    const [imgRowsAfter] = await dbQuery(
      'SELECT id, product_id, position, src FROM product_images WHERE product_id = $1 ORDER BY position ASC, id ASC',
      [id]
    )
    return res.json({
      success: true,
      product: { ...(productRows?.[0] ?? {}), images: Array.isArray(imgRowsAfter) ? imgRowsAfter : [] },
    })
  } catch (e) {
    if (connection) { try { await dbQueryConn(connection, 'ROLLBACK') } catch {} }
    return res.status(500).json({ error: e?.message || 'Failed to update product' })
  } finally {
    if (connection) connection.release()
  }
})

// DELETE /api/admin/products/:id
app.delete('/api/admin/products/:id', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid product id' })

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [existRows] = await dbQueryConn(connection, 'SELECT id FROM products WHERE id = $1 FOR UPDATE', [id])
    if (!Array.isArray(existRows) || !existRows[0]) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Product not found' })
    }

    await dbQueryConn(connection, 'DELETE FROM product_images WHERE product_id = $1', [id])
    await dbQueryConn(connection, 'DELETE FROM product_config WHERE product_id = $1', [String(id)])
    await dbQueryConn(connection, 'DELETE FROM products WHERE id = $1', [id])

    await dbQueryConn(connection, 'COMMIT')
    return res.json({ success: true })
  } catch (e) {
    if (connection) { try { await dbQueryConn(connection, 'ROLLBACK') } catch {} }
    return res.status(500).json({ error: e?.message || 'Failed to delete product' })
  } finally {
    if (connection) connection.release()
  }
})

// Get all product configurations for Klyme management
app.get('/api/admin/product-config', requireAuth, async (req, res) => {
  try {
    const [rows] = await dbQuery(
      'SELECT product_id as id, product_name as name, product_sku as sku, klyme_enabled FROM product_config ORDER BY product_name'
    );

    console.log('Fetched product configurations:', rows.length, 'products');

    res.json({
      success: true,
      config: rows
    });
  } catch (error) {
    console.error('Error fetching product configurations:', error);
    res.status(500).json({ error: 'Failed to fetch product configurations' });
  }
});

// Check products Klyme status by SKU (public, routed via Nginx /api/admin/ -> :5001)
app.post('/api/admin/products/klyme-status-by-sku', async (req, res) => {
  try {
    const product_skus = req.body?.product_skus ?? req.body?.skus ?? req.body?.productSkus;

    if (!Array.isArray(product_skus) || product_skus.length === 0) {
      return res.status(400).json({ error: 'Product SKUs array is required' })
    }

    const normalizedSkus = product_skus
      .map((s) => String(s || '').trim())
      .filter(Boolean)

    if (normalizedSkus.length === 0) {
      return res.status(400).json({ error: 'Product SKUs array is required' })
    }

    const placeholders = normalizedSkus.map((_, i) => '$' + (i + 1)).join(',')
    const [products] = await dbQuery(
      `SELECT product_sku, klyme_enabled FROM product_config WHERE product_sku IN (${placeholders})`,
      normalizedSkus
    )

    const klymeSettings = {}
    ;(Array.isArray(products) ? products : []).forEach((product) => {
      const sku = String(product?.product_sku || '').trim()
      if (!sku) return
      klymeSettings[sku] = Boolean(product?.klyme_enabled)
    })

    // Force-enable Klyme for frontend Klyme-only products.
    normalizedSkus.forEach((sku) => {
      const s = String(sku || '').trim().toUpperCase()
      if (s === 'RETAT-20MG' || s === 'RETAT-40MG') {
        klymeSettings[String(sku).trim()] = true
      }
    })

    normalizedSkus.forEach((sku) => {
      if (!(sku in klymeSettings)) {
        klymeSettings[sku] = false
      }
    })

    return res.json({ klyme_settings: klymeSettings })
  } catch (error) {
    console.error('Error checking products Klyme status by SKU:', error)
    return res.status(500).json({ error: 'Failed to check products Klyme status' })
  }
})

function normalizeBlacklistEmail(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s || !s.includes('@')) return ''
  return s.slice(0, 255)
}

function normalizeBlacklistAddressKey(payload) {
  const address = String(payload?.address || payload?.shipping_address || payload?.shippingAddress || '').trim().toLowerCase()
  const city = String(payload?.city || payload?.shipping_city || payload?.shippingCity || '').trim().toLowerCase()
  const postcode = String(payload?.postcode || payload?.shipping_zip || payload?.shippingZip || '').trim().toLowerCase()
  const country = String(payload?.country || payload?.shipping_country || payload?.shippingCountry || '').trim().toLowerCase()
  const combined = `${address}|${city}|${postcode}|${country}`
    .replace(/\s+/g, ' ')
    .trim()
  if (!combined || combined === '|||') return ''
  return combined.slice(0, 512)
}

app.get('/api/admin/customer-blacklist', requireAuth, async (_req, res) => {
  try {
    const [rows] = await dbQuery(
      `SELECT
         cb.id,
         cb.email_lower AS email,
         cb.address_key,
         cb.reason,
         cb.created_at,
         o.order_number AS last_order_number,
         o.customer_name AS customer_name,
         o.customer_email AS customer_email,
         o.total AS last_order_total,
         o.currency AS last_order_currency,
         o.status AS last_order_status,
         o.payment_status AS last_order_payment_status,
         o.created_at AS last_order_created_at
       FROM customer_blacklist cb
       LEFT JOIN orders o
         ON o.customer_email = cb.email_lower
       ORDER BY cb.created_at DESC, cb.id DESC
       LIMIT 500`
    )
    return res.json({ success: true, blacklist: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch blacklist' })
  }
})

app.get('/api/admin/customers', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 500), 1), 2000)
    const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 500

    const offset = Math.max(Number(req.query?.offset || 0), 0)
    const safeOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0

    const domainId = await resolveAdminDomainFilter(req)
    const domainParams = []
    let domainAndClause = ''
    if (domainId != null) {
      domainParams.push(domainId)
      domainAndClause = `AND orders.domain_id = $${domainParams.length}`
    }

    // NOTE: Some MySQL setups throw "Incorrect arguments to mysqld_stmt_execute" when
    // using prepared placeholders for LIMIT/OFFSET. We clamp + truncate to safe integers
    // above, then inline them here.
    const [rows] = await dbQuery(
      `SELECT
        LOWER(TRIM(customer_email)) AS email,
        MAX(NULLIF(TRIM(customer_name), '')) AS customer_name,
        COALESCE(
          MAX(NULLIF(TRIM(u.phone), '')),
          MAX(NULLIF(TRIM(customer_phone), ''))
        ) AS customer_phone,
        MAX(u.date_of_birth) AS date_of_birth,
        COUNT(*) AS orders_count,
        MAX(orders.created_at) AS last_order_created_at,
        (array_agg(orders.order_number ORDER BY orders.created_at DESC))[1] AS last_order_number
      FROM orders
      LEFT JOIN users u
        ON LOWER(TRIM(u.email)) = LOWER(TRIM(orders.customer_email))
      WHERE customer_email IS NOT NULL
        AND TRIM(customer_email) <> ''
        ${domainAndClause}
      GROUP BY LOWER(TRIM(customer_email))
      ORDER BY MAX(orders.created_at) DESC
      LIMIT ${safeLimit + 1} OFFSET ${safeOffset}`,
      domainParams
    )

    const rawList = Array.isArray(rows) ? rows : []
    const hasMore = rawList.length > safeLimit
    const list = hasMore ? rawList.slice(0, safeLimit) : rawList
    const customers = list
      .map((r) => ({
        email: String(r?.email || '').trim(),
        customer_name: String(r?.customer_name || '').trim(),
        customer_phone: String(r?.customer_phone || '').trim(),
        date_of_birth: r?.date_of_birth || null,
        orders_count: Number(r?.orders_count || 0),
        last_order_created_at: r?.last_order_created_at,
        last_order_number: String(r?.last_order_number || '').trim(),
      }))
      .filter((c) => c.email && c.email.includes('@'))

    return res.json({ success: true, customers, has_more: hasMore })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch customers' })
  }
})

app.get('/api/admin/customers/:email', requireAuth, async (req, res) => {
  try {
    const emailLower = String(req.params.email || '').trim().toLowerCase()
    if (!emailLower || !emailLower.includes('@')) return res.status(400).json({ error: 'Valid customer email is required' })

    try {
      await ensureCustomerCreditsSchema()
    } catch {
      // ignore
    }

    const [profileRows] = await dbQuery(
      `SELECT
        LOWER(TRIM(customer_email)) AS email,
        MAX(NULLIF(TRIM(customer_name), '')) AS customer_name,
        COALESCE(
          MAX(NULLIF(TRIM(u.phone), '')),
          MAX(NULLIF(TRIM(customer_phone), ''))
        ) AS customer_phone,
        MAX(u.date_of_birth) AS date_of_birth,
        COUNT(*) AS orders_count,
        MAX(orders.created_at) AS last_order_created_at
      FROM orders
      LEFT JOIN users u
        ON LOWER(TRIM(u.email)) = LOWER(TRIM(orders.customer_email))
      WHERE LOWER(TRIM(customer_email)) = $1
      GROUP BY LOWER(TRIM(customer_email))
     `,
      [emailLower]
    )

    const profileList = Array.isArray(profileRows) ? profileRows : []
    const profile = profileList[0] ? profileList[0] : null
    if (!profile) return res.status(404).json({ error: 'Customer not found' })

    const [creditRows] = await dbQuery(
      `SELECT COALESCE(uc.balance, 0) AS balance
       FROM users u
       LEFT JOIN user_credits uc
         ON uc.user_id = u.id
       WHERE LOWER(TRIM(u.email)) = $1
      `,
      [emailLower]
    )
    const creditList = Array.isArray(creditRows) ? creditRows : []
    const creditBalance = Number(creditList[0]?.balance || 0)

    const [recentRows] = await dbQuery(
      `SELECT
        id,
        order_number,
        status,
        payment_status,
        total,
        currency,
        created_at
      FROM orders
      WHERE LOWER(TRIM(customer_email)) = $1
      ORDER BY created_at DESC
      LIMIT 20`,
      [emailLower]
    )

    const recentOrders = (Array.isArray(recentRows) ? recentRows : []).map((o) => ({
      id: Number(o?.id),
      order_number: String(o?.order_number || '').trim(),
      status: String(o?.status || '').trim(),
      payment_status: String(o?.payment_status || '').trim(),
      total: Number(o?.total || 0),
      currency: String(o?.currency || 'GBP').trim() || 'GBP',
      created_at: o?.created_at,
    }))

    return res.json({
      success: true,
      customer: {
        email: String(profile?.email || '').trim(),
        customer_name: String(profile?.customer_name || '').trim(),
        customer_phone: String(profile?.customer_phone || '').trim(),
        date_of_birth: profile?.date_of_birth || null,
        orders_count: Number(profile?.orders_count || 0),
        last_order_created_at: profile?.last_order_created_at,
        credit_balance: creditBalance,
        recentOrders,
      },
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch customer' })
  }
})

app.post('/api/admin/customers/:email/credits', requireAuth, async (req, res) => {
  try {
    const emailLower = String(req.params.email || '').trim().toLowerCase()
    if (!emailLower || !emailLower.includes('@')) return res.status(400).json({ error: 'Valid customer email is required' })

    const amountRaw = req.body?.amount
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' })

    await ensureCustomerCreditsSchema()

    const connection = await pool.connect()
    try {
      dbQueryConn(connection, 'BEGIN')

      const [userRows] = await dbQueryConn(connection, 'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1', [emailLower])
      const userList = Array.isArray(userRows) ? userRows : []
      const userId = userList[0]?.id
      if (!userId) {
        dbQueryConn(connection, 'ROLLBACK')
        return res.status(404).json({ error: 'User not found' })
      }

      const [existingRows] = await dbQueryConn(connection, 'SELECT balance FROM user_credits WHERE user_id = $1 FOR UPDATE', [userId])
      const existingList = Array.isArray(existingRows) ? existingRows : []

      if (!existingList.length) {
        await dbQueryConn(connection, 'INSERT INTO user_credits (user_id, balance) VALUES ($1, 0)', [userId])
      }

      await dbQueryConn(connection, 'UPDATE user_credits SET balance = COALESCE(balance, 0) + $1 WHERE user_id = $2', [amount, userId])

      const adminName = String(req.adminUser?.username || req.adminUser?.role || 'admin')
      const note = String(req.body?.note || '').trim().slice(0, 255) || null
      await dbQueryConn(connection, 
        'INSERT INTO credit_ledger (user_id, amount, source, admin_username, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, amount, 'admin_add', adminName, note, nowMysqlDatetime()]
      )

      dbQueryConn(connection, 'COMMIT')

      const [balanceRows] = await dbQueryConn(connection, 'SELECT balance FROM user_credits WHERE user_id = $1', [userId])
      const balanceList = Array.isArray(balanceRows) ? balanceRows : []
      const balance = Number(balanceList[0]?.balance || 0)

      return res.json({ success: true, balance })
    } catch (e) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
      return res.status(500).json({ error: e?.message || 'Failed to add credits' })
    } finally {
      try {
        connection.release()
      } catch {
        // ignore
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to add credits' })
  }
})

app.post('/api/admin/customers/:email/credits/deduct', requireAuth, async (req, res) => {
  try {
    const emailLower = String(req.params.email || '').trim().toLowerCase()
    if (!emailLower || !emailLower.includes('@')) return res.status(400).json({ error: 'Valid customer email is required' })

    const amountRaw = req.body?.amount
    const amount = Number(amountRaw)
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' })

    await ensureCustomerCreditsSchema()

    const connection = await pool.connect()
    try {
      dbQueryConn(connection, 'BEGIN')

      const [userRows] = await dbQueryConn(connection, 'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1', [emailLower])
      const userList = Array.isArray(userRows) ? userRows : []
      const userId = userList[0]?.id
      if (!userId) {
        dbQueryConn(connection, 'ROLLBACK')
        return res.status(404).json({ error: 'User not found' })
      }

      const [existingRows] = await dbQueryConn(connection, 'SELECT balance FROM user_credits WHERE user_id = $1 FOR UPDATE', [userId])
      const existingList = Array.isArray(existingRows) ? existingRows : []

      if (!existingList.length) {
        await dbQueryConn(connection, 'INSERT INTO user_credits (user_id, balance) VALUES ($1, 0)', [userId])
      }

      const currentBalance = Number(existingList[0]?.balance || 0)
      const safeCurrent = Number.isFinite(currentBalance) ? currentBalance : 0
      const deducted = Math.max(0, Math.min(amount, safeCurrent))
      const nextBalance = Number((safeCurrent - deducted).toFixed(2))

      await dbQueryConn(connection, 'UPDATE user_credits SET balance = $1 WHERE user_id = $2', [nextBalance, userId])

      const adminName = String(req.adminUser?.username || req.adminUser?.role || 'admin')
      const note = String(req.body?.note || '').trim().slice(0, 255) || null
      await dbQueryConn(connection, 
        'INSERT INTO credit_ledger (user_id, amount, source, admin_username, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, -deducted, 'admin_deduct', adminName, note, nowMysqlDatetime()]
      )

      dbQueryConn(connection, 'COMMIT')

      return res.json({ success: true, balance: nextBalance, deducted })
    } catch (e) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
      return res.status(500).json({ error: e?.message || 'Failed to deduct credits' })
    } finally {
      try {
        connection.release()
      } catch {
        // ignore
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to deduct credits' })
  }
})

app.delete('/api/admin/customer-blacklist/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })
    const [result] = await dbQuery('DELETE FROM customer_blacklist WHERE id = $1', [id])
    const affected = Number(result?.affectedRows || 0)
    if (!affected) return res.status(404).json({ error: 'Entry not found' })
    return res.json({ success: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to delete blacklist entry' })
  }
})

// Update product Klyme setting
app.post('/api/admin/product/:id/klyme-enabled', requireAuth, async (req, res) => {
  try {
    const { klyme_enabled } = req.body;
    const productId = String(req.params.id);

    console.log('=== PRODUCT KLYME UPDATE REQUEST ===');
    console.log('Product ID:', productId);
    console.log('Klyme Enabled:', klyme_enabled);

    if (typeof klyme_enabled !== 'boolean') {
      return res.status(400).json({ error: 'klyme_enabled must be a boolean value' });
    }

    // Ensure table exists before trying to update/insert.
    await ensureProductConfigTable()

    // Update klyme_enabled setting in product_config table
    const [result] = await dbQuery(
      'UPDATE product_config SET klyme_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE product_id = $2',
      [klyme_enabled, productId]
    );

    if (result.affectedRows === 0) {
      const fallbackName = String(req.body?.product_name || req.body?.name || productId).trim() || productId
      const fallbackSku = String(req.body?.product_sku || req.body?.sku || productId).trim() || productId
      try {
        await dbQuery(
          'INSERT INTO product_config (product_id, product_name, product_sku, klyme_enabled) VALUES ($1, $2, $3, $4) ON CONFLICT (product_id) DO UPDATE SET klyme_enabled = EXCLUDED.klyme_enabled, product_name = EXCLUDED.product_name, product_sku = EXCLUDED.product_sku',
          [productId, fallbackName, fallbackSku, klyme_enabled]
        )
        console.log('Inserted missing product_config row for:', productId)
      } catch (insertErr) {
        console.error('Product not found with ID and failed to insert:', productId, insertErr?.message || insertErr)
        return res.status(500).json({
          error: 'Failed to create product configuration',
          details: insertErr?.message || String(insertErr || 'Unknown error'),
        })
      }
    }

    console.log('Product Klyme update result:', result.affectedRows, 'rows affected');

    res.json({
      success: true,
      message: 'Product Klyme setting updated successfully',
      klyme_enabled
    });
  } catch (error) {
    console.error('Error updating product Klyme setting:', error);
    res.status(500).json({ error: 'Failed to update product Klyme setting' });
  }
});

// Check products Klyme status for checkout (public, routed via Nginx /api/admin/ -> :5001)
app.post('/api/admin/products/klyme-status', async (req, res) => {
  try {
    const product_ids = req.body?.product_ids ?? req.body?.productIds;

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'Product IDs array is required' });
    }

    const placeholders = product_ids.map((_, i) => '$' + (i + 1)).join(',');
    const [products] = await dbQuery(
      `SELECT product_id, klyme_enabled FROM product_config WHERE product_id IN (${placeholders})`,
      product_ids
    );

    const klymeSettings = {};
    products.forEach((product) => {
      klymeSettings[product.product_id] = Boolean(product.klyme_enabled);
    });

    product_ids.forEach((id) => {
      if (!(id in klymeSettings)) {
        klymeSettings[id] = false;
      }
    });

    return res.json({ klyme_settings: klymeSettings });
  } catch (error) {
    console.error('Error checking products Klyme status:', error);
    return res.status(500).json({ error: 'Failed to check products Klyme status' });
  }
});

// Check products Klyme status for checkout
app.post('/api/products/klyme-status', async (req, res) => {
  try {
    const product_ids = req.body?.product_ids ?? req.body?.productIds;

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'Product IDs array is required' });
    }

    // Create placeholders for IN clause
    const placeholders = product_ids.map((_, i) => '$' + (i + 1)).join(',');
    
    // Get Klyme status from product_config table
    const [products] = await dbQuery(
      `SELECT product_id, klyme_enabled FROM product_config WHERE product_id IN (${placeholders})`,
      product_ids
    );

    // Build response object with product_id as key and klyme_enabled as value
    const klymeSettings = {};
    products.forEach(product => {
      klymeSettings[product.product_id] = Boolean(product.klyme_enabled);
    });

    // Force-enable Klyme for frontend Klyme-only products.
    product_ids.forEach((id) => {
      const pid = String(id).trim()
      if (
        pid === 'retatrutide-20mg' ||
        pid === 'retatrutide-40mg' ||
        pid === 'bundle-retatrutide-20mg-x2' ||
        pid === 'bundle-retatrutide-40mg-x2'
      ) {
        klymeSettings[String(id).trim()] = true;
      }
    });

    // For products not found in database, default to false
    product_ids.forEach(id => {
      if (!(id in klymeSettings)) {
        klymeSettings[id] = false;
      }
    });

    console.log('Klyme status check for products:', product_ids, 'Result:', klymeSettings);

    res.json({
      klyme_settings: klymeSettings
    });
  } catch (error) {
    console.error('Error checking products Klyme status:', error);
    res.status(500).json({ error: 'Failed to check products Klyme status' });
  }
});

// Check products Klyme status by SKU (public, used for order-based eligibility where items only have SKU)
app.post('/api/products/klyme-status-by-sku', async (req, res) => {
  try {
    const product_skus = req.body?.product_skus ?? req.body?.skus ?? req.body?.productSkus;

    if (!Array.isArray(product_skus) || product_skus.length === 0) {
      return res.status(400).json({ error: 'Product SKUs array is required' })
    }

    const normalizedSkus = product_skus
      .map((s) => String(s || '').trim())
      .filter(Boolean)

    if (normalizedSkus.length === 0) {
      return res.status(400).json({ error: 'Product SKUs array is required' })
    }

    const placeholders = normalizedSkus.map((_, i) => '$' + (i + 1)).join(',')
    const [products] = await dbQuery(
      `SELECT product_sku, klyme_enabled FROM product_config WHERE product_sku IN (${placeholders})`,
      normalizedSkus
    )

    const klymeSettings = {}
    ;(Array.isArray(products) ? products : []).forEach((product) => {
      const sku = String(product?.product_sku || '').trim()
      if (!sku) return
      klymeSettings[sku] = Boolean(product?.klyme_enabled)
    })

    normalizedSkus.forEach((sku) => {
      if (!(sku in klymeSettings)) {
        klymeSettings[sku] = false
      }
    })

    return res.json({ klyme_settings: klymeSettings })
  } catch (error) {
    console.error('Error checking products Klyme status by SKU:', error)
    return res.status(500).json({ error: 'Failed to check products Klyme status' })
  }
})

app.post('/api/admin/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }

    const [rows] = await dbQuery(
      `SELECT id, username, email, password_hash, role, is_active
         FROM admin_users
        WHERE username = $1
       `,
      [username]
    )
    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const ok = await bcrypt.compare(password, String(user.password_hash || ''))
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    try {
      await dbQuery('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [user.id])
    } catch (_) {
      // non-fatal: don't block login if last_login update fails
    }

    const role = String(user.role || 'admin')
    const token = jwt.sign(
      { id: user.id, username: user.username, role, sv: ADMIN_SESSION_VERSION },
      JWT_SECRET,
      { expiresIn: '24h' }
    )
    return res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, role },
    })
  } catch (e) {
    console.error('Admin login error:', e?.message || String(e))
    return res.status(500).json({ error: 'Login failed' })
  }
})

app.get('/api/admin/verify', requireAuth, async (req, res) => {
  res.json({ valid: true, user: req.adminUser })
})

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const domainId = await resolveAdminDomainFilter(req)

    // ?since only shifts the IVMS figures, but it still has to be part of the
    // key. Keying on the parsed instant rather than the raw string means
    // equivalent spellings share an entry and unparseable values — which the
    // queries treat as "no since" — all collapse onto the same one.
    const sinceRaw = req.query?.since
    const since = sinceRaw ? new Date(String(sinceRaw)) : null
    const sinceDate = since && Number.isFinite(since.getTime()) ? since : null

    const cacheKey = `stats:${domainId ?? 'all'}:${sinceDate ? sinceDate.toISOString() : 'none'}`
    const cached = getCachedDashboard(cacheKey)
    if (cached) return res.json(cached)

    const domainOrdersWhere = domainId != null ? 'AND domain_id = $1' : ''
    const domainOrdersParams = domainId != null ? [domainId] : []
    const domainLinksWhere = domainId != null ? 'AND domain_id = $1' : ''
    const domainLinksParams = domainId != null ? [domainId] : []

    // This endpoint reports ~45 counters that are all derived from four tables.
    // Asking for them one counter at a time cost 28 database round trips (~2.7s
    // against the remote pooler) to do a few milliseconds of actual work, so
    // they're grouped here into five statements: aggregates that share a table
    // and a WHERE clause are computed together with COUNT/SUM ... FILTER, which
    // also means each table is scanned once instead of once per counter.

    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]

    const receivedPlaceholders = receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')

    // 1. Order counts and revenue — one pass over `orders`.
    const ordersAggSql = `
      SELECT
        COUNT(*) AS total_count,
        COALESCE(SUM(total),0) AS total_revenue,
        COUNT(*) FILTER (WHERE LOWER(status) = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE LOWER(status) = 'delivered' OR LOWER(payment_status) = 'paid') AS completed_count,
        COALESCE(SUM(total) FILTER (WHERE LOWER(payment_status) IN ('pending','unpaid')),0) AS pending_payments_amount,
        COALESCE(SUM(total) FILTER (WHERE LOWER(payment_status) = 'received'),0) AS completed_payments_amount
      FROM orders
      WHERE 1=1 ${domainOrdersWhere}
    `

    // 2. Payment-link counts — all five windows in one pass.
    const linksAggSql = `
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE created_at >= (NOW() - INTERVAL '1 hour')) AS c1h,
        COUNT(*) FILTER (WHERE created_at >= (NOW() - INTERVAL '12 hours')) AS c12h,
        COUNT(*) FILTER (WHERE created_at >= (NOW() - INTERVAL '24 hours')) AS c24h,
        COUNT(*) FILTER (WHERE created_at >= (NOW() - INTERVAL '7 days')) AS c7d
      FROM payment_capture_requests
      WHERE 1=1 ${domainLinksWhere}
    `

    // 3. Received-payment windows plus the two bank_account_used splits.
    // The payment date is a correlated subquery over `payments`; hoisting it into
    // a subselect evaluates it once per order rather than once per order *per
    // counter*, which is what made the seven separate versions of this expensive.
    const ivmsSinceFilter = sinceDate ? `AND pd >= $${receivedStatuses.length + 1}` : ''
    const receivedAggSql = `
      SELECT
        COUNT(*) AS all_count,
        COALESCE(SUM(COALESCE(total,0)),0) AS all_amount,
        COUNT(*) FILTER (WHERE pd >= (NOW() - INTERVAL '24 hours')) AS c24h,
        COALESCE(SUM(COALESCE(total,0)) FILTER (WHERE pd >= (NOW() - INTERVAL '24 hours')),0) AS a24h,
        COUNT(*) FILTER (WHERE pd >= (NOW() - INTERVAL '48 hours')) AS c48h,
        COALESCE(SUM(COALESCE(total,0)) FILTER (WHERE pd >= (NOW() - INTERVAL '48 hours')),0) AS a48h,
        COUNT(*) FILTER (WHERE pd >= (NOW() - INTERVAL '7 days')) AS c7d,
        COALESCE(SUM(COALESCE(total,0)) FILTER (WHERE pd >= (NOW() - INTERVAL '7 days')),0) AS a7d,
        COUNT(*) FILTER (WHERE pd >= (NOW() - INTERVAL '30 days')) AS c30d,
        COALESCE(SUM(COALESCE(total,0)) FILTER (WHERE pd >= (NOW() - INTERVAL '30 days')),0) AS a30d,
        COUNT(*) FILTER (WHERE bank = 'ivms' ${ivmsSinceFilter}) AS ivms_count,
        COALESCE(SUM(total) FILTER (WHERE bank = 'ivms' ${ivmsSinceFilter}),0) AS ivms_amount,
        COUNT(*) FILTER (WHERE bank = 'ibalticx') AS ib_count,
        COALESCE(SUM(total) FILTER (WHERE bank = 'ibalticx'),0) AS ib_amount
      FROM (
        SELECT
          orders.total AS total,
          LOWER(COALESCE(orders.bank_account_used,'')) AS bank,
          COALESCE(
            (
              SELECT COALESCE(p.updated_at, p.created_at)
              FROM payments p
              WHERE p.order_id = orders.id
                AND LOWER(COALESCE(p.status,'')) IN (${receivedPlaceholders})
              ORDER BY COALESCE(p.updated_at, p.created_at) DESC
              LIMIT 1
            ),
            orders.updated_at,
            orders.created_at
          ) AS pd
        FROM orders
        WHERE LOWER(COALESCE(payment_status,'')) IN (${receivedPlaceholders})
      ) x
    `
    const receivedAggParams = sinceDate ? [...receivedStatuses, sinceDate] : receivedStatuses

    // 4. Klyme and AabanPay totals + windows. Previously eight near-identical
    // queries differing only in the provider literal and the time window; the
    // provider is now a GROUP BY key and the windows are FILTER clauses.
    // `latest` picks each order's most recent successful payment per provider,
    // matching the original per-provider subquery exactly.
    const providerAggSql = `
      SELECT
        latest.provider AS provider,
        COUNT(*) AS all_count,
        COALESCE(SUM(COALESCE(p.amount, o.total, 0)),0) AS all_amount,
        COUNT(*) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '1 hour')) AS c1h,
        COALESCE(SUM(COALESCE(p.amount, o.total, 0)) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '1 hour')),0) AS a1h,
        COUNT(*) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '12 hours')) AS c12h,
        COALESCE(SUM(COALESCE(p.amount, o.total, 0)) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '12 hours')),0) AS a12h,
        COUNT(*) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '24 hours')) AS c24h,
        COALESCE(SUM(COALESCE(p.amount, o.total, 0)) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '24 hours')),0) AS a24h,
        COUNT(*) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '48 hours')) AS c48h,
        COALESCE(SUM(COALESCE(p.amount, o.total, 0)) FILTER (WHERE latest.paid_at >= (NOW() - INTERVAL '48 hours')),0) AS a48h
      FROM orders o
      INNER JOIN (
        SELECT
          order_id,
          LOWER(COALESCE(provider,'')) AS provider,
          MAX(COALESCE(updated_at, created_at)) AS paid_at
        FROM payments
        WHERE LOWER(COALESCE(provider,'')) IN ('klyme','aabanpay')
          AND LOWER(COALESCE(status,'')) IN (${receivedPlaceholders})
        GROUP BY order_id, LOWER(COALESCE(provider,''))
      ) latest
        ON latest.order_id = o.id
      INNER JOIN payments p
        ON p.order_id = latest.order_id
       AND COALESCE(p.updated_at, p.created_at) = latest.paid_at
       AND LOWER(COALESCE(p.provider,'')) = latest.provider
       AND LOWER(COALESCE(p.status,'')) IN (${receivedPlaceholders})
      GROUP BY latest.provider
    `

    // 5. Fallback: some environments update orders.payment_processor and/or
    // orders.bank_account_used but may not have a consistent
    // payments.provider/status row. Kept as a thunk so its try/catch — and the
    // one-shot column-support flags it flips — still work inside the batch.
    const fallbackParts = []
    if (ORDERS_HAS_PAYMENT_PROCESSOR_COL === true) fallbackParts.push("LOWER(COALESCE(payment_processor,'')) = 'aabanpay'")
    if (ORDERS_HAS_BANK_ACCOUNT_USED_COL === true) fallbackParts.push("LOWER(COALESCE(bank_account_used,'')) = 'aabanpay'")

    const aabanpayFallbackQuery = async () => {
      if (!fallbackParts.length) return [[{ count: 0, amount: 0 }]]

      const aabanpayOrderFallbackSql = `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(COALESCE(total, 0)), 0) AS amount
        FROM orders
        WHERE LOWER(COALESCE(payment_status,'')) IN (${receivedPlaceholders})
          AND (${fallbackParts.join(' OR ')})
      `

      try {
        return await dbQuery(aabanpayOrderFallbackSql, receivedStatuses)
      } catch (e) {
        // Avoid log spam: only log once per process.
        if (ORDERS_HAS_PAYMENT_PROCESSOR_COL !== false || ORDERS_HAS_BANK_ACCOUNT_USED_COL !== false) {
          console.error('[admin-service] aabanpay fallback stats query failed:', e?.message || e)
        }
        ORDERS_HAS_PAYMENT_PROCESSOR_COL = false
        ORDERS_HAS_BANK_ACCOUNT_USED_COL = false
        return [[{ count: 0, amount: 0 }]]
      }
    }

    const [
      [ordersAggRows],
      [linksAggRows],
      [receivedAggRows],
      [providerAggRows],
      [aabanpayFallbackRows],
    ] = await Promise.all([
      dbQuery(ordersAggSql, domainOrdersParams),
      dbQuery(linksAggSql, domainLinksParams),
      dbQuery(receivedAggSql, receivedAggParams),
      dbQuery(providerAggSql, receivedStatuses),
      aabanpayFallbackQuery(),
    ])

    const row0 = (rows) => (Array.isArray(rows) && rows[0] ? rows[0] : {})
    const ord = row0(ordersAggRows)
    const links = row0(linksAggRows)
    const recv = row0(receivedAggRows)
    const aabanpayFallback = Array.isArray(aabanpayFallbackRows) ? aabanpayFallbackRows : []

    const byProvider = new Map(
      (Array.isArray(providerAggRows) ? providerAggRows : []).map((r) => [String(r.provider || ''), r])
    )
    const klyme = byProvider.get('klyme') || {}
    const aabanpay = byProvider.get('aabanpay') || {}

    // Counts are passed through as-is (pg returns bigint as a string) wherever
    // the previous response did, so the payload is byte-for-byte unchanged.
    const payload = {
      totalOrders: ord.total_count || 0,
      totalRevenue: Number(ord.total_revenue || 0),
      pendingOrders: ord.pending_count || 0,
      completedOrders: ord.completed_count || 0,
      pendingPaymentsTotal: Number(ord.pending_payments_amount || 0),
      completedPaymentsTotal: Number(ord.completed_payments_amount || 0),
      receivedPaymentsCount: Number(recv.all_count || 0),
      receivedPaymentsAmount: Number(recv.all_amount || 0),
      receivedPaymentsCount24h: Number(recv.c24h || 0),
      receivedPaymentsAmount24h: Number(recv.a24h || 0),
      receivedPaymentsCount48h: Number(recv.c48h || 0),
      receivedPaymentsAmount48h: Number(recv.a48h || 0),
      receivedPaymentsCount7d: Number(recv.c7d || 0),
      receivedPaymentsAmount7d: Number(recv.a7d || 0),
      receivedPaymentsCount30d: Number(recv.c30d || 0),
      receivedPaymentsAmount30d: Number(recv.a30d || 0),
      ibalticxPaidCount: Number(recv.ib_count || 0),
      ibalticxPaidTotal: Number(recv.ib_amount || 0),
      klymePaidCount: Number(klyme.all_count || 0),
      klymePaidTotal: Number(klyme.all_amount || 0),
      klymePaidCount1h: Number(klyme.c1h || 0),
      klymePaidCount12h: Number(klyme.c12h || 0),
      klymePaidCount24h: Number(klyme.c24h || 0),
      klymePaidCount48h: Number(klyme.c48h || 0),
      klymePaidTotal1h: Number(klyme.a1h || 0),
      klymePaidTotal12h: Number(klyme.a12h || 0),
      klymePaidTotal24h: Number(klyme.a24h || 0),
      klymePaidTotal48h: Number(klyme.a48h || 0),
      ivmsPaidCount: Number(recv.ivms_count || 0),
      ivmsPaidTotal: Number(recv.ivms_amount || 0),
      aabanpayPaidCount: Number(aabanpay.all_count || 0) || Number(aabanpayFallback[0]?.count || 0),
      aabanpayPaidTotal: Number(aabanpay.all_amount || 0) || Number(aabanpayFallback[0]?.amount || 0),
      aabanpayPaidCount1h: Number(aabanpay.c1h || 0),
      aabanpayPaidTotal1h: Number(aabanpay.a1h || 0),
      aabanpayPaidCount12h: Number(aabanpay.c12h || 0),
      aabanpayPaidTotal12h: Number(aabanpay.a12h || 0),
      aabanpayPaidCount24h: Number(aabanpay.c24h || 0),
      aabanpayPaidTotal24h: Number(aabanpay.a24h || 0),
      aabanpayPaidCount48h: Number(aabanpay.c48h || 0),
      aabanpayPaidTotal48h: Number(aabanpay.a48h || 0),
      totalPaymentLinksSent: links.total_count || 0,
      paymentLinksSent1h: links.c1h || 0,
      paymentLinksSent12h: links.c12h || 0,
      paymentLinksSent24h: links.c24h || 0,
      paymentLinksSent7d: links.c7d || 0,
    }

    setCachedDashboard(cacheKey, payload)
    return res.json(payload)
  } catch (e) {
    console.error('[admin-service] /api/admin/stats failed:', e?.message || e)
    return res.status(500).json({ error: e?.message || 'Failed to fetch stats' })
  }
})

app.get('/api/admin/stats/orders-submitted', requireAuth, async (req, res) => {
  try {
    const [h1Rows] = await dbQuery(`SELECT COUNT(*) AS count FROM orders WHERE created_at >= (NOW() - INTERVAL '1 hour')`)
    const [h12Rows] = await dbQuery(`SELECT COUNT(*) AS count FROM orders WHERE created_at >= (NOW() - INTERVAL '12 hours')`)
    const [h24Rows] = await dbQuery(`SELECT COUNT(*) AS count FROM orders WHERE created_at >= (NOW() - INTERVAL '24 hours')`)
    const [d7Rows] = await dbQuery(`SELECT COUNT(*) AS count FROM orders WHERE created_at >= (NOW() - INTERVAL '7 days')`)


    const h1 = Array.isArray(h1Rows) ? h1Rows : []
    const h12 = Array.isArray(h12Rows) ? h12Rows : []
    const h24 = Array.isArray(h24Rows) ? h24Rows : []
    const d7 = Array.isArray(d7Rows) ? d7Rows : []

    return res.json({
      ordersSubmitted1h: Number(h1[0]?.count || 0),
      ordersSubmitted12h: Number(h12[0]?.count || 0),
      ordersSubmitted24h: Number(h24[0]?.count || 0),
      ordersSubmitted7d: Number(d7[0]?.count || 0),
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch orders submitted stats' })
  }
})

app.get('/api/admin/stats/completed-payments', requireAuth, async (req, res) => {
  try {
    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]

    const placeholders = receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')

    const baseSql = (intervalExpr) => `
      SELECT
        COALESCE(SUM(CASE
          WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${placeholders}))
            THEN 1 ELSE 0
        END),0) AS count,
        COALESCE(SUM(CASE
          WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${placeholders}))
            THEN COALESCE(lp.amount, orders.total, 0)
          ELSE 0
        END),0) AS amount
      FROM orders
      LEFT JOIN (
        SELECT p.order_id, p.amount, COALESCE(p.updated_at, p.created_at) AS paid_at
        FROM payments p
        INNER JOIN (
          SELECT order_id, MAX(COALESCE(updated_at, created_at)) AS paid_at
          FROM payments
          WHERE LOWER(COALESCE(status,'')) IN (${placeholders})
          GROUP BY order_id
        ) latest
          ON latest.order_id = p.order_id
         AND latest.paid_at = COALESCE(p.updated_at, p.created_at)
        WHERE LOWER(COALESCE(p.status,'')) IN (${placeholders})
      ) lp
        ON lp.order_id = orders.id
      WHERE COALESCE(lp.paid_at, orders.updated_at, orders.created_at) >= (NOW() - INTERVAL '${intervalExpr}')
    `

    const params = receivedStatuses

    const [h1Rows] = await dbQuery(baseSql('1 HOUR'), params)
    const [h12Rows] = await dbQuery(baseSql('12 HOUR'), params)
    const [h24Rows] = await dbQuery(baseSql('24 HOUR'), params)
    const [d7Rows] = await dbQuery(baseSql('7 DAY'), params)

    const row = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : {})
    const r1 = row(h1Rows)
    const r12 = row(h12Rows)
    const r24 = row(h24Rows)
    const r7 = row(d7Rows)

    return res.json({
      completedPayments1h: Number(r1?.count || 0),
      completedPaymentsAmount1h: Number(r1?.amount || 0),
      completedPayments12h: Number(r12?.count || 0),
      completedPaymentsAmount12h: Number(r12?.amount || 0),
      completedPayments24h: Number(r24?.count || 0),
      completedPaymentsAmount24h: Number(r24?.amount || 0),
      completedPayments7d: Number(r7?.count || 0),
      completedPaymentsAmount7d: Number(r7?.amount || 0),
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch completed payments stats' })
  }
})

app.get('/api/admin/stats/product', requireAuth, async (req, res) => {
  try {
    const productIdRaw = req.query?.productId
    const productId = Number(productIdRaw)
    const sku = String(req.query?.sku || '').trim()

    const hasProductId = Number.isFinite(productId) && productId > 0
    const hasSku = Boolean(sku)
    if (!hasProductId && !hasSku) return res.status(400).json({ error: 'productId or sku is required' })

    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]

    const placeholders = receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')

    const baseSql = (intervalExpr) => `
      SELECT
        COALESCE(COUNT(DISTINCT orders.id),0) AS ordersCount,
        COALESCE(SUM(COALESCE(oi.quantity,0)),0) AS unitsSold,
        COALESCE(SUM(COALESCE(oi.line_total,0)),0) AS revenue
      FROM orders
      INNER JOIN order_items oi
        ON oi.order_id = orders.id
      LEFT JOIN (
        SELECT p.order_id, COALESCE(p.updated_at, p.created_at) AS paid_at
        FROM payments p
        INNER JOIN (
          SELECT order_id, MAX(COALESCE(updated_at, created_at)) AS paid_at
          FROM payments
          WHERE LOWER(COALESCE(status,'')) IN (${placeholders})
          GROUP BY order_id
        ) latest
          ON latest.order_id = p.order_id
         AND latest.paid_at = COALESCE(p.updated_at, p.created_at)
        WHERE LOWER(COALESCE(p.status,'')) IN (${placeholders})
      ) lp
        ON lp.order_id = orders.id
      WHERE (
        ${productIdPlaceholder}
        ${skuPlaceholder ? ' OR ' + skuPlaceholder : ''}
      )
        AND COALESCE(lp.paid_at, orders.updated_at, orders.created_at) >= (NOW() - INTERVAL '${intervalExpr}')
        AND (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${placeholders}))
    `

    const matchParams = []
    if (hasProductId) matchParams.push(productId)
    if (hasSku) matchParams.push(sku)

    const productIdPlaceholder = hasProductId ? `oi.product_id = $${receivedStatuses.length + 1}` : '1=0'
    const skuPlaceholder = hasSku ? `LOWER(COALESCE(oi.sku,'')) = LOWER($${receivedStatuses.length + (hasProductId ? 2 : 1)})` : null

    const paramsForInterval = [...receivedStatuses, ...matchParams]

    const [h1Rows] = await dbQuery(baseSql('1 HOUR'), paramsForInterval)
    const [h12Rows] = await dbQuery(baseSql('12 HOUR'), paramsForInterval)
    const [h24Rows] = await dbQuery(baseSql('24 HOUR'), paramsForInterval)
    const [d7Rows] = await dbQuery(baseSql('7 DAY'), paramsForInterval)

    const row = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : {})
    const r1 = row(h1Rows)
    const r12 = row(h12Rows)
    const r24 = row(h24Rows)
    const r7 = row(d7Rows)

    return res.json({
      sku,
      productId: hasProductId ? productId : null,
      product1h: {
        orders: Number(r1?.ordersCount || 0),
        units: Number(r1?.unitsSold || 0),
        revenue: Number(r1?.revenue || 0),
      },
      product12h: {
        orders: Number(r12?.ordersCount || 0),
        units: Number(r12?.unitsSold || 0),
        revenue: Number(r12?.revenue || 0),
      },
      product24h: {
        orders: Number(r24?.ordersCount || 0),
        units: Number(r24?.unitsSold || 0),
        revenue: Number(r24?.revenue || 0),
      },
      product7d: {
        orders: Number(r7?.ordersCount || 0),
        units: Number(r7?.unitsSold || 0),
        revenue: Number(r7?.revenue || 0),
      },
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch product stats' })
  }
})

app.get('/api/admin/stats/weekly', requireAuth, async (req, res) => {
  try {
    const daysRaw = Number(req.query?.days || 7)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 30) : 7

    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]

    const paymentDateExpr = `COALESCE(
      (
        SELECT COALESCE(p.updated_at, p.created_at)
        FROM payments p
        WHERE p.order_id = orders.id
          AND LOWER(COALESCE(p.status,'')) IN (${receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')})
        ORDER BY COALESCE(p.updated_at, p.created_at) DESC
        LIMIT 1
      ),
      orders.updated_at,
      orders.created_at
    )`

    const domainId = await resolveAdminDomainFilter(req)
    const domainWeeklyWhere = domainId != null ? 'AND orders.domain_id = $11' : ''
    const domainWeeklyParams = domainId != null ? [domainId] : []

    const [rows] = await dbQuery(
      `SELECT
        orders.id,
        orders.total,
        orders.status,
        orders.payment_status,
        orders.submitted_at,
        orders.reserved_at,
        orders.created_at,
        ${paymentDateExpr} AS payment_date
       FROM orders
       WHERE (orders.created_at >= (NOW() - ($10 * INTERVAL '1 day'))
          OR ${paymentDateExpr} >= (NOW() - ($10 * INTERVAL '1 day')))
          ${domainWeeklyWhere}`,
      [...receivedStatuses, days, ...domainWeeklyParams]
    )

    const isReceived = (raw) => {
      const s = String(raw || '').trim().toLowerCase()
      return receivedStatuses.includes(s)
    }

    const startUtc = new Date()
    startUtc.setUTCHours(0, 0, 0, 0)
    startUtc.setUTCDate(startUtc.getUTCDate() - (days - 1))

    const isoDay = (d) => {
      const yyyy = d.getUTCFullYear()
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(d.getUTCDate()).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    }

    const dayBuckets = []
    const byDay = new Map()
    for (let i = 0; i < days; i++) {
      const d = new Date(startUtc)
      d.setUTCDate(startUtc.getUTCDate() + i)
      const key = isoDay(d)
      const base = {
        date: key,
        ordersRequested: 0,
        submittedCount: 0,
        submittedAmount: 0,
        securedCount: 0,
        securedAmount: 0,
        receivedCount: 0,
        receivedAmount: 0,
        completedCount: 0,
        completedAmount: 0,
      }
      dayBuckets.push(base)
      byDay.set(key, base)
    }

    const list = Array.isArray(rows) ? rows : []
    for (const r of list) {
      const createdAt = r?.created_at ? new Date(r.created_at) : null
      if (createdAt && Number.isFinite(createdAt.getTime())) {
        const k = isoDay(createdAt)
        const bucket = byDay.get(k)
        if (bucket) bucket.ordersRequested += 1
      }

      const paymentStatus = String(r?.payment_status || '').trim().toLowerCase()
      const hasSecured = paymentStatus === 'received' || isReceived(paymentStatus)

      const submittedAt = r?.submitted_at ? new Date(r.submitted_at) : null
      const reservedAt = r?.reserved_at ? new Date(r.reserved_at) : null
      const submittedDate = submittedAt && Number.isFinite(submittedAt.getTime())
        ? submittedAt
        : (reservedAt && Number.isFinite(reservedAt.getTime()) ? reservedAt : null)
      const submittedKey = submittedDate ? isoDay(submittedDate) : null
      const isSubmitted = !hasSecured && (submittedAt || reservedAt)
      if (isSubmitted && submittedKey) {
        const bucket = byDay.get(submittedKey)
        if (bucket) {
          const amt = toMoney(r?.total)
          bucket.submittedCount += 1
          bucket.submittedAmount = toMoney(bucket.submittedAmount + amt)
        }
      }

      const paymentDate = r?.payment_date ? new Date(r.payment_date) : null
      const payKey = paymentDate && Number.isFinite(paymentDate.getTime()) ? isoDay(paymentDate) : null
      if (payKey && hasSecured) {
        const bucket = byDay.get(payKey)
        if (bucket) {
          const amt = toMoney(r?.total)
          bucket.securedCount += 1
          bucket.securedAmount = toMoney(bucket.securedAmount + amt)

          if (paymentStatus === 'received') {
            bucket.receivedCount += 1
            bucket.receivedAmount = toMoney(bucket.receivedAmount + amt)
          }

          const status = String(r?.status || '').trim().toLowerCase()
          const isCompleted = status === 'completed' || status === 'delivered'
          if (isCompleted) {
            bucket.completedCount += 1
            bucket.completedAmount = toMoney(bucket.completedAmount + amt)
          }
        }
      }
    }

    return res.json({ days, series: dayBuckets })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch weekly stats' })
  }
})

app.get('/api/admin/stats/timeseries', requireAuth, async (req, res) => {
  try {
    const bucketRaw = String(req.query?.bucket || 'auto').trim().toLowerCase()
    const allowedBuckets = new Set(['auto', 'day', 'month'])
    if (!allowedBuckets.has(bucketRaw)) return res.status(400).json({ error: 'Unsupported bucket' })

    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]

    const paymentDateExpr = `COALESCE(
      (
        SELECT COALESCE(p.updated_at, p.created_at)
        FROM payments p
        WHERE p.order_id = orders.id
          AND LOWER(COALESCE(p.status,'')) IN (${receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')})
        ORDER BY COALESCE(p.updated_at, p.created_at) DESC
        LIMIT 1
      ),
      orders.updated_at,
      orders.created_at
    )`

    const submittedDateExpr = `COALESCE(orders.submitted_at, orders.reserved_at, orders.created_at)`

    const [rangeRows] = await dbQuery(
      `SELECT
        MIN(DATE(orders.created_at)) AS min_created,
        MAX(DATE(orders.created_at)) AS max_created,
        MIN(DATE(${paymentDateExpr})) AS min_payment,
        MAX(DATE(${paymentDateExpr})) AS max_payment,
        MIN(DATE(${submittedDateExpr})) AS min_submitted,
        MAX(DATE(${submittedDateExpr})) AS max_submitted
       FROM orders`,
      receivedStatuses
    )

    const rr = Array.isArray(rangeRows) ? rangeRows : []
    const range = rr[0] || {}

    const toYmd = (v) => {
      if (!v) return ''
      if (v instanceof Date && Number.isFinite(v.getTime())) {
        const yyyy = v.getUTCFullYear()
        const mm = String(v.getUTCMonth() + 1).padStart(2, '0')
        const dd = String(v.getUTCDate()).padStart(2, '0')
        return `${yyyy}-${mm}-${dd}`
      }
      const s = String(v).trim()
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
      return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
    }

    const minStr = toYmd(range?.min_created || range?.min_payment || range?.min_submitted)
    const maxStr = toYmd(range?.max_created || range?.max_payment || range?.max_submitted)

    if (!minStr || !maxStr) return res.json({ bucket: 'auto', series: [] })

    const parseDateUtc = (s) => {
      if (s instanceof Date && Number.isFinite(s.getTime())) {
        const yyyy = s.getUTCFullYear()
        const mm = s.getUTCMonth()
        const dd = s.getUTCDate()
        const t = Date.UTC(yyyy, mm, dd, 0, 0, 0, 0)
        return Number.isFinite(t) ? new Date(t) : null
      }
      const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!m) return null
      const y = Number(m[1])
      const mo = Number(m[2]) - 1
      const d = Number(m[3])
      const t = Date.UTC(y, mo, d, 0, 0, 0, 0)
      return Number.isFinite(t) ? new Date(t) : null
    }

    const minDate = parseDateUtc(minStr)
    const maxDate = parseDateUtc(maxStr)
    if (!minDate || !maxDate) return res.json({ bucket: bucketRaw, series: [] })

    const spanDays = Math.max(0, Math.round((maxDate.getTime() - minDate.getTime()) / (24 * 60 * 60 * 1000))) + 1
    const resolvedBucket = bucketRaw === 'auto' ? (spanDays <= 90 ? 'day' : 'month') : bucketRaw

    const isoDay = (d) => {
      const yyyy = d.getUTCFullYear()
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(d.getUTCDate()).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    }

    const isoMonth = (d) => {
      const yyyy = d.getUTCFullYear()
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
      return `${yyyy}-${mm}`
    }

    const buckets = []
    const byKey = new Map()

    if (resolvedBucket === 'day') {
      const end = new Date(maxDate)
      end.setUTCDate(end.getUTCDate() + 1)
      const cur = new Date(minDate)
      while (cur < end) {
        const key = isoDay(cur)
        const base = {
          date: key,
          ordersRequested: 0,
          submittedCount: 0,
          submittedAmount: 0,
          securedCount: 0,
          securedAmount: 0,
          receivedCount: 0,
          receivedAmount: 0,
          completedCount: 0,
          completedAmount: 0,
        }
        buckets.push(base)
        byKey.set(key, base)
        cur.setUTCDate(cur.getUTCDate() + 1)
      }
    } else {
      const startMonth = new Date(minDate)
      startMonth.setUTCDate(1)
      const end = new Date(maxDate)
      end.setUTCDate(1)
      end.setUTCMonth(end.getUTCMonth() + 1)
      const cur = new Date(startMonth)
      while (cur < end) {
        const key = isoMonth(cur)
        const base = {
          date: key,
          ordersRequested: 0,
          submittedCount: 0,
          submittedAmount: 0,
          securedCount: 0,
          securedAmount: 0,
          receivedCount: 0,
          receivedAmount: 0,
          completedCount: 0,
          completedAmount: 0,
        }
        buckets.push(base)
        byKey.set(key, base)
        cur.setUTCMonth(cur.getUTCMonth() + 1)
      }
    }

    const ordersKeyExpr = resolvedBucket === 'day'
      ? "TO_CHAR(orders.created_at, 'YYYY-MM-DD')"
      : "TO_CHAR(orders.created_at, 'YYYY-MM')"
    const paymentsKeyExpr = resolvedBucket === 'day'
      ? `TO_CHAR(${paymentDateExpr}, 'YYYY-MM-DD')`
      : `TO_CHAR(${paymentDateExpr}, 'YYYY-MM')`

    const submittedKeyExpr = resolvedBucket === 'day'
      ? `TO_CHAR(${submittedDateExpr}, 'YYYY-MM-DD')`
      : `TO_CHAR(${submittedDateExpr}, 'YYYY-MM')`

    const [ordersAggRows] = await dbQuery(
      `SELECT
        ${ordersKeyExpr} AS k,
        COUNT(*) AS ordersRequested
       FROM orders
       GROUP BY k
       ORDER BY k ASC`
    )

    const receivedPlaceholders = receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')

    const [submittedAggRows] = await dbQuery(
      `SELECT
        ${submittedKeyExpr} AS k,
        SUM(CASE WHEN LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders}) THEN 0 ELSE 1 END) AS submittedCount,
        COALESCE(SUM(CASE
          WHEN LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders})
            THEN 0
          ELSE COALESCE(orders.total, 0)
        END),0) AS submittedAmount
       FROM orders
       WHERE (orders.submitted_at IS NOT NULL OR orders.reserved_at IS NOT NULL)
       GROUP BY k
       ORDER BY k ASC`,
      receivedStatuses
    )

    const [paymentsAggRows] = await dbQuery(
      `SELECT
        TO_CHAR(COALESCE(lp.paid_at, orders.updated_at, orders.created_at), CASE WHEN '${resolvedBucket}' = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS k,
        SUM(CASE WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders})) THEN 1 ELSE 0 END) AS securedCount,
        COALESCE(SUM(CASE
          WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders}))
            THEN COALESCE(lp.amount, orders.total, 0)
          ELSE 0
        END),0) AS securedAmount,
        SUM(CASE WHEN LOWER(COALESCE(orders.payment_status,'')) = 'received' THEN 1 ELSE 0 END) AS receivedCount,
        COALESCE(SUM(CASE
          WHEN LOWER(COALESCE(orders.payment_status,'')) = 'received'
            THEN COALESCE(lp.amount, orders.total, 0)
          ELSE 0
        END),0) AS receivedAmount,
        SUM(CASE
          WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders}))
            AND LOWER(COALESCE(orders.status,'')) = 'delivered'
            THEN 1
          ELSE 0
        END) AS completedCount,
        COALESCE(SUM(CASE
          WHEN (lp.order_id IS NOT NULL OR LOWER(COALESCE(orders.payment_status,'')) IN (${receivedPlaceholders}))
            AND LOWER(COALESCE(orders.status,'')) = 'delivered'
            THEN COALESCE(lp.amount, orders.total, 0)
          ELSE 0
        END),0) AS completedAmount
       FROM orders
       LEFT JOIN (
         SELECT p.order_id, p.amount, COALESCE(p.updated_at, p.created_at) AS paid_at
         FROM payments p
         INNER JOIN (
           SELECT order_id, MAX(COALESCE(updated_at, created_at)) AS paid_at
           FROM payments
           WHERE LOWER(COALESCE(status,'')) IN (${receivedPlaceholders})
           GROUP BY order_id
         ) latest
           ON latest.order_id = p.order_id
          AND latest.paid_at = COALESCE(p.updated_at, p.created_at)
         WHERE LOWER(COALESCE(p.status,'')) IN (${receivedPlaceholders})
       ) lp
         ON lp.order_id = orders.id
       GROUP BY k
       ORDER BY k ASC`,
      receivedStatuses
    )

    const ordList = Array.isArray(ordersAggRows) ? ordersAggRows : []
    for (const r of ordList) {
      const key = String(r?.k || '').trim()
      const b = byKey.get(key)
      if (!b) continue
      b.ordersRequested = Number(r?.ordersRequested || 0)
    }

    const subList = Array.isArray(submittedAggRows) ? submittedAggRows : []
    for (const r of subList) {
      const key = String(r?.k || '').trim()
      const b = byKey.get(key)
      if (!b) continue
      b.submittedCount = Number(r?.submittedCount || 0)
      b.submittedAmount = toMoney(r?.submittedAmount)
    }

    const payList = Array.isArray(paymentsAggRows) ? paymentsAggRows : []
    for (const r of payList) {
      const key = String(r?.k || '').trim()
      const b = byKey.get(key)
      if (!b) continue
      b.securedCount = Number(r?.securedCount || 0)
      b.securedAmount = toMoney(r?.securedAmount)
      b.receivedCount = Number(r?.receivedCount || 0)
      b.receivedAmount = toMoney(r?.receivedAmount)
      b.completedCount = Number(r?.completedCount || 0)
      b.completedAmount = toMoney(r?.completedAmount)
    }

    return res.json({ bucket: resolvedBucket, series: buckets })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch timeseries stats' })
  }
})

app.get('/api/admin/ibalticx-paid', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 2000)
    const offset = Math.max(Number(req.query?.offset || 0), 0)

    const [rows] = await dbQuery(
      `SELECT
        id,
        order_number,
        customer_name,
        customer_email,
        customer_phone,
        shipping_address,
        shipping_city,
        shipping_zip,
        shipping_country,
        tracking_number,
        subtotal,
        discount_amount,
        promo_code,
        total,
        currency,
        status,
        payment_status,
        payment_rejection_reason,
        created_at,
        ibalticx_invoice_sent_at,
        ibalticx_invoice_to,
        ibalticx_invoice_message_id,
        bank_account_used
      FROM orders
      WHERE LOWER(payment_status) = 'received'
        AND LOWER(bank_account_used) = 'ibalticx'
      ORDER BY created_at DESC
      LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`
    )
    return res.json({ orders: Array.isArray(rows) ? rows : [], limit, offset })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch iBalticX paid orders' })
  }
})

app.get('/api/admin/klyme-paid', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 2000)
    const offset = Math.max(Number(req.query?.offset || 0), 0)

    const receivedStatuses = [
      'paid',
      'succeeded',
      'success',
      'completed',
      'complete',
      'captured',
      'approved',
      'verified',
      'received',
    ]
    const receivedPlaceholders = receivedStatuses.map((_, i) => '$' + (i + 1)).join(',')

    const [rows] = await dbQuery(
      `
        SELECT
          o.id,
          o.order_number,
          o.customer_name,
          o.customer_email,
          o.customer_phone,
          o.shipping_address,
          o.shipping_city,
          o.shipping_zip,
          o.shipping_country,
          o.tracking_number,
          o.subtotal,
          o.discount_amount,
          o.promo_code,
          o.total,
          o.currency,
          o.status,
          o.payment_status,
          o.payment_rejection_reason,
          o.created_at,
          p.provider AS payment_provider,
          p.provider_id AS payment_provider_id,
          p.status AS payment_provider_status,
          p.amount AS payment_amount,
          p.currency AS payment_currency,
          COALESCE(p.updated_at, p.created_at) AS paid_at
        FROM orders o
        INNER JOIN (
          SELECT order_id, MAX(COALESCE(updated_at, created_at)) AS paid_at
          FROM payments
          WHERE LOWER(COALESCE(provider,'')) = 'klyme'
            AND LOWER(COALESCE(status,'')) IN (${receivedPlaceholders})
          GROUP BY order_id
        ) latest
          ON latest.order_id = o.id
        INNER JOIN payments p
          ON p.order_id = latest.order_id
         AND COALESCE(p.updated_at, p.created_at) = latest.paid_at
         AND LOWER(COALESCE(p.provider,'')) = 'klyme'
         AND LOWER(COALESCE(p.status,'')) IN (${receivedPlaceholders})
        ORDER BY paid_at DESC
        LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}
      `,
      receivedStatuses
    )

    return res.json({ orders: Array.isArray(rows) ? rows : [], limit, offset })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch Klyme paid orders' })
  }
})

app.get('/api/admin/payment-links', requireAuth, async (req, res) => {
  try {
    const hoursRaw = Number(req.query?.hours)
    const allowedHours = new Set([1, 12, 24])
    const hours = allowedHours.has(hoursRaw) ? hoursRaw : 1
    const limit = Math.min(Math.max(Number(req.query?.limit || 300), 1), 1000)

    const [rows] = await dbQuery(
      `SELECT
        pcr.id,
        pcr.order_id,
        pcr.email AS request_email,
        pcr.created_at AS sent_at,
        o.customer_email,
        o.payment_status,
        o.total AS order_total,
        o.currency AS order_currency
      FROM payment_capture_requests pcr
      LEFT JOIN orders o ON o.id = pcr.order_id
      WHERE pcr.created_at >= (NOW() - INTERVAL '${Math.trunc(hours)} hours')
      ORDER BY pcr.created_at DESC
      LIMIT ${Math.trunc(limit)}`
    )

    const list = Array.isArray(rows) ? rows : []
    const items = list.map((r) => {
      const rawStatus = String(r?.payment_status || '').trim().toLowerCase()
      let status = 'pending'
      if (rawStatus === 'received' || rawStatus === 'paid' || rawStatus === 'completed') status = 'received'
      else if (rawStatus === 'rejected' || rawStatus === 'failed' || rawStatus === 'cancelled') status = 'rejected'

      const email = String(r?.request_email || r?.customer_email || '').trim()

      return {
        id: Number(r?.id),
        order_id: Number(r?.order_id),
        email,
        status,
        sent_at: r?.sent_at,
        amount: Number(r?.order_total || 0),
        currency: String(r?.order_currency || 'GBP').trim() || 'GBP',
      }
    })

    return res.json({ success: true, hours, links: items })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to fetch payment links' })
  }
})

app.post('/api/admin/orders', requireAuth, adminUpload.single('adminPaymentScreenshot'), async (req, res) => {
  let connection
  try {
    const body = req.body || {}
    let screenshotFilename = null
    let screenshotUrl = null
    if (req.file && req.file.filename) {
      screenshotFilename = req.file.filename
      const proto = req.headers['x-forwarded-proto'] || req.protocol
      const host = req.get('host')
      const base = PUBLIC_BASE_URL || `${proto}://${host}`
      screenshotUrl = `${String(base || '').replace(/\/$/, '')}/uploads/${encodeURIComponent(req.file.filename)}`
    }
    const customer_name = normalizeName(body.customer_name || body.customerName || body.name)
    const customer_email = String(body.customer_email || '').trim().toLowerCase()
    const customer_phone = String(body.customer_phone || '').trim().slice(0, 32)
    const shipping_address = normalizeAddressField(body.shipping_address, 255)
    const shipping_city = normalizeAddressField(body.shipping_city, 120)
    const shipping_state = normalizeAddressField(body.shipping_state, 120)
    const shipping_zip = normalizeAddressField(body.shipping_zip, 40)
    const shipping_country = normalizeAddressField(body.shipping_country, 120) || 'United Kingdom'
    const promo_code = String(body.promo_code || '').trim().slice(0, 64).toUpperCase()
    const payment_method = String(body.payment_method || 'Bank Transfer').trim().slice(0, 100)
    const currencyRaw = String(body.currency || 'GBP').trim().toUpperCase()
    const currency = currencyRaw || 'GBP'
    const orderStatusRaw = String(body.status || 'pending').trim().toLowerCase()
    const paymentStatusRaw = String(body.payment_status || 'pending').trim().toLowerCase()
    const status = orderStatusRaw || 'pending'
    const payment_status = paymentStatusRaw || 'pending'

    const requestedCreditsAppliedRaw = Number(body.credits_applied || 0)
    const requestedCreditsApplied = Number.isFinite(requestedCreditsAppliedRaw) ? Math.max(0, requestedCreditsAppliedRaw) : 0

    const clientTotalBeforeCreditsRaw = Number(body.total_before_credits)
    const clientTotalBeforeCredits = Number.isFinite(clientTotalBeforeCreditsRaw) ? Math.max(0, clientTotalBeforeCreditsRaw) : null

    const clientTotalRaw = Number(body.total)
    const clientTotal = Number.isFinite(clientTotalRaw) ? Math.max(0, clientTotalRaw) : null

    if (!customer_name) {
      console.warn('[admin/orders] missing customer_name', {
        bodyKeys: Object.keys(body || {}),
        customer_name: body?.customer_name,
        customerName: body?.customerName,
        name: body?.name,
        contentType: req.headers['content-type'],
      })
      return res.status(400).json({ error: 'customer_name is required' })
    }
    if (!customer_email || !customer_email.includes('@')) return res.status(400).json({ error: 'Valid customer_email is required' })
    if (!shipping_address) return res.status(400).json({ error: 'shipping_address is required' })
    if (!shipping_city) return res.status(400).json({ error: 'shipping_city is required' })
    if (!shipping_zip) return res.status(400).json({ error: 'shipping_zip is required' })

    let rawItems = []
    if (Array.isArray(body.items)) {
      rawItems = body.items
    } else if (typeof body.items === 'string') {
      try {
        const parsed = JSON.parse(body.items)
        if (Array.isArray(parsed)) rawItems = parsed
      } catch {
        rawItems = []
      }
    } else {
      rawItems = []
    }
    if (!rawItems.length) return res.status(400).json({ error: 'At least one item is required' })

    const cleanedItems = []
    for (const raw of rawItems) {
      const name = normalizeName(raw?.name)
      const sku = normalizeSku(raw?.sku)
      const quantity = Math.trunc(Number(raw?.quantity))
      const unit_price = toMoney(raw?.unit_price)
      if (!name) return res.status(400).json({ error: 'Each item requires name' })
      if (!sku) return res.status(400).json({ error: 'Each item requires sku' })
      if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Each item quantity must be >= 1' })
      if (!Number.isFinite(unit_price) || unit_price < 0) return res.status(400).json({ error: 'Each item unit_price must be >= 0' })
      cleanedItems.push({ name, sku, quantity, unit_price, line_total: toMoney(quantity * unit_price) })
    }

    const subtotal = toMoney(cleanedItems.reduce((sum, it) => sum + Number(it.line_total || 0), 0))
    const discount_amount = 0
    const total_after_discount = subtotal
    const total_before_discount = subtotal
    const totalBeforeCredits = toMoney(clientTotalBeforeCredits !== null ? clientTotalBeforeCredits : total_after_discount)
    let creditsAppliedFinal = toMoney(Math.min(requestedCreditsApplied, totalBeforeCredits))
    const total = toMoney(clientTotal !== null ? clientTotal : Math.max(0, totalBeforeCredits - creditsAppliedFinal))
    const items_text = cleanedItems.map((it) => `${it.name} x ${it.quantity}`).join(', ')
    const created_at = nowMysqlDatetime()

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    let order_number = String(body.order_number || '').trim()
    if (!order_number) order_number = generateAdminOrderNumber()

    for (let i = 0; i < 8; i++) {
      const [dupRows] = await dbQueryConn(connection, 'SELECT id FROM orders WHERE order_number = $1', [order_number])
      const dup = Array.isArray(dupRows) ? dupRows : []
      if (!dup.length) break
      order_number = generateAdminOrderNumber()
    }

    const [dupRowsFinal] = await dbQueryConn(connection, 'SELECT id FROM orders WHERE order_number = $1', [order_number])
    if (Array.isArray(dupRowsFinal) && dupRowsFinal.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'Could not allocate unique order number' })
    }

    // Apply Alluvi credits (if provided) to the customer wallet.
    // This is best-effort: if the user does not exist, credits are treated as 0.
    if (creditsAppliedFinal > 0) {
      try {
        await ensureCustomerCreditsSchema()
      } catch {
        // ignore
      }

      try {
        const [userRows] = await dbQueryConn(connection, 
          'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1',
          [String(customer_email || '').trim().toLowerCase()]
        )
        const user = Array.isArray(userRows) && userRows[0] ? userRows[0] : null
        const userId = Number(user?.id)
        if (!Number.isFinite(userId) || userId <= 0) {
          creditsAppliedFinal = 0
        } else {
          await dbQueryConn(connection, 'INSERT INTO user_credits (user_id, balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING', [userId])
          const [balRows] = await dbQueryConn(connection, 'SELECT balance FROM user_credits WHERE user_id = $1 FOR UPDATE', [userId])
          const balList = Array.isArray(balRows) ? balRows : []
          const balance = Number(balList[0]?.balance || 0)
          const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0
          const canApply = toMoney(Math.min(creditsAppliedFinal, safeBalance, totalBeforeCredits))
          if (!(canApply > 0)) {
            creditsAppliedFinal = 0
          } else {
            await dbQueryConn(connection, 
              'UPDATE user_credits SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE user_id = $2',
              [canApply, userId]
            )
            try {
              const adminName = String(req.adminUser?.username || req.adminUser?.role || 'admin')
              await dbQueryConn(connection, 
                'INSERT INTO credit_ledger (user_id, amount, source, admin_username, order_number, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, -canApply, 'admin_apply', adminName, order_number, created_at]
              )
            } catch {
              // ignore ledger failures
            }
            creditsAppliedFinal = canApply
          }
        }
      } catch {
        creditsAppliedFinal = 0
      }
    }

    const knownCols = ORDERS_COLUMNS
    const hasCol = (name) => {
      if (!knownCols) return true
      return knownCols.has(String(name))
    }

    const insertCols = []
    const insertVals = []
    const push = (col, val) => {
      if (!hasCol(col)) return
      insertCols.push(col)
      insertVals.push(val)
    }

    push('order_number', order_number)
    push('customer_email', customer_email)
    push('customer_name', customer_name)
    push('customer_phone', customer_phone || null)

    push('shipping_address', shipping_address)
    push('shipping_city', shipping_city)
    push('shipping_state', shipping_state || null)
    push('shipping_zip', shipping_zip)
    push('shipping_country', shipping_country)

    push('currency', currency)
    push('subtotal', totalBeforeCredits)
    push('shipping', 0)
    push('total', total)

    push('credits_applied', creditsAppliedFinal)
    push('total_before_credits', totalBeforeCredits)

    push('total_before_discount', total_before_discount)
    push('total_after_discount', total_after_discount)
    push('discount_amount', discount_amount)

    push('promo_code', promo_code || null)
    push('promo_discount_percent', 0)
    push('promo_valid', !!promo_code)

    push('status', status)
    push('payment_status', payment_status)
    push('payment_method', payment_method)

    push('items_text', items_text)
    push('payment_screenshot_filename', screenshotFilename)
    push('payment_screenshot_url', screenshotUrl)

    push('bank_account_used', null)
    push('reserved_at', null)
    push('submitted_at', null)
    push('created_at', created_at)

    const orderDomainId = (await resolveAdminDomainFilter(req)) ?? req.domainId
    push('domain_id', orderDomainId ?? null)

    if (!insertCols.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Order insert failed: no compatible columns detected' })
    }

    const placeholders = insertCols.map((_, i) => '$' + (i + 1)).join(', ')
    await dbQueryConn(connection, 
      `INSERT INTO orders (${insertCols.join(', ')}) VALUES (${placeholders})`,
      insertVals
    )

    const [orderRows] = await dbQueryConn(connection, 'SELECT id FROM orders WHERE order_number = $1', [order_number])
    const orderId = Array.isArray(orderRows) && orderRows[0] ? Number(orderRows[0].id) : NaN
    if (!Number.isFinite(orderId) || orderId <= 0) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(500).json({ error: 'Failed to resolve created order id' })
    }

    for (const it of cleanedItems) {
      await dbQueryConn(connection, 
        'INSERT INTO order_items (order_id, product_id, name, sku, quantity, unit_price, line_total) VALUES ($1, NULL, $2, $3, $4, $5, $6)',
        [orderId, it.name, it.sku, it.quantity, it.unit_price, it.line_total]
      )
    }

    const provider_id = `ADMIN-${order_number}`
    await dbQueryConn(connection,
      `INSERT INTO payments (order_id, provider, provider_id, amount, currency, status, raw_response, created_at, domain_id)
       VALUES ($1, 'Manual', $2, $3, $4, $5, NULL, $6, $7)`,
      [orderId, provider_id, total, currency, payment_status, created_at, orderDomainId ?? null]
    )

    const [createdOrderRows] = await dbQueryConn(connection, 'SELECT * FROM orders WHERE id = $1', [orderId])
    const [createdItemsRows] = await dbQueryConn(connection, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [orderId])
    const [createdPaymentsRows] = await dbQueryConn(connection, 'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [orderId])

    dbQueryConn(connection, 'COMMIT')

    return res.status(201).json({
      success: true,
      order: Array.isArray(createdOrderRows) ? (createdOrderRows[0] || null) : null,
      items: Array.isArray(createdItemsRows) ? createdItemsRows : [],
      payments: Array.isArray(createdPaymentsRows) ? createdPaymentsRows : [],
    })
  } catch (e) {
    if (connection) {
      try { dbQueryConn(connection, 'ROLLBACK') } catch {}
    }
    return res.status(500).json({ error: e?.message || 'Failed to create order' })
  } finally {
    if (connection) connection.release()
  }
})

app.get('/api/admin/orders', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const offset = Math.max(Number(req.query?.offset || 0), 0)

    const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200
    const safeOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0

    const domainId = await resolveAdminDomainFilter(req)
    const domainParams = []
    let domainWhereClause = ''
    if (domainId != null) {
      domainParams.push(domainId)
      domainWhereClause = `WHERE orders.domain_id = $${domainParams.length}`
    }

    const [rows] = await dbQuery(
      `SELECT
        orders.*,
        d.domain_name,
        (
          SELECT p.status
          FROM payments p
          WHERE p.order_id = orders.id
          ORDER BY COALESCE(p.updated_at, p.created_at) DESC
          LIMIT 1
        ) AS latest_payment_status,
        (
          SELECT p.status
          FROM payments p
          WHERE p.order_id = orders.id
            AND LOWER(p.status) IN ('received','paid','succeeded','success','completed','complete','captured','approved','verified')
          ORDER BY COALESCE(p.updated_at, p.created_at) DESC
          LIMIT 1
        ) AS latest_successful_payment_status,
        (
          SELECT p.status
          FROM payments p
          WHERE p.order_id = orders.id
            AND LOWER(p.status) IN ('rejected','reject','declined','denied','failed','cancelled','canceled')
          ORDER BY COALESCE(p.updated_at, p.created_at) DESC
          LIMIT 1
        ) AS latest_failed_payment_status,
        (
          CASE
            WHEN LOWER(COALESCE(orders.payment_status, '')) IN ('received','paid','succeeded','success','completed','complete','captured','approved','verified') THEN orders.payment_status
            WHEN LOWER(COALESCE(orders.payment_status, '')) IN ('rejected','reject','declined','denied','failed','cancelled','canceled') THEN orders.payment_status
            WHEN LOWER(COALESCE(
              (
                SELECT p4.status
                FROM payments p4
                WHERE p4.order_id = orders.id
                  AND LOWER(p4.status) IN ('received','paid','succeeded','success','completed','complete','captured','approved','verified')
                ORDER BY COALESCE(p4.updated_at, p4.created_at) DESC
                LIMIT 1
              ),
              ''
            )) IN ('received','paid','succeeded','success','completed','complete','captured','approved','verified') THEN 'received'
            WHEN LOWER(COALESCE(
              (
                SELECT p5.status
                FROM payments p5
                WHERE p5.order_id = orders.id
                  AND LOWER(p5.status) IN ('rejected','reject','declined','denied','failed','cancelled','canceled')
                ORDER BY COALESCE(p5.updated_at, p5.created_at) DESC
                LIMIT 1
              ),
              ''
            )) IN ('rejected','reject','declined','denied','failed','cancelled','canceled') THEN 'rejected'
            WHEN LOWER(COALESCE(
              (
                SELECT p2.status
                FROM payments p2
                WHERE p2.order_id = orders.id
                ORDER BY COALESCE(p2.updated_at, p2.created_at) DESC
                LIMIT 1
              ),
              ''
            )) IN ('received','paid','succeeded','success','completed','complete','captured','approved','verified') THEN 'received'
            WHEN LOWER(COALESCE(
              (
                SELECT p3.status
                FROM payments p3
                WHERE p3.order_id = orders.id
                ORDER BY COALESCE(p3.updated_at, p3.created_at) DESC
                LIMIT 1
              ),
              ''
            )) IN ('rejected','reject','declined','denied','failed','cancelled','canceled') THEN 'rejected'
            ELSE COALESCE(orders.payment_status, '')
          END
        ) AS effective_payment_status,
        (
          SELECT MAX(pcr.email_sent_at)
          FROM payment_capture_requests pcr
          WHERE pcr.order_id = orders.id
        ) AS payment_request_sent_at,
        (
          EXTRACT(EPOCH FROM (
            SELECT MAX(pcr.email_sent_at)
            FROM payment_capture_requests pcr
            WHERE pcr.order_id = orders.id
          ))::bigint * 1000
        ) AS payment_request_sent_at_ms,
        (
          COALESCE(
            (
              SELECT COALESCE(p.updated_at, p.created_at)
              FROM payments p
              WHERE p.order_id = orders.id
                AND LOWER(p.status) IN ('received', 'paid', 'succeeded', 'success', 'completed', 'complete', 'captured', 'approved', 'verified')
              ORDER BY COALESCE(p.updated_at, p.created_at) DESC
              LIMIT 1
            ),
            (
              SELECT COALESCE(p.updated_at, p.created_at)
              FROM payments p
              WHERE p.order_id = orders.id
              ORDER BY COALESCE(p.updated_at, p.created_at) DESC
              LIMIT 1
            )
          )
        ) AS payment_date,
        (
          EXTRACT(EPOCH FROM COALESCE(
            (
              SELECT COALESCE(p.updated_at, p.created_at)
              FROM payments p
              WHERE p.order_id = orders.id
                AND LOWER(p.status) IN ('received', 'paid', 'succeeded', 'success', 'completed', 'complete', 'captured', 'approved', 'verified')
              ORDER BY COALESCE(p.updated_at, p.created_at) DESC
              LIMIT 1
            ),
            (
              SELECT COALESCE(p.updated_at, p.created_at)
              FROM payments p
              WHERE p.order_id = orders.id
              ORDER BY COALESCE(p.updated_at, p.created_at) DESC
              LIMIT 1
            )
          ))::bigint * 1000
        ) AS payment_date_ms
      FROM orders
      LEFT JOIN domains d ON d.id = orders.domain_id
      ${domainWhereClause}
      ORDER BY created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      domainParams
    )

    const orders = Array.isArray(rows) ? rows : []

    const [countRows] = await dbQuery(
      `SELECT COUNT(*)::int AS total FROM orders ${domainWhereClause}`,
      domainParams
    )
    const total = countRows?.[0]?.total ?? 0

    return res.json({ orders, total })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch orders' })
  }
})

app.post('/api/admin/orders/bulk-capture-payment', requireAuth, async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.orderNumbers) ? req.body.orderNumbers : []
    const orderNumbers = raw
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .slice(0, 500)

    if (!orderNumbers.length) return res.status(400).json({ error: 'orderNumbers array is required' })

    const results = []
    for (const orderNumber of orderNumbers) {
      try {
        const [ordersRows] = await dbQuery(
          'SELECT id, order_number, customer_email, customer_name, total, currency, domain_id FROM orders WHERE order_number = $1',
          [orderNumber]
        )
        const orders = Array.isArray(ordersRows) ? ordersRows : []
        if (!orders.length) {
          results.push({ orderNumber, ok: false, skipped: false, error: 'Order not found' })
          continue
        }
        const order = orders[0]

        const customerEmail = String(order.customer_email || '').trim()
        if (!customerEmail || !customerEmail.includes('@')) {
          results.push({ orderNumber, ok: false, skipped: false, error: 'Order has no valid customer email' })
          continue
        }

        const [existingRows] = await dbQuery(
          'SELECT id FROM payment_capture_requests WHERE order_id = $1',
          [order.id]
        )
        const existing = Array.isArray(existingRows) ? existingRows : []
        if (existing.length) {
          results.push({ orderNumber, ok: true, skipped: true })
          continue
        }

        const rawToken = randomToken()
        const tokenHash = sha256Hex(rawToken)
        const createdAt = nowMysqlDatetime()
        const expiresAt = addHoursMysql(24)

        let connection
        try {
          connection = await pool.connect()
          dbQueryConn(connection, 'BEGIN')
          await dbQueryConn(connection, 
            `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, created_at, domain_id)
              VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
            [order.id, customerEmail, tokenHash, expiresAt, createdAt, order?.domain_id ?? null]
          )
          dbQueryConn(connection, 'COMMIT')
        } catch (e) {
          if (connection) {
            try {
              dbQueryConn(connection, 'ROLLBACK')
            } catch {
              // ignore
            }
          }
          throw e
        } finally {
          if (connection) connection.release()
        }

        const domainName = await resolveDomainNameById(order?.domain_id)
        const brand = await resolveBrandFromForDomain(domainName)

        const publicBase = (brand?.website || env('PUBLIC_API_BASE_URL', env('PUBLIC_BASE_URL', ''))).replace(/\/$/, '')
        const paymentLink = `${publicBase}/payment-capture/${encodeURIComponent(rawToken)}`

        const customerName = String(order.customer_name || 'Customer')
        const totalNumber = Number(order.total || 0)
        const currency = String(order.currency || 'GBP')

        const emailRes = await sendEmail(
          customerEmail,
          `Complete Payment - ${order.order_number}`,
          'payment_capture',
          {
            customerName,
            customerEmail,
            orderNumber: order.order_number,
            total: Number.isFinite(totalNumber) ? totalNumber : 0,
            currency,
            paymentLink,
            expiresHours: 24,
            domain: domainName,
            website: brand?.website,
            bank: {
              payeeName: 'HSA INTERPAY UK',
              sortCode: '609561',
              accountNumber: '21327124',
              reference: env('PAYMENT_REFERENCE', 'Ivms subscription'),
            },
          },
          { from: brand?.from, fromName: brand?.fromName }
        )

        if (!emailRes?.success) {
          results.push({ orderNumber, ok: false, skipped: false, error: emailRes?.error || 'Failed to send email' })
          continue
        }

        results.push({ orderNumber, ok: true, skipped: false })
      } catch (e) {
        results.push({ orderNumber, ok: false, skipped: false, error: e?.message || 'Failed' })
      }
    }

    return res.json({ success: true, results })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Bulk capture payment failed' })
  }
})

app.post('/api/admin/orders/bulk-payment-reminder', requireAuth, async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.orderNumbers) ? req.body.orderNumbers : []
    const orderNumbers = raw
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .slice(0, 500)

    if (!orderNumbers.length) return res.status(400).json({ error: 'orderNumbers array is required' })

    const results = []
    for (const orderNumber of orderNumbers) {
      try {
        const [ordersRows] = await dbQuery(
          'SELECT id, order_number, customer_email, customer_name, total, currency, domain_id FROM orders WHERE order_number = $1',
          [orderNumber]
        )
        const orders = Array.isArray(ordersRows) ? ordersRows : []
        if (!orders.length) {
          results.push({ orderNumber, ok: false, error: 'Order not found' })
          continue
        }
        const order = orders[0]

        const customerEmail = String(order.customer_email || '').trim()
        if (!customerEmail || !customerEmail.includes('@')) {
          results.push({ orderNumber, ok: false, error: 'Order has no valid customer email' })
          continue
        }

        const rawToken = randomToken()
        const tokenHash = sha256Hex(rawToken)
        const createdAt = nowMysqlDatetime()
        const expiresAt = addHoursMysql(24)

        let connection
        try {
          connection = await pool.connect()
          dbQueryConn(connection, 'BEGIN')
          await dbQueryConn(connection, 
            `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, created_at, domain_id)
              VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
            [order.id, customerEmail, tokenHash, expiresAt, createdAt, order?.domain_id ?? null]
          )
          dbQueryConn(connection, 'COMMIT')
        } catch (e) {
          if (connection) {
            try {
              dbQueryConn(connection, 'ROLLBACK')
            } catch {
              // ignore
            }
          }
          throw e
        } finally {
          if (connection) connection.release()
        }

        const domainName = await resolveDomainNameById(order?.domain_id)
        const brand = await resolveBrandFromForDomain(domainName)

        const publicBase = (brand?.website || env('PUBLIC_API_BASE_URL', env('PUBLIC_BASE_URL', ''))).replace(/\/$/, '')
        const paymentLink = `${publicBase}/payment-capture/${encodeURIComponent(rawToken)}`

        const customerName = String(order.customer_name || 'Customer')
        const totalNumber = Number(order.total || 0)
        const currency = String(order.currency || 'GBP')

        const emailRes = await sendPaymentReminderEmail(customerEmail, {
          customerName,
          customerEmail,
          orderNumber: order.order_number,
          total: Number.isFinite(totalNumber) ? totalNumber : 0,
          currency,
          paymentLink,
          expiresHours: 24,
          domain: domainName,
          website: brand?.website,
          bank: {
            payeeName: 'HSA INTERPAY UK',
            sortCode: '609561',
            accountNumber: '21327124',
            reference: env('PAYMENT_REFERENCE', 'Ivms subscription'),
          },
          from: brand?.from,
          fromName: brand?.fromName,
        })

        if (!emailRes?.success) {
          results.push({ orderNumber, ok: false, error: emailRes?.error || 'Failed to send email' })
          continue
        }

        results.push({ orderNumber, ok: true })
      } catch (e) {
        results.push({ orderNumber, ok: false, error: e?.message || 'Failed' })
      }
    }

    return res.json({ success: true, results })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Bulk payment reminder failed' })
  }
})

app.get('/api/admin/order/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const [ordersRows] = await dbQuery(
      `SELECT orders.*, d.domain_name,
        (SELECT COUNT(*) FROM payment_capture_requests pcr WHERE pcr.order_id = orders.id) AS capture_link_count
       FROM orders
       LEFT JOIN domains d ON d.id = orders.domain_id
       WHERE orders.id = $1`,
      [id]
    )
    const orders = Array.isArray(ordersRows) ? ordersRows : []
    if (!orders.length) return res.status(404).json({ error: 'Order not found' })

    const [itemsRows] = await dbQuery('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [id])
    const [paymentsRows] = await dbQuery('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [id])

    return res.json({
      order: orders[0],
      items: Array.isArray(itemsRows) ? itemsRows : [],
      payments: Array.isArray(paymentsRows) ? paymentsRows : [],
    })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch order details' })
  }
})

app.get('/api/admin/order-number/:orderNumber', requireAuth, async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim()
    if (!orderNumber) return res.status(400).json({ error: 'Invalid order number' })

    const [ordersRows] = await dbQuery(
      `SELECT orders.*, d.domain_name,
        (SELECT COUNT(*) FROM payment_capture_requests pcr WHERE pcr.order_id = orders.id) AS capture_link_count
       FROM orders
       LEFT JOIN domains d ON d.id = orders.domain_id
       WHERE orders.order_number = $1`,
      [orderNumber]
    )
    const orders = Array.isArray(ordersRows) ? ordersRows : []
    if (!orders.length) return res.status(404).json({ error: 'Order not found' })

    const id = Number(orders[0]?.id)
    if (!Number.isFinite(id)) return res.status(500).json({ error: 'Order record invalid' })

    const [itemsRows] = await dbQuery('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [id])
    const [paymentsRows] = await dbQuery('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [id])

    return res.json({
      order: orders[0],
      items: Array.isArray(itemsRows) ? itemsRows : [],
      payments: Array.isArray(paymentsRows) ? paymentsRows : [],
    })
  } catch (_e) {
    return res.status(500).json({ error: 'Failed to fetch order details' })
  }
})

app.get('/api/admin/orders/latest-by-email/:email', requireAuth, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase()
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' })

    const [ordersRows] = await dbQuery(
      'SELECT * FROM orders WHERE LOWER(customer_email) = $1 ORDER BY created_at DESC',
      [email]
    )
    const orders = Array.isArray(ordersRows) ? ordersRows : []
    if (!orders.length) return res.status(404).json({ error: 'Order not found' })

    const id = Number(orders[0]?.id)
    if (!Number.isFinite(id)) return res.status(500).json({ error: 'Order record invalid' })

    const [itemsRows] = await dbQuery('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [id])
    const [paymentsRows] = await dbQuery('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [id])

    return res.json({
      order: orders[0],
      items: Array.isArray(itemsRows) ? itemsRows : [],
      payments: Array.isArray(paymentsRows) ? paymentsRows : [],
    })
  } catch (_e) {
    return res.status(500).json({ error: 'Failed to fetch order details' })
  }
})

app.put('/api/admin/order/:id/items', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })
    const filterDomainId = await resolveAdminDomainFilter(req)

    const items = Array.isArray(req.body?.items) ? req.body.items : null
    if (!items) return res.status(400).json({ error: 'items array is required' })

    const cleaned = []
    for (const raw of items) {
      const itemId = raw?.id !== undefined && raw?.id !== null ? Number(raw.id) : null
      const name = normalizeName(raw?.name)
      const sku = normalizeSku(raw?.sku)
      const qty = Math.trunc(Number(raw?.quantity))
      const unit = toMoney(raw?.unit_price)
      if (!name) return res.status(400).json({ error: 'Item name is required' })
      if (!sku) return res.status(400).json({ error: 'Item sku is required' })
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Item quantity must be >= 1' })
      if (!Number.isFinite(unit) || unit < 0) return res.status(400).json({ error: 'Item unit_price must be >= 0' })
      cleaned.push({ id: itemId && Number.isFinite(itemId) ? itemId : null, name, sku, quantity: qty, unit_price: unit })
    }

    if (!cleaned.length) return res.status(400).json({ error: 'At least one item is required' })

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [ordersRows] = await dbQueryConn(connection, 'SELECT * FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE', [id])
    const orders = Array.isArray(ordersRows) ? ordersRows : []
    if (!orders.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }
    const order = orders[0]
    if (filterDomainId != null && order?.domain_id != null && Number(order.domain_id) !== filterDomainId) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
    }

    const [existingRows] = await dbQueryConn(connection, 'SELECT * FROM order_items WHERE order_id = $1 FOR UPDATE', [id])
    const existing = Array.isArray(existingRows) ? existingRows : []
    const existingById = new Map()
    for (const it of existing) {
      if (it && it.id !== undefined && it.id !== null) existingById.set(Number(it.id), it)
    }

    const keepIds = new Set()
    for (const it of cleaned) {
      const lineTotal = toMoney(Number(it.quantity) * Number(it.unit_price))
      if (it.id && existingById.has(it.id)) {
        keepIds.add(it.id)
        await dbQueryConn(connection, 
          'UPDATE order_items SET name = $1, sku = $2, quantity = $3, unit_price = $4, line_total = $5 WHERE id = $6 AND order_id = $7',
          [it.name, it.sku, it.quantity, it.unit_price, lineTotal, it.id, id]
        )
      } else {
        const [ins] = await dbQueryConn(connection, 
          'INSERT INTO order_items (order_id, product_id, name, sku, quantity, unit_price, line_total) VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING id',
          [id, it.name, it.sku, it.quantity, it.unit_price, lineTotal]
        )
        const newId = ins?.insertId
        if (newId) keepIds.add(Number(newId))
      }
    }

    for (const it of existing) {
      const eid = Number(it?.id)
      if (!Number.isFinite(eid)) continue
      if (!keepIds.has(eid)) {
        await dbQueryConn(connection, 'DELETE FROM order_items WHERE id = $1 AND order_id = $2', [eid, id])
      }
    }

    const [finalItemsRows] = await dbQueryConn(connection, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [id])
    const finalItems = Array.isArray(finalItemsRows) ? finalItemsRows : []

    const subtotal = toMoney(finalItems.reduce((acc, it) => acc + Number(it?.line_total || 0), 0))
    const shipping = toMoney(order?.shipping || 0)
    const promoPercent = Number(order?.promo_discount_percent ?? order?.promo_discount ?? 0)
    const safePromoPercent = Number.isFinite(promoPercent) && promoPercent > 0 ? promoPercent : 0
    const discountAmount = safePromoPercent ? toMoney(subtotal * (safePromoPercent / 100)) : toMoney(order?.discount_amount || 0)
    const total = toMoney(subtotal - discountAmount + shipping)

    await dbQueryConn(connection, 
      'UPDATE orders SET subtotal = $1, discount_amount = $2, total = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      [subtotal, discountAmount, total, id]
    )

    await dbQueryConn(connection, 
      'UPDATE payments SET amount = $1, currency = $2, updated_at = CURRENT_TIMESTAMP WHERE order_id = $3',
      [total, String(order?.currency || 'GBP'), id]
    )

    dbQueryConn(connection, 'COMMIT')

    const [orderRowsAfter] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
    const [paymentsRowsAfter] = await dbQuery('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [id])

    return res.json({
      success: true,
      order: Array.isArray(orderRowsAfter) && orderRowsAfter[0] ? orderRowsAfter[0] : order,
      items: finalItems,
      payments: Array.isArray(paymentsRowsAfter) ? paymentsRowsAfter : [],
    })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to update order items' })
  } finally {
    if (connection) connection.release()
  }
})

app.put('/api/admin/order/:id/promo', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })
    const filterDomainId = await resolveAdminDomainFilter(req)

    const promoCodeRaw = String(req.body?.promo_code || req.body?.promoCode || '').trim().toUpperCase()
    const promoMap = {
      PETER10: 10,
      PETER15: 15,
      PETER20: 20,
      DAVID10: 10,
      DAVID15: 15,
      DAVID20: 20,
      NOX10: 10,
      NOX20: 20,
      ZOEY10: 10,
      ZOEY20: 20,
      SAVE10: 10,
      SAVE20: 20,
      CHARLES99: 99,
      REFUND25: 25,
    }

    const clearPromo = !promoCodeRaw || promoCodeRaw === '-' || promoCodeRaw.toLowerCase() === 'none'
    const percent = clearPromo ? 0 : promoMap[promoCodeRaw]
    if (!clearPromo && !percent) return res.status(400).json({ error: 'Invalid promo code' })

    const hasPromoPercentCol = await columnExists('orders', 'promo_discount_percent')
    const hasPromoDiscountCol = await columnExists('orders', 'promo_discount')
    const hasPromoValidCol = await columnExists('orders', 'promo_valid')
    const hasTotalBeforeCol = await columnExists('orders', 'total_before_discount')
    const hasTotalAfterCol = await columnExists('orders', 'total_after_discount')

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 'SELECT * FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE', [id])
    const orders = Array.isArray(orderRows) ? orderRows : []
    if (!orders.length) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }

    const order = orders[0]
    if (filterDomainId != null && order?.domain_id != null && Number(order.domain_id) !== filterDomainId) {
      await dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
    }
    const subtotal = toMoney(order?.subtotal || 0)
    const shipping = toMoney(order?.shipping || 0)
    const discountAmount = percent > 0 ? toMoney(subtotal * (percent / 100)) : 0
    const total = toMoney(subtotal - discountAmount + shipping)

    const sets = []
    const values = []
    let p = 1

    sets.push(`promo_code = $${p++}`);      values.push(clearPromo ? null : promoCodeRaw)
    sets.push(`discount_amount = $${p++}`); values.push(discountAmount)
    sets.push(`total = $${p++}`);           values.push(total)
    sets.push('updated_at = CURRENT_TIMESTAMP')

    if (hasPromoPercentCol)  { sets.push(`promo_discount_percent = $${p++}`); values.push(percent) }
    if (hasPromoDiscountCol) { sets.push(`promo_discount = $${p++}`);         values.push(percent) }
    if (hasPromoValidCol)    { sets.push(`promo_valid = $${p++}`);            values.push(percent > 0) }
    if (hasTotalBeforeCol)   { sets.push(`total_before_discount = $${p++}`);  values.push(subtotal) }
    if (hasTotalAfterCol)    { sets.push(`total_after_discount = $${p++}`);   values.push(total) }

    values.push(id)

    await dbQueryConn(connection,
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${p}`,
      values
    )

    await dbQueryConn(connection,
      'UPDATE payments SET amount = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2',
      [total, id]
    )

    await dbQueryConn(connection, 'COMMIT')

    const [ordersAfter] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
    const [itemsRowsAfter] = await dbQuery('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [id])
    const [paymentsRowsAfter] = await dbQuery('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [id])

    return res.json({
      success: true,
      order: Array.isArray(ordersAfter) && ordersAfter[0] ? ordersAfter[0] : order,
      items: Array.isArray(itemsRowsAfter) ? itemsRowsAfter : [],
      payments: Array.isArray(paymentsRowsAfter) ? paymentsRowsAfter : [],
    })
  } catch (e) {
    if (connection) {
      try {
        await dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to apply promo' })
  } finally {
    if (connection) connection.release()
  }
})

app.put('/api/admin/order/:id/shipping', requireAuth, async (req, res) => {
  let connection
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })
    const filterDomainId = await resolveAdminDomainFilter(req)

    const address = normalizeAddressField(req.body?.shipping_address ?? req.body?.shippingAddress, 255)
    const city = normalizeAddressField(req.body?.shipping_city ?? req.body?.shippingCity, 120)
    const state = normalizeAddressField(req.body?.shipping_state ?? req.body?.shippingState, 120)
    const zip = normalizeAddressField(req.body?.shipping_zip ?? req.body?.shippingZip, 30)
    const country = normalizeAddressField(req.body?.shipping_country ?? req.body?.shippingCountry, 120)

    if (!address) return res.status(400).json({ error: 'shipping_address is required' })

    const hasAddressCol = await columnExists('orders', 'shipping_address')
    const hasCityCol = await columnExists('orders', 'shipping_city')
    const hasStateCol = await columnExists('orders', 'shipping_state')
    const hasZipCol = await columnExists('orders', 'shipping_zip')
    const hasCountryCol = await columnExists('orders', 'shipping_country')

    if (!hasAddressCol && !hasCityCol && !hasStateCol && !hasZipCol && !hasCountryCol) {
      return res.status(500).json({ error: 'Orders table is missing shipping fields' })
    }

    connection = await pool.connect()
    dbQueryConn(connection, 'BEGIN')

    const [orderRows] = await dbQueryConn(connection, 'SELECT * FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE', [id])
    const orders = Array.isArray(orderRows) ? orderRows : []
    if (!orders.length) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }
    if (filterDomainId != null && orders[0]?.domain_id != null && Number(orders[0].domain_id) !== filterDomainId) {
      dbQueryConn(connection, 'ROLLBACK')
      return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
    }

    const sets = ['updated_at = CURRENT_TIMESTAMP']
    const values = []

    if (hasAddressCol) {
      values.push(address)
      sets.push(`shipping_address = $${values.length}`)
    }
    if (hasCityCol) {
      values.push(city || null)
      sets.push(`shipping_city = $${values.length}`)
    }
    if (hasStateCol) {
      values.push(state || null)
      sets.push(`shipping_state = $${values.length}`)
    }
    if (hasZipCol) {
      values.push(zip || null)
      sets.push(`shipping_zip = $${values.length}`)
    }
    if (hasCountryCol) {
      values.push(country || null)
      sets.push(`shipping_country = $${values.length}`)
    }

    values.push(id)

    await dbQueryConn(connection,
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values
    )

    dbQueryConn(connection, 'COMMIT')

    const [ordersAfter] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
    const order = Array.isArray(ordersAfter) && ordersAfter[0] ? ordersAfter[0] : orders[0]
    return res.json({ success: true, order })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Failed to update shipping' })
  } finally {
    if (connection) connection.release()
  }
})

app.put('/api/admin/order/:id/payment-status', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const filterDomainId = await resolveAdminDomainFilter(req)
    if (filterDomainId != null) {
      const [domainCheckRows] = await dbQuery('SELECT domain_id FROM orders WHERE id = $1', [id])
      const existingDomainId = domainCheckRows?.[0]?.domain_id
      if (existingDomainId != null && Number(existingDomainId) !== filterDomainId) {
        return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
      }
    }

    const nextStatusRaw = String(req.body?.payment_status ?? req.body?.paymentStatus ?? '').trim().toLowerCase()
    const allowed = ['received', 'rejected']
    if (!allowed.includes(nextStatusRaw)) return res.status(400).json({ error: 'Invalid payment status' })

    const reasonRaw = String(req.body?.payment_rejection_reason ?? req.body?.paymentRejectionReason ?? '').trim()
    const reason = nextStatusRaw === 'rejected' ? (reasonRaw || 'Rejected by admin') : null

    const accountRaw = String(req.body?.bank_account_used ?? req.body?.bankAccountUsed ?? '').trim().toLowerCase()
    const allowedAccounts = new Set(['ibalticx', 'ivms'])
    const account = nextStatusRaw === 'received'
      ? (allowedAccounts.has(accountRaw) ? accountRaw : null)
      : null

    const updated = await applyAdminPaymentStatusUpdate({
      id,
      nextStatusRaw,
      reason,
      account,
      adminRemark: null,
      adminScreenshotFilename: null,
      adminScreenshotUrl: null,
    })
    return res.json({ success: true, order: updated?.order || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to update payment status' })
  }
})

// Approve payment with admin evidence (remark required, optional screenshot)
app.post(
  '/api/admin/order/:id/payment-status/evidence',
  requireAuth,
  adminUpload.single('adminPaymentScreenshot'),
  async (req, res) => {
    try {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

      const nextStatusRaw = 'received'
      const remark = String(req.body?.admin_payment_remark ?? req.body?.adminPaymentRemark ?? req.body?.remark ?? '').trim()
      if (!remark) return res.status(400).json({ error: 'admin remark is required' })

      const accountRaw = String(req.body?.bank_account_used ?? req.body?.bankAccountUsed ?? '').trim().toLowerCase()
      const allowedAccounts = new Set(['ibalticx', 'ivms'])
      const account = allowedAccounts.has(accountRaw) ? accountRaw : null

      let adminScreenshotFilename = null
      let adminScreenshotUrl = null
      if (req.file && req.file.filename) {
        adminScreenshotFilename = req.file.filename
        const proto = req.headers['x-forwarded-proto'] || req.protocol
        const host = req.get('host')
        const base = PUBLIC_BASE_URL || `${proto}://${host}`
        adminScreenshotUrl = `${String(base || '').replace(/\/$/, '')}/uploads/${encodeURIComponent(req.file.filename)}`
      }

      const updated = await applyAdminPaymentStatusUpdate({
        id,
        nextStatusRaw,
        reason: null,
        account,
        adminRemark: remark,
        adminScreenshotFilename,
        adminScreenshotUrl,
        fireAndForget: true,
      })

      return res.json({ success: true, order: updated?.order || null })
    } catch (e) {
      if (String(e?.code || '') === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Order not found' })
      return res.status(500).json({ error: e?.message || 'Failed to approve payment' })
    }
  }
)

app.use((err, _req, res, _next) => {
  const msg = String(err?.message || err || '')
  if (msg.toLowerCase().includes('multer') || msg.toLowerCase().includes('file') || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Upload failed. Please try a smaller image.' })
  }
  console.error('Unhandled error:', msg)
  return res.status(500).json({ error: 'Server error' })
})

app.put('/api/admin/order/:id/status', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const { status, trackingNumber, paymentStatus, paymentRejectionReason } = req.body || {}
    if (!status || typeof status !== 'string') return res.status(400).json({ error: 'status is required' })

    const nextStatusRaw = String(status || '').trim()
    const nextStatusLower = nextStatusRaw.toLowerCase()

    const normalizedTrackingNumber = trackingNumber !== undefined && trackingNumber !== null
      ? String(trackingNumber).replace(/\s+/g, '').trim().toUpperCase()
      : ''

    const filterDomainId = await resolveAdminDomainFilter(req)

    const [beforeRows] = await dbQuery(
      'SELECT order_number, customer_email, customer_name, shipping_address, shipping_city, shipping_state, shipping_zip, shipping_country, status AS current_status, tracking_number AS current_tracking_number, domain_id FROM orders WHERE id = $1',
      [id]
    )
    const beforeOrder = Array.isArray(beforeRows) && beforeRows[0] ? beforeRows[0] : null
    if (!beforeOrder) return res.status(404).json({ error: 'Order not found' })
    if (filterDomainId != null && beforeOrder?.domain_id != null && Number(beforeOrder.domain_id) !== filterDomainId) {
      return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
    }

    const normalizedPaymentStatus = paymentStatus !== undefined && paymentStatus !== null ? String(paymentStatus).trim().toLowerCase() : ''
    const normalizedReason = paymentRejectionReason !== undefined && paymentRejectionReason !== null
      ? String(paymentRejectionReason).trim().slice(0, 255)
      : ''

    const shouldSetReason = normalizedPaymentStatus === 'rejected'
    const shouldClearReason = ['paid', 'received', 'succeeded', 'success', 'completed', 'complete'].includes(normalizedPaymentStatus)

    if (normalizedTrackingNumber && paymentStatus) {
      await dbQuery(
        'UPDATE orders SET status = $1, tracking_number = $2, payment_status = $3, payment_rejection_reason = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5',
        [status, normalizedTrackingNumber, paymentStatus, shouldSetReason ? (normalizedReason || 'Rejected by admin') : shouldClearReason ? null : null, id]
      )
    } else if (normalizedTrackingNumber) {
      await dbQuery(
        'UPDATE orders SET status = $1, tracking_number = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [status, normalizedTrackingNumber, id]
      )
    } else if (paymentStatus) {
      await dbQuery(
        'UPDATE orders SET status = $1, payment_status = $2, payment_rejection_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
        [status, paymentStatus, shouldSetReason ? (normalizedReason || 'Rejected by admin') : shouldClearReason ? null : null, id]
      )
    } else {
      await dbQuery(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, id]
      )
    }

    const prevStatusLower = String(beforeOrder?.current_status || '').trim().toLowerCase()
    const prevTrackingNumber = String(beforeOrder?.current_tracking_number || '').replace(/\s+/g, '').trim().toUpperCase()
    const effectiveTrackingNumber = String(normalizedTrackingNumber || prevTrackingNumber || '').replace(/\s+/g, '').trim().toUpperCase()
    const shouldSendOutForDelivery =
      nextStatusLower === 'out for delivery' &&
      !!effectiveTrackingNumber &&
      (prevStatusLower !== 'out for delivery' || (!prevTrackingNumber && !!effectiveTrackingNumber) || (normalizedTrackingNumber && normalizedTrackingNumber !== prevTrackingNumber))

    console.log('[status_update] out_for_delivery decision', {
      orderId: id,
      prevStatus: prevStatusLower,
      nextStatus: nextStatusLower,
      prevTrackingNumber,
      incomingTrackingNumber: normalizedTrackingNumber,
      effectiveTrackingNumber,
      shouldSendOutForDelivery,
    })

    if (shouldSendOutForDelivery) {
      const customerEmail = String(beforeOrder?.customer_email || '').trim()
      if (customerEmail && customerEmail.includes('@')) {
        const orderData = {
          customerEmail,
          customerName: String(beforeOrder?.customer_name || '').trim() || 'there',
          orderNumber: String(beforeOrder?.order_number || '').trim(),
          shippingAddress: String(beforeOrder?.shipping_address || '').trim(),
          shippingCity: String(beforeOrder?.shipping_city || '').trim(),
          shippingState: String(beforeOrder?.shipping_state || '').trim(),
          shippingZip: String(beforeOrder?.shipping_zip || '').trim(),
          shippingCountry: String(beforeOrder?.shipping_country || '').trim(),
        }
        try {
          console.log('[status_update] sending out_for_delivery email', {
            orderId: id,
            orderNumber: orderData.orderNumber,
            to: customerEmail,
            trackingNumber: effectiveTrackingNumber,
            prevStatus: prevStatusLower,
            nextStatus: nextStatusLower,
          })
          const emailRes = await sendOutForDeliveryEmail(orderData, effectiveTrackingNumber)
          if (!emailRes?.success) {
            console.error('[status_update] out_for_delivery email provider returned failure', {
              orderId: id,
              orderNumber: orderData.orderNumber,
              to: customerEmail,
              trackingNumber: effectiveTrackingNumber,
              error: emailRes?.error || 'unknown error',
            })
          }
        } catch (e) {
          console.error('[status_update] failed to send out_for_delivery email', {
            orderId: id,
            orderNumber: orderData.orderNumber,
            to: customerEmail,
            trackingNumber: effectiveTrackingNumber,
            error: e?.message || e,
          })
        }
      }
    }

    const [ordersAfter] = await dbQuery('SELECT * FROM orders WHERE id = $1', [id])
    const order = Array.isArray(ordersAfter) && ordersAfter[0] ? ordersAfter[0] : null
    return res.json({ success: true, order })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update order status' })
  }
})

app.delete('/api/admin/order/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' })

    const filterDomainId = await resolveAdminDomainFilter(req)
    if (filterDomainId != null) {
      const [domainCheckRows] = await dbQuery('SELECT domain_id FROM orders WHERE id = $1', [id])
      const existingDomainId = domainCheckRows?.[0]?.domain_id
      if (existingDomainId != null && Number(existingDomainId) !== filterDomainId) {
        return res.status(409).json({ error: 'domain_mismatch', message: 'This order belongs to a different domain.' })
      }
    }

    // order_items + payments are expected to cascade via FK constraints.
    const [result] = await dbQuery('DELETE FROM orders WHERE id = $1', [id])
    const affected = result?.affectedRows || 0
    if (!affected) return res.status(404).json({ error: 'Order not found' })

    return res.json({ success: true })
  } catch (_e) {
    return res.status(500).json({ error: 'Failed to delete order' })
  }
})

// Capture Payment: Admin triggers email with a single-use token link to payment page.
app.post('/api/admin/orders/:orderNumber/capture-payment', requireAuth, async (req, res) => {
  let connection
  try {
    const orderNumber = String(req.params.orderNumber || '').trim()
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })

    const [ordersRows] = await dbQuery('SELECT id, order_number, customer_email, customer_name, total, currency, domain_id FROM orders WHERE order_number = $1', [orderNumber])
    const orders = Array.isArray(ordersRows) ? ordersRows : []
    if (!orders.length) return res.status(404).json({ error: 'Order not found' })
    const order = orders[0]

    const customerEmail = String(order.customer_email || '').trim()
    if (!customerEmail || !customerEmail.includes('@')) return res.status(400).json({ error: 'Order has no valid customer email' })

    const rawToken = randomToken()
    const tokenHash = sha256Hex(rawToken)
    const createdAt = nowMysqlDatetime()
    const expiresAt = addHoursMysql(24)

    connection = await pool.connect()
    await dbQueryConn(connection, 'BEGIN')

    await dbQueryConn(connection,
      `INSERT INTO payment_capture_requests (order_id, email, token_hash, expires_at, used_at, created_at, domain_id)
        VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
      [order.id, customerEmail, tokenHash, expiresAt, createdAt, order?.domain_id ?? null]
    )

    await dbQueryConn(connection, 'COMMIT')

    const domainName = await resolveDomainNameById(order?.domain_id)
    const brand = await resolveBrandFromForDomain(domainName)

    const publicBase = (brand?.website || env('PUBLIC_API_BASE_URL', env('PUBLIC_BASE_URL', ''))).replace(/\/$/, '')
    const paymentLink = `${publicBase}/payment-capture/${encodeURIComponent(rawToken)}`

    const customerName = String(order.customer_name || 'Customer')
    const totalNumber = Number(order.total || 0)
    const currency = String(order.currency || 'GBP')

    const emailRes = await sendEmail(
      customerEmail,
      `${brand?.fromName || domainName || 'Store'} payment request for order ${order.order_number}`,
      'payment_capture',
      {
        customerName,
        customerEmail,
        orderNumber: order.order_number,
        total: Number.isFinite(totalNumber) ? totalNumber : 0,
        currency,
        paymentLink,
        expiresHours: 24,
        domain: domainName,
        website: brand?.website,
        bank: {
          payeeName: env('PAYMENT_PAYEE_NAME', '1066 Detailing Ltd'),
          sortCode: env('PAYMENT_SORT_CODE', '60-83-82'),
          accountNumber: env('PAYMENT_ACCOUNT_NUMBER', '46672542'),
          reference: env('PAYMENT_REFERENCE', 'Beauty'),
        },
      },
      { from: brand?.from, fromName: brand?.fromName }
    )

    if (!emailRes?.success) {
      return res.status(500).json({ error: emailRes?.error || 'Failed to send email' })
    }

    return res.json({ success: true })
  } catch (e) {
    if (connection) {
      try {
        dbQueryConn(connection, 'ROLLBACK')
      } catch {
        // ignore
      }
    }
    return res.status(500).json({ error: e?.message || 'Capture payment failed' })
  } finally {
    if (connection) connection.release()
  }
})

// New requirement: never email accounts@ivmsgroup.com; use iBalticX invoice template.
app.post('/api/admin/orders/:orderNumber/resend-has-invoice', requireAuth, async (req, res) => {
  try {
    return res.status(410).json({ error: 'HAS/IVMS invoice emails are disabled' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to resend invoice email' })
  }
})

// Resend OLD HAS Invoice: same template, but with legacy LHAS bank details.
app.post('/api/admin/orders/:orderNumber/resend-old-has-invoice', requireAuth, async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim()
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })

    const [rows] = await dbQuery(
      `SELECT
        id,
        order_number,
        customer_name,
        customer_phone,
        shipping_address,
        shipping_city,
        shipping_zip,
        shipping_country,
        submitted_at,
        reserved_at,
        created_at,
        total,
        currency,
        promo_code,
        discount_amount,
        promo_discount_percent
      FROM orders
      WHERE order_number = $1
     `,
      [orderNumber]
    )

    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return res.status(404).json({ error: 'Order not found' })
    const order = list[0]

    const toDate = (value) => {
      if (!value) return null
      if (value instanceof Date) return value
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }

    const [payRows] = await dbQuery(
      `SELECT COALESCE(updated_at, created_at) AS payment_date
       FROM payments
       WHERE order_id = $1
         AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')
       ORDER BY COALESCE(updated_at, created_at) DESC
      `,
      [Number(order.id)]
    )
    const payList = Array.isArray(payRows) ? payRows : []
    const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null
    if (!paymentDate) return res.status(400).json({ error: 'No successful payment date found for this order' })

    const invoiceDate = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(paymentDate || new Date())

    const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'
    const customerPhone = String(order?.customer_phone || '').trim()
    const customerAddressLine1 = String(order?.shipping_address || '').trim()
    const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(', ')

    const invoiceTotal = Number(order?.total || 0)
    const invoiceNumberRaw = `INV-${String(order?.order_number || orderNumber).trim() || Date.now()}`
    const invoiceNumber = String(invoiceNumberRaw)
      .replace(/^INV-ALU-/i, 'INV-')
      .replace(/^INV-ALU/i, 'INV-')

    let orderItems = []
    try {
      const [itemRows] = await dbQuery(
        'SELECT name, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id ASC',
        [order.id]
      )
      orderItems = Array.isArray(itemRows) ? itemRows : []
    } catch {
      orderItems = []
    }

    const promoDiscountPercent = Number(order?.promo_discount_percent || 0)
    const promoCode = String(order?.promo_code || '').trim()
    const discountAmount = Number(order?.discount_amount || 0)
    const masked = buildHasInvoiceMaskedItems({
      orderItems,
      promoDiscountPercent,
      expectedTotal: invoiceTotal,
    })

    const baseUrl = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || env('PUBLIC_BASE_URL', '')).replace(/\/$/, '')

    const invoicePayload = {
      logoUrl: `${baseUrl}/images/hsalogo.png`,
      invoiceDate,
      invoiceNumber,
      billToName: customerDisplayName,
      billToAddressLine1: customerAddressLine1,
      billToAddressLine2: customerAddressLine2,
      billToNumber: customerPhone,
      items: masked.items,
      total: masked.total,
      subtotal: masked.subtotal,
      currency: String(order?.currency || 'GBP'),
      promoCode: promoCode && promoCode !== '-' ? promoCode : '',
      promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
      bank: {
        payeeName: 'HSA INTERPAY UK',
        accountNumber: '21327124',
        sortCode: '609561',
        reference: 'ivms software subscription',
      },
    }

    const recipients = ['its.me.rushil2002@gmail.com']
    const results = []
    for (const to of recipients) {
      try {
        const r = await sendHasInvoiceEmail(to, invoicePayload)
        results.push({ to, success: !!r?.success, messageId: r?.messageId || null, error: r?.error || null })
      } catch (err) {
        results.push({ to, success: false, messageId: null, error: err?.message || 'Failed' })
      }
    }

    const ok = results.some((r) => r.success)
    if (!ok) {
      const firstErr = results.find((r) => !r.success)?.error || 'Failed to send invoice email'
      return res.status(502).json({ error: firstErr, results })
    }

    return res.json({ success: true, results })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to resend old invoice email' })
  }
})

// Send HAS invoice to an arbitrary email (Postman/testing). Same template and logic as resend-has-invoice.
// Allows choosing bank variant: "current" (env PAYMENT_*) or "old" (LHAS).
app.post('/api/admin/orders/:orderNumber/send-has-invoice-to', requireAuth, async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim()
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })

    const baseUrl = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '')

    const to = String(req.body?.to || '').trim()
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid to email is required' })
    if (String(to).trim().toLowerCase() === 'accounts@ivmsgroup.com') {
      return res.status(400).json({ error: 'Sending to this recipient is not allowed' })
    }

    const bankVariantRaw = String(req.body?.bankVariant || 'current').trim().toLowerCase()
    const bankVariant = bankVariantRaw === 'old' ? 'old' : 'current'

    const [rows] = await dbQuery(
      `SELECT
        id,
        order_number,
        customer_name,
        customer_phone,
        shipping_address,
        shipping_city,
        shipping_zip,
        shipping_country,
        submitted_at,
        reserved_at,
        created_at,
        total,
        currency,
        promo_code,
        discount_amount,
        promo_discount_percent
      FROM orders
      WHERE order_number = $1
     `,
      [orderNumber]
    )

    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return res.status(404).json({ error: 'Order not found' })
    const order = list[0]

    const toDate = (value) => {
      if (!value) return null
      if (value instanceof Date) return value
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? null : d
    }

    const [payRows] = await dbQuery(
      `SELECT COALESCE(updated_at, created_at) AS payment_date
       FROM payments
       WHERE order_id = $1
         AND LOWER(status) IN ('received', 'paid', 'success', 'succeeded', 'completed')
       ORDER BY COALESCE(updated_at, created_at) DESC
      `,
      [Number(order.id)]
    )
    const payList = Array.isArray(payRows) ? payRows : []
    const paymentDate = payList.length ? toDate(payList[0]?.payment_date) : null
    if (!paymentDate) return res.status(400).json({ error: 'No successful payment date found for this order' })

    const invoiceDate = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(paymentDate || new Date())

    const customerDisplayName = String(order?.customer_name || '').trim() || 'Customer'
    const customerPhone = String(order?.customer_phone || '').trim()
    const customerAddressLine1 = String(order?.shipping_address || '').trim()
    const customerAddressLine2 = [order?.shipping_city, order?.shipping_zip, order?.shipping_country]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(', ')

    const invoiceTotal = Number(order?.total || 0)
    const invoiceNumberRaw = `INV-${String(order?.order_number || orderNumber).trim() || Date.now()}`
    const invoiceNumber = String(invoiceNumberRaw)
      .replace(/^INV-ALU-/i, 'INV-')
      .replace(/^INV-ALU/i, 'INV-')

    let orderItems = []
    try {
      const [itemRows] = await dbQuery(
        'SELECT name, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY id ASC',
        [order.id]
      )
      orderItems = Array.isArray(itemRows) ? itemRows : []
    } catch {
      orderItems = []
    }

    const promoDiscountPercent = Number(order?.promo_discount_percent || 0)
    const promoCode = String(order?.promo_code || '').trim()
    const discountAmount = Number(order?.discount_amount || 0)
    const masked = buildHasInvoiceMaskedItems({
      orderItems,
      promoDiscountPercent,
      expectedTotal: invoiceTotal,
    })

    const bank =
      bankVariant === 'old'
        ? {
            payeeName: 'HSA INTERPAY UK',
            accountNumber: '21327124',
            sortCode: '609561',
            reference: 'ivms software subscription',
          }
        : {
            payeeName: 'HSA INTERPAY UK',
            sortCode: '609561',
            accountNumber: '21327124',
            reference: 'ivms software subscription',
          }

    const out = await sendHasInvoiceEmail(to, {
      logoUrl: `${baseUrl}/images/hsalogo.png`,
      invoiceDate,
      invoiceNumber,
      billToName: customerDisplayName,
      billToAddressLine1: customerAddressLine1,
      billToAddressLine2: customerAddressLine2,
      billToNumber: customerPhone,
      items: masked.items,
      total: masked.total,
      subtotal: masked.subtotal,
      currency: String(order?.currency || 'GBP'),
      promoCode: promoCode && promoCode !== '-' ? promoCode : '',
      promoDiscountPercent: Number.isFinite(promoDiscountPercent) ? promoDiscountPercent : 0,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
      bank,
    })

    if (!out?.success) return res.status(502).json({ error: out?.error || 'Failed to send invoice email' })

    return res.json({ success: true, messageId: out?.messageId || null, to, bankVariant })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to send invoice email' })
  }
})

app.post('/api/admin/send-has-invoice', requireAuth, async (req, res) => {
  return res.status(410).json({ error: 'This endpoint is disabled.' })
})

async function ensureProductConfigTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS product_config (
        id SERIAL PRIMARY KEY,
        product_id VARCHAR(100) NOT NULL UNIQUE,
        product_name VARCHAR(200) NOT NULL,
        product_sku VARCHAR(100) NOT NULL,
        klyme_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('✅ Product config table ensured')
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.toLowerCase().includes('already exists')) return
    console.error('Failed to ensure product_config table:', msg)
  }
}

async function insertProductConfigData() {
  try {
    // Current products from frontend
    const currentProducts = [
      { id: 'glow-70mg', name: 'Glow 70mg (R&D Only)', sku: 'GLOW-70MG' },
      { id: 'bpc-157-tb-500-40mg', name: 'BPC-157 & TB-500 40mg (R&D Only)', sku: 'BPC-TB-40MG' },
      { id: 'retatrutide-20mg', name: 'Retatrutide 20mg (R&D Only)', sku: 'RETAT-20MG' },
      { id: 'retatrutide-40mg', name: 'Retatrutide 40mg (R&D Only)', sku: 'RETAT-40MG' },
      { id: 'bundle-retatrutide-20mg-x2', name: 'Retatrutide 20mg (R&D Only) X 2', sku: 'BUNDLED-RETAT-20MG-X2' },
      { id: 'bundle-retatrutide-40mg-x2', name: 'Retatrutide 40mg (R&D Only) X 2', sku: 'BUNDLED-RETAT-40MG-X2' },
      { id: 'tirzepatide-40mg', name: 'Tirzepatide 40mg (R&D Only)', sku: 'TIRZ-40MG' },
      { id: 'nad-plus-1000mg', name: 'NAD+ 1,000mg', sku: 'NAD-1000MG' },
      { id: 'test-product', name: 'Test Product (Dummy)', sku: 'TEST-GBP1' }
    ];

    for (const product of currentProducts) {
      try {
        await dbQuery(
          'INSERT INTO product_config (product_id, product_name, product_sku, klyme_enabled) VALUES ($1, $2, $3, $4) ON CONFLICT (product_name, country) DO NOTHING, product_sku = VALUES(product_sku)',
          [product.id, product.name, product.sku, false]
        );
        console.log(`✅ Product config ensured: ${product.name} (${product.id})`);
      } catch (e) {
        console.log(`⚠️  Could not ensure product config ${product.id}:`, e?.message || e);
      }
    }
    console.log('✅ Product config data insertion completed');
  } catch (e) {
    console.error('Failed to insert product config data:', e);
  }
}

async function ensureCustomerBlacklistTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS customer_blacklist (
        id SERIAL PRIMARY KEY,
        email_lower VARCHAR(255) NULL,
        address_key VARCHAR(512) NULL,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('✅ Customer blacklist table ensured')
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.toLowerCase().includes('already exists')) return
    console.error('Failed to ensure customer_blacklist table:', msg)
  }
}

async function ensurePaymentCaptureEmailTrackingColumns() {
  const isMissingTable = (err) => {
    const code = String(err?.code || '').toUpperCase()
    const msg = String(err?.message || '').toLowerCase()
    return code === 'ER_NO_SUCH_TABLE' || code === '42P01' || msg.includes("doesn't exist") || msg.includes('does not exist') || msg.includes('no such table')
  }

  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  try {
    await dbQuery('ALTER TABLE payment_capture_requests ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMP NULL')
  } catch (e) {
    if (!isDuplicate(e) && !isMissingTable(e)) {
      console.error('Failed to ensure payment_capture_requests.email_sent_at:', e?.message || String(e))
    }
  }

  try {
    await dbQuery('ALTER TABLE payment_capture_requests ADD COLUMN IF NOT EXISTS email_send_error VARCHAR(255) NULL')
  } catch (e) {
    if (!isDuplicate(e) && !isMissingTable(e)) {
      console.error('Failed to ensure payment_capture_requests.email_send_error:', e?.message || String(e))
    }
  }
}

async function ensureUsersTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        phone VARCHAR(64) NULL,
        date_of_birth DATE NULL,
        nationality VARCHAR(100) NULL,
        country_of_residence VARCHAR(100) NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'user',
        klyme_restricted SMALLINT NOT NULL DEFAULT 0,
        last_login TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure users table:', msg)
    }
  }
}

async function seedUsersFromSql() {
  const sqlPath = path.resolve(__dirname, '..', '..', 'alluviruss_with_create_db.sql')
  if (!fs.existsSync(sqlPath)) {
    console.log('[seed] SQL file not found at', sqlPath, '— skipping user seed')
    return
  }

  try {
    const content = fs.readFileSync(sqlPath, 'utf8')

    // Extract the INSERT INTO `users` VALUES block
    const insertMatch = content.match(/INSERT INTO `users` VALUES\s*\n?([\s\S]*?);/)
    if (!insertMatch) {
      console.log('[seed] No INSERT INTO users found in SQL file — skipping')
      return
    }

    const valuesBlock = insertMatch[1]

    // Parse MySQL value tuples, handling escaped quotes like O\'Connor
    function parseMysqlString(str, pos) {
      // pos should be at the opening quote
      if (str[pos] !== "'") return null
      let result = ''
      let i = pos + 1
      while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length) {
          result += str[i + 1]
          i += 2
        } else if (str[i] === "'") {
          return { value: result, end: i + 1 }
        } else {
          result += str[i]
          i++
        }
      }
      return null
    }

    function parseValue(str, pos) {
      // Skip whitespace
      while (pos < str.length && (str[pos] === ' ' || str[pos] === '\t' || str[pos] === '\n' || str[pos] === '\r')) pos++
      if (str.substr(pos, 4) === 'NULL') {
        return { value: null, end: pos + 4 }
      }
      if (str[pos] === "'") {
        return parseMysqlString(str, pos)
      }
      // Numeric value
      let numStr = ''
      while (pos < str.length && str[pos] !== ',' && str[pos] !== ')') {
        numStr += str[pos]
        pos++
      }
      return { value: numStr.trim(), end: pos }
    }

    const users = []
    let i = 0
    while (i < valuesBlock.length) {
      if (valuesBlock[i] === '(') {
        i++ // skip (
        const fields = []
        while (fields.length < 12) {
          const parsed = parseValue(valuesBlock, i)
          if (!parsed) break
          fields.push(parsed.value)
          i = parsed.end
          // skip comma or closing paren
          if (valuesBlock[i] === ',') i++
        }
        // skip closing paren
        if (valuesBlock[i] === ')') i++

        if (fields.length === 12) {
          users.push({
            id: parseInt(fields[0], 10),
            name: fields[1],
            email: fields[2],
            password_hash: fields[3],
            phone: fields[4],
            date_of_birth: fields[5],
            nationality: fields[6],
            country_of_residence: fields[7],
            role: fields[8],
            created_at: fields[9],
            updated_at: fields[10],
            last_login: fields[11],
          })
        }
      } else {
        i++
      }
    }

    if (users.length === 0) {
      console.log('[seed] No user rows parsed from SQL file — skipping')
      return
    }

    // Check how many users already exist
    const [existing] = await dbQuery('SELECT COUNT(*) as cnt FROM users')
    const existingCount = existing[0]?.cnt || 0

    if (existingCount >= users.length) {
      console.log(`[seed] Database already has ${existingCount} users (>= ${users.length} in SQL) — skipping seed`)
      return
    }

    console.log(`[seed] Seeding ${users.length} users from SQL file (${existingCount} already in DB)...`)

    let inserted = 0
    let skipped = 0
    for (const u of users) {
      try {
        const [result] = await dbQuery(
          `INSERT INTO users (id, name, email, password_hash, phone, date_of_birth, nationality, country_of_residence, role, created_at, updated_at, last_login)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
          [u.id, u.name, u.email, u.password_hash, u.phone, u.date_of_birth, u.nationality, u.country_of_residence, u.role, u.created_at, u.updated_at, u.last_login]
        )
        if (result.affectedRows > 0) inserted++
        else skipped++
      } catch (e) {
        // Skip duplicates or other insert errors for individual rows
        skipped++
      }
    }

    console.log(`[seed] Done — inserted: ${inserted}, skipped (already exist): ${skipped}`)
  } catch (e) {
    console.error('[seed] Failed to seed users from SQL file:', e?.message || String(e))
  }
}

async function ensureUserAddressesTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL NOT NULL,
        user_id INT NOT NULL,
        address_line1 VARCHAR(255) NOT NULL,
        city VARCHAR(100) DEFAULT NULL,
        postcode VARCHAR(20) DEFAULT NULL,
        country VARCHAR(100) DEFAULT NULL,
        is_default SMALLINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT fk_user_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure user_addresses table:', msg)
    }
  }

  // Fix column name mismatch: older schema used postal_code, production uses postcode
  try {
    await dbQuery('ALTER TABLE user_addresses RENAME COLUMN postal_code TO postcode')
  } catch {
    // column already named postcode, or doesn't exist — either is fine
  }
}

async function ensureAdminUsersTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(120) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'admin',
        is_active SMALLINT NOT NULL DEFAULT 1,
        last_login TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure admin_users table:', msg)
    }
  }

  // First-run bootstrap: if the table is empty, seed a single admin from env vars.
  // No hardcoded fallback — if the env vars are not set, login will be unavailable
  // until an admin row is inserted manually or the env vars are provided.
  try {
    const [rows] = await dbQuery('SELECT COUNT(*) AS count FROM admin_users')
    const count = Number(rows?.[0]?.count || 0)
    if (count > 0) return

    const seedUsername = env('ADMIN_SEED_USERNAME', '').trim()
    const seedEmail = env('ADMIN_SEED_EMAIL', '').trim()
    const seedPassword = env('ADMIN_SEED_PASSWORD', '')
    if (!seedUsername || !seedEmail || !seedPassword) {
      console.warn('admin_users table is empty. Set ADMIN_SEED_USERNAME, ADMIN_SEED_EMAIL, and ADMIN_SEED_PASSWORD env vars to seed the first admin user, or insert one manually.')
      return
    }

    const passwordHash = await bcrypt.hash(seedPassword, 10)
    await dbQuery(
      `INSERT INTO admin_users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'admin', 1)`,
      [seedUsername, seedEmail, passwordHash]
    )
    console.log(`Seeded initial admin user "${seedUsername}" from env vars`)
  } catch (e) {
    console.error('Failed to seed initial admin user:', e?.message || String(e))
  }
}

async function ensureOrdersTable() {
  const isDuplicate = (err) => {
    const msg = String(err?.message || '').toLowerCase()
    return msg.includes('duplicate') || msg.includes('exists')
  }

  const addCol = async (sql) => {
    try { await dbQuery(sql) } catch (e) { if (!isDuplicate(e)) { /* column may already exist */ } }
  }

  // Full production schema matching alluviruss_with_create_db.sql
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL NOT NULL,
        order_number VARCHAR(64) NOT NULL,
        user_id INT DEFAULT NULL,
        customer_email VARCHAR(150) NOT NULL,
        customer_name VARCHAR(150) DEFAULT NULL,
        customer_phone VARCHAR(50) DEFAULT NULL,
        shipping_address VARCHAR(255) DEFAULT NULL,
        shipping_city VARCHAR(100) DEFAULT NULL,
        shipping_state VARCHAR(100) DEFAULT NULL,
        shipping_zip VARCHAR(20) DEFAULT NULL,
        shipping_country VARCHAR(100) DEFAULT NULL,
        tracking_number VARCHAR(255) DEFAULT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'GBP',
        subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        shipping DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        payment_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        payment_method VARCHAR(50) DEFAULT 'Manual',
        promo_code VARCHAR(50) DEFAULT NULL,
        promo_discount DECIMAL(5,2) DEFAULT NULL,
        discount_amount DECIMAL(10,2) DEFAULT NULL,
        payment_rejection_reason VARCHAR(255) DEFAULT NULL,
        admin_payment_remark TEXT,
        admin_payment_screenshot_filename VARCHAR(255) DEFAULT NULL,
        admin_payment_screenshot_url VARCHAR(512) DEFAULT NULL,
        ibalticx_invoice_sent_at TIMESTAMP DEFAULT NULL,
        ibalticx_invoice_to VARCHAR(255) DEFAULT NULL,
        ibalticx_invoice_message_id VARCHAR(255) DEFAULT NULL,
        bank_account_used VARCHAR(100) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_before_discount DECIMAL(10,2) DEFAULT NULL,
        total_after_discount DECIMAL(10,2) DEFAULT NULL,
        promo_discount_percent DECIMAL(5,2) DEFAULT NULL,
        promo_valid SMALLINT DEFAULT 0,
        items_text TEXT,
        payment_screenshot_filename VARCHAR(255) DEFAULT NULL,
        payment_screenshot_url TEXT,
        reserved_at TIMESTAMP DEFAULT NULL,
        submitted_at TIMESTAMP DEFAULT NULL,
        credits_applied DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total_before_credits DECIMAL(12,2) DEFAULT NULL,
        credits_reserved DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        PRIMARY KEY (id),
        CONSTRAINT order_number UNIQUE (order_number)
      )
    `)
  } catch (e) {
    if (!isDuplicate(e)) {
      console.error('Failed to ensure orders table:', e?.message || String(e))
    }
  }

  // Ensure all columns exist (for tables created with older/simpler schema)
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INT DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_state VARCHAR(100) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping DECIMAL(10,2) NOT NULL DEFAULT 0.00')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount DECIMAL(5,2) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_before_discount DECIMAL(10,2) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_after_discount DECIMAL(10,2) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount_percent DECIMAL(5,2) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_valid SMALLINT DEFAULT 0')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_text TEXT')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot_filename VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_reserved DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_applied DECIMAL(12,2) NOT NULL DEFAULT 0.00')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_before_credits DECIMAL(12,2) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_rejection_reason VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_remark TEXT')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_screenshot_filename VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_payment_screenshot_url VARCHAR(512) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_sent_at TIMESTAMP DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_to VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ibalticx_invoice_message_id VARCHAR(255) DEFAULT NULL')
  await addCol('ALTER TABLE orders ADD COLUMN IF NOT EXISTS bank_account_used VARCHAR(100) DEFAULT NULL')

  // Ensure order_items table exists
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL NOT NULL,
        order_id INT NOT NULL,
        product_id INT DEFAULT NULL,
        name VARCHAR(150) NOT NULL,
        sku VARCHAR(100) NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        line_total DECIMAL(10,2) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        CONSTRAINT fk_oi_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      )
    `)
  } catch (e) {
    if (!isDuplicate(e)) {
      console.error('Failed to ensure order_items table:', e?.message || String(e))
    }
  }
}

// ─── Missing core tables (matching alluviruss_with_create_db.sql) ────────────

async function ensureProductsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL NOT NULL,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(180) NOT NULL,
        sku VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'GBP',
        in_stock SMALLINT NOT NULL DEFAULT 1,
        stock_qty INT DEFAULT NULL,
        image_url VARCHAR(500) DEFAULT NULL,
        image_alt VARCHAR(255) DEFAULT NULL,
        lab_test_url VARCHAR(500) DEFAULT NULL,
        short_desc VARCHAR(255) DEFAULT NULL,
        long_desc TEXT,
        details_contents TEXT,
        details_storage TEXT,
        details_delivery TEXT,
        is_enabled SMALLINT NOT NULL DEFAULT 1,
        display_order INT NOT NULL DEFAULT 0,
        klyme_enabled SMALLINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT slug UNIQUE (slug),
        CONSTRAINT sku UNIQUE (sku)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure products table:', msg)
    }
  }
}

async function ensurePaymentsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL NOT NULL,
        order_id INT NOT NULL,
        user_id INT DEFAULT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'Manual',
        provider_id VARCHAR(128) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'GBP',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        webhook_received SMALLINT DEFAULT 0,
        final_status VARCHAR(50) DEFAULT NULL,
        status_checked_at TIMESTAMP NULL DEFAULT NULL,
        bank_name VARCHAR(255) DEFAULT NULL,
        raw_response JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT uq_payment_provider_id UNIQUE (provider, provider_id),
        CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure payments table:', msg)
    }
  }
}

async function ensurePaymentCaptureRequestsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS payment_capture_requests (
        id BIGSERIAL,
        order_id BIGINT NOT NULL,
        email VARCHAR(255) DEFAULT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP DEFAULT NULL,
        email_sent_at TIMESTAMP DEFAULT NULL,
        email_send_error VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uniq_token_hash UNIQUE (token_hash)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure payment_capture_requests table:', msg)
    }
  }
}

async function ensureOrderAddressChangeRequestsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS order_address_change_requests (
        id SERIAL NOT NULL,
        order_id INT DEFAULT NULL,
        order_number VARCHAR(60) DEFAULT NULL,
        customer_email VARCHAR(150) NOT NULL,
        current_shipping_json TEXT,
        requested_shipping_json TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        admin_id INT DEFAULT NULL,
        admin_note VARCHAR(255) DEFAULT NULL,
        decided_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (id)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure order_address_change_requests table:', msg)
    }
  }
}

async function ensureShippingLabelsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS shipping_labels (
        id SERIAL NOT NULL,
        tracking_number VARCHAR(40) DEFAULT NULL,
        customer_ref VARCHAR(80) DEFAULT NULL,
        recipient_name VARCHAR(160) DEFAULT NULL,
        address_text TEXT,
        postcode VARCHAR(20) DEFAULT NULL,
        service_name VARCHAR(80) DEFAULT NULL,
        postage_cost DECIMAL(10,2) DEFAULT NULL,
        postage_currency VARCHAR(10) DEFAULT NULL,
        label_date VARCHAR(40) DEFAULT NULL,
        source_filename VARCHAR(255) DEFAULT NULL,
        raw_text TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT uniq_tracking_number UNIQUE (tracking_number)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure shipping_labels table:', msg)
    }
  }
}

async function ensurePasswordResetTokensTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL,
        user_id INT NOT NULL,
        token VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT uq_password_reset_token UNIQUE (token),
        CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure password_reset_tokens table:', msg)
    }
  }
}

async function ensurePaymentSessionsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS payment_sessions (
        id SERIAL NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        order_id INT DEFAULT NULL,
        payment_provider_id VARCHAR(255) DEFAULT NULL,
        customer_email VARCHAR(255) DEFAULT NULL,
        customer_name VARCHAR(255) DEFAULT NULL,
        order_data JSON DEFAULT NULL,
        payment_url VARCHAR(500) DEFAULT NULL,
        success_url VARCHAR(500) DEFAULT NULL,
        failure_url VARCHAR(500) DEFAULT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        CONSTRAINT session_id UNIQUE (session_id),
        CONSTRAINT fk_payment_sessions_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure payment_sessions table:', msg)
    }
  }
}

async function ensureEmailNotificationsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS email_notifications (
        id SERIAL NOT NULL,
        order_id INT DEFAULT NULL,
        payment_session_id VARCHAR(255) DEFAULT NULL,
        email_type VARCHAR(50) NOT NULL,
        recipient_email VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        sent_at TIMESTAMP NULL DEFAULT NULL,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT fk_email_notifications_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure email_notifications table:', msg)
    }
  }
}

async function ensureWebhookLogsTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'Manual',
        event_type VARCHAR(100) DEFAULT NULL,
        payload JSON DEFAULT NULL,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure webhook_logs table:', msg)
    }
  }
}

async function ensureWholesaleInquiriesTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS wholesale_inquiries (
        id SERIAL NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT '',
        email VARCHAR(255) NOT NULL,
        contact VARCHAR(64) NOT NULL,
        quantity VARCHAR(64) NOT NULL,
        country VARCHAR(128) NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure wholesale_inquiries table:', msg)
    }
  }
  // Migrate existing tables that were created before the name column was added.
  try {
    await dbQuery('ALTER TABLE wholesale_inquiries ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL DEFAULT \'\'')
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('duplicate column')) {
      console.error('Failed to ensure wholesale_inquiries.name:', msg)
    }
  }
}

async function ensureNewsletterSubscribersTable() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id SERIAL NOT NULL,
        email VARCHAR(255) NOT NULL,
        consent SMALLINT NOT NULL DEFAULT 0,
        source VARCHAR(64) NOT NULL DEFAULT 'home_popup_reta',
        ip_address VARCHAR(45),
        user_agent VARCHAR(512),
        is_winner SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT uniq_newsletter_email_source UNIQUE (email, source)
      )
    `)
  } catch (e) {
    const msg = String(e?.message || e)
    if (!msg.toLowerCase().includes('already exists')) {
      console.error('Failed to ensure newsletter_subscribers table:', msg)
    }
  }
}

// ─── Newsletter admin endpoints ─────────────────────────────────────────────

app.get('/api/admin/newsletter', requireAuth, async (req, res) => {
  try {
    await ensureNewsletterSubscribersTable()
    const q = String(req.query.q || '').trim()
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500)
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0)

    const where = []
    const params = []
    if (q) {
      where.push('email LIKE $1')
      params.push(`%${q}%`)
    }
    if (from) {
      where.push('created_at >= $1')
      params.push(from.length === 10 ? `${from} 00:00:00` : from)
    }
    if (to) {
      where.push('created_at <= $1')
      params.push(to.length === 10 ? `${to} 23:59:59` : to)
    }
    const domainId = await resolveAdminDomainFilter(req)
    if (domainId != null) {
      params.push(domainId)
      where.push(`domain_id = $${params.length}`)
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [countRows] = await dbQuery(
      `SELECT COUNT(*) AS total FROM newsletter_subscribers ${whereClause}`,
      params
    )
    const total = Number(countRows?.[0]?.total || 0)

    const [rows] = await dbQuery(
      `SELECT id, email, consent, source, ip_address, user_agent, is_winner, created_at
       FROM newsletter_subscribers
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    )

    return res.json({ items: rows, total })
  } catch (e) {
    console.error('GET /api/admin/newsletter failed:', e?.message || e)
    return res.status(500).json({ error: 'Failed to load newsletter subscribers' })
  }
})

app.delete('/api/admin/newsletter/:id', requireAuth, async (req, res) => {
  try {
    await ensureNewsletterSubscribersTable()
    const id = parseInt(String(req.params.id), 10)
    if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const [result] = await dbQuery(
      'DELETE FROM newsletter_subscribers WHERE id = $1',
      [id]
    )
    if (!(result && result.affectedRows)) return res.status(404).json({ error: 'Not found' })
    return res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/admin/newsletter/:id failed:', e?.message || e)
    return res.status(500).json({ error: 'Failed to delete subscriber' })
  }
})

app.put('/api/admin/newsletter/:id/winner', requireAuth, async (req, res) => {
  try {
    await ensureNewsletterSubscribersTable()
    const id = parseInt(String(req.params.id), 10)
    if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const isWinner = req.body && typeof req.body.is_winner !== 'undefined'
      ? Boolean(req.body.is_winner)
      : true

    // Read prior state so we only email on the false → true transition
    const [priorRows] = await dbQuery(
      'SELECT email, is_winner FROM newsletter_subscribers WHERE id = $1',
      [id]
    )
    const prior = Array.isArray(priorRows) && priorRows[0] ? priorRows[0] : null
    if (!prior) return res.status(404).json({ error: 'Not found' })

    const [result] = await dbQuery(
      'UPDATE newsletter_subscribers SET is_winner = $1 WHERE id = $2',
      [isWinner ? 1 : 0, id]
    )
    if (!(result && result.affectedRows)) return res.status(404).json({ error: 'Not found' })

    // Send the celebration email only when flagging a NEW winner
    const wasWinner = Boolean(Number(prior.is_winner))
    if (isWinner && !wasWinner && prior.email) {
      ;(async () => {
        try {
          await sendNewsletterWinnerEmail(prior.email, { productName: 'Retatrutide 40mg pen' })
        } catch (mailErr) {
          console.error('[newsletter] winner email failed:', mailErr?.message || mailErr)
        }
      })()
    }

    return res.json({ ok: true, is_winner: isWinner, email_sent: isWinner && !wasWinner })
  } catch (e) {
    console.error('PUT /api/admin/newsletter/:id/winner failed:', e?.message || e)
    return res.status(500).json({ error: 'Failed to update winner flag' })
  }
})

app.get('/api/admin/newsletter/export.csv', requireAuth, async (req, res) => {
  try {
    await ensureNewsletterSubscribersTable()
    const q = String(req.query.q || '').trim()
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()

    const where = []
    const params = []
    if (q) { where.push('email LIKE $1'); params.push(`%${q}%`) }
    if (from) { where.push('created_at >= $1'); params.push(from.length === 10 ? `${from} 00:00:00` : from) }
    if (to) { where.push('created_at <= $1'); params.push(to.length === 10 ? `${to} 23:59:59` : to) }
    const domainId = await resolveAdminDomainFilter(req)
    if (domainId != null) { params.push(domainId); where.push(`domain_id = $${params.length}`) }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await dbQuery(
      `SELECT id, email, consent, source, is_winner, created_at
       FROM newsletter_subscribers ${whereClause}
       ORDER BY created_at DESC`,
      params
    )

    const escape = (v) => {
      const s = v === null || typeof v === 'undefined' ? '' : String(v)
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const header = ['id', 'email', 'consent', 'source', 'is_winner', 'created_at']
    const lines = [header.join(',')]
for (const r of rows) {
  lines.push([
    r.id,
    r.email,
    r.consent ? '1' : '0', 
    r.source,
    r.is_winner ? '1' : '0', 
    r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, // Fixed $3
  ].map(escape).join(','))
}


    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="newsletter-subscribers-${Date.now()}.csv"`)
    return res.send(lines.join('\n'))
  } catch (e) {
    console.error('GET /api/admin/newsletter/export.csv failed:', e?.message || e)
    return res.status(500).json({ error: 'Failed to export subscribers' })
  }
})

// ─── Startup ────────────────────────────────────────────────────────────────

;(async () => {
  // 1. Independent tables (no FK dependencies)
  await ensureUsersTable()
  await seedUsersFromSql()
  await ensureAdminUsersTable()
  await ensureProductsTable()
  await ensureShippingLabelsTable()
  await ensureWebhookLogsTable()

  // 2. Tables that depend on users
  await ensureUserAddressesTable()
  await ensurePasswordResetTokensTable()

  // 3. Tables that depend on users + products
  await ensureOrdersTable()
  await ensureOrdersAdminPaymentEvidenceColumns()
  await ensureOrdersIbalticxInvoiceColumns()

  // 4. Tables that depend on orders
  await ensurePaymentsTable()
  await ensurePaymentCaptureRequestsTable()
  await ensurePaymentSessionsTable()
  await ensureEmailNotificationsTable()
  await ensureOrderAddressChangeRequestsTable()

  // 5. Backfill & column migrations
  await backfillOrderItemSkus()
  await ensurePaymentCaptureEmailTrackingColumns()

  // 6. Config & feature tables
  await ensureProductConfigTable()
  await ensureCustomerBlacklistTable()
  await ensureWholesaleConsoleSchema()
  await ensureWholesaleInquiriesTable()
  await ensureNewsletterSubscribersTable()

  app.listen(PORT, () => {
    console.log(`✅ Admin service running on port ${PORT}`)
  })
})().catch((e) => {
  console.error('Failed to start admin service:', e?.message || String(e))
})
