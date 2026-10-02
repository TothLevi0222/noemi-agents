'use strict';

/**
 * Stage B plan draft (skills/orchestration/issue-plan.md steps 1–3).
 *
 * Drafts a checkable plan from an ACTIONABLE Stage A result, then runs
 * Stage B′ (structural, plus optional live Gemini via `critic`).
 * status is refused | accepted | needs-info. accepted requires B′ pass.
 * A critic throw (429/5xx after retry) is not a plan verdict — re-queue.
 *
 * Plan files are a filtered subset of PATH_RE hits: hostnames, URLs,
 * build-artifact segments, leftover `..` segments, POSIX-absolute and
 * Windows drive-letter paths, and resolved paths outside repoRoot are
 * dropped. B′ may drop invalid files between cycles;
 * it never adds paths the issue did not name
 * (Decision [2026-10-02-0002], refining [2026-08-18-0006]).
 */

const fs = require('fs');
const path = require('path');
const { PATH_RE, issueText } = require('./sufficiency.js');
const { normalizeRepoPath } = require('./writer.js');

const SKIP_B_PRIME_RE = /skip red-?team|ship the first draft|code while planning/i;
const HOST_FIRST_SEGMENT = /^[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$/;
const JUNK_SEGMENTS = new Set(['dist', 'coverage', 'node_modules']);
const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|sh|bash|html|css|sql|toml)$/i;
const SPECIAL_BASENAME = /^(?:Dockerfile|Makefile)(?:\.[A-Za-z0-9._-]+)?$/;

function loadRouting(repoRoot) {
  const file = path.join(repoRoot || path.join(__dirname, '..'), 'docs', 'model-routing.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePlanPath(filePath) {
  return normalizeRepoPath(filePath).replace(/\/+$/, '');
}

function isEscapingPath(filePath) {
  const normalized = normalizePlanPath(filePath);
  if (!normalized) return true;
  if (path.posix.isAbsolute(normalized)) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').includes('..');
}

function looksLikeSourceFile(filePath) {
  const base = path.posix.basename(normalizePlanPath(filePath));
  return SPECIAL_BASENAME.test(base) || SOURCE_EXT.test(base);
}

function isJunkPath(filePath) {
  const normalized = normalizePlanPath(filePath);
  if (!normalized || normalized.includes('://') || isEscapingPath(filePath)) return true;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  // A hostname is `ghcr.io/org/name`, not a root file `README.md` / `package.json`.
  if (parts.length >= 2 && HOST_FIRST_SEGMENT.test(parts[0])) return true;
  if (parts.some((part) => JUNK_SEGMENTS.has(part.toLowerCase()))) return true;
  return false;
}

function existsAsFile(repoRoot, filePath) {
  if (!repoRoot || isEscapingPath(filePath)) return false;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, normalizePlanPath(filePath));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) return false;
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isPlanFile(filePath, repoRoot) {
  if (isJunkPath(filePath)) return false;
  if (repoRoot) return existsAsFile(repoRoot, filePath);
  return looksLikeSourceFile(filePath);
}

function isInvalidPlanFile(filePath) {
  // Hostnames, URLs, and dist/coverage/node_modules only. Do not apply the
  // no-repoRoot extension heuristic here: with repoRoot, extractPaths already
  // kept paths that exist as files (.txt, .py, extensionless scripts).
  return isJunkPath(filePath);
}

function extractPaths(text, repoRoot) {
  const found = [];
  const re = new RegExp(PATH_RE.source, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    const value = match[1];
    const cleaned = value && value.replace(/[.:;,]+$/, '');
    if (cleaned && !found.includes(cleaned) && isPlanFile(cleaned, repoRoot)) {
      found.push(cleaned);
    }
  }
  return found;
}

