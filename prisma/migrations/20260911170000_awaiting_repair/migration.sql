-- A garment returned for repair is not sellable until it has been repaired.
--
-- "Repair and restock" used to put it straight back into sellable stock, so
-- the till could sell a garment with the fault the customer returned it for.
-- It now waits in its own state until released.
ALTER TYPE "InventoryState" ADD VALUE 'AWAITING_REPAIR';
