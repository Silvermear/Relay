-- Dosya Adi: 05_multi_calls.sql
-- Amaci: Kisisel aramaya kisi ekleme (multi-call) sistemi
-- Kullanimi: Supabase SQL Editor'a yapistir ve RUN tusuna bas.

CREATE TABLE IF NOT EXISTS multi_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  started_by UUID REFERENCES auth.users(id),
  participant_ids UUID[] DEFAULT ARRAY[]::UUID[],
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE multi_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Katilimcilar multi-call gorebilir"
ON multi_calls FOR SELECT USING (
  auth.uid() = ANY(participant_ids)
);

CREATE POLICY "Katilimcilar multi-call baslatabilir"
ON multi_calls FOR INSERT WITH CHECK (
  auth.uid() = started_by
);

CREATE POLICY "Katilimcilar multi-call guncelleyebilir"
ON multi_calls FOR UPDATE USING (
  auth.uid() = ANY(participant_ids)
);

ALTER PUBLICATION supabase_realtime ADD TABLE multi_calls;
