-- Profil tablosuna avatar_url sütunu ekle (base64 data URL olarak kaydedilecek)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;
