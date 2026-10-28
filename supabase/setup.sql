-- Comisión Clara: esquema compartido para una sola organización.
-- Ejecutar una vez desde Supabase > SQL Editor como administrador del proyecto.

create extension if not exists pgcrypto;

create table if not exists public.commission_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'operator' check (role in ('admin', 'operator')),
  created_at timestamptz not null default now()
);

create table if not exists public.sellers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  commission numeric(12,2) not null check (commission > 0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references public.sellers(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  seller_name text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_commission numeric(12,2) not null check (unit_commission >= 0),
  total numeric(12,2) not null check (total >= 0),
  commission_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commissions(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commissions_date_idx on public.commissions(commission_date desc);
create index if not exists payments_commission_idx on public.payments(commission_id, payment_date);

create or replace function public.is_commission_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.commission_members
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_commission_member() from public, anon;
grant execute on function public.is_commission_member() to authenticated;

alter table public.commission_members enable row level security;
alter table public.sellers enable row level security;
alter table public.products enable row level security;
alter table public.commissions enable row level security;
alter table public.payments enable row level security;

revoke all on table public.commission_members, public.sellers, public.products, public.commissions, public.payments from public, anon, authenticated;
grant select on table public.commission_members to authenticated;
grant select, insert, update, delete on table public.sellers, public.products, public.commissions, public.payments to authenticated;

drop policy if exists "Members can view own membership" on public.commission_members;
create policy "Members can view own membership" on public.commission_members
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Members manage sellers" on public.sellers;
create policy "Members manage sellers" on public.sellers
  for all to authenticated using (public.is_commission_member()) with check (public.is_commission_member());
drop policy if exists "Members manage products" on public.products;
create policy "Members manage products" on public.products
  for all to authenticated using (public.is_commission_member()) with check (public.is_commission_member());
drop policy if exists "Members manage commissions" on public.commissions;
create policy "Members manage commissions" on public.commissions
  for all to authenticated using (public.is_commission_member()) with check (public.is_commission_member());
drop policy if exists "Members manage payments" on public.payments;
create policy "Members manage payments" on public.payments
  for all to authenticated using (public.is_commission_member()) with check (public.is_commission_member());

create or replace function public.validate_commission_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  commission_total numeric(12,2);
  already_paid numeric(12,2);
begin
  if new.payment_date > current_date then
    raise exception 'La fecha del pago no puede ser futura.' using errcode = '22023';
  end if;

  select total into commission_total
  from public.commissions
  where id = new.commission_id
  for update;

  if commission_total is null then
    raise exception 'No se encontró la comisión.' using errcode = '23503';
  end if;

  select coalesce(sum(amount), 0) into already_paid
  from public.payments
  where commission_id = new.commission_id
    and id <> new.id;

  if already_paid + new.amount > commission_total then
    raise exception 'El pago supera el saldo disponible.' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists validate_commission_payment on public.payments;
create trigger validate_commission_payment
  before insert or update on public.payments
  for each row execute function public.validate_commission_payment();

create or replace function public.validate_commission_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  already_paid numeric(12,2);
begin
  select coalesce(sum(amount), 0) into already_paid
  from public.payments where commission_id = new.id;
  if new.total < already_paid then
    raise exception 'El total no puede ser menor a los pagos ya registrados.' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.validate_commission_payment() from public, anon, authenticated;
revoke all on function public.validate_commission_total() from public, anon, authenticated;
grant execute on function public.validate_commission_payment() to authenticated;
grant execute on function public.validate_commission_total() to authenticated;

drop trigger if exists validate_commission_total on public.commissions;
create trigger validate_commission_total
  before update of total on public.commissions
  for each row execute function public.validate_commission_total();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sellers_touch_updated_at on public.sellers;
create trigger sellers_touch_updated_at before update on public.sellers
  for each row execute function public.touch_updated_at();
drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at before update on public.products
  for each row execute function public.touch_updated_at();
drop trigger if exists commissions_touch_updated_at on public.commissions;
create trigger commissions_touch_updated_at before update on public.commissions
  for each row execute function public.touch_updated_at();

revoke all on function public.touch_updated_at() from public, anon, authenticated;
grant execute on function public.touch_updated_at() to authenticated;

do $$
declare
  tbl regclass;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach tbl in array array[
      'public.sellers'::regclass,
      'public.products'::regclass,
      'public.commissions'::regclass,
      'public.payments'::regclass
    ] loop
      begin
        execute format('alter publication supabase_realtime add table %s', tbl);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;
