-- Multi-item returns: one row per returned line, not per order.
--
-- Until now eternate.returns held at most one row per order_id and the submit
-- route rejected everything else as "duplicate". A customer returning three
-- items from one order therefore produced one row and two 409s — measured on
-- 2026-08-26: 200 rows, zero orders with more than one row.
--
-- source_order_line_key is the same "<order>/<lineItem>" string the Return V2
-- API already receives, so it needs no new plumbing to populate.

alter table eternate.returns
  add column if not exists source_order_line_key text;

-- Existing rows predate multi-item support: each is the only row for its order,
-- so a per-order sentinel keeps them unique under the new constraint below.
update eternate.returns
   set source_order_line_key = 'legacy/' || order_id
 where source_order_line_key is null;

alter table eternate.returns
  alter column source_order_line_key set not null;

-- The duplicate guard the route relies on. Concurrent submissions for the same
-- line now collide here rather than racing a select, and a second line on the
-- same order is no longer a duplicate.
create unique index if not exists returns_shop_order_line_uniq
  on eternate.returns (shop_id, order_id, source_order_line_key);

-- Ties the rows of one multi-item submission together: every row of a return
-- shares a group id, and exactly one of them carries the label.
alter table eternate.returns
  add column if not exists return_group_id uuid;

create index if not exists returns_group_idx
  on eternate.returns (return_group_id);
