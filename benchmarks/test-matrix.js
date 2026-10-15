'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root=path.resolve(__dirname,'..');
const script=path.join(__dirname,'matrix.js');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'projection-matrix-'));
function cli(args) {
    const result=spawnSync(process.execPath,[script,...args],{
        cwd:root,encoding:'utf8',timeout:200000,
        env:{...process.env,PROJECTION_BENCH_ALLOW_REMOTE:'0'},
    });
    if(result.error) throw result.error;
    return result;
}
function parsed(result) {
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
}
async function main() {
    const plan=parsed(cli(['plan','--phase','pilot']));
    assert.equal(plan.cellCount,36);
    assert.equal(plan.estimatedRequests,36);
    assert.equal(plan.cells.filter((c)=>c.status==='unbound').length,27);
    assert.equal(plan.cells.filter((c)=>c.status==='adapter-needed').length,6);
    assert.equal(plan.cells.filter((c)=>c.status==='approval-required').length,3);
    assert.notEqual(cli(['plan','--phase','full']).status,0);
    assert.notEqual(cli(['run','--phase','pilot']).status,0);

    let called=0;
    const server=http.createServer((request,response)=>{
        let body='';
        request.on('data',(chunk)=>body+=chunk);
        request.on('end',()=>{
            called++;
            const parsedRequest=JSON.parse(body);
            assert.equal(parsedRequest.model,'synthetic-model-NOT-REAL');
            response.setHeader('content-type','application/json');
            response.end(JSON.stringify({
                choices:[{message:{content:JSON.stringify({
                    edits:[{search:'x + 1',replace:'x + 2'}],
                })}}],
                usage:{prompt_tokens:20},
            }));
        });
    });
    await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
    try {
        const bindings={
            endpoint:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',
            deviceLabel:'mock-CI-no-GPU',
            models:{'qwen25coder-1_5b-q4':{
                modelId:'synthetic-model-NOT-REAL',quantization:'Q4',
                engine:'mock-only',runtimeVersion:'unit-test',
            }},
        };
        const bindingFile=path.join(temporary,'bindings.json');
        fs.writeFileSync(bindingFile,JSON.stringify(bindings));
        const runArgs=['run','--phase','pilot','--cell','qwen25coder-1_5b-q4',
            '--protocol','grounded-micro-edit','--bindings',bindingFile,
            '--output-root',path.join(temporary,'outputs')];
        const first=parsed(cli(runArgs));
        assert.equal(first.status,'completed');
        assert.equal(first.acceptedAttempts,1);
        assert.equal(called,1);
        const resultFile=path.join(first.location,'results.json');
        const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
        assert.equal(result.rows.length,1);
        assert.equal(result.rows[0].patchSuccess,true);
        assert.equal(result.rows[0].referenceExact,true);
        assert.equal(result.rows[0].semanticEquivalence,null);
        const second=parsed(cli(runArgs));
        assert.equal(second.status,'resumed-verified');
        assert.equal(called,1,'resume must not consume another inference call');
        fs.appendFileSync(resultFile,'\ncorruption\n');
        const third=cli(runArgs);
        assert.notEqual(third.status,0);
        assert.match(third.stderr,/checksum mismatch/);
        assert.equal(called,1);
    } finally {
        await new Promise((resolve)=>server.close(resolve));
    }
    console.log('model matrix smoke: PASS (synthetic local inference only)');
}
main().catch((error)=>{
    console.error(error);
    process.exitCode=1;
}).finally(()=>fs.rmSync(temporary,{recursive:true,force:true}));
