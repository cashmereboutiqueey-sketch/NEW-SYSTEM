-- Which stage an operation belongs to.
--
-- Line efficiency is earned minutes over clocked minutes, and the minutes a
-- stage earns are qtyOut times the standard minutes for that stage. Operations
-- carried a line and a sequence but never a stage, so there was no way to say
-- what "the standard minutes for sewing" were — which is why the stage log had
-- no writer and the efficiency screen could never fill in.
--
-- Nullable: existing operations have no stage until somebody says, and
-- guessing one from the sequence number would invent the very figure the
-- report is meant to measure.
ALTER TABLE "style_operations" ADD COLUMN "stage" "ProductionStage";

CREATE INDEX "style_operations_styleId_stage_idx" ON "style_operations"("styleId", "stage");
