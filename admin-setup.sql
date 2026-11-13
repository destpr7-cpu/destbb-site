-- Run once in Supabase SQL Editor. Then create a PUBLIC Storage bucket named product-images.
create table if not exists public.products (
  id text primary key check (id ~ '^[a-z0-9-]{2,50}$'),
  name text not null,
  price integer not null check (price > 0),
  sale_price integer null check (sale_price is null or (sale_price > 0 and sale_price < price)),
  tag text not null default 'NEW / ITEM',
  images jsonb not null default '[]'::jsonb,
  sizes jsonb not null default '[]'::jsonb,
  size_hints jsonb not null default '{}'::jsonb,
  category text not null default 'apparel' check (category in ('scarf','apparel')),
  description text not null default '',
  active boolean not null default true,
  preorder boolean not null default false,
  stock jsonb not null default '{}'::jsonb,
  sort_order integer not null default 999,
  updated_at timestamptz not null default now()
);
alter table public.products add column if not exists category text not null default 'apparel' check (category in ('scarf','apparel'));

-- Initial catalog records. Local image paths keep working; new images can be uploaded later.
insert into public.products (id,name,price,tag,images,sizes,size_hints,category,description,preorder,stock,sort_order) values
('scarf2r','DESIGNER SCARF «2R»',699,'01 / SCARF','["/assets/scarf_2r_1.png","/assets/scarf_2r_2.JPG","/assets/scarf_2r_3.JPG","/assets/scarf_2r_4.JPG","/assets/scarf_2r_5.png"]','["190×21 см"]','{}','scarf','190×21 см. 100% Acrylic. Отправка по всему миру, кроме РФ и РБ.',false,'{"190×21 см":0}',1),
('scarfhinge','DESIGNER SCARF «UNTITLED»',749,'02 / SCARF','["/assets/scarf_untitled_1.png","/assets/scarf_untitled_2.JPG","/assets/scarf_untitled_3.JPG","/assets/scarf_untitled_4.JPG","/assets/scarf_untitled_5.JPG","/assets/scarf_untitled_6.JPG"]','["190×21 см"]','{}','scarf','190×21 см. 100% Acrylic. Отправка по всему миру, кроме РФ и РБ.',false,'{"190×21 см":0}',2),
('redline','LONGSLEEVE «REDLINE»',1720,'03 / LONGSLEEVE','["/assets/redline_main.webp","/assets/redline_1.webp","/assets/redline_2.webp","/assets/redline_3.webp","/assets/redline_4.webp","/assets/redline_macro.webp"]','["S","M","L","XL"]','{"S":"150-165 см","M":"165-175 см","L":"175-185 см","XL":"185+ см"}','apparel','Чёрный лонгслив в стиле Y2K и контрастными бордовыми рукавами. Трафаретная печать, трикотаж, плотность 210 г/м².',false,'{"S":0,"M":0,"L":0,"XL":0}',3),
('jesus','LONGSLEEVE «JESUS»',1520,'04 / LONGSLEEVE','["/assets/jesus_0.jpg","/assets/jesus_1.jpg","/assets/jesus_2.jpg"]','["S","M","L","XL","XXL"]','{"S":"150-165 см","M":"165-175 см","L":"175-185 см","XL":"185+ см","XXL":"190+ см"}','apparel','Шелкотрафарет, трикотаж, плотность 200 г/м². Сроки: 2–3 недели.',false,'{"S":0,"M":0,"L":0,"XL":0,"XXL":0}',4),
('scarf','SCARF «GREAT SCHEMA»',888,'05 / SCARF','["/assets/scarf_0.jpg","/assets/scarf_1.jpg","/assets/scarf_2.jpg"]','["190×21 см"]','{}','scarf','100% акрил. 190×21 см.',false,'{"190×21 см":0}',5)
on conflict (id) do nothing;

alter table public.products enable row level security;
revoke all on public.products from anon, authenticated;

-- Keep updated_at current on saves.
create or replace function public.destbb_products_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists destbb_products_updated_at on public.products;
create trigger destbb_products_updated_at before update on public.products
for each row execute function public.destbb_products_updated_at();

create table if not exists public.orders (
  order_number text primary key,
  status text not null default 'awaiting_review' check (status in ('request','awaiting_review','paid','cancelled','telegram_failed')),
  items jsonb not null,
  delivery jsonb not null default '{}'::jsonb,
  payment text,
  shipping text,
  subtotal integer not null,
  shipping_cost integer not null default 0,
  total integer not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;

-- Marking an order as paid decreases inventory atomically, once only.
create or replace function public.destbb_mark_order_paid(p_order_number text)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  line jsonb;
  prod public.products%rowtype;
  size_key text;
  have_count integer;
  take_count integer;
begin
  select * into o from public.orders where order_number = p_order_number for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'paid' then return; end if;
  if o.status = 'cancelled' then raise exception 'Cancelled order cannot be marked paid'; end if;
  for line in select value from jsonb_array_elements(o.items)
  loop
    select * into prod from public.products where id = line->>'id' for update;
    if not found then raise exception 'Product no longer exists: %', line->>'id'; end if;
    if prod.preorder then continue; end if;
    size_key := coalesce(line->>'size', '');
    take_count := greatest(1, (line->>'qty')::integer);
    have_count := coalesce((prod.stock->>size_key)::integer, 0);
    if have_count < take_count then raise exception 'Not enough stock for % / %', prod.name, size_key; end if;
    update public.products set stock = jsonb_set(stock, array[size_key], to_jsonb(have_count - take_count), true) where id = prod.id;
  end loop;
  update public.orders set status = 'paid', paid_at = now() where order_number = p_order_number;
end;
$$;
revoke all on function public.destbb_mark_order_paid(text) from public, anon, authenticated;
grant execute on function public.destbb_mark_order_paid(text) to service_role;
