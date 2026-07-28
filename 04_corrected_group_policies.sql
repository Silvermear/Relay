-- Dosya Adı: 04_corrected_group_policies.sql
-- Amacı: Grup Rol Politikaları ve Sınır Değişiklikleri (DÜZELTİLMİŞ)
-- Açıklama: JavaScript kodlarındaki roller ('owner', 'moderator', 'member') ile tam uyumludur.
-- Kullanımı: Supabase SQL Editor'a yapıştır ve RUN tuşuna bas.

-- 1. Üye sınırı sütununu ekle (varsa atlar)
alter table groups add column if not exists member_limit integer default 0;

-- 2. Rol sütununu ekle (varsa atlar)
alter table group_members add column if not exists role text default 'member';

-- 3. Rol kontrol kısıtlamasını (Check Constraint) güvenle güncelle/ekle
alter table group_members drop constraint if exists group_members_role_check;
alter table group_members add constraint group_members_role_check check (role in ('owner', 'moderator', 'member'));

-- 4. Eski politikaları temizle (varsa)
drop policy if exists "groups_update" on groups;
drop policy if exists "group_members_delete" on group_members;
drop policy if exists "group_members_role_update" on group_members;

-- 5. groups tablosu için UPDATE politikası (Grup Sahibi ve Yetkililer güncelleyebilir)
create policy "groups_update"
on groups for update
using (
  auth.uid() = created_by
  or
  auth.uid() in (
    select user_id from group_members
    where group_id = groups.id and role = 'moderator' and status = 'accepted'
  )
);

-- 6. group_members tablosu için DELETE (Atma / Ayrılma) politikası
-- Kurallar: 
-- - Her üye kendisi gruptan ayrılabilir (auth.uid() = user_id)
-- - Grup Sahibi (created_by) herkesi gruptan atabilir
-- - Grup Yetkilisi (moderator) sadece normal üyeleri ('member') atabilir, Sahibi veya diğer Yetkilileri atamaz
create policy "group_members_delete"
on group_members for delete
using (
  auth.uid() = user_id
  or
  auth.uid() = (select created_by from groups where id = group_id)
  or
  (
    auth.uid() in (
      select user_id from group_members gm2
      where gm2.group_id = group_members.group_id and gm2.role = 'moderator' and gm2.status = 'accepted'
    )
    and role = 'member'
  )
);

-- 7. group_members tablosu için UPDATE (Rol değiştirme / Davet kabul etme) politikası
-- Kurallar:
-- - Daveti kabul etmek için üyenin kendisi satırı güncelleyebilir (durum güncellemesi için)
-- - Grup Sahibi (created_by) üyelerin yetkilerini/rollerini güncelleyebilir
create policy "group_members_role_update"
on group_members for update
using (
  auth.uid() = user_id
  or
  auth.uid() = (select created_by from groups where id = group_id)
);
