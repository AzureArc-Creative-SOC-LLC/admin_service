# Admin Service — API Reference

**Base URL:** `http://localhost:5001` (local) or your deployed domain

---

## Authentication

All endpoints except `/api/admin/login`, `/health`, and the public `/api/products/*` routes require:

```
Authorization: Bearer <token>
```

Tokens expire after **24 hours**.

---

## Auth

### POST `/api/admin/login`

**Request:**
```json
{
  "username": "admin",
  "password": "yourpassword"
}
```

**Response `200`:**
```json
{
  "success": true,
  "token": "<jwt>",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "role": "admin"
  }
}
```

**Errors:** `400` username/password missing · `401` invalid credentials

---

### GET `/api/admin/verify`

Check if the current token is valid.

**Response `200`:**
```json
{
  "valid": true,
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

---

### GET `/api/admin/health`

No auth required.

**Response `200`:** `{ "status": "ok" }`

---

## Orders

### GET `/api/admin/orders`

**Query params:**

| Param | Type | Default | Max |
|---|---|---|---|
| `limit` | number | 200 | 500 |
| `offset` | number | 0 | — |

**Response `200`:**
```json
{
  "orders": [
    {
      "id": 1,
      "order_number": "ADM-20250101-001",
      "customer_email": "jane@example.com",
      "customer_name": "Jane Doe",
      "customer_phone": "+441234567890",
      "shipping_address": "123 Main St",
      "shipping_city": "London",
      "shipping_state": "",
      "shipping_zip": "SW1A 1AA",
      "shipping_country": "United Kingdom",
      "currency": "GBP",
      "subtotal": "59.99",
      "shipping": "0.00",
      "total": "49.99",
      "credits_applied": "10.00",
      "total_before_credits": "59.99",
      "total_before_discount": "59.99",
      "total_after_discount": "59.99",
      "discount_amount": "0.00",
      "promo_code": "SAVE10",
      "promo_discount_percent": 0,
      "promo_valid": 1,
      "status": "pending",
      "payment_status": "pending",
      "payment_method": "Bank Transfer",
      "payment_rejection_reason": null,
      "bank_account_used": null,
      "tracking_number": null,
      "items_text": "Product A x 2",
      "payment_screenshot_filename": null,
      "payment_screenshot_url": null,
      "reserved_at": null,
      "submitted_at": null,
      "created_at": "2025-01-01T12:00:00Z",
      "updated_at": "2025-01-01T12:00:00Z",
      "latest_payment_status": "pending",
      "latest_successful_payment_status": null,
      "latest_failed_payment_status": null,
      "effective_payment_status": "pending",
      "payment_request_sent_at": null,
      "payment_request_sent_at_ms": null,
      "payment_date": null,
      "payment_date_ms": null
    }
  ]
}
```

---

### GET `/api/admin/order/:id`

Get a single order by database ID.

**Response `200`:**
```json
{
  "order": {
    "id": 1,
    "order_number": "ADM-20250101-001",
    "customer_email": "jane@example.com",
    "customer_name": "Jane Doe",
    "customer_phone": "+441234567890",
    "shipping_address": "123 Main St",
    "shipping_city": "London",
    "shipping_state": "",
    "shipping_zip": "SW1A 1AA",
    "shipping_country": "United Kingdom",
    "currency": "GBP",
    "subtotal": "59.99",
    "shipping": "0.00",
    "total": "49.99",
    "credits_applied": "10.00",
    "total_before_credits": "59.99",
    "promo_code": "SAVE10",
    "status": "pending",
    "payment_status": "pending",
    "payment_method": "Bank Transfer",
    "payment_rejection_reason": null,
    "bank_account_used": null,
    "tracking_number": null,
    "items_text": "Product A x 2",
    "payment_screenshot_filename": null,
    "payment_screenshot_url": null,
    "created_at": "2025-01-01T12:00:00Z",
    "updated_at": "2025-01-01T12:00:00Z"
  },
  "items": [
    {
      "id": 1,
      "order_id": 1,
      "product_id": null,
      "name": "Product A",
      "sku": "SKU-001",
      "quantity": 2,
      "unit_price": "24.99",
      "line_total": "49.98"
    }
  ],
  "payments": [
    {
      "id": 1,
      "order_id": 1,
      "provider": "Manual",
      "provider_id": "ADMIN-ADM-20250101-001",
      "amount": "49.99",
      "currency": "GBP",
      "status": "pending",
      "raw_response": null,
      "created_at": "2025-01-01T12:00:00Z",
      "updated_at": null
    }
  ]
}
```

**Errors:** `400` invalid id · `404` not found

---

### GET `/api/admin/order-number/:orderNumber`

Same response shape as `GET /api/admin/order/:id`.

---

### GET `/api/admin/orders/latest-by-email/:email`

Same response shape as `GET /api/admin/order/:id`.

**Errors:** `400` invalid email · `404` no orders found

---

### POST `/api/admin/orders`

`Content-Type: multipart/form-data` (supports optional file upload)

**Request fields:**

| Field | Required | Type | Notes |
|---|---|---|---|
| `customer_name` | Yes | string | |
| `customer_email` | Yes | string | valid email |
| `customer_phone` | No | string | |
| `shipping_address` | Yes | string | |
| `shipping_city` | Yes | string | |
| `shipping_zip` | Yes | string | |
| `shipping_state` | No | string | |
| `shipping_country` | No | string | default `United Kingdom` |
| `items` | Yes | JSON string | array — see below |
| `total` | No | number | computed from items if omitted |
| `currency` | No | string | default `GBP` |
| `status` | No | string | default `pending` |
| `payment_status` | No | string | default `pending` |
| `payment_method` | No | string | default `Bank Transfer` |
| `promo_code` | No | string | |
| `credits_applied` | No | number | |
| `total_before_credits` | No | number | |
| `adminPaymentScreenshot` | No | file | image upload |

**`items` array (JSON stringified):**
```json
[
  {
    "name": "Product A",
    "sku": "SKU-001",
    "quantity": 2,
    "unit_price": 24.99
  }
]
```

**Response `201`:**
```json
{
  "success": true,
  "order": { /* same fields as GET /api/admin/order/:id → order */ },
  "items": [ /* same as GET /api/admin/order/:id → items */ ],
  "payments": [ /* same as GET /api/admin/order/:id → payments */ ]
}
```

**Errors:** `400` missing required fields · `409` duplicate order number

---

### PUT `/api/admin/order/:id/status`

**Request:**
```json
{
  "status": "dispatched",
  "trackingNumber": "TRK123456",
  "paymentStatus": "received",
  "paymentRejectionReason": ""
}
```

Valid `status` values: `pending` · `processing` · `dispatched` · `delivered` · `cancelled`

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### PUT `/api/admin/order/:id/payment-status`

**Request:**
```json
{
  "payment_status": "received",
  "bank_account_used": "ibalticx"
}
```

`payment_status` must be `"received"` or `"rejected"`.  
`bank_account_used`: `"ibalticx"` or `"ivms"` (only applicable when receiving).

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### POST `/api/admin/order/:id/payment-status/evidence`

Approve payment with admin remark + optional screenshot.  
`Content-Type: multipart/form-data`

**Request fields:**

| Field | Required | Notes |
|---|---|---|
| `admin_payment_remark` | Yes | text remark |
| `bank_account_used` | No | `ibalticx` or `ivms` |
| `adminPaymentScreenshot` | No | file upload |

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### PUT `/api/admin/order/:id/items`

**Request:**
```json
{
  "items": [
    {
      "name": "Product A",
      "sku": "SKU-001",
      "quantity": 2,
      "unit_price": 24.99
    }
  ]
}
```

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### PUT `/api/admin/order/:id/promo`

**Request:**
```json
{ "promo_code": "SAVE10" }
```

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### PUT `/api/admin/order/:id/shipping`

**Request:**
```json
{
  "shipping_address": "123 Main St",
  "shipping_city": "London",
  "shipping_state": "",
  "shipping_zip": "SW1A 1AA",
  "shipping_country": "United Kingdom"
}
```

**Response `200`:**
```json
{ "success": true, "order": { /* full order row */ } }
```

---

### DELETE `/api/admin/order/:id`

**Response `200`:**
```json
{ "success": true }
```

---

### POST `/api/admin/order/:id/refund`

Only works for orders containing test product ID 32.

**Request:**
```json
{ "amount": 49.99 }
```

**Response `200`:**
```json
{ "success": true }
```
or if already refunded:
```json
{ "success": true, "alreadyRefunded": true }
```

---

### POST `/api/admin/orders/bulk-capture-payment`

**Request:**
```json
{ "orderNumbers": ["ADM-001", "ADM-002"] }
```

**Response `200`:**
```json
{
  "success": true,
  "results": [
    { "orderNumber": "ADM-001", "success": true },
    { "orderNumber": "ADM-002", "success": false, "error": "Order not found" }
  ]
}
```

---

### POST `/api/admin/orders/bulk-payment-reminder`

**Request:**
```json
{ "orderNumbers": ["ADM-001", "ADM-002"] }
```

**Response `200`:** same shape as bulk-capture-payment

---

### POST `/api/admin/orders/:orderNumber/capture-payment`

**Response `200`:**
```json
{ "success": true }
```

---

### POST `/api/admin/orders/:orderNumber/resend-has-entry`

**Response `200`:**
```json
{ "success": true }
```

---

### POST `/api/admin/orders/resend-all-has-entries`

**Response `200`:**
```json
{
  "success": true,
  "results": [
    { "orderNumber": "ADM-001", "success": true },
    { "orderNumber": "ADM-002", "success": false, "error": "..." }
  ]
}
```

---

### POST `/api/admin/orders/:orderNumber/resend-has-invoice`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/orders/:orderNumber/resend-old-has-invoice`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/orders/:orderNumber/send-has-invoice-to`

**Request:**
```json
{ "email": "override@example.com" }
```

**Response `200`:** `{ "success": true }`

---

## Stats

### GET `/api/admin/stats`

**Query params:** `since` — ISO date string (optional), filters completed payment totals from this date onward.

**Response `200`:**
```json
{
  "totalOrders": 500,
  "totalRevenue": "24500.00",
  "pendingOrders": 12,
  "completedOrders": 488,
  "pendingPaymentsAmount": "1200.00",
  "completedPaymentsAmount": "23300.00",
  "paymentLinksLast1h": 3,
  "paymentLinksLast12h": 15,
  "paymentLinksLast24h": 30,
  "paymentLinksLast7d": 120,
  "paymentLinksTotal": 900
}
```

---

### GET `/api/admin/stats/orders-submitted`

**Query params:** `window` (e.g. `24 hours`, `7 days`)

---

### GET `/api/admin/stats/completed-payments`

**Query params:** `window`

---

### GET `/api/admin/stats/product`

Per-product order and revenue breakdown.

---

### GET `/api/admin/stats/weekly`

Weekly aggregated order counts and revenue.

---

### GET `/api/admin/stats/timeseries`

**Query params:** `from`, `to` (ISO dates), `interval` (`day` · `week` · `month`)

---

## Customers

### GET `/api/admin/customers`

**Query params:**

| Param | Default | Max |
|---|---|---|
| `limit` | 500 | 2000 |
| `offset` | 0 | — |

**Response `200`:**
```json
{
  "success": true,
  "customers": [
    {
      "email": "jane@example.com",
      "customer_name": "Jane Doe",
      "customer_phone": "+441234567890",
      "date_of_birth": null,
      "orders_count": 3,
      "last_order_created_at": "2025-01-10T12:00:00Z",
      "last_order_number": "ADM-001"
    }
  ],
  "has_more": false
}
```

---

### GET `/api/admin/customers/:email`

**Response `200`:**
```json
{
  "success": true,
  "customer": {
    "email": "jane@example.com",
    "customer_name": "Jane Doe",
    "customer_phone": "+441234567890",
    "date_of_birth": null,
    "orders_count": 5,
    "last_order_created_at": "2025-01-10T12:00:00Z",
    "credit_balance": 10.00,
    "recentOrders": [
      {
        "id": 1,
        "order_number": "ADM-001",
        "status": "delivered",
        "payment_status": "received",
        "total": 49.99,
        "currency": "GBP",
        "created_at": "2025-01-01T12:00:00Z"
      }
    ]
  }
}
```

**Errors:** `400` invalid email · `404` not found

---

### POST `/api/admin/customers/:email/credits`

**Request:**
```json
{ "amount": 10.00, "note": "Goodwill credit" }
```

**Response `200`:**
```json
{ "success": true, "balance": 15.00 }
```

**Errors:** `400` invalid amount · `404` user not found

---

### POST `/api/admin/customers/:email/credits/deduct`

**Request:**
```json
{ "amount": 5.00, "note": "Manual deduction" }
```

**Response `200`:**
```json
{ "success": true, "balance": 10.00 }
```

---

### GET `/api/admin/customer-blacklist`

**Response `200`:**
```json
{
  "success": true,
  "blacklist": [
    {
      "id": 1,
      "email": "bad@example.com",
      "address_key": null,
      "reason": "fraud",
      "created_at": "2025-01-01T12:00:00Z",
      "last_order_number": "ADM-001",
      "customer_name": "Bad Actor",
      "customer_email": "bad@example.com",
      "last_order_total": "49.99",
      "last_order_currency": "GBP",
      "last_order_status": "cancelled",
      "last_order_payment_status": "rejected",
      "last_order_created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

---

### DELETE `/api/admin/customer-blacklist/:id`

**Response `200`:** `{ "success": true }`

---

## Products

### GET `/api/admin/products`

**Query params:**

| Param | Type | Default | Max | Notes |
|---|---|---|---|---|
| `limit` | number | 50 | 200 | |
| `q` | string | — | — | search by name or SKU (case-insensitive) |

**Response `200`:**
```json
{
  "products": [
    {
      "id": 1,
      "name": "Product A",
      "sku": "SKU-001",
      "price": "49.99",
      "currency": "GBP",
      "image_url": "https://example.com/img.jpg",
      "image_alt": "Product A image",
      "is_enabled": 1,
      "images": [
        { "id": 10, "product_id": 1, "position": 0, "src": "https://example.com/img.jpg" }
      ]
    }
  ]
}
```

> No `success` key at top level.

---

### GET `/api/admin/products/:id`

**Response `200`:**
```json
{
  "success": true,
  "product": {
    "id": 1,
    "name": "Product A",
    "slug": "product-a",
    "sku": "SKU-001",
    "price": "49.99",
    "currency": "GBP",
    "in_stock": 1,
    "stock_qty": 100,
    "image_url": "https://example.com/img.jpg",
    "image_alt": "Product A image",
    "lab_test_url": null,
    "short_desc": "Short description",
    "long_desc": "Full description",
    "details_contents": null,
    "details_storage": null,
    "details_delivery": null,
    "is_enabled": 1,
    "display_order": 0,
    "klyme_enabled": false,
    "created_at": "2025-01-01T12:00:00Z",
    "updated_at": "2025-01-01T12:00:00Z",
    "images": [
      { "id": 10, "product_id": 1, "position": 0, "src": "https://example.com/img.jpg" }
    ]
  }
}
```

**Errors:** `400` invalid id · `404` not found

---

### POST `/api/admin/products`

**Request:**
```json
{
  "name": "Product A",
  "sku": "SKU-001",
  "price": 49.99,
  "currency": "GBP",
  "in_stock": 1,
  "stock_qty": 100,
  "image_url": "https://example.com/img.jpg",
  "image_alt": "Product A image",
  "lab_test_url": null,
  "short_desc": "Short description",
  "long_desc": "Full description",
  "details_contents": null,
  "details_storage": null,
  "details_delivery": null,
  "is_enabled": 1,
  "display_order": 0,
  "images": [
    { "src": "https://example.com/img.jpg", "position": 0 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | |
| `sku` | Yes | auto-uppercased; must be unique |
| `price` | Yes | non-negative number |
| `currency` | No | default `GBP` |
| `in_stock` | No | `1` / `0`, default `1` |
| `stock_qty` | No | integer or null |
| `image_url` | No | |
| `image_alt` | No | |
| `lab_test_url` | No | |
| `short_desc` | No | |
| `long_desc` | No | |
| `details_contents` | No | |
| `details_storage` | No | |
| `details_delivery` | No | |
| `is_enabled` | No | `1` / `0`, default `1` |
| `display_order` | No | integer, default `0` |
| `images` | No | array of `{ src, position }` |

**Response `201`:**
```json
{
  "success": true,
  "product": { /* same fields as GET /api/admin/products/:id → product */ }
}
```

**Errors:** `400` missing/invalid fields · `409` SKU already exists

---

### PUT `/api/admin/products/:id`

Patch-style — only fields present in the body are updated; omitted fields keep their current values.

**Request:** same fields as POST (all optional — cannot send empty `name`, `sku`, or negative `price`)

Sending `images` array replaces all existing images for the product.

**Response `200`:**
```json
{
  "success": true,
  "product": { /* same fields as GET /api/admin/products/:id → product */ }
}
```

**Errors:** `400` invalid id or validation · `404` not found · `409` SKU conflict

---

### DELETE `/api/admin/products/:id`

Cascades: deletes product images and product_config entry before deleting the product.

**Response `200`:**
```json
{ "success": true }
```

**Errors:** `400` invalid id · `404` not found

---

### GET `/api/admin/product-config`

**Response `200`:**
```json
{
  "success": true,
  "config": [
    { "id": "1", "name": "Product A", "sku": "SKU-001", "klyme_enabled": false }
  ]
}
```

> `id` is returned as a string (stored as text in `product_config`).

---

### POST `/api/admin/product/:id/klyme-enabled`

**Request:**
```json
{ "enabled": true }
```

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/products/klyme-status` *(no auth)*

**Request:**
```json
{ "product_ids": [1, 2, 3] }
```

> Also accepts `productIds` as the key name.

**Response `200`:**
```json
{
  "klyme_settings": {
    "1": true,
    "2": false,
    "3": false
  }
}
```

> Response is an **object** keyed by product ID (as sent), not an array. No `success` key.

---

### POST `/api/admin/products/klyme-status-by-sku` *(no auth)*

**Request:**
```json
{ "skus": ["SKU-001", "SKU-002"] }
```

> Also accepts `product_skus` or `productSkus` as the key name.

**Response `200`:**
```json
{
  "klyme_settings": {
    "SKU-001": true,
    "SKU-002": false
  }
}
```

> Response is an **object** keyed by SKU string. No `success` key.

---

### POST `/api/products/klyme-status` *(public — no auth)*

Same request and response shape as `POST /api/admin/products/klyme-status`.

---

### POST `/api/products/klyme-status-by-sku` *(public — no auth)*

Same request and response shape as `POST /api/admin/products/klyme-status-by-sku`.

---

## Affiliates & Affiliate Requests

### GET `/api/admin/affiliate-requests`

**Query params:**

| Param | Values | Default |
|---|---|---|
| `status` | `pending` · `approved` · `rejected` · `all` | `pending` |
| `limit` | 1–500 | 200 |
| `offset` | | 0 |

**Response `200`:**
```json
{
  "requests": [
    {
      "id": 1,
      "user_id": 42,
      "user_name": "Jane Doe",
      "email": "jane@example.com",
      "first_name": "Jane",
      "last_name": "Doe",
      "tiktok_link": "https://tiktok.com/@jane",
      "status": "pending",
      "admin_note": null,
      "approved_by": null,
      "approved_at": null,
      "created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

---

### POST `/api/admin/affiliate-requests/:id/approve`

**Request:**
```json
{
  "percent": 10,
  "adminNote": "Approved after review"
}
```

`percent`: discount percent (1–90, default 10)

**Response `200`:** `{ "success": true }`

**Errors:** `404` not found · `409` request is not pending

---

### POST `/api/admin/affiliate-requests/:id/reject`

**Request:**
```json
{ "adminNote": "Not eligible at this time" }
```

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/affiliate-requests/:id/revoke`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/affiliate-requests/:id/reinstate`

**Response `200`:** `{ "success": true }`

---

### GET `/api/admin/affiliates`

**Query params:** `limit` (default 500, max 1000), `offset`

**Response `200`:**
```json
{
  "affiliates": [
    {
      "affiliate_id": 1,
      "request_id": 1,
      "user_id": 42,
      "promo_code": "JANE10",
      "promo_percent": 10,
      "reward_amount": "10.00",
      "first_name": "Jane",
      "last_name": "Doe",
      "tiktok_link": "https://tiktok.com/@jane",
      "status": "approved",
      "approved_at": "2025-01-05T10:00:00Z",
      "created_at": "2025-01-01T12:00:00Z",
      "user_email": "jane@example.com",
      "user_name": "Jane Doe",
      "wallet_balance": "30.00",
      "redemption_count": 3,
      "total_earned": "30.00"
    }
  ]
}
```

---

### GET `/api/admin/affiliates/:id`

**Response `200`:**
```json
{
  "affiliate": {
    "affiliate_id": 1,
    "request_id": 1,
    "user_id": 42,
    "promo_code": "JANE10",
    "promo_percent": 10,
    "reward_amount": "10.00",
    "first_name": "Jane",
    "last_name": "Doe",
    "tiktok_link": "https://tiktok.com/@jane",
    "status": "approved",
    "approved_at": "2025-01-05T10:00:00Z",
    "created_at": "2025-01-01T12:00:00Z",
    "user_email": "jane@example.com",
    "user_name": "Jane Doe",
    "wallet_balance": "30.00",
    "redemption_count": 3,
    "total_earned": "30.00"
  },
  "redemptions": [
    {
      "redemption_id": 1,
      "reward_amount": "10.00",
      "redeemed_at": "2025-01-10T09:00:00Z",
      "order_id": 100,
      "order_number": "ADM-100",
      "customer_name": "John Smith",
      "customer_email": "john@example.com",
      "customer_phone": "+441234567890",
      "subtotal": "99.99",
      "total": "89.99",
      "total_before_discount": "99.99",
      "total_after_discount": "89.99",
      "discount_amount": "10.00",
      "currency": "GBP",
      "payment_status": "received",
      "order_created_at": "2025-01-10T08:00:00Z",
      "items": [
        { "name": "Product A", "quantity": 2, "unit_price": "44.99", "line_total": "89.98" }
      ]
    }
  ]
}
```

**Errors:** `400` invalid id · `404` not found

---

## Email

All email endpoints return `{ "success": true }` on success.

### POST `/api/admin/email/customer-info/send`

**Request:** `{ "orderNumber": "ADM-001" }`

---

### POST `/api/admin/email/customer-info/send-all`

No body required. Sends customer info emails for all eligible orders.

---

### POST `/api/admin/email/template/send`

**Request:**
```json
{
  "to": "user@example.com",
  "subject": "Hello",
  "body": "Email content here"
}
```

---

### POST `/api/admin/email/ibalticx/send`

**Request:** `{ "orderNumber": "ADM-001" }`

---

### POST `/api/admin/email/payment-reminder/send`

**Request:** `{ "orderNumber": "ADM-001" }`

---

### POST `/api/admin/email/has-invoice/send`

**Request:** `{ "orderNumber": "ADM-001" }`

---

## Payment Links / Capture Requests

### GET `/api/admin/payment-links`

**Query params:**

| Param | Notes |
|---|---|
| `hours` | look-back window in hours (default `24`) |
| `limit` | max results (default `200`) |

**Response `200`:**
```json
{
  "success": true,
  "hours": 24,
  "links": [
    {
      "id": 1,
      "order_id": 100,
      "email": "jane@example.com",
      "status": "pending",
      "sent_at": "2025-01-01T12:00:00Z",
      "amount": 49.99,
      "currency": "GBP"
    }
  ]
}
```

> Field names: `email` (not `customer_email`), `sent_at` (not `email_sent_at`), `amount` is a number (not string). No `order_number` or `created_at` fields.

---

### GET `/api/admin/ibalticx-paid`

List orders paid via iBalticX account.

**Response `200`:** `{ "orders": [ /* order rows */ ] }`

---

### GET `/api/admin/klyme-paid`

List orders paid via Klyme.

**Response `200`:** `{ "orders": [ /* order rows */ ] }`

---

## Address Change Requests

### GET `/api/admin/address-change-requests`

**Response `200`:**
```json
{
  "success": true,
  "requests": [
    {
      "id": 1,
      "order_id": 100,
      "order_number": "ADM-100",
      "customer_email": "jane@example.com",
      "new_shipping_address": "456 New St",
      "new_shipping_city": "Manchester",
      "new_shipping_state": "",
      "new_shipping_zip": "M1 1AA",
      "new_shipping_country": "United Kingdom",
      "status": "pending",
      "created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

---

### POST `/api/admin/address-change-requests/:id/approve`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/address-change-requests/:id/reject`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/address-change-requests/approve-all`

**Response `200`:** `{ "success": true, "updated": 5 }`

---

### POST `/api/admin/address-change-requests/reject-all`

**Response `200`:** `{ "success": true, "updated": 5 }`

---

## Wholesale

### GET `/api/admin/wholesale/orders`

**Query params:**

| Param | Values | Default |
|---|---|---|
| `status` | `pending` · `in_progress` · `completed` · `cancelled` · `all` | `all` |
| `country` | any string | — |
| `limit` | 1–500 | 200 |
| `offset` | | 0 |

**Response `200`:**
```json
{
  "orders": [
    {
      "id": 1,
      "order_code": "WO-20250101-001",
      "order_number": "WO-20250101-001",
      "first_name": "John",
      "last_name": "Smith",
      "customer_name": "John Smith",
      "email": "john@example.com",
      "customer_email": "john@example.com",
      "mobile": "+441234567890",
      "customer_phone": "+441234567890",
      "country": "United Kingdom",
      "shipping_country": "United Kingdom",
      "delivery_date": null,
      "status": "pending",
      "payment_status": "pending",
      "subtotal": "250.00",
      "discount_amount": "0.00",
      "grand_total": "250.00",
      "total": "250.00",
      "currency": "GBP",
      "total_payment": "250.00",
      "received_payment": "0.00",
      "pending_payment": "250.00",
      "created_at": "2025-01-01T12:00:00Z",
      "items": [
        {
          "id": 1,
          "wholesale_order_id": 1,
          "product_code": "SKU-001",
          "product_title": "Product A",
          "unit_price": "25.00",
          "quantity": 10
        }
      ]
    }
  ]
}
```

---

### GET `/api/admin/wholesale/orders/:id`

**Response `200`:** Single wholesale order — same fields as list, plus full allocations.

---

### POST `/api/admin/wholesale/orders`

**Required fields:** `first_name`, `last_name`, `email`, `mobile`, `country`, `items` (at least one)

**Request:**
```json
{
  "first_name": "John",
  "last_name": "Smith",
  "email": "john@example.com",
  "mobile": "+441234567890",
  "country": "United Kingdom",
  "delivery_date": "2025-02-01",
  "currency": "GBP",
  "items": [
    { "product_code": "SKU-001", "product_title": "Product A", "unit_price": 25.00, "quantity": 10 }
  ],
  "subtotal": 250.00,
  "discount_amount": 0,
  "grand_total": 250.00,
  "total_payment": 250.00,
  "notes": ""
}
```

**Response `201`:** `{ "success": true, "order": { /* wholesale order */ }, "items": [ /* order items */ ] }`

---

### PUT `/api/admin/wholesale/orders/:id`

Same body as POST (all fields optional — only sent fields are updated).

**Response `200`:** `{ "success": true, "order": { /* wholesale order */ }, "items": [ /* order items */ ] }`

---

### DELETE `/api/admin/wholesale/orders/:id`

**Response `200`:** `{ "success": true }`

---

### POST `/api/admin/wholesale/allocations`

**Request:**
```json
{
  "order_id": 1,
  "allocations": [
    { "item_id": 1, "member_id": 2, "quantity": 5 }
  ]
}
```

**Response `200`:** `{ "success": true }`

---

### GET `/api/admin/wholesale/products`

Returns active wholesale products only (filtered by `is_active`).

**Response `200`:**
```json
{
  "success": true,
  "products": [
    {
      "code": "SKU-001",
      "title": "Product A",
      "unit_price": "25.00",
      "currency": "GBP"
    }
  ]
}
```

> Fields are `code` and `title` — not `product_code` / `product_name`. No `id` or `unit` field.

---

### GET `/api/admin/wholesale/product-inventory`

**Query params:**

| Param | Notes |
|---|---|
| `product` | filter by exact `product_name` |
| `country` | filter by exact country |

**Response `200`:**
```json
{
  "inventory": [
    {
      "id": 1,
      "product_name": "Retatrutide 20mg",
      "country": "United Kingdom",
      "cartridge": 50,
      "leaflet": 50,
      "magnet_box": 50,
      "pen": 50,
      "solution": 50,
      "needles": 250,
      "powder": 50
    }
  ]
}
```

> No `success` key at top level. Returns all 7 component fields — not a single `on_hand` total.

---

### PUT `/api/admin/wholesale/product-inventory`

Updates (or creates) component stock for a product+country combination.

**Request:**
```json
{
  "product_name": "Retatrutide 20mg",
  "country": "United Kingdom",
  "cartridge": 50,
  "leaflet": 50,
  "magnet_box": 50,
  "pen": 50,
  "solution": 50,
  "needles": 250,
  "powder": 50
}
```

| Field | Required | Notes |
|---|---|---|
| `product_name` | Yes | |
| `country` | Yes | |
| `cartridge` | No | defaults to 0 |
| `leaflet` | No | defaults to 0 |
| `magnet_box` | No | defaults to 0 |
| `pen` | No | defaults to 0 |
| `solution` | No | defaults to 0 |
| `needles` | No | defaults to 0 |
| `powder` | No | defaults to 0 |

**Response `200`:**
```json
{
  "ok": true,
  "inventory": {
    "id": 1,
    "product_name": "Retatrutide 20mg",
    "country": "United Kingdom",
    "cartridge": 50,
    "leaflet": 50,
    "magnet_box": 50,
    "pen": 50,
    "solution": 50,
    "needles": 250,
    "powder": 50
  }
}
```

> Response key is `ok` (not `success`). Returns the updated inventory row.

---

### GET `/api/admin/wholesale/product-recipes`

**Response `200`:**
```json
{
  "recipes": [
    {
      "id": 1,
      "product_name": "Retatrutide 20mg",
      "cartridge": 1,
      "leaflet": 1,
      "magnet_box": 1,
      "pen": 1,
      "solution": 1,
      "needles": 5,
      "powder": 1
    }
  ]
}
```

> No `success` key at top level.

---

### GET `/api/admin/wholesale/inventory/raw`

**Response `200`:**
```json
{
  "materials": [
    {
      "name": "Powder A",
      "unit": "g",
      "on_hand": 100,
      "updated_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

> Field is `name` (not `material_name`). No `id` field. No `success` key at top level.

---

### PUT `/api/admin/wholesale/inventory/raw`

Updates stock for one or more raw materials. Sends an **array** of updates.

**Request:**
```json
{
  "updates": [
    { "name": "Powder A", "on_hand": 100 },
    { "name": "Cartridge B", "on_hand": 50 }
  ]
}
```

> Body must be `{ "updates": [...] }`. Each item uses `name` (not `material_name`).

**Response `200`:**
```json
{
  "ok": true,
  "materials": [
    { "name": "Powder A", "unit": "g", "on_hand": 100, "updated_at": "2025-01-01T12:00:00Z" }
  ]
}
```

> Response key is `ok` (not `success`). Returns the full updated materials list.

---

### GET `/api/admin/wholesale/team`

**Response `200`:**
```json
{
  "success": true,
  "team": [
    { "id": 1, "display_name": "Alice", "role": "packer" }
  ]
}
```

> Field is `display_name` (not `name`). No `created_at` in response.

---

### GET `/api/admin/wholesale/countries`

**Response `200`:**
```json
{
  "success": true,
  "countries": [
    "United Kingdom",
    "United States",
    "Canada",
    "Australia",
    "Germany",
    "France",
    "Netherlands",
    "Sweden",
    "Ireland",
    "Switzerland"
  ]
}
```

---

### POST `/api/admin/wholesale/orders-with-deduction`

Creates a wholesale order **and** deducts inventory from `wholesale_product_inventory` for the order's country, based on product recipes. Fails if any product has no recipe or insufficient inventory.

**Request:**
```json
{
  "firstName": "John",
  "lastName": "Smith",
  "email": "john@example.com",
  "mobile": "+441234567890",
  "country": "United Kingdom",
  "deliveryDate": "2025-02-01",
  "totalPayment": 250.00,
  "receivedPayment": 0,
  "pendingPayment": 250.00,
  "items": [
    { "product_name": "Retatrutide 20mg", "quantity": 10 }
  ]
}
```

> Uses camelCase field names. `items` reference products by `product_name` (matching recipe names), not by product code.

**Response `201`:** `{ "success": true, "order": { /* wholesale order */ } }`

**Errors:** `400` missing fields · `400` no recipe found for product · `400` insufficient inventory

---

## Wholesale Inquiries

### GET `/api/admin/wholesale-inquiries`

**Query params:** `limit` (default 100), `offset`

**Response `200`:**
```json
{
  "success": true,
  "total": 50,
  "inquiries": [
    {
      "id": 1,
      "name": "Jane Doe",
      "email": "jane@example.com",
      "contact": "+441234567890",
      "quantity": "100 units",
      "country": "United Kingdom",
      "submitted_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

---

### DELETE `/api/admin/wholesale-inquiries/:id`

**Response `200`:** `{ "success": true }`

---

## Newsletter

### GET `/api/admin/newsletter`

**Query params:**

| Param | Notes |
|---|---|
| `q` | email search (partial match) |
| `from` | date filter — `YYYY-MM-DD` or ISO datetime |
| `to` | date filter — `YYYY-MM-DD` or ISO datetime |
| `limit` | default 100, max 500 |
| `offset` | default 0 |

**Response `200`:**
```json
{
  "total": 250,
  "items": [
    {
      "id": 1,
      "email": "jane@example.com",
      "consent": true,
      "source": "website",
      "ip_address": "1.2.3.4",
      "user_agent": "Mozilla/5.0...",
      "is_winner": false,
      "created_at": "2025-01-01T12:00:00Z"
    }
  ]
}
```

> No `success` key at top level.

---

### DELETE `/api/admin/newsletter/:id`

**Response `200`:** `{ "ok": true }`

---

### PUT `/api/admin/newsletter/:id/winner`

**Request:**
```json
{ "is_winner": true }
```

If `is_winner` is omitted it defaults to `true`.  
Automatically sends a winner celebration email on the first time a subscriber is flagged as winner.

**Response `200`:**
```json
{ "ok": true, "is_winner": true, "email_sent": true }
```

---

### GET `/api/admin/newsletter/export.csv`

**Query params:** same as `GET /api/admin/newsletter` (`q`, `from`, `to`)

**Response:** CSV file download (`Content-Type: text/csv; charset=utf-8`)

CSV columns: `id`, `email`, `consent`, `source`, `ip_address`, `is_winner`, `created_at`

---

## Error Responses

All endpoints return errors in this shape:

```json
{ "error": "Human-readable error message" }
```

| Status | Meaning |
|---|---|
| `400` | Bad request — missing or invalid input |
| `401` | Unauthorized — missing, expired, or invalid token |
| `404` | Resource not found |
| `409` | Conflict — e.g. duplicate order number, request not in expected state |
| `500` | Server error |

---

## Response envelope reference

Not all endpoints follow the `{ "success": true, ... }` pattern. Use this table as a quick reference:

| Endpoint | Top-level shape |
|---|---|
| `GET /api/admin/orders` | `{ orders }` |
| `GET /api/admin/order/:id` | `{ order, items, payments }` |
| `GET /api/admin/products` | `{ products }` — no `success` |
| `GET /api/admin/wholesale/orders` | `{ orders }` — no `success` |
| `GET /api/admin/wholesale/product-inventory` | `{ inventory }` — no `success` |
| `PUT /api/admin/wholesale/product-inventory` | `{ ok, inventory }` |
| `GET /api/admin/wholesale/product-recipes` | `{ recipes }` — no `success` |
| `GET /api/admin/wholesale/inventory/raw` | `{ materials }` — no `success` |
| `PUT /api/admin/wholesale/inventory/raw` | `{ ok, materials }` |
| `GET /api/admin/newsletter` | `{ total, items }` — no `success` |
| `DELETE /api/admin/newsletter/:id` | `{ ok }` |
| `PUT /api/admin/newsletter/:id/winner` | `{ ok, is_winner, email_sent }` |
| `GET /api/admin/affiliates` | `{ affiliates }` — no `success` |
| `GET /api/admin/affiliate-requests` | `{ requests }` — no `success` |
| `POST /api/admin/products/klyme-status` | `{ klyme_settings }` — object map, no `success` |
| `POST /api/products/klyme-status` | `{ klyme_settings }` — object map, no `success` |
| `POST /api/admin/products/klyme-status-by-sku` | `{ klyme_settings }` — object map, no `success` |
| `POST /api/products/klyme-status-by-sku` | `{ klyme_settings }` — object map, no `success` |
