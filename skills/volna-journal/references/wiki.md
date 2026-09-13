# Record format of the wiki of conclusions

Read on stage `capture`, when the experience of a task becomes a record in `.volna/wiki/`.

What is taken out of the journal is what outlives the task: a technique, a trap, a property of the
reference implementation, a catch in the infrastructure — **impersonally, with no task number**, with one
link to the source. What is not taken out: one-off circumstances, details of this particular order,
correspondence.

Where the material is: the `**в вики:**` subitem of `## Состояние` (the running list of candidates),
`**отвергнуто:**` there as well (disproved hypotheses), and in the log the `**почему:**` and
`**отменяет:**` lines. Never read the log whole.

Field names are Russian because the records are: the format is data, not prompt.

## The unit of storage is a conclusion

**One record is one claim.** The heading is the conclusion itself, not the topic: «Form 99 does not load
steps», not «Stepped laminate». What exactly is true must be clear before the record is opened.

```markdown
# <the claim in one line>

**тип:** гейт · **предмет:** особые формы · **этапы:** analyze, implement

**вывод:** what is true and what follows from it, one to three lines.

**источник:**
- `extensions/volna/core.ts:120` — `the exact line from the source`

**связи:** [[another-record]]
```

**тип** comes from the closed list of `SCHEMA.md`: `гейт`, `magic-число`, `направление`, `особый случай`,
`порядок`, `побочный эффект`, `ограничение`, `термин`, `договорённость`, `конфликт`, `расхождение`,
`постмортем`. The type is what keeps a record from sliding into a retelling: if no type fits, it probably
is not a conclusion.

**`постмортем`** is a genre of its own: a defect reached where it should not have, and the record explains
why the **process** let it through. It is opened when three signs meet: the mechanism is non-obvious, the
cause is systemic (a hole in a check or in where a rule lives, not a typo), and finding it out again is
expensive. On top of the usual fields `**страховка:**` is **mandatory** — what catches this class now (a
test, a line in a stage file, a lint code). Its `**вывод:**` works as a half-minute summary: what broke,
why it slipped through, what the lesson is. No страховка — lint gives `K024`: without it the record is a
story, and stories live in the task log.

Two types are easy to confuse. **`конфликт`** means one of the sides is wrong, and the record must reach an
outcome — `**разрешено:**` with `**арбитр:**`, or `**эскалация:**`. **`расхождение`** means both sides are
alive and each is right in its own area; then no resolution is needed, but `**область:**` is. The value of
a расхождение is that it keeps both sides side by side and warns that they must not be merged.

**предмет is two to four words the record is selected by without opening the file**: what it touches («mirror
of the view», «painting», «order cache»). The heading is the conclusion, the предмет is the area: the
conclusion does not tell whether the record is about the current task, the area does.

**A source is mandatory in the `reference` section**, and a code locator carries a line number and a
**verbatim quote**. The quote must occur in the source literally — that is what `/volna:wiki-verify`
checks. A retelling in your own words is not a locator. A commented-out line is never the source of live
behaviour: it is quoted only by a record that is itself about disabled code.

## Layout

Sections: `reference` for conclusions about the reference code base, `project` for knowledge about the
product, `process` for ways of working and tool catches, `volna` for working with Volna itself.

The density of a section decides the layout. Tens of records — **a file per record**. Thousands (usually
`reference`) — **a `##` section inside a subtopic file**: neighbouring conclusions are mutually contextual
and mislead when read apart.

Files lie **flat in the section root**, and the node path lives in the name through a dash:
`reference/ui-tabs-gates.md` is node `ui/tabs`, document `gates`. That way a link from an index comes down
to a file name instead of a chain of `../`, and the record name becomes unique across the wiki: two files
with one name silently share the link key `[[name]]`. The name is parsed against the `topics` registry, and
a section declares its own node depth — `sections: {process: {depth: 1}}` — otherwise a document name
starting with a topic would eat a level. The older layout by subdirectories is still read.

Budget: a record 20 lines, a subtopic file 200. Grown past it — split, do not extend. A conclusion that
does not fit is almost always two conclusions.

## Indexes are assembled, not written

`volna_wiki action=index fix=true` builds them from the records; a manual edit will be overwritten. One row
per conclusion. The index exists so that the cost of reading does not grow with the accumulated experience:
one node is opened, not the whole section.

The sharding axis is declared by the project in `SCHEMA.md`, key `index.shard_by`. The choice is a property
of the corpus, not of the tool:

- `stage` — the section is cut by flow stage, a stage opens `<section>/INDEX--<stage>.md`;
- `topic` — the section is cut by nodes **recursively**, until a node fits `limits.index_file_bytes` (and
  `index_file_lines`). The result is a tree `<section>/INDEX-<node>-<subnode>.md` down which a task descends
  to a single leaf, reading only tables of contents on the way. Rows are the same at every level: предмет,
  тип, этапы, description — the route is chosen by them, the branch is not opened.

Both together (`[topic, stage]`) mean: a tree by topic, and a large leaf additionally cut by stage. A stage
then duplicates a record in each of its shards while the «этапы» column exists anyway, so on a dense corpus
the `stage` axis is usually redundant. A leaf that still does not fit is cut by subtopic — the record files
(`INDEX-ui-down-view--measures.md`) — and only then into numbered parts `--1`, `--2` on a предмет boundary.
A chain of a single node gets no table of contents: the descent is silent.

The description of a node comes from `SCHEMA.md`, key `topics`: node name → one line about what is inside.
Not set — the frequent предметы of the records stand in for it, and the branch is chosen by them. Adding a
node means adding `topics` too: a node name is one Latin word and explains nothing by itself.

## Two calls instead of walking the tree

**`volna_wiki action=route query="words of the task"`** — what to open for the current task. It weighs the
match by предмет, heading, path and тип, sums it over the index leaves and prints the branches starting
from the nearest, plus the closest records addressed as `file#anchor`. No matches — open the root
`INDEX.md`. Call it **before** reading the wiki, not after: a route is cheaper than a walk.

**`volna_wiki action=place query="text of the conclusion"`** — where to put a new record. The same matching
core, but the answer is a directory: either a node of the existing hierarchy (with the number of matched
path segments and the weight), or «no suitable node» and a proposal to open a branch — the parent is the
nearest partially matched node, the name is a word of the task that is not in the tree yet. A node counts
as found by matching **path segments**, not single words of records: a segment is the declared topic of the
node. The tool never invents a node name for the human — it will not propose a Cyrillic word.

A new branch is opened only on «not found». A duplicate means refining the existing record, not creating a
second one. That there are two is what `/volna:wiki-lint` shows.

The file name is part of the global link key `[[name#anchor]]`, the directory is not in it: two files with
one name and one heading silently shadow each other.
