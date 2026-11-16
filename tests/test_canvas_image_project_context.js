const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/canvas.js'), 'utf8');
function functionSource(name){
    const start = source.indexOf('function ' + name + '(');
    assert.notEqual(start, -1);
    const rest = source.slice(source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start);
    const end = rest.slice(1).search(/\n(?:async )?function /);
    return end < 0 ? rest : rest.slice(0, end + 1);
}

test('image task helper includes the active project without mutating the payload', async () => {
    let submitted;
    const ctx = vm.createContext({
        canvas:{id:'cat-litter-project'},
        cascadeFetch:async (url, options) => {
            submitted = JSON.parse(options.body);
            return {ok:true, json:async () => ({task_id:'result'})};
        },
    });
    vm.runInContext(functionSource('createCanvasImageTask'), ctx);
    const payload = {prompt:'cover', provider_id:'comfly'};
    await ctx.createCanvasImageTask(payload);
    assert.equal(submitted.canvas_id, 'cat-litter-project');
    assert.equal(payload.canvas_id, undefined);
    await ctx.createCanvasImageTask({...payload, canvas_id:'captured-project'});
    assert.equal(submitted.canvas_id, 'captured-project');
    ctx.canvas = null;
    await ctx.createCanvasImageTask(payload);
    assert.equal(submitted.canvas_id, '');
});

test('legacy image generation captures the project for its direct API request', async () => {
    let submitted;
    const gen = {id:'gen', count:1};
    const ctx = vm.createContext({
        canvas:{id:'cat-litter-project'}, nodes:[gen],
        orderedSources:(_node, sources) => sources, generatorSources:() => [{prompt:'cover'}],
        imageRefsOnly:refs => refs, outputForNode:() => null, uid:() => 'pending',
        runSnapshot:() => ({}), generatorSizeForRun:async () => '1024x1024',
        resolveImageProviderId:id => id, resolveImageModel:model => model,
        API_RATIO_VALUES:{}, CANVAS_REFERENCE_IMAGE_MAX:8, normalizedImageQuality:() => '',
        refreshRunNodes:() => {}, setTimeout:() => {}, collectRunMetas:() => [],
        requestMetaFromResult:() => ({}), appendOutputImages:() => {}, mergeGeneratedOutputs:() => {},
        addGenerationLog:() => {}, scheduleSave:() => {},
        fetch:async (_url, options) => {
            submitted = JSON.parse(options.body);
            return {ok:true, json:async () => ({images:[]})};
        },
    });
    vm.runInContext(functionSource('runGeneratorLegacy'), ctx);
    await ctx.runGeneratorLegacy('gen');
    assert.equal(submitted.canvas_id, 'cat-litter-project');
});
