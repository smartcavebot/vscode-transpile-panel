'use strict';

/**
 * Resumable, operator-bound model matrix. By default this only plans.
 *
 * node benchmarks/matrix.js plan --phase pilot
 * node benchmarks/matrix.js run --phase pilot --cell qwen25coder-1_5b-q4
 *     --protocol grounded-micro-edit --bindings benchmarks/model-bindings.local.json
 *
 * One invocation deliberately runs one protocol × model × case, never the
 * unbounded full matrix. Completed cells are content-hash checked on resume.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadTrajectories } = require('./run');

const root = path.resolve(__dirname, '..');
const matrixPath = path.join(__dirname, 'model-matrix.json');
const defaultBindings = path.join(__dirname, 'model-bindings.local.json');
const resultRoot = path.join(__dirname, 'matrix-runs');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (file) => fs.existsSync(file);
const safe = (name) => {
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) throw new Error('Unsafe output path component.');
    return name;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function options(argv) {
    const [command='plan', ...rest] = argv;
    const values = { command, phase: 'pilot' };
    const seen = new Set();
    for (let i=0; i<rest.length; i++) {
        const name=rest[i], value=rest[++i];
        assert(name.startsWith('--') && typeof value==='string' && !value.startsWith('--'),
            'Expected --key value arguments.');
        const key=name.slice(2);
        assert(['phase','cell','protocol','case','bindings','output-root','max-requests'].includes(key),
            'Unknown matrix argument: '+name);
        assert(!seen.has(key), 'Duplicate matrix argument: '+name);
        seen.add(key);
        values[key]=value;
    }
    assert(command==='plan' || command==='run', 'Command must be plan or run.');
    if (values['max-requests'] !== undefined) {
        const count=Number(values['max-requests']);
        assert(Number.isInteger(count) && count>=1 && count<=10000,
            'max-requests must be an integer 1..10000.');
        values.maxRequests=count;
    } else values.maxRequests=3;
    return values;
}

function resolvePlan(opts) {
    const matrix=json(matrixPath);
    assert(matrix.version===1 && Array.isArray(matrix.variants) && Array.isArray(matrix.protocols),
        'Invalid model matrix.');
    const phase=matrix.phases.find((p)=>p.id===opts.phase);
    assert(phase, 'Unknown matrix phase: '+opts.phase);
    if (opts.phase==='full') {
        assert(opts.case, 'Full runs require --case; bound work to one trajectory.');
    } else {
        assert(!opts.case, 'Pilot/privacy cases are determined by the committed matrix.');
    }
    const cases=phase.caseIds===null ? [opts.case] : phase.caseIds;
    const trajectories=loadTrajectories();
    for(const id of cases) assert(trajectories.has(id),'Unknown trajectory: '+id);
    const variants=matrix.variants.filter((v)=>!opts.cell || v.id===opts.cell);
    assert(variants.length>0,'Unknown matrix cell.');
    const protocols=matrix.protocols.filter((p)=>!opts.protocol || p===opts.protocol);
    assert(protocols.length>0,'Unknown update protocol.');
    const bindingsFile=path.resolve(opts.bindings || defaultBindings);
    const bindings=exists(bindingsFile) ? json(bindingsFile) : { models: {} };
    assert(bindings && typeof bindings==='object' && bindings.models &&
        typeof bindings.models==='object', 'Invalid model bindings.');
    return {matrix,phase,cases,trajectories,variants,protocols,bindings,bindingsFile};
}

function isReady(variant, binding) {
    if(variant.status !== 'candidate') return false;
    if(variant.adapter !== 'chat-completions') return false;
    if(!binding || typeof binding.modelId!=='string' ||
        binding.modelId.length<1 || binding.modelId.startsWith('REPLACE_')) return false;
    if(binding.quantization!==variant.quantization) return false;
    const endpoint=binding.endpoint;
    return typeof endpoint==='string' && endpoint.length>0;
}

function listCells(plan) {
    const cells=[];
    for(const variant of plan.variants) {
        const local=plan.bindings.models[variant.id] ?? null;
        const binding=local && { ...local, endpoint:local.endpoint || plan.bindings.endpoint };
        for(const protocol of plan.protocols) for(const caseId of plan.cases) {
            cells.push({
                id:variant.id, quantization:variant.quantization, adapter:variant.adapter,
                protocol, phase:plan.phase.id, caseId,
                expectedRequests:plan.trajectories.get(caseId).steps.length,
                status:variant.status==='candidate'
                    ? isReady(variant,binding) ? 'configured' : 'unbound'
                    : variant.status,
                binding,
            });
        }
    }
    return cells;
}

function outputFiles(base, cell) {
    const dir=path.join(base,safe(cell.phase),safe(cell.caseId),
        safe(cell.id),safe(cell.protocol));
    return {
        dir,
        attempts:path.join(dir,'attempts.json'),
        results:path.join(dir,'results.json'),
        manifest:path.join(dir,'manifest.json'),
        intent:path.join(dir,'intent.json'),
        pending:path.join(dir,'attempts.partial.json'),
    };
}

function validateAttempts(attempts, cell, binding) {
    assert(Array.isArray(attempts) && attempts.length===cell.expectedRequests,
        'Recorded attempts have unexpected length.');
    const expected=loadTrajectories().get(cell.caseId).steps.map((s)=>s.id);
    for(let i=0;i<attempts.length;i++) {
        const a=attempts[i];
        assert(a.caseId===cell.caseId && a.stepId===expected[i] &&
            a.protocol===cell.protocol && a.modelId===binding.modelId &&
            a.quantization===cell.quantization && a.response &&
            typeof a.response==='object',
            'Recorded attempt does not match selected matrix cell.');
    }
}

function fingerprint(plan,cell,binding) {
    const file=path.join(__dirname,'cases',cell.caseId+'.json');
    return sha256(JSON.stringify({
        matrixSha256:sha256(fs.readFileSync(matrixPath)),
        trajectorySha256:sha256(fs.readFileSync(file)),
        cell:cell.id,protocol:cell.protocol,phase:cell.phase,
        modelId:binding.modelId,quantization:binding.quantization,
        endpoint:binding.endpoint,engine:binding.engine||null,
        runtimeVersion:binding.runtimeVersion||null,
        deviceLabel:plan.bindings.deviceLabel||null,
        maxContextCharacters:process.env.PROJECTION_BENCH_MAX_CHARACTERS||'12000',
        maxOutputTokens:process.env.PROJECTION_BENCH_MAX_OUTPUT_TOKENS||'2048',
        artifactSha256:binding.artifactSha256||null,
    }));
}

function completed(files,signature) {
    if (![files.manifest,files.results,files.attempts].every(exists)) return false;
    const m=json(files.manifest);
    if(m.schemaVersion!==1 || m.configSha256!==signature ||
       m.status!=='completed') throw new Error('Existing cell has mismatched metadata; review before resuming.');
    if(m.attemptsSha256!==sha256(fs.readFileSync(files.attempts)) ||
       m.resultsSha256!==sha256(fs.readFileSync(files.results))) {
        throw new Error('Existing matrix result checksum mismatch; refusing to overwrite.');
    }
    return true;
}

function runChild(args,env) {
    const result=spawnSync(process.execPath,args,{
        cwd:root, env:{...process.env,...env}, encoding:'utf8',
        timeout:Math.max(180000,120000*Number(env.EXPECTED_REQUESTS || 1)+30000),
        maxBuffer:1024*1024,
    });
    if(result.error || result.status!==0) {
        throw new Error('Model/scorer process failed: '+
            (result.error?.code || result.stderr?.slice(-1500) || 'exit-'+result.status));
    }
    return result.stdout;
}

function runCell(plan,cell,base,opts) {
    assert(cell.status==='configured',
        'Cell is not runnable: '+cell.id+' ('+cell.status+'). Configure a chat-compatible local binding.');
    assert(cell.expectedRequests<=opts.maxRequests,
        'Run would exceed --max-requests ('+cell.expectedRequests+' > '+opts.maxRequests+').');
    const binding=cell.binding;
    const files=outputFiles(base,cell);
    const signature=fingerprint(plan,cell,binding);
    if(completed(files,signature)) return {cell:cell.id,protocol:cell.protocol,
        caseId:cell.caseId,status:'resumed-verified'};
    fs.mkdirSync(files.dir,{recursive:true,mode:0o700});
    // Bind any interrupted partial artifacts to precisely the original
    // matrix, source trajectory, endpoint, model alias and quantization.
    if(exists(files.intent)) {
        const intent=json(files.intent);
        if(intent.configSha256!==signature) {
            throw new Error('Partial matrix cell belongs to a different configuration; refusing to reuse it.');
        }
    } else {
        if([files.pending,files.attempts,files.results].some(exists)) {
            throw new Error('Unattested partial matrix artifacts exist; inspect them before retrying.');
        }
        fs.writeFileSync(files.intent,JSON.stringify({schemaVersion:1,configSha256:signature})+'\\n',
            {flag:'wx',mode:0o600});
    }
    // A complete recorded .partial file is valid after a prior crash; re-use
    // it instead of paying for inference again. Never overwrite unknown files.
    if(!exists(files.attempts)) {
        if(!exists(files.pending)) {
            runChild([path.join(__dirname,'record-model.js')],{
                PROJECTION_BENCH_ENDPOINT:binding.endpoint,
                PROJECTION_BENCH_MODEL:binding.modelId,
                PROJECTION_BENCH_QUANTIZATION:binding.quantization,
                PROJECTION_BENCH_CASE:cell.caseId,
                PROJECTION_BENCH_PROTOCOLS:cell.protocol,
                PROJECTION_BENCH_OUTPUT:files.pending,
                PROJECTION_BENCH_ALLOW_REMOTE:process.env.PROJECTION_BENCH_ALLOW_REMOTE||'0',
                PROJECTION_BENCH_MAX_CHARACTERS:
                    process.env.PROJECTION_BENCH_MAX_CHARACTERS || '12000',
                EXPECTED_REQUESTS:String(cell.expectedRequests),
            });
        }
        const attempts=json(files.pending);
        validateAttempts(attempts,cell,binding);
        fs.renameSync(files.pending,files.attempts);
    } else {
        validateAttempts(json(files.attempts),cell,binding);
    }
    if(!exists(files.results)) {
        const scored=runChild([path.join(__dirname,'run.js'),files.attempts],{
            EXPECTED_REQUESTS:'1',
        });
        const output=JSON.parse(scored);
        assert(output.rows.length===cell.expectedRequests,
            'Scored row count differs from recorded attempt count.');
        fs.writeFileSync(files.results,scored,{flag:'wx',mode:0o600});
    }
    const manifest={
        schemaVersion:1,status:'completed',phase:cell.phase,
        caseId:cell.caseId,cellId:cell.id,protocol:cell.protocol,
        modelId:binding.modelId,declaredQuantization:binding.quantization,
        engine:binding.engine||null,runtimeVersion:binding.runtimeVersion||null,
        artifactSha256:binding.artifactSha256||null,
        deviceLabel:plan.bindings.deviceLabel||null,
        nodeVersion:process.version,platform:process.platform,architecture:process.arch,
        configSha256:signature,
        attemptsSha256:sha256(fs.readFileSync(files.attempts)),
        resultsSha256:sha256(fs.readFileSync(files.results)),
        completedAt:new Date().toISOString(),
    };
    fs.writeFileSync(files.manifest,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return {cell:cell.id,protocol:cell.protocol,caseId:cell.caseId,
        status:'completed',acceptedAttempts:json(files.attempts).length,
        location:files.dir};
}

function main() {
    const opts=options(process.argv.slice(2));
    const plan=resolvePlan(opts);
    const cells=listCells(plan);
    if(opts.command==='plan') {
        process.stdout.write(JSON.stringify({
            phase:plan.phase.id,cases:plan.cases,cellCount:cells.length,
            estimatedRequests:cells.reduce((n,c)=>n+c.expectedRequests,0),
            cells:cells.map(({binding,...c})=>c),
            note:'Status is configuration readiness, NOT measured model performance.',
        },null,2)+'\n');
        return;
    }
    assert(opts.cell && opts.protocol,
        'Running requires --cell AND --protocol; no accidental all-matrix execution.');
    assert(cells.length===1,'Running requires exactly one case; select --case for full phase.');
    const base=path.resolve(opts['output-root'] || resultRoot);
    const result=runCell(plan,cells[0],base,opts);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
}

if(require.main===module) {
    try { main(); } catch(error) {
        process.stderr.write('matrix failed: '+error.message+'\n');
        process.exitCode=1;
    }
}
module.exports={options,resolvePlan,listCells,outputFiles,validateAttempts,fingerprint,completed};
