CREATE TABLE IF NOT EXISTS blocked_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  blocked_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, blocked_user_id)
);

ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;

-- Kullanıcı kendi blokladıklarını görebilir
CREATE POLICY "users can view own blocks" ON blocked_users
  FOR SELECT USING (auth.uid() = user_id);

-- Kullanıcı kendi bloklayabilir
CREATE POLICY "users can block" ON blocked_users
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Kullanıcı kendi blokunu kaldırabilir
CREATE POLICY "users can unblock" ON blocked_users
  FOR DELETE USING (auth.uid() = user_id);

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE blocked_users;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$$;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;
