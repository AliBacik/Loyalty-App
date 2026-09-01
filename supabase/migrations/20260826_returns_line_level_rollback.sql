-- Rollback for 20260826_returns_line_level.sql.
-- Drops only what that migration added; no pre-existing column is touched.

drop index if exists eternate.returns_group_idx;
drop index if exists eternate.returns_shop_order_line_uniq;

alter table eternate.returns drop column if exists return_group_id;
alter table eternate.returns drop column if exists source_order_line_key;
