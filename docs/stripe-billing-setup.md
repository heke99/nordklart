# Stripe Billing – production setup

Nordklart keeps the commercial source of truth in Supabase. Stripe handles payment collection, Checkout, invoices and the customer portal. A Stripe payment never opens access by itself: the signed webhook is reconciled to a Nordklart checkout intent before a subscription, add-on or one-time purchase is activated.

## Required environment variables

Set these in the same environment that runs the Next.js application:

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_APP_URL=https://app.example.se
```

Optional values:

```bash
# Pin Stripe API behaviour deliberately after verifying a new API version.
STRIPE_API_VERSION=

# Use a configured Stripe Billing Portal profile. Omit to use the account default.
STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_...
```

`NEXT_PUBLIC_APP_URL` may be replaced by `APP_URL` on server-only deployments. It must be a controlled public application URL. Checkout and portal return URLs never trust a browser-supplied `Origin` header.

## Stripe dashboard configuration

1. Add a webhook endpoint at:

   ```text
   https://<your-app-domain>/api/stripe/webhook
   ```

2. Store the signing secret from that endpoint as `STRIPE_WEBHOOK_SECRET`.

3. Subscribe the endpoint to at least:

   ```text
   checkout.session.completed
   checkout.session.expired
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   ```

4. Configure the Stripe Billing Portal for payment-method updates and invoice history. Keep plan changes and subscription cancellation disabled initially: Nordklart supports dependent add-ons such as Bankgiro, and a base-plan change or cancellation must be handled as one controlled commercial operation so no dependent service keeps charging by mistake.

5. In the Nordklart superadmin view, open **Planer, priser och åtkomst**, create or open a draft version, select **Synka Stripe**, then publish or schedule it. A published plan version remains immutable; create a new version for every price or feature change.

## Operational rules

- Do not set `stripe_price_id` manually in the database.
- Do not activate customer access manually after a payment. Investigate the webhook log if the activation is missing.
- `Complimentary Full Access` does not include Bankgiro. Use the separate `Complimentary Bankgiro` grant only after an explicit decision.
- Bankgiro operations require both commercial access and a fully provisioned provider account.
- A `past_due` subscription is allowed only through its stored grace window. Once the grace window ends, feature access is denied by the database resolver.
- The Vercel cron route `/api/commerce/activate-scheduled-prices/cron` promotes due scheduled plan versions every five minutes. It is protected by `CRON_SECRET` through the common cron guard.
- Failed webhook events are stored in `stripe_webhook_events`; fix the underlying cause and resend the event from Stripe rather than editing access tables.

## First production verification

1. Publish a low-cost test plan from the superadmin view.
2. Start Checkout as a company owner/admin.
3. Complete payment with Stripe test mode before switching to live keys.
4. Confirm `checkout.session.completed` becomes `processed` in the superadmin Stripe tab.
5. Confirm `company_subscriptions` or `one_time_purchases` is created with the exact plan-version price snapshot.
6. Confirm the company feature inspector shows the subscription item as the effective source.
7. For Bankgiro, confirm that application access is available after purchase but operational access remains blocked until provider provisioning is active.

## Tax, subscription changes and role controls

Set these values in every environment where Checkout can run:

```bash
STRIPE_TAX_ENABLED=true
STRIPE_TAX_MODE=automatic
CRON_SECRET=<long-random-secret>
```

Before publishing a sellable plan, set a Stripe Tax code and tax behaviour for its product in **Planer, priser och åtkomst**. Nordklart sends Checkout the customer address and tax-ID collection requirements, asks Stripe Tax to calculate tax, and stores the tax/subtotal/total evidence from the signed webhook with the resulting Stripe invoice.

Customers can update payment methods and retrieve invoices in Stripe Billing Portal. Plan changes and cancellations are requested from Nordklart and processed by a superadmin. A processed request is scheduled for the next billing period; cancellation schedules dependent add-ons first and then the base subscription.

Manage global roles in **Plattformsteam**. `Complimentary Full Access` remains a company-level commercial grant and must never be used as a platform role.
