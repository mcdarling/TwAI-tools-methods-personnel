# TwAI tools, methods, and personnel

A questionnaire-driven planner for AI projects. You place a project in the AI
taxonomy and state its application context; the planner returns:

- the **GCMM maturity target** the consequence level calls for,
- **recommended methods and tools** for each GCMM credibility element,
- the **personnel** those methods and the target's review level need, compared
  with the roles you already have, and
- **R&D needs**: evidence the project needs that no mature method can produce.

It produces a plan (what evidence is needed and whether it can be produced
today). It never scores achieved credibility; per GCMM, only a completed
evidence package can do that.

## Sources

- **GCMM**: Nichol & Darling, *From Incredible Claims to Credible AI:
  Evidence-Backed Maturity Profiles for Risk-Informed AI Assurance* (AAAI-26).
  Elements, levels, the consequence-to-level mapping, score caps, and the
  supervised-ML rubric (Table 3) come from this paper.
- **Taxonomy**: Acquesta, Darling & Nichol, *Towards Certifying Trustworthy
  Machine Learning Models for Acoustic Signal Classification* (ASA, May 2026).
  The seven taxonomic rankings are the questionnaire sections.

Method maturity ratings, the option lists for each ranking, and rules marked
`"provisional": true` in `data/gcmm.json` are first drafts for review.

## How it works

```
answers ──► paradigm (from representation, learning setting, model family)
        │      └─ selects the GCMM rubric, or reports a framework gap
        ├─► target level (from consequence) + rule-forced requirements
        ├─► requirements = rubric cells up to the target
        │      └─ for each: applicable methods from the catalog, best by maturity
        │           covered   = validated or production method exists
        │           maturing  = only prototype or research methods  → R&D
        │           missing   = no method applies to this profile   → R&D
        └─► personnel = roles behind recommended methods + reviewers for the level
```

| File | Contents |
|---|---|
| `data/taxonomy.json` | Questionnaire sections and options |
| `data/gcmm.json` | Elements, levels, consequence mapping, paradigms, rubric, rules |
| `data/methods.json` | Method catalog: evidence produced, applicability, maturity, tools, roles |
| `data/roles.json` | Personnel roles |
| `data/examples.json` | Worked examples (AE classification, E3SM case study, hybrid AE) |
| `engine.js` | Planning engine, shared by the page and the tests |
| `index.html` | Questionnaire and report |

## Extending the catalog

- **New method or tool**: add an entry to `data/methods.json`. `evidence` lists
  the requirement ids it satisfies; `applies` restricts it by answer (for
  example `{"algorithm": ["cnn"], "inputs_any": ["waveform"]}`).
- **New paradigm rubric** (closing a framework gap): add a rubric under
  `rubrics` in `data/gcmm.json` and point the paradigm's `rubric` at it.
- **In-house tools**: add them to a method's `tools` list, or add a method.

Run the tests after any data change; they check that every id resolves and
that each requirement has at least one method.

## Running

```sh
python3 -m http.server   # then open http://localhost:8000
node --test test/*.test.js
```

The page loads its data with `fetch`, so it must be served rather than opened
from disk.