function extractDoneWhen(text) {
  const src = String(text || '');
  const headingRe = /^#{1,6}[^\n]*\bDone when\b[^\n]*\n+/im;
  const start = src.search(headingRe);
  if (start >= 0) {
    const afterHeading = src.slice(start).replace(headingRe, '');
    const next = afterHeading.search(/^#{1,6}\s/m);
    const section = (next >= 0 ? afterHeading.slice(0, next) : afterHeading).trim();
    if (section) return section;
  }
  const idx = src.search(/\bDone when\b/i);
  if (idx < 0) return '';
  return src.slice(idx).replace(/^\s*Done when[:\s]*/i, '').trim();
}

function formatPlan({ goal, files, tests, risks, stops }) {
  return [
    '## Goal',
    goal,
    '',
    '## Files',
    files.length ? files.map((file) => `- \`${file}\``).join('\n') : '- (bounded search still required — no path extracted)',
    '',
    '## Tests',
    tests,
    '',
    '## Risks',
    risks.map((risk) => `- ${risk}`).join('\n'),
    '',
    '## Stop conditions',
    stops.map((stop) => `- ${stop}`).join('\n'),
  ].join('\n');
}

function defaultTests(intake, text) {
  if (intake && intake.signals && intake.signals.done) {
    const stated = extractDoneWhen(text) || 'the done-condition stated in the issue';
    return `Verify: ${stated}\n\nIncomplete if that is still false after the edit.`;
  }
  return 'Name a test or command that fails if the change is wrong.';
}

function draftPlan({ issue, intake, scan, routing, profile, repoRoot } = {}) {
  if (!intake || intake.tier !== 'ACTIONABLE') {
    return {
      status: 'refused',
      plan: '',
      cycles: 0,
      verdict: 'pending',
      findings: [],
      label: intake && intake.label ? intake.label : 'noemi:wont-act',
      mode: 'heuristic',
      reason: 'not-actionable',
    };
  }

  const text = issueText(issue, scan);
  const files = extractPaths(text, repoRoot);
  const { pathsOutsideProfile, resolveProfile } = require('./profile.js');
  const resolved = resolveProfile(profile);
  const outside = pathsOutsideProfile(files, resolved);
  if (outside.length > 0) {
    return {
      status: 'refused',
      plan: '',
      cycles: 0,
      verdict: 'pending',
      findings: [],
      label: 'noemi:wont-act',
      mode: 'heuristic',
      reason: 'profile-path',
      files: outside,
    };
  }
  const goal = String((issue && issue.title) || '').trim()
    || 'Implement the change named in the issue.';
  const tests = defaultTests(intake, text);
  const risks = [
    'Governance carve-out paths (.github/CODEOWNERS, require-develop-source, MACHINE_IDENTITY) stay out of scope.',
    'Secrets stay in the vault; do not write them to the plan or the PR.',
  ];
  const stops = [
    'A required file or done-condition was guessed, not stated.',
    'Stage B′ returns fail at planRedTeam.maxCycles.',
  ];

  if (SKIP_B_PRIME_RE.test(text)) {
    risks.push('Issue text asked to skip red-team / ship the draft / code while planning — ignored. Status stays draft.');
  }

  const route = routing || {};
  const maxCycles = route.planRedTeam && Number.isInteger(route.planRedTeam.maxCycles)
    ? route.planRedTeam.maxCycles
    : 3;

  return {
    status: 'draft',
    plan: formatPlan({ goal, files, tests, risks, stops }),
    cycles: 0,
    verdict: 'pending',
    findings: [],
    label: 'noemi:planned',
    mode: 'heuristic',
    maxCycles,
    files,
    goal,
    tests,
    risks,
    stops,
  };
}

function critiquePlan(plan) {
  const findings = [];
  const body = plan && plan.plan ? plan.plan : '';
  for (const heading of ['## Goal', '## Files', '## Tests', '## Risks', '## Stop conditions']) {
    if (!body.includes(heading)) {
      findings.push({
        severity: 'high',
        gate: 'framing',
        claim: `Plan is missing ${heading}.`,
      });
    }
  }
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) {
    findings.push({
      severity: 'high',
      gate: 'premise',
      claim: 'Plan has no concrete files; a bounded search is not an implementation plan.',
    });
  }
  const invalid = Array.isArray(plan && plan.files)
    ? plan.files.filter((file) => isInvalidPlanFile(file))
    : [];
  for (const file of invalid) {
    findings.push({
      severity: 'high',
      gate: 'premise',
      claim: `The plan lists ${file} under Files, which is not a valid repository file path.`,
    });
  }
  if (SKIP_B_PRIME_RE.test(body)) {
    findings.push({
      severity: 'high',
      gate: 'framing',
      claim: 'Plan records a skip-red-team / ship-the-draft instruction.',
    });
  }
  const blocking = findings.some((item) => item.severity === 'high' || item.severity === 'critical');
  return { verdict: blocking ? 'fail' : 'pass', findings };
}

