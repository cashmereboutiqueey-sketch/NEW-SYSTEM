-- The rule that watches for a drawer nobody closed.
--
-- Inserted here rather than left to the seed, which does not run on a deploy:
-- the evaluator exists in code from this release, and without its row it would
-- simply never run and nobody would know why. Idempotent on the code, so a
-- database seeded with it already is untouched.
INSERT INTO "alert_rules" ("id", "code", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "severity", "parameters", "isEnabled")
VALUES (
  'rule_till_left_open',
  'TILL_LEFT_OPEN',
  'Till left open',
  'وردية مفتوحة من غير قفل',
  'A POS session is still open long after it was started.',
  'وردية كاشير لسه مفتوحة بعد وقت طويل من فتحها.',
  'WARNING',
  '{"afterHours": 12}'::jsonb,
  true
)
ON CONFLICT ("code") DO NOTHING;
