const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const engine = require("../engine.js");

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", f), "utf8"));
const data = { gcmm: load("gcmm.json"), methods: load("methods.json"), roles: load("roles.json") };
const taxonomy = load("taxonomy.json");
const examples = Object.fromEntries(load("examples.json").examples.map((e) => [e.id, e.answers]));

const reqs = (result) => result.elements.flatMap((e) => e.requirements);
const req = (result, id) => reqs(result).find((r) => r.id === id);
const recommendedMethods = (result) => new Set(reqs(result).filter((r) => r.best).flatMap((r) => [r.best.id, ...r.alternatives.map((m) => m.id)]));

test("catalog integrity: ids referenced by methods, rules, and paradigms exist", () => {
  const reqIds = new Set([...Object.values(data.gcmm.rubrics).flat(), ...data.gcmm.extra_requirements].map((r) => r.id));
  const roleIds = new Set(data.roles.roles.map((r) => r.id));
  for (const m of data.methods.methods) {
    for (const e of m.evidence) assert.ok(reqIds.has(e), `${m.id} cites unknown requirement ${e}`);
    for (const r of m.roles) assert.ok(roleIds.has(r), `${m.id} cites unknown role ${r}`);
    assert.ok(engine.MATURITY_RANK[m.maturity], `${m.id} has unknown maturity ${m.maturity}`);
  }
  for (const rule of data.gcmm.rules) for (const id of rule.add) assert.ok(reqIds.has(id), `rule ${rule.id} adds unknown ${id}`);
  for (const p of data.gcmm.paradigms) for (const id of p.extra_requirements || []) assert.ok(reqIds.has(id), `${p.id} adds unknown ${id}`);
  for (const l of data.gcmm.levels) if (l.review_role) assert.ok(roleIds.has(l.review_role));
});

test("catalog integrity: every requirement has at least one method in the catalog", () => {
  const cited = new Set(data.methods.methods.flatMap((m) => m.evidence));
  for (const r of [...Object.values(data.gcmm.rubrics).flat(), ...data.gcmm.extra_requirements]) {
    assert.ok(cited.has(r.id), `no method cites ${r.id}`);
  }
});

test("taxonomy answers in examples use declared option values", () => {
  const options = {};
  for (const s of taxonomy.sections) for (const q of s.questions) {
    if (q.options) options[q.id] = new Set(q.options.map((o) => o.value));
    if (q.options_from === "roles") options[q.id] = new Set(data.roles.roles.map((r) => r.id));
  }
  for (const [id, a] of Object.entries(examples)) {
    for (const [k, v] of Object.entries(a)) {
      if (!options[k]) continue;
      for (const x of [].concat(v)) assert.ok(options[k].has(x), `${id}: ${k}=${x} is not a declared option`);
    }
  }
});

test("E3SM case (moderate consequence): supervised-ML rubric, level-1 target, no R&D gaps", () => {
  const r = engine.evaluate(data, examples["e3sm-rf"]);
  assert.equal(r.paradigm.id, "supervised-ml");
  assert.equal(r.target, 1);
  assert.ok(reqs(r).every((q) => q.level <= 1));
  assert.equal(r.counts.missing, 0);
  assert.equal(r.counts.maturing, 0);
  assert.deepEqual(r.rnd, []);
});

test("E3SM with a causal claim reproduces the paper's list of what stronger claims need", () => {
  // Paper: "Stronger claims would require structural sea ice assumptions, tests for physically
  // implausible feature reliance, validation across additional operating conditions, sensitivity
  // analysis for correlated predictors, and independent reproduction of the ... pipeline."
  const r = engine.evaluate(data, examples["e3sm-causal"]);
  const m = recommendedMethods(r);
  assert.ok(m.has("dag_elicitation"), "structural assumptions");
  assert.ok(m.has("perturbation_tabular"), "tests for implausible feature reliance");
  assert.ok(m.has("leave_condition_out") && m.has("external_validation"), "validation across operating conditions");
  assert.ok(m.has("conditional_permutation"), "sensitivity for correlated predictors");
  assert.ok(req(r, "mf.mechanism"), "causal claim forces mechanism evidence above the level-2 target");
  assert.equal(req(r, "mf.mechanism").status, "maturing");
  // Independent reproduction is a level-3 expectation; confirm it appears at the critical level.
  const crit = engine.evaluate(data, { ...examples["e3sm-causal"], consequence: "critical" });
  assert.ok(recommendedMethods(crit).has("independent_reimplementation"), "independent reproduction");
});

test("AE example: high consequence, undocumented operating domain blocks, shift rule adds requirements", () => {
  const r = engine.evaluate(data, examples["ae-rf"]);
  assert.equal(r.target, 2);
  assert.ok(r.flags.some((f) => f.severity === "block" && /operating domain/.test(f.text)));
  assert.equal(req(r, "val.shift_aware").rule, "shift-expected");
  assert.equal(req(r, "val.calibration").best.id, "calibration_classification");
  assert.ok(r.personnel.some((p) => p.id === "peer_reviewer" && !p.have));
  assert.ok(!r.personnel.some((p) => p.id === "independent_review"));
});

test("hybrid AE example: framework gap plus method and maturation gaps", () => {
  const r = engine.evaluate(data, examples["ae-hybrid"]);
  assert.equal(r.paradigm.id, "sciml-hybrid");
  assert.ok(r.rnd.some((x) => x.kind === "framework"));
  assert.equal(req(r, "hy.coupling").status, "maturing");
  assert.equal(req(r, "ev.convergence").best.id, "pinn_convergence");
  assert.equal(req(r, "mf.attribution").status, "maturing");
  assert.ok(r.personnel.some((p) => p.id === "sciml" && p.have));
});

test("mechanistic models point to PCMM and generate no requirements", () => {
  const r = engine.evaluate(data, { ...examples["ae-rf"], representation: "mechanistic" });
  assert.equal(r.paradigm.id, "pde-sbes");
  assert.equal(reqs(r).length, 0);
  assert.ok(r.flags.some((f) => /PCMM/.test(f.text)));
});

test("generated outputs surface research-grade validation gaps", () => {
  const r = engine.evaluate(data, { ...examples["ae-rf"], learning: "generative", output: "generated", inputs: ["text"], algorithm: "foundation" });
  assert.equal(r.paradigm.id, "generative");
  assert.equal(req(r, "gen.output_validity").status, "maturing");
  assert.ok(r.counts.missing > 0, "some evidence has no method at all for generated output");
});

test("markdown export includes the plan sections", () => {
  const a = examples["ae-hybrid"];
  const md = engine.toMarkdown(engine.evaluate(data, a), a);
  for (const h of ["## R&D needs", "## Evidence plan", "## Personnel", "## Tools"]) assert.ok(md.includes(h));
});
