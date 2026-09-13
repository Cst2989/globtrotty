-- Where the notebook lives. Until this migration nothing on this branch stored
-- one: `turn()` built an empty Notebook at the top of every turn, filled it from
-- her message, and dropped it, so the budget gate judged every proposal against
-- a null and recorded `not evaluated` rather than a verdict, and the provenance
-- rule in src/notebook.ts had no caller that could reach its tool branch.
--
-- jsonb rather than columns. The notebook's shape is the product's model of what
-- she wants and it changes with the desk prompts; a column per field would mean
-- a migration every time a desk learns to ask about one more thing, and the
-- fields are read as a whole and written as a whole.
--
-- Nullable with no default. A conversation that predates this migration has no
-- notebook, which is a different fact from having an empty one, and
-- `loadNotebook` turns both into `emptyNotebook()` deliberately while the column
-- keeps the distinction.
alter table course.conversations add column requirements jsonb;

comment on column course.conversations.requirements is
  'The notebook: every field she stated, with its provenance and the moment it was '
  'recorded. Provenance is assigned by the harness and never by the model: the '
  'update_requirements schema carries no source field (src/tools/registry.ts) and '
  'src/agents/driver.ts derives it from whether this turn has already ingested a '
  'tool result. A tool-sourced patch may tighten a constraint and never relax one.';
