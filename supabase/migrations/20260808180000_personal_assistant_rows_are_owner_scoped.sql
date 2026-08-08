-- Personal assistant rows are owner-scoped, not company-write-scoped.
--
-- 20260808170000 swapped 147 write policies from "is a member" to "may write
-- for this company" (user_can_write_company). That is right for ledger and
-- master data, and it is what closed the hole where a viewer could mutate
-- another company member's records.
--
-- Three of those tables are not company data. agent_conversations,
-- chat_sessions and chat_messages are one user's own conversation with the
-- assistant, each row carrying user_id. Requiring company *write* capability
-- there had a side effect nobody asked for: a viewer or auditor — someone whose
-- whole job is reading the books — could no longer ask the assistant a
-- question, because starting a conversation writes a row.
--
-- The right predicate for these three is membership AND ownership, which is
-- strictly tighter than either version:
--
--   before 20260808170000:  any member could edit ANY member's conversation
--   after  20260808170000:  only writers, but still ANY writer's conversation
--   here:                   only your own, and only in a company you belong to
--
-- So this both restores read-only users' access to the assistant and fixes the
-- cross-user tampering that neither earlier version prevented.
--
-- agent_memory and agent_profiles are deliberately NOT included: they have no
-- user_id and hold shared, company-level assistant knowledge. Write capability
-- is the correct gate for those.

-- agent_conversations ---------------------------------------------------------
DROP POLICY IF EXISTS agent_conversations_insert ON public.agent_conversations;
CREATE POLICY agent_conversations_insert ON public.agent_conversations FOR INSERT TO public
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS agent_conversations_update ON public.agent_conversations;
CREATE POLICY agent_conversations_update ON public.agent_conversations FOR UPDATE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  )
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS agent_conversations_delete ON public.agent_conversations;
CREATE POLICY agent_conversations_delete ON public.agent_conversations FOR DELETE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

-- chat_sessions ---------------------------------------------------------------
DROP POLICY IF EXISTS chat_sessions_insert ON public.chat_sessions;
CREATE POLICY chat_sessions_insert ON public.chat_sessions FOR INSERT TO public
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS chat_sessions_update ON public.chat_sessions;
CREATE POLICY chat_sessions_update ON public.chat_sessions FOR UPDATE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS chat_sessions_delete ON public.chat_sessions;
CREATE POLICY chat_sessions_delete ON public.chat_sessions FOR DELETE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

-- chat_messages ---------------------------------------------------------------
DROP POLICY IF EXISTS chat_messages_insert ON public.chat_messages;
CREATE POLICY chat_messages_insert ON public.chat_messages FOR INSERT TO public
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS chat_messages_update ON public.chat_messages;
CREATE POLICY chat_messages_update ON public.chat_messages FOR UPDATE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS chat_messages_delete ON public.chat_messages;
CREATE POLICY chat_messages_delete ON public.chat_messages FOR DELETE TO public
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

NOTIFY pgrst, 'reload schema';
