-- Dosya Adı: 02_add_logo_url_column.sql
-- Amacı: groups tablosuna logo eklenebilmesi için yeni sütun açmak
-- Kullanımı: Bu kodu Supabase SQL Editor'a yapıştırıp RUN tuşuna bas.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS logo_url TEXT;
