-- Handing somebody a login.
--
-- Set when a password was chosen by somebody other than its owner — a new
-- account, or a reset. They cannot reach any screen until they replace it,
-- because a password two people know is not a password, and the audit trail
-- stops meaning anything the moment two people can sign in as one person.
ALTER TABLE "users"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
