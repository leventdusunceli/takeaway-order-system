-- Humus Bestellungen: Datenbank-Setup
-- Einmal im Supabase "SQL Editor" ausführen (New query -> einfügen -> Run).
-- Das Skript kann gefahrlos mehrfach laufen.

-- 1. Rollen ------------------------------------------------------------------
create table if not exists public.profiles (
  id   uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('kellner', 'kueche', 'admin'))
);
alter table public.profiles enable row level security;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

drop policy if exists "eigenes Profil lesen" on public.profiles;
create policy "eigenes Profil lesen" on public.profiles
  for select to authenticated using (id = auth.uid());

-- 2. Bestellungen ------------------------------------------------------------
create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  daily_no       int not null default 0,                 -- Tagesnummer (1, 2, 3 ...)
  created_at     timestamptz not null default now(),
  pickup_at      timestamptz,                            -- leer = "Ab sofort"
  customer_name  text,
  customer_phone text,
  note           text,
  source         text not null default 'vor_ort' check (source in ('telefon', 'vor_ort', 'online')),
  items          jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  total_cents    int not null default 0,
  status         text not null default 'neu' check (status in ('neu', 'in_arbeit', 'fertig')),
  started_at     timestamptz,
  ready_at       timestamptz,
  edited_at      timestamptz,                            -- Kellner hat nach dem Senden geändert
  ack_at         timestamptz,                            -- Küche hat Änderung gesehen
  created_by     uuid default auth.uid() references auth.users(id)
);
create index if not exists orders_created_at_idx on public.orders (created_at);
alter table public.orders enable row level security;

-- Beginn des heutigen Tages (Berliner Zeit)
create or replace function public.berlin_today() returns timestamptz
language sql stable as $$
  select date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'
$$;

-- 3. Trigger: neue Bestellung (Tagesnummer, Status immer "neu") ---------------
create or replace function public.orders_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.daily_no := coalesce((select max(daily_no) from public.orders
                            where created_at >= public.berlin_today()), 0) + 1;
  if public.my_role() <> 'admin' then
    new.status := 'neu'; new.started_at := null; new.ready_at := null;
    new.edited_at := null; new.ack_at := null;
  end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists orders_before_insert on public.orders;
create trigger orders_before_insert before insert on public.orders
  for each row execute function public.orders_before_insert();

-- 4. Trigger: Änderungen (wer darf welche Spalten ändern) --------------------
create or replace function public.orders_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.my_role();
begin
  if r = 'admin' then return new; end if;
  if new.id <> old.id or new.created_at <> old.created_at or new.daily_no <> old.daily_no
     or new.created_by is distinct from old.created_by then
    raise exception 'Diese Felder sind gesperrt';
  end if;

  if r = 'kellner' then
    if old.status = 'fertig' then raise exception 'Bestellung ist schon fertig'; end if;
    if new.status is distinct from old.status or new.started_at is distinct from old.started_at
       or new.ready_at is distinct from old.ready_at or new.ack_at is distinct from old.ack_at then
      raise exception 'Kellner darf den Status nicht ändern';
    end if;
    new.edited_at := now();
  elsif r = 'kueche' then
    if new.pickup_at is distinct from old.pickup_at or new.customer_name is distinct from old.customer_name
       or new.customer_phone is distinct from old.customer_phone or new.note is distinct from old.note
       or new.source <> old.source or new.items <> old.items or new.total_cents <> old.total_cents
       or new.edited_at is distinct from old.edited_at then
      raise exception 'Küche darf nur den Status ändern';
    end if;
  else
    raise exception 'Keine Berechtigung';
  end if;
  return new;
end $$;
drop trigger if exists orders_before_update on public.orders;
create trigger orders_before_update before update on public.orders
  for each row execute function public.orders_before_update();

-- 5. Zugriffsregeln (Row Level Security) --------------------------------------
drop policy if exists "Admin alles" on public.orders;
create policy "Admin alles" on public.orders
  for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists "Kellner und Küche lesen" on public.orders;
create policy "Kellner und Küche lesen" on public.orders
  for select to authenticated
  using (public.my_role() in ('kellner', 'kueche')
         and (status <> 'fertig' or created_at >= public.berlin_today()));

drop policy if exists "Kellner senden" on public.orders;
create policy "Kellner senden" on public.orders
  for insert to authenticated with check (public.my_role() = 'kellner');

drop policy if exists "Kellner ändern" on public.orders;
create policy "Kellner ändern" on public.orders
  for update to authenticated
  using (public.my_role() = 'kellner' and status <> 'fertig')
  with check (public.my_role() = 'kellner');

drop policy if exists "Küche Status" on public.orders;
create policy "Küche Status" on public.orders
  for update to authenticated
  using (public.my_role() = 'kueche') with check (public.my_role() = 'kueche');

-- 6. Live-Verbindung einschalten ----------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;

-- 7. Rollen den drei Benutzern zuweisen ---------------------------------------
-- Der Teil vor dem @ der E-Mail bestimmt die Rolle:
--   kellner@...  -> Kellner      kueche@...  -> Küche      chef@...  -> Admin
-- Dieses Statement nach dem Anlegen der Benutzer ausführen (auch mehrfach ok).
insert into public.profiles (id, role)
select id, case split_part(email, '@', 1)
             when 'kellner' then 'kellner'
             when 'kueche'  then 'kueche'
             when 'chef'    then 'admin'
           end
from auth.users
where split_part(email, '@', 1) in ('kellner', 'kueche', 'chef')
on conflict (id) do update set role = excluded.role;
