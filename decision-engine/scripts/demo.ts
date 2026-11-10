import { analyzeDecisions } from '../src/index.ts';
import { demoInput } from '../fixtures/demo-scenario.ts';

const asJson = process.argv.includes('--json');
const { candidates, diagnostics } = await analyzeDecisions(demoInput);

if (asJson) {
  console.log(JSON.stringify({ candidates, diagnostics }, null, 2));
} else {
  console.log(`Decision Drift Radar: project ${demoInput.projectKey}\n`);
  for (const c of candidates) {
    console.log(`[${c.priority.tier.toUpperCase()}] ${c.kind} (${c.confidence} confidence): ${c.decisionText}`);
    console.log(`   source: ${c.sourceTitle} — “${c.evidenceExcerpt}”`);
    if (c.change) console.log(`   change: ${JSON.stringify(c.change)}`);
    for (const m of c.affectedIssues) {
      console.log(`   → ${m.issueKey} ${m.issueSummary} [${m.strength}, ${m.drift}]`);
      for (const r of m.reasons) console.log(`       • ${r.label}`);
      for (const r of m.driftReasons) console.log(`       ◦ ${r}`);
    }
    if (c.affectedIssues.length === 0) console.log('   → no affected issues found');
    console.log(`   signals: ${c.priority.signals.map((s) => s.label).join('; ')}\n`);
  }
  console.log('diagnostics:', diagnostics);
}
