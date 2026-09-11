-- Taking a sign-in back.
--
-- A session cookie is signed and good for twelve hours. Until now nothing
-- about the account behind it was checked again in that time, so switching
-- somebody off, or resetting a password somebody else had learned, left the
-- existing cookie working until it expired on its own.
--
-- The cookie now carries this number, and a request is refused when the
-- account's number has moved on. Deactivation and password changes move it.
ALTER TABLE "users"
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
