# Nordklart public dashboard page

Route: `/dashboard`

This page is a public marketing/dashboard entry point for Nordklart. It is intentionally separate from the authenticated in-app overview.

## Positioning

The page presents four clear choices:

1. Bokföring
2. Enbart bokslut
3. Bankgiro via Leslie/partner
4. Allt i ett

## Rules preserved

- No XLSX/Excel export was added.
- No database migration was needed.
- No Docker dependency was added.
- The page is server-rendered and uses existing Tailwind/design tokens.
- Public copy avoids technical implementation terms such as RLS, migrations, Supabase and entitlements.

## Main CTAs

- `/register?intent=bookkeeping`
- `/register?intent=year-end`
- `/register?intent=bankgiro`
- `/register?intent=all-in-one`
- `/register?intent=agency`
