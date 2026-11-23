-- Manual rollback for migrations/0004_account_security.sql. It is NOT applied by `db:migrate`.
--
-- Run it only on the database you mean to roll back, inside the transaction below, and take a
-- backup first. It discards: every enrolled authenticator and recovery code (people must enrol
-- again), pending temporary-password markers (an account with a temporary password then keeps it
-- as an ordinary password), the security event log, sign-in throttles and used-code markers.
-- Passwords, sessions, memberships and all academy data are untouched.
--
-- After rolling back, also delete the matching row from drizzle's bookkeeping so that
-- `db:migrate` re-applies 0004 cleanly if you move forward again:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TABLE "totp_used_code";
DROP TABLE "two_factor";
DROP TABLE "temporary_credential";
DROP TABLE "sign_in_throttle";
DROP TABLE "security_event";
ALTER TABLE "app_user" DROP COLUMN "two_factor_enabled";
COMMIT;
