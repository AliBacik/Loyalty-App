-- Drop the per-order unique key that predates multi-item returns.
--
-- 20260826_returns_line_level.sql added the per-line unique index but left this
-- one in place, so the old "one row per order" rule was still enforced: the
-- first multi-item submission after that migration created both Zoho tickets
-- and then lost every row with
--   duplicate key value violates unique constraint "returns_shop_id_order_id_key"
-- The insert is one batch, so one collision drops all of the return's rows.
--
-- returns_shop_order_line_uniq (shop_id, order_id, source_order_line_key) is the
-- guard from here on: a second line of the same order is allowed, a re-submitted
-- line is not.

alter table eternate.returns
  drop constraint if exists returns_shop_id_order_id_key;

-- Same name may exist as a plain index rather than a constraint.
drop index if exists eternate.returns_shop_id_order_id_key;
