/**
 * The BankID feature flag, on its own, with no Node built-ins behind it.
 *
 * The flag used to live in `lib/auth/bankid.ts` next to the personnummer
 * hashing, encryption and HMAC helpers — a module that imports `node:crypto`.
 * Client components need the flag and nothing else, so importing it from there
 * pulled the whole identity-crypto module into the browser bundle. Keeping the
 * two apart means a client component can ask "is BankID on?" without shipping
 * the code that handles personnummer.
 *
 * Both variables are NEXT_PUBLIC_ and therefore inlined at build time; the
 * Docker entrypoint rewrites the placeholders in .next/static before the app
 * serves anything.
 */
export function isBankIdEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return false
  return process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true'
}
