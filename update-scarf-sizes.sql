update public.products
set
  sizes = '["205×21 см"]'::jsonb,
  description = regexp_replace(coalesce(description, ''), '190×21\s*см', '205×21 см', 'g'),
  stock = (coalesce(stock, '{}'::jsonb) - '190×21 см') || jsonb_build_object('205×21 см', coalesce(stock->'190×21 см', '0'::jsonb)),
  updated_at = now()
where id in ('scarf2r', 'scarfhinge');