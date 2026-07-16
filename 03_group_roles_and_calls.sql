-- Dosya Adı: 03_group_roles_and_calls.sql
-- Amacı: Grup rol sistemi ve sesli arama için gerekli tablo/sütun değişiklikleri
-- Kullanımı: Supabase SQL Editor'a yapıştır ve RUN tuşuna bas.

-- 1. group_members tablosuna rol sütunu ekle
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';

-- 2. Mevcut kurucuları admin yap
UPDATE group_members gm
SET role = 'admin'
FROM groups g
WHERE gm.group_id = g.id AND gm.user_id = g.created_by;

-- 3. Grup aramaları tablosu
CREATE TABLE IF NOT EXISTS group_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  started_by UUID REFERENCES auth.users(id),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. RLS aktif et
ALTER TABLE group_calls ENABLE ROW LEVEL SECURITY;

-- 5. Politikalar
CREATE POLICY "Grup uyesi aramalari gorebilir"
ON group_calls FOR SELECT USING (
  group_id IN (
    SELECT group_id FROM group_members
    WHERE user_id = auth.uid() AND status = 'accepted'
  )
);

CREATE POLICY "Grup uyesi arama baslatabilir"
ON group_calls FOR INSERT WITH CHECK (
  auth.uid() = started_by AND
  group_id IN (
    SELECT group_id FROM group_members
    WHERE user_id = auth.uid() AND status = 'accepted'
  )
);

CREATE POLICY "Arama baslatan bitirebilir"
ON group_calls FOR UPDATE USING (auth.uid() = started_by);

-- 6. Realtime aktif et (Supabase Dashboard > Database > Replication'dan group_calls tablosunu da ekle)