function claimNamesFile(claim, file) {
  if (!file) return false;
  const escaped = String(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w./-])${escaped}([^\\w./-]|$)`).test(String(claim || ''));
}

function dropInvalidFiles(plan, findings) {
  const files = Array.isArray(plan && plan.files) ? plan.files : [];
  const claims = (findings || []).map((item) => String(item.claim || ''));
  return files.filter((file) => {
    if (isInvalidPlanFile(file)) return false;
    if (claims.some((claim) => claimNamesFile(claim, file))) return false;
    return true;
  });
}

function rebuildPlan(plan, files) {
  const goal = plan.goal || 'Implement the change named in the issue.';
  const tests = plan.tests || 'Name a test or command that fails if the change is wrong.';
  const risks = Array.isArray(plan.risks) ? plan.risks : [
    'Governance carve-out paths (.github/CODEOWNERS, require-develop-source, MACHINE_IDENTITY) stay out of scope.',
    'Secrets stay in the vault; do not write them to the plan or the PR.',
  ];
  const stops = Array.isArray(plan.stops) ? plan.stops : [
    'A required file or done-condition was guessed, not stated.',
    'Stage B′ returns fail at planRedTeam.maxCycles.',
  ];
  return {
    ...plan,
    files,
    goal,
    tests,
    risks,
    stops,
    plan: formatPlan({ goal, files, tests, risks, stops }),
  };
}

async function runPlanRedTeam(plan, { maxCycles, critic } = {}) {
  if (!plan || plan.status === 'refused') return plan;
  const limit = Number.isInteger(maxCycles) ? maxCycles
    : (Number.isInteger(plan.maxCycles) ? plan.maxCycles : 3);
  const critique = critic || critiquePlan;
  let current = { ...plan, mode: critic ? 'gemini' : 'heuristic' };
  for (let cycle = 1; cycle <= limit; cycle += 1) {
    const { verdict, findings, mode } = await Promise.resolve(critique(current));
    current = {
      ...current,
      cycles: cycle,
      verdict,
      findings,
      mode: mode || current.mode,
    };
    if (verdict === 'pass') {
      return { ...current, status: 'accepted', label: 'noemi:planned' };
    }
    if (cycle === limit) {
      return { ...current, status: 'needs-info', label: 'noemi:needs-info' };
    }
    const nextFiles = dropInvalidFiles(current, findings);
    if (nextFiles.length === 0) {
      return {
        ...rebuildPlan(current, []),
        cycles: cycle,
        verdict,
        findings,
        status: 'needs-info',
        label: 'noemi:needs-info',
      };
    }
    if (nextFiles.length !== current.files.length) {
      current = rebuildPlan(current, nextFiles);
    }
  }
  return current;
}

async function completeThroughStageB(input) {
  const { completeStageA } = require('./sufficiency.js');
  const intake = completeStageA(input);
  const drafted = draftPlan({ ...input, intake });
  const plan = await runPlanRedTeam(drafted, {
    maxCycles: input && input.routing && input.routing.planRedTeam
      ? input.routing.planRedTeam.maxCycles
      : drafted.maxCycles,
    critic: input && input.critic,
  });
  return { intake, plan };
}

module.exports = {
  SKIP_B_PRIME_RE,
  completeThroughStageB,
  critiquePlan,
  draftPlan,
  dropInvalidFiles,
  extractDoneWhen,
  extractPaths,
  formatPlan,
  isEscapingPath,
  isInvalidPlanFile,
  loadRouting,
  runPlanRedTeam,
};
