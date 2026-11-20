-- Recipe metadata chosen by the family. NULL means "not set": the app shows its own guess instead.
ALTER TABLE recipes ADD COLUMN course TEXT;     -- 'main' | 'side' | 'dessert' | 'breakfast' | 'other'
ALTER TABLE recipes ADD COLUMN seasons TEXT;    -- JSON array of 'spring','summer','fall','winter'; [] = all year
ALTER TABLE recipes ADD COLUMN occasions TEXT   -- JSON array of 'weeknight','weekend'; [] = either
