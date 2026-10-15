'use strict';
const assert = require('node:assert/strict');
const { loadTrajectories, compileCore } = require('./run');
const {
    settings, buildPrompt, normalize, record,
} = require('./record-copilot');

async function main() {
    assert.throws(() => settings({}), /Explicit trajectory/);
    assert.throws(() => settings({
        PROJECTION_BENCH_COPILOT_CASE: 'linq-eager-001',
        PROJECTION_BENCH_COPILOT_PROTOCOL: 'grounded-micro-edit',
        PROJECTION_BENCH_COPILOT_MODEL: 'mock-model',
        PROJECTION_BENCH_COPILOT_OUTPUT: '/tmp/not-written',
        PROJECTION_BENCH_COPILOT_MAX_REQUESTS: '200',
    }), /Request cap/);

    const corpus=loadTrajectories();
    const privacy=corpus.get('interpolation-privacy-001');
    const { outbound, canaries }=buildPrompt(
        privacy, privacy.steps[0], privacy.initialSource, privacy.initialTarget, 'full-rewrite',
    );
    assert.equal(canaries.length,1);
    assert(!outbound.includes('CANARY_SYNTHETIC_NOT_SECRET'));
    assert(outbound.includes('__BENCH_REDACTED_CANARY_0__'));
    const restored=normalize(
        JSON.stringify({text:'s = "__BENCH_REDACTED_CANARY_0__"'}),
        'full-rewrite', canaries,
    );
    assert.equal(restored.text,'s = "CANARY_SYNTHETIC_NOT_SECRET"');
    assert.equal(normalize('not json','full-rewrite',[]).code,'malformed-json');
    assert.equal(normalize('{"edits":null}','grounded-micro-edit',[]).code,'malformed-patch');

    const core=compileCore();
    try {
        const prompts=[];
        const attempts=await record(async (modelId,prompt)=>{
            prompts.push({modelId,prompt});
            return JSON.stringify({
                edits:[{search:'x + 1',replace:'x + 2'}],
            });
        }, {
            caseId:'linq-eager-001',protocol:'grounded-micro-edit',
            modelId:'synthetic-mock-NOT-INFERENCE',maxRequests:1,
        },corpus,core.applyGroundedPatch);
        assert.equal(prompts.length,1);
        assert.equal(attempts.length,1);
        assert.equal(attempts[0].providerId,'github-copilot-sdk');
        assert.equal(attempts[0].outboundCanaryPresent,false);
        assert.equal(attempts[0].response.kind,'patch');
        assert.equal(attempts[0].quantization,null);
        assert.equal(attempts[0].outboundTokens,null);
        assert.throws(() => {
            const bad=buildPrompt(
                {...privacy,canaries:['']},
                privacy.steps[0],privacy.initialSource,privacy.initialTarget,'full-rewrite',
            );
            return bad;
        }, /Invalid synthetic canary/);
        await assert.rejects(()=>record(async()=> '{}',{
            caseId:'interpolation-privacy-001',protocol:'full-rewrite',
            modelId:'synthetic',maxRequests:1,
        },corpus,core.applyGroundedPatch),/exceeds explicit billed request cap/);
    } finally {
        require('node:fs').rmSync(core.outDir,{recursive:true,force:true});
    }
    console.log('Copilot hosted oracle recorder smoke: PASS (no inference)');
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
