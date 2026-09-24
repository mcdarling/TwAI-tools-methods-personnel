/*
 * Planning engine: questionnaire answers -> GCMM target profile, recommended
 * methods and tools, personnel, and R&D gaps.
 *
 * Pure function of (data, answers); runs in the browser and in Node.
 * This produces a plan (what evidence is needed and whether it can be
 * produced), never an achieved GCMM score.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlannerEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MATURITY_RANK = { production: 4, validated: 3, prototype: 2, research: 1 };

  // Requirement status, ordered from best to worst.
  var STATUS = {
    covered:  { rank: 0, label: "Covered" },
    maturing: { rank: 1, label: "Needs maturation" },
    missing:  { rank: 2, label: "No method" }
  };

  function asList(v) {
    if (v === undefined || v === null || v === "") return [];
    return Array.isArray(v) ? v : [v];
  }

  // A condition maps answer keys to allowed values. Special keys:
  //   inputs_any:  at least one selected input is in the list
  //   inputs_only: every selected input is in the list (and at least one is selected)
  function matches(cond, a) {
    if (!cond) return true;
    return Object.keys(cond).every(function (key) {
      var allowed = cond[key];
      if (key === "inputs_any") return asList(a.inputs).some(function (x) { return allowed.indexOf(x) >= 0; });
      if (key === "inputs_only") {
        var ins = asList(a.inputs);
        return ins.length > 0 && ins.every(function (x) { return allowed.indexOf(x) >= 0; });
      }
      return asList(a[key]).some(function (x) { return allowed.indexOf(x) >= 0; });
    });
  }

  function pickParadigm(paradigms, a) {
    for (var i = 0; i < paradigms.length; i++) {
      var p = paradigms[i];
      if (p.when && matches(p.when, a)) return p;
      if (p.when_any && p.when_any.some(function (c) { return matches(c, a); })) return p;
    }
    // Unanswered learning setting: fall back to the supervised rubric.
    return paradigms.filter(function (p) { return p.id === "supervised-ml"; })[0];
  }

  function statusFor(best) {
    if (!best) return "missing";
    return MATURITY_RANK[best.maturity] >= MATURITY_RANK.validated ? "covered" : "maturing";
  }

  function evaluate(data, answers) {
    var a = answers || {};
    var gcmm = data.gcmm;
    var methods = data.methods.methods;
    var rolesById = {};
    data.roles.roles.forEach(function (r) { rolesById[r.id] = r; });

    var flags = [];
    var consequence = gcmm.consequence[a.consequence];
    var target = consequence ? consequence.target : null;
    if (target === null) {
      flags.push({ severity: "block", text: "Choose a consequence level. GCMM sets the required maturity from it." });
    }

    var paradigm = pickParadigm(gcmm.paradigms, a);
    if (paradigm.framework !== "instantiated") {
      flags.push({ severity: paradigm.framework === "gap" ? "rnd" : "info", text: paradigm.framework_note });
    }

    // Score caps from the paper: GCMM is undefined without a documented context.
    var undocumented = [];
    if (!a.intended_use_documented) undocumented.push("intended use");
    if (!a.operating_domain_documented) undocumented.push("operating domain");
    if (undocumented.length) {
      flags.push({
        severity: target !== null && target > 1 ? "block" : "warn",
        text: "The " + undocumented.join(" and ") + (undocumented.length > 1 ? " are" : " is") +
          " not documented, so no element can score above level 1 (GCMM conservative-scoring cap)." +
          (target > 1 ? " Your target is level " + target + ", so documenting this comes first." : "")
      });
    }
    if (a.semantics === "prescriptive" && a.claim === "association") {
      flags.push({ severity: "warn", text: "Prescriptive use recommends actions, which is an interventional claim. Check the kind of claim under Solution space." });
    }

    // Requirements: rubric cells up to the target level, plus rule-forced and paradigm-specific ones.
    var rubric = paradigm.rubric ? gcmm.rubrics[paradigm.rubric] : [];
    var allReqs = {};
    rubric.concat(gcmm.extra_requirements).forEach(function (r) { allReqs[r.id] = r; });

    var selected = {};
    if (target !== null) {
      rubric.forEach(function (r) {
        if (r.level <= target) selected[r.id] = { reason: "Level " + r.level + " evidence toward a level-" + target + " target" };
      });
      (paradigm.extra_requirements || []).forEach(function (id) {
        selected[id] = { reason: "Specific to this paradigm (GCMM paper, beyond supervised ML)" };
      });
      if (paradigm.rubric) {
        gcmm.rules.forEach(function (rule) {
          if (!matches(rule.when, a)) return;
          flags.push({ severity: "info", text: rule.flag, provisional: rule.provisional });
          rule.add.forEach(function (id) {
            if (!selected[id]) selected[id] = { reason: "Required because " + rule.reason, rule: rule.id };
          });
        });
      }
    }

    var elements = gcmm.elements.map(function (el) {
      var reqs = Object.keys(selected)
        .map(function (id) { return allReqs[id]; })
        .filter(function (r) { return r.element === el.id; })
        .sort(function (x, y) { return x.level - y.level; })
        .map(function (r) {
          var candidates = methods
            .filter(function (m) { return m.evidence.indexOf(r.id) >= 0 && matches(m.applies, a); })
            .sort(function (x, y) { return MATURITY_RANK[y.maturity] - MATURITY_RANK[x.maturity]; });
          var best = candidates[0] || null;
          return {
            id: r.id, label: r.label, level: r.level,
            reason: selected[r.id].reason, rule: selected[r.id].rule || null,
            status: statusFor(best), best: best, alternatives: candidates.slice(1)
          };
        });
      var worst = reqs.reduce(function (w, r) { return STATUS[r.status].rank > STATUS[w].rank ? r.status : w; }, "covered");
      return { id: el.id, name: el.name, question: el.question, target: target, requirements: reqs, status: reqs.length ? worst : null };
    });

    var allRequirements = [];
    elements.forEach(function (e) { allRequirements = allRequirements.concat(e.requirements); });

    // Personnel: roles behind each recommended method, the reviewer the target level
    // calls for, and a domain expert for the decision context.
    var need = {};
    function addRole(id, why) {
      if (!rolesById[id]) return;
      if (!need[id]) need[id] = { id: id, name: rolesById[id].name, skills: rolesById[id].skills, reasons: [] };
      if (need[id].reasons.indexOf(why) < 0) need[id].reasons.push(why);
    }
    allRequirements.forEach(function (r) {
      if (r.best) r.best.roles.forEach(function (id) { addRole(id, r.label); });
    });
    if (target !== null) {
      for (var lv = 0; lv <= target; lv++) {
        var rr = gcmm.levels[lv].review_role;
        if (rr) addRole(rr, "Level-" + lv + " review: " + gcmm.levels[lv].review.toLowerCase());
      }
    }
    if (a.domain_expertise) addRole("domain_sme", "Decision context: " + a.domain_expertise);
    var have = asList(a.roles);
    var personnel = Object.keys(need).map(function (id) {
      var p = need[id];
      p.have = have.indexOf(id) >= 0;
      return p;
    }).sort(function (x, y) { return (x.have - y.have) || (y.reasons.length - x.reasons.length); });

    // Tools grouped from the recommended methods.
    var tools = {};
    allRequirements.forEach(function (r) {
      if (!r.best) return;
      r.best.tools.forEach(function (t) {
        if (!tools[t]) tools[t] = [];
        if (tools[t].indexOf(r.label) < 0) tools[t].push(r.label);
      });
    });

    // R&D needs.
    var rnd = [];
    if (paradigm.framework === "gap") {
      rnd.push({ kind: "framework", title: "GCMM rubric: " + paradigm.name, detail: paradigm.framework_note });
    }
    allRequirements.forEach(function (r) {
      if (r.status === "missing") {
        rnd.push({ kind: "method", element: r.id.split(".")[0].toUpperCase(), title: r.label,
          detail: "No known method produces this evidence for your inputs, outputs, and model family." });
      } else if (r.status === "maturing") {
        rnd.push({ kind: "maturation", element: r.id.split(".")[0].toUpperCase(), title: r.label,
          detail: r.best.name + " is " + r.best.maturity + "-grade." + (r.best.note ? " " + r.best.note : "") });
      }
    });

    var counts = { covered: 0, maturing: 0, missing: 0 };
    allRequirements.forEach(function (r) { counts[r.status]++; });

    return {
      paradigm: { id: paradigm.id, name: paradigm.name, framework: paradigm.framework, note: paradigm.framework_note },
      target: target,
      consequence: consequence ? consequence.label : null,
      levels: gcmm.levels,
      flags: flags,
      elements: elements,
      counts: counts,
      personnel: personnel,
      staffingGaps: personnel.filter(function (p) { return !p.have; }).length,
      tools: Object.keys(tools).sort().map(function (t) { return { name: t, for: tools[t] }; }),
      rnd: rnd
    };
  }

  function toMarkdown(result, answers) {
    var a = answers || {};
    var L = [];
    L.push("# AI project plan" + (a.decision_context ? ": " + a.decision_context : ""));
    L.push("");
    if (a.intended_use) L.push("**Intended use:** " + a.intended_use);
    L.push("**Paradigm:** " + result.paradigm.name + " (" + result.paradigm.framework + ")");
    L.push("**Target:** " + (result.target === null ? "not set" : "GCMM level " + result.target + " on all elements (" + result.consequence + ")"));
    L.push("");
    if (result.flags.length) {
      L.push("## Notes");
      result.flags.forEach(function (f) { L.push("- " + f.text + (f.provisional ? " _(provisional rule)_" : "")); });
      L.push("");
    }
    L.push("## R&D needs");
    if (!result.rnd.length) L.push("None identified.");
    result.rnd.forEach(function (r) { L.push("- **" + r.title + "** (" + r.kind + "): " + r.detail); });
    L.push("");
    L.push("## Evidence plan");
    result.elements.forEach(function (e) {
      if (!e.requirements.length) return;
      L.push("### " + e.name);
      e.requirements.forEach(function (r) {
        L.push("- [" + STATUS[r.status].label + "] L" + r.level + " " + r.label + ": " +
          (r.best ? r.best.name + " (" + r.best.maturity + (r.best.tools.length ? "; " + r.best.tools.join(", ") : "") + ")" : "none"));
      });
    });
    L.push("");
    L.push("## Personnel");
    result.personnel.forEach(function (p) {
      L.push("- " + (p.have ? "[have] " : "[NEED] ") + p.name + ": " + p.reasons.slice(0, 4).join("; ") + (p.reasons.length > 4 ? "; ..." : ""));
    });
    L.push("");
    L.push("## Tools");
    result.tools.forEach(function (t) { L.push("- " + t.name); });
    return L.join("\n");
  }

  return { evaluate: evaluate, toMarkdown: toMarkdown, matches: matches, STATUS: STATUS, MATURITY_RANK: MATURITY_RANK };
});
