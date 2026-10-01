# Service-role additions, 2026-10-01

Each file below now constructs a service-role client. For each one: who the
actor is, how company and resource access is checked, and why the service
role is needed.

## `app/api/legal/accept/route.ts` (POST)

- **Actor:** `requireAuth` authenticates the user and enforces MFA. The route
  is limited per user (20 per 15 min).
- **Company and resource:** none. Legal acceptances belong to the person, not
  to a company. The only input is a list of legal text version ids; the user
  id always comes from the session, never from the request body.
- **Permission:** `accept_legal_documents` accepts only versions that are
  currently active and records them for the authenticated user only.
- **Why service role:** `legal_acceptances` is evidence of what a user agreed
  to and when. Users can read their own rows but cannot write them
  (`legal_acceptances_service_insert`), and `accept_legal_documents` is
  granted to `service_role` only. The IP address and user agent are taken
  from the request on the server, so the client cannot supply them.

## `lib/agent/chat/response-cache.ts`

- **Actor:** the signed-in user of `/api/agent/invoke`. That route runs
  `requireAuth` (MFA enforced) and `getCompanyReadAccess` for the company
  before the chat loop calls this module.
- **Company and resource:** every read and write is scoped to that company
  id: the lookup RPC `agent_response_cache_hit(p_company_id, p_cache_key)`
  and the upsert/cleanup on `agent_response_cache` all filter on
  `company_id`. The cache key itself also hashes the company id.
- **Permission:** read access to the company, the same level that may use
  the assistant at all. Only first-turn answers produced without tool calls
  are stored, so no tool output or staged write is replayed.
- **Why service role:** members must not be able to write cache rows
  through the API, or one member could plant an answer that another member
  later receives. The table therefore has no API grants or policies, and
  the RPC is granted to `service_role` only.
