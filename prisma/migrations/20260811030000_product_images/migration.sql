-- Product photographs.
--
-- The file name is stored, not the bytes. A database carrying every product
-- shot makes every backup, restore and replication slower for no gain, and a
-- photograph of a coat is not a secret that needs the database's protections.
-- The files live on disk and are included in the backup separately.
ALTER TABLE "styles" ADD COLUMN "imageName" TEXT;

-- A colour may have its own shot; most do not, and fall back to the style's.
ALTER TABLE "variants" ADD COLUMN "imageName" TEXT;
